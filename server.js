const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { PEOPLE } = require('./people');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 10 * 60_000; // empty rooms are deleted after this
const GUARDIAN_GRACE_MS = Number(process.env.GUARDIAN_GRACE_MS) || 20_000; // time for a dropped guardian to come back
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 20;
const TIMER_OPTIONS = [0, 30, 45, 60]; // seconds per question; 0 = no timer
const LAP_OPTIONS = [1, 2, 3];          // how many times the asking order loops before the guardian wins

const PLAYER_COLORS = [
  '#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#457b9d',
  '#6d597a', '#b5838d', '#588157', '#bc4749', '#3a86ff',
  '#7209b7', '#ff006e', '#8d5524', '#118ab2', '#22223b',
  '#ff7f11', '#06d6a0', '#8338ec', '#ef476f', '#ffd166'
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** rooms: code -> room */
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(),
    phase: 'lobby', // lobby | playing | results
    game: null,
    round: 0,
    guardianHistory: [], // player ids that already guarded, so the role rotates
    turnTimer: null,
    graceTimer: null,
    emptySince: null,
    settings: { timer: 0, laps: 2 }
  };
  rooms.set(room.code, room);
  return room;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}

function currentAskerId(g) {
  if (!g || !g.order.length) return null;
  return g.order[g.turnIndex % g.order.length];
}

function snapshotFor(room, player) {
  const g = room.game;
  const base = {
    type: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    youId: player.id,
    round: room.round,
    settings: room.settings,
    people: PEOPLE,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      connected: p.connected,
      score: p.score || 0,
      standing: g ? PEOPLE.length - (g.down[p.id] || []).length : PEOPLE.length,
      eliminated: g ? g.eliminated.includes(p.id) : false
    })),
    game: null
  };
  if (g) {
    const reveal = room.phase === 'results' || player.id === g.guardianId;
    base.game = {
      guardianId: g.guardianId,
      secretKey: reveal ? g.secretKey : null,
      order: g.order,
      currentId: room.phase === 'playing' ? currentAskerId(g) : null,
      lap: g.lap,
      totalLaps: g.totalLaps,
      turnEndsAt: g.turnEndsAt || null,
      answers: g.answers,
      guesses: g.guesses,
      down: g.down[player.id] || [],
      result: room.phase === 'results' ? g.result : null
    };
  }
  return base;
}

function pushState(room) {
  for (const p of room.players.values()) send(p.ws, snapshotFor(room, p));
}

function clearTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function clearGrace(room) {
  if (room.graceTimer) {
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
  }
}

// ---------- game flow ----------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The guardian rotates: whoever has guarded least recently goes next.
function pickGuardian(room) {
  const ids = connectedPlayers(room).map((p) => p.id);
  const never = ids.filter((id) => !room.guardianHistory.includes(id));
  if (never.length) return never[Math.floor(Math.random() * never.length)];
  // everyone has guarded: pick the one longest ago
  for (const id of room.guardianHistory) if (ids.includes(id)) return id;
  return ids[0];
}

function startRound(room) {
  clearTimer(room);
  const guardianId = pickGuardian(room);
  room.guardianHistory = [...room.guardianHistory.filter((id) => id !== guardianId), guardianId];
  const askers = shuffle(connectedPlayers(room).map((p) => p.id).filter((id) => id !== guardianId));
  room.round += 1;
  room.game = {
    guardianId,
    secretKey: PEOPLE[Math.floor(Math.random() * PEOPLE.length)].key,
    order: askers,
    turnIndex: 0,
    lap: 1,
    totalLaps: room.settings.laps,
    answers: [],   // { by, a: 'sim' | 'nao' | 'skip' }
    guesses: [],   // { by, key, correct }
    eliminated: [],
    down: {},      // playerId -> [person keys]
    turnEndsAt: null,
    result: null
  };
  room.phase = 'playing';
  armTurn(room);
}

function armTurn(room) {
  const g = room.game;
  clearTimer(room);
  if (room.phase !== 'playing') return;
  // skip askers who are gone or out of the round
  let guard = 0;
  while (guard++ < g.order.length) {
    const current = room.players.get(currentAskerId(g));
    if (current && current.connected && !g.eliminated.includes(current.id)) break;
    advanceTurnPointer(room);
    if (room.phase !== 'playing') return;
  }
  if (room.settings.timer > 0) {
    const ms = room.settings.timer * 1000;
    g.turnEndsAt = Date.now() + ms;
    room.turnTimer = setTimeout(() => recordAnswer(room, 'skip'), ms);
  } else {
    g.turnEndsAt = null;
  }
  pushState(room);
}

function advanceTurnPointer(room) {
  const g = room.game;
  g.turnIndex += 1;
  if (g.turnIndex % g.order.length === 0) {
    g.lap += 1;
    if (g.lap > g.totalLaps) finishRound(room, null, 'laps');
  }
}

function recordAnswer(room, a) {
  const g = room.game;
  if (room.phase !== 'playing') return;
  g.answers.push({ by: currentAskerId(g), a, t: Date.now() });
  advanceTurnPointer(room);
  if (room.phase === 'playing') armTurn(room);
}

function finishRound(room, winnerId, how) {
  clearTimer(room);
  clearGrace(room);
  const g = room.game;
  const awards = {};
  const give = (id, n) => {
    const p = room.players.get(id);
    if (!p) return;
    awards[id] = (awards[id] || 0) + n;
    p.score = (p.score || 0) + n;
  };
  if (winnerId) give(winnerId, 2);
  else give(g.guardianId, 1);
  g.turnEndsAt = null;
  g.result = { winnerId, how, awards, secretKey: g.secretKey, questions: g.answers.filter((x) => x.a !== 'skip').length };
  room.phase = 'results';
  pushState(room);
}

function backToLobby(room) {
  clearTimer(room);
  clearGrace(room);
  room.game = null;
  room.phase = 'lobby';
  for (const [id, p] of room.players) if (!p.connected) room.players.delete(id);
  ensureHost(room);
  pushState(room);
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (!host || !host.connected) {
    const next = connectedPlayers(room)[0];
    room.hostId = next ? next.id : null;
  }
}

// ---------- websocket handling ----------

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('handler error:', err);
      send(ws, { type: 'error', message: 'Algo correu mal no servidor.' });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.playerId);
    if (!player || player.ws !== ws) return;
    player.connected = false;
    player.ws = null;

    if (room.phase === 'lobby') room.players.delete(player.id);
    ensureHost(room);

    if (connectedPlayers(room).length === 0) {
      room.emptySince = Date.now();
    } else if (room.phase === 'playing') {
      const g = room.game;
      if (player.id === g.guardianId) {
        // the one person who can answer dropped: a reload or a wifi blip should
        // not kill the round, so wait a bit for them before giving up
        broadcast(room, { type: 'notice', message: `${player.name} (guardião) perdeu a ligação. À espera que volte…` });
        clearGrace(room);
        room.graceTimer = setTimeout(() => {
          room.graceTimer = null;
          const p = room.players.get(player.id);
          if (room.phase !== 'playing' || !room.game || room.game.guardianId !== player.id || (p && p.connected)) return;
          broadcast(room, { type: 'notice', message: `${player.name} (guardião) não voltou. A ronda terminou sem vencedor.` });
          finishRound(room, null, 'guardian_left');
        }, GUARDIAN_GRACE_MS);
      } else if (currentAskerId(g) === player.id) {
        armTurn(room);
      }
    }
    pushState(room);
  });
});

function joinError(ws, message) {
  send(ws, { type: 'join_error', message });
}

function handleMessage(ws, msg) {
  // --- pre-join messages ---
  if (msg.type === 'create' || msg.type === 'join') {
    const name = String(msg.name || '').trim().slice(0, 18);
    if (!name) return joinError(ws, 'Escreve primeiro o teu nome.');

    let room;
    if (msg.type === 'create') {
      room = makeRoom();
    } else {
      room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room) return joinError(ws, 'Não há nenhuma sala com esse código.');
      if (room.players.size >= MAX_PLAYERS) return joinError(ws, 'Essa sala está cheia.');
      if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return joinError(ws, 'Já há alguém na sala com esse nome.');
      }
    }

    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      name,
      color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
      ws,
      connected: true,
      score: 0
    };
    room.players.set(player.id, player);
    room.emptySince = null;
    if (!room.hostId) room.hostId = player.id;
    ws.roomCode = room.code;
    ws.playerId = player.id;
    // joining mid-round: you get a board right away and a turn at the end of the order
    if (room.phase === 'playing') room.game.order.push(player.id);
    send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token });
    pushState(room);
    return;
  }

  if (msg.type === 'rejoin') {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const player = room && room.players.get(msg.playerId);
    if (!room || !player || player.token !== msg.token) {
      return send(ws, { type: 'rejoin_failed' });
    }
    if (player.ws && player.ws !== ws) player.ws.close();
    player.ws = ws;
    player.connected = true;
    room.emptySince = null;
    ws.roomCode = room.code;
    ws.playerId = player.id;
    ensureHost(room);
    if (room.game && room.game.guardianId === player.id) {
      clearGrace(room);
      if (room.phase === 'playing') broadcast(room, { type: 'notice', message: `${player.name} (guardião) voltou.` }, player.id);
    }
    send(ws, { type: 'joined', code: room.code, playerId: player.id, token: player.token });
    pushState(room);
    return;
  }

  // --- in-room messages ---
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const player = room.players.get(ws.playerId);
  if (!player) return;
  const g = room.game;
  const isHost = player.id === room.hostId;

  switch (msg.type) {
    case 'settings': {
      if (!isHost || room.phase === 'playing') return;
      if (TIMER_OPTIONS.includes(msg.timer)) room.settings.timer = msg.timer;
      if (LAP_OPTIONS.includes(msg.laps)) room.settings.laps = msg.laps;
      pushState(room);
      break;
    }

    case 'start': {
      if (!isHost || room.phase === 'playing') return;
      if (connectedPlayers(room).length < MIN_PLAYERS) {
        return send(ws, { type: 'error', message: `São precisas pelo menos ${MIN_PLAYERS} pessoas.` });
      }
      startRound(room);
      break;
    }

    case 'answer': {
      // the guardian records the answer they just gave out loud
      if (room.phase !== 'playing' || player.id !== g.guardianId) return;
      if (!['sim', 'nao', 'skip'].includes(msg.a)) return;
      recordAnswer(room, msg.a);
      break;
    }

    case 'skip': {
      // host or guardian can move past an asker who is away from the keyboard
      if (room.phase !== 'playing' || !(isHost || player.id === g.guardianId)) return;
      recordAnswer(room, 'skip');
      break;
    }

    case 'flip': {
      if (room.phase !== 'playing' || player.id === g.guardianId) return;
      const keys = Array.isArray(msg.keys) ? msg.keys.filter((k) => PEOPLE.some((p) => p.key === k)).slice(0, PEOPLE.length) : [];
      g.down[player.id] = [...new Set(keys)];
      pushState(room);
      break;
    }

    case 'guess': {
      if (room.phase !== 'playing' || player.id === g.guardianId) return;
      if (g.eliminated.includes(player.id)) return;
      if (!PEOPLE.some((p) => p.key === msg.key)) return;
      const correct = msg.key === g.secretKey;
      g.guesses.push({ by: player.id, key: msg.key, correct, t: Date.now() });
      if (correct) return finishRound(room, player.id, 'guess');
      g.eliminated.push(player.id);
      const alive = g.order.filter((id) => {
        const p = room.players.get(id);
        return p && p.connected && !g.eliminated.includes(id);
      });
      if (!alive.length) return finishRound(room, null, 'all_out');
      if (currentAskerId(g) === player.id) armTurn(room);
      else pushState(room);
      break;
    }

    case 'next_round': {
      if (!isHost || room.phase !== 'results') return;
      if (connectedPlayers(room).length < MIN_PLAYERS) {
        return send(ws, { type: 'error', message: `São precisas pelo menos ${MIN_PLAYERS} pessoas.` });
      }
      startRound(room);
      break;
    }

    case 'end_game': {
      if (!isHost || room.phase === 'lobby') return;
      broadcast(room, { type: 'notice', message: `${player.name} terminou o jogo. De volta à sala.` }, player.id);
      backToLobby(room);
      break;
    }
  }
}

// heartbeat + empty-room cleanup
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Adivinha Quem running on http://localhost:${PORT}`);
});
