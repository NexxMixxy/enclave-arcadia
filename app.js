// ============================================================================
// ENCLAVE ARCADE — STANDALONE LIVE FRONTEND (app.js)
// ============================================================================

// 1. Point this to your Render Web Service URL
const RENDER_SERVER_URL = "https://enclave-arcade-backend.onrender.com";
const WS_URL = RENDER_SERVER_URL.replace(/^http/, "ws");

const state = {
  authMode: "login",
  room: "MAIN",
  mode: "skribbl",
  me: {
    username: "Player",
    color: "#6366f1",
    wins: 0,
    team: "A"
  },
  players: [],
  drawing: false,
  brushColor: "#000000",
  brushSize: 6,
  canDraw: true
};

// ============================================================================
// 2. SIGN UP / LOG IN FLOW
// ============================================================================
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const signupExtra = document.getElementById("signupExtra");
const authForm = document.getElementById("authForm");
const authError = document.getElementById("authError");

tabLogin.onclick = () => {
  state.authMode = "login";
  tabLogin.classList.add("active");
  tabSignup.classList.remove("active");
  signupExtra.classList.add("hidden");
};

tabSignup.onclick = () => {
  state.authMode = "signup";
  tabSignup.classList.add("active");
  tabLogin.classList.remove("active");
  signupExtra.classList.remove("hidden");
};

authForm.onsubmit = async (e) => {
  e.preventDefault();
  authError.textContent = "Connecting to server...";

  const username = document.getElementById("authUsername").value.trim();
  const password = document.getElementById("authPassword").value;
  const color = document.getElementById("authColor").value;
  const room = document.getElementById("authRoom").value.trim().toUpperCase() || "MAIN";

  try {
    const res = await fetch(`${RENDER_SERVER_URL}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: state.authMode,
        username,
        password,
        color
      })
    });
    const data = await res.json();

    if (!data.ok) {
      authError.textContent = data.error || "Authentication failed";
      return;
    }

    state.me.username = data.user.username;
    state.me.color = data.user.color || color;
    state.me.wins = data.user.wins || 0;
    state.room = room;

    updateProfileChip();
    document.getElementById("authModal").classList.add("hidden");
    connectLiveSocket();
  } catch (err) {
    // Fallback if testing locally before Render is updated
    state.me.username = username;
    state.me.color = color;
    state.room = room;
    updateProfileChip();
    document.getElementById("authModal").classList.add("hidden");
    connectLiveSocket();
  }
};

function updateProfileChip() {
  document.getElementById("myUsername").textContent = state.me.username;
  document.getElementById("myTotalWins").textContent = `${state.me.wins} Wins`;
  const badge = document.getElementById("myBadge");
  badge.textContent = state.me.username.charAt(0).toUpperCase();
  badge.style.background = state.me.color;
  document.getElementById("roomBadge").textContent = `Room: ${state.room}`;
}

// ============================================================================
// 3. LIVE WEBSOCKET CONNECTION
// ============================================================================
let ws = null;

function connectLiveSocket() {
  const dot = document.getElementById("connStatus");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    dot.classList.remove("offline");
    dot.classList.add("online");
    sendPacket("join", {
      roomId: state.room,
      player: state.me
    });
  };

  ws.onclose = () => {
    dot.classList.remove("online");
    dot.classList.add("offline");
    setTimeout(connectLiveSocket, 4000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  };
}

function sendPacket(type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "roster":
      state.players = msg.players;
      renderRoster();
      break;

    case "stroke":
      drawSegment(msg.x0, msg.y0, msg.x1, msg.y1, msg.color, msg.size, false);
      break;

    case "clearCanvas":
      clearCanvasBoard(false);
      break;

    case "roundState":
      document.getElementById("hudWordMask").textContent = msg.maskedWord;
      document.getElementById("hudRound").textContent = `Round ${msg.round} / ${msg.maxRounds}`;
      document.getElementById("hudRole").textContent = msg.roleText || "";
      state.canDraw = Boolean(msg.canDraw);
      if (msg.hangmanLeft !== undefined) {
        document.getElementById("hudChancesLeft").textContent = `${msg.hangmanLeft} / ${msg.hangmanMax}`;
      }
      break;

    case "timer":
      document.getElementById("hudTimer").textContent = `${msg.timeLeft}s`;
      break;

    case "chat":
      appendChatMessage(msg.username, msg.text, msg.style);
      break;

    case "garticPhase":
      handleGarticPhase(msg);
      break;

    case "garticAlbum":
      renderGarticAlbum(msg.chain);
      break;

    case "snakeTick":
      renderSnakeArena(msg.snakes, msg.orbs);
      break;
  }
}

// ============================================================================
// 4. WHITEBOARD CANVAS & PNG DOWNLOAD
// ============================================================================
const canvas = document.getElementById("arcadeCanvas");
const ctx = canvas.getContext("2d");
clearCanvasBoard(false);

const colors = [
  "#000000", "#ffffff", "#ef4444", "#f59e0b",
  "#10b981", "#3b82f6", "#6366f1", "#ec4899", "#78350f"
];
const paletteEl = document.getElementById("colorPalette");

colors.forEach((hex, i) => {
  const sw = document.createElement("div");
  sw.className = "color-swatch" + (i === 0 ? " active" : "");
  sw.style.background = hex;
  sw.onclick = () => {
    state.brushColor = hex;
    document.querySelectorAll(".color-swatch").forEach(el => el.classList.remove("active"));
    sw.classList.add("active");
  };
  paletteEl.appendChild(sw);
});

let prevPt = { x: 0, y: 0 };

function getCanvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

canvas.addEventListener("pointerdown", (e) => {
  if (state.mode === "snake" || !state.canDraw) return;
  state.drawing = true;
  prevPt = getCanvasPoint(e);
});

canvas.addEventListener("pointermove", (e) => {
  if (!state.drawing || state.mode === "snake" || !state.canDraw) return;
  const pt = getCanvasPoint(e);
  drawSegment(prevPt.x, prevPt.y, pt.x, pt.y, state.brushColor, state.brushSize, true);
  prevPt = pt;
});

window.addEventListener("pointerup", () => {
  state.drawing = false;
});

function drawSegment(x0, y0, x1, y1, color, size, broadcastStroke) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.stroke();

  if (broadcastStroke) {
    sendPacket("stroke", { x0, y0, x1, y1, color, size });
  }
}

function clearCanvasBoard(emit = true) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (emit) sendPacket("clearCanvas");
}

document.getElementById("brushSize").oninput = (e) => {
  state.brushSize = Number(e.target.value);
};

document.getElementById("btnEraser").onclick = () => {
  state.brushColor = "#ffffff";
};

document.getElementById("btnClearCanvas").onclick = () => {
  if (state.canDraw) clearCanvasBoard(true);
};

document.getElementById("btnDownloadPng").onclick = () => {
  const link = document.createElement("a");
  link.download = `enclave-arcade-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
};

// ============================================================================
// 5. MODE SWITCHING & GARTIC / HANGMAN / SNAKE HANDLERS
// ============================================================================
document.querySelectorAll(".mode-tab").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".mode-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.mode = btn.dataset.mode;

    document.getElementById("hudHangmanBox").classList.toggle("hidden", state.mode !== "hangman");
    document.getElementById("btnSwitchTeam").classList.toggle("hidden", state.mode !== "hangman");
    document.getElementById("drawToolbar").classList.toggle("hidden", state.mode === "snake");
    document.getElementById("garticPanel").classList.toggle("hidden", state.mode !== "gartic");
    document.getElementById("btnSubmitDrawing").classList.toggle("hidden", state.mode !== "gartic");

    sendPacket("switchMode", { mode: state.mode });
  };
});

document.getElementById("btnSwitchTeam").onclick = () => {
  sendPacket("swapTeam");
};

document.getElementById("btnStartMatch").onclick = () => {
  const settings = {
    mode: state.mode,
    drawTime: Number(document.getElementById("setDrawTime").value) || 80,
    rounds: Number(document.getElementById("setRounds").value) || 3,
    hangmanMaxGuesses: Number(document.getElementById("setHangmanChances").value) || 10,
    difficulty: document.getElementById("setDifficulty").value
  };
  sendPacket("startGame", { settings });
};

// Gartic Chain Workflow
document.getElementById("btnGarticSubmitText").onclick = () => {
  const input = document.getElementById("garticSentenceInput");
  const text = input.value.trim();
  if (!text) return;
  sendPacket("garticEntry", { entryType: "text", prompt: text });
  input.value = "";
  document.getElementById("garticStepTitle").textContent = "Submitted! Waiting for other players...";
};

document.getElementById("btnSubmitDrawing").onclick = () => {
  const dataUrl = canvas.toDataURL("image/png");
  sendPacket("garticEntry", { entryType: "drawing", imageDataUrl: dataUrl });
  document.getElementById("garticPanel").classList.remove("hidden");
  document.getElementById("garticStepTitle").textContent = "Drawing saved! Write or wait for next chain step...";
};

function handleGarticPhase(msg) {
  const panel = document.getElementById("garticPanel");
  const banner = document.getElementById("garticTargetPrompt");

  if (msg.phase === "draw") {
    // Hide overlay so player can draw the sentence on the canvas
    panel.classList.add("hidden");
    clearCanvasBoard(false);
    state.canDraw = true;
    document.getElementById("hudRole").textContent = `Draw this: "${msg.promptToDraw}"`;
  } else {
    panel.classList.remove("hidden");
    document.getElementById("garticStepTitle").textContent = msg.title || "Write what you see or start a prompt";
    if (msg.previousImage) {
      banner.innerHTML = `<img src="${msg.previousImage}" style="max-height:160px;background:#fff;border-radius:6px;" />`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }
}

function renderGarticAlbum(chain) {
  const panel = document.getElementById("garticPanel");
  const album = document.getElementById("garticAlbumList");
  panel.classList.remove("hidden");
  document.getElementById("garticStepTitle").textContent = "Gartic Chain Complete — Save Your Favorite Drawings!";
  album.innerHTML = "";

  chain.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "album-entry";
    div.innerHTML = `<strong>${item.username}</strong>: ${item.prompt || "Drew an interpretation"}`;

    if (item.imageDataUrl) {
      const img = document.createElement("img");
      img.src = item.imageDataUrl;
      const dl = document.createElement("button");
      dl.className = "btn-tool accent";
      dl.style.marginTop = "8px";
      dl.textContent = "Download PNG";
      dl.onclick = () => {
        const a = document.createElement("a");
        a.download = `gartic-${item.username}-${index + 1}.png`;
        a.href = item.imageDataUrl;
        a.click();
      };
      div.appendChild(img);
      div.appendChild(dl);
    }
    album.appendChild(div);
  });
}

// Live Snake.io Controls & Renderer
window.addEventListener("keydown", (e) => {
  if (state.mode !== "snake") return;
  const map = {
    ArrowUp: [0, -1], KeyW: [0, -1],
    ArrowDown: [0, 1], KeyS: [0, 1],
    ArrowLeft: [-1, 0], KeyA: [-1, 0],
    ArrowRight: [1, 0], KeyD: [1, 0]
  };
  if (map[e.code]) {
    sendPacket("snakeDir", { dx: map[e.code][0], dy: map[e.code][1] });
  }
});

function renderSnakeArena(snakes, orbs) {
  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  orbs.forEach(o => {
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.arc(o.x, o.y, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  snakes.forEach(s => {
    ctx.fillStyle = s.color || "#6366f1";
    s.body.forEach((seg, idx) => {
      ctx.fillRect(seg.x - 7, seg.y - 7, 14, 14);
      if (idx === 0) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "600 12px sans-serif";
        ctx.fillText(s.username, seg.x - 18, seg.y - 12);
        ctx.fillStyle = s.color || "#6366f1";
      }
    });
  });
}

// ============================================================================
// 6. ROSTER & CHAT
// ============================================================================
function renderRoster() {
  const container = document.getElementById("playerRoster");
  container.innerHTML = "";
  state.players.forEach(p => {
    const item = document.createElement("div");
    item.className = "player-item";
    item.innerHTML = `
      <div class="player-left">
        <div class="avatar-circle" style="background:${p.color || "#6366f1"};width:24px;height:24px;font-size:11px;">
          ${p.username.charAt(0).toUpperCase()}
        </div>
        <span style="font-weight:600;">${p.username}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${state.mode === "hangman" ? `<span class="team-badge team-${p.team}">Team ${p.team}</span>` : ""}
        <span style="color:var(--text-dim);font-weight:700;">${p.score || 0}</span>
      </div>
    `;
    container.appendChild(item);
  });
}

function appendChatMessage(username, text, style = "") {
  const feed = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = `chat-line ${style}`;
  div.innerHTML = `<strong>${username}:</strong> ${text}`;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

document.getElementById("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  sendPacket("guess", { text });
  input.value = "";
};
