// Fills a room with bots for manual testing: node test/bots.mjs PORT CODE Name1 Name2 ...
// A bot that becomes guardian answers every 5 s; hunter bots flip a few random cards.
import WebSocket from 'ws';

const [PORT, CODE, ...NAMES] = process.argv.slice(2);
for (const name of NAMES) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let state = null, answerTimer = null, flipped = false;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, code: CODE })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'state') return;
    state = m;
    const g = m.game;
    if (m.phase !== 'playing') { clearInterval(answerTimer); answerTimer = null; flipped = false; return; }
    if (g.guardianId === m.youId) {
      if (!answerTimer) answerTimer = setInterval(() => ws.send(JSON.stringify({ type: 'answer', a: Math.random() < 0.5 ? 'sim' : 'nao' })), 5000);
    } else if (!flipped) {
      flipped = true;
      const keys = m.people.map((p) => p.key).sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 6));
      setTimeout(() => ws.send(JSON.stringify({ type: 'flip', keys })), 1500);
    }
  });
  ws.on('close', () => console.log(name, 'closed'));
}
setTimeout(() => process.exit(0), 15 * 60_000);
