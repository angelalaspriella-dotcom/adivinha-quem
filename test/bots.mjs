// Fills a room with bots for manual testing: node test/bots.mjs PORT CODE Name1 Name2 ...
// Hunter bots flip a few random cards. In Quem sou eu the bots peek at each other's
// screens to learn their own card and guess it after a few seconds, so scores move.
import WebSocket from 'ws';

const [PORT, CODE, ...NAMES] = process.argv.slice(2);
const states = new Map(); // name -> last state, shared so bots can "see" each other's screens

for (const name of NAMES) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let flipped = false, guessed = false;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, code: CODE })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'state') return;
    states.set(name, m);
    const g = m.game;
    if (m.phase !== 'playing') { flipped = false; guessed = false; return; }
    if (g.guardianId !== m.youId && !flipped) {
      flipped = true;
      const keys = m.people.map((p) => p.key).sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 6));
      setTimeout(() => ws.send(JSON.stringify({ type: 'flip', keys })), 1500);
    }
    if (g.mode === 'eu' && !guessed) {
      guessed = true;
      setTimeout(() => {
        const other = [...states.values()].find((s) => s.youId !== m.youId && s.game && s.game.identities[m.youId]);
        if (other) ws.send(JSON.stringify({ type: 'guess', key: other.game.identities[m.youId] }));
      }, 3000 + Math.random() * 5000);
    }
  });
  ws.on('close', () => console.log(name, 'closed'));
}
setTimeout(() => process.exit(0), 15 * 60_000);
