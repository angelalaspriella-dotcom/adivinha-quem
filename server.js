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
const ROUND_MINUTES = [0, 5, 8, 10]; // optional round timer; 0 = none

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
    roundTimer: null,
    graceTimer: null,
    emptySince: null,
    settings: { minutes: 0 }
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
      endsAt: g.endsAt || null,
      startedAt: g.startedAt,
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

function clearTimers(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
  if (room.graceTimer) {
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
  }
}

// ---------- game flow ----------

// The guardian rotates: whoever has guarded least recently goes next.
function pickGuardian(room) {
  const ids = connectedPlayers(room).map((p) => p.id);
  const never = ids.filter((id) => !room.guardianHistory.includes(id));
  if (never.length) return never[Math.floor(Math.random() * never.length)];
  for (const id of room.guardianHistory) if (ids.includes(id)) return id;
  return ids[0];
}

function startRound(room) {
  clearTimers(room);
  const guardianId = pickGuardian(room);
  room.guardianHistory = [...room.guardianHistory.filter((id) => id !== guardianId), guardianId];
  room.round += 1;
  const minutes = room.settings.minutes;
  room.game = {
    guardianId,
    secretKey: PEOPLE[Math.floor(Math.random() * PEOPLE.length)].key,
    startedAt: Date.now(),
    endsAt: minutes ? Date.now() + minutes * 60_000 : null,
    guesses: [],   // { by, key, correct, t }
    eliminated: [],
    down: {},      // playerId -> [person keys]
    result: null
  };
  if (minutes) room.roundTimer = setTimeout(() => finishRound(room, null, 'time'), minutes * 60_000);
  room.phase = 'playing';
  pushState(room);
}

function finishRound(room, winnerId, how) {
  clearTimers(room);
  const g = room.game;
  const awards = {};
  const give = (id, n) => {
    const p = room.players.get(id);
    if (!p) return;
    awards[id] = (awards[id] || 0) + n;
    p.score = (p.score || 0) + n;
  };
  if (winnerId) give(winnerId, 2);
  else if (how !== 'guardian_left') give(g.guardianId, 1);
  g.endsAt = null;
  g.result = { winnerId, how, awards, secretKey: g.secretKey, seconds: Math.round((Date.now() - g.startedAt) / 1000) };
  room.phase = 'results';
  pushState(room);
}

function backToLobby(room) {
  clearTimers(room);
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
    } else if (room.phase === 'playing' && player.id === room.game.guardianId) {
      // the one person who knows the secret dropped: a reload or a wifi blip
      // should not kill the round, so wait a bit for them before giving up
      broadcast(room, { type: 'notice', message: `${player.name} (guardião) perdeu a ligação. À espera que volte…` });
      if (room.graceTimer) clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => {
        room.graceTimer = null;
        const p = room.players.get(player.id);
        if (room.phase !== 'playing' || !room.game || room.game.guardianId !== player.id || (p && p.connected)) return;
        broadcast(room, { type: 'notice', message: `${player.name} (guardião) não voltou. A ronda terminou sem vencedor.` });
        finishRound(room, null, 'guardian_left');
      }, GUARDIAN_GRACE_MS);
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
    if (room.game && room.game.guardianId === player.id && room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
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
      if (ROUND_MINUTES.includes(msg.minutes)) room.settings.minutes = msg.minutes;
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
      const alive = connectedPlayers(room).filter((p) => p.id !== g.guardianId && !g.eliminated.includes(p.id));
      if (!alive.length) return finishRound(room, null, 'all_out');
      pushState(room);
      break;
    }

    case 'end_round': {
      // guardian or host closes the round when nobody will get it
      if (room.phase !== 'playing' || !(isHost || player.id === g.guardianId)) return;
      finishRound(room, null, 'called');
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
      clearTimers(room);
      rooms.delete(code);
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Adivinha Quem running on http://localhost:${PORT}`);
});
