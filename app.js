// ============================================================================
// ENCLAVE ARCADE — LIVE MULTIPLAYER CLIENT (app.js)
// Includes Fixed Chat Ledger, 2D 1v1 Tournament Shadow Fight & Medium Seance
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
  canDraw: false,
  salemTarget: ""
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
    const res = await fetch(`${RENDER_SERVER_URL}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: state.authMode, username, password, color }) }); const data = await res.json();  if (!data.ok) { authError.textContent = data.error \vert{}\vert{} "Login failed"; return; }  state.me.username = data.user.username; state.me.color = data.user.color \vert{}\vert{} color; state.me.wins = data.user.wins \vert{}\vert{} 0; state.room = room;  finishLogin(); } catch (err) { state.me.username = username; state.me.color = color; state.room = room; finishLogin(); } };  function finishLogin() { document.getElementById("myUsername").textContent = state.me.username; document.getElementById("myTotalWins").textContent = `${state.me.wins} Wins`;
  const badge = document.getElementById("myBadge");
  badge.textContent = state.me.username.charAt(0).toUpperCase();
  badge.style.background = state.me.color;
  document.getElementById("roomBadge").textContent = `Room: ${state.room}`; document.getElementById("authModal").classList.add("hidden");  updateMobileControlsUI(); connectWebSocket(); }  // ============================================================================ // 2. WEBSOCKET CONNECTION & SERVER SYNC // ============================================================================ let ws = null;  function connectWebSocket() { const dot = document.getElementById("connStatus"); ws = new WebSocket(WS_URL);  ws.onopen = () => { dot.classList.remove("offline"); dot.classList.add("online"); sendPacket("join", { roomId: state.room, player: state.me }); };  ws.onclose = () => { dot.classList.remove("online"); dot.classList.add("offline"); setTimeout(connectWebSocket, 3500); };  ws.onmessage = (event) => { const msg = JSON.parse(event.data); handleServerPacket(msg); }; }  function sendPacket(type, payload = {}) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type, ...payload })); } }  function handleServerPacket(msg) { switch (msg.type) { case "roster": state.players = msg.players \vert{}\vert{} []; state.hostUsername = msg.hostUsername \vert{}\vert{} ""; state.isHost = state.me.username.toLowerCase() === state.hostUsername.toLowerCase(); updateHostPermissionsUI(); renderRoster(); break;  case "modeSync": applyModeUI(msg.mode, msg.settings); break;  case "stroke": if (state.mode === "skribbl" \vert{}\vert{} state.mode === "hangman" \vert{}\vert{} state.mode === "gartic") { drawSegment(msg.x0, msg.y0, msg.x1, msg.y1, msg.color, msg.size, false); } break;  case "clearCanvas": clearCanvasBoard(false); break;  case "roundState": document.getElementById("hudWordMask").textContent = msg.maskedWord \vert{}\vert{} "_ _ _ _ _"; document.getElementById("hudRound").textContent = `Round ${msg.round} / ${msg.maxRounds}`; document.getElementById("hudRole").textContent = msg.roleText \vert{}\vert{} ""; state.canDraw = Boolean(msg.canDraw); if (msg.hangmanLeft !== undefined) { document.getElementById("hudChancesLeft").textContent = `${msg.hangmanLeft} / ${msg.hangmanMax}`; } break;  case "timer": document.getElementById("hudTimer").textContent = `${msg.timeLeft}s`;
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
        render3DSnakeArena(msg.snakes, msg.orbs, msg.worldW || 3200, msg.worldH || 3200);
      }
      break;

    case "shadowTick":
      if (state.mode === "shadow") {
        renderShadowFightArena(msg.fighters, msg.effects, msg.bracket);
      }
      break;

    case "salemState":
      if (state.mode === "salem") {
        renderSalemState(msg);
      }
      break;
  }
}

// ============================================================================
// 3. HOST LOCKING & MODE SWITCHING
// ============================================================================
function updateHostPermissionsUI() {
  const hostBadge = document.getElementById("hostBadge");
  hostBadge.textContent = state.isHost
    ? "👑 You are Room Host"
    : `👑 Host: ${state.hostUsername \vert{}\vert{} "None"}`;  const settingsPanel = document.getElementById("hostSettingsPanel"); settingsPanel.classList.toggle("locked-panel", !state.isHost);  const controls = [ "setDrawTime", "setRounds", "setHangmanChances", "setDifficulty", "setAiCount", "setAiTier", "setSalemAiStyle", "btnStartMatch" ]; controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !state.isHost; });  document.querySelectorAll(".mode-tab").forEach(tab => { tab.classList.toggle("locked-tab", !state.isHost); tab.title = state.isHost ? "Switch Game Mode" : "Only the Room Host can switch game modes"; }); }  function applyModeUI(newMode, settings) { state.mode = newMode; state.drawing = false;  document.querySelectorAll(".mode-tab").forEach(b => { b.classList.toggle("active", b.dataset.mode === newMode); });  if (settings) { document.getElementById("setDrawTime").value = settings.drawTime \vert{}\vert{} 75; document.getElementById("setRounds").value = settings.rounds \vert{}\vert{} 3; document.getElementById("setHangmanChances").value = settings.hangmanMaxGuesses \vert{}\vert{} 10; document.getElementById("setDifficulty").value = settings.difficulty \vert{}\vert{} "ALL"; if (settings.aiCount !== undefined) document.getElementById("setAiCount").value = String(settings.aiCount); if (settings.aiTier) document.getElementById("setAiTier").value = settings.aiTier; if (settings.salemAiStyle) document.getElementById("setSalemAiStyle").value = settings.salemAiStyle; }  const hideToolbar = newMode === "snake" \vert{}\vert{} newMode === "shadow" \vert{}\vert{} newMode === "salem"; document.getElementById("hudHangmanBox").classList.toggle("hidden", newMode !== "hangman"); document.getElementById("btnSwitchTeam").classList.toggle("hidden", newMode !== "hangman"); document.getElementById("drawToolbar").classList.toggle("hidden", hideToolbar); document.getElementById("garticPanel").classList.toggle("hidden", newMode !== "gartic"); document.getElementById("salemPanel").classList.toggle("hidden", newMode !== "salem"); document.getElementById("btnSubmitDrawing").classList.toggle("hidden", newMode !== "gartic");  const chatInput = document.getElementById("chatInput"); chatInput.disabled = false; chatInput.placeholder = "Type a guess, claim, or suspicion..."; document.getElementById("chatHeaderTitle").textContent = "Live Guesses & Town Ledger";  clearCanvasBoard(false);  if (newMode === "snake") { document.getElementById("hudWordMask").textContent = "3D SNAKE.IO"; document.getElementById("hudRole").textContent = "3200x3200 Arena — Check the top-right Mini-Map!"; document.getElementById("hudTimer").textContent = "ENDLESS"; } else if (newMode === "shadow") { document.getElementById("hudWordMask").textContent = "1V1 DOJO TOURNAMENT"; document.getElementById("hudRole").textContent = "A/D(Move) W(Jump) J(Jab) K(Kick) L(Katana) S/Space(Guard)"; document.getElementById("hudTimer").textContent = "BRACKET"; } else if (newMode === "salem") { document.getElementById("hudWordMask").textContent = "VILLAGE OF SALEM"; document.getElementById("hudRole").textContent = "Medium seances every 3rd Night; Mayor can reveal for 3x vote!"; }  updateMobileControlsUI(); }  document.querySelectorAll(".mode-tab").forEach(btn => { btn.onclick = () => { if (!state.isHost) { appendChatMessage("System", "Only the Room Host can switch the active game mode.", "system"); return; } sendPacket("switchMode", { mode: btn.dataset.mode }); }; });  document.getElementById("btnStartMatch").onclick = () => { if (!state.isHost) return; const settings = { mode: state.mode, drawTime: Number(document.getElementById("setDrawTime").value) \vert{}\vert{} 75, rounds: Number(document.getElementById("setRounds").value) \vert{}\vert{} 3, hangmanMaxGuesses: Number(document.getElementById("setHangmanChances").value) \vert{}\vert{} 10, difficulty: document.getElementById("setDifficulty").value, aiCount: Number(document.getElementById("setAiCount").value) \vert{}\vert{} 0, aiTier: document.getElementById("setAiTier").value \vert{}\vert{} "medium", salemAiStyle: document.getElementById("setSalemAiStyle").value \vert{}\vert{} "deductive" }; sendPacket("startGame", { settings }); };  document.getElementById("btnSwitchTeam").onclick = () => { sendPacket("swapTeam"); };  // ============================================================================ // 4. CANVAS DRAWING & PNG SAVING // ============================================================================ const canvas = document.getElementById("arcadeCanvas"); const ctx = canvas.getContext("2d"); clearCanvasBoard(false);  const colors = [ "#000000", "#ffffff", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#6366f1", "#ec4899", "#78350f" ]; const paletteEl = document.getElementById("colorPalette");  colors.forEach((hex, i) => { const sw = document.createElement("div"); sw.className = "color-swatch" + (i === 0 ? " active" : ""); sw.style.background = hex; sw.onclick = () => { state.brushColor = hex; document.querySelectorAll(".color-swatch").forEach(el => el.classList.remove("active")); sw.classList.add("active"); }; paletteEl.appendChild(sw); });  let prevPt = { x: 0, y: 0 };  function getCanvasPoint(e) { const rect = canvas.getBoundingClientRect(); return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) }; }  canvas.addEventListener("pointerdown", (e) => { if (state.mode !== "skribbl" && state.mode !== "hangman" && state.mode !== "gartic") return; if (!state.canDraw) return; state.drawing = true; prevPt = getCanvasPoint(e); });  canvas.addEventListener("pointermove", (e) => { const pt = getCanvasPoint(e);  if (state.mode === "snake" && !state.mobileControls) { const angle = Math.atan2(pt.y - 270, pt.x - 480); sendPacket("snakeInput", { angle }); return; }  if (!state.drawing \vert{}\vert{} !state.canDraw) return; if (state.mode !== "skribbl" && state.mode !== "hangman" && state.mode !== "gartic") return; drawSegment(prevPt.x, prevPt.y, pt.x, pt.y, state.brushColor, state.brushSize, true); prevPt = pt; });  window.addEventListener("pointerup", () => { state.drawing = false; });  function drawSegment(x0, y0, x1, y1, color, size, emit) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = "round"; ctx.stroke();  if (emit) { sendPacket("stroke", { x0, y0, x1, y1, color, size }); } }  function clearCanvasBoard(emit = true) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); if (emit) sendPacket("clearCanvas"); }  document.getElementById("brushSize").oninput = (e) => { state.brushSize = Number(e.target.value); }; document.getElementById("btnEraser").onclick = () => { state.brushColor = "#ffffff"; }; document.getElementById("btnClearCanvas").onclick = () => { if (state.canDraw) clearCanvasBoard(true); }; document.getElementById("btnDownloadPng").onclick = () => { const link = document.createElement("a"); link.download = `enclave-arcade-${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
};

// ============================================================================
// 5. 3200x3200 CAMERA SNAKE.IO RENDERER + SECTOR MINI-MAP
// ============================================================================
function render3DSnakeArena(snakes, orbs, worldW, worldH) {
  ctx.fillStyle = "#0b0d14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const mySnake = snakes.find(s => s.username.toLowerCase() === state.me.username.toLowerCase()) || snakes[0];
  const camX = mySnake && mySnake.body.length > 0 ? mySnake.body[0][0] : worldW / 2;
  const camY = mySnake && mySnake.body.length > 0 ? mySnake.body[0][1] : worldH / 2;

  ctx.save();
  ctx.translate(canvas.width / 2 - camX, canvas.height / 2 - camY);

  ctx.fillStyle = "#121624";
  ctx.fillRect(0, 0, worldW, worldH);

  ctx.strokeStyle = "rgba(99, 102, 241, 0.14)";
  ctx.lineWidth = 1;
  const startGridX = Math.floor((camX - 550) / 80) * 80;
  const endGridX = Math.min(worldW, camX + 550);
  const startGridY = Math.floor((camY - 350) / 80) * 80;
  const endGridY = Math.min(worldH, camY + 350);

  for (let x = Math.max(0, startGridX); x <= endGridX; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, Math.max(0, startGridY));
    ctx.lineTo(x, endGridY);
    ctx.stroke();
  }
  for (let y = Math.max(0, startGridY); y <= endGridY; y += 80) {
    ctx.beginPath();
    ctx.moveTo(Math.max(0, startGridX), y);
    ctx.lineTo(endGridX, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, worldW, worldH);

  orbs.forEach(o => {
    if (Math.abs(o.x - camX) > 540 || Math.abs(o.y - camY) > 330) return;
    const r = o.r || 6;
    const orbGrad = ctx.createRadialGradient(o.x - r * 0.3, o.y - r * 0.3, 1, o.x, o.y, r);
    orbGrad.addColorStop(0, "#ffffff");
    orbGrad.addColorStop(0.45, o.c || "#fbbf24");
    orbGrad.addColorStop(1, "#78350f");
    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
    ctx.fill();
  });

  snakes.forEach(s => {
    if (!s.body || s.body.length === 0) return;
    const baseRadius = Math.min(15, 9.5 + Math.min(5.5, (s.mass || 60) / 180));

    ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
    for (let i = s.body.length - 1; i >= 0; i--) {
      const [sx, sy] = s.body[i];
      if (Math.abs(sx - camX) > 560 || Math.abs(sy - camY) > 350) continue;
      ctx.beginPath();
      ctx.arc(sx + 4, sy + 6, baseRadius * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = s.body.length - 1; i >= 0; i--) {
      const [sx, sy] = s.body[i];
      if (Math.abs(sx - camX) > 560 || Math.abs(sy - camY) > 350) continue;
      const r = i === 0 ? baseRadius * 1.1 : baseRadius * (0.82 + 0.18 * (1 - i / s.body.length));
      const grad = ctx.createRadialGradient(sx - r * 0.35, sy - r * 0.35, 1, sx, sy, r);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.3, s.color || "#6366f1");
      grad.addColorStop(1, "#111827");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const [hx, hy] = s.body[0];
    if (Math.abs(hx - camX) <= 560 && Math.abs(hy - camY) <= 350) {
      const ang = s.angle || 0;
      const eyeDist = baseRadius * 0.55;
      const lx = hx + Math.cos(ang - 0.55) * eyeDist;
      const ly = hy + Math.sin(ang - 0.55) * eyeDist;
      const rx = hx + Math.cos(ang + 0.55) * eyeDist;
      const ry = hy + Math.sin(ang + 0.55) * eyeDist;

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(lx, ly, 3.3, 0, Math.PI * 2);
      ctx.arc(rx, ry, 3.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${s.username} (${s.mass || 60})`, hx, hy - baseRadius - 8);
    }
  });

  ctx.restore();

  // Sector Mini-Map
  const mapSize = 136;
  const mapX = canvas.width - mapSize - 14;
  const mapY = 14;

  ctx.fillStyle = "rgba(15, 17, 22, 0.84)";
  ctx.strokeStyle = "rgba(99, 102, 241, 0.6)";
  ctx.lineWidth = 2;
  ctx.fillRect(mapX, mapY, mapSize, mapSize);
  ctx.strokeRect(mapX, mapY, mapSize, mapSize);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const step = (mapSize / 4) * i;
    ctx.beginPath();
    ctx.moveTo(mapX + step, mapY);
    ctx.lineTo(mapX + step, mapY + mapSize);
    ctx.moveTo(mapX, mapY + step);
    ctx.lineTo(mapX + mapSize, mapY + step);
    ctx.stroke();
  }

  const vw = (canvas.width / worldW) * mapSize;
  const vh = (canvas.height / worldH) * mapSize;
  const vx = mapX + ((camX - canvas.width / 2) / worldW) * mapSize;
  const vy = mapY + ((camY - canvas.height / 2) / worldH) * mapSize;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.strokeRect(vx, vy, vw, vh);

  snakes.forEach(s => {
    if (!s.body || s.body.length === 0) return;
    const [hx, hy] = s.body[0];
    const mx = mapX + (hx / worldW) * mapSize;
    const my = mapY + (hy / worldH) * mapSize;
    const isMe = mySnake && s.username === mySnake.username;

    ctx.fillStyle = isMe ? "#ffffff" : (s.color || "#6366f1");
    ctx.beginPath();
    ctx.arc(mx, my, isMe ? 4 : 2.8, 0, Math.PI * 2);
    ctx.fill();
  });

  const colChar = ["A", "B", "C", "D"][Math.min(3, Math.floor((camX / worldW) * 4))];
  const rowNum = Math.min(4, Math.floor((camY / worldH) * 4) + 1);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "700 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`SECTOR ${colChar}${rowNum}`, mapX + 6, mapY + mapSize - 6);
}

// ============================================================================
// 6. VILLAGE OF SALEM (MEDIUM SEANCE, MAYOR, EXECUTIONER, BODYGUARD, GRAVEYARD)
// ============================================================================
document.getElementById("btnSaveWill").onclick = () => {
  const val = document.getElementById("salemWillInput").value.trim();
  sendPacket("salemWill", { willText: val });
  appendChatMessage("Last Will", "Your Last Will has been saved in secret.", "system");
};

document.getElementById("btnBomberDetonate").onclick = () => {
  state.salemTarget = "DETONATE";
  sendPacket("salemAction", { target: "DETONATE" });
};

document.getElementById("btnMayorReveal").onclick = () => {
  sendPacket("salemMayorReveal");
};

function renderSalemState(msg) {
  const panel = document.getElementById("salemPanel");
  panel.classList.remove("hidden");

  const moonIcon = msg.fullMoon ? "🌕 FULL MOON " : "";
  const seanceIcon = msg.seanceNight ? "🔮 SEANCE NIGHT " : "";
  document.getElementById("salemPhaseTitle").textContent =
    `Day ${msg.day} —${moonIcon}${seanceIcon}${msg.phase.toUpperCase()} PHASE`;
  document.getElementById("salemInstruction").textContent = msg.instruction || "";
  document.getElementById("salemReportBanner").textContent = msg.report || "";

  const badge = document.getElementById("salemMyRoleBadge");
  const roleLabel = msg.myRole === "PlagueDoctor" ? "Plague Doctor" : msg.myRole;
  badge.textContent = `Role: ${roleLabel}${msg.extraStatus ? ` (${msg.extraStatus})` : ""}`;
  badge.className = `salem-role-badge role-${msg.myRole}`;  // Configure Right Chat Bar for Medium Seance, Mafia Night Chat, or Ghost Chat const chatInput = document.getElementById("chatInput"); const chatHeader = document.getElementById("chatHeaderTitle"); const isMafia = ["Godfather", "Killer", "Consigliere"].includes(msg.myRole); const isMediumSeance = msg.myRole === "Medium" && msg.seanceNight && msg.phase === "night";  if (!msg.amAlive) { chatInput.disabled = false; chatInput.placeholder = msg.seanceNight && msg.phase === "night" ? "🔮 Seance Active: The living Medium can hear you tonight!" : "👻 Dead Chat: Only fallen players can hear you..."; chatHeader.textContent = msg.seanceNight && msg.phase === "night" ? "🔮 Medium Seance & Ghost Channel" : "👻 Graveyard Ghost Chat"; } else if (msg.phase === "night") { if (isMafia) { chatInput.disabled = false; chatInput.placeholder = "🩸 Mafia Night Chat: Whisper to your Mafia partners..."; chatHeader.textContent = "🩸 Private Mafia Night Channel"; } else if (isMediumSeance) { chatInput.disabled = false; chatInput.placeholder = "🔮 Seance Open: Speak with the Graveyard ghosts tonight!"; chatHeader.textContent = "🔮 Medium Seance Channel (Every 3rd Night)"; } else { chatInput.disabled = true; chatInput.placeholder = "🌙 Town is sleeping (Public chat muted until dawn)..."; chatHeader.textContent = "🌙 Night Phase (Town Sleeping)"; } } else { chatInput.disabled = false; chatInput.placeholder = "Type your role claim, Last Will, or suspicion..."; chatHeader.textContent = "☀️ Town Square Day Ledger"; }  // Mayor Reveal Button const mayorBtn = document.getElementById("btnMayorReveal"); mayorBtn.classList.toggle( "hidden", !(msg.amAlive && msg.myRole === "Mayor" && !msg.mayorRevealed && msg.phase !== "night") );  // Bomber Detonate Button const detonateBtn = document.getElementById("btnBomberDetonate"); detonateBtn.classList.toggle( "hidden", !(msg.amAlive && msg.phase === "night" && msg.myRole === "Bomber" && msg.plantedCount > 0) ); if (msg.plantedCount > 0) { detonateBtn.textContent = `💥 Detonate (${msg.plantedCount})`;
  }

  const skipBtn = document.getElementById("btnSalemSkipVote");
  skipBtn.classList.toggle("hidden", msg.phase !== "voting" || !msg.amAlive);
  skipBtn.onclick = () => {
    state.salemTarget = "SKIP";
    sendPacket("salemAction", { target: "SKIP" });
  };

  // 1. Render Town Player Cards
  const grid = document.getElementById("salemTownGrid");
  grid.innerHTML = "";

  (msg.town || []).forEach(p => {
    const card = document.createElement("div");
    card.className = "salem-card" +
      (!p.alive ? " dead" : "") +
      (state.salemTarget === p.username ? " selected-target" : "");

    const roleInfo = !p.alive
      ? `<span style="font-size:11px;color:#fca5a5;">💀 ${p.revealedRole || "Fallen"}</span>`
      : `<span style="font-size:11px;color:var(--text-dim);">Alive</span>`;

    const voteCount = msg.votes && msg.votes[p.username]
      ? `${msg.votes[p.username]} Vote(s)`
      : "";

    let tagsHtml = "";
    if (p.isMafiaMate) tagsHtml += `<span class="mini-tag tag-mafia">🩸 Mafia</span>`;
    if (p.mayorRevealed) tagsHtml += `<span class="mini-tag tag-mayor">🎖️ Mayor (3x)</span>`;
    if (p.isExecTarget) tagsHtml += `<span class="mini-tag tag-exec">🎯 Your Target</span>`;
    if (p.hasBomb) tagsHtml += `<span class="mini-tag tag-bomb">💣 Rigged</span>`;
    if (p.isInfected) tagsHtml += `<span class="mini-tag tag-plague">☣️ Infected</span>`;

    card.innerHTML = `
      <div class="avatar-circle" style="background:${p.color || "#6366f1"};width:30px;height:30px;font-size:12px;">
        ${p.username.charAt(0).toUpperCase()}
      </div>
      <div style="font-weight:700;font-size:12px;">${p.username}</div>${roleInfo}
      <div class="salem-tag-row">${tagsHtml}</div>
      <div class="salem-votes">${voteCount}</div>
    `;

    if (msg.amAlive && p.alive && msg.canAct) {
      const canTargetSelf = msg.myRole === "Doctor" && msg.phase === "night";
      const isFellowMafiaAtNight = isMafia && p.isMafiaMate && msg.phase === "night" && msg.myRole !== "Consigliere";

      if ((p.username !== state.me.username || canTargetSelf) && !isFellowMafiaAtNight) {
        const btn = document.createElement("button");
        btn.className = "btn-primary full-width";
        btn.textContent = msg.actionLabel || "Select";
        btn.onclick = () => {
          state.salemTarget = p.username;
          sendPacket("salemAction", { target: p.username });
          document.querySelectorAll(".salem-card").forEach(c => c.classList.remove("selected-target"));
          card.classList.add("selected-target");
        };
        card.appendChild(btn);
      }
    }

    grid.appendChild(card);
  });

  // 2. Render Live Graveyard Role List & Last Wills
  const graveList = document.getElementById("salemGraveyardList");
  const graveBadge = document.getElementById("graveCountBadge");
  const graves = msg.graveyard || [];
  graveBadge.textContent = `${graves.length} Fallen`;

  if (graves.length === 0) {
    graveList.innerHTML = `<div style="font-size:11px;color:var(--text-dim);font-style:italic;">No casualties yet.</div>`;
  } else {
    graveList.innerHTML = "";
    graves.forEach(g => {
      const entry = document.createElement("div");
      entry.className = "grave-entry";
      const dispRole = g.role === "PlagueDoctor" ? "Plague Doctor" : g.role;
      entry.innerHTML = `
        <div class="grave-header">
          <span>💀 ${g.username}</span>
          <span class="salem-role-badge role-${g.role}" style="font-size:9px;padding:2px 6px;">${dispRole}</span>
        </div>
        <div style="font-size:10px;color:var(--text-dim);">Day ${g.day}:${g.cause}</div>
        <div class="grave-will">📜 ${g.willText || "No Last Will left behind."}</div>
      `;
      graveList.appendChild(entry);
    });
  }
}

// ============================================================================
// 7. STICKMAN SHADOW FIGHT RENDERER (STILL 2D DOJO MAP + 1V1 BRACKET HUD)
// ============================================================================
function renderShadowFightArena(fighters = [], effects = [], bracket = null) {
  // Still 2D Traditional Dojo Backdrop
  const sky = ctx.createLinearGradient(0, 0, 0, 430);
  sky.addColorStop(0, "#140c1c");
  sky.addColorStop(0.5, "#4a1525");
  sky.addColorStop(1, "#c2410c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, 430);

  // Shoji Screen & Dojo Back Wall Panels (Crisp 2D Architectural Grid)
  ctx.fillStyle = "rgba(254, 215, 170, 0.12)";
  for (let i = 0; i < 6; i++) {
    const bx = 130 + i * 120;
    ctx.fillRect(bx, 130, 96, 260);
    ctx.strokeStyle = "#1f1218";
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, 130, 96, 260);
  }

  // Dojo Outer Pillars & 2D Arena Bounds (120px to 840px)
  ctx.fillStyle = "#090a0f";
  ctx.fillRect(90, 90, 28, 340);
  ctx.fillRect(842, 90, 28, 340);

  // Still 2D Wooden Tatami Mat Floor
  ctx.fillStyle = "#181216";
  ctx.fillRect(0, 430, canvas.width, 110);
  ctx.fillStyle = "#2b1d23";
  ctx.fillRect(90, 430, 780, 16);

  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(90, 430);
  ctx.lineTo(870, 430);
  ctx.stroke();

  // ==========================================================================
  // TOP 1V1 TOURNAMENT BRACKET HUD OVERLAY
  // ==========================================================================
  if (bracket) {
    ctx.fillStyle = "rgba(15, 17, 22, 0.88)";
    ctx.strokeStyle = "rgba(245, 158, 11, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(140, 12, 680, 68);
    ctx.strokeRect(140, 12, 680, 68);

    ctx.fillStyle = "#fbbf24";
    ctx.font = "800 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      `🏆 ${bracket.stageName.toUpperCase()} —${bracket.currentMatchLabel}`,
      480,
      32
    );

    ctx.fillStyle = "#e5e7eb";
    ctx.font = "600 11px sans-serif";
    ctx.fillText(bracket.queueSummary || "Winner advances to the next round!", 480, 52);

    ctx.fillStyle = "#9ca3af";
    ctx.font = "600 10px sans-serif";
    ctx.fillText(bracket.spectatorNote || "", 480, 69);
  }

  // Top Left & Right Street-Fighter / Shadow-Fight 1v1 Health Bars
  if (fighters.length >= 1) {
    const f1 = fighters[0];
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(140, 92, 280, 16);
    ctx.fillStyle = f1.hp > 30 ? "#10b981" : "#ef4444";
    ctx.fillRect(140, 92, (Math.max(0, f1.hp) / 100) * 280, 16);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.strokeRect(140, 92, 280, 16);

    ctx.fillStyle = "#ffffff";
    ctx.font = "800 12px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${f1.username} (${Math.max(0, f1.hp)} HP)`, 144, 104);
  }

  if (fighters.length >= 2) {
    const f2 = fighters[1];
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(540, 92, 280, 16);
    ctx.fillStyle = f2.hp > 30 ? "#10b981" : "#ef4444";
    const w2 = (Math.max(0, f2.hp) / 100) * 280;
    ctx.fillRect(540 + (280 - w2), 92, w2, 16);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.strokeRect(540, 92, 280, 16);

    ctx.fillStyle = "#ffffff";
    ctx.font = "800 12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${f2.username} (${Math.max(0, f2.hp)} HP)`, 816, 104);

    ctx.fillStyle = "#fbbf24";
    ctx.font = "900 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("VS", 480, 105);
  }

  // Render the 2 Active 1v1 Stickman Duelists with Paced Martial Arts Poses
  const now = Date.now() / 1000;

  fighters.forEach(f => {
    const dir = f.facing || 1;
    const x = f.x;
    const y = f.y;

    // Ground Shadow under stickman
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.ellipse(x, 432, 24, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const walkSwing = f.state === "walk" ? Math.sin(now * 9.5) * 13 : 0;
    const breathe = Math.sin(now * 4) * 2;
    const lean = f.state === "slash" ? dir * 12 : (f.state === "kick" ? -dir * 6 : (f.state === "hitstun" ? -dir * 10 : 0));

    const hipX = x;
    const hipY = y - 44 + breathe;
    const shoulderX = x + lean;
    const shoulderY = y - 82 + breathe;
    const headX = shoulderX + dir * 3;
    const headY = shoulderY - 16;

    // Flowing Headband
    ctx.strokeStyle = f.color || "#ef4444";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(headX - dir * 8, headY - 3);
    ctx.quadraticCurveTo(headX - dir * 24, headY + Math.sin(now * 10) * 6, headX - dir * 38, headY + 7);
    ctx.stroke();

    // Silhouette Stickman Limbs
    ctx.strokeStyle = f.state === "hitstun" ? "#ef4444" : "#050608";
    ctx.fillStyle = "#050608";
    ctx.lineWidth = 7.5;

    // Spine
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(shoulderX, shoulderY);
    ctx.stroke();

    // Head + Glowing Eye
    ctx.beginPath();
    ctx.arc(headX, headY, 11.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = f.color || "#fbbf24";
    ctx.beginPath();
    ctx.arc(headX + dir * 5, headY - 2, 2.4, 0, Math.PI * 2);
    ctx.fill();

    // Articulated Legs (Knee -> Foot)
    ctx.strokeStyle = f.state === "hitstun" ? "#ef4444" : "#050608";
    ctx.beginPath();
    // Back Leg
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(hipX - dir * 10 + walkSwing * 0.5, y - 20);
    ctx.lineTo(hipX - dir * 16 + walkSwing, y);
    // Front Leg (or High Martial Arts Kick)
    ctx.moveTo(hipX, hipY);
    if (f.state === "kick") {
      ctx.lineTo(hipX + dir * 26, hipY - 12);
      ctx.lineTo(hipX + dir * 54, hipY - 18);
    } else {
      ctx.lineTo(hipX + dir * 12 - walkSwing * 0.5, y - 20);
      ctx.lineTo(hipX + dir * 16 - walkSwing, y);
    }
    ctx.stroke();

    // Articulated Arms & Weapons
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    if (f.state === "punch") {
      ctx.lineTo(shoulderX + dir * 22, shoulderY - 2);
      ctx.lineTo(shoulderX + dir * 48, shoulderY - 4);
      ctx.stroke();
    } else if (f.state === "block") {
      ctx.lineTo(shoulderX + dir * 15, shoulderY + 6);
      ctx.lineTo(shoulderX + dir * 20, shoulderY - 18);
      ctx.stroke();
      ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + dir * 12, y - 56, 36, -1.1, 1.1);
      ctx.stroke();
    } else if (f.state === "slash") {
      const handX = shoulderX + dir * 32;
      const handY = shoulderY - 6;
      ctx.lineTo(handX, handY);
      ctx.stroke();

      // Shadow Katana Blade
      ctx.strokeStyle = f.color || "#a855f7";
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(handX, handY);
      ctx.lineTo(handX + dir * 58, handY - 14);
      ctx.stroke();
    } else {
      // Martial Arts Guard Stance
      ctx.lineTo(shoulderX + dir * 14, shoulderY + 12);
      ctx.lineTo(shoulderX + dir * 24, shoulderY + 2);
      ctx.stroke();
    }

    ctx.restore();
  });

  // Hit Sparks
  effects.forEach(ef => {
    ctx.fillStyle = ef.color || "#fbbf24";
    ctx.beginPath();
    ctx.arc(ef.x, ef.y, 11, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ============================================================================
// 8. PC KEYBOARD & MOBILE TOUCH CONTROLS
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

  joystickStick.style.transform = `translate(${Math.cos(angle) * dist}px,${Math.sin(angle) * dist}px)`;

  if (state.mode === "snake") {
    sendPacket("snakeInput", { angle });
  } else if (state.mode === "shadow") {
    const moveX = Math.abs(dx) > 10 ? Math.sign(dx) : 0;
    sendPacket("shadowInput", { moveX, jump: dy < -24 });
  }
}

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

window.addEventListener("keydown", (e) => {
  const activeTag = document.activeElement ? document.activeElement.tagName : "";
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

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
// 9. GARTIC CHAIN, ROSTER & FIXED SCROLLABLE CHAT TABLE
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
    div.innerHTML = `<strong>${item.username}</strong>:${item.prompt || "Drew an interpretation"}`;
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

// Appends row into the Fixed-Height Scrollable Chat Ledger Table
function appendChatMessage(username, text, style = "") {
  const tbody = document.getElementById("chatMessages");
  const scrollBox = document.getElementById("chatScrollBox");
  const tr = document.createElement("tr");
  tr.className = `chat-row ${style}`;

  const tdSender = document.createElement("td");
  tdSender.className = "col-sender";
  tdSender.textContent = username;
  tdSender.title = username;

  const tdMsg = document.createElement("td");
  tdMsg.className = "col-msg";
  tdMsg.textContent = text;

  tr.appendChild(tdSender);
  tr.appendChild(tdMsg);
  tbody.appendChild(tr);

  // Cap ledger at 120 rows so DOM stays fast
  while (tbody.children.length > 120) {
    tbody.removeChild(tbody.firstChild);
  }
  scrollBox.scrollTop = scrollBox.scrollHeight;
}

document.getElementById("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  if (input.disabled) return;
  const text = input.value.trim();
  if (!text) return;
  sendPacket("guess", { text });
  input.value = "";
};
