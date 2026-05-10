/* =========================================================
   土俵バトル - 1vs1 ジャイロ相撲 (モバイル最適化版 v4)
   - モバイルUI崩れの修正: レイアウトの再構築
   - 画面シェイクの抑制: プレイを妨げない程度の揺れに調整
   - 操作性の改善: ジャイロ感度の再調整、ボタン反応の向上
   ========================================================= */

(() => {
'use strict';

// ---------- DOM ----------
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

// ---------- Game constants ----------
const ARENA = {
  size: 1000,
  ringRadius: 420,
  ringInnerRadius: 405,
  dangerZone: 320,
};
const PLAYER = {
  radius: 56,
  mass: 1.0,
  accel: 1600,
  maxSpeed: 650,
  friction: 0.86,
  tackleAccel: 5500,
  tackleDuration: 0.28,
  tackleCooldown: 1.1,
  tackleStaminaCost: 35,
  spinAccel: 6500,
  spinDuration: 0.35,
  spinStaminaCost: 50,
  spinCooldown: 1.5,
  defenseStaminaCost: 25,
  defenseCooldown: 0.8,
  defenseDuration: 0.4,
  staminaMax: 100,
  staminaRegen: 28,
  specialGaugeMax: 100,
  specialGaugePerHit: 15,
  restitution: 1.15,
};
const ROUND = {
  winsToMatch: 2,
  startCountdown: 3,
};

// ジャイロ感度の再調整 (より安定した操作へ)
const GYRO = {
  deadZone: 4,      // 少し広げて誤動作を防止
  fullZone: 20,     // 傾きを検出しやすく
  maxTilt: 1.0,
  smoothing: 0.75,  // 反応速度を上げるために少し下げる
  accelerationFactor: 1.0,
};

// ---------- State ----------
const state = {
  mode: null,
  peer: null,
  conn: null,
  myPeerId: null,
  opPeerId: null,
  passphrase: null,
  myMotionEnabled: false,
  motionTilt: { x:0, y:0 },
  motionRaw: { gamma: 0, beta: 0 },
  motionCalibration: { gamma: 0, beta: 30 },
  hasReceivedMotion: false,
  game: null,
  opInput: { tx:0, ty:0, tackle:false, spin:false, defend:false, seq:0 },
  myInput: { tx:0, ty:0, tackle:false, spin:false, defend:false, seq:0 },
  scoreMe: 0,
  scoreOp: 0,
  round: 1,
  matchOver: false,
  rafId: null,
  lastTime: 0,
  remoteSnapshot: null,
  prevSnapshot: null,
  snapshotTime: 0,
  cpuTarget: { x:500, y:500 },
  cpuDifficulty: 'normal',
  screenShakeIntensity: 0,
  screenShakeTime: 0,
  comboCount: 0,
  comboResetTimer: 0,
  impactFlash: 0,
  impactFlashMax: 0.1, // 短くして視認性向上
  shockwaves: [],
  trailParticles: [],
  dustParticles: [],
};

// ---------- PeerJS matchmaking ----------
function hashStr(s){
  let h = 5381;
  for (let i=0;i<s.length;i++) h = ((h<<5)+h+s.charCodeAt(i))|0;
  return Math.abs(h).toString(36);
}
function makeIds(phrase){
  const norm = phrase.trim().toLowerCase().replace(/\s+/g,'-');
  const tag = hashStr('sumo-bouts-' + norm);
  return { A: `sumob-${tag}-A`, B: `sumob-${tag}-B` };
}

function createPeer(id){
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, { debug: 1 });
    let done = false;
    peer.on('open', (pid) => { if(!done){done=true; resolve(peer);} });
    peer.on('error', (err) => { if(done) return; done = true; reject(err); });
    setTimeout(() => { if(!done){done=true; reject(new Error('peer-timeout'));} }, 8000);
  });
}

async function startMatchmaking(phrase){
  setStatus('接続中…', false);
  const ids = makeIds(phrase);
  state.passphrase = phrase;
  try{
    const peer = await createPeer(ids.A);
    state.peer = peer; state.myPeerId = ids.A; state.opPeerId = ids.B; state.mode = 'host';
    setStatus('相手を待っています…（合言葉: ' + phrase + '）');
    peer.on('connection', (conn) => { state.conn = conn; attachConn(conn); });
  }catch(err){
    if(String(err && (err.type||err.message||'')).includes('unavailable') || (err && err.type === 'unavailable-id')){
      try{
        const peer = await createPeer(ids.B);
        state.peer = peer; state.myPeerId = ids.B; state.opPeerId = ids.A; state.mode = 'guest';
        setStatus('部屋に入っています…');
        const conn = peer.connect(ids.A, { reliable: false, serialization: 'json' });
        state.conn = conn; attachConn(conn);
      }catch(err2){ setStatus('接続に失敗しました: ' + (err2.message||err2.type||err2), true); }
    } else { setStatus('接続に失敗しました: ' + (err.message||err.type||err), true); }
  }
}

function attachConn(conn){
  conn.on('open', () => { setStatus('接続完了！ ゲーム開始準備中…'); onConnected(); });
  conn.on('data', (data) => onPeerData(data));
  conn.on('close', () => { setStatus('相手との接続が切れました', true); endMatchAbort(); });
  conn.on('error', (e) => { setStatus('通信エラー: ' + (e.message||e), true); });
}

function safeSend(obj){
  try{ if(state.conn && state.conn.open){ state.conn.send(obj); } }catch(e){ }
}

function onConnected(){
  state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false;
  enterGame();
}

function onPeerData(data){
  if(!data || typeof data !== 'object') return;
  switch(data.t){
    case 'snap': state.prevSnapshot = state.remoteSnapshot; state.remoteSnapshot = data.s; state.snapshotTime = performance.now(); break;
    case 'in': if(state.mode==='host'){ state.opInput = data.i; } break;
    case 'round':
      if(state.mode==='guest'){
        state.scoreMe = data.guestScore; state.scoreOp = data.hostScore; state.round = data.round;
        updateScoreUI();
        $('round-label').textContent = `第${state.round}番`;
        const guestWon = (data.banner === 'guest'), hostWon = (data.banner === 'host');
        const txt = guestWon ? '勝ち！' : (hostWon ? '負け…' : '引分'), cls = guestWon ? 'red' : (hostWon ? 'blue' : '');
        showRoundBannerWithSub(txt, `${state.scoreMe} － ${state.scoreOp}`, cls);
        if(data.matchOver){ setTimeout(()=> showResult(state.scoreMe>state.scoreOp), 1500); } else { setTimeout(()=> hideBanner(), 1700); }
      }
      break;
    case 'rematch': if(state.mode==='host'){ startNewMatch(); } break;
  }
}

// ---------- Motion (Gyro) ----------
async function ensureMotionPermission(){
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'){
    try{ const res = await DeviceOrientationEvent.requestPermission(); if(res !== 'granted') return false; }catch(e){ return false; }
  }
  state.myMotionEnabled = true; attachOrientation(); return true;
}

let _orientationAttached = false;
function attachOrientation(){
  if(_orientationAttached) return; _orientationAttached = true;
  window.addEventListener('deviceorientation', (e) => {
    const g = e.gamma, b = e.beta;
    if(g == null || b == null) return;
    state.motionRaw.gamma = g; state.motionRaw.beta = b;
    if(!state.hasReceivedMotion){ state.motionCalibration.gamma = g; state.motionCalibration.beta = b; state.hasReceivedMotion = true; }
    const dg = g - state.motionCalibration.gamma, db = b - state.motionCalibration.beta;
    let tx = softZone(dg, GYRO.deadZone, GYRO.fullZone), ty = softZone(db, GYRO.deadZone, GYRO.fullZone);
    tx = clamp(tx, -GYRO.maxTilt, GYRO.maxTilt); ty = clamp(ty, -GYRO.maxTilt, GYRO.maxTilt);
    state.motionTilt.x = state.motionTilt.x * GYRO.smoothing + tx * (1 - GYRO.smoothing);
    state.motionTilt.y = state.motionTilt.y * GYRO.smoothing + ty * (1 - GYRO.smoothing);
  }, true);
}

function softZone(v, dead, full){
  if(Math.abs(v) <= dead) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.min(1, (Math.abs(v) - dead) / (full - dead));
}

function clamp(v, a, b){ return Math.max(a, Math.min(b,v)); }

// ---------- Audio (WebAudio synth) ----------
let audioCtx = null;
function ensureAudio(){
  if(!audioCtx){ try { audioCtx = new (window.AudioContext||window.webkitAudioContext)(); } catch(e){ return; } }
  if(audioCtx.state === 'suspended') audioCtx.resume();
}

function playSfx(kind){
  if(!audioCtx) return;
  const t0 = audioCtx.currentTime;
  if(kind === 'tackle'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(180, t0); o.frequency.exponentialRampToValueAtTime(80, t0+0.18);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.22);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.25);
  } else if(kind === 'spin'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(440, t0); o.frequency.exponentialRampToValueAtTime(220, t0+0.3);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0+0.05); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.35);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.4);
  } else if(kind === 'defend'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='triangle'; o.frequency.setValueAtTime(330, t0); o.frequency.exponentialRampToValueAtTime(220, t0+0.2);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.2, t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.22);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.25);
  } else if(kind === 'hit'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='triangle'; o.frequency.setValueAtTime(220, t0); o.frequency.exponentialRampToValueAtTime(80, t0+0.12);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0+0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.16);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.18);
  } else if(kind === 'bell'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(523, t0); o.frequency.exponentialRampToValueAtTime(330, t0+0.5);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0+0.05); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.55);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.6);
  }
}

// ---------- UI Controls ----------
function attachUI(){
  $('btn-match').addEventListener('click', () => {
    const phrase = $('passphrase').value.trim();
    if(phrase.length < 2) { setStatus('合言葉は2文字以上で入力してください', true); return; }
    ensureAudio(); startMatchmaking(phrase);
  });
  $('btn-solo').addEventListener('click', () => {
    ensureAudio(); state.mode = 'cpu'; state.cpuDifficulty = 'normal';
    state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false; enterGame();
  });
  $('btn-enable-motion').addEventListener('click', async () => {
    const ok = await ensureMotionPermission(); if(ok) $('enable-motion').classList.add('hidden'); else setStatus('動きセンサーの許可に失敗しました', true);
  });
  $('btn-tackle').addEventListener('click', () => { state.myInput.tackle = true; ensureAudio(); playSfx('tackle'); });
  $('btn-spin').addEventListener('click', () => { state.myInput.spin = true; ensureAudio(); playSfx('spin'); });
  $('btn-defend').addEventListener('click', () => { state.myInput.defend = true; ensureAudio(); playSfx('defend'); });
  $('btn-rematch').addEventListener('click', () => { if(state.mode === 'host') startNewMatch(); else if(state.mode === 'guest') safeSend({ t:'rematch' }); });
  $('btn-back').addEventListener('click', () => location.reload());

  document.addEventListener('keydown', (e) => {
    if(!state.game || state.game.paused) return;
    if(e.key === ' ') { e.preventDefault(); state.myInput.tackle = true; playSfx('tackle'); }
    else if(e.key === 'q' || e.key === 'Q') { e.preventDefault(); state.myInput.spin = true; playSfx('spin'); }
    else if(e.key === 'e' || e.key === 'E') { e.preventDefault(); state.myInput.defend = true; playSfx('defend'); }
    else if(e.key === 'ArrowLeft') { e.preventDefault(); state.myInput.tx = -1; }
    else if(e.key === 'ArrowRight') { e.preventDefault(); state.myInput.tx = 1; }
    else if(e.key === 'ArrowUp') { e.preventDefault(); state.myInput.ty = -1; }
    else if(e.key === 'ArrowDown') { e.preventDefault(); state.myInput.ty = 1; }
  });
}

function attachTouchFallback(canvas){
  let touchX = 0, touchY = 0;
  canvas.addEventListener('touchstart', (e) => { if(e.touches.length > 0){ touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } });
  canvas.addEventListener('touchmove', (e) => {
    if(e.touches.length > 0){
      const dx = e.touches[0].clientX - touchX, dy = e.touches[0].clientY - touchY;
      if(Math.hypot(dx, dy) > 5){ state.myInput.tx = clamp(dx / 100, -1, 1); state.myInput.ty = clamp(dy / 100, -1, 1); }
    }
  });
}

function enterGame(){ showScreen('game'); state.game = createInitialGameState(); startCountdownThenRun(); if(!state.myMotionEnabled && state.mode !== 'cpu') $('enable-motion').classList.remove('hidden'); }
function startNewMatch(){ state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false; state.game = createInitialGameState(); startCountdownThenRun(); }
function endMatchAbort(){ if(state.rafId) cancelAnimationFrame(state.rafId); state.rafId = null; showScreen('lobby'); }

function cpuThink(dt){
  const me = state.game.p2, op = state.game.p1, cx = ARENA.size/2, cy = ARENA.size/2;
  const dxCenter = cx - me.x, dyCenter = cy - me.y, distCenter = Math.hypot(dxCenter, dyCenter);
  const dxOp = op.x - me.x, dyOp = op.y - me.y, distOp = Math.hypot(dxOp, dyOp);
  let targetX = dxOp, targetY = dyOp;
  if(distCenter > ARENA.dangerZone){
    const pull = (distCenter - ARENA.dangerZone) / (ARENA.ringRadius - ARENA.dangerZone);
    targetX = dxOp * (1 - pull) + dxCenter * pull; targetY = dyOp * (1 - pull) + dyCenter * pull;
    if(distCenter > ARENA.ringRadius - 60 && me.stamina > PLAYER.tackleStaminaCost && me.cooldown <= 0) state.opInput.tackle = true;
  }
  const distTarget = Math.hypot(targetX, targetY);
  state.opInput.tx = distTarget > 0.1 ? targetX / distTarget * 0.75 : 0;
  state.opInput.ty = distTarget > 0.1 ? targetY / distTarget * 0.75 : 0;
  const rand = Math.random();
  if(distOp < 250 && rand < 0.2) state.opInput.tackle = true;
  if(distOp < 180 && rand < 0.12) state.opInput.spin = true;
  if(distOp < 120 && rand < 0.15) state.opInput.defend = true;
}

function resetGameState(){ state.screenShakeIntensity = 0; state.screenShakeTime = 0; state.comboCount = 0; state.comboResetTimer = 0; state.impactFlash = 0; state.shockwaves = []; state.trailParticles = []; state.dustParticles = []; }
function createInitialGameState(){ return { p1: { x: ARENA.size*0.5 - 180, y: ARENA.size*0.5, vx:0, vy:0, stamina: PLAYER.staminaMax, specialGauge: 0, tackleT:0, spinT:0, defendT:0, cooldown:0, spinCooldown:0, defendCooldown:0, color:'red', alive:true, isDefending: false, hitT: 0 }, p2: { x: ARENA.size*0.5 + 180, y: ARENA.size*0.5, vx:0, vy:0, stamina: PLAYER.staminaMax, specialGauge: 0, tackleT:0, spinT:0, defendT:0, cooldown:0, spinCooldown:0, defendCooldown:0, color:'blue', alive:true, isDefending: false, hitT: 0 }, t: 0, paused: true, countdown: ROUND.startCountdown, roundEnded: false, winner: null }; }

function startCountdownThenRun(){
  $('round-label').textContent = `第${state.round}番`; updateScoreUI();
  state.game.paused = true; state.game.roundEnded = false;
  showRoundBannerWithSub(`第${state.round}番`, '構えて…', '');
  if(!state.rafId){ state.lastTime = performance.now(); loop(); }
  setTimeout(() => { showRoundBannerWithSub('はっけよい', '残った！', ''); playSfx('bell'); setTimeout(() => { hideBanner(); state.game.paused = false; }, 600); }, 1100);
}
function updateScoreUI(){ $('score-me').textContent = state.scoreMe; $('score-op').textContent = state.scoreOp; }
function showRoundBannerWithSub(text, sub, cls=''){ const b = $('banner'); b.classList.remove('hidden'); b.innerHTML = `<div class="inner ${cls}">${text}<div class="sub">${sub}</div></div>`; }
function hideBanner(){ $('banner').classList.add('hidden'); }

let canvas, ctx, scale=1, offsetX=0, offsetY=0;
function setupCanvas(){ canvas = $('canvas'); ctx = canvas.getContext('2d'); resizeCanvas(); window.addEventListener('resize', resizeCanvas); attachTouchFallback(canvas); }
function resizeCanvas(){
  const dpr = Math.min(window.devicePixelRatio||1, 2); const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w*dpr; canvas.height = h*dpr; canvas.style.width = w+'px'; canvas.style.height = h+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const minDim = Math.min(w,h); scale = (minDim*0.94) / ARENA.size; offsetX = (w - ARENA.size*scale)/2; offsetY = (h - ARENA.size*scale)/2;
}

function loop(){
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now(); let dt = (now - state.lastTime)/1000; state.lastTime = now;
  if(dt > 0.05) dt = 0.05;
  state.myInput.tx = state.motionTilt.x; state.myInput.ty = state.motionTilt.y;
  if(state.mode === 'host' || state.mode === 'cpu'){
    if(state.mode === 'cpu') cpuThink(dt);
    simulate(dt); if(state.mode === 'host') sendSnapshot();
    state.myInput.tackle = state.myInput.spin = state.myInput.defend = false;
    state.opInput.tackle = state.opInput.spin = state.opInput.defend = false;
    updateFx(dt);
  } else if (state.mode === 'guest'){
    state.myInput.seq = (state.myInput.seq+1)|0;
    safeSend({ t:'in', i: { tx: -state.myInput.tx, ty: -state.myInput.ty, tackle: state.myInput.tackle, spin: state.myInput.spin, defend: state.myInput.defend, seq: state.myInput.seq }});
    state.myInput.tackle = state.myInput.spin = state.myInput.defend = false;
    interpFromSnapshot(); updateFx(dt);
  }
  state.screenShakeTime -= dt; if(state.screenShakeTime < 0) state.screenShakeTime = 0;
  state.comboResetTimer -= dt; if(state.comboResetTimer < 0) state.comboCount = 0;
  state.impactFlash -= dt; if(state.impactFlash < 0) state.impactFlash = 0;
  render();
}

function simulate(dt){
  const g = state.game; if(g.paused || g.roundEnded) return;
  applyInput(g.p1, state.myInput, dt); applyInput(g.p2, state.opInput, dt);
  integrate(g.p1, dt); integrate(g.p2, dt);
  resolveCollision(g.p1, g.p2);
  g.p1.stamina = Math.min(PLAYER.staminaMax, g.p1.stamina + PLAYER.staminaRegen*dt);
  g.p2.stamina = Math.min(PLAYER.staminaMax, g.p2.stamina + PLAYER.staminaRegen*dt);
  [g.p1, g.p2].forEach(p => { p.tackleT = Math.max(0, p.tackleT-dt); p.spinT = Math.max(0, p.spinT-dt); p.defendT = Math.max(0, p.defendT-dt); p.cooldown = Math.max(0, p.cooldown-dt); p.spinCooldown = Math.max(0, p.spinCooldown-dt); p.defendCooldown = Math.max(0, p.defendCooldown-dt); p.hitT = Math.max(0, p.hitT-dt); p.isDefending = p.defendT > 0; });
  const cx = ARENA.size/2, cy = ARENA.size/2, r = ARENA.ringRadius;
  const out1 = dist(g.p1.x,g.p1.y,cx,cy) > r+4, out2 = dist(g.p2.x,g.p2.y,cx,cy) > r+4;
  if(out1 || out2){ g.roundEnded = true; let winner = (out1 && out2) ? (dist(g.p1.x,g.p1.y,cx,cy) > dist(g.p2.x,g.p2.y,cx,cy) ? 'p2' : 'p1') : (out1 ? 'p2' : 'p1'); g.winner = winner; onRoundEnd(winner); }
  g.t += dt;
}

function applyInput(p, inp, dt){
  if(!p.alive) return;
  if(inp.spin && p.spinCooldown<=0 && p.stamina>=PLAYER.spinStaminaCost){ p.stamina -= PLAYER.spinStaminaCost; p.spinT = PLAYER.spinDuration; p.spinCooldown = PLAYER.spinCooldown; p.specialGauge = Math.min(PLAYER.specialGaugeMax, p.specialGauge + 20); const mag = Math.hypot(inp.tx, inp.ty); let dx = mag > 0.05 ? inp.tx/mag : (p===state.game.p1?1:-1), dy = mag > 0.05 ? inp.ty/mag : 0; p.vx += dx * 480; p.vy += dy * 480; }
  if(inp.defend && p.defendCooldown<=0 && p.stamina>=PLAYER.defenseStaminaCost){ p.stamina -= PLAYER.defenseStaminaCost; p.defendT = PLAYER.defenseDuration; p.defendCooldown = PLAYER.defenseCooldown; }
  if(inp.tackle && p.cooldown<=0 && p.stamina>=PLAYER.tackleStaminaCost){ p.stamina -= PLAYER.tackleStaminaCost; p.tackleT = PLAYER.tackleDuration; p.cooldown = PLAYER.tackleCooldown; const mag = Math.hypot(inp.tx, inp.ty); let dx = mag > 0.05 ? inp.tx/mag : (p===state.game.p1?1:-1), dy = mag > 0.05 ? inp.ty/mag : 0; p.vx += dx * 420; p.vy += dy * 420; }
  const accel = (p.tackleT>0 || p.spinT>0) ? PLAYER.tackleAccel : PLAYER.accel;
  p.vx += inp.tx * accel * dt; p.vy += inp.ty * accel * dt;
  const maxV = (p.tackleT>0 || p.spinT>0) ? PLAYER.maxSpeed*1.7 : PLAYER.maxSpeed, sp = Math.hypot(p.vx,p.vy);
  if(sp>maxV){ p.vx*=maxV/sp; p.vy*=maxV/sp; }
  if(sp > 200 && Math.random() < 0.3) spawnDust(p.x, p.y + PLAYER.radius*0.8);
}

function integrate(p, dt){ const f = Math.pow(PLAYER.friction, dt*60); p.vx *= f; p.vy *= f; p.x += p.vx * dt; p.y += p.vy * dt; }
function resolveCollision(a,b){
  const dx = b.x-a.x, dy = b.y-a.y, d = Math.hypot(dx,dy), minD = PLAYER.radius*2;
  if(d <= 0.001 || d >= minD) return;
  const nx = dx/d, ny = dy/d, overlap = (minD-d);
  a.x -= nx*overlap*0.5; a.y -= ny*overlap*0.5; b.x += nx*overlap*0.5; b.y += ny*overlap*0.5;
  const rvx = b.vx-a.vx, rvy = b.vy-a.vy, vn = rvx*nx + rvy*ny;
  if(vn > 0) return;
  let dmg = 1.0; if(a.isDefending) dmg *= 0.5; if(b.isDefending) dmg *= 0.5;
  a.vx -= nx*vn*PLAYER.restitution*dmg; a.vy -= ny*vn*PLAYER.restitution*dmg; b.vx += nx*vn*PLAYER.restitution*dmg; b.vy += ny*vn*PLAYER.restitution*dmg;
  if(a.spinT>0){ b.vx += nx*280; b.vy += ny*280; b.hitT = 0.3; } if(b.spinT>0){ a.vx -= nx*280; a.vy -= ny*280; a.hitT = 0.3; }
  const strength = Math.abs(vn);
  if(strength > 60){
    a.hitT = 0.3; b.hitT = 0.3; navigator.vibrate && navigator.vibrate(20); playSfx('hit');
    spawnImpactFx((a.x+b.x)/2, (a.y+b.y)/2); spawnShockwave((a.x+b.x)/2, (a.y+b.y)/2, strength);
    state.screenShakeIntensity = Math.min(4, strength/150); // 揺れを大幅に抑制
    state.screenShakeTime = 0.12; state.impactFlash = state.impactFlashMax;
    state.comboCount++; state.comboResetTimer = 1.0;
    a.specialGauge = Math.min(PLAYER.specialGaugeMax, a.specialGauge + PLAYER.specialGaugePerHit); b.specialGauge = Math.min(PLAYER.specialGaugeMax, b.specialGauge + PLAYER.specialGaugePerHit);
  }
}

const fxParticles = [];
function spawnImpactFx(x,y){ for(let i=0;i<16;i++){ const a = Math.random()*Math.PI*2, sp = 100 + Math.random()*200; fxParticles.push({ x, y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp, life: 0.4 + Math.random()*0.3, max: 0.7, size: 3 + Math.random()*5, color: Math.random() > 0.5 ? 'rgba(255,200,100,{a})' : 'rgba(255,220,150,{a})' }); } }
function spawnShockwave(x, y, strength){ state.shockwaves.push({ x, y, radius: 0, maxRadius: 60 + strength * 0.2, life: 0.25, max: 0.25 }); }
function spawnDust(x, y){ state.dustParticles.push({ x: x + (Math.random()-0.5)*40, y: y + (Math.random()-0.5)*20, vx: (Math.random()-0.5)*20, vy: -Math.random()*30, life: 0.3 + Math.random()*0.3, max: 0.6, size: 4 + Math.random()*8 }); }
function updateFx(dt){ [fxParticles, state.shockwaves, state.trailParticles, state.dustParticles].forEach(arr => { for(let i=arr.length-1;i>=0;i--){ const p = arr[i]; p.life -= dt; if(p.life <= 0){ arr.splice(i,1); continue; } if(p.vx !== undefined){ p.x += p.vx*dt; p.y += p.vy*dt; p.vx *= 0.92; p.vy *= 0.92; } if(p.radius !== undefined) p.radius = p.maxRadius * (1 - p.life / p.max); } }); }
function drawFx(){ state.shockwaves.forEach(s => { const a = Math.max(0, s.life / s.max); ctx.strokeStyle = `rgba(255,200,100,${a * 0.5})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(s.x, s.y, s.radius, 0, Math.PI*2); ctx.stroke(); }); fxParticles.forEach(p => { const a = Math.max(0, p.life / p.max); ctx.fillStyle = p.color.replace('{a}', a); ctx.beginPath(); ctx.arc(p.x, p.y, p.size*a, 0, Math.PI*2); ctx.fill(); }); state.dustParticles.forEach(p => { const a = Math.max(0, p.life / p.max); ctx.fillStyle = `rgba(180,150,100,${a * 0.3})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size*a, 0, Math.PI*2); ctx.fill(); }); }
function dist(x1,y1,x2,y2){ return Math.hypot(x2-x1, y2-y1); }

function onRoundEnd(winner){
  let myWin = (winner === 'p1'); if(myWin) state.scoreMe++; else state.scoreOp++;
  const matchOver = (state.scoreMe>=ROUND.winsToMatch || state.scoreOp>=ROUND.winsToMatch);
  if(state.mode === 'host') safeSend({ t:'round', hostScore: state.scoreMe, guestScore: state.scoreOp, round: state.round + (matchOver?0:1), banner: (winner==='p1') ? 'host' : (winner==='p2')?'guest':'draw', matchOver });
  updateScoreUI(); showRoundBannerWithSub(myWin? '勝ち！' : '負け…', `${state.scoreMe} － ${state.scoreOp}`, myWin?'red':'blue');
  if(matchOver) setTimeout(()=> showResult(myWin), 1500); else setTimeout(()=> { state.round++; state.game = createInitialGameState(); resetGameState(); startCountdownThenRun(); }, 1700);
}

function sendSnapshot(){
  const now = performance.now(); if (now - lastSnapAt < 33) return; lastSnapAt = now;
  if(!state.conn || !state.conn.open) return;
  const g = state.game; safeSend({ t:'snap', s: { p1: pack(g.p1), p2: pack(g.p2), paused: g.paused, roundEnded: g.roundEnded, score: [state.scoreMe, state.scoreOp], round: state.round } });
}
function pack(p){ return [Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), Math.round(p.stamina), Math.round(p.specialGauge), Math.round(p.tackleT*1000), Math.round(p.spinT*1000), Math.round(p.defendT*1000), Math.round(p.cooldown*1000), p.isDefending?1:0, Math.round(p.hitT*1000)]; }
function unpack(arr){ return { x:arr[0], y:arr[1], vx:arr[2], vy:arr[3], stamina:arr[4], specialGauge:arr[5], tackleT:arr[6]/1000, spinT:arr[7]/1000, defendT:arr[8]/1000, cooldown:arr[9]/1000, isDefending:arr[10]?true:false, hitT:arr[11]/1000, alive:true, color: null }; }
function interpFromSnapshot(){ if(!state.remoteSnapshot) return; const s = state.remoteSnapshot; state.game.p1 = unpack(s.p1); state.game.p1.color = 'red'; state.game.p2 = unpack(s.p2); state.game.p2.color = 'blue'; state.game.paused = !!s.paused; state.game.roundEnded = !!s.roundEnded; if(s.score){ state.scoreOp = s.score[0]; state.scoreMe = s.score[1]; updateScoreUI(); } if(s.round && state.round !== s.round){ state.round = s.round; $('round-label').textContent = `第${state.round}番`; } }

function render(){
  const w = window.innerWidth, h = window.innerHeight; ctx.clearRect(0,0,w,h); ctx.save();
  if(state.screenShakeTime > 0){ const s = state.screenShakeIntensity; ctx.translate((Math.random()-0.5)*s*2, (Math.random()-0.5)*s*2); }
  if(state.impactFlash > 0){ ctx.fillStyle = `rgba(255,255,255,${(state.impactFlash/state.impactFlashMax)*0.2})`; ctx.fillRect(0,0,w,h); }
  ctx.translate(offsetX, offsetY); ctx.scale(scale, scale); if(state.mode === 'guest'){ ctx.translate(ARENA.size, ARENA.size); ctx.rotate(Math.PI); }
  drawDohyo(); let me = state.mode === 'guest' ? state.game.p2 : state.game.p1, op = state.mode === 'guest' ? state.game.p1 : state.game.p2;
  [me, op].forEach(drawShadow); drawRikishi(op, op === state.game.p1 ? '#a8322c' : '#2f4a6b', false); drawRikishi(me, me === state.game.p1 ? '#a8322c' : '#2f4a6b', true); drawFx(); ctx.restore();
  $('stamina-fill').style.width = (me.stamina/PLAYER.staminaMax*100)+'%';
  const sp = $('special-fill'); if(sp) sp.style.width = (me.specialGauge/PLAYER.specialGaugeMax*100)+'%';
  $('btn-tackle').classList.toggle('cooldown', me.stamina < PLAYER.tackleStaminaCost || me.cooldown>0);
  $('btn-spin').classList.toggle('cooldown', me.stamina < PLAYER.spinStaminaCost || me.spinCooldown>0);
  $('btn-defend').classList.toggle('cooldown', me.stamina < PLAYER.defenseStaminaCost || me.defendCooldown>0);
  if(state.comboCount > 1){ ctx.save(); ctx.translate(offsetX + w/2, offsetY + 120); ctx.scale(1/scale, 1/scale); const s = 1 + Math.sin(performance.now()/150)*0.1; ctx.scale(s,s); ctx.fillStyle = 'rgba(255,200,0,0.8)'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5; ctx.fillText(`COMBO x${state.comboCount}`, 0, 0); ctx.restore(); }
}

function drawDohyo(){ const cx = ARENA.size/2, cy = ARENA.size/2; ctx.fillStyle = '#cdb070'; ctx.fillRect(40,40,ARENA.size-80, ARENA.size-80); const g = ctx.createRadialGradient(cx,cy-60,80, cx,cy, ARENA.ringRadius); g.addColorStop(0, '#e3b67a'); g.addColorStop(0.5, '#d4a968'); g.addColorStop(1, '#a76f3a'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx,cy, ARENA.ringRadius, 0, Math.PI*2); ctx.fill(); ctx.lineWidth = 18; ctx.strokeStyle = '#f1e1bc'; ctx.beginPath(); ctx.arc(cx,cy, ARENA.ringRadius-10, 0, Math.PI*2); ctx.stroke(); ctx.lineWidth = 2; ctx.strokeStyle = '#7a5a30'; ctx.beginPath(); ctx.arc(cx,cy, ARENA.ringRadius-10, 0, Math.PI*2); ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(cx-60, cy-4, 120, 8); ctx.fillRect(cx-60, cy-60, 120, 8); ctx.fillRect(cx-60, cy+52, 120, 8); }
function drawShadow(p){ ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(p.x+6, p.y+14, PLAYER.radius*0.95, PLAYER.radius*0.4, 0, 0, Math.PI*2); ctx.fill(); }
function drawRikishi(p, color, isMe){
  const r = PLAYER.radius; ctx.save(); ctx.translate(p.x, p.y);
  const g = ctx.createRadialGradient(-r*0.3, -r*0.3, r*0.1, 0, 0, r); g.addColorStop(0, lighten(color, 0.3)); g.addColorStop(1, color); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = isMe ? '#f5e6c4' : '#dcd0b0'; ctx.beginPath(); ctx.arc(0, 6, r*0.7, 0, Math.PI, false); ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#2b2118'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.stroke();
  ctx.fillStyle = '#2b2118';
  if(p.hitT > 0){ ctx.lineWidth = 3; ctx.strokeStyle = '#2b2118'; ctx.beginPath(); ctx.moveTo(-12, -12); ctx.lineTo(-4, -4); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-4, -12); ctx.lineTo(-12, -4); ctx.stroke(); ctx.beginPath(); ctx.moveTo(4, -12); ctx.lineTo(12, -4); ctx.stroke(); ctx.beginPath(); ctx.moveTo(12, -12); ctx.lineTo(4, -4); ctx.stroke(); }
  else { ctx.beginPath(); ctx.arc(-10, -8, 4, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(10, -8, 4, 0, Math.PI*2); ctx.fill(); }
  if(p.tackleT>0){ ctx.strokeStyle = 'rgba(255,240,180,0.8)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0,0, r+8, 0, Math.PI*2); ctx.stroke(); }
  if(p.spinT>0){ ctx.strokeStyle = 'rgba(200,255,100,0.8)'; ctx.lineWidth = 6; const rot = (performance.now()/100)%(Math.PI*2); ctx.beginPath(); ctx.arc(0,0, r+12, rot, rot+Math.PI*0.8); ctx.stroke(); }
  if(p.isDefending){ ctx.strokeStyle = 'rgba(100,150,255,0.7)'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(0,0, r+16, 0, Math.PI*2); ctx.stroke(); }
  if(isMe){ ctx.fillStyle = '#fff'; ctx.font = 'bold 20px "Hiragino Mincho ProN", serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 3; if(state.mode === 'guest'){ ctx.rotate(Math.PI); ctx.fillText('己', 0, r+15); } else { ctx.fillText('己', 0, -r-15); } }
  ctx.restore();
}
function lighten(hex, amt){ const c = hex.replace('#',''); const r = parseInt(c.slice(0,2),16), g = parseInt(c.slice(2,4),16), b = parseInt(c.slice(4,6),16), f = (v)=> Math.min(255, Math.round(v + (255-v)*amt)); return `rgb(${f(r)},${f(g)},${f(b)})`; }
function showResult(win){ state.matchOver = true; state.game.paused = true; $('result-title').textContent = win ? '勝利！' : '敗北…'; $('result-sub').textContent = win ? 'あなたの勝ちです！' : '相手の勝ちです…'; showScreen('result'); }
document.addEventListener('DOMContentLoaded', () => { setupCanvas(); attachUI(); showScreen('lobby'); });
})();
