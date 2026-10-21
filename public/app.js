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
    for (const btn of document.querySelectorAll('[data-minutes]')) {
      btn.classList.toggle('selected', Number(btn.dataset.minutes) === s.minutes);
      btn.disabled = !isHost();
    }
    $('setting-note').textContent = (s.minutes
      ? `Cada ronda tem ${s.minutes} minutos. Se o tempo acabar sem ninguém acertar, o guardião ganha.`
      : 'Sem limite de tempo: o guardião termina a ronda quando ninguém acertar.') + (isHost() ? '' : ' Só o anfitrião muda as regras.');
    $('lobby-players').innerHTML = state.players.map((p) => playerRow(p, p.score ? [`<span class="pts">${p.score} pts</span>`] : [])).join('');
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
    const guardian = player(game.guardianId);
    const iAmOut = me().eliminated;

    $('round-badge').textContent = `RONDA ${state.round}`;
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

    const misses = game.guesses.filter((q) => !q.correct).slice().reverse();
    $('misses-box').hidden = !misses.length;
    $('misses-log').innerHTML = misses.map((q) => `<li><span class="n">✗</span><span class="who">${esc(player(q.by)?.name || '?')} disse ${esc(person(q.key)?.name || '?')}</span><span class="ans miss">NÃO É</span></li>`).join('');
  }

  function renderBoard(game, iAmOut) {
    const down = myDown();
    const total = state.people.length;
    const canPlay = !iAmOut;
    $('board-count').textContent = `${total - down.length} de ${total} de pé${canPlay ? (guessMode ? ' · escolhe quem é' : ' · toca para baixar') : ''}`;
    const board = $('board');
    board.classList.toggle('guessing', guessMode && canPlay);
    // only rebuild the cards when something on the board changed, so the
    // flip animation survives the server's state pushes
    const key = `${state.round}|${canPlay}|${[...down].sort().join(',')}`;
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
    if (me().eliminated) { area.innerHTML = ''; return; }
    if (pickKey) {
      const p = person(pickKey);
      area.innerHTML = `<div class="confirm"><div><b>É ${esc(p.name)}?</b> Se errares, ficas fora da ronda e toda a gente fica a saber.</div>
        <div class="row"><button class="btn btn-red" id="confirm-guess">Sim, é ${esc(p.name)}</button><button class="btn" id="cancel-guess">Voltar</button></div></div>`;
      $('confirm-guess').addEventListener('click', () => { wsSend({ type: 'guess', key: pickKey }); guessMode = false; pickKey = null; });
      $('cancel-guess').addEventListener('click', () => { pickKey = null; renderGuessArea(); });
      area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (guessMode) {
      area.innerHTML = `<div class="confirm"><div><b>Toca no tabuleiro</b> na pessoa que achas que é.</div>
        <div class="row"><button class="btn" id="cancel-guess">Afinal não</button></div></div>`;
      $('cancel-guess').addEventListener('click', () => { guessMode = false; renderPlaying(); });
    } else {
      area.innerHTML = `<button class="btn btn-yellow btn-big btn-guess" id="guess-btn">💡 Acho que é esta pessoa</button>`;
      $('guess-btn').addEventListener('click', () => { guessMode = true; renderPlaying(); });
    }
  }

  function flip(key) {
    const set = new Set(myDown());
    set.has(key) ? set.delete(key) : set.add(key);
    localDown = { round: state.round, keys: [...set] };
    renderBoard(g(), me().eliminated);
    clearTimeout(flipTimer);
    flipTimer = setTimeout(() => wsSend({ type: 'flip', keys: localDown.keys }), 400);
  }

  function renderResults() {
    const r = g().result;
    if (!r) return;
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

    const standings = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = standings[0]?.score || 0;
    $('leaderboard').innerHTML = standings.map((p) => {
      const gain = (r.awards && r.awards[p.id]) || 0;
      const tags = [
        p.id === g().guardianId ? '<span class="tag tag-guard">guardião</span>' : '',
        top > 0 && p.score === top ? '<span class="tag tag-win">líder</span>' : '',
        gain ? `<span class="gain">+${gain}</span>` : '',
        `<span class="pts">${p.score || 0} pts</span>`
      ];
      return playerRow(p, tags);
    }).join('');
    $('next-btn').hidden = !isHost();
    $('next-note').hidden = isHost();
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

  $('start-btn').addEventListener('click', () => wsSend({ type: 'start' }));
  $('next-btn').addEventListener('click', () => wsSend({ type: 'next_round' }));

  // ending a round without a winner: tap once to arm, again within 3s to confirm
  function armable(btn, idle, armed, action) {
    let t = null;
    const reset = () => { clearTimeout(t); btn.classList.remove('armed'); btn.textContent = idle; };
    btn.addEventListener('click', () => {
      if (btn.classList.contains('armed')) { reset(); action(); }
      else { btn.classList.add('armed'); btn.textContent = armed; t = setTimeout(reset, 3000); }
    });
    return reset;
  }
  const resetEndRound = armable($('end-round-btn'), 'Ninguém acertou, terminar a ronda', 'Toca outra vez para terminar', () => wsSend({ type: 'end_round' }));
  const resetHostEnd = armable($('host-end-round'), 'Terminar a ronda sem vencedor', 'Toca outra vez para terminar', () => wsSend({ type: 'end_round' }));

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
