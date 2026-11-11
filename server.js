// ============================================================================
// ENCLAVE ARCADE — COMPLETE LIVE SERVER (server.js)
// Includes Expanded Village of Salem (Godfather, Vigilante, Jester, Werewolf,
// Bomber, Plague Doctor -> Pestilence, Last Wills & Non-Cheating Salem AI)
// ============================================================================

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 8080;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';

let globalWordPool = [
  'anchor', 'compass', 'lantern', 'fortress', 'eclipse',
  'glacier', 'phantom', 'harbor', 'catapult', 'obsidian',
  'telescope', 'labyrinth', 'windmill', 'avalanche', 'treasure',
  'volcano', 'spaceship', 'pirate', 'waterfall', 'lightning'
];

async function syncDictionary(difficulty = 'ALL') {
  if (!GOOGLE_SCRIPT_URL.startsWith('http')) return;
  try {
    const res = await fetch(
      `${GOOGLE_SCRIPT_URL}?action=words&count=300&difficulty=${encodeURIComponent(difficulty)}`,
      { redirect: 'follow' }
    );
    const data = await res.json();
    if (data.ok && Array.isArray(data.words) && data.words.length > 0) {
      globalWordPool = data.words;
    }
  } catch (err) {
    console.error('[Google Sheet] Word sync skipped:', err.message);
  }
}

async function pushScoresToGoogleSheet(players) {
  if (!GOOGLE_SCRIPT_URL.startsWith('http') || players.length === 0) return;
  try {
    const humanPlayers = players.filter(p => !p.isAI);
    if (humanPlayers.length === 0) return;
    const topScore = Math.max(...players.map(p => p.score || 0));
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'recordScores',
        players: humanPlayers.map(p => ({
          username: p.username,
          scoreDelta: p.score || 0,
          won: (p.score || 0) === topScore && topScore > 0
        }))
      }),
      redirect: 'follow'
    });
  } catch (err) {
    console.error('[Google Sheet] Score save error:', err.message);
  }
}

// ============================================================================
// 1. HTTP SERVER
// ============================================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/api/auth') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const passwordHash = crypto
          .createHash('sha256')
          .update(String(payload.password || ''))
          .digest('hex');

        if (GOOGLE_SCRIPT_URL.startsWith('http')) {
          const sheetRes = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: payload.action,
              username: payload.username,
              passwordHash,
              color: payload.color
            }),
            redirect: 'follow'
          });
          const sheetData = await sheetRes.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(sheetData));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          user: { username: payload.username, color: payload.color || '#6366f1', wins: 0 }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Enclave Arcade Live Multiplayer Server Running');
});

// ============================================================================
// 2. BUILT-IN WEBSOCKET PROTOCOL
// ============================================================================
function sendWs(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  } catch (e) {
    // Ignore write errors on closing sockets
  }
}

function parseWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    if (opcode === 0x08) return { close: true, messages, remaining: Buffer.alloc(0) };

    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let len = buffer[offset + 1] & 0x7f;
    let hLen = 2;

    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      hLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      hLen = 10;
    }

    const dataStart = hLen + (masked ? 4 : 0);
    if (offset + dataStart + len > buffer.length) break;

    const data = Buffer.alloc(len);
    if (masked) {
      const mask = buffer.subarray(offset + hLen, offset + dataStart);
      for (let i = 0; i < len; i++) {
        data[i] = buffer[offset + dataStart + i] ^ mask[i % 4];
      }
    } else {
      buffer.copy(data, 0, offset + dataStart, offset + dataStart + len);
    }

    if (opcode === 0x01) messages.push(data.toString('utf8'));
    offset += dataStart + len;
  }

  return { close: false, messages, remaining: buffer.subarray(offset) };
}

// ============================================================================
// 3. PARALLEL COLONY AI PROFILES (Up to 10 Distinct Bots per Tier)
// ============================================================================
const AI_CATALOG = {
  easy: [
    { name: 'Colony_Leo', label: '12y MS', color: '#10b981' },
    { name: 'Colony_Maya', label: '13y MS', color: '#3b82f6' },
    { name: 'Colony_Toby', label: '11y MS', color: '#f59e0b' },
    { name: 'Colony_Zoe', label: '14y MS', color: '#ec4899' },
    { name: 'Colony_Finn', label: '12y MS', color: '#6366f1' },
    { name: 'Colony_Ruby', label: '13y MS', color: '#ef4444' },
    { name: 'Colony_Milo', label: '11y MS', color: '#14b8a6' },
    { name: 'Colony_Luna', label: '14y MS', color: '#a855f7' },
    { name: 'Colony_Owen', label: '12y MS', color: '#f97316' },
    { name: 'Colony_Ivy', label: '13y MS', color: '#84cc16' }
  ],
  medium: [
    { name: 'Colony_Zack', label: '16y HS', color: '#6366f1' },
    { name: 'Colony_Chloe', label: '17y HS', color: '#ec4899' },
    { name: 'Colony_Kai', label: '15y HS', color: '#10b981' },
    { name: 'Colony_Jade', label: '17y HS', color: '#f59e0b' },
    { name: 'Colony_Axel', label: '16y HS', color: '#ef4444' },
    { name: 'Colony_Nina', label: '15y HS', color: '#3b82f6' },
    { name: 'Colony_Cole', label: '17y HS', color: '#a855f7' },
    { name: 'Colony_Tara', label: '16y HS', color: '#14b8a6' },
    { name: 'Colony_zane', label: '15y HS', color: '#f97316' },
    { name: 'Colony_Skye', label: '17y HS', color: '#84cc16' }
  ],
  hard: [
    { name: 'Colony_Draven', label: '19y UNI', color: '#a855f7' },
    { name: 'Colony_Elena', label: '20y UNI', color: '#ef4444' },
    { name: 'Colony_Soren', label: '18y UNI', color: '#3b82f6' },
    { name: 'Colony_Lyra', label: '20y UNI', color: '#10b981' },
    { name: 'Colony_Vance', label: '19y UNI', color: '#f59e0b' },
    { name: 'Colony_Freya', label: '20y UNI', color: '#ec4899' },
    { name: 'Colony_Kael', label: '18y UNI', color: '#6366f1' },
    { name: 'Colony_Vera', label: '19y UNI', color: '#14b8a6' },
    { name: 'Colony_Orion', label: '20y UNI', color: '#f97316' },
    { name: 'Colony_Nyx', label: '19y UNI', color: '#84cc16' }
  ]
};

function rebuildRoomAI(room) {
  const count = Math.min(10, Math.max(0, Number(room.settings.aiCount) || 0));
  const tier = AI_CATALOG[room.settings.aiTier] ? room.settings.aiTier : 'medium';
  const templates = AI_CATALOG[tier];

  room.aiPlayers = [];
  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length];
    room.aiPlayers.push({
      username: t.name,
      color: t.color,
      score: 0,
      team: i % 2 === 0 ? 'B' : 'A',
      isAI: true,
      aiTier: tier,
      aiLabel: t.label
    });
  }
}

function getAllParticipants(room) {
  return [...Array.from(room.players.values()), ...room.aiPlayers];
}

// ============================================================================
// 4. ROOM ENGINE & HOST MANAGEMENT
// ============================================================================
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      hostUsername: '',
      mode: 'skribbl',
      players: new Map(),
      aiPlayers: [],
      settings: {
        drawTime: 75,
        rounds: 3,
        hangmanMaxGuesses: 10,
        difficulty: 'ALL',
        aiCount: 6,
        aiTier: 'medium',
        salemAiStyle: 'deductive'
      },
      round: 1,
      currentWord: '',
      drawerUsername: '',
      drawingTeam: 'A',
      hangmanLeft: 10,
      guessedUsers: new Set(),
      garticChain: [],
      timerInterval: null,
      aiInterval: null,
      snakeInterval: null,
      shadowInterval: null,
      salemChatTimeouts: [],
      snakes: new Map(),
      orbs: [],
      fighters: new Map(),
      effects: [],
      salem: null
    });
    rebuildRoomAI(rooms.get(roomId));
  }
  return rooms.get(roomId);
}

function stopAllRoomIntervals(room) {
  clearInterval(room.timerInterval);
  clearInterval(room.aiInterval);
  clearInterval(room.snakeInterval);
  clearInterval(room.shadowInterval);
  if (room.salemChatTimeouts) {
    room.salemChatTimeouts.forEach(t => clearTimeout(t));
    room.salemChatTimeouts = [];
  }
}

function broadcast(room, packet, exclude = null) {
  for (const [sock] of room.players.entries()) {
    if (sock !== exclude) sendWs(sock, packet);
  }
}

function ensureRoomHost(room) {
  const humans = Array.from(room.players.values());
  if (humans.length === 0) {
    room.hostUsername = '';
    return;
  }
  const stillHere = humans.some(p => p.username.toLowerCase() === room.hostUsername.toLowerCase());
  if (!stillHere) {
    room.hostUsername = humans[0].username;
  }
}

function syncRoster(room) {
  ensureRoomHost(room);
  const list = getAllParticipants(room).map(p => ({
    username: p.username,
    color: p.color,
    score: p.score || 0,
    team: p.team,
    isAI: Boolean(p.isAI),
    aiLabel: p.aiLabel || ''
  }));
  broadcast(room, { type: 'roster', players: list, hostUsername: room.hostUsername });
}

// ============================================================================
// 5. SKRIBBL & TEAM HANGMAN ENGINE
// ============================================================================
function startDrawingTurn(room) {
  stopAllRoomIntervals(room);

  const participants = getAllParticipants(room);
  if (participants.length === 0) return;

  room.currentWord = (globalWordPool[Math.floor(Math.random() * globalWordPool.length)] || 'compass').toLowerCase();
  room.guessedUsers.clear();
  room.hangmanLeft = room.settings.hangmanMaxGuesses;

  const drawer = participants[(room.round - 1) % participants.length];
  room.drawerUsername = drawer.username;
  room.drawingTeam = drawer.team;

  const masked = room.currentWord.split('').map(() => '_').join(' ');
  broadcast(room, { type: 'clearCanvas' });

  for (const [sock, p] of room.players.entries()) {
    const isDrawer = room.mode === 'hangman'
      ? p.team === room.drawingTeam
      : p.username === room.drawerUsername;

    sendWs(sock, {
      type: 'roundState',
      maskedWord: isDrawer ? room.currentWord.toUpperCase().split('').join(' ') : masked,
      round: room.round,
      maxRounds: room.settings.rounds,
      canDraw: isDrawer,
      roleText: isDrawer
        ? `DRAW THIS WORD: ${room.currentWord.toUpperCase()}`
        : `${room.drawerUsername} is drawing — Type your guess in chat!`,
      hangmanLeft: room.hangmanLeft,
      hangmanMax: room.settings.hangmanMaxGuesses
    });
  }

  if (drawer.isAI) {
    let step = 0;
    room.aiInterval = setInterval(() => {
      if (step > 40) return clearInterval(room.aiInterval);
      const a1 = (step / 20) * Math.PI * 2;
      const a2 = ((step + 1) / 20) * Math.PI * 2;
      const r = 75 + (step > 20 ? 30 * Math.sin(step) : 0);
      broadcast(room, {
        type: 'stroke',
        x0: Math.round(480 + Math.cos(a1) * r),
        y0: Math.round(270 + Math.sin(a1) * r),
        x1: Math.round(480 + Math.cos(a2) * r),
        y1: Math.round(270 + Math.sin(a2) * r),
        color: drawer.color || '#6366f1',
        size: 6
      });
      step++;
    }, 180);
  }

  let timeLeft = room.settings.drawTime;
  broadcast(room, { type: 'timer', timeLeft });

  room.timerInterval = setInterval(() => {
    timeLeft--;
    broadcast(room, { type: 'timer', timeLeft });
    runAiWordGuessing(room, timeLeft);

    if (timeLeft <= 0) {
      stopAllRoomIntervals(room);
      broadcast(room, {
        type: 'chat',
        username: 'Referee',
        text: `Time's up! The word was ${room.currentWord.toUpperCase()}.`,
        style: 'system'
      });
      advanceDrawingRound(room);
    }
  }, 1000);
}

function advanceDrawingRound(room) {
  if (room.round < room.settings.rounds) {
    room.round++;
    setTimeout(() => startDrawingTurn(room), 2200);
  } else {
    pushScoresToGoogleSheet(getAllParticipants(room));
  }
}

function runAiWordGuessing(room, timeLeft) {
  if (!room.currentWord || room.aiPlayers.length === 0) return;

  room.aiPlayers.forEach(ai => {
    if (ai.username === room.drawerUsername) return;
    if (room.mode === 'hangman' && ai.team === room.drawingTeam) return;
    if (room.guessedUsers.has(ai.username)) return;

    const hitChance = ai.aiTier === 'hard' ? 0.055 : (ai.aiTier === 'medium' ? 0.032 : 0.018);
    if (timeLeft < room.settings.drawTime - 6 && Math.random() < hitChance) {
      room.guessedUsers.add(ai.username);
      ai.score = (ai.score || 0) + 110;
      syncRoster(room);
      broadcast(room, {
        type: 'chat',
        username: `${ai.username} [${ai.aiLabel}]`,
        text: 'Guessed the secret word!',
        style: 'correct'
      });
    }
  });
}

// ============================================================================
// 6. LAG-PROOF 3200x3200 SNAKE.IO ENGINE
// ============================================================================
const SNAKE_WORLD_W = 3200;
const SNAKE_WORLD_H = 3200;
const MAX_TRAIL_NODES = 42;

function spawnSnake(room, p) {
  const sx = 300 + Math.floor(Math.random() * (SNAKE_WORLD_W - 600));
  const sy = 300 + Math.floor(Math.random() * (SNAKE_WORLD_H - 600));
  const angle = Math.random() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    pts.push([
      Math.round(sx - Math.cos(angle) * i * 12),
      Math.round(sy - Math.sin(angle) * i * 12)
    ]);
  }
  room.snakes.set(p.username, {
    username: p.username,
    color: p.color || '#6366f1',
    isAI: Boolean(p.isAI),
    aiTier: p.aiTier || 'medium',
    angle,
    boost: false,
    mass: 60,
    pts
  });
}

function startSnakeGame(room) {
  stopAllRoomIntervals(room);
  room.snakes.clear();

  const orbColors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa'];
  room.orbs = Array.from({ length: 85 }, () => ({
    x: 60 + Math.floor(Math.random() * (SNAKE_WORLD_W - 120)),
    y: 60 + Math.floor(Math.random() * (SNAKE_WORLD_H - 120)),
    r: 7,
    v: 12,
    loot: false,
    c: orbColors[Math.floor(Math.random() * orbColors.length)]
  }));

  getAllParticipants(room).forEach(p => spawnSnake(room, p));

  room.snakeInterval = setInterval(() => {
    const allSnakes = Array.from(room.snakes.values());

    allSnakes.forEach(s => {
      if (!s.isAI || s.pts.length === 0) return;
      const [hx, hy] = s.pts[0];

      if (hx < 180 || hx > SNAKE_WORLD_W - 180 || hy < 180 || hy > SNAKE_WORLD_H - 180) {
        const centerAngle = Math.atan2(SNAKE_WORLD_H / 2 - hy, SNAKE_WORLD_W / 2 - hx);
        const diff = Math.atan2(Math.sin(centerAngle - s.angle), Math.cos(centerAngle - s.angle));
        s.angle += diff * 0.25;
        return;
      }

      let bestOrb = null;
      let bestScore = Infinity;
      for (let i = 0; i < room.orbs.length; i++) {
        const o = room.orbs[i];
        const d = Math.hypot(o.x - hx, o.y - hy) / (o.loot ? 2.5 : 1);
        if (d < bestScore) {
          bestScore = d;
          bestOrb = o;
        }
      }

      let targetAngle = bestOrb ? Math.atan2(bestOrb.y - hy, bestOrb.x - hx) : s.angle;

      if (s.aiTier !== 'easy') {
        allSnakes.forEach(other => {
          if (other.username === s.username) return;
          for (let i = 0; i < other.pts.length; i += 2) {
            const [ox, oy] = other.pts[i];
            if (Math.hypot(ox - hx, oy - hy) < 60) {
              targetAngle = Math.atan2(hy - oy, hx - ox);
              break;
            }
          }
        });
      }

      const turnRate = s.aiTier === 'hard' ? 0.26 : (s.aiTier === 'medium' ? 0.18 : 0.12);
      const diff = Math.atan2(Math.sin(targetAngle - s.angle), Math.cos(targetAngle - s.angle));
      s.angle += diff * turnRate;
      s.boost = s.aiTier === 'hard' && bestScore < 120 && s.mass > 100;
    });

    allSnakes.forEach(s => {
      if (s.pts.length === 0) return;
      const isBoosting = s.boost && s.mass > 70;
      const speed = isBoosting ? 13 : 8.5;
      if (isBoosting && Math.random() < 0.25) s.mass = Math.max(60, s.mass - 1);

      const nx = Math.max(20, Math.min(SNAKE_WORLD_W - 20, Math.round(s.pts[0][0] + Math.cos(s.angle) * speed)));
      const ny = Math.max(20, Math.min(SNAKE_WORLD_H - 20, Math.round(s.pts[0][1] + Math.sin(s.angle) * speed)));
      s.pts.unshift([nx, ny]);

      for (let i = room.orbs.length - 1; i >= 0; i--) {
        const o = room.orbs[i];
        if (Math.abs(o.x - nx) < 22 && Math.abs(o.y - ny) < 22) {
          s.mass += o.v || 12;
          const p = getAllParticipants(room).find(u => u.username === s.username);
          if (p) p.score = s.mass;

          if (o.loot) {
            room.orbs.splice(i, 1);
          } else {
            o.x = 60 + Math.floor(Math.random() * (SNAKE_WORLD_W - 120));
            o.y = 60 + Math.floor(Math.random() * (SNAKE_WORLD_H - 120));
          }
          break;
        }
      }

      const desiredNodes = Math.min(MAX_TRAIL_NODES, 8 + Math.floor((s.mass - 60) / 25));
      while (s.pts.length > desiredNodes) {
        s.pts.pop();
      }
    });

    const eliminated = [];
    allSnakes.forEach(sA => {
      if (sA.pts.length === 0) return;
      const [hx, hy] = sA.pts[0];

      if (hx <= 22 || hx >= SNAKE_WORLD_W - 22 || hy <= 22 || hy >= SNAKE_WORLD_H - 22) {
        eliminated.push({ victim: sA, killer: { username: 'Arena Laser Wall' } });
        return;
      }

      allSnakes.forEach(sB => {
        if (sA.username === sB.username) return;
        for (let i = 0; i < sB.pts.length; i++) {
          const [bx, by] = sB.pts[i];
          if (Math.abs(hx - bx) < 15 && Math.abs(hy - by) < 15) {
            eliminated.push({ victim: sA, killer: sB });
            break;
          }
        }
      });
    });

    if (eliminated.length > 0) {
      eliminated.forEach(({ victim, killer }) => {
        const dropValue = Math.max(15, Math.floor((victim.mass * 0.65) / Math.max(4, Math.floor(victim.pts.length / 2))));
        victim.pts.forEach(([px, py], idx) => {
          if (idx % 2 === 0 && room.orbs.length < 150) {
            room.orbs.push({
              x: px + Math.floor(Math.random() * 14 - 7),
              y: py + Math.floor(Math.random() * 14 - 7),
              r: 10,
              v: dropValue,
              loot: true,
              c: victim.color
            });
          }
        });

        const vp = getAllParticipants(room).find(u => u.username === victim.username);
        if (vp) {
          vp.score = 60;
          spawnSnake(room, vp);
        }

        broadcast(room, {
          type: 'chat',
          username: 'Snake Arena',
          text: `🐍 ${victim.username} crashed into ${killer.username} and dropped ${Math.floor(victim.mass * 0.65)} mass!`,
          style: 'system'
        });
      });
      syncRoster(room);
    }

    broadcast(room, {
      type: 'snakeTick',
      worldW: SNAKE_WORLD_W,
      worldH: SNAKE_WORLD_H,
      snakes: allSnakes.map(s => ({
        username: s.username,
        color: s.color,
        angle: Number(s.angle.toFixed(2)),
        mass: s.mass,
        body: s.pts
      })),
      orbs: room.orbs
    });
  }, 65);
}

// ============================================================================
// 7. EXPANDED VILLAGE OF SALEM ENGINE (10 Roles, Last Wills & Deduction AI)
// ============================================================================
const FAKE_CLAIM_ROLES = ['Sheriff', 'Doctor', 'Vigilante', 'Villager'];

function buildSalemRoleDeck(totalCount) {
  // Core balanced deck that scales with lobby size
  const deck = ['Godfather', 'Sheriff', 'Doctor', 'Vigilante', 'Jester'];
  const specials = ['Werewolf', 'Bomber', 'PlagueDoctor', 'Killer'];

  for (const sp of specials) {
    if (deck.length < totalCount) deck.push(sp);
  }
  while (deck.length < totalCount) {
    deck.push('Villager');
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, totalCount);
}

function isEvilRole(role) {
  return ['Godfather', 'Killer', 'Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(role);
}

function startSalemGame(room) {
  stopAllRoomIntervals(room);

  // Ensure at least 7 town members so special roles have room to interact
  if (getAllParticipants(room).length < 7) {
    room.settings.aiCount = Math.max(room.settings.aiCount, 7 - room.players.size);
    rebuildRoomAI(room);
    syncRoster(room);
  }

  const all = getAllParticipants(room);
  const deck = buildSalemRoleDeck(all.length);

  const townMap = new Map();
  all.forEach((p, idx) => {
    const role = deck[idx];
    const fakeClaim = isEvilRole(role) || role === 'Jester'
      ? FAKE_CLAIM_ROLES[Math.floor(Math.random() * FAKE_CLAIM_ROLES.length)]
      : role;

    townMap.set(p.username, {
      username: p.username,
      color: p.color || '#6366f1',
      isAI: Boolean(p.isAI),
      aiTier: p.aiTier || 'medium',
      role,
      fakeClaim,
      alive: true,
      revealedRole: '',
      bullets: role === 'Vigilante' ? 2 : 0,
      basicDefense: role === 'Godfather' ? 1 : 0,
      infected: role === 'PlagueDoctor',
      willText: `${p.username} the ${fakeClaim} — Night Logs:`,
      aiLogs: [],
      susMap: new Map() // Public-only suspicion tracker for non-cheating AI
    });
  });

  room.salem = {
    day: 1,
    phase: 'night',
    town: townMap,
    nightActions: new Map(),
    votes: new Map(),
    bombs: new Set(),
    jesterHauntQueue: [], // [{ jesterName, voters: [] }]
    pestilenceUnleashed: false,
    report: 'Night 1 has fallen. Special roles: lock in your targets and update your Last Will!'
  };

  broadcast(room, {
    type: 'chat',
    username: 'Salem Crier',
    text: '🕯️ Village of Salem has begun! Update your Last Will and watch for suspicious claims.',
    style: 'system'
  });

  runSalemPhaseLoop(room);
}

function announceFallenPlayer(room, victim, causeText) {
  victim.alive = false;
  victim.revealedRole = victim.role;
  broadcast(room, {
    type: 'chat',
    username: 'Salem Morgue',
    text: `💀 ${victim.username} died (${causeText}). Their role was ${victim.role}.`,
    style: 'system'
  });
  const will = (victim.willText || '').trim();
  if (will) {
    broadcast(room, {
      type: 'chat',
      username: `📜 ${victim.username}'s Last Will`,
      text: will,
      style: 'will-reveal'
    });
  }
}

function sendSalemStateToAll(room) {
  if (!room.salem) return;
  const s = room.salem;
  const fullMoon = s.day % 2 === 0;

  const voteCounts = {};
  for (const target of s.votes.values()) {
    if (target !== 'SKIP') voteCounts[target] = (voteCounts[target] || 0) + 1;
  }

  for (const [sock, p] of room.players.entries()) {
    const me = s.town.get(p.username) || { role: 'Villager', alive: false, bullets: 0 };
    let canAct = false;
    let actionLabel = 'Select';
    let instruction = 'Wait for the current phase to conclude.';
    let extraStatus = '';

    if (me.role === 'Vigilante') extraStatus = `${me.bullets} Bullets`;
    if (me.role === 'Bomber') extraStatus = `${s.bombs.size} Planted`;

    if (me.alive) {
      if (s.phase === 'night') {
        switch (me.role) {
          case 'Godfather':
          case 'Killer':
            canAct = true;
            actionLabel = 'Assassinate';
            instruction = 'Choose a town member for the Mafia to eliminate tonight.';
            break;
          case 'Doctor':
            canAct = true;
            actionLabel = 'Heal';
            instruction = 'Choose a player (or yourself) to heal tonight.';
            break;
          case 'Sheriff':
            canAct = true;
            actionLabel = 'Interrogate';
            instruction = 'Inspect a suspect tonight (Note: Godfathers & Jesters can fool Sheriffs!).';
            break;
          case 'Vigilante':
            canAct = me.bullets > 0;
            actionLabel = 'Shoot';
            instruction = me.bullets > 0
              ? `You have ${me.bullets} bullet(s). Shoot only if you are confident someone is Evil!`
              : 'You are out of bullets.';
            break;
          case 'Werewolf':
            canAct = fullMoon;
            actionLabel = 'Maul Rampage';
            instruction = fullMoon
              ? '🌕 Full Moon! Choose a house to rampage (kills target + anyone visiting them).'
              : 'No Full Moon tonight. You rest quietly until an even-numbered night.';
            break;
          case 'Bomber':
            canAct = true;
            actionLabel = 'Plant Bomb';
            instruction = 'Plant a hidden bomb on a player, or click Detonate All Bombs above!';
            break;
          case 'PlagueDoctor':
            canAct = true;
            actionLabel = 'Infect';
            instruction = 'Spread the plague! When all living players are infected, you become Pestilence.';
            break;
          case 'Pestilence':
            canAct = true;
            actionLabel = 'Obliterate';
            instruction = '☣️ You are Pestilence (Invincible at night)! Choose a house to obliterate.';
            break;
          case 'Jester':
            instruction = 'You are the Jester! Plan a sketchy fake claim for tomorrow so the Town exiles you.';
            break;
          default:
            instruction = 'You are a Villager. Update your Last Will with suspects from today!';
        }
      } else if (s.phase === 'discussion') {
        instruction = 'Share leads, ask for Roles/Wills, and watch who throws suspicion in chat!';
      } else if (s.phase === 'voting') {
        canAct = true;
        actionLabel = 'Vote Exile';
        instruction = 'Vote to exile a suspect (Beware of giving the Jester a free win!).';
      }
    } else {
      instruction = 'You have fallen. Watch the remaining Town and AI bots battle it out!';
    }

    const townView = Array.from(s.town.values()).map(t => ({
      username: t.username,
      color: t.color,
      alive: t.alive,
      revealedRole: t.revealedRole,
      hasBomb: me.role === 'Bomber' && s.bombs.has(t.username),
      isInfected: (me.role === 'PlagueDoctor' || me.role === 'Pestilence') && t.infected
    }));

    sendWs(sock, {
      type: 'salemState',
      day: s.day,
      phase: s.phase,
      fullMoon,
      myRole: me.role,
      extraStatus,
      plantedCount: s.bombs.size,
      amAlive: me.alive,
      canAct,
      actionLabel,
      instruction,
      report: s.report,
      town: townView,
      votes: s.phase === 'voting' ? voteCounts : {}
    });
  }
}

function runSalemPhaseLoop(room) {
  stopAllRoomIntervals(room);
  const s = room.salem;
  if (!s) return;

  sendSalemStateToAll(room);
  scheduleNonCheatingSalemAI(room);

  let timeLeft = s.phase === 'night' ? 20 : (s.phase === 'discussion' ? 24 : 20);
  broadcast(room, { type: 'timer', timeLeft });

  room.timerInterval = setInterval(() => {
    timeLeft--;
    broadcast(room, { type: 'timer', timeLeft });

    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      advanceSalemPhase(room);
    }
  }, 1000);
}

// ============================================================================
// NON-CHEATING SALEM SOCIAL DEDUCTION AI (Suspicions, Bluffing & Wills)
// ============================================================================
function pickAiTargetWithoutCheating(ai, aliveOthers) {
  if (aliveOthers.length === 0) return null;
  // Sort by AI's personal public suspicion score, with randomness so AI never auto-locks
  const weighted = aliveOthers.map(t => ({
    player: t,
    weight: 1 + (ai.susMap.get(t.username) || 0) + Math.random() * 2.5
  }));
  weighted.sort((a, b) => b.weight - a.weight);
  return weighted[0].player;
}

function scheduleNonCheatingSalemAI(room) {
  const s = room.salem;
  if (!s) return;
  const fullMoon = s.day % 2 === 0;
  const style = room.settings.salemAiStyle || 'deductive';
  const aliveList = Array.from(s.town.values()).filter(t => t.alive);

  aliveList.filter(t => t.isAI).forEach(ai => {
    const aliveOthers = aliveList.filter(t => t.username !== ai.username);
    if (aliveOthers.length === 0) return;

    if (s.phase === 'night') {
      // AI Night Actions (Uses zero knowledge of hidden Town roles, except Mafia knowing Mafia)
      if (ai.role === 'Godfather' || ai.role === 'Killer') {
        const nonMafia = aliveOthers.filter(t => t.role !== 'Godfather' && t.role !== 'Killer');
        const pick = nonMafia[Math.floor(Math.random() * nonMafia.length)];
        if (pick) s.nightActions.set(ai.username, pick.username);
        // Write a fake Last Will to fool the town if killed
        const randomPeer = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        ai.willText = `${ai.username} the ${ai.fakeClaim} | N${s.day}: Checked/Protected ${randomPeer.username}`;
      } else if (ai.role === 'Doctor') {
        const pick = Math.random() < 0.25 ? ai : aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        s.nightActions.set(ai.username, pick.username);
        ai.aiLogs.push(`N${s.day}: Healed ${pick.username}`);
        ai.willText = `${ai.username} the Doctor | ${ai.aiLogs.join(', ')}`;
      } else if (ai.role === 'Sheriff') {
        const pick = pickAiTargetWithoutCheating(ai, aliveOthers);
        if (pick) s.nightActions.set(ai.username, pick.username);
      } else if (ai.role === 'Vigilante' && ai.bullets > 0) {
        // Vigilante AI only shoots if someone has high public suspicion (never shoots Night 1)
        const topSus = pickAiTargetWithoutCheating(ai, aliveOthers);
        if (s.day > 1 && topSus && (ai.susMap.get(topSus.username) || 0) >= 2 && Math.random() < 0.6) {
          s.nightActions.set(ai.username, topSus.username);
          ai.aiLogs.push(`N${s.day}: Shooting ${topSus.username}`);
          ai.willText = `${ai.username} the Vigilante | ${ai.aiLogs.join(', ')}`;
        }
      } else if (ai.role === 'Werewolf' && fullMoon) {
        const pick = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        if (pick) s.nightActions.set(ai.username, pick.username);
      } else if (ai.role === 'Bomber') {
        if (s.bombs.size >= 2 && Math.random() < 0.65) {
          s.nightActions.set(ai.username, 'DETONATE');
        } else {
          const unbombed = aliveOthers.filter(t => !s.bombs.has(t.username));
          const pick = unbombed[Math.floor(Math.random() * unbombed.length)] || aliveOthers[0];
          if (pick) s.nightActions.set(ai.username, pick.username);
        }
      } else if (ai.role === 'PlagueDoctor' || ai.role === 'Pestilence') {
        const uninfected = aliveOthers.filter(t => !t.infected);
        const pick = uninfected[Math.floor(Math.random() * uninfected.length)] || aliveOthers[0];
        if (pick) s.nightActions.set(ai.username, pick.username);
      } else if (ai.role === 'Jester') {
        const randomPeer = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        ai.willText = `${ai.username} the "Sheriff" | N${s.day}: ${randomPeer.username} is 100% SUS (jk?)`;
      }
    } else if (s.phase === 'discussion') {
      // Organic Day Discussion Chatter — Only a subset of bots speak each day to keep chat natural
      const speakChance = style === 'chaotic' ? 0.75 : (style === 'deductive' ? 0.6 : 0.45);
      if (Math.random() > speakChance) return;

      const delay = 2200 + Math.floor(Math.random() * 14000);
      const timerId = setTimeout(() => {
        if (!room.salem || room.salem.phase !== 'discussion' || !ai.alive) return;
        const currentOthers = Array.from(s.town.values()).filter(t => t.alive && t.username !== ai.username);
        if (currentOthers.length === 0) return;
        const randomPeer = pickAiTargetWithoutCheating(ai, currentOthers);

        let line = '';
        if (ai.role === 'Sheriff' && ai.aiLogs.length > 0) {
          const latestLog = ai.aiLogs[ai.aiLogs.length - 1];
          line = `Sheriff here! My latest log: ${latestLog}. What do we think?`;
        } else if (ai.role === 'Jester') {
          const jesterLines = [
            `Wait why is everyone looking at me?? I'm totally ${ai.fakeClaim}, trust me bro.`,
            `I think ${randomPeer.username} is evil, source: it came to me in a dream.`,
            `Don't vote me! If I die the town loses its best "Doctor" 👀`
          ];
          line = jesterLines[Math.floor(Math.random() * jesterLines.length)];
          // Saying sketchy things makes other AI slightly more suspicious of the Jester
          aliveList.forEach(other => {
            if (other.isAI && other.username !== ai.username) {
              other.susMap.set(ai.username, (other.susMap.get(ai.username) || 0) + 1.2);
            }
          });
        } else if (isEvilRole(ai.role)) {
          const bluffLines = [
            `I claim ${ai.fakeClaim}. Honestly ${randomPeer.username} has been way too quiet today, kinda sus.`,
            `Do we have any Sheriff or Doctor leads? Let's get role claims before we waste a trial.`,
            `Idk about you guys, but ${randomPeer.username}'s voting pattern feels super sketchy to me.`
          ];
          line = bluffLines[Math.floor(Math.random() * bluffLines.length)];
          // Evil deflection adds slight public suspicion to randomPeer
          aliveList.forEach(other => {
            if (other.isAI) other.susMap.set(randomPeer.username, (other.susMap.get(randomPeer.username) || 0) + 0.7);
          });
        } else {
          const townLines = style === 'chaotic'
            ? [
                `${randomPeer.username} is acting mad sus right now, what's your role??`,
                `Watch out for Bomber and Plague Doctor, don't let them stall the trial!`,
                `Hold up, who hasn't claimed a role yet? Looking at you ${randomPeer.username}.`
              ]
            : [
                `${randomPeer.username}, any leads or Last Will to share with the Town?`,
                `Remember Godfather shows up Innocent to Sheriff, and careful not to give Jester a free win.`,
                `Let's compare wills—I'm leaning slightly sus on ${randomPeer.username} unless they claim.`
              ];
          line = townLines[Math.floor(Math.random() * townLines.length)];
        }

        if (line) {
          broadcast(room, { type: 'chat', username: ai.username, text: line, style: '' });
        }
      }, delay);

      room.salemChatTimeouts.push(timerId);
    } else if (s.phase === 'voting') {
      // AI Voting — Imperfect, splits votes or skips if uncertain so AI never auto-wins
      const delay = 2500 + Math.floor(Math.random() * 11000);
      const timerId = setTimeout(() => {
        if (!room.salem || room.salem.phase !== 'voting' || !ai.alive) return;
        const currentOthers = Array.from(s.town.values()).filter(t => t.alive && t.username !== ai.username);
        if (currentOthers.length === 0) return;

        // 25% chance an AI skips/abstains if no strong evidence exists
        if (Math.random() < 0.25) {
          s.votes.set(ai.username, 'SKIP');
          sendSalemStateToAll(room);
          return;
        }

        let pool = currentOthers;
        if (ai.role === 'Godfather' || ai.role === 'Killer') {
          const nonMafia = currentOthers.filter(t => t.role !== 'Godfather' && t.role !== 'Killer');
          if (nonMafia.length > 0) pool = nonMafia;
        }

        const target = pickAiTargetWithoutCheating(ai, pool);
        if (target) {
          s.votes.set(ai.username, target.username);
          sendSalemStateToAll(room);
        }
      }, delay);

      room.salemChatTimeouts.push(timerId);
    }
  });
}

function advanceSalemPhase(room) {
  const s = room.salem;
  if (!s) return;

  if (s.phase === 'night') {
    const fullMoon = s.day % 2 === 0;
    const healedSet = new Set();
    const visitorsTo = new Map(); // targetName -> [visitorNames]
    const nightKills = []; // { victimName, cause, unstoppable }

    const recordVisit = (visitor, target) => {
      if (!target || target === 'DETONATE' || visitor === target) return;
      if (!visitorsTo.has(target)) visitorsTo.set(target, []);
      visitorsTo.get(target).push(visitor);
    };

    // 1. Resolve Jester Haunts from yesterday's exile
    while (s.jesterHauntQueue.length > 0) {
      const haunt = s.jesterHauntQueue.shift();
      const validVoters = haunt.voters.map(u => s.town.get(u)).filter(t => t && t.alive);
      if (validVoters.length > 0) {
        const haunted = validVoters[Math.floor(Math.random() * validVoters.length)];
        nightKills.push({
          victimName: haunted.username,
          cause: `Haunted by Jester ${haunt.jesterName}`,
          unstoppable: true
        });
      }
    }

    // 2. Process Night Actions
    for (const [actorName, targetName] of s.nightActions.entries()) {
      const actor = s.town.get(actorName);
      if (!actor || !actor.alive) continue;
      recordVisit(actorName, targetName);

      if (actor.role === 'Doctor') {
        healedSet.add(targetName);
      } else if (actor.role === 'Sheriff') {
        const inspected = s.town.get(targetName);
        if (inspected) {
          // Godfather appears Innocent; Jester has a 50% chance to look Suspicious!
          const looksSus =
            ['Killer', 'Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(inspected.role) ||
            (inspected.role === 'Jester' && Math.random() < 0.6);

          if (actor.isAI) {
            actor.aiLogs.push(`N${s.day}: ${inspected.username} (${looksSus ? 'SUS!' : 'Inno'})`);
            actor.willText = `${actor.username} the Sheriff | ${actor.aiLogs.join(', ')}`;
            if (looksSus) actor.susMap.set(inspected.username, (actor.susMap.get(inspected.username) || 0) + 4);
          }
        }
      } else if (actor.role === 'Godfather' || actor.role === 'Killer') {
        nightKills.push({ victimName: targetName, cause: 'Mafia Ambush', unstoppable: false });
      } else if (actor.role === 'Vigilante' && actor.bullets > 0) {
        actor.bullets--;
        const shotTarget = s.town.get(targetName);
        if (shotTarget) {
          nightKills.push({ victimName: targetName, cause: 'Vigilante Shot', unstoppable: false });
          if (!isEvilRole(shotTarget.role) && shotTarget.role !== 'Jester') {
            actor.bullets = 0; // Lose remaining bullets over guilt of shooting a Townie
          }
        }
      } else if (actor.role === 'Werewolf' && fullMoon) {
        nightKills.push({ victimName: targetName, cause: 'Werewolf Full-Moon Maul', unstoppable: false });
        const othersAtHouse = visitorsTo.get(targetName) || [];
        othersAtHouse.forEach(vName => {
          if (vName !== actorName) {
            nightKills.push({ victimName: vName, cause: 'Mauled visiting a Werewolf target', unstoppable: false });
          }
        });
      } else if (actor.role === 'Bomber') {
        if (targetName === 'DETONATE') {
          s.bombs.forEach(bombedUser => {
            nightKills.push({ victimName: bombedUser, cause: 'Detonated by the Bomber', unstoppable: true });
          });
          s.bombs.clear();
        } else {
          s.bombs.add(targetName);
        }
      } else if (actor.role === 'PlagueDoctor') {
        const t = s.town.get(targetName);
        if (t) t.infected = true;
      } else if (actor.role === 'Pestilence') {
        nightKills.push({ victimName: targetName, cause: 'Obliterated by Pestilence', unstoppable: true });
      }
    }

    // 3. Plague Contagion Spread via Visits
    for (const [houseOwner, visitors] of visitorsTo.entries()) {
      const ownerObj = s.town.get(houseOwner);
      if (!ownerObj) continue;
      visitors.forEach(vName => {
        const vObj = s.town.get(vName);
        if (!vObj) return;
        if (ownerObj.infected || vObj.infected) {
          ownerObj.infected = true;
          vObj.infected = true;
        }
      });
    }

    s.nightActions.clear();

    // 4. Resolve Deaths vs Heals & Defense
    const casualties = [];
    nightKills.forEach(k => {
      const victim = s.town.get(k.victimName);
      if (!victim || !victim.alive) return;

      // Pestilence is invincible at night
      if (victim.role === 'Pestilence') return;

      if (!k.unstoppable) {
        if (healedSet.has(victim.username)) return;
        if (victim.basicDefense > 0) {
          victim.basicDefense--;
          return;
        }
      }

      announceFallenPlayer(room, victim, k.cause);
      casualties.push(`${victim.username} (${victim.role})`);
    });

    // 5. Check if Plague Doctor transforms into Pestilence
    const aliveNow = Array.from(s.town.values()).filter(t => t.alive);
    const pd = aliveNow.find(t => t.role === 'PlagueDoctor');
    if (pd && aliveNow.every(t => t.infected)) {
      pd.role = 'Pestilence';
      s.pestilenceUnleashed = true;
      broadcast(room, {
        type: 'chat',
        username: 'Apocalypse Herald',
        text: '☣️ A horseman approaches! Every living soul is infected — The Plague Doctor has become PESTILENCE!',
        style: 'correct'
      });
    }

    s.report = casualties.length > 0
      ? `Dawn of Day ${s.day}: Casualties overnight — ${casualties.join(', ')}.`
      : `Dawn of Day ${s.day}: No one died last night! Discuss clues in chat.`;

    if (checkSalemWinCondition(room)) return;
    s.phase = 'discussion';
    runSalemPhaseLoop(room);
  } else if (s.phase === 'discussion') {
    s.phase = 'voting';
    s.votes.clear();
    s.report = `Town Trial is open! Vote for a suspect or Skip Vote.`;
    runSalemPhaseLoop(room);
  } else if (s.phase === 'voting') {
    const tally = {};
    const votersByCandidate = {};

    for (const [voter, target] of s.votes.entries()) {
      if (target !== 'SKIP') {
        tally[target] = (tally[target] || 0) + 1;
        if (!votersByCandidate[target]) votersByCandidate[target] = [];
        votersByCandidate[target].push(voter);
      }
    }

    let topCandidate = null;
    let topVotes = 0;
    for (const [candidate, count] of Object.entries(tally)) {
      if (count > topVotes) {
        topVotes = count;
        topCandidate = candidate;
      }
    }

    if (topCandidate && topVotes >= 2) {
      const exiled = s.town.get(topCandidate);
      if (exiled && exiled.alive) {
        announceFallenPlayer(room, exiled, `Exiled by Town Trial (${topVotes} votes)`);
        s.report = `The Town exiled ${exiled.username} (${exiled.role})!`;

        // JESTER VICTORY & REVENGE HAUNT
        if (exiled.role === 'Jester') {
          s.jesterHauntQueue.push({
            jesterName: exiled.username,
            voters: votersByCandidate[topCandidate] || []
          });
          const jp = getAllParticipants(room).find(u => u.username === exiled.username);
          if (jp) jp.score = (jp.score || 0) + 250;
          syncRoster(room);

          broadcast(room, {
            type: 'chat',
            username: 'Jester Revenge',
            text: `🃏 ${exiled.username} was the JESTER! They win +250 pts and will haunt one of their guilty voters tonight!`,
            style: 'correct'
          });
        }
      }
    } else {
      s.report = `No suspect received enough votes for exile. Night falls upon Salem...`;
    }

    s.votes.clear();
    if (checkSalemWinCondition(room)) return;
    s.day++;
    s.phase = 'night';
    runSalemPhaseLoop(room);
  }
}

function checkSalemWinCondition(room) {
  const s = room.salem;
  if (!s) return true;

  const alive = Array.from(s.town.values()).filter(t => t.alive);
  const aliveMafia = alive.filter(t => t.role === 'Godfather' || t.role === 'Killer').length;
  const aliveNeutEvil = alive.filter(t =>
    ['Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(t.role)
  ).length;
  const aliveTown = alive.filter(t =>
    ['Villager', 'Doctor', 'Sheriff', 'Vigilante'].includes(t.role)
  ).length;

  if (aliveMafia === 0 && aliveNeutEvil === 0) {
    stopAllRoomIntervals(room);
    s.report = `🏆 TOWN VICTORY! All Mafia, Monsters, and Apocalypse threats have been vanquished!`;
    getAllParticipants(room).forEach(p => {
      const t = s.town.get(p.username);
      if (t && ['Villager', 'Doctor', 'Sheriff', 'Vigilante'].includes(t.role)) {
        p.score = (p.score || 0) + 160;
      }
    });
    syncRoster(room);
    sendSalemStateToAll(room);
    broadcast(room, { type: 'chat', username: 'Salem Crier', text: s.report, style: 'correct' });
    return true;
  }

  if (aliveTown === 0 && (aliveMafia > 0 || aliveNeutEvil > 0)) {
    stopAllRoomIntervals(room);
    const winnerLabel = aliveNeutEvil > aliveMafia ? 'DARK APOCALYPSE / NEUTRAL EVIL' : 'MAFIA SYNDICATE';
    s.report = `🩸 ${winnerLabel} VICTORY! The Town of Salem has fallen!`;
    getAllParticipants(room).forEach(p => {
      const t = s.town.get(p.username);
      if (t && t.alive && isEvilRole(t.role)) {
        p.score = (p.score || 0) + 220;
      }
    });
    syncRoster(room);
    sendSalemStateToAll(room);
    broadcast(room, { type: 'chat', username: 'Salem Crier', text: s.report, style: 'correct' });
    return true;
  }

  return false;
}

// ============================================================================
// 8. STICKMAN SHADOW FIGHT ENGINE
// ============================================================================
function spawnFighter(room, p, idx = 0) {
  room.fighters.set(p.username, {
    username: p.username,
    color: p.color || '#ef4444',
    isAI: Boolean(p.isAI),
    aiTier: p.aiTier || 'medium',
    x: 180 + (idx * 220) % 600,
    y: 440,
    vy: 0,
    moveX: 0,
    facing: idx % 2 === 0 ? 1 : -1,
    hp: 100,
    state: 'idle',
    cooldown: 0
  });
}

function startShadowFight(room) {
  stopAllRoomIntervals(room);
  room.fighters.clear();
  room.effects = [];

  getAllParticipants(room).forEach((p, idx) => spawnFighter(room, p, idx));

  room.shadowInterval = setInterval(() => {
    const fighters = Array.from(room.fighters.values());
    room.effects = room.effects.filter(ef => Date.now() - ef.born < 180);

    fighters.forEach(f => {
      if (f.cooldown > 0) f.cooldown--;
      if (f.cooldown === 0 && ['punch', 'kick', 'slash'].includes(f.state)) {
        f.state = f.moveX !== 0 ? 'walk' : 'idle';
      }

      if (f.isAI && fighters.length > 1) {
        let target = null;
        let minDist = Infinity;
        fighters.forEach(other => {
          if (other.username === f.username) return;
          const d = Math.abs(other.x - f.x);
          if (d < minDist) {
            minDist = d;
            target = other;
          }
        });

        if (target) {
          f.facing = target.x >= f.x ? 1 : -1;
          const aggro = f.aiTier === 'hard' ? 0.22 : (f.aiTier === 'medium' ? 0.13 : 0.07);

          if (minDist > 72) {
            f.moveX = f.facing;
            f.state = 'walk';
          } else {
            f.moveX = 0;
            if (f.cooldown === 0 && Math.random() < aggro) {
              const moves = ['punch', 'kick', 'slash', 'block'];
              triggerFighterAction(room, f, moves[Math.floor(Math.random() * moves.length)]);
            }
          }
        }
      }

      if (f.state !== 'block') {
        f.x = Math.max(60, Math.min(900, f.x + f.moveX * 7.5));
        if (f.moveX !== 0) f.facing = Math.sign(f.moveX);
      }

      f.y += f.vy;
      if (f.y < 440) {
        f.vy += 1.8;
      } else {
        f.y = 440;
        f.vy = 0;
      }
    });

    broadcast(room, {
      type: 'shadowTick',
      fighters,
      effects: room.effects
    });
  }, 55);
}

function triggerFighterAction(room, attacker, action) {
  if (attacker.cooldown > 0) return;

  if (action === 'block') {
    attacker.state = 'block';
    attacker.cooldown = 10;
    return;
  }

  attacker.state = action;
  const stats = {
    punch: { range: 64, dmg: 10, cd: 6, knock: 14 },
    kick: { range: 76, dmg: 15, cd: 9, knock: 24 },
    slash: { range: 96, dmg: 22, cd: 13, knock: 32 }
  }[action] || { range: 64, dmg: 10, cd: 6, knock: 14 };

  attacker.cooldown = stats.cd;

  for (const target of room.fighters.values()) {
    if (target.username === attacker.username) continue;
    const dx = target.x - attacker.x;
    const inFront = Math.sign(dx) === attacker.facing || Math.abs(dx) < 20;

    if (inFront && Math.abs(dx) <= stats.range && Math.abs(target.y - attacker.y) < 55) {
      const blocked = target.state === 'block';
      const finalDmg = blocked ? Math.ceil(stats.dmg * 0.2) : stats.dmg;
      target.hp -= finalDmg;
      target.x = Math.max(60, Math.min(900, target.x + attacker.facing * (blocked ? 6 : stats.knock)));

      room.effects.push({
        x: (attacker.x + target.x) / 2,
        y: target.y - 62,
        color: blocked ? '#3b82f6' : attacker.color,
        born: Date.now()
      });

      if (target.hp <= 0) {
        target.hp = 100;
        target.x = 120 + Math.floor(Math.random() * 720);
        const p = getAllParticipants(room).find(u => u.username === attacker.username);
        if (p) p.score = (p.score || 0) + 50;
        syncRoster(room);

        broadcast(room, {
          type: 'chat',
          username: 'Shadow Dojo',
          text: `⚔️ ${attacker.username} defeated ${target.username} with a ${action.toUpperCase()}! (+50 pts)`,
          style: 'correct'
        });
      }
    }
  }
}

// ============================================================================
// 9. WEBSOCKET CONNECTION & PACKET ROUTING
// ============================================================================
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let currentRoom = null;
  let rx = Buffer.alloc(0);

  socket.on('data', async (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    const parsed = parseWsFrames(rx);
    rx = parsed.remaining;

    if (parsed.close) return socket.end();

    for (const raw of parsed.messages) {
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }

      if (msg.type === 'join') {
        currentRoom = getRoom(msg.roomId || 'MAIN');
        const team = currentRoom.players.size % 2 === 0 ? 'A' : 'B';
        currentRoom.players.set(socket, { ...msg.player, score: 0, team, isAI: false });
        ensureRoomHost(currentRoom);
        syncRoster(currentRoom);

        sendWs(socket, {
          type: 'modeSync',
          mode: currentRoom.mode,
          settings: currentRoom.settings
        });

        if (currentRoom.mode === 'snake') {
          spawnSnake(currentRoom, currentRoom.players.get(socket));
        } else if (currentRoom.mode === 'shadow') {
          spawnFighter(currentRoom, currentRoom.players.get(socket), currentRoom.players.size);
        } else if (currentRoom.mode === 'salem' && currentRoom.salem) {
          sendSalemStateToAll(currentRoom);
        }

        broadcast(currentRoom, {
          type: 'chat',
          username: 'System',
          text: `${msg.player.username} joined Room ${currentRoom.roomId}.`,
          style: 'system'
        });
        continue;
      }

      if (!currentRoom) continue;
      const sender = currentRoom.players.get(socket);
      if (!sender) continue;

      const isRoomHost = sender.username.toLowerCase() === currentRoom.hostUsername.toLowerCase();

      if (msg.type === 'stroke') {
        broadcast(currentRoom, msg, socket);
      } else if (msg.type === 'clearCanvas') {
        broadcast(currentRoom, { type: 'clearCanvas' }, socket);
      } else if (msg.type === 'swapTeam') {
        sender.team = sender.team === 'A' ? 'B' : 'A';
        syncRoster(currentRoom);
      } else if (msg.type === 'switchMode') {
        if (!isRoomHost) continue;
        stopAllRoomIntervals(currentRoom);
        currentRoom.mode = msg.mode;
        broadcast(currentRoom, {
          type: 'modeSync',
          mode: currentRoom.mode,
          settings: currentRoom.settings
        });
        syncRoster(currentRoom);

        if (currentRoom.mode === 'snake') {
          startSnakeGame(currentRoom);
        } else if (currentRoom.mode === 'shadow') {
          startShadowFight(currentRoom);
        } else if (currentRoom.mode === 'salem') {
          startSalemGame(currentRoom);
        } else if (currentRoom.mode === 'gartic') {
          broadcast(currentRoom, {
            type: 'garticPhase',
            phase: 'text',
            title: 'Write a creative sentence for the next player to draw!'
          });
        } else {
          startDrawingTurn(currentRoom);
        }
      } else if (msg.type === 'startGame') {
        if (!isRoomHost) continue;
        stopAllRoomIntervals(currentRoom);

        if (msg.settings) {
          currentRoom.settings = { ...currentRoom.settings, ...msg.settings };
          currentRoom.mode = msg.settings.mode || currentRoom.mode;
          rebuildRoomAI(currentRoom);
          await syncDictionary(currentRoom.settings.difficulty);
        }

        currentRoom.round = 1;
        currentRoom.garticChain = [];
        syncRoster(currentRoom);
        broadcast(currentRoom, {
          type: 'modeSync',
          mode: currentRoom.mode,
          settings: currentRoom.settings
        });

        if (currentRoom.mode === 'snake') {
          startSnakeGame(currentRoom);
        } else if (currentRoom.mode === 'shadow') {
          startShadowFight(currentRoom);
        } else if (currentRoom.mode === 'salem') {
          startSalemGame(currentRoom);
        } else if (currentRoom.mode === 'gartic') {
          broadcast(currentRoom, {
            type: 'garticPhase',
            phase: 'text',
            title: 'Write a creative sentence for the next player to draw!'
          });
        } else {
          startDrawingTurn(currentRoom);
        }
      } else if (msg.type === 'salemWill') {
        if (!currentRoom.salem) continue;
        const actor = currentRoom.salem.town.get(sender.username);
        if (actor && actor.alive) {
          actor.willText = String(msg.willText || '').slice(0, 140);
        }
      } else if (msg.type === 'salemAction') {
        if (!currentRoom.salem) continue;
        const s = currentRoom.salem;
        const actor = s.town.get(sender.username);
        if (!actor || !actor.alive) continue;

        if (s.phase === 'night') {
          s.nightActions.set(sender.username, msg.target);
          if (actor.role === 'Sheriff') {
            const inspected = s.town.get(msg.target);
            if (inspected) {
              // Godfather appears Innocent to Sheriff; Jester can look Suspicious
              const looksSus =
                ['Killer', 'Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(inspected.role) ||
                (inspected.role === 'Jester' && Math.random() < 0.6);
              const verdict = looksSus
                ? '⚠️ SUSPICIOUS (Evil or Jester!)'
                : '✅ SEEMS INNOCENT (Town or Godfather)';
              sendWs(socket, {
                type: 'chat',
                username: 'Sheriff Report',
                text: `Night ${s.day} inspection of ${inspected.username}: ${verdict}`,
                style: 'correct'
              });
            }
          } else {
            sendWs(socket, {
              type: 'chat',
              username: 'Salem Night',
              text: msg.target === 'DETONATE'
                ? '💥 Detonation sequence armed for dawn!'
                : `Night target locked: ${msg.target}`,
              style: 'system'
            });
          }
        } else if (s.phase === 'voting') {
          s.votes.set(sender.username, msg.target);
          sendSalemStateToAll(currentRoom);
        }
      } else if (msg.type === 'garticEntry') {
        currentRoom.garticChain.push({
          username: sender.username,
          prompt: msg.prompt || null,
          imageDataUrl: msg.imageDataUrl || null
        });

        if (currentRoom.players.size === 1 && currentRoom.aiPlayers.length > 0 && msg.entryType === 'text') {
          currentRoom.garticChain.push({
            username: `${currentRoom.aiPlayers[0].username} [${currentRoom.aiPlayers[0].aiLabel}]`,
            prompt: `AI interpreted "${msg.prompt}"`,
            imageDataUrl: null
          });
        }

        const targetSteps = Math.max(2, currentRoom.players.size * 2);
        if (currentRoom.garticChain.length >= targetSteps) {
          broadcast(currentRoom, { type: 'garticAlbum', chain: currentRoom.garticChain });
          currentRoom.garticChain = [];
        } else if (msg.entryType === 'text') {
          broadcast(currentRoom, { type: 'garticPhase', phase: 'draw', promptToDraw: msg.prompt });
        } else {
          broadcast(currentRoom, {
            type: 'garticPhase',
            phase: 'text',
            title: 'Describe what was drawn above!',
            previousImage: msg.imageDataUrl
          });
        }
      } else if (msg.type === 'guess') {
        const text = String(msg.text || '').trim();
        if (!text) continue;

        if (
          (currentRoom.mode === 'skribbl' || currentRoom.mode === 'hangman') &&
          currentRoom.currentWord &&
          text.toLowerCase() === currentRoom.currentWord.toLowerCase()
        ) {
          if (!currentRoom.guessedUsers.has(sender.username)) {
            currentRoom.guessedUsers.add(sender.username);
            sender.score = (sender.score || 0) + 125;
            syncRoster(currentRoom);
            broadcast(currentRoom, {
              type: 'chat',
              username: sender.username,
              text: 'Guessed the secret word!',
              style: 'correct'
            });

            stopAllRoomIntervals(currentRoom);
            advanceDrawingRound(currentRoom);
          }
          continue;
        }

        // If a human player accuses someone by name in Salem chat, AI bots take note!
        if (currentRoom.mode === 'salem' && currentRoom.salem) {
          const lower = text.toLowerCase();
          for (const target of currentRoom.salem.town.values()) {
            if (lower.includes(target.username.toLowerCase())) {
              currentRoom.salem.town.forEach(ai => {
                if (ai.isAI && ai.username !== target.username) {
                  ai.susMap.set(target.username, (ai.susMap.get(target.username) || 0) + 1.5);
                }
              });
            }
          }
        }

        if (currentRoom.mode === 'hangman' && currentRoom.currentWord && sender.team !== currentRoom.drawingTeam) {
          currentRoom.hangmanLeft = Math.max(0, currentRoom.hangmanLeft - 1);
          broadcast(currentRoom, {
            type: 'roundState',
            maskedWord: currentRoom.currentWord.split('').map(() => '_').join(' '),
            round: currentRoom.round,
            maxRounds: currentRoom.settings.rounds,
            canDraw: false,
            roleText: `Guessing Team has ${currentRoom.hangmanLeft} chances left!`,
            hangmanLeft: currentRoom.hangmanLeft,
            hangmanMax: currentRoom.settings.hangmanMaxGuesses
          });

          if (currentRoom.hangmanLeft === 0) {
            stopAllRoomIntervals(currentRoom);
            broadcast(currentRoom, {
              type: 'chat',
              username: 'Referee',
              text: `Out of chances! The word was ${currentRoom.currentWord.toUpperCase()}.`,
              style: 'system'
            });
            advanceDrawingRound(currentRoom);
            continue;
          }
        }

        broadcast(currentRoom, { type: 'chat', username: sender.username, text, style: '' });
      } else if (msg.type === 'snakeInput') {
        const s = currentRoom.snakes.get(sender.username);
        if (s) {
          if (typeof msg.angle === 'number') s.angle = msg.angle;
          if (typeof msg.boost === 'boolean') s.boost = msg.boost;
        }
      } else if (msg.type === 'shadowInput') {
        const f = currentRoom.fighters.get(sender.username);
        if (f) {
          if (typeof msg.moveX === 'number') {
            f.moveX = msg.moveX;
            if (f.cooldown === 0) f.state = msg.moveX !== 0 ? 'walk' : 'idle';
          }
          if (msg.jump && f.y >= 440) {
            f.vy = -16;
          }
          if (msg.action) {
            triggerFighterAction(currentRoom, f, msg.action);
          }
        }
      }
    }
  });

  socket.on('close', () => {
    if (currentRoom) {
      const leaving = currentRoom.players.get(socket);
      currentRoom.players.delete(socket);
      if (leaving) {
        currentRoom.snakes.delete(leaving.username);
        currentRoom.fighters.delete(leaving.username);
      }
      if (currentRoom.players.size === 0) {
        stopAllRoomIntervals(currentRoom);
      }
      syncRoster(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Enclave Arcade Live Server listening on port ${PORT}`);
  syncDictionary('ALL');
});
