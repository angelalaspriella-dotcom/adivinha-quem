/* Adivinha Quem — cliente */
(() => {
  const $ = (id) => document.getElementById(id);

  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    playing: $('screen-play'),
    results: $('screen-results')
  };

  let ws = null;
  let state = null;            // último snapshot do servidor
  let session = loadSession();
  let timerInterval = null;
  let reconnectDelay = 500;
  let intentionallyClosed = false;
  let localDown = null;        // { round, keys } cartas em baixo antes de o servidor confirmar
  let flipTimer = null;
  let guessMode = false;
  let pickKey = null;

  // ---------- sessão ----------

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem('adivinha-quem') || 'null'); } catch { return null; }
  }
  function saveSession(s) {
    session = s;
    if (s) sessionStorage.setItem('adivinha-quem', JSON.stringify(s));
    else sessionStorage.removeItem('adivinha-quem');
  }

  // ---------- websocket ----------

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('open', () => {
      reconnectDelay = 500;
      $('conn-lost').hidden = true;
      if (session) wsSend({ type: 'rejoin', ...session });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (intentionallyClosed) return;
      if (session) $('conn-lost').hidden = false;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.8, 8000);
    });
  }

  function wsSend(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        saveSession({ code: msg.code, playerId: msg.playerId, token: msg.token });
        break;
      case 'rejoin_failed':
        saveSession(null);
        state = null;
        render();
        break;
      case 'join_error':
      case 'error':
      case 'notice':
        toast(msg.message);
        break;
      case 'state': {
        const prev = state;
        state = msg;
        if (!prev || prev.phase !== state.phase || prev.round !== state.round) {
          guessMode = false; pickKey = null; localDown = null;
          delete $('board').dataset.key;
          window.scrollTo(0, 0);
        }
        render();
        break;
      }
    }
  }

  // ---------- helpers ----------

  const me = () => state && state.players.find((p) => p.id === state.youId);
  const player = (id) => state && state.players.find((p) => p.id === id);
  const person = (key) => state && state.people.find((p) => p.key === key);
  const isHost = () => state && state.hostId === state.youId;
  const g = () => state && state.game;
  const isGuardian = () => g() && g().guardianId === state.youId;
  const isEu = () => g() && g().mode === 'eu';
  const MODE_NOTES = {
    quem: 'Um guardião por ronda vê a pessoa secreta; a equipa toda tenta descobrir quem é.',
    eu: 'Toda a gente recebe uma carta que só os outros veem. Cada um tenta descobrir quem é.'
  };

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), 3200);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  const photo = (key) => `<img alt="" src="/fotos/${esc(key)}.jpg">`;

  // ---------- render ----------

  function render() {
    const phase = state ? state.phase : 'home';
    for (const [name, el] of Object.entries(screens)) el.hidden = name !== phase;
    stopTimer();
    disarmEndGame();
    $('end-game-btn').hidden = !state || !isHost() || state.phase === 'lobby';
    if (!state) return;
    switch (state.phase) {
      case 'lobby': renderLobby(); break;
      case 'playing': renderPlaying(); break;
      case 'results': renderResults(); break;
    }
  }

  // Standings for the whole room: sorted by points, ties share a position.
  function ranked() {
    const list = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name));
    let pos = 0, prev = null;
    return list.map((p, i) => {
      if (p.score !== prev) { pos = i + 1; prev = p.score; }
      return { p, pos };
    });
  }
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  function scoreboard(awards = {}, { guardianId = null } = {}) {
    const anyPoints = state.players.some((p) => p.score > 0);
    return ranked().map(({ p, pos }) => {
      const gain = awards[p.id] || 0;
      const medal = anyPoints && MEDAL[pos] ? MEDAL[pos] : '';
      return `<li class="player-row rank-row ${p.connected ? '' : 'disconnected'} ${anyPoints && pos === 1 ? 'first' : ''}">
        <span class="rank ${medal ? 'medal' : ''}">${medal || `${pos}º`}</span>
        <span class="dot" style="background:${p.color}"></span>
        <span class="player-name">${esc(p.name)}</span>
        ${p.id === state.youId ? '<span class="tag tag-you">tu</span>' : ''}
        ${guardianId && p.id === guardianId ? '<span class="tag tag-guard">guardião</span>' : ''}
        ${!p.connected ? '<span class="tag">ausente</span>' : ''}
        ${gain ? `<span class="gain">+${gain}</span>` : ''}
        <span class="pts">${p.score || 0} pts</span>
      </li>`;
    }).join('');
  }

  function playerRow(p, tags = []) {
    const t = [
      p.id === state.youId ? '<span class="tag tag-you">tu</span>' : '',
      p.id === state.hostId ? '<span class="tag">anfitrião</span>' : '',
      ...tags,
      !p.connected ? '<span class="tag">ausente</span>' : ''
    ].join('');
    return `<li class="player-row ${p.connected ? '' : 'disconnected'}">
      <span class="dot" style="background:${p.color}"></span>
      <span class="player-name">${esc(p.name)}</span>${t}
    </li>`;
  }

  function renderLobby() {
    $('room-code').textContent = state.code;
    const s = state.settings;
    for (const btn of document.querySelectorAll('[data-mode]')) {
      btn.classList.toggle('selected', btn.dataset.mode === s.mode);
      btn.disabled = !isHost();
    }
    $('mode-note').textContent = MODE_NOTES[s.mode] || '';
    for (const btn of document.querySelectorAll('[data-minutes]')) {
      btn.classList.toggle('selected', Number(btn.dataset.minutes) === s.minutes);
      btn.disabled = !isHost();
    }
    $('setting-note').textContent = (s.minutes
      ? `Cada ronda tem ${s.minutes} minutos.` + (s.mode === 'quem' ? ' Se o tempo acabar sem ninguém acertar, o guardião ganha.' : ' Quem não tiver acertado até lá fica sem pontos.')
      : (s.mode === 'quem' ? 'Sem limite de tempo: o guardião termina a ronda quando ninguém acertar.' : 'Sem limite de tempo: a ronda acaba quando toda a gente tiver respondido, ou quando o anfitrião a terminar.')) + (isHost() ? '' : ' Só o anfitrião muda as regras.');
    const anyPoints = state.players.some((p) => p.score > 0);
    $('lobby-players').innerHTML = anyPoints ? scoreboard() : state.players.map((p) => playerRow(p)).join('');
    const n = state.players.filter((p) => p.connected).length;
    const need = Math.max(0, 3 - n);
    $('lobby-note').textContent = need
      ? `Faltam ${need} ${need > 1 ? 'pessoas' : 'pessoa'}… (3 a 20 podem jogar)`
      : isHost() ? 'Está toda a gente? Carrega em Começar.' : 'À espera que o anfitrião comece…';
    const startBtn = $('start-btn');
    startBtn.hidden = !isHost();
    startBtn.disabled = n < 3;
  }

  function myDown() {
    if (localDown && localDown.round === state.round) return localDown.keys;
    return g().down || [];
  }

  function renderPlaying() {
    const game = g();
    if (isEu()) return renderPlayingEu(game);
    $('eu-view').hidden = true;
    $('team-box').hidden = false;
    const guardian = player(game.guardianId);
    const iAmOut = me().eliminated;

    $('round-badge').textContent = `RONDA ${state.round} · ADIVINHA QUEM`;
    startTimer(game.endsAt, $('timer'), $('timer-value'));

    const banner = $('turn-banner');
    banner.className = 'turn-banner';
    if (isGuardian()) {
      banner.classList.add('mine');
      banner.innerHTML = 'És o guardião desta ronda<small>Responde às perguntas na chamada. Os outros tratam das cartas.</small>';
    } else if (iAmOut) {
      banner.classList.add('out');
      banner.innerHTML = 'Erraste. Estás fora desta ronda.<small>Podes continuar a ver. Voltas na próxima.</small>';
    } else {
      banner.innerHTML = `${esc(guardian ? guardian.name : 'Alguém')} guarda o segredo<small>Perguntem na chamada. Aqui, baixa as cartas que já não servem.</small>`;
    }

    $('guardian-view').hidden = !isGuardian();
    $('player-view').hidden = isGuardian();
    if (isGuardian()) {
      const sp = person(game.secretKey);
      $('secret-photo').innerHTML = sp ? photo(sp.key) : '';
      $('secret-name').textContent = sp ? sp.name : '';
    } else {
      renderBoard(game, iAmOut);
    }

    // team: everyone hunting, with how many cards they still have up
    $('team-list').innerHTML = state.players.filter((p) => p.id !== game.guardianId).map((p) => {
      const cls = [p.eliminated ? 'out' : '', p.connected ? '' : 'disconnected'].join(' ');
      return `<li class="chip ${cls}"><span class="dot" style="background:${p.color};width:10px;height:10px"></span>${esc(p.name)}${p.id === state.youId ? ' (tu)' : ''}<span class="cnt">${p.standing}</span></li>`;
    }).join('');
    $('host-end-round').hidden = !(isHost() && !isGuardian());
    $('host-end-round').textContent = 'Terminar a ronda sem vencedor';
    renderStandingsBox();

    const misses = game.guesses.filter((q) => !q.correct).slice().reverse();
    $('misses-box').hidden = !misses.length;
    $('misses-log').innerHTML = misses.map((q) => `<li><span class="n">✗</span><span class="who">${esc(player(q.by)?.name || '?')} disse ${esc(person(q.key)?.name || '?')}</span><span class="ans miss">NÃO É</span></li>`).join('');
  }

  function identityChip(pid, key, { tagYou = false } = {}) {
    const p = player(pid);
    const id = person(key);
    const cls = p.solved ? 'ok' : p.eliminated ? 'ko' : '';
    const status = p.solved ? ' ✓' : p.eliminated ? ' ✗' : '';
    return `<li class="${cls}"><span class="ph">${id ? photo(id.key) : ''}</span><span class="who"><span class="pn">${esc(p.name)}${tagYou && pid === state.youId ? ' (tu)' : ''}${status}</span><span class="idn">${id ? esc(id.name) : '?'}</span></span></li>`;
  }

  function renderPlayingEu(game) {
    const meP = me();
    const done = meP.eliminated || meP.solved;
    $('round-badge').textContent = `RONDA ${state.round} · QUEM SOU EU`;
    startTimer(game.endsAt, $('timer'), $('timer-value'));
    $('guardian-view').hidden = true;
    $('eu-view').hidden = false;
    $('player-view').hidden = false;
    $('team-box').hidden = true;

    const banner = $('turn-banner');
    banner.className = 'turn-banner';
    if (meP.solved) {
      banner.classList.add('mine');
      banner.innerHTML = 'Acertaste! Já sabes quem és.<small>Continua a responder às perguntas dos outros na chamada.</small>';
    } else if (meP.eliminated) {
      banner.classList.add('out');
      banner.innerHTML = 'Erraste. Estás fora desta ronda.<small>Continua a responder às perguntas dos outros.</small>';
    } else {
      banner.innerHTML = 'Tens uma carta na testa<small>Pergunta na chamada quem és ("Tenho óculos?"). Aqui, baixa as cartas que já não podes ser.</small>';
    }

    const myKey = game.identities[state.youId];
    const myP = myKey ? person(myKey) : null;
    $('my-photo').innerHTML = myP ? photo(myP.key) : '<span class="unknown">?</span>';
    $('my-name').textContent = myP ? myP.name : '???';
    $('others-list').innerHTML = state.players
      .filter((p) => p.id !== state.youId && game.identities[p.id])
      .map((p) => identityChip(p.id, game.identities[p.id])).join('')
      || '<li class="empty-note">Ainda não há mais ninguém com carta.</li>';

    renderBoard(game, done);
    $('host-end-round').hidden = !isHost();
    $('host-end-round').textContent = 'Terminar a ronda já';
    // wrong guesses stay private in this mode: who you guessed would be a clue for the others
    $('misses-box').hidden = true;
    renderStandingsBox();
  }

  function renderStandingsBox() {
    const box = $('standings-box');
    box.hidden = !state.players.some((p) => p.score > 0);
    $('standings-list').innerHTML = scoreboard();
  }

  function renderBoard(game, iAmOut) {
    const down = myDown();
    const total = state.people.length;
    const canPlay = !iAmOut;
    $('board-count').textContent = `${total - down.length} de ${total} de pé${canPlay ? (guessMode ? (isEu() ? ' · escolhe quem és' : ' · escolhe quem é') : ' · toca para baixar') : ''}`;
    const board = $('board');
    board.classList.toggle('guessing', guessMode && canPlay);
    // only rebuild the cards when something on the board changed, so the
    // flip animation survives the server's state pushes
    const key = `${state.round}|${canPlay}|${guessMode}|${[...down].sort().join(',')}`;
    if (board.dataset.key === key) { renderGuessArea(); return; }
    board.dataset.key = key;
    board.innerHTML = state.people.map((p) => {
      const isDown = down.includes(p.key);
      return `<button class="card ${isDown ? 'down' : ''}" data-key="${esc(p.key)}" aria-pressed="${isDown}" aria-label="${esc(p.name)}${isDown ? ' (em baixo)' : ''}" ${canPlay ? '' : 'disabled'}>
        <span class="card-inner"><span class="face front">${photo(p.key)}<span class="nm">${esc(p.name)}</span></span><span class="face back"></span></span>
      </button>`;
    }).join('');
    for (const btn of board.querySelectorAll('.card')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (guessMode) {
          if (!myDown().includes(key)) { pickKey = key; renderGuessArea(); }
        } else {
          flip(key);
        }
      });
    }
    renderGuessArea();
  }

  function renderGuessArea() {
    const area = $('guess-area');
    const eu = isEu();
    if (me().eliminated || me().solved) { area.innerHTML = ''; return; }
    if (pickKey) {
      const p = person(pickKey);
      area.innerHTML = `<div class="confirm"><div><b>${eu ? `És ${esc(p.name)}?` : `É ${esc(p.name)}?`}</b> Se errares, ficas fora da ronda e toda a gente fica a saber.</div>
        <div class="row"><button class="btn btn-red" id="confirm-guess">${eu ? `Sim, sou ${esc(p.name)}` : `Sim, é ${esc(p.name)}`}</button><button class="btn" id="cancel-guess">Voltar</button></div></div>`;
      $('confirm-guess').addEventListener('click', () => { wsSend({ type: 'guess', key: pickKey }); guessMode = false; pickKey = null; });
      $('cancel-guess').addEventListener('click', () => { pickKey = null; renderGuessArea(); });
      area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (guessMode) {
      area.innerHTML = `<div class="confirm"><div><b>Toca no tabuleiro</b> ${eu ? 'em quem achas que és.' : 'na pessoa que achas que é.'}</div>
        <div class="row"><button class="btn" id="cancel-guess">Afinal não</button></div></div>`;
      $('cancel-guess').addEventListener('click', () => { guessMode = false; renderPlaying(); });
    } else {
      area.innerHTML = `<button class="btn btn-yellow btn-big btn-guess" id="guess-btn">${eu ? '🪪 Já sei quem sou' : '💡 Acho que é esta pessoa'}</button>`;
      $('guess-btn').addEventListener('click', () => { guessMode = true; renderPlaying(); });
    }
  }

  function flip(key) {
    const set = new Set(myDown());
    set.has(key) ? set.delete(key) : set.add(key);
    localDown = { round: state.round, keys: [...set] };
    renderBoard(g(), me().eliminated || me().solved);
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => wsSend({ type: 'flip', keys: localDown.keys }), 400);
  }

  function renderResultsEu(r) {
    const meP = me();
    const banner = $('result-banner');
    banner.className = 'result-banner' + (meP.solved ? '' : ' guardian');
    banner.textContent = meP.solved ? (r.solved[0] === state.youId ? 'ACERTASTE PRIMEIRO!' : 'ACERTASTE!') : meP.eliminated ? 'ERRASTE…' : 'ACABOU A RONDA';
    $('result-identities').hidden = false;
    $('reveal-row').hidden = true;
    $('identities-list').innerHTML = state.players.filter((p) => g().identities[p.id]).map((p) => identityChip(p.id, g().identities[p.id], { tagYou: true })).join('');
    const n = r.solved.length;
    const first = r.solved[0] ? player(r.solved[0]) : null;
    const howText = {
      all_done: 'Toda a gente já respondeu.',
      time: 'Acabou o tempo.',
      called: 'O anfitrião deu a ronda por terminada.'
    };
    $('result-how-eu').textContent = `${howText[r.how] || ''} ${n ? `${n} ${n === 1 ? 'pessoa acertou' : 'pessoas acertaram'}${first ? `, ${first.name} em primeiro` : ''}.` : 'Ninguém acertou.'}`;
    $('score-rules').textContent = '+2 a quem acerta quem é · +1 extra para o primeiro';
  }

  function renderResults() {
    const r = g().result;
    if (!r) return;
    if (isEu()) renderResultsEu(r);
    else { $('result-identities').hidden = true; $('reveal-row').hidden = false; $('score-rules').textContent = '+2 a quem acerta · +1 ao guardião se ninguém acertar'; }
    $('leaderboard').innerHTML = scoreboard(r.awards || {}, { guardianId: isEu() ? null : g().guardianId });
    const lead = ranked().filter(({ pos }) => pos === 1).map(({ p }) => p);
    $('leader-line').textContent = state.players.some((p) => p.score > 0)
      ? (lead.length === 1 ? `${lead[0].name} vai à frente com ${lead[0].score} pts.` : `Empate na frente: ${lead.map((p) => p.name).join(', ')} com ${lead[0].score} pts.`)
      : 'Ainda ninguém marcou.';
    $('next-btn').hidden = !isHost();
    $('next-note').hidden = isHost();
    $('next-mode-box').hidden = !isHost();
    for (const btn of document.querySelectorAll('#next-mode-box [data-mode]')) btn.classList.toggle('selected', btn.dataset.mode === state.settings.mode);
    if (isEu()) return;
    const winner = r.winnerId ? player(r.winnerId) : null;
    const guardian = player(g().guardianId);
    const sp = person(r.secretKey);
    const banner = $('result-banner');
    banner.className = 'result-banner' + (winner ? '' : ' guardian');
    banner.textContent = winner
      ? (winner.id === state.youId ? 'ACERTASTE!' : `${winner.name.toUpperCase()} ACERTOU!`)
      : (r.how === 'guardian_left' ? 'RONDA SEM VENCEDOR' : `${(guardian?.name || 'O GUARDIÃO').toUpperCase()} AGUENTOU!`);

    $('result-photo').innerHTML = sp ? photo(sp.key) : '';
    $('result-name').textContent = sp ? sp.name : '';
    const mins = Math.floor(r.seconds / 60), secs = r.seconds % 60;
    const dur = mins ? `${mins} min ${secs} s` : `${secs} s`;
    const howText = {
      guess: `${winner?.name || '?'} acertou ao fim de ${dur}.`,
      time: `Acabou o tempo e ninguém acertou. Ponto para ${guardian?.name || 'o guardião'}.`,
      called: `A ronda foi dada por terminada sem ninguém acertar. Ponto para ${guardian?.name || 'o guardião'}.`,
      all_out: `Toda a gente errou. Ponto para ${guardian?.name || 'o guardião'}.`,
      guardian_left: 'O guardião saiu a meio da ronda.'
    };
    $('result-how').textContent = howText[r.how] || '';
    const misses = g().guesses.filter((q) => !q.correct);
    $('result-guesses').textContent = misses.length
      ? 'Palpites errados: ' + misses.map((q) => `${player(q.by)?.name || '?'} disse ${person(q.key)?.name || '?'}`).join('; ') + '.'
      : 'Ninguém errou um palpite nesta ronda.';
  }

  // ---------- timer ----------

  function startTimer(endsAt, pillEl, valueEl) {
    stopTimer();
    if (!endsAt) { pillEl.hidden = true; return; }
    pillEl.hidden = false;
    const tick = () => {
      const s = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      valueEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      pillEl.classList.toggle('urgent', s <= 30);
      if (s <= 0) stopTimer();
    };
    tick();
    timerInterval = setInterval(tick, 250);
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }

  // ---------- eventos ----------

  $('home-form').addEventListener('submit', (ev) => { ev.preventDefault(); $('create-btn').click(); });

  $('create-btn').addEventListener('click', () => {
    const name = $('name-input').value.trim();
    if (!name) return toast('Escreve primeiro o teu nome.');
    wsSend({ type: 'create', name });
  });

  $('join-btn').addEventListener('click', () => {
    const name = $('name-input').value.trim();
    const code = $('code-input').value.trim().toUpperCase();
    if (!name) return toast('Escreve primeiro o teu nome.');
    if (code.length !== 4) return toast('O código da sala tem 4 letras.');
    wsSend({ type: 'join', name, code });
  });

  $('code-input').addEventListener('input', (ev) => {
    ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  $('room-code').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      $('copy-hint').textContent = 'copiado! manda à equipa';
      setTimeout(() => ($('copy-hint').textContent = 'toca para copiar o link de convite'), 2500);
    } catch {
      toast(`Link de convite: ${url}`);
    }
  });

  for (const btn of document.querySelectorAll('[data-minutes]')) {
    btn.addEventListener('click', () => wsSend({ type: 'settings', minutes: Number(btn.dataset.minutes) }));
  }
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => wsSend({ type: 'settings', mode: btn.dataset.mode }));
  }

  $('start-btn').addEventListener('click', () => wsSend({ type: 'start' }));
  $('next-btn').addEventListener('click', () => wsSend({ type: 'next_round' }));

  // ending a round without a winner: tap once to arm, again within 3s to confirm
  function armable(btn, idle, armed, action) {
    let t = null;
    let idleNow = idle;
    const reset = () => { clearTimeout(t); btn.classList.remove('armed'); btn.textContent = idleNow; };
    btn.addEventListener('click', () => {
      if (btn.classList.contains('armed')) { reset(); action(); }
      else { idleNow = idle || btn.textContent; btn.classList.add('armed'); btn.textContent = armed; t = setTimeout(reset, 3000); }
    });
    return reset;
  }
  const resetEndRound = armable($('end-round-btn'), 'Ninguém acertou, terminar a ronda', 'Toca outra vez para terminar', () => wsSend({ type: 'end_round' }));
  const resetHostEnd = armable($('host-end-round'), null, 'Toca outra vez para terminar', () => wsSend({ type: 'end_round' }));

  const endGameBtn = $('end-game-btn');
  const resetEndGame = armable(endGameBtn, '✕ Terminar jogo', 'Toca outra vez para terminar', () => wsSend({ type: 'end_game' }));
  function disarmEndGame() { resetEndGame(); resetEndRound(); resetHostEnd(); }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (guessMode || pickKey)) { guessMode = false; pickKey = null; if (state && state.phase === 'playing') renderPlaying(); }
  });

  window.addEventListener('beforeunload', () => { intentionallyClosed = true; });

  // código pré-preenchido a partir do link de convite
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('code-input').value = params.get('room').toUpperCase().slice(0, 4);

  connect();
})();
