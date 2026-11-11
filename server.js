// ============================================================================
// ENCLAVE ARCADE — STANDALONE LIVE MULTIPLAYER SERVER (server.js)
// Zero external dependencies (Uses built-in node:http and node:crypto)
// ============================================================================

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 8080;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';

let globalWordPool = [
  'anchor', 'compass', 'lantern', 'fortress', 'eclipse',
  'glacier', 'phantom', 'harbor', 'catapult', 'obsidian',
  'telescope', 'labyrinth', 'windmill', 'avalanche', 'treasure'
];

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
      console.log(`[Google Sheet] Synced ${globalWordPool.length} words (${difficulty})`);
    }
  } catch (err) {
    console.error('[Google Sheet] Word sync skipped:', err.message);
  }
}

// Push final match scores and wins to Google Sheet Users tab
async function pushScoresToGoogleSheet(players) {
  if (!GOOGLE_SCRIPT_URL.startsWith('http') || players.length === 0) return;
  try {
    const topScore = Math.max(...players.map(p => p.score || 0));
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'recordScores',
        players: players.map(p => ({
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
              action: payload.action, // 'signup' or 'login'
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

        // Fallback if GOOGLE_SCRIPT_URL is not configured yet
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
// 2. BUILT-IN WEBSOCKET PROTOCOL (RFC 6455)
// ============================================================================
function sendWs(socket, obj) {
  if (socket.destroyed || !socket.writable) return;
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
// 3. LIVE MULTIPLAYER ROOM ENGINE (Skribbl, Gartic, Team Hangman, Snake.io)
// ============================================================================
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      mode: 'skribbl',
      players: new Map(), // socket -> player
      settings: { drawTime: 80, rounds: 3, hangmanMaxGuesses: 10, difficulty: 'ALL' },
      round: 1,
      currentWord: '',
      drawerUsername: '',
      drawingTeam: 'A',
      hangmanLeft: 10,
      guessedUsers: new Set(),
      garticChain: [],
      timerInterval: null,
      snakeInterval: null,
      snakes: new Map(),
      orbs: []
    });
  }
  return rooms.get(roomId);
}

function broadcast(room, packet, exclude = null) {
  for (const [sock] of room.players.entries()) {
    if (sock !== exclude) sendWs(sock, packet);
  }
}

function syncRoster(room) {
  const list = Array.from(room.players.values()).map(p => ({
    username: p.username,
    color: p.color,
    score: p.score || 0,
    team: p.team
  }));
  broadcast(room, { type: 'roster', players: list });
}

function startDrawingTurn(room) {
  clearInterval(room.timerInterval);
  clearInterval(room.snakeInterval);

  const players = Array.from(room.players.values());
  if (players.length === 0) return;

  room.currentWord = (globalWordPool[Math.floor(Math.random() * globalWordPool.length)] || 'arcade').toLowerCase();
  room.guessedUsers.clear();
  room.hangmanLeft = room.settings.hangmanMaxGuesses;

  const drawer = players[(room.round - 1) % players.length];
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
      roleText: isDrawer ? 'You are drawing!' : `${room.drawerUsername} is drawing — Guess the word!`,
      hangmanLeft: room.hangmanLeft,
      hangmanMax: room.settings.hangmanMaxGuesses
    });
  }

  let timeLeft = room.settings.drawTime;
  room.timerInterval = setInterval(() => {
    timeLeft--;
    broadcast(room, { type: 'timer', timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      broadcast(room, {
        type: 'chat',
        username: 'Referee',
        text: `Time's up! The word was ${room.currentWord.toUpperCase()}.`,
        style: 'system'
      });
      if (room.round < room.settings.rounds) {
        room.round++;
        setTimeout(() => startDrawingTurn(room), 2000);
      } else {
        pushScoresToGoogleSheet(Array.from(room.players.values()));
      }
    }
  }, 1000);
}

function startSnakeGame(room) {
  clearInterval(room.timerInterval);
  clearInterval(room.snakeInterval);

  room.snakes.clear();
  room.orbs = Array.from({ length: 18 }, () => ({
    x: 30 + Math.floor(Math.random() * 900),
    y: 30 + Math.floor(Math.random() * 480)
  }));

  let idx = 0;
  for (const p of room.players.values()) {
    const sx = 140 + (idx * 120) % 680;
    const sy = 120 + (idx * 90) % 300;
    room.snakes.set(p.username, {
      username: p.username,
      color: p.color || '#6366f1',
      dx: 1,
      dy: 0,
      body: [{ x: sx, y: sy }, { x: sx - 14, y: sy }, { x: sx - 28, y: sy }]
    });
    idx++;
  }

  room.snakeInterval = setInterval(() => {
    for (const s of room.snakes.values()) {
      const head = {
        x: (s.body[0].x + s.dx * 10 + 960) % 960,
        y: (s.body[0].y + s.dy * 10 + 540) % 540
      };
      s.body.unshift(head);

      const hit = room.orbs.findIndex(o => Math.hypot(o.x - head.x, o.y - head.y) < 16);
      if (hit !== -1) {
        room.orbs[hit] = { x: 30 + Math.floor(Math.random() * 900), y: 30 + Math.floor(Math.random() * 480) };
        for (const p of room.players.values()) {
          if (p.username === s.username) p.score = (p.score || 0) + 15;
        }
        syncRoster(room);
      } else {
        s.body.pop();
      }
    }
    broadcast(room, { type: 'snakeTick', snakes: Array.from(room.snakes.values()), orbs: room.orbs });
  }, 65);
}

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
        currentRoom.players.set(socket, { ...msg.player, score: 0, team });
        syncRoster(currentRoom);
        broadcast(currentRoom, {
          type: 'chat',
          username: 'System',
          text: `${msg.player.username} joined Room ${currentRoom.roomId} (Team ${team}).`,
          style: 'system'
        });
        continue;
      }

      if (!currentRoom) continue;
      const sender = currentRoom.players.get(socket);
      if (!sender) continue;

      if (msg.type === 'stroke') {
        broadcast(currentRoom, msg, socket);
      } else if (msg.type === 'clearCanvas') {
        broadcast(currentRoom, { type: 'clearCanvas' }, socket);
      } else if (msg.type === 'swapTeam') {
        sender.team = sender.team === 'A' ? 'B' : 'A';
        syncRoster(currentRoom);
      } else if (msg.type === 'switchMode') {
        currentRoom.mode = msg.mode;
        clearInterval(currentRoom.timerInterval);
        clearInterval(currentRoom.snakeInterval);
        syncRoster(currentRoom);
        if (msg.mode === 'snake') startSnakeGame(currentRoom);
      } else if (msg.type === 'startGame') {
        if (msg.settings) {
          currentRoom.settings = { ...currentRoom.settings, ...msg.settings };
          currentRoom.mode = msg.settings.mode || currentRoom.mode;
          await syncDictionary(currentRoom.settings.difficulty);
        }
        currentRoom.round = 1;
        currentRoom.garticChain = [];
        if (currentRoom.mode === 'snake') {
          startSnakeGame(currentRoom);
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

        if (currentRoom.garticChain.length >= currentRoom.players.size * 2) {
          broadcast(currentRoom, { type: 'garticAlbum', chain: currentRoom.garticChain });
          currentRoom.garticChain = [];
        } else if (msg.entryType === 'text') {
          broadcast(currentRoom, { type: 'garticPhase', phase: 'draw', promptToDraw: msg.prompt });
        } else {
          broadcast(currentRoom, {
            type: 'garticPhase',
            phase: 'text',
            title: 'Guess / describe what was drawn above!',
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
            sender.score = (sender.score || 0) + 120;
            syncRoster(currentRoom);
            broadcast(currentRoom, {
              type: 'chat',
              username: sender.username,
              text: 'Guessed the secret word!',
              style: 'correct'
            });

            if (currentRoom.round < currentRoom.settings.rounds) {
              currentRoom.round++;
              setTimeout(() => startDrawingTurn(currentRoom), 1500);
            } else {
              broadcast(currentRoom, {
                type: 'chat',
                username: 'Referee',
                text: 'Match complete! Saving scores to leaderboard...',
                style: 'system'
              });
              pushScoresToGoogleSheet(Array.from(currentRoom.players.values()));
            }
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
            broadcast(currentRoom, {
              type: 'chat',
              username: 'Referee',
              text: `Out of chances! The word was ${currentRoom.currentWord.toUpperCase()}.`,
              style: 'system'
            });
            currentRoom.round = (currentRoom.round % currentRoom.settings.rounds) + 1;
            setTimeout(() => startDrawingTurn(currentRoom), 2000);
            continue;
          }
        }

        broadcast(currentRoom, { type: 'chat', username: sender.username, text, style: '' });
      } else if (msg.type === 'snakeDir') {
        const s = currentRoom.snakes.get(sender.username);
        if (s && (s.dx !== -msg.dx || s.dy !== -msg.dy)) {
          s.dx = msg.dx;
          s.dy = msg.dy;
        }
      }
    }
  });

  socket.on('close', () => {
    if (currentRoom) {
      currentRoom.players.delete(socket);
      syncRoster(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Enclave Arcade Live Server listening on port ${PORT}`);
  syncDictionary('ALL');
});
