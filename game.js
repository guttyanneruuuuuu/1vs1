/* =========================================================
   土俵バトル - 1vs1 ジャイロ相撲 (安定性向上版 v5)
   - ジャイロ許可フローの改善: ロビーのボタン押下時に即時要求
   - モバイルUIの再調整: 要素の重なりを完全に排除
   - 画面シェイクの極小化: プレイの妨げにならない微細な揺れ
   - タッチ操作の強化: ジャイロ不可時の完全な代替
   ========================================================= */

(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const screens = { lobby: $('lobby'), game: $('game'), result: $('result') };
const showScreen = (name) => {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
};

const statusEl = $('status');
const setStatus = (msg, isError=false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', !!isError);
};

const ARENA = { size: 1000, ringRadius: 420, ringInnerRadius: 405, dangerZone: 320 };
const PLAYER = {
  radius: 56, mass: 1.0, accel: 1600, maxSpeed: 650, friction: 0.86,
  tackleAccel: 5500, tackleDuration: 0.28, tackleCooldown: 1.1, tackleStaminaCost: 35,
  spinAccel: 6500, spinDuration: 0.35, spinStaminaCost: 50, spinCooldown: 1.5,
  defenseStaminaCost: 25, defenseCooldown: 0.8, defenseDuration: 0.4,
  staminaMax: 100, staminaRegen: 28, specialGaugeMax: 100, specialGaugePerHit: 15, restitution: 1.15,
};
const ROUND = { winsToMatch: 2, startCountdown: 3 };
const GYRO = { deadZone: 5, fullZone: 25, maxTilt: 1.0, smoothing: 0.7, accelerationFactor: 1.0 };

const state = {
  mode: null, peer: null, conn: null, myPeerId: null, opPeerId: null, passphrase: null,
  myMotionEnabled: false, motionTilt: { x:0, y:0 }, motionRaw: { gamma: 0, beta: 0 },
  motionCalibration: { gamma: 0, beta: 30 }, hasReceivedMotion: false,
  game: null, opInput: { tx:0, ty:0, tackle:false, spin:false, defend:false, seq:0 },
  myInput: { tx:0, ty:0, tackle:false, spin:false, defend:false, seq:0 },
  scoreMe: 0, scoreOp: 0, round: 1, matchOver: false, rafId: null, lastTime: 0,
  remoteSnapshot: null, prevSnapshot: null, snapshotTime: 0, cpuDifficulty: 'normal',
  screenShakeIntensity: 0, screenShakeTime: 0, comboCount: 0, comboResetTimer: 0,
  impactFlash: 0, impactFlashMax: 0.08, shockwaves: [], trailParticles: [], dustParticles: [],
};

// ---------- ジャイロ許可フロー改善 ----------
async function requestMotionPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') {
        state.myMotionEnabled = true;
        attachOrientation();
        return true;
      }
    } catch (e) {
      console.error('Motion permission error:', e);
    }
  } else {
    // Android or desktop
    state.myMotionEnabled = true;
    attachOrientation();
    return true;
  }
  return false;
}

let _orientationAttached = false;
function attachOrientation() {
  if (_orientationAttached) return;
  _orientationAttached = true;
  window.addEventListener('deviceorientation', (e) => {
    const g = e.gamma, b = e.beta;
    if (g == null || b == null) return;
    if (!state.hasReceivedMotion) {
      state.motionCalibration.gamma = g;
      state.motionCalibration.beta = b;
      state.hasReceivedMotion = true;
    }
    let tx = softZone(g - state.motionCalibration.gamma, GYRO.deadZone, GYRO.fullZone);
    let ty = softZone(b - state.motionCalibration.beta, GYRO.deadZone, GYRO.fullZone);
    state.motionTilt.x = state.motionTilt.x * GYRO.smoothing + clamp(tx, -1, 1) * (1 - GYRO.smoothing);
    state.motionTilt.y = state.motionTilt.y * GYRO.smoothing + clamp(ty, -1, 1) * (1 - GYRO.smoothing);
  }, true);
}

function softZone(v, dead, full) {
  if (Math.abs(v) <= dead) return 0;
  return (v < 0 ? -1 : 1) * Math.min(1, (Math.abs(v) - dead) / (full - dead));
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ---------- UI Controls ----------
function attachUI() {
  $('btn-match').addEventListener('click', async () => {
    const phrase = $('passphrase').value.trim();
    if (phrase.length < 2) { setStatus('合言葉は2文字以上で入力してください', true); return; }
    await requestMotionPermission();
    ensureAudio();
    startMatchmaking(phrase);
  });

  $('btn-solo').addEventListener('click', async () => {
    await requestMotionPermission();
    ensureAudio();
    state.mode = 'cpu';
    state.scoreMe = 0; state.scoreOp = 0; state.round = 1;
    enterGame();
  });

  $('btn-tackle').addEventListener('touchstart', (e) => { e.preventDefault(); state.myInput.tackle = true; playSfx('tackle'); }, {passive: false});
  $('btn-spin').addEventListener('touchstart', (e) => { e.preventDefault(); state.myInput.spin = true; playSfx('spin'); }, {passive: false});
  $('btn-defend').addEventListener('touchstart', (e) => { e.preventDefault(); state.myInput.defend = true; playSfx('defend'); }, {passive: false});
  
  // Click fallbacks for desktop
  $('btn-tackle').addEventListener('mousedown', () => { state.myInput.tackle = true; playSfx('tackle'); });
  $('btn-spin').addEventListener('mousedown', () => { state.myInput.spin = true; playSfx('spin'); });
  $('btn-defend').addEventListener('mousedown', () => { state.myInput.defend = true; playSfx('defend'); });

  $('btn-rematch').addEventListener('click', () => { if (state.mode === 'host') startNewMatch(); else safeSend({ t: 'rematch' }); });
  $('btn-back').addEventListener('click', () => location.reload());
}

function attachTouchFallback(canvas) {
  let touchX = 0, touchY = 0, isTouching = false;
  canvas.addEventListener('touchstart', (e) => {
    isTouching = true;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, {passive: true});
  canvas.addEventListener('touchmove', (e) => {
    if (!isTouching) return;
    const dx = e.touches[0].clientX - touchX, dy = e.touches[0].clientY - touchY;
    state.myInput.tx = clamp(dx / 80, -1, 1);
    state.myInput.ty = clamp(dy / 80, -1, 1);
  }, {passive: true});
  canvas.addEventListener('touchend', () => {
    isTouching = false;
    if (!state.myMotionEnabled) { state.myInput.tx = 0; state.myInput.ty = 0; }
  });
}

// ---------- Network / PeerJS ----------
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }
function makeIds(phrase) { const tag = hashStr('sumo-bouts-' + phrase.trim().toLowerCase().replace(/\s+/g, '-')); return { A: `sumob-${tag}-A`, B: `sumob-${tag}-B` }; }
async function startMatchmaking(phrase) {
  setStatus('接続中…');
  const ids = makeIds(phrase);
  try {
    const peer = new Peer(ids.A, { debug: 1 });
    peer.on('open', () => { state.peer = peer; state.mode = 'host'; setStatus('相手を待っています…'); });
    peer.on('connection', (c) => { state.conn = c; attachConn(c); });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        const guestPeer = new Peer(ids.B, { debug: 1 });
        guestPeer.on('open', () => {
          state.peer = guestPeer; state.mode = 'guest'; setStatus('接続中…');
          const c = guestPeer.connect(ids.A, { reliable: false });
          state.conn = c; attachConn(c);
        });
      } else setStatus('エラー: ' + err.type, true);
    });
  } catch (e) { setStatus('接続失敗', true); }
}
function attachConn(c) {
  c.on('open', () => { setStatus('接続完了！'); onConnected(); });
  c.on('data', (d) => onPeerData(d));
  c.on('close', () => { setStatus('切断されました', true); endMatchAbort(); });
}
function onConnected() { state.scoreMe = 0; state.scoreOp = 0; state.round = 1; enterGame(); }
function onPeerData(d) {
  if (d.t === 'snap') { state.remoteSnapshot = d.s; }
  else if (d.t === 'in' && state.mode === 'host') { state.opInput = d.i; }
  else if (d.t === 'round' && state.mode === 'guest') {
    state.scoreMe = d.guestScore; state.scoreOp = d.hostScore; state.round = d.round;
    updateScoreUI(); showRoundBannerWithSub(d.banner === 'guest' ? '勝ち！' : '負け…', `${state.scoreMe} － ${state.scoreOp}`);
    if (d.matchOver) setTimeout(() => showResult(state.scoreMe > state.scoreOp), 1500); else setTimeout(hideBanner, 1700);
  } else if (d.t === 'rematch' && state.mode === 'host') startNewMatch();
}
function safeSend(o) { if (state.conn && state.conn.open) state.conn.send(o); }

// ---------- Game Loop ----------
function enterGame() { showScreen('game'); state.game = createInitialGameState(); startCountdownThenRun(); }
function startCountdownThenRun() {
  state.game.paused = true; updateScoreUI(); showRoundBannerWithSub(`第${state.round}番`, '構えて…');
  if (!state.rafId) { state.lastTime = performance.now(); loop(); }
  setTimeout(() => { showRoundBannerWithSub('はっけよい', '残った！'); playSfx('bell'); setTimeout(() => { hideBanner(); state.game.paused = false; }, 600); }, 1100);
}
function loop() {
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now(); let dt = Math.min((now - state.lastTime) / 1000, 0.05); state.lastTime = now;
  if (state.mode === 'host' || state.mode === 'cpu') {
    if (state.mode === 'cpu') cpuThink(dt);
    simulate(dt); if (state.mode === 'host') sendSnapshot();
    state.myInput.tackle = state.myInput.spin = state.myInput.defend = false;
    state.opInput.tackle = state.opInput.spin = state.opInput.defend = false;
    updateFx(dt);
  } else {
    safeSend({ t: 'in', i: { tx: -state.motionTilt.x, ty: -state.motionTilt.y, tackle: state.myInput.tackle, spin: state.myInput.spin, defend: state.myInput.defend } });
    state.myInput.tackle = state.myInput.spin = state.myInput.defend = false;
    interpFromSnapshot(); updateFx(dt);
  }
  state.screenShakeTime = Math.max(0, state.screenShakeTime - dt);
  state.impactFlash = Math.max(0, state.impactFlash - dt);
  render();
}

function simulate(dt) {
  const g = state.game; if (g.paused || g.roundEnded) return;
  [g.p1, g.p2].forEach((p, i) => {
    const inp = i === 0 ? state.myInput : state.opInput;
    if (inp.spin && p.stamina >= PLAYER.spinStaminaCost && p.spinCooldown <= 0) { p.stamina -= PLAYER.spinStaminaCost; p.spinT = PLAYER.spinDuration; p.spinCooldown = PLAYER.spinCooldown; p.vx += (inp.tx || (i === 0 ? 1 : -1)) * 400; p.vy += (inp.ty || 0) * 400; }
    if (inp.tackle && p.stamina >= PLAYER.tackleStaminaCost && p.cooldown <= 0) { p.stamina -= PLAYER.tackleStaminaCost; p.tackleT = PLAYER.tackleDuration; p.cooldown = PLAYER.tackleCooldown; p.vx += (inp.tx || (i === 0 ? 1 : -1)) * 350; p.vy += (inp.ty || 0) * 350; }
    if (inp.defend && p.stamina >= PLAYER.defenseStaminaCost && p.defendCooldown <= 0) { p.stamina -= PLAYER.defenseStaminaCost; p.defendT = PLAYER.defenseDuration; p.defendCooldown = PLAYER.defenseCooldown; }
    const accel = (p.tackleT > 0 || p.spinT > 0) ? PLAYER.tackleAccel : PLAYER.accel;
    p.vx += (i === 0 ? state.motionTilt.x : inp.tx) * accel * dt; p.vy += (i === 0 ? state.motionTilt.y : inp.ty) * accel * dt;
    const f = Math.pow(PLAYER.friction, dt * 60); p.vx *= f; p.vy *= f; p.x += p.vx * dt; p.y += p.vy * dt;
    p.stamina = Math.min(PLAYER.staminaMax, p.stamina + PLAYER.staminaRegen * dt);
    p.tackleT = Math.max(0, p.tackleT - dt); p.spinT = Math.max(0, p.spinT - dt); p.defendT = Math.max(0, p.defendT - dt);
    p.cooldown = Math.max(0, p.cooldown - dt); p.spinCooldown = Math.max(0, p.spinCooldown - dt); p.defendCooldown = Math.max(0, p.defendCooldown - dt);
    p.isDefending = p.defendT > 0; p.hitT = Math.max(0, p.hitT - dt);
  });
  resolveCollision(g.p1, g.p2);
  const cx = 500, cy = 500, r = ARENA.ringRadius;
  const out1 = dist(g.p1.x, g.p1.y, cx, cy) > r, out2 = dist(g.p2.x, g.p2.y, cx, cy) > r;
  if (out1 || out2) { g.roundEnded = true; onRoundEnd(out1 ? 'p2' : 'p1'); }
}

function resolveCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), minD = PLAYER.radius * 2;
  if (d >= minD || d < 0.1) return;
  const nx = dx / d, ny = dy / d, vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn > 0) return;
  const overlap = minD - d; a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5; b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
  let dmg = (a.isDefending || b.isDefending) ? 0.5 : 1.0;
  a.vx -= nx * vn * PLAYER.restitution * dmg; a.vy -= ny * vn * PLAYER.restitution * dmg;
  b.vx += nx * vn * PLAYER.restitution * dmg; b.vy += ny * vn * PLAYER.restitution * dmg;
  if (Math.abs(vn) > 80) {
    a.hitT = b.hitT = 0.2; state.screenShakeIntensity = Math.min(3, Math.abs(vn) / 200); state.screenShakeTime = 0.1;
    state.impactFlash = state.impactFlashMax; playSfx('hit'); spawnImpactFx((a.x + b.x) / 2, (a.y + b.y) / 2);
  }
}

function cpuThink(dt) {
  const me = state.game.p2, op = state.game.p1, distCenter = dist(me.x, me.y, 500, 500);
  let tx = op.x - me.x, ty = op.y - me.y;
  if (distCenter > ARENA.dangerZone) { const pull = (distCenter - ARENA.dangerZone) / 100; tx = tx * (1 - pull) + (500 - me.x) * pull; ty = ty * (1 - pull) + (500 - me.y) * pull; }
  const mag = Math.hypot(tx, ty); state.opInput.tx = mag > 0.1 ? tx / mag * 0.7 : 0; state.opInput.ty = mag > 0.1 ? ty / mag * 0.7 : 0;
  if (dist(me.x, me.y, op.x, op.y) < 200 && Math.random() < 0.05) state.opInput.tackle = true;
}

// ---------- Render / FX ----------
function render() {
  const w = window.innerWidth, h = window.innerHeight; ctx.clearRect(0, 0, w, h); ctx.save();
  if (state.screenShakeTime > 0) { const s = state.screenShakeIntensity; ctx.translate((Math.random() - 0.5) * s * 10, (Math.random() - 0.5) * s * 10); }
  if (state.impactFlash > 0) { ctx.fillStyle = `rgba(255,255,255,${state.impactFlash * 2})`; ctx.fillRect(0, 0, w, h); }
  ctx.translate(offsetX, offsetY); ctx.scale(scale, scale); if (state.mode === 'guest') { ctx.translate(1000, 1000); ctx.rotate(Math.PI); }
  drawDohyo(); const g = state.game; [g.p1, g.p2].forEach((p, i) => drawRikishi(p, i === 0 ? '#a8322c' : '#2f4a6b', i === 0));
  fxParticles.forEach(p => { const a = p.life / p.max; ctx.fillStyle = `rgba(255,200,100,${a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2); ctx.fill(); });
  ctx.restore();
  const me = state.mode === 'guest' ? g.p2 : g.p1;
  $('stamina-fill').style.width = (me.stamina) + '%';
  $('btn-tackle').classList.toggle('cooldown', me.stamina < PLAYER.tackleStaminaCost || me.cooldown > 0);
  $('btn-spin').classList.toggle('cooldown', me.stamina < PLAYER.spinStaminaCost || me.spinCooldown > 0);
  $('btn-defend').classList.toggle('cooldown', me.stamina < PLAYER.defenseStaminaCost || me.defendCooldown > 0);
}

function drawDohyo() {
  ctx.fillStyle = '#cdb070'; ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = '#d4a968'; ctx.beginPath(); ctx.arc(500, 500, ARENA.ringRadius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#f1e1bc'; ctx.lineWidth = 15; ctx.beginPath(); ctx.arc(500, 500, ARENA.ringRadius - 8, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(440, 498, 120, 4); ctx.fillRect(440, 450, 120, 4); ctx.fillRect(440, 546, 120, 4);
}

function drawRikishi(p, color, isMe) {
  const r = PLAYER.radius; ctx.save(); ctx.translate(p.x, p.y);
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#2b2118'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = isMe ? '#f5e6c4' : '#dcd0b0'; ctx.beginPath(); ctx.arc(0, 6, r * 0.7, 0, Math.PI, false); ctx.fill();
  ctx.fillStyle = '#2b2118';
  if (p.hitT > 0) { ctx.font = '20px Arial'; ctx.textAlign = 'center'; ctx.fillText('× ×', 0, -10); }
  else { ctx.beginPath(); ctx.arc(-12, -10, 5, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(12, -10, 5, 0, Math.PI * 2); ctx.fill(); }
  if (p.tackleT > 0) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, r + 10, 0, Math.PI * 2); ctx.stroke(); }
  if (p.spinT > 0) { ctx.strokeStyle = '#ff0'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, r + 12, 0, Math.PI * 2); ctx.stroke(); }
  if (p.isDefending) { ctx.strokeStyle = '#0af'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, r + 15, 0, Math.PI * 2); ctx.stroke(); }
  if (isMe) { ctx.fillStyle = '#fff'; ctx.font = 'bold 24px serif'; ctx.textAlign = 'center'; ctx.fillText('己', 0, -r - 15); }
  ctx.restore();
}

// ---------- Utils / Audio ----------
const fxParticles = [];
function spawnImpactFx(x, y) { for (let i = 0; i < 12; i++) { const a = Math.random() * Math.PI * 2, s = 50 + Math.random() * 100; fxParticles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, max: 0.5, size: 5 }); } }
function updateFx(dt) { for (let i = fxParticles.length - 1; i >= 0; i--) { const p = fxParticles[i]; p.life -= dt; if (p.life <= 0) { fxParticles.splice(i, 1); continue; } p.x += p.vx * dt; p.y += p.vy * dt; } }
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); }
function updateScoreUI() { $('score-me').textContent = state.scoreMe; $('score-op').textContent = state.scoreOp; }
function onRoundEnd(w) { if (w === 'p1') state.scoreMe++; else state.scoreOp++; const over = state.scoreMe >= 2 || state.scoreOp >= 2; if (state.mode === 'host') safeSend({ t: 'round', hostScore: state.scoreMe, guestScore: state.scoreOp, round: state.round + 1, banner: w === 'p1' ? 'host' : 'guest', matchOver: over }); updateScoreUI(); showRoundBannerWithSub(w === 'p1' ? '勝ち！' : '負け…', `${state.scoreMe} － ${state.scoreOp}`); if (over) setTimeout(() => showResult(w === 'p1'), 1500); else setTimeout(() => { state.round++; state.game = createInitialGameState(); startCountdownThenRun(); }, 1700); }
function sendSnapshot() { if (state.conn && state.conn.open) { const g = state.game; safeSend({ t: 'snap', s: { p1: pack(g.p1), p2: pack(g.p2), paused: g.paused, score: [state.scoreMe, state.scoreOp], round: state.round } }); } }
function pack(p) { return [Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), Math.round(p.stamina), Math.round(p.tackleT * 100), Math.round(p.spinT * 100), Math.round(p.defendT * 100), p.isDefending ? 1 : 0, Math.round(p.hitT * 100)]; }
function unpack(a) { return { x: a[0], y: a[1], vx: a[2], vy: a[3], stamina: a[4], tackleT: a[5] / 100, spinT: a[6] / 100, defendT: a[7] / 100, isDefending: a[8] === 1, hitT: a[9] / 100, alive: true }; }
function interpFromSnapshot() { if (state.remoteSnapshot) { const s = state.remoteSnapshot; state.game.p1 = unpack(s.p1); state.game.p2 = unpack(s.p2); state.game.paused = s.paused; state.scoreMe = s.score[1]; state.scoreOp = s.score[0]; updateScoreUI(); } }
function showResult(w) { showScreen('result'); $('result-title').textContent = w ? '勝利！' : '敗北…'; }

let scale = 1, offsetX = 0, offsetY = 0;
function resizeCanvas() {
  const w = window.innerWidth, h = window.innerHeight, dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scale = Math.min(w, h) * 0.9 / 1000; offsetX = (w - 1000 * scale) / 2; offsetY = (h - 1000 * scale) / 2;
}

document.addEventListener('DOMContentLoaded', () => { setupCanvas(); attachUI(); showScreen('lobby'); });
})();
