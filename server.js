// ============================================================================
// ENCLAVE ARCADE — COMPLETE LIVE SERVER (server.js)
// Zero external dependencies (Uses built-in node:http and node:crypto)
// ============================================================================

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 8080;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';

let globalWordPool = [
  'anchor', 'compass', 'lantern', 'fortress', 'eclipse',
  'glacier', 'phantom', 'harbor', 'catapult', 'obsidian',
  'telescope', 'labyrinth', 'windmill', 'avalanche', 'treasure',
  ' volcano', 'spaceship', 'pirate', 'waterfall', 'lightning'
].map(w => w.trim());

// Sync English dictionary from Google Sheet
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
// 1. HTTP SERVER (Sign Up / Login Proxy to Google Sheet)
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
// 3. PARALLEL COLONY AI PROFILES (Middle School, High School, University)
// ============================================================================
const AI_CATALOG = {
  easy: [
    { name: 'Colony_Leo', label: '12y MS', color: '#10b981' },
    { name: 'Colony_Maya', label: '13y MS', color: '#3b82f6' },
    { name: 'Colony_Toby', label: '11y MS', color: '#f59e0b' },
    { name: 'Colony_Zoe', label: '14y MS', color: '#ec4899' }
  ],
  medium: [
    { name: 'Colony_Zack', label: '16y HS', color: '#6366f1' },
    { name: 'Colony_Chloe', label: '17y HS', color: '#ec4899' },
    { name: 'Colony_Kai', label: '15y HS', color: '#10b981' },
    { name: 'Colony_Jade', label: '17y HS', color: '#f59e0b' }
  ],
  hard: [
    { name: 'Colony_Draven', label: '19y UNI', color: '#a855f7' },
    { name: 'Colony_Elena', label: '20y UNI', color: '#ef4444' },
    { name: 'Colony_Soren', label: '18y UNI', color: '#3b82f6' },
    { name: 'Colony_Lyra', label: '20y UNI', color: '#10b981' }
  ]
};

function rebuildRoomAI(room) {
  const count = Math.min(4, Math.max(0, Number(room.settings.aiCount) || 0));
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
      players: new Map(), // socket -> human player
      aiPlayers: [],
      settings: {
        drawTime: 75,
        rounds: 3,
        hangmanMaxGuesses: 10,
        difficulty: 'ALL',
        aiCount: 1,
        aiTier: 'medium'
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
      snakes: new Map(),
      orbs: [],
      fighters: new Map(),
      effects: []
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
// 5. SKRIBBL & TEAM HANGMAN ENGINE (With AI Guessing & AI Vector Drawing)
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

  broadcast(room, {
    type: 'chat',
    username: 'Referee',
    text: `Round ${room.round}: ${room.drawerUsername} is now drawing!`,
    style: 'system'
  });

  // If an AI bot is the drawer, draw a procedural sketch on the canvas
  if (drawer.isAI) {
    runAiProceduralDrawing(room, drawer);
  }

  let timeLeft = room.settings.drawTime;
  broadcast(room, { type: 'timer', timeLeft });

  room.timerInterval = setInterval(() => {
    timeLeft--;
    broadcast(room, { type: 'timer', timeLeft });

    // Parallel Colony AI Guessing Logic
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
    broadcast(room, {
      type: 'chat',
      username: 'Referee',
      text: 'Match finished! Saving scores to Google Sheet...',
      style: 'system'
    });
    pushScoresToGoogleSheet(getAllParticipants(room));
  }
}

function runAiProceduralDrawing(room, aiDrawer) {
  let step = 0;
  const cx = 480;
  const cy = 270;
  room.aiInterval = setInterval(() => {
    if (step > 45) {
      clearInterval(room.aiInterval);
      return;
    }
    const a1 = (step / 20) * Math.PI * 2;
    const a2 = ((step + 1) / 20) * Math.PI * 2;
    const r = 75 + (step > 20 ? 35 * Math.sin(step) : 0);
    broadcast(room, {
      type: 'stroke',
      x0: cx + Math.cos(a1) * r,
      y0: cy + Math.sin(a1) * r,
      x1: cx + Math.cos(a2) * r,
      y1: cy + Math.sin(a2) * r,
      color: aiDrawer.color || '#6366f1',
      size: 6
    });
    step++;
  }, 180);
}

function runAiWordGuessing(room, timeLeft) {
  if (!room.currentWord || room.aiPlayers.length === 0) return;

  room.aiPlayers.forEach(ai => {
    if (ai.username === room.drawerUsername) return;
    if (room.mode === 'hangman' && ai.team === room.drawingTeam) return;
    if (room.guessedUsers.has(ai.username)) return;

    // Intelligence probability per second based on school tier
    const hitChance = ai.aiTier === 'hard' ? 0.055 : (ai.aiTier === 'medium' ? 0.032 : 0.018);
    const wrongChatChance = 0.04;

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
    } else if (Math.random() < wrongChatChance) {
      const decoys = globalWordPool.filter(w => w !== room.currentWord);
      const randomGuess = decoys[Math.floor(Math.random() * decoys.length)] || 'circle';
      broadcast(room, {
        type: 'chat',
        username: `${ai.username} [${ai.aiLabel}]`,
        text: randomGuess,
        style: ''
      });
    }
  });
}

// ============================================================================
// 6. 3D ENDLESS SNAKE.IO ENGINE (Collisions, Mass Loot Drops & Respawns)
// ============================================================================
function spawnSnakeForParticipant(room, p) {
  const sx = 120 + Math.floor(Math.random() * 720);
  const sy = 100 + Math.floor(Math.random() * 340);
  const angle = Math.random() * Math.PI * 2;
  const body = [];
  for (let i = 0; i < 6; i++) {
    body.push({
      x: sx - Math.cos(angle) * i * 10,
      y: sy - Math.sin(angle) * i * 10
    });
  }
  room.snakes.set(p.username, {
    username: p.username,
    color: p.color || '#6366f1',
    isAI: Boolean(p.isAI),
    aiTier: p.aiTier || 'medium',
    angle,
    boost: false,
    body
  });
}

function startSnakeGame(room) {
  stopAllRoomIntervals(room);
  room.snakes.clear();

  const orbColors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa'];
  room.orbs = Array.from({ length: 28 }, () => ({
    x: 35 + Math.floor(Math.random() * 890),
    y: 35 + Math.floor(Math.random() * 470),
    radius: 6,
    value: 10,
    loot: false,
    color: orbColors[Math.floor(Math.random() * orbColors.length)]
  }));

  getAllParticipants(room).forEach(p => spawnSnakeForParticipant(room, p));

  room.snakeInterval = setInterval(() => {
    const allSnakes = Array.from(room.snakes.values());

    // 1. Update AI Steering (Hunt high-value loot orbs & avoid walls/bodies)
    allSnakes.forEach(s => {
      if (!s.isAI || s.body.length === 0) return;
      const head = s.body[0];

      // Find nearest attractive orb
      let bestOrb = null;
      let bestScore = Infinity;
      room.orbs.forEach(o => {
        const d = Math.hypot(o.x - head.x, o.y - head.y) / (o.loot ? 2.2 : 1);
        if (d < bestScore) {
          bestScore = d;
          bestOrb = o;
        }
      });

      let targetAngle = bestOrb ? Math.atan2(bestOrb.y - head.y, bestOrb.x - head.x) : s.angle;

      // University & High School AI actively dodge other snake bodies
      if (s.aiTier !== 'easy') {
        allSnakes.forEach(other => {
          if (other.username === s.username) return;
          other.body.forEach(seg => {
            const dist = Math.hypot(seg.x - head.x, seg.y - head.y);
            if (dist < 48) {
              targetAngle = Math.atan2(head.y - seg.y, head.x - seg.x);
            }
          });
        });
      }

      const turnSpeed = s.aiTier === 'hard' ? 0.28 : (s.aiTier === 'medium' ? 0.19 : 0.12);
      const diff = Math.atan2(Math.sin(targetAngle - s.angle), Math.cos(targetAngle - s.angle));
      s.angle += diff * turnSpeed;
      s.boost = s.aiTier === 'hard' && bestScore < 95 && s.body.length > 10;
    });

    // 2. Move All Snakes
    allSnakes.forEach(s => {
      if (s.body.length === 0) return;
      const speed = s.boost && s.body.length > 6 ? 11.5 : 7.5;
      const head = {
        x: (s.body[0].x + Math.cos(s.angle) * speed + 960) % 960,
        y: (s.body[0].y + Math.sin(s.angle) * speed + 540) % 540
      };
      s.body.unshift(head);

      let ateOrb = false;
      for (let i = room.orbs.length - 1; i >= 0; i--) {
        const o = room.orbs[i];
        if (Math.hypot(o.x - head.x, o.y - head.y) < (o.radius || 6) + 12) {
          ateOrb = true;
          const pts = o.value || 10;
          const participant = getAllParticipants(room).find(p => p.username === s.username);
          if (participant) participant.score = (participant.score || 0) + pts;

          if (o.loot) {
            room.orbs.splice(i, 1);
          } else {
            room.orbs[i].x = 35 + Math.floor(Math.random() * 890);
            room.orbs[i].y = 35 + Math.floor(Math.random() * 470);
          }
          break;
        }
      }

      if (!ateOrb) {
        s.body.pop();
      }
    });

    // 3. Check Head-to-Body Collisions (Snake.io Cut-Off Rules)
    const deadSnakes = [];
    allSnakes.forEach(sA => {
      if (sA.body.length === 0) return;
      const headA = sA.body[0];

      allSnakes.forEach(sB => {
        if (sA.username === sB.username) return;
        for (let i = 0; i < sB.body.length; i++) {
          const seg = sB.body[i];
          if (Math.hypot(headA.x - seg.x, headA.y - seg.y) < 14) {
            deadSnakes.push({ victim: sA, killer: sB });
            break;
          }
        }
      });
    });

    // 4. Convert Dead Snakes into % Mass Loot Orbs & Respawn
    if (deadSnakes.length > 0) {
      deadSnakes.forEach(({ victim, killer }) => {
        // Drop ~65% of body segments as large glowing loot orbs along their body trail
        victim.body.forEach((seg, idx) => {
          if (idx % 2 === 0 && room.orbs.length < 90) {
            room.orbs.push({
              x: seg.x + (Math.random() * 10 - 5),
              y: seg.y + (Math.random() * 10 - 5),
              radius: 10,
              value: 25,
              loot: true,
              color: victim.color
            });
          }
        });

        const victimPlayer = getAllParticipants(room).find(p => p.username === victim.username);
        if (victimPlayer) {
          victimPlayer.score = Math.floor((victimPlayer.score || 0) * 0.4);
          spawnSnakeForParticipant(room, victimPlayer);
        }

        broadcast(room, {
          type: 'chat',
          username: 'Snake Arena',
          text: `🐍 ${killer.username} cut off ${victim.username}! Bonus mass dropped!`,
          style: 'system'
        });
      });
      syncRoster(room);
    }

    broadcast(room, {
      type: 'snakeTick',
      snakes: Array.from(room.snakes.values()),
      orbs: room.orbs
    });
  }, 60);
}

// ============================================================================
// 7. STICKMAN SHADOW FIGHT ENGINE (Dojo Combat + Parallel Colony AI Fighters)
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

      // Parallel Colony AI Martial Arts Decision Tree
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

      // Horizontal Movement & Gravity
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
// 8. WEBSOCKET CONNECTION & PACKET ROUTING
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

        // Sync new player to the room's active mode immediately
        sendWs(socket, {
          type: 'modeSync',
          mode: currentRoom.mode,
          settings: currentRoom.settings
        });

        if (currentRoom.mode === 'snake') {
          spawnSnakeForParticipant(currentRoom, currentRoom.players.get(socket));
        } else if (currentRoom.mode === 'shadow') {
          spawnFighter(currentRoom, currentRoom.players.get(socket), currentRoom.players.size);
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
        } else if (currentRoom.mode === 'gartic') {
          broadcast(currentRoom, {
            type: 'garticPhase',
            phase: 'text',
            title: 'Write a creative sentence for the next player to draw!'
          });
        } else {
          startDrawingTurn(currentRoom);
        }
      } else if (msg.type === 'garticEntry') {
        currentRoom.garticChain.push({
          username: sender.username,
          prompt: msg.prompt || null,
          imageDataUrl: msg.imageDataUrl || null
        });

        // Also let AI bots contribute a step if solo
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
