// Simulates a whole team over real WebSockets against a running server.
// Usage: node test/sim.mjs [port]
import WebSocket from 'ws';

const PORT = process.argv[2] || 3100;
const URL = `ws://localhost:${PORT}`;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, state: null, joined: null, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === 'state') c.state = m;
    if (m.type === 'joined') c.joined = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.open = () => new Promise((r) => (ws.readyState === 1 ? r() : ws.once('open', r)));
  c.me = () => c.state.players.find((p) => p.id === c.state.youId);
  c.g = () => c.state.game;
  return c;
}

const NAMES = ['Angela', 'Vasco', 'Marta', 'Bruno', 'Ana', 'Daniel', 'Eduarda', 'João'];
const C = NAMES.map(client);
await Promise.all(C.map((c) => c.open()));

console.log('\n1. Sala');
C[0].send({ type: 'create', name: C[0].name }); await tick(100);
const code = C[0].joined.code;
check('Sala criada com código de 4 letras', /^[A-Z]{4}$/.test(code), code);
for (const c of C.slice(1)) { c.send({ type: 'join', name: c.name, code }); await tick(30); }
await tick(150);
check('8 jogadores na sala', C[0].state.players.length === 8);
check('Angela é anfitriã', C[0].state.hostId === C[0].state.youId);
check('Todos recebem as 17 caras', C.every((c) => c.state.people.length === 17));
C[1].send({ type: 'settings', laps: 1 }); await tick(80);
check('Só o anfitrião muda regras', C[0].state.settings.laps === 2);
C[0].send({ type: 'settings', laps: 1, timer: 0 }); await tick(80);
check('Anfitrião muda para 1 volta', C[0].state.settings.laps === 1);
const dup = client('Vasco'); await dup.open(); dup.send({ type: 'join', name: 'Vasco', code }); await tick(100);
check('Nome repetido é recusado', dup.msgs.some((m) => m.type === 'join_error'));
dup.ws.close();

console.log('\n2. Começar a ronda');
C[0].send({ type: 'start' }); await tick(200);
check('Fase "playing", ronda 1', C.every((c) => c.state.phase === 'playing' && c.state.round === 1));
const guardianId = C[0].g().guardianId;
const guardian = C.find((c) => c.state.youId === guardianId);
const hunters = C.filter((c) => c !== guardian);
check('Há um guardião', !!guardian);
check('Só o guardião vê a pessoa secreta', !!guardian.g().secretKey && hunters.every((c) => c.g().secretKey === null));
check('Ordem tem os 7 caçadores', guardian.g().order.length === 7 && !guardian.g().order.includes(guardianId));
check('Sem temporizador', guardian.g().turnEndsAt === null);
const secret = guardian.g().secretKey;

console.log('\n3. Perguntas e cartas');
const first = hunters.find((c) => c.state.youId === guardian.g().currentId);
check('Alguém está a perguntar', !!first);
first.send({ type: 'answer', a: 'sim' }); await tick(80);
check('Caçador não consegue registar resposta', guardian.g().answers.length === 0);
guardian.send({ type: 'answer', a: 'sim' }); await tick(100);
check('Guardião regista SIM, vez avança', guardian.g().answers.length === 1 && guardian.g().answers[0].a === 'sim' && guardian.g().currentId !== first.state.youId);
check('Resposta chega a toda a gente', hunters.every((c) => c.g().answers.length === 1));
const keys = C[0].state.people.map((p) => p.key).filter((k) => k !== secret);
hunters[0].send({ type: 'flip', keys: keys.slice(0, 5) }); await tick(100);
check('Cartas guardadas (12 de pé)', hunters[0].me().standing === 12 && hunters[0].g().down.length === 5);
check('Os outros veem a contagem, não as cartas', hunters[1].state.players.find((p) => p.id === hunters[0].state.youId).standing === 12 && hunters[1].g().down.length === 0);
guardian.send({ type: 'flip', keys: keys.slice(0, 3) }); await tick(80);
check('Guardião não tem tabuleiro', guardian.me().standing === 17);
C[0].send({ type: 'skip' }); await tick(100);
check('Anfitrião salta quem está a perguntar', guardian.g().answers.length === 2 && guardian.g().answers[1].a === 'skip');

console.log('\n4. Palpite errado');
const wrongKey = keys[0];
const h1 = hunters[1];
h1.send({ type: 'guess', key: wrongKey }); await tick(120);
check('Jogo continua', C[0].state.phase === 'playing');
check('Quem errou fica eliminado', h1.me().eliminated === true);
check('Toda a gente vê o palpite errado', hunters.every((c) => c.g().guesses.length === 1 && c.g().guesses[0].key === wrongKey && c.g().guesses[0].correct === false));
h1.send({ type: 'guess', key: secret }); await tick(100);
check('Eliminado não pode voltar a arriscar', C[0].state.phase === 'playing' && guardian.g().guesses.length === 1);
check('Ordem salta o eliminado', guardian.g().currentId !== h1.state.youId);

console.log('\n5. Palpite certo');
const h2 = hunters[2];
h2.send({ type: 'guess', key: secret }); await tick(150);
check('Fase "results"', C.every((c) => c.state.phase === 'results'));
check('Vencedor correto', C[0].g().result.winnerId === h2.state.youId && C[0].g().result.how === 'guess');
check('Pessoa secreta revelada a todos', C.every((c) => c.g().secretKey === secret));
check('+2 ao vencedor, 0 ao guardião', h2.me().score === 2 && guardian.me().score === 0);
check('Palpite errado visível no fim', C[0].g().guesses.length === 2);

console.log('\n6. Ronda 2: o guardião roda e as voltas esgotam');
C[0].send({ type: 'next_round' }); await tick(200);
check('Ronda 2 a decorrer', C.every((c) => c.state.phase === 'playing' && c.state.round === 2));
const g2 = C.find((c) => c.state.youId === C[0].g().guardianId);
check('Guardião diferente', g2 !== guardian);
check('Eliminações limpas', C.every((c) => !c.me().eliminated));
check('Tabuleiros limpos', C.every((c) => c.me().standing === 17));
const nOrder = g2.g().order.length;
for (let i = 0; i < nOrder; i++) { g2.send({ type: 'answer', a: i % 2 ? 'sim' : 'nao' }); await tick(60); }
await tick(150);
check('Uma volta completa sem acertar: o guardião ganha', C[0].state.phase === 'results' && C[0].g().result.winnerId === null && C[0].g().result.how === 'laps');
check('+1 ao guardião', g2.me().score === 1);

console.log('\n7. Ronda 3 com temporizador e entrada a meio');
C[0].send({ type: 'end_game' }); await tick(150);
check('Terminar jogo volta à sala', C.every((c) => c.state.phase === 'lobby'));
check('Pontos mantêm-se na sala', h2.me().score === 2);
C[0].send({ type: 'settings', timer: 30, laps: 3 }); await tick(60);
C[0].send({ type: 'start' }); await tick(200);
const g3 = C.find((c) => c.state.youId === C[0].g().guardianId);
check('Temporizador armado', typeof g3.g().turnEndsAt === 'number' && g3.g().turnEndsAt > Date.now());
const late = client('Soraia'); await late.open(); late.send({ type: 'join', name: 'Soraia', code }); await tick(150);
check('Entrar a meio da ronda: recebe estado de jogo', late.state && late.state.phase === 'playing' && late.g().down.length === 0);
check('Entra no fim da ordem', g3.g().order[g3.g().order.length - 1] === late.state.youId);

console.log('\n8. Todos erram');
const hunters3 = C.filter((c) => c !== g3).concat([late]);
const secret3 = g3.g().secretKey;
const wrong3 = C[0].state.people.map((p) => p.key).find((k) => k !== secret3);
for (const c of hunters3) { c.send({ type: 'guess', key: wrong3 }); await tick(40); }
await tick(200);
check('Toda a gente errou: o guardião ganha', C[0].state.phase === 'results' && C[0].g().result.how === 'all_out');

console.log('\n9. Guardião perde a ligação (servidor com GUARDIAN_GRACE_MS=600)');
C[0].send({ type: 'next_round' }); await tick(200);
const g4 = C.concat([late]).find((c) => c.state.youId === C[0].g().guardianId);
const anyone = C.find((c) => c !== g4);
g4.ws.close(); await tick(200);
check('Ronda continua durante o período de tolerância', anyone.state.phase === 'playing');
check('Os outros são avisados', anyone.msgs.some((m) => m.type === 'notice' && /perdeu a ligação/.test(m.message)));
// comes back in time with the rejoin token
const back = client(g4.name); await back.open();
back.send({ type: 'rejoin', code, playerId: g4.joined.playerId, token: g4.joined.token }); await tick(200);
check('Guardião volta e a ronda continua', back.state && back.state.phase === 'playing' && back.g().secretKey !== null);
await tick(700);
check('Tolerância cancelada: ronda ainda a decorrer', anyone.state.phase === 'playing');
// and now for real: drops and does not come back
back.ws.close(); await tick(1000);
check('Sem voltar: ronda termina sem vencedor', anyone.state.phase === 'results' && anyone.g().result.how === 'guardian_left');

console.log(`\nResultado: ${pass} certos, ${fail} falhados`);
for (const c of C.concat([late])) c.ws.close();
process.exit(fail ? 1 : 0);
