// ============================================================================
// ENCLAVE ARCADE — LIVE MULTIPLAYER CLIENT (app.js)
// Supports Host Lock, Parallel Colony AI, 3D Snake.io, Shadow Fight & Mobile
// ============================================================================

const RENDER_SERVER_URL = "https://enclave-arcade-live.onrender.com";
const WS_URL = RENDER_SERVER_URL.replace(/^http/, "ws");

const state = {
  authMode: "login",
  room: "MAIN",
  mode: "skribbl",
  hostUsername: "",
  isHost: false,
  mobileControls: /Android|iPhone|iPad|iPod|Touch/i.test(navigator.userAgent),
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
  canDraw: false
};

// ============================================================================
// 1. AUTHENTICATION (SIGN UP & LOG IN)
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
      body: JSON.stringify({ action: state.authMode, username, password, color })
    });
    const data = await res.json();

    if (!data.ok) {
      authError.textContent = data.error || "Login failed";
      return;
    }

    state.me.username = data.user.username;
    state.me.color = data.user.color || color;
    state.me.wins = data.user.wins || 0;
    state.room = room;

    finishLogin();
  } catch (err) {
    state.me.username = username;
    state.me.color = color;
    state.room = room;
    finishLogin();
  }
};

function finishLogin() {
  document.getElementById("myUsername").textContent = state.me.username;
  document.getElementById("myTotalWins").textContent = `${state.me.wins} Wins`;
  const badge = document.getElementById("myBadge");
  badge.textContent = state.me.username.charAt(0).toUpperCase();
  badge.style.background = state.me.color;
  document.getElementById("roomBadge").textContent = `Room: ${state.room}`;
  document.getElementById("authModal").classList.add("hidden");

  updateMobileControlsUI();
  connectWebSocket();
}

// ============================================================================
// 2. WEBSOCKET CONNECTION & SERVER SYNC
// ============================================================================
let ws = null;

function connectWebSocket() {
  const dot = document.getElementById("connStatus");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    dot.classList.remove("offline");
    dot.classList.add("online");
    sendPacket("join", { roomId: state.room, player: state.me });
  };

  ws.onclose = () => {
    dot.classList.remove("online");
    dot.classList.add("offline");
    setTimeout(connectWebSocket, 3500);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerPacket(msg);
  };
}

function sendPacket(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function handleServerPacket(msg) {
  switch (msg.type) {
    case "roster":
      state.players = msg.players || [];
      state.hostUsername = msg.hostUsername || "";
      state.isHost = state.me.username.toLowerCase() === state.hostUsername.toLowerCase();
      updateHostPermissionsUI();
      renderRoster();
      break;

    case "modeSync":
      applyModeUI(msg.mode, msg.settings);
      break;

    case "stroke":
      if (state.mode === "skribbl" || state.mode === "hangman" || state.mode === "gartic") {
        drawSegment(msg.x0, msg.y0, msg.x1, msg.y1, msg.color, msg.size, false);
      }
      break;

    case "clearCanvas":
      clearCanvasBoard(false);
      break;

    case "roundState":
      document.getElementById("hudWordMask").textContent = msg.maskedWord || "_ _ _ _ _";
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
      if (state.mode === "snake") {
        render3DSnakeArena(msg.snakes, msg.orbs);
      }
      break;

    case "shadowTick":
      if (state.mode === "shadow") {
        renderShadowFightArena(msg.fighters, msg.effects);
      }
      break;
  }
}

// ============================================================================
// 3. HOST LOCKING & MODE SWITCHING (Prevents layering/desync)
// ============================================================================
function updateHostPermissionsUI() {
  const hostBadge = document.getElementById("hostBadge");
  hostBadge.textContent = state.isHost
    ? "👑 You are Room Host"
    : `👑 Host: ${state.hostUsername || "None"}`;

  const settingsPanel = document.getElementById("hostSettingsPanel");
  settingsPanel.classList.toggle("locked-panel", !state.isHost);

  const controls = [
    "setDrawTime", "setRounds", "setHangmanChances",
    "setDifficulty", "setAiCount", "setAiTier", "btnStartMatch"
  ];
  controls.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !state.isHost;
  });

  document.querySelectorAll(".mode-tab").forEach(tab => {
    tab.classList.toggle("locked-tab", !state.isHost);
    tab.title = state.isHost ? "Switch Game Mode" : "Only the Room Host can switch game modes";
  });
}

function applyModeUI(newMode, settings) {
  state.mode = newMode;
  state.drawing = false;

  document.querySelectorAll(".mode-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === newMode);
  });

  if (settings) {
    document.getElementById("setDrawTime").value = settings.drawTime || 75;
    document.getElementById("setRounds").value = settings.rounds || 3;
    document.getElementById("setHangmanChances").value = settings.hangmanMaxGuesses || 10;
    document.getElementById("setDifficulty").value = settings.difficulty || "ALL";
    if (settings.aiCount !== undefined) document.getElementById("setAiCount").value = String(settings.aiCount);
    if (settings.aiTier) document.getElementById("setAiTier").value = settings.aiTier;
  }

  const isActionMode = newMode === "snake" || newMode === "shadow";
  document.getElementById("hudHangmanBox").classList.toggle("hidden", newMode !== "hangman");
  document.getElementById("btnSwitchTeam").classList.toggle("hidden", newMode !== "hangman");
  document.getElementById("drawToolbar").classList.toggle("hidden", isActionMode);
  document.getElementById("garticPanel").classList.toggle("hidden", newMode !== "gartic");
  document.getElementById("btnSubmitDrawing").classList.toggle("hidden", newMode !== "gartic");

  // Clear old frames cleanly so Snake or Shadow Fight never gets stuck on the board
  clearCanvasBoard(false);

  if (newMode === "snake") {
    document.getElementById("hudWordMask").textContent = "3D SNAKE.IO";
    document.getElementById("hudRole").textContent = "Slither, eat glowing orbs, and cut off rivals!";
    document.getElementById("hudTimer").textContent = "ENDLESS";
  } else if (newMode === "shadow") {
    document.getElementById("hudWordMask").textContent = "SHADOW FIGHT";
    document.getElementById("hudRole").textContent = "PC: WASD + J(Punch) K(Kick) L(Katana) Space(Block)";
    document.getElementById("hudTimer").textContent = "DOJO";
  }

  updateMobileControlsUI();
}

document.querySelectorAll(".mode-tab").forEach(btn => {
  btn.onclick = () => {
    if (!state.isHost) {
      appendChatMessage("System", "Only the Room Host can switch the active game mode.", "system");
      return;
    }
    sendPacket("switchMode", { mode: btn.dataset.mode });
  };
});

document.getElementById("btnStartMatch").onclick = () => {
  if (!state.isHost) return;
  const settings = {
    mode: state.mode,
    drawTime: Number(document.getElementById("setDrawTime").value) || 75,
    rounds: Number(document.getElementById("setRounds").value) || 3,
    hangmanMaxGuesses: Number(document.getElementById("setHangmanChances").value) || 10,
    difficulty: document.getElementById("setDifficulty").value,
    aiCount: Number(document.getElementById("setAiCount").value) || 0,
    aiTier: document.getElementById("setAiTier").value || "medium"
  };
  sendPacket("startGame", { settings });
};

document.getElementById("btnSwitchTeam").onclick = () => {
  sendPacket("swapTeam");
};

// ============================================================================
// 4. CANVAS DRAWING & PNG SAVING (PC Mouse + Mobile Touch)
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
  if (state.mode === "snake" || state.mode === "shadow") return;
  if (!state.canDraw) return;
  state.drawing = true;
  prevPt = getCanvasPoint(e);
});

canvas.addEventListener("pointermove", (e) => {
  const pt = getCanvasPoint(e);

  // In Snake.io on PC, steering follows mouse cursor smoothly
  if (state.mode === "snake" && !state.mobileControls) {
    const angle = Math.atan2(pt.y - 270, pt.x - 480);
    sendPacket("snakeInput", { angle });
    return;
  }

  if (!state.drawing || state.mode === "snake" || state.mode === "shadow" || !state.canDraw) return;
  drawSegment(prevPt.x, prevPt.y, pt.x, pt.y, state.brushColor, state.brushSize, true);
  prevPt = pt;
});

window.addEventListener("pointerup", () => {
  state.drawing = false;
});

function drawSegment(x0, y0, x1, y1, color, size, emit) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.stroke();

  if (emit) {
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
// 5. 3D SNAKE.IO RENDERER (Volumetric Spheres, Drop Shadows, Loot Orbs)
// ============================================================================
function render3DSnakeArena(snakes, orbs) {
  // Deep 3D perspective floor gradient
  const bgGrad = ctx.createRadialGradient(480, 270, 60, 480, 270, 560);
  bgGrad.addColorStop(0, "#181d2c");
  bgGrad.addColorStop(1, "#0b0d14");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle isometric-style 3D hex/grid floor lines
  ctx.strokeStyle = "rgba(99, 102, 241, 0.12)";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Render glowing energy orbs & dead-snake mass drops
  orbs.forEach(o => {
    const r = o.radius || 6;
    ctx.save();
    ctx.shadowColor = o.color || "#f59e0b";
    ctx.shadowBlur = o.loot ? 16 : 9;
    const orbGrad = ctx.createRadialGradient(o.x - r * 0.3, o.y - r * 0.3, 1, o.x, o.y, r);
    orbGrad.addColorStop(0, "#ffffff");
    orbGrad.addColorStop(0.4, o.color || "#fbbf24");
    orbGrad.addColorStop(1, "#92400e");
    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Render each snake with 3D cylindrical/spherical shading from tail to head
  snakes.forEach(s => {
    if (!s.body || s.body.length === 0) return;
    const baseRadius = Math.min(18, 9 + Math.floor(s.body.length / 10));

    // 1. Floor drop shadow for 3D elevation
    ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
    for (let i = s.body.length - 1; i >= 0; i--) {
      const seg = s.body[i];
      ctx.beginPath();
      ctx.arc(seg.x + 4, seg.y + 7, baseRadius * 0.92, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 3D lit body spheres
    for (let i = s.body.length - 1; i >= 0; i--) {
      const seg = s.body[i];
      const r = i === 0 ? baseRadius * 1.12 : baseRadius * (0.78 + 0.22 * (1 - i / s.body.length));
      const grad = ctx.createRadialGradient(seg.x - r * 0.35, seg.y - r * 0.35, r * 0.1, seg.x, seg.y, r);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.28, s.color || "#6366f1");
      grad.addColorStop(1, "#111827");

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(seg.x, seg.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Directional Eyes & Nameplate on Head
    const head = s.body[0];
    const ang = s.angle || 0;
    const eyeOffset = baseRadius * 0.55;
    const lx = head.x + Math.cos(ang - 0.55) * eyeOffset;
    const ly = head.y + Math.sin(ang - 0.55) * eyeOffset;
    const rx = head.x + Math.cos(ang + 0.55) * eyeOffset;
    const ry = head.y + Math.sin(ang + 0.55) * eyeOffset;

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(lx, ly, 3.6, 0, Math.PI * 2);
    ctx.arc(rx, ry, 3.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(lx + Math.cos(ang) * 1.3, ly + Math.sin(ang) * 1.3, 1.8, 0, Math.PI * 2);
    ctx.arc(rx + Math.cos(ang) * 1.3, ry + Math.sin(ang) * 1.3, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${s.username} (${s.body.length})`, head.x, head.y - baseRadius - 8);
  });
}

// ============================================================================
// 6. STICKMAN SHADOW FIGHT RENDERER (Dojo Sunset + Articulated Martial Arts)
// ============================================================================
function renderShadowFightArena(fighters, effects = []) {
  // Sunset Crimson/Gold Dojo Sky
  const sky = ctx.createLinearGradient(0, 0, 0, 440);
  sky.addColorStop(0, "#1a091e");
  sky.addColorStop(0.45, "#6b1426");
  sky.addColorStop(0.85, "#d97706");
  sky.addColorStop(1, "#fbbf24");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, 440);

  // Glowing Sun Disc
  ctx.fillStyle = "rgba(254, 240, 138, 0.85)";
  ctx.beginPath();
  ctx.arc(480, 295, 95, 0, Math.PI * 2);
  ctx.fill();

  // Silhouette Pagoda Pillars & Bamboo
  ctx.fillStyle = "#090a0f";
  ctx.fillRect(70, 80, 26, 360);
  ctx.fillRect(864, 80, 26, 360);
  ctx.fillRect(0, 440, canvas.width, 100);

  // Tatami Floor Rim Highlight
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 440);
  ctx.lineTo(canvas.width, 440);
  ctx.stroke();

  const now = Date.now() / 1000;

  fighters.forEach(f => {
    const dir = f.facing || 1;
    const x = f.x;
    const y = f.y;

    // Health Bar & Nameplate above fighter
    const barW = 74;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x - barW / 2, y - 122, barW, 8);
    ctx.fillStyle = f.hp > 35 ? "#10b981" : "#ef4444";
    ctx.fillRect(x - barW / 2, y - 122, (Math.max(0, f.hp) / 100) * barW, 8);

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(f.username, x, y - 128);

    // Stickman Joint Articulation
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const walkCycle = f.state === "walk" ? Math.sin(now * 14) * 14 : 0;
    const hipX = x;
    const hipY = y - 42;
    const shoulderX = x + (f.state === "slash" ? dir * 8 : 0);
    const shoulderY = y - 78;
    const headX = shoulderX + dir * 2;
    const headY = shoulderY - 16;

    // Flowing Colored Headband
    ctx.strokeStyle = f.color || "#ef4444";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(headX - dir * 8, headY - 3);
    ctx.quadraticCurveTo(
      headX - dir * 24,
      headY + Math.sin(now * 12) * 8,
      headX - dir * 36,
      headY + 6
    );
    ctx.stroke();

    // Pure Shadow Body Silhouette
    ctx.strokeStyle = "#050608";
    ctx.fillStyle = "#050608";
    ctx.lineWidth = 7;

    // Torso
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(shoulderX, shoulderY);
    ctx.stroke();

    // Head + Glowing Eyes
    ctx.beginPath();
    ctx.arc(headX, headY, 11, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = f.color || "#f59e0b";
    ctx.beginPath();
    ctx.arc(headX + dir * 5, headY - 2, 2.3, 0, Math.PI * 2);
    ctx.fill();

    // Legs (with High Kick Pose)
    ctx.strokeStyle = "#050608";
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(hipX - dir * 12 + walkCycle, y);
    ctx.moveTo(hipX, hipY);
    if (f.state === "kick") {
      ctx.lineTo(hipX + dir * 48, hipY - 14);
    } else {
      ctx.lineTo(hipX + dir * 12 - walkCycle, y);
    }
    ctx.stroke();

    // Arms & Shadow Katana Slash
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    if (f.state === "punch") {
      ctx.lineTo(shoulderX + dir * 44, shoulderY - 2);
    } else if (f.state === "block") {
      ctx.lineTo(shoulderX + dir * 16, shoulderY - 18);
    } else if (f.state === "slash") {
      const handX = shoulderX + dir * 34;
      const handY = shoulderY - 8;
      ctx.lineTo(handX, handY);
      ctx.stroke();

      // Glowing Shadow Katana Blade & Arc
      ctx.strokeStyle = f.color || "#a855f7";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(handX, handY);
      ctx.lineTo(handX + dir * 52, handY - 18);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(shoulderX, shoulderY, 68, dir > 0 ? -0.7 : 2.3, dir > 0 ? 0.5 : 3.7);
      ctx.stroke();
    } else {
      ctx.lineTo(shoulderX + dir * 18, shoulderY + 14);
      ctx.stroke();
    }

    // Shield Aura when Blocking
    if (f.state === "block") {
      ctx.strokeStyle = "rgba(59, 130, 246, 0.75)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y - 55, 42, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  });

  // Hit Sparks
  effects.forEach(ef => {
    ctx.save();
    ctx.fillStyle = ef.color || "#fbbf24";
    ctx.beginPath();
    ctx.arc(ef.x, ef.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// ============================================================================
// 7. PC KEYBOARD & MOBILE TOUCH CONTROLS (Joystick + Action Buttons)
// ============================================================================
const btnToggleMobile = document.getElementById("btnToggleMobile");
btnToggleMobile.onclick = () => {
  state.mobileControls = !state.mobileControls;
  updateMobileControlsUI();
};

function updateMobileControlsUI() {
  btnToggleMobile.textContent = `Mobile Controls: ${state.mobileControls ? "ON" : "OFF"}`;
  const overlay = document.getElementById("mobileControlsOverlay");
  const isActionMode = state.mode === "snake" || state.mode === "shadow";
  overlay.classList.toggle("hidden", !(state.mobileControls && isActionMode));

  document.getElementById("btnTouchBoost").classList.toggle("hidden", state.mode !== "snake");
  document.getElementById("shadowTouchCluster").classList.toggle("hidden", state.mode !== "shadow");
}

// Virtual Thumb Joystick Logic
const joystickZone = document.getElementById("joystickZone");
const joystickStick = document.getElementById("joystickStick");
let joyActive = false;

joystickZone.addEventListener("pointerdown", (e) => {
  joyActive = true;
  handleJoystickMove(e);
});
window.addEventListener("pointermove", (e) => {
  if (joyActive) handleJoystickMove(e);
});
window.addEventListener("pointerup", () => {
  if (!joyActive) return;
  joyActive = false;
  joystickStick.style.transform = `translate(0px, 0px)`;
  if (state.mode === "shadow") {
    sendPacket("shadowInput", { moveX: 0 });
  }
});

function handleJoystickMove(e) {
  const rect = document.getElementById("joystickBase").getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  const dist = Math.min(36, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);

  joystickStick.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;

  if (state.mode === "snake") {
    sendPacket("snakeInput", { angle });
  } else if (state.mode === "shadow") {
    const moveX = Math.abs(dx) > 10 ? Math.sign(dx) : 0;
    sendPacket("shadowInput", { moveX, jump: dy < -24 });
  }
}

// Touch Action Buttons for Snake & Shadow Fight
const btnTouchBoost = document.getElementById("btnTouchBoost");
btnTouchBoost.addEventListener("pointerdown", () => sendPacket("snakeInput", { boost: true }));
btnTouchBoost.addEventListener("pointerup", () => sendPacket("snakeInput", { boost: false }));

document.querySelectorAll("#shadowTouchCluster .touch-btn").forEach(btn => {
  btn.addEventListener("pointerdown", () => {
    const act = btn.dataset.action;
    if (act === "jump") sendPacket("shadowInput", { jump: true });
    else sendPacket("shadowInput", { action: act });
  });
});

// PC Keyboard Controls for Snake.io & Stickman Shadow Fight
window.addEventListener("keydown", (e) => {
  if (document.activeElement === document.getElementById("chatInput") ||
      document.activeElement === document.getElementById("garticSentenceInput")) {
    return;
  }

  if (state.mode === "snake") {
    const angleMap = {
      ArrowUp: -Math.PI / 2, KeyW: -Math.PI / 2,
      ArrowDown: Math.PI / 2, KeyS: Math.PI / 2,
      ArrowLeft: Math.PI, KeyA: Math.PI,
      ArrowRight: 0, KeyD: 0
    };
    if (angleMap[e.code] !== undefined) {
      sendPacket("snakeInput", { angle: angleMap[e.code] });
    }
    if (e.code === "Space") {
      sendPacket("snakeInput", { boost: true });
    }
  } else if (state.mode === "shadow") {
    if (e.code === "KeyA" || e.code === "ArrowLeft") sendPacket("shadowInput", { moveX: -1 });
    if (e.code === "KeyD" || e.code === "ArrowRight") sendPacket("shadowInput", { moveX: 1 });
    if (e.code === "KeyW" || e.code === "ArrowUp") sendPacket("shadowInput", { jump: true });
    if (e.code === "KeyJ") sendPacket("shadowInput", { action: "punch" });
    if (e.code === "KeyK") sendPacket("shadowInput", { action: "kick" });
    if (e.code === "KeyL") sendPacket("shadowInput", { action: "slash" });
    if (e.code === "Space" || e.code === "KeyS") sendPacket("shadowInput", { action: "block" });
  }
});

window.addEventListener("keyup", (e) => {
  if (state.mode === "snake" && e.code === "Space") {
    sendPacket("snakeInput", { boost: false });
  } else if (state.mode === "shadow") {
    if (["KeyA", "ArrowLeft", "KeyD", "ArrowRight"].includes(e.code)) {
      sendPacket("shadowInput", { moveX: 0 });
    }
  }
});

// ============================================================================
// 8. GARTIC CHAIN, ROSTER & CHAT
// ============================================================================
document.getElementById("btnGarticSubmitText").onclick = () => {
  const input = document.getElementById("garticSentenceInput");
  const text = input.value.trim();
  if (!text) return;
  sendPacket("garticEntry", { entryType: "text", prompt: text });
  input.value = "";
  document.getElementById("garticStepTitle").textContent = "Submitted! Waiting for chain...";
};

document.getElementById("btnSubmitDrawing").onclick = () => {
  const dataUrl = canvas.toDataURL("image/png");
  sendPacket("garticEntry", { entryType: "drawing", imageDataUrl: dataUrl });
  document.getElementById("garticPanel").classList.remove("hidden");
  document.getElementById("garticStepTitle").textContent = "Drawing submitted!";
};

function handleGarticPhase(msg) {
  const panel = document.getElementById("garticPanel");
  const banner = document.getElementById("garticTargetPrompt");

  if (msg.phase === "draw") {
    panel.classList.add("hidden");
    clearCanvasBoard(false);
    state.canDraw = true;
    document.getElementById("hudRole").textContent = `Draw this: "${msg.promptToDraw}"`;
  } else {
    panel.classList.remove("hidden");
    document.getElementById("garticStepTitle").textContent = msg.title || "Write a sentence or interpretation";
    if (msg.previousImage) {
      banner.innerHTML = `<img src="${msg.previousImage}" style="max-height:150px;background:#fff;border-radius:6px;" />`;
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
  document.getElementById("garticStepTitle").textContent = "Gartic Chain Album — Download Your Favorites!";
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
      dl.textContent = "Save PNG";
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

function renderRoster() {
  const container = document.getElementById("playerRoster");
  container.innerHTML = "";
  state.players.forEach(p => {
    const isRoomHost = p.username.toLowerCase() === state.hostUsername.toLowerCase();
    const item = document.createElement("div");
    item.className = "player-item";
    item.innerHTML = `
      <div class="player-left">
        <div class="avatar-circle" style="background:${p.color || "#6366f1"};width:22px;height:22px;font-size:11px;">
          ${p.username.charAt(0).toUpperCase()}
        </div>
        <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${isRoomHost ? "👑 " : ""}${p.username}
        </span>
        ${p.isAI ? `<span class="ai-pill">${p.aiLabel || "AI"}</span>` : ""}
      </div>
      <div style="display:flex;align-items:center;gap:5px;">
        ${state.mode === "hangman" ? `<span class="team-badge team-${p.team}">T-${p.team}</span>` : ""}
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
