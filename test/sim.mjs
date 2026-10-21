// Simulates a whole team over real WebSockets against a running server.
// Usage: node test/sim.mjs [port]   (start the server with GUARDIAN_GRACE_MS=600 for step 8)
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
C[1].send({ type: 'settings', minutes: 5 }); await tick(80);
check('Só o anfitrião muda regras', C[0].state.settings.minutes === 0);
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
check('Sem temporizador', guardian.g().endsAt === null);
check('Estado sem perguntas nem ordem (tudo falado)', !('answers' in guardian.g()) && !('order' in guardian.g()));
const secret = guardian.g().secretKey;

console.log('\n3. Cartas');
const keys = C[0].state.people.map((p) => p.key).filter((k) => k !== secret);
hunters[0].send({ type: 'flip', keys: keys.slice(0, 5) }); await tick(100);
check('Cartas guardadas (12 de pé)', hunters[0].me().standing === 12 && hunters[0].g().down.length === 5);
check('Os outros veem a contagem, não as cartas', hunters[1].state.players.find((p) => p.id === hunters[0].state.youId).standing === 12 && hunters[1].g().down.length === 0);
guardian.send({ type: 'flip', keys: keys.slice(0, 3) }); await tick(80);
check('Guardião não tem tabuleiro', guardian.me().standing === 17);

console.log('\n4. Palpite errado');
const wrongKey = keys[0];
const h1 = hunters[1];
h1.send({ type: 'guess', key: wrongKey }); await tick(120);
check('Jogo continua', C[0].state.phase === 'playing');
check('Quem errou fica eliminado', h1.me().eliminated === true);
check('Toda a gente vê o palpite errado', hunters.every((c) => c.g().guesses.length === 1 && c.g().guesses[0].key === wrongKey && c.g().guesses[0].correct === false));
h1.send({ type: 'guess', key: secret }); await tick(100);
check('Eliminado não pode voltar a arriscar', C[0].state.phase === 'playing' && guardian.g().guesses.length === 1);

console.log('\n5. Palpite certo');
const h2 = hunters[2];
h2.send({ type: 'guess', key: secret }); await tick(150);
check('Fase "results"', C.every((c) => c.state.phase === 'results'));
check('Vencedor correto', C[0].g().result.winnerId === h2.state.youId && C[0].g().result.how === 'guess');
check('Pessoa secreta revelada a todos', C.every((c) => c.g().secretKey === secret));
check('+2 ao vencedor, 0 ao guardião', h2.me().score === 2 && guardian.me().score === 0);
check('Duração registada', typeof C[0].g().result.seconds === 'number');
const h2After1 = h2.me().score;

console.log('\n6. Ronda 2: o guardião roda e dá a ronda por terminada');
C[0].send({ type: 'next_round' }); await tick(200);
check('Ronda 2 a decorrer', C.every((c) => c.state.phase === 'playing' && c.state.round === 2));
const g2 = C.find((c) => c.state.youId === C[0].g().guardianId);
check('Guardião diferente', g2 !== guardian);
check('Eliminações limpas', C.every((c) => !c.me().eliminated));
check('Tabuleiros limpos', C.every((c) => c.me().standing === 17));
const notAllowed = C.find((c) => c !== g2 && c.state.youId !== C[0].state.hostId);
notAllowed.send({ type: 'end_round' }); await tick(80);
check('Um caçador normal não termina a ronda', C[0].state.phase === 'playing');
g2.send({ type: 'end_round' }); await tick(150);
check('Guardião termina a ronda: ganha', C[0].state.phase === 'results' && C[0].g().result.winnerId === null && C[0].g().result.how === 'called');
check('+1 ao guardião', C[0].g().result.awards[g2.state.youId] === 1 && Object.keys(C[0].g().result.awards).length === 1);

console.log('\n7. Ronda 3 com tempo, entrada a meio, todos erram');
C[0].send({ type: 'end_game' }); await tick(150);
check('Terminar jogo volta à sala', C.every((c) => c.state.phase === 'lobby'));
check('Pontos mantêm-se na sala', h2.me().score === h2After1 + (g2 === h2 ? 1 : 0));
C[0].send({ type: 'settings', minutes: 5 }); await tick(60);
C[0].send({ type: 'start' }); await tick(200);
const g3 = C.find((c) => c.state.youId === C[0].g().guardianId);
check('Temporizador de ronda armado (~5 min)', typeof g3.g().endsAt === 'number' && g3.g().endsAt - Date.now() > 4.5 * 60_000);
const late = client('Soraia'); await late.open(); late.send({ type: 'join', name: 'Soraia', code }); await tick(150);
check('Entrar a meio da ronda: recebe estado de jogo e tabuleiro limpo', late.state && late.state.phase === 'playing' && late.g().down.length === 0);
const hunters3 = C.filter((c) => c !== g3).concat([late]);
const secret3 = g3.g().secretKey;
const wrong3 = C[0].state.people.map((p) => p.key).find((k) => k !== secret3);
for (const c of hunters3) { c.send({ type: 'guess', key: wrong3 }); await tick(40); }
await tick(200);
check('Toda a gente errou: o guardião ganha', C[0].state.phase === 'results' && C[0].g().result.how === 'all_out');

console.log('\n8. Guardião perde a ligação (servidor com GUARDIAN_GRACE_MS=600)');
C[0].send({ type: 'next_round' }); await tick(200);
const g4 = C.concat([late]).find((c) => c.state.youId === C[0].g().guardianId);
const anyone = C.find((c) => c !== g4);
g4.ws.close(); await tick(200);
check('Ronda continua durante o período de tolerância', anyone.state.phase === 'playing');
check('Os outros são avisados', anyone.msgs.some((m) => m.type === 'notice' && /perdeu a ligação/.test(m.message)));
const back = client(g4.name); await back.open();
back.send({ type: 'rejoin', code, playerId: g4.joined.playerId, token: g4.joined.token }); await tick(200);
check('Guardião volta e a ronda continua', back.state && back.state.phase === 'playing' && back.g().secretKey !== null);
await tick(700);
check('Tolerância cancelada: ronda ainda a decorrer', anyone.state.phase === 'playing');
back.ws.close(); await tick(1000);
check('Sem voltar: ronda termina sem vencedor e sem pontos', anyone.state.phase === 'results' && anyone.g().result.how === 'guardian_left' && Object.keys(anyone.g().result.awards).length === 0);

console.log('\n9. Modo Quem sou eu');
const all = C.filter((c) => c !== g4).concat([back, late]).filter((c) => c.ws.readyState === 1);
// the host may have changed if the dropped guardian was Angela
const H = all.find((c) => c.state && c.state.hostId === c.state.youId);
const NH = all.find((c) => c !== H);
H.send({ type: 'end_game' }); await tick(200);
NH.send({ type: 'settings', mode: 'eu' }); await tick(80);
check('Só o anfitrião muda o modo', H.state.settings.mode === 'quem');
H.send({ type: 'settings', mode: 'eu', minutes: 0 }); await tick(80);
check('Modo Quem sou eu escolhido', H.state.settings.mode === 'eu');
H.send({ type: 'start' }); await tick(250);
const live = all.filter((c) => c.state && c.state.phase === 'playing');
check('Ronda a decorrer no modo eu, sem guardião', live.length >= 3 && live.every((c) => c.g().mode === 'eu' && c.g().guardianId === null));
check('Vejo as cartas dos outros, mas não a minha', live.every((c) => !(c.state.youId in c.g().identities) && Object.keys(c.g().identities).length === live.length - 1));
check('Toda a gente tem carta diferente', new Set(Object.values(live[0].g().identities)).size === Object.keys(live[0].g().identities).length);
const a1 = live[0], a2 = live[1], a3 = live[2];
const myKey = (c) => live.find((o) => o !== c).g().identities[c.state.youId];
a1.send({ type: 'guess', key: live[0].state.people.map((p) => p.key).find((k) => k !== myKey(a1)) }); await tick(150);
check('Palpite errado: fora da ronda, e a sua carta continua escondida para ele', a1.me().eliminated && !(a1.state.youId in a1.g().identities));
a2.send({ type: 'guess', key: myKey(a2) }); await tick(150);
check('Palpite certo: fica resolvido e passa a ver a sua carta', a2.me().solved && a2.g().identities[a2.state.youId] === myKey(a2));
check('Os outros veem quem já acertou', a3.state.players.find((p) => p.id === a2.state.youId).solved);
check('Ronda continua enquanto houver gente a pensar', a3.state.phase === 'playing');
const newcomer = client('Rita'); await newcomer.open(); newcomer.send({ type: 'join', name: 'Rita', code }); await tick(150);
check('Quem entra a meio recebe carta', newcomer.state.phase === 'playing' && !!a3.g().identities[newcomer.state.youId]);
for (const c of live.slice(2).concat([newcomer])) { c.send({ type: 'guess', key: myKey(c) }); await tick(60); }
await tick(250);
check('Toda a gente respondeu: ronda termina', a3.state.phase === 'results' && a3.g().result.how === 'all_done');
check('Primeiro a acertar leva +3, os outros +2, quem errou 0', a3.g().result.awards[a2.state.youId] === 3 && a3.g().result.awards[a3.state.youId] === 2 && !a3.g().result.awards[a1.state.youId]);
check('No fim, todas as cartas ficam visíveis, a minha incluída', a1.g().identities[a1.state.youId] === myKey(a1));
newcomer.ws.close();

console.log('\n10. Quem sou eu: quem falta responder sai');
H.send({ type: 'next_round' }); await tick(250);
const live2 = all.filter((c) => c.ws.readyState === 1 && c.state && c.state.phase === 'playing');
const key2 = (c) => live2.find((o) => o !== c).g().identities[c.state.youId];
const lastOne = live2[live2.length - 1];
for (const c of live2) if (c !== lastOne) { c.send({ type: 'guess', key: key2(c) }); await tick(50); }
await tick(150);
check('Ronda aberta enquanto falta um', live2[0].state.phase === 'playing');
lastOne.ws.close(); await tick(200);
check('Sai o último por responder: tolerância, ainda a decorrer', live2[0].state.phase === 'playing');
await tick(800);
check('Não voltou: a ronda fecha sozinha', live2[0].state.phase === 'results' && live2[0].g().result.how === 'all_done');
H.send({ type: 'next_round' }); await tick(250);
check('Nova ronda de Quem sou eu a decorrer', H.state.phase === 'playing' && H.g().mode === 'eu');
H.send({ type: 'end_round' }); await tick(150);
check('Anfitrião fecha a ronda: resultados sem pontos', H.state.phase === 'results' && H.g().result.how === 'called' && Object.keys(H.g().result.awards).length === 0);
H.send({ type: 'settings', mode: 'quem' }); await tick(80);
H.send({ type: 'next_round' }); await tick(250);
check('Trocar de jogo entre rondas, sem passar pela sala', H.state.phase === 'playing' && H.g().mode === 'quem' && !!H.g().guardianId);

console.log(`\nResultado: ${pass} certos, ${fail} falhados`);
for (const c of C.concat([late, back])) try { c.ws.close(); } catch {}
process.exit(fail ? 1 : 0);
