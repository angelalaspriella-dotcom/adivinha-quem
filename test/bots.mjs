// Fills a room with bots for manual testing: node test/bots.mjs PORT CODE Name1 Name2 ...
// Hunter bots flip a few random cards; a guardian bot does nothing (the talking is on the call).
import WebSocket from 'ws';

const [PORT, CODE, ...NAMES] = process.argv.slice(2);
for (const name of NAMES) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let flipped = false;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, code: CODE })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'state') return;
    const g = m.game;
    if (m.phase !== 'playing') { flipped = false; return; }
    if (g.guardianId !== m.youId && !flipped) {
      flipped = true;
      const keys = m.people.map((p) => p.key).sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 6));
      setTimeout(() => ws.send(JSON.stringify({ type: 'flip', keys })), 1500);
    }
  });
  ws.on('close', () => console.log(name, 'closed'));
}
setTimeout(() => process.exit(0), 15 * 60_000);
