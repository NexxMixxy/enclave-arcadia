// ============================================================================
// ENCLAVE ARCADE — COMPLETE LIVE SERVER (server.js)
// Includes Medium (Every-3-Nights Seance), Mayor, Executioner, Bodyguard,
// Consigliere, and 2D 1v1 Tournament Bracket Stickman Shadow Fight
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
// 3. PARALLEL COLONY AI PROFILES
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
    { name: 'Colony_Zane', label: '15y HS', color: '#f97316' },
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
      shadowBracket: null,
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
// 7. VILLAGE OF SALEM ENGINE (MEDIUM SEANCE EVERY 3 NIGHTS + 14 ROLES)
// ============================================================================
const FAKE_CLAIM_ROLES = ['Sheriff', 'Doctor', 'Medium', 'Bodyguard', 'Vigilante', 'Villager'];

function buildSalemRoleDeck(totalCount) {
  const deck = ['Godfather', 'Sheriff', 'Doctor', 'Medium', 'Vigilante', 'Jester'];
  const specials = [
    'Mayor', 'Bodyguard', 'Executioner', 'Consigliere',
    'Werewolf', 'Bomber', 'PlagueDoctor', 'Killer'
  ];

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
  return ['Godfather', 'Killer', 'Consigliere', 'Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(role);
}

function isMafiaRole(role) {
  return role === 'Godfather' || role === 'Killer' || role === 'Consigliere';
}

function isTownRole(role) {
  return ['Villager', 'Doctor', 'Sheriff', 'Vigilante', 'Medium', 'Mayor', 'Bodyguard'].includes(role);
}

function broadcastMafiaNightChat(room, senderName, text) {
  if (!room.salem) return;
  for (const [sock, p] of room.players.entries()) {
    const member = room.salem.town.get(p.username);
    if (member && (isMafiaRole(member.role) || !member.alive)) {
      sendWs(sock, {
        type: 'chat',
        username: `🩸 [MAFIA] ${senderName}`,
        text,
        style: 'mafia-chat'
      });
    }
  }
}

// Medium Seance + Dead Chat Router (Every 3rd Night, living Mediums & Dead share the Seance channel!)
function broadcastDeadOrSeanceChat(room, senderName, text, isLivingMedium = false) {
  if (!room.salem) return;
  const s = room.salem;
  const seanceNight = s.phase === 'night' && s.day % 3 === 0;

  for (const [sock, p] of room.players.entries()) {
    const member = s.town.get(p.username);
    if (!member) continue;
    const canHear = !member.alive || (seanceNight && member.alive && member.role === 'Medium');
    if (canHear) {
      sendWs(sock, {
        type: 'chat',
        username: isLivingMedium ? `🔮 [MEDIUM SEANCE] ${senderName}` : `👻 [DEAD] ${senderName}`,
        text,
        style: seanceNight ? 'seance-chat' : 'dead-chat'
      });
    }
  }
}

function startSalemGame(room) {
  stopAllRoomIntervals(room);

  if (getAllParticipants(room).length < 8) {
    room.settings.aiCount = Math.max(room.settings.aiCount, 8 - room.players.size);
    rebuildRoomAI(room);
    syncRoster(room);
  }

  const all = getAllParticipants(room);
  const deck = buildSalemRoleDeck(all.length);

  const townMap = new Map();
  all.forEach((p, idx) => {
    const role = deck[idx];
    const fakeClaim = isEvilRole(role) || role === 'Jester' || role === 'Executioner'
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
      mayorRevealed: false,
      execTarget: '',
      revealedRole: '',
      bullets: role === 'Vigilante' ? 2 : 0,
      basicDefense: role === 'Godfather' || role === 'Executioner' ? 1 : 0,
      infected: role === 'PlagueDoctor',
      willText: `${p.username} the ${fakeClaim} — Night Logs:`,
      aiLogs: [],
      susMap: new Map()
    });
  });

  // Assign Executioner a random living Town target
  const townCandidates = Array.from(townMap.values()).filter(
    t => isTownRole(t.role) && t.role !== 'Mayor'
  );
  townMap.forEach(member => {
    if (member.role === 'Executioner' && townCandidates.length > 0) {
      const pick = townCandidates[Math.floor(Math.random() * townCandidates.length)];
      member.execTarget = pick.username;
    }
  });

  room.salem = {
    day: 1,
    phase: 'night',
    town: townMap,
    graveyard: [],
    nightActions: new Map(),
    votes: new Map(),
    bombs: new Set(),
    jesterHauntQueue: [],
    pestilenceUnleashed: false,
    report: 'Night 1 has fallen. Mediums channel the Graveyard every 3rd Night (Night 3, 6, 9)!'
  };

  broadcast(room, {
    type: 'chat',
    username: 'Salem Crier',
    text: '🕯️ Village of Salem has begun! Roles include Medium, Mayor, Executioner, Bodyguard & Consigliere.',
    style: 'system'
  });

  runSalemPhaseLoop(room);
}

function announceFallenPlayer(room, victim, causeText) {
  victim.alive = false;
  victim.revealedRole = victim.role;

  const will = (victim.willText || '').trim();
  if (room.salem) {
    room.salem.graveyard.push({
      username: victim.username,
      role: victim.role,
      cause: causeText,
      willText: will || 'No Last Will left behind.',
      day: room.salem.day
    });

    // If an Executioner's target dies at night, Executioner becomes a Jester!
    room.salem.town.forEach(member => {
      if (member.alive && member.role === 'Executioner' && member.execTarget === victim.username && room.salem.phase === 'night') {
        member.role = 'Jester';
        member.execTarget = '';
      }
    });
  }

  broadcast(room, {
    type: 'chat',
    username: 'Salem Morgue',
    text: `💀 ${victim.username} died (${causeText}). Their role was ${victim.role}.`,
    style: 'system'
  });

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
  const seanceNight = s.day % 3 === 0;

  const voteCounts = {};
  for (const [voterName, target] of s.votes.entries()) {
    if (target !== 'SKIP') {
      const voterObj = s.town.get(voterName);
      const weight = voterObj && voterObj.mayorRevealed ? 3 : 1;
      voteCounts[target] = (voteCounts[target] || 0) + weight;
    }
  }

  for (const [sock, p] of room.players.entries()) {
    const me = s.town.get(p.username) || { role: 'Villager', alive: false, bullets: 0 };
    let canAct = false;
    let actionLabel = 'Select';
    let instruction = 'Wait for the current phase to conclude.';
    let extraStatus = '';

    if (me.role === 'Vigilante') extraStatus = `${me.bullets} Bullets`;
    if (me.role === 'Bomber') extraStatus = `${s.bombs.size} Planted`;
    if (me.role === 'Executioner' && me.execTarget) extraStatus = `Target: ${me.execTarget}`;
    if (me.role === 'Medium') extraStatus = seanceNight ? 'Seance ACTIVE' : `Seance on Night ${Math.ceil(s.day / 3) * 3}`;

    if (me.alive) {
      if (s.phase === 'night') {
        switch (me.role) {
          case 'Godfather':
          case 'Killer':
            canAct = true;
            actionLabel = 'Assassinate';
            instruction = '🩸 Mafia Night Chat is open! Coordinate with your partners & pick a target.';
            break;
          case 'Consigliere':
            canAct = true;
            actionLabel = 'Inspect Role';
            instruction = '🩸 Mafia Consigliere: Inspect a player tonight to uncover their exact role!';
            break;
          case 'Doctor':
            canAct = true;
            actionLabel = 'Heal';
            instruction = 'Choose a player (or yourself) to heal from attacks tonight.';
            break;
          case 'Bodyguard':
            canAct = true;
            actionLabel = 'Guard';
            instruction = 'Choose a player to guard tonight (You will duel & kill their first attacker!).';
            break;
          case 'Sheriff':
            canAct = true;
            actionLabel = 'Interrogate';
            instruction = 'Inspect a suspect tonight (Note: Godfathers & Jesters can fool Sheriffs!).';
            break;
          case 'Medium':
            instruction = seanceNight
              ? '🔮 SEANCE NIGHT (Every 3rd Night)! Type in the right-hand chat to commune with the Graveyard!'
              : `You are the Medium. Your next Graveyard Seance opens on Night ${Math.ceil(s.day / 3) * 3}!`;
            break;
          case 'Mayor':
            instruction = 'You are the Mayor! Survive the night—during the day you can reveal for 3x vote power.';
            break;
          case 'Executioner':
            instruction = `🎯 You are the Executioner! Trick the Town into exiling ${me.execTarget} during the day trial.`;
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
            instruction = 'You are a Villager sleeping through the night. Update your Last Will!';
        }
      } else if (s.phase === 'discussion') {
        instruction = 'Cross-check the Graveyard Role List & Last Wills on the right!';
      } else if (s.phase === 'voting') {
        canAct = true;
        actionLabel = me.mayorRevealed ? 'Vote (3x)' : 'Vote Exile';
        instruction = 'Vote to exile a suspect (Beware of Jester & Executioner pushes!).';
      }
    } else {
      instruction = seanceNight && s.phase === 'night'
        ? '🔮 SEANCE NIGHT! A living Medium is listening to Dead Chat right now—share your leads!'
        : '👻 You are in the Graveyard! You can talk with other fallen players in Dead Chat.';
    }

    const townView = Array.from(s.town.values()).map(t => ({
      username: t.username,
      color: t.color,
      alive: t.alive,
      mayorRevealed: t.mayorRevealed,
      revealedRole: t.revealedRole,
      isMafiaMate: isMafiaRole(me.role) && isMafiaRole(t.role),
      isExecTarget: me.role === 'Executioner' && me.execTarget === t.username,
      hasBomb: me.role === 'Bomber' && s.bombs.has(t.username),
      isInfected: (me.role === 'PlagueDoctor' || me.role === 'Pestilence') && t.infected
    }));

    sendWs(sock, {
      type: 'salemState',
      day: s.day,
      phase: s.phase,
      fullMoon,
      seanceNight,
      myRole: me.role,
      mayorRevealed: me.mayorRevealed,
      extraStatus,
      plantedCount: s.bombs.size,
      amAlive: me.alive,
      canAct,
      actionLabel,
      instruction,
      report: s.report,
      town: townView,
      graveyard: s.graveyard,
      votes: s.phase === 'voting' ? voteCounts : {}
    });
  }
}

function runSalemPhaseLoop(room) {
  stopAllRoomIntervals(room);
  const s = room.salem;
  if (!s) return;

  if (s.phase === 'night' && s.day % 3 === 0) {
    broadcastDeadOrSeanceChat(
      room,
      'Seance Bell',
      `Night ${s.day} Seance is open! Living Mediums and Fallen Ghosts can communicate tonight.`,
      true
    );
  }

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
// NON-CHEATING SALEM AI (With Medium Seance Ghosts, Executioner & Mayor Logic)
// ============================================================================
function pickAiTargetWithoutCheating(ai, aliveOthers) {
  if (aliveOthers.length === 0) return null;
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
  const seanceNight = s.day % 3 === 0;
  const style = room.settings.salemAiStyle || 'deductive';
  const aliveList = Array.from(s.town.values()).filter(t => t.alive);
  const deadAiList = Array.from(s.town.values()).filter(t => !t.alive && t.isAI);

  // Dead AI ghosts whisper clues during Every-3rd-Night Seance!
  if (s.phase === 'night' && seanceNight && deadAiList.length > 0 && aliveList.length > 0) {
    const ghost = deadAiList[Math.floor(Math.random() * deadAiList.length)];
    const suspect = aliveList[Math.floor(Math.random() * aliveList.length)];
    const timerId = setTimeout(() => {
      if (!room.salem || room.salem.phase !== 'night') return;
      broadcastDeadOrSeanceChat(
        room,
        ghost.username,
        `Medium, listen closely! Before I died, ${suspect.username}'s alibi didn't add up—watch them tomorrow!`,
        false
      );
      aliveList.forEach(m => {
        if (m.isAI && m.role === 'Medium') {
          m.aiLogs.push(`Seance N${s.day}: Ghost ${ghost.username} warned about ${suspect.username}`);
          m.willText = `${m.username} the Medium | ${m.aiLogs.join('; ')}`;
          m.susMap.set(suspect.username, (m.susMap.get(suspect.username) || 0) + 2.2);
        }
      });
    }, 4000);
    room.salemChatTimeouts.push(timerId);
  }

  aliveList.filter(t => t.isAI).forEach(ai => {
    const aliveOthers = aliveList.filter(t => t.username !== ai.username);
    if (aliveOthers.length === 0) return;

    if (s.phase === 'night') {
      if (ai.role === 'Godfather' || ai.role === 'Killer') {
        const nonMafia = aliveOthers.filter(t => !isMafiaRole(t.role));
        const pick = nonMafia[Math.floor(Math.random() * nonMafia.length)];
        if (pick) {
          s.nightActions.set(ai.username, pick.username);
          const timerId = setTimeout(() => {
            if (!room.salem || room.salem.phase !== 'night' || !ai.alive) return;
            broadcastMafiaNightChat(
              room,
              ai.username,
              `Targeting ${pick.username} tonight. Tomorrow I'll claim ${ai.fakeClaim}.`
            );
          }, 2500 + Math.floor(Math.random() * 4000));
          room.salemChatTimeouts.push(timerId);
        }
        const randomPeer = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        ai.willText = `${ai.username} the ${ai.fakeClaim} | N${s.day}: Visited ${randomPeer.username}`;
      } else if (ai.role === 'Consigliere') {
        const nonMafia = aliveOthers.filter(t => !isMafiaRole(t.role));
        const pick = nonMafia[Math.floor(Math.random() * nonMafia.length)];
        if (pick) s.nightActions.set(ai.username, pick.username);
      } else if (ai.role === 'Doctor' || ai.role === 'Bodyguard') {
        const revealedMayor = aliveOthers.find(t => t.mayorRevealed);
        const pick = revealedMayor || aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        if (pick) {
          s.nightActions.set(ai.username, pick.username);
          ai.aiLogs.push(`N${s.day}: Protected ${pick.username}`);
          ai.willText = `${ai.username} the ${ai.role} | ${ai.aiLogs.join(', ')}`;
        }
      } else if (ai.role === 'Sheriff') {
        const pick = pickAiTargetWithoutCheating(ai, aliveOthers);
        if (pick) s.nightActions.set(ai.username, pick.username);
      } else if (ai.role === 'Vigilante' && ai.bullets > 0) {
        const topSus = pickAiTargetWithoutCheating(ai, aliveOthers);
        if (s.day > 1 && topSus && (ai.susMap.get(topSus.username) || 0) >= 2 && Math.random() < 0.6) {
          s.nightActions.set(ai.username, topSus.username);
          ai.aiLogs.push(`N${s.day}: Shot ${topSus.username}`);
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
      }
    } else if (s.phase === 'discussion') {
      // AI Mayor might reveal on Day 2+
      if (ai.role === 'Mayor' && !ai.mayorRevealed && s.day >= 2 && Math.random() < 0.5) {
        const revTimer = setTimeout(() => {
          if (!room.salem || !ai.alive || ai.mayorRevealed) return;
          ai.mayorRevealed = true;
          broadcast(room, {
            type: 'chat',
            username: 'Salem Crier',
            text: `🎖️ ${ai.username} has officially revealed themselves as the MAYOR of Salem! (Vote weight: 3x)`,
            style: 'correct'
          });
          sendSalemStateToAll(room);
        }, 3000);
        room.salemChatTimeouts.push(revTimer);
      }

      const speakChance = style === 'chaotic' ? 0.75 : (style === 'deductive' ? 0.6 : 0.45);
      if (Math.random() > speakChance) return;

      const delay = 2200 + Math.floor(Math.random() * 14000);
      const timerId = setTimeout(() => {
        if (!room.salem || room.salem.phase !== 'discussion' || !ai.alive) return;
        const currentOthers = Array.from(s.town.values()).filter(t => t.alive && t.username !== ai.username);
        if (currentOthers.length === 0) return;
        const randomPeer = pickAiTargetWithoutCheating(ai, currentOthers);

        let line = '';
        if ((ai.role === 'Sheriff' || ai.role === 'Medium') && ai.aiLogs.length > 0) {
          const latestLog = ai.aiLogs[ai.aiLogs.length - 1];
          line = `${ai.role} claim here! Latest log: ${latestLog}. Thoughts?`;
        } else if (ai.role === 'Executioner' && ai.execTarget) {
          line = `I checked ${ai.execTarget} last night and they came back SUSPICIOUS! We need to trial ${ai.execTarget} today!`;
          aliveList.forEach(other => {
            if (other.isAI) other.susMap.set(ai.execTarget, (other.susMap.get(ai.execTarget) || 0) + 1.1);
          });
        } else if (ai.role === 'Jester') {
          const jesterLines = [
            `Wait why is everyone looking at me?? I'm totally ${ai.fakeClaim}, trust me bro.`,
            `I think ${randomPeer.username} is evil, source: it came to me in a dream.`,
            `Don't vote me! If I die the town loses its best "Doctor" 👀`
          ];
          line = jesterLines[Math.floor(Math.random() * jesterLines.length)];
          aliveList.forEach(other => {
            if (other.isAI && other.username !== ai.username) {
              other.susMap.set(ai.username, (other.susMap.get(ai.username) || 0) + 1.2);
            }
          });
        } else if (isEvilRole(ai.role)) {
          const bluffLines = [
            `I claim ${ai.fakeClaim}. Honestly ${randomPeer.username} has been way too quiet today, kinda sus.`,
            `Look at the Graveyard roles—there's still evil out there. What is ${randomPeer.username} claiming?`,
            `Idk about you guys, but ${randomPeer.username}'s voting pattern feels super sketchy to me.`
          ];
          line = bluffLines[Math.floor(Math.random() * bluffLines.length)];
          aliveList.forEach(other => {
            if (other.isAI) other.susMap.set(randomPeer.username, (other.susMap.get(randomPeer.username) || 0) + 0.7);
          });
        } else {
          const townLines = [
            `${randomPeer.username}, any leads or Last Will to share with the Town?`,
            `Check the Graveyard wills on the right—${randomPeer.username}'s claim might conflict.`,
            `Careful of Executioner pushes, let's get role claims before locking votes on ${randomPeer.username}.`
          ];
          line = townLines[Math.floor(Math.random() * townLines.length)];
        }

        if (line) {
          broadcast(room, { type: 'chat', username: ai.username, text: line, style: '' });
        }
      }, delay);

      room.salemChatTimeouts.push(timerId);
    } else if (s.phase === 'voting') {
      const delay = 2500 + Math.floor(Math.random() * 11000);
      const timerId = setTimeout(() => {
        if (!room.salem || room.salem.phase !== 'voting' || !ai.alive) return;
        const currentOthers = Array.from(s.town.values()).filter(t => t.alive && t.username !== ai.username);
        if (currentOthers.length === 0) return;

        if (ai.role === 'Executioner' && ai.execTarget) {
          const execT = s.town.get(ai.execTarget);
          if (execT && execT.alive) {
            s.votes.set(ai.username, ai.execTarget);
            sendSalemStateToAll(room);
            return;
          }
        }

        if (Math.random() < 0.25) {
          s.votes.set(ai.username, 'SKIP');
          sendSalemStateToAll(room);
          return;
        }

        let pool = currentOthers.filter(t => !t.mayorRevealed);
        if (pool.length === 0) pool = currentOthers;

        if (isMafiaRole(ai.role)) {
          const nonMafia = pool.filter(t => !isMafiaRole(t.role));
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
    const guardedBy = new Map(); // targetName -> bodyguardName
    const visitorsTo = new Map();
    const nightKills = []; // { victimName, attackerName, cause, unstoppable }
    let mafiaKillIssued = false;

    const recordVisit = (visitor, target) => {
      if (!target || target === 'DETONATE' || visitor === target) return;
      if (!visitorsTo.has(target)) visitorsTo.set(target, []);
      visitorsTo.get(target).push(visitor);
    };

    while (s.jesterHauntQueue.length > 0) {
      const haunt = s.jesterHauntQueue.shift();
      const validVoters = haunt.voters.map(u => s.town.get(u)).filter(t => t && t.alive);
      if (validVoters.length > 0) {
        const haunted = validVoters[Math.floor(Math.random() * validVoters.length)];
        nightKills.push({
          victimName: haunted.username,
          attackerName: '',
          cause: `Haunted by Jester ${haunt.jesterName}`,
          unstoppable: true
        });
      }
    }

    for (const [actorName, targetName] of s.nightActions.entries()) {
      const actor = s.town.get(actorName);
      if (!actor || !actor.alive) continue;
      recordVisit(actorName, targetName);

      if (actor.role === 'Doctor') {
        healedSet.add(targetName);
      } else if (actor.role === 'Bodyguard') {
        guardedBy.set(targetName, actorName);
      } else if (actor.role === 'Consigliere') {
        const inspected = s.town.get(targetName);
        if (inspected) {
          broadcastMafiaNightChat(
            room,
            `${actor.username} (Consigliere)`,
            `Intel report: ${inspected.username}'s exact role is ${inspected.role}!`
          );
        }
      } else if (actor.role === 'Sheriff') {
        const inspected = s.town.get(targetName);
        if (inspected) {
          const looksSus =
            ['Killer', 'Consigliere', 'Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(inspected.role) ||
            (inspected.role === 'Jester' && Math.random() < 0.6);

          if (actor.isAI) {
            actor.aiLogs.push(`N${s.day}: ${inspected.username} (${looksSus ? 'SUS!' : 'Inno'})`);
            actor.willText = `${actor.username} the Sheriff | ${actor.aiLogs.join(', ')}`;
            if (looksSus) actor.susMap.set(inspected.username, (actor.susMap.get(inspected.username) || 0) + 4);
          }
        }
      } else if (actor.role === 'Godfather' || actor.role === 'Killer') {
        if (!mafiaKillIssued) {
          mafiaKillIssued = true;
          nightKills.push({ victimName: targetName, attackerName: actorName, cause: 'Mafia Ambush', unstoppable: false });
        }
      } else if (actor.role === 'Vigilante' && actor.bullets > 0) {
        actor.bullets--;
        const shotTarget = s.town.get(targetName);
        if (shotTarget) {
          nightKills.push({ victimName: targetName, attackerName: actorName, cause: 'Vigilante Shot', unstoppable: false });
          if (isTownRole(shotTarget.role)) {
            actor.bullets = 0;
          }
        }
      } else if (actor.role === 'Werewolf' && fullMoon) {
        nightKills.push({ victimName: targetName, attackerName: actorName, cause: 'Werewolf Full-Moon Maul', unstoppable: false });
        const othersAtHouse = visitorsTo.get(targetName) || [];
        othersAtHouse.forEach(vName => {
          if (vName !== actorName) {
            nightKills.push({ victimName: vName, attackerName: actorName, cause: 'Mauled visiting a Werewolf target', unstoppable: false });
          }
        });
      } else if (actor.role === 'Bomber') {
        if (targetName === 'DETONATE') {
          s.bombs.forEach(bombedUser => {
            nightKills.push({ victimName: bombedUser, attackerName: actorName, cause: 'Detonated by the Bomber', unstoppable: true });
          });
          s.bombs.clear();
        } else {
          s.bombs.add(targetName);
        }
      } else if (actor.role === 'PlagueDoctor') {
        const t = s.town.get(targetName);
        if (t) t.infected = true;
      } else if (actor.role === 'Pestilence') {
        nightKills.push({ victimName: targetName, attackerName: actorName, cause: 'Obliterated by Pestilence', unstoppable: true });
      }
    }

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

    const casualties = [];
    nightKills.forEach(k => {
      const victim = s.town.get(k.victimName);
      if (!victim || !victim.alive) return;
      if (victim.role === 'Pestilence') return;

      // Bodyguard Interception Duel!
      if (!k.unstoppable && guardedBy.has(victim.username) && k.attackerName) {
        const bgName = guardedBy.get(victim.username);
        const bgObj = s.town.get(bgName);
        const atkObj = s.town.get(k.attackerName);
        guardedBy.delete(victim.username);

        if (bgObj && bgObj.alive) {
          announceFallenPlayer(room, bgObj, `Fought off an attacker guarding ${victim.username}`);
          casualties.push(`${bgObj.username} (Bodyguard)`);
        }
        if (atkObj && atkObj.alive && atkObj.role !== 'Pestilence') {
          announceFallenPlayer(room, atkObj, `Slain by Bodyguard ${bgName}`);
          casualties.push(`${atkObj.username} (${atkObj.role})`);
        }
        return;
      }

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

    const aliveNow = Array.from(s.town.values()).filter(t => t.alive);
    const pd = aliveNow.find(t => t.role === 'PlagueDoctor');
    if (pd && aliveNow.every(t => t.infected)) {
      pd.role = 'Pestilence';
      s.pestilenceUnleashed = true;
      broadcast(room, {
        type: 'chat',
        username: 'Apocalypse Herald',
        text: '☣️ Every living soul is infected — The Plague Doctor has transformed into PESTILENCE!',
        style: 'correct'
      });
    }

    s.report = casualties.length > 0
      ? `Dawn of Day ${s.day}: Casualties overnight — ${casualties.join(', ')}. Inspect the Graveyard!`
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
        const voterObj = s.town.get(voter);
        const weight = voterObj && voterObj.mayorRevealed ? 3 : 1;
        tally[target] = (tally[target] || 0) + weight;
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

        // Check if any living Executioner had this player as their target
        s.town.forEach(member => {
          if (member.alive && member.role === 'Executioner' && member.execTarget === exiled.username) {
            const ep = getAllParticipants(room).find(u => u.username === member.username);
            if (ep) ep.score = (ep.score || 0) + 250;
            syncRoster(room);
            broadcast(room, {
              type: 'chat',
              username: 'Executioner Victory',
              text: `🪓 ${member.username} (Executioner) successfully tricked the Town into exiling ${exiled.username}! (+250 pts)`,
              style: 'correct'
            });
          }
        });

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
  const aliveMafia = alive.filter(t => isMafiaRole(t.role)).length;
  const aliveNeutEvil = alive.filter(t =>
    ['Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(t.role)
  ).length;
  const aliveTown = alive.filter(t => isTownRole(t.role)).length;

  if (aliveMafia === 0 && aliveNeutEvil === 0) {
    stopAllRoomIntervals(room);
    s.report = `🏆 TOWN VICTORY! All Mafia, Monsters, and Apocalypse threats have been vanquished!`;
    getAllParticipants(room).forEach(p => {
      const t = s.town.get(p.username);
      if (t && isTownRole(t.role)) {
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
// 8. STICKMAN SHADOW FIGHT (PACED 2D PHYSICS + 1V1 TOURNAMENT BRACKET)
// ============================================================================
function createFighterState(p, sideIndex) {
  return {
    username: p.username,
    color: p.color || (sideIndex === 0 ? '#ef4444' : '#3b82f6'),
    isAI: Boolean(p.isAI),
    aiTier: p.aiTier || 'medium',
    x: sideIndex === 0 ? 270 : 690,
    y: 430,
    vx: 0,
    vy: 0,
    moveX: 0,
    facing: sideIndex === 0 ? 1 : -1,
    hp: 100,
    state: 'idle',
    cooldown: 0,
    stun: 0
  };
}

function startShadowFight(room) {
  stopAllRoomIntervals(room);

  // Ensure at least 4 competitors for a clean 1v1 Bracket (Semifinals -> Finals)
  if (getAllParticipants(room).length < 4) {
    room.settings.aiCount = Math.max(room.settings.aiCount, 4 - room.players.size);
    rebuildRoomAI(room);
    syncRoster(room);
  }

  const competitors = [...getAllParticipants(room)];
  // Shuffle bracket seeding
  for (let i = competitors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [competitors[i], competitors[j]] = [competitors[j], competitors[i]];
  }

  room.shadowBracket = {
    roundNumber: 1,
    currentPool: competitors,
    nextRoundWinners: [],
    matchIndex: 0,
    activePair: []
  };

  launchNextBracketDuel(room);
}

function launchNextBracketDuel(room) {
  const b = room.shadowBracket;
  if (!b) return;

  // If current round pool is exhausted, advance to next bracket stage!
  if (b.matchIndex * 2 >= b.currentPool.length) {
    if (b.nextRoundWinners.length <= 1) {
      const champ = b.nextRoundWinners[0] || b.currentPool[0];
      if (champ) {
        const p = getAllParticipants(room).find(u => u.username === champ.username);
        if (p) p.score = (p.score || 0) + 150;
        syncRoster(room);
        broadcast(room, {
          type: 'chat',
          username: 'Dojo Grandmaster',
          text: `🏆 ${champ.username} won the 1v1 Shadow Fight Tournament Finals! (+150 pts) — Starting new bracket in 4s...`,
          style: 'correct'
        });
      }
      setTimeout(() => {
        if (room.mode === 'shadow') startShadowFight(room);
      }, 4000);
      return;
    }

    b.currentPool = [...b.nextRoundWinners];
    b.nextRoundWinners = [];
    b.matchIndex = 0;
    b.roundNumber++;
  }

  const p1 = b.currentPool[b.matchIndex * 2];
  const p2 = b.currentPool[b.matchIndex * 2 + 1];

  // Odd player gets a bye to the next round
  if (p1 && !p2) {
    b.nextRoundWinners.push(p1);
    b.matchIndex++;
    broadcast(room, {
      type: 'chat',
      username: 'Dojo Bracket',
      text: `🥋 ${p1.username} receives a bracket bye into the next round!`,
      style: 'system'
    });
    launchNextBracketDuel(room);
    return;
  }

  room.fighters.clear();
  room.effects = [];
  const f1 = createFighterState(p1, 0);
  const f2 = createFighterState(p2, 1);
  room.fighters.set(f1.username, f1);
  room.fighters.set(f2.username, f2);
  b.activePair = [f1.username, f2.username];

  const totalMatchesInRound = Math.ceil(b.currentPool.length / 2);
  const stageName = totalMatchesInRound === 1
    ? 'Grand Finals'
    : (totalMatchesInRound === 2 ? 'Semifinals' : `Round ${b.roundNumber}`);

  broadcast(room, {
    type: 'chat',
    username: 'Dojo Announcer',
    text: `⚔️ [${stageName}] 1v1 Duel: ${f1.username} vs ${f2.username}!`,
    style: 'system'
  });

  clearInterval(room.shadowInterval);
  room.shadowInterval = setInterval(() => tickShadowDuel(room, stageName, totalMatchesInRound), 50);
}

function tickShadowDuel(room, stageName, totalMatchesInRound) {
  const b = room.shadowBracket;
  if (!b) return;

  const fighters = Array.from(room.fighters.values());
  if (fighters.length < 2) return;

  room.effects = room.effects.filter(ef => Date.now() - ef.born < 180);

  fighters.forEach(f => {
    if (f.cooldown > 0) f.cooldown--;
    if (f.stun > 0) f.stun--;

    if (f.stun === 0 && f.cooldown === 0 && ['punch', 'kick', 'slash', 'hitstun'].includes(f.state)) {
      f.state = f.moveX !== 0 ? 'walk' : 'idle';
    }

    const opponent = fighters.find(o => o.username !== f.username);
    if (!opponent) return;

    // Paced Martial Arts AI Decision Tree
    if (f.isAI && f.stun === 0) {
      const dx = opponent.x - f.x;
      const dist = Math.abs(dx);
      f.facing = dx >= 0 ? 1 : -1;

      const strikeRate = f.aiTier === 'hard' ? 0.14 : (f.aiTier === 'medium' ? 0.09 : 0.05);

      if (dist > 82) {
        f.moveX = f.facing;
        if (f.cooldown === 0) f.state = 'walk';
      } else if (dist < 44) {
        // Step back slightly for spacing like real Shadow Fight
        f.moveX = Math.random() < 0.35 ? -f.facing : 0;
      } else {
        f.moveX = 0;
        if (f.cooldown === 0 && Math.random() < strikeRate) {
          // React with block if opponent is mid-slash
          if (opponent.state === 'slash' && Math.random() < 0.45) {
            triggerFighterAction(room, f, 'block');
          } else {
            const moves = ['punch', 'kick', 'slash', 'block'];
            triggerFighterAction(room, f, moves[Math.floor(Math.random() * moves.length)]);
          }
        }
      }
    }

    // Deliberate 2D Movement + Knockback Friction
    const walkVel = (f.state !== 'block' && f.stun === 0 && f.cooldown < 6) ? f.moveX * 4.4 : 0;
    f.x = Math.max(125, Math.min(835, Math.round(f.x + walkVel + f.vx)));
    f.vx *= 0.76;
    if (Math.abs(f.vx) < 0.3) f.vx = 0;

    if (f.moveX !== 0 && f.stun === 0 && !f.isAI) {
      f.facing = Math.sign(f.moveX);
    }

    // Gravity on 2D Dojo Floor (y = 430)
    f.y = Math.round(f.y + f.vy);
    if (f.y < 430) {
      f.vy += 1.45;
    } else {
      f.y = 430;
      f.vy = 0;
    }
  });

  const nextIdx = (b.matchIndex + 1) * 2;
  const upNextA = b.currentPool[nextIdx];
  const upNextB = b.currentPool[nextIdx + 1];
  const queueSummary = upNextA
    ? `Up Next: ${upNextA.username} vs ${upNextB ? upNextB.username : 'BYE'} | Advancing: ${b.nextRoundWinners.map(w => w.username).join(', ') || 'None yet'}`
    : `Advancing to Next Stage: ${b.nextRoundWinners.map(w => w.username).join(', ') || 'Winner of this duel'}`;

  broadcast(room, {
    type: 'shadowTick',
    fighters,
    effects: room.effects,
    bracket: {
      stageName,
      currentMatchLabel: `Match ${b.matchIndex + 1}/${totalMatchesInRound}: ${fighters[0].username} vs ${fighters[1].username}`,
      queueSummary,
      spectatorNote: '1v1 Elimination Bracket — Winner advances to Finals!'
    }
  });
}

function triggerFighterAction(room, attacker, action) {
  if (!room.shadowBracket || attacker.cooldown > 0 || attacker.stun > 0) return;

  if (action === 'block') {
    attacker.state = 'block';
    attacker.cooldown = 12;
    return;
  }

  attacker.state = action;
  // Deliberate, paced frame data & knockback velocities
  const stats = {
    punch: { range: 62, dmg: 9, cd: 10, stun: 5, knockVx: 7 },
    kick: { range: 78, dmg: 14, cd: 16, stun: 8, knockVx: 13 },
    slash: { range: 96, dmg: 20, cd: 23, stun: 11, knockVx: 18 }
  }[action] || { range: 62, dmg: 9, cd: 10, stun: 5, knockVx: 7 };

  attacker.cooldown = stats.cd;

  for (const target of room.fighters.values()) {
    if (target.username === attacker.username) continue;
    const dx = target.x - attacker.x;
    const inFront = Math.sign(dx) === attacker.facing || Math.abs(dx) < 18;

    if (inFront && Math.abs(dx) <= stats.range && Math.abs(target.y - attacker.y) < 55) {
      const blocked = target.state === 'block';
      const finalDmg = blocked ? Math.ceil(stats.dmg * 0.2) : stats.dmg;
      target.hp -= finalDmg;
      target.vx = attacker.facing * (blocked ? 3.5 : stats.knockVx);

      if (!blocked) {
        target.state = 'hitstun';
        target.stun = stats.stun;
      } else {
        attacker.cooldown += 4; // Slight parry stagger when hitting a guard
      }

      room.effects.push({
        x: Math.round((attacker.x + target.x) / 2),
        y: target.y - 62,
        color: blocked ? '#3b82f6' : attacker.color,
        born: Date.now()
      });

      if (target.hp <= 0) {
        target.hp = 0;
        clearInterval(room.shadowInterval);

        const winnerParticipant = getAllParticipants(room).find(u => u.username === attacker.username);
        if (winnerParticipant) {
          winnerParticipant.score = (winnerParticipant.score || 0) + 45;
          room.shadowBracket.nextRoundWinners.push(winnerParticipant);
        }
        room.shadowBracket.matchIndex++;
        syncRoster(room);

        broadcast(room, {
          type: 'chat',
          username: 'Dojo Referee',
          text: `🥋 ${attacker.username} defeated ${target.username} with a ${action.toUpperCase()} and advances in the bracket! (+45 pts)`,
          style: 'correct'
        });

        setTimeout(() => {
          if (room.mode === 'shadow') launchNextBracketDuel(room);
        }, 2400);
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
      } else if (msg.type === 'salemMayorReveal') {
        if (!currentRoom.salem) continue;
        const s = currentRoom.salem;
        const actor = s.town.get(sender.username);
        if (actor && actor.alive && actor.role === 'Mayor' && !actor.mayorRevealed && s.phase !== 'night') {
          actor.mayorRevealed = true;
          broadcast(currentRoom, {
            type: 'chat',
            username: 'Salem Crier',
            text: `🎖️ ${actor.username} has officially revealed themselves as the MAYOR of Salem! Their vote now counts as 3 votes!`,
            style: 'correct'
          });
          sendSalemStateToAll(currentRoom);
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
              const looksSus =
                ['Killer', 'Consigliere', 'Werewolf', 'Bomber', 'PlagueDoctor', 'Pestilence'].includes(inspected.role) ||
                (inspected.role === 'Jester' && Math.random() < 0.6);
              const verdict = looksSus
                ? '⚠️ SUSPICIOUS (Evil or Jester!)'
                : '✅ SEEMS INNOCENT (Town, Executioner, or Godfather)';
              sendWs(socket, {
                type: 'chat',
                username: 'Sheriff Report',
                text: `Night ${s.day} inspection of ${inspected.username}: ${verdict}`,
                style: 'correct'
              });
            }
          } else if (actor.role === 'Consigliere') {
            const inspected = s.town.get(msg.target);
            if (inspected) {
              sendWs(socket, {
                type: 'chat',
                username: 'Consigliere Intel',
                text: `Night ${s.day} exact role of ${inspected.username}: ${inspected.role}`,
                style: 'mafia-chat'
              });
            }
          } else if (isMafiaRole(actor.role)) {
            broadcastMafiaNightChat(
              currentRoom,
              sender.username,
              `Locked target on ${msg.target} for tonight.`
            );
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

        // VILLAGE OF SALEM CHAT ROUTING (Dead Chat, Medium Seance, Mafia Night Chat, & Public Day Chat)
        if (currentRoom.mode === 'salem' && currentRoom.salem) {
          const s = currentRoom.salem;
          const member = s.town.get(sender.username);
          const seanceNight = s.phase === 'night' && s.day % 3 === 0;

          if (member && !member.alive) {
            broadcastDeadOrSeanceChat(currentRoom, sender.username, text, false);
            continue;
          }

          if (s.phase === 'night') {
            if (member && isMafiaRole(member.role)) {
              broadcastMafiaNightChat(currentRoom, sender.username, text);
            } else if (member && member.role === 'Medium' && seanceNight) {
              broadcastDeadOrSeanceChat(currentRoom, sender.username, text, true);
            } else {
              sendWs(socket, {
                type: 'chat',
                username: 'Salem Night',
                text: '🌙 Town is sleeping! Public chat is muted until dawn.',
                style: 'system'
              });
            }
            continue;
          }

          const lower = text.toLowerCase();
          for (const target of s.town.values()) {
            if (lower.includes(target.username.toLowerCase())) {
              s.town.forEach(ai => {
                if (ai.isAI && ai.username !== target.username) {
                  ai.susMap.set(target.username, (ai.susMap.get(target.username) || 0) + 1.5);
                }
              });
            }
          }

          broadcast(currentRoom, { type: 'chat', username: sender.username, text, style: '' });
          continue;
        }

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
        // Only the 2 active 1v1 bracket duelists can control fighters on the mat
        const f = currentRoom.fighters.get(sender.username);
        if (f) {
          if (typeof msg.moveX === 'number') {
            f.moveX = msg.moveX;
            if (f.cooldown === 0 && f.stun === 0) f.state = msg.moveX !== 0 ? 'walk' : 'idle';
          }
          if (msg.jump && f.y >= 430 && f.stun === 0) {
            f.vy = -14.5;
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
