/* =========================================================
   土俵バトル - 1vs1 ジャイロ相撲 (大幅リニューアル版 v2)
   - PeerJS で合言葉マッチング (host/guest 決定はID辞書順)
   - WebRTC DataChannel で 入力同期 (authoritative host)
   - ジャイロ操作 + 複数アクションボタン
   - スペシャルアクション、コンボシステム、画面エフェクト
   - 強化版: キャラクターデザイン、高度なエフェクト、ジャイロ感度改善
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
  // スペシャルアクション
  spinAccel: 6500,
  spinDuration: 0.35,
  spinStaminaCost: 50,
  spinCooldown: 1.5,
  defenseStaminaCost: 25,
  defenseCooldown: 0.8,
  defenseDuration: 0.4,
  // ゲージ
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

// ジャイロ感度改善用定数
const GYRO = {
  deadZone: 3,
  fullZone: 25,
  maxTilt: 1.0,
  smoothing: 0.85,
  accelerationFactor: 1.2,
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
  cpuDifficulty: 'normal', // 'easy', 'normal', 'hard'
  // エフェクト
  screenShakeIntensity: 0,
  screenShakeTime: 0,
  comboCount: 0,
  comboResetTimer: 0,
  // 新規: 高度なエフェクト管理
  impactFlash: 0,
  impactFlashMax: 0.15,
  shockwaves: [],
  trailParticles: [],
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
  return {
    A: `sumob-${tag}-A`,
    B: `sumob-${tag}-B`,
  };
}

function createPeer(id){
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, { debug: 1 });
    let done = false;
    peer.on('open', (pid) => { if(!done){done=true; resolve(peer);} });
    peer.on('error', (err) => {
      if(done) return;
      done = true;
      reject(err);
    });
    setTimeout(() => { if(!done){done=true; reject(new Error('peer-timeout'));} }, 8000);
  });
}

async function startMatchmaking(phrase){
  setStatus('接続中…', false);
  const ids = makeIds(phrase);
  state.passphrase = phrase;

  try{
    const peer = await createPeer(ids.A);
    state.peer = peer;
    state.myPeerId = ids.A;
    state.opPeerId = ids.B;
    state.mode = 'host';
    setStatus('相手を待っています…（合言葉: ' + phrase + '）');

    peer.on('connection', (conn) => {
      state.conn = conn;
      attachConn(conn);
    });
    peer.on('error', (err) => {
      console.warn('peer err', err);
    });
  }catch(err){
    if(String(err && (err.type||err.message||'')).includes('unavailable') || (err && err.type === 'unavailable-id')){
      try{
        const peer = await createPeer(ids.B);
        state.peer = peer;
        state.myPeerId = ids.B;
        state.opPeerId = ids.A;
        state.mode = 'guest';
        setStatus('部屋に入っています…');
        const conn = peer.connect(ids.A, { reliable: false, serialization: 'json' });
        state.conn = conn;
        attachConn(conn);
      }catch(err2){
        setStatus('接続に失敗しました: ' + (err2.message||err2.type||err2), true);
      }
    } else {
      setStatus('接続に失敗しました: ' + (err.message||err.type||err), true);
    }
  }
}

function attachConn(conn){
  conn.on('open', () => {
    setStatus('接続完了！ ゲーム開始準備中…');
    onConnected();
  });
  conn.on('data', (data) => onPeerData(data));
  conn.on('close', () => {
    setStatus('相手との接続が切れました', true);
    endMatchAbort();
  });
  conn.on('error', (e) => {
    setStatus('通信エラー: ' + (e.message||e), true);
  });
}

function safeSend(obj){
  try{
    if(state.conn && state.conn.open){
      state.conn.send(obj);
    }
  }catch(e){ /* ignore */ }
}

// ---------- Connection established ----------
function onConnected(){
  state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false;
  enterGame();
}

// ---------- Network protocol ----------
function onPeerData(data){
  if(!data || typeof data !== 'object') return;
  switch(data.t){
    case 'snap':
      state.prevSnapshot = state.remoteSnapshot;
      state.remoteSnapshot = data.s;
      state.snapshotTime = performance.now();
      break;
    case 'in':
      if(state.mode==='host'){
        state.opInput = data.i;
      }
      break;
    case 'round':
      if(state.mode==='guest'){
        state.scoreMe = data.guestScore;
        state.scoreOp = data.hostScore;
        state.round = data.round;
        updateScoreUI();
        $('round-label').textContent = `第${state.round}番`;
        const guestWon = (data.banner === 'guest');
        const hostWon  = (data.banner === 'host');
        const txt = guestWon ? '勝ち！' : (hostWon ? '負け…' : '引分');
        const cls = guestWon ? 'red'   : (hostWon ? 'blue' : '');
        showRoundBannerWithSub(txt, `${state.scoreMe} － ${state.scoreOp}`, cls);
        if(data.matchOver){
          setTimeout(()=> showResult(state.scoreMe>state.scoreOp), 1500);
        } else {
          setTimeout(()=> hideBanner(), 1700);
        }
      }
      break;
    case 'rematch':
      if(state.mode==='host'){
        startNewMatch();
      }
      break;
  }
}

// ---------- Motion (Gyro) ----------
async function ensureMotionPermission(){
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'){
    try{
      const res = await DeviceOrientationEvent.requestPermission();
      if(res !== 'granted') return false;
    }catch(e){ return false; }
  }
  state.myMotionEnabled = true;
  attachOrientation();
  return true;
}

let _orientationAttached = false;
function attachOrientation(){
  if(_orientationAttached) return;
  _orientationAttached = true;
  window.addEventListener('deviceorientation', (e) => {
    const g = e.gamma;
    const b = e.beta;
    if(g == null || b == null) return;
    state.motionRaw.gamma = g;
    state.motionRaw.beta = b;
    if(!state.hasReceivedMotion){
      state.motionCalibration.gamma = g;
      state.motionCalibration.beta  = b;
      state.hasReceivedMotion = true;
    }
    const dg = g - state.motionCalibration.gamma;
    const db = b - state.motionCalibration.beta;
    
    // 改善版: より精密なジャイロ処理
    let tx = softZone(dg, GYRO.deadZone, GYRO.fullZone);
    let ty = softZone(db, GYRO.deadZone, GYRO.fullZone);
    
    // 加速度による感度調整
    const tiltMagnitude = Math.hypot(tx, ty);
    if(tiltMagnitude > 0.3){
      const factor = 1 + (tiltMagnitude - 0.3) * GYRO.accelerationFactor * 0.5;
      tx *= factor;
      ty *= factor;
    }
    
    tx = clamp(tx, -GYRO.maxTilt, GYRO.maxTilt);
    ty = clamp(ty, -GYRO.maxTilt, GYRO.maxTilt);
    
    // スムージング
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
  if(!audioCtx){
    try { audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
    catch(e){ return; }
  }
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
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate*0.08, audioCtx.sampleRate);
    const d = buf.getChannelData(0); for(let i=0;i<d.length;i++) d[i] = (Math.random()*2-1) * (1 - i/d.length);
    const n = audioCtx.createBufferSource(), ng = audioCtx.createGain();
    n.buffer = buf; ng.gain.value = 0.18;
    n.connect(ng).connect(audioCtx.destination); n.start(t0); n.stop(t0+0.08);
  } else if(kind === 'combo'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(880, t0); o.frequency.exponentialRampToValueAtTime(440, t0+0.15);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.2, t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.18);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.2);
  } else if(kind === 'bell'){
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(523, t0); o.frequency.exponentialRampToValueAtTime(330, t0+0.5);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0+0.05); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.55);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.6);
  }
}

// ---------- UI Controls ----------
function attachUI(){
  const passInput = $('passphrase');
  const btnMatch = $('btn-match');
  const btnSolo = $('btn-solo');
  const btnEnableMotion = $('btn-enable-motion');
  const btnTackle = $('btn-tackle');
  const btnSpin = $('btn-spin');
  const btnDefend = $('btn-defend');
  const btnRematch = $('btn-rematch');
  const btnBack = $('btn-back');

  if(btnMatch) btnMatch.addEventListener('click', () => {
    const phrase = passInput.value.trim();
    if(phrase.length < 2) { setStatus('合言葉は2文字以上で入力してください', true); return; }
    ensureAudio();
    startMatchmaking(phrase);
  });

  if(btnSolo) btnSolo.addEventListener('click', () => {
    ensureAudio();
    state.mode = 'cpu';
    state.cpuDifficulty = 'normal';
    state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false;
    enterGame();
  });

  if(btnEnableMotion) btnEnableMotion.addEventListener('click', async () => {
    const ok = await ensureMotionPermission();
    if(ok){
      $('enable-motion').classList.add('hidden');
    } else {
      setStatus('動きセンサーの許可に失敗しました', true);
    }
  });

  if(btnTackle) btnTackle.addEventListener('click', () => {
    state.myInput.tackle = true;
    ensureAudio();
    playSfx('tackle');
  });

  if(btnSpin) btnSpin.addEventListener('click', () => {
    state.myInput.spin = true;
    ensureAudio();
    playSfx('spin');
  });

  if(btnDefend) btnDefend.addEventListener('click', () => {
    state.myInput.defend = true;
    ensureAudio();
    playSfx('defend');
  });

  if(btnRematch) btnRematch.addEventListener('click', () => {
    if(state.mode === 'host'){
      startNewMatch();
    } else if(state.mode === 'guest'){
      safeSend({ t:'rematch' });
    }
  });

  if(btnBack) btnBack.addEventListener('click', () => {
    location.reload();
  });

  // Keyboard fallback
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
  canvas.addEventListener('touchstart', (e) => {
    if(e.touches.length > 0){
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    }
  });
  canvas.addEventListener('touchmove', (e) => {
    if(e.touches.length > 0){
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const dx = x - touchX;
      const dy = y - touchY;
      const mag = Math.hypot(dx, dy);
      if(mag > 5){
        state.myInput.tx = clamp(dx / 100, -1, 1);
        state.myInput.ty = clamp(dy / 100, -1, 1);
      }
    }
  });
}

function enterGame(){
  showScreen('game');
  state.game = createInitialGameState();
  startCountdownThenRun();
  if(!state.myMotionEnabled && state.mode !== 'cpu'){
    $('enable-motion').classList.remove('hidden');
  }
}

function startNewMatch(){
  state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false;
  state.game = createInitialGameState();
  startCountdownThenRun();
}

function endMatchAbort(){
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  showScreen('lobby');
}

function cpuThink(dt){
  const me = state.game.p1;
  const op = state.game.p2;
  const dx = op.x - me.x;
  const dy = op.y - me.y;
  const dist = Math.hypot(dx, dy);
  const mag = dist > 0.1 ? 1 : 0;
  
  state.opInput.tx = (mag > 0) ? dx / dist * 0.7 : 0;
  state.opInput.ty = (mag > 0) ? dy / dist * 0.7 : 0;
  
  const difficulty = state.cpuDifficulty;
  const rand = Math.random();
  
  if(difficulty === 'easy'){
    if(dist < 200 && rand < 0.15) state.opInput.tackle = true;
    if(dist < 150 && rand < 0.08) state.opInput.spin = true;
    if(dist < 100 && rand < 0.1) state.opInput.defend = true;
  } else if(difficulty === 'normal'){
    if(dist < 250 && rand < 0.25) state.opInput.tackle = true;
    if(dist < 180 && rand < 0.15) state.opInput.spin = true;
    if(dist < 120 && rand < 0.2) state.opInput.defend = true;
  } else {
    if(dist < 280 && rand < 0.35) state.opInput.tackle = true;
    if(dist < 200 && rand < 0.25) state.opInput.spin = true;
    if(dist < 150 && rand < 0.3) state.opInput.defend = true;
  }
}

function resetGameState(){
  state.screenShakeIntensity = 0;
  state.screenShakeTime = 0;
  state.comboCount = 0;
  state.comboResetTimer = 0;
  state.impactFlash = 0;
  state.shockwaves = [];
  state.trailParticles = [];
}

function createInitialGameState(){
  return {
    p1: { 
      x: ARENA.size*0.5 - 180, y: ARENA.size*0.5, 
      vx:0, vy:0, 
      stamina: PLAYER.staminaMax, 
      specialGauge: 0,
      tackleT:0, spinT:0, defendT:0, 
      cooldown:0, spinCooldown:0, defendCooldown:0, 
      color:'red', alive:true,
      isDefending: false,
    },
    p2: { 
      x: ARENA.size*0.5 + 180, y: ARENA.size*0.5, 
      vx:0, vy:0, 
      stamina: PLAYER.staminaMax, 
      specialGauge: 0,
      tackleT:0, spinT:0, defendT:0, 
      cooldown:0, spinCooldown:0, defendCooldown:0, 
      color:'blue', alive:true,
      isDefending: false,
    },
    t: 0,
    paused: true,
    countdown: ROUND.startCountdown,
    roundEnded: false,
    winner: null,
  };
}

function startCountdownThenRun(){
  $('round-label').textContent = `第${state.round}番`;
  updateScoreUI();

  state.game.paused = true;
  state.game.roundEnded = false;
  showRoundBannerWithSub(`第${state.round}番`, '構えて…', '');
  if(!state.rafId){
    state.lastTime = performance.now();
    loop();
  }
  setTimeout(() => {
    showRoundBannerWithSub('はっけよい', '残った！', '');
    playSfx('bell');
    setTimeout(() => {
      hideBanner();
      state.game.paused = false;
    }, 600);
  }, 1100);
}

function updateScoreUI(){
  $('score-me').textContent = state.scoreMe;
  $('score-op').textContent = state.scoreOp;
}

// ---------- Banner ----------
function showRoundBanner(text, cls=''){
  const b = $('banner');
  b.classList.remove('hidden');
  b.innerHTML = `<div class="inner ${cls}">${text}</div>`;
}
function showRoundBannerWithSub(text, sub, cls=''){
  const b = $('banner');
  b.classList.remove('hidden');
  b.innerHTML = `<div class="inner ${cls}">${text}<div class="sub">${sub}</div></div>`;
}
function hideBanner(){ $('banner').classList.add('hidden'); }

// ---------- Canvas ----------
let canvas, ctx, scale=1, offsetX=0, offsetY=0;
function setupCanvas(){
  canvas = $('canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  attachTouchFallback(canvas);
}
function resizeCanvas(){
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w*dpr;
  canvas.height = h*dpr;
  canvas.style.width = w+'px';
  canvas.style.height = h+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);

  const minDim = Math.min(w,h);
  scale = (minDim*0.94) / ARENA.size;
  offsetX = (w - ARENA.size*scale)/2;
  offsetY = (h - ARENA.size*scale)/2;
}

// ---------- Main loop ----------
function loop(){
  state.rafId = requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - state.lastTime)/1000;
  state.lastTime = now;
  if(dt > 0.05) dt = 0.05;

  state.myInput.tx = state.motionTilt.x;
  state.myInput.ty = state.motionTilt.y;

  if(state.mode === 'host' || state.mode === 'cpu'){
    if(state.mode === 'cpu'){
      cpuThink(dt);
    }
    simulate(dt);
    if(state.mode === 'host'){
      sendSnapshot();
    }
    state.myInput.tackle = false;
    state.myInput.spin = false;
    state.myInput.defend = false;
    state.opInput.tackle = false;
    state.opInput.spin = false;
    state.opInput.defend = false;
    updateFx(dt);
  } else if (state.mode === 'guest'){
    state.myInput.seq = (state.myInput.seq+1)|0;
    safeSend({ t:'in', i: {
      tx: -state.myInput.tx,
      ty: -state.myInput.ty,
      tackle: state.myInput.tackle,
      spin: state.myInput.spin,
      defend: state.myInput.defend,
      seq: state.myInput.seq
    }});
    state.myInput.tackle = false;
    state.myInput.spin = false;
    state.myInput.defend = false;
    interpFromSnapshot();
    updateFx(dt);
  }

  // Update screen shake
  state.screenShakeTime -= dt;
  if(state.screenShakeTime < 0) state.screenShakeTime = 0;

  // Update combo timer
  state.comboResetTimer -= dt;
  if(state.comboResetTimer < 0){
    state.comboCount = 0;
  }

  // Update impact flash
  state.impactFlash -= dt;
  if(state.impactFlash < 0) state.impactFlash = 0;

  render();
}

// ---------- Simulation ----------
function simulate(dt){
  const g = state.game;
  if(g.paused){
    return;
  }
  if(g.roundEnded) return;

  applyInput(g.p1, state.myInput, dt);
  applyInput(g.p2, state.opInput, dt);

  integrate(g.p1, dt);
  integrate(g.p2, dt);

  resolveCollision(g.p1, g.p2);

  g.p1.stamina = Math.min(PLAYER.staminaMax, g.p1.stamina + PLAYER.staminaRegen*dt);
  g.p2.stamina = Math.min(PLAYER.staminaMax, g.p2.stamina + PLAYER.staminaRegen*dt);

  g.p1.tackleT = Math.max(0, g.p1.tackleT - dt);
  g.p2.tackleT = Math.max(0, g.p2.tackleT - dt);
  g.p1.spinT = Math.max(0, g.p1.spinT - dt);
  g.p2.spinT = Math.max(0, g.p2.spinT - dt);
  g.p1.defendT = Math.max(0, g.p1.defendT - dt);
  g.p2.defendT = Math.max(0, g.p2.defendT - dt);
  g.p1.cooldown = Math.max(0, g.p1.cooldown - dt);
  g.p2.cooldown = Math.max(0, g.p2.cooldown - dt);
  g.p1.spinCooldown = Math.max(0, g.p1.spinCooldown - dt);
  g.p2.spinCooldown = Math.max(0, g.p2.spinCooldown - dt);
  g.p1.defendCooldown = Math.max(0, g.p1.defendCooldown - dt);
  g.p2.defendCooldown = Math.max(0, g.p2.defendCooldown - dt);

  g.p1.isDefending = g.p1.defendT > 0;
  g.p2.isDefending = g.p2.defendT > 0;

  const cx = ARENA.size/2, cy = ARENA.size/2;
  const r = ARENA.ringRadius;
  const out1 = dist(g.p1.x,g.p1.y,cx,cy) > r + 4;
  const out2 = dist(g.p2.x,g.p2.y,cx,cy) > r + 4;

  if(out1 || out2){
    g.roundEnded = true;
    let winner = null;
    if(out1 && out2){
      const d1 = dist(g.p1.x,g.p1.y,cx,cy);
      const d2 = dist(g.p2.x,g.p2.y,cx,cy);
      winner = (d1>d2) ? 'p2' : 'p1';
    } else if(out1) winner = 'p2';
    else winner = 'p1';
    g.winner = winner;
    onRoundEnd(winner);
  }

  g.t += dt;
}

function applyInput(p, inp, dt){
  if(!p.alive) return;

  // Spin attack
  if(inp.spin && p.spinCooldown<=0 && p.stamina>=PLAYER.spinStaminaCost){
    p.stamina -= PLAYER.spinStaminaCost;
    p.spinT = PLAYER.spinDuration;
    p.spinCooldown = PLAYER.spinCooldown;
    p.specialGauge = Math.min(PLAYER.specialGaugeMax, p.specialGauge + 20);
    const mag = Math.hypot(inp.tx, inp.ty);
    let dx, dy;
    if(mag > 0.05){ dx = inp.tx/mag; dy = inp.ty/mag; }
    else {
      const vmag = Math.hypot(p.vx,p.vy);
      if(vmag>1){ dx = p.vx/vmag; dy = p.vy/vmag; }
      else { dx = (p===state.game.p1?1:-1); dy = 0; }
    }
    p.vx += dx * 480;
    p.vy += dy * 480;
  }

  // Defend
  if(inp.defend && p.defendCooldown<=0 && p.stamina>=PLAYER.defenseStaminaCost){
    p.stamina -= PLAYER.defenseStaminaCost;
    p.defendT = PLAYER.defenseDuration;
    p.defendCooldown = PLAYER.defenseCooldown;
  }

  // Tackle
  if(inp.tackle && p.cooldown<=0 && p.stamina>=PLAYER.tackleStaminaCost){
    p.stamina -= PLAYER.tackleStaminaCost;
    p.tackleT = PLAYER.tackleDuration;
    p.cooldown = PLAYER.tackleCooldown;
    const mag = Math.hypot(inp.tx, inp.ty);
    let dx, dy;
    if(mag > 0.05){ dx = inp.tx/mag; dy = inp.ty/mag; }
    else {
      const vmag = Math.hypot(p.vx,p.vy);
      if(vmag>1){ dx = p.vx/vmag; dy = p.vy/vmag; }
      else { dx = (p===state.game.p1?1:-1); dy = 0; }
    }
    p.vx += dx * 420;
    p.vy += dy * 420;
  }

  const accel = (p.tackleT>0 || p.spinT>0) ? PLAYER.tackleAccel : PLAYER.accel;
  p.vx += inp.tx * accel * dt;
  p.vy += inp.ty * accel * dt;

  const maxV = (p.tackleT>0 || p.spinT>0) ? PLAYER.maxSpeed*1.7 : PLAYER.maxSpeed;
  const sp = Math.hypot(p.vx,p.vy);
  if(sp>maxV){ p.vx*=maxV/sp; p.vy*=maxV/sp; }
}

function integrate(p, dt){
  const f = Math.pow(PLAYER.friction, dt*60);
  p.vx *= f; p.vy *= f;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

function resolveCollision(a,b){
  const dx = b.x-a.x, dy = b.y-a.y;
  const d = Math.hypot(dx,dy);
  const minD = PLAYER.radius*2;
  if(d <= 0.001 || d >= minD) return;
  const nx = dx/d, ny = dy/d;
  const overlap = (minD-d);
  a.x -= nx*overlap*0.5; a.y -= ny*overlap*0.5;
  b.x += nx*overlap*0.5; b.y += ny*overlap*0.5;
  const rvx = b.vx-a.vx, rvy = b.vy-a.vy;
  const vn = rvx*nx + rvy*ny;
  if(vn > 0) return;

  // Defense damage reduction
  let damageMultiplier = 1.0;
  if(a.isDefending) damageMultiplier *= 0.5;
  if(b.isDefending) damageMultiplier *= 0.5;

  a.vx -= nx*vn*PLAYER.restitution*damageMultiplier;
  a.vy -= ny*vn*PLAYER.restitution*damageMultiplier;
  b.vx += nx*vn*PLAYER.restitution*damageMultiplier;
  b.vy += ny*vn*PLAYER.restitution*damageMultiplier;

  if(a.spinT>0){ b.vx += nx*280; b.vy += ny*280; }
  if(b.spinT>0){ a.vx -= nx*280; a.vy -= ny*280; }

  const strength = Math.abs(vn);
  if(strength > 60){
    navigator.vibrate && navigator.vibrate(20);
    playSfx('hit');
    spawnImpactFx((a.x+b.x)/2, (a.y+b.y)/2);
    spawnShockwave((a.x+b.x)/2, (a.y+b.y)/2, strength);
    state.screenShakeIntensity = Math.min(8, strength/100);
    state.screenShakeTime = 0.15;
    state.impactFlash = state.impactFlashMax;
    state.comboCount++;
    state.comboResetTimer = 1.0;
    if(state.comboCount > 1){
      playSfx('combo');
    }
    a.specialGauge = Math.min(PLAYER.specialGaugeMax, a.specialGauge + PLAYER.specialGaugePerHit);
    b.specialGauge = Math.min(PLAYER.specialGaugeMax, b.specialGauge + PLAYER.specialGaugePerHit);
  }
}

// ---------- FX particles ----------
const fxParticles = [];
function spawnImpactFx(x,y){
  for(let i=0;i<24;i++){
    const a = Math.random()*Math.PI*2;
    const sp = 100 + Math.random()*280;
    fxParticles.push({
      x, y,
      vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
      life: 0.5 + Math.random()*0.4,
      max: 0.8,
      size: 4 + Math.random()*7,
      color: Math.random() > 0.5 ? 'rgba(255,200,100,{a})' : 'rgba(255,220,150,{a})',
    });
  }
}

function spawnShockwave(x, y, strength){
  state.shockwaves.push({
    x, y,
    radius: 0,
    maxRadius: 80 + strength * 0.3,
    life: 0.3,
    max: 0.3,
  });
}

function spawnTrailParticles(x, y, vx, vy){
  for(let i=0;i<3;i++){
    const angle = Math.atan2(vy, vx) + (Math.random() - 0.5) * 0.5;
    const speed = Math.hypot(vx, vy) * 0.5;
    state.trailParticles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.2 + Math.random() * 0.1,
      max: 0.3,
      size: 3 + Math.random() * 3,
    });
  }
}

function updateFx(dt){
  for(let i=fxParticles.length-1;i>=0;i--){
    const p = fxParticles[i];
    p.life -= dt;
    if(p.life <= 0){ fxParticles.splice(i,1); continue; }
    p.x += p.vx*dt; p.y += p.vy*dt;
    p.vx *= 0.92; p.vy *= 0.92;
  }

  for(let i=state.shockwaves.length-1;i>=0;i--){
    const s = state.shockwaves[i];
    s.life -= dt;
    if(s.life <= 0){ state.shockwaves.splice(i,1); continue; }
    s.radius = s.maxRadius * (1 - s.life / s.max);
  }

  for(let i=state.trailParticles.length-1;i>=0;i--){
    const p = state.trailParticles[i];
    p.life -= dt;
    if(p.life <= 0){ state.trailParticles.splice(i,1); continue; }
    p.x += p.vx*dt; p.y += p.vy*dt;
    p.vx *= 0.88; p.vy *= 0.88;
  }
}

function drawFx(){
  // Draw shockwaves
  for(const s of state.shockwaves){
    const a = Math.max(0, s.life / s.max);
    ctx.strokeStyle = `rgba(255,200,100,${a * 0.6})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.radius, 0, Math.PI*2);
    ctx.stroke();
  }

  // Draw impact particles
  for(const p of fxParticles){
    const a = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color.replace('{a}', a);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size*a, 0, Math.PI*2);
    ctx.fill();
  }

  // Draw trail particles
  for(const p of state.trailParticles){
    const a = Math.max(0, p.life / p.max);
    ctx.fillStyle = `rgba(200,220,255,${a * 0.5})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size*a, 0, Math.PI*2);
    ctx.fill();
  }
}

function dist(x1,y1,x2,y2){ const dx=x2-x1, dy=y2-y1; return Math.hypot(dx,dy); }

// ---------- Round end ----------
function onRoundEnd(winner){
  let myWin = (winner === 'p1');
  if(state.mode === 'cpu'){
  }
  if(myWin) state.scoreMe++; else state.scoreOp++;
  const matchOver = (state.scoreMe>=ROUND.winsToMatch || state.scoreOp>=ROUND.winsToMatch);
  if(state.mode === 'host'){
    safeSend({
      t:'round',
      hostScore: state.scoreMe,
      guestScore: state.scoreOp,
      round: state.round + (matchOver?0:1),
      banner: (winner==='p1') ? 'host' : (winner==='p2')?'guest':'draw',
      matchOver
    });
  }
  updateScoreUI();
  showRoundBannerWithSub(myWin? '勝ち！' : '負け…', `${state.scoreMe} － ${state.scoreOp}`, myWin?'red':'blue');
  if(matchOver){
    setTimeout(()=> showResult(myWin), 1500);
  } else {
    setTimeout(()=> {
      state.round++;
      state.game = createInitialGameState();
      resetGameState();
      startCountdownThenRun();
    }, 1700);
  }
}

// ---------- Snapshot for guest ----------
let lastSnapAt = 0;
function sendSnapshot(){
  const now = performance.now();
  if (now - lastSnapAt < 33) return;
  lastSnapAt = now;
  if(!state.conn || !state.conn.open) return;
  const g = state.game;
  const snap = {
    p1: pack(g.p1),
    p2: pack(g.p2),
    paused: g.paused,
    roundEnded: g.roundEnded,
    score: [state.scoreMe, state.scoreOp],
    round: state.round,
  };
  safeSend({ t:'snap', s: snap });
}
function pack(p){
  return [Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), Math.round(p.stamina), Math.round(p.specialGauge), Math.round(p.tackleT*1000), Math.round(p.spinT*1000), Math.round(p.defendT*1000), Math.round(p.cooldown*1000), p.isDefending?1:0];
}
function unpack(arr){
  return { x:arr[0], y:arr[1], vx:arr[2], vy:arr[3], stamina:arr[4], specialGauge:arr[5], tackleT:arr[6]/1000, spinT:arr[7]/1000, defendT:arr[8]/1000, cooldown:arr[9]/1000, isDefending:arr[10]?true:false, alive:true, color: null };
}

function interpFromSnapshot(){
  if(!state.remoteSnapshot) return;
  const s = state.remoteSnapshot;
  const p1 = unpack(s.p1); p1.color = 'red';
  const p2 = unpack(s.p2); p2.color = 'blue';
  state.game.p1 = p1;
  state.game.p2 = p2;
  state.game.paused = !!s.paused;
  state.game.roundEnded = !!s.roundEnded;
  if(s.score){
    state.scoreOp = s.score[0];
    state.scoreMe = s.score[1];
    updateScoreUI();
  }
  if(s.round){
    if(state.round !== s.round){
      state.round = s.round;
      $('round-label').textContent = `第${state.round}番`;
    }
  }
}

// ---------- Render ----------
function render(){
  const w = window.innerWidth, h = window.innerHeight;
  ctx.clearRect(0,0,w,h);

  ctx.save();
  
  // Screen shake effect
  if(state.screenShakeTime > 0){
    const shake = state.screenShakeIntensity;
    const shakeX = (Math.random() - 0.5) * shake * 2;
    const shakeY = (Math.random() - 0.5) * shake * 2;
    ctx.translate(shakeX, shakeY);
  }

  // Impact flash effect
  if(state.impactFlash > 0){
    const flashAlpha = (state.impactFlash / state.impactFlashMax) * 0.3;
    ctx.fillStyle = `rgba(255,255,255,${flashAlpha})`;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  if(state.mode === 'guest'){
    ctx.translate(ARENA.size, ARENA.size);
    ctx.rotate(Math.PI);
  }

  drawDohyo();

  let me, op;
  if(state.mode === 'guest'){
    me = state.game.p2; op = state.game.p1;
  } else {
    me = state.game.p1; op = state.game.p2;
  }

  drawShadow(me); drawShadow(op);
  drawRikishi(op, op === state.game.p1 ? '#a8322c' : '#2f4a6b', false);
  drawRikishi(me, me === state.game.p1 ? '#a8322c' : '#2f4a6b', true);
  drawFx();

  ctx.restore();

  // UI
  const myStamina = me.stamina;
  const mySpecial = me.specialGauge;
  $('stamina-fill').style.width = (myStamina/PLAYER.staminaMax*100)+'%';
  const specialEl = $('special-fill');
  if(specialEl){
    specialEl.style.width = (mySpecial/PLAYER.specialGaugeMax*100)+'%';
  }

  const btnTackle = $('btn-tackle');
  if(btnTackle){
    btnTackle.classList.toggle('cooldown', myStamina < PLAYER.tackleStaminaCost || me.cooldown>0);
  }
  const btnSpin = $('btn-spin');
  if(btnSpin){
    btnSpin.classList.toggle('cooldown', myStamina < PLAYER.spinStaminaCost || me.spinCooldown>0);
  }
  const btnDefend = $('btn-defend');
  if(btnDefend){
    btnDefend.classList.toggle('cooldown', myStamina < PLAYER.defenseStaminaCost || me.defendCooldown>0);
  }

  // Combo display - enhanced
  if(state.comboCount > 1){
    ctx.save();
    ctx.translate(offsetX + window.innerWidth/2, offsetY + 120);
    ctx.scale(1/scale, 1/scale);
    const comboScale = 1 + Math.sin(performance.now() / 150) * 0.1;
    ctx.scale(comboScale, comboScale);
    ctx.fillStyle = 'rgba(255,200,0,0.9)';
    ctx.font = 'bold 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.fillText(`COMBO x${state.comboCount}`, 0, 0);
    ctx.restore();
  }

  if(state.game.paused){
    drawCountdown(w,h);
  }
}

function drawDohyo(){
  const cx = ARENA.size/2, cy = ARENA.size/2;
  
  // 土俵の背景
  ctx.fillStyle = '#cdb070';
  ctx.fillRect(40,40,ARENA.size-80, ARENA.size-80);
  
  // 土俵の枠
  ctx.strokeStyle = '#6b4a22';
  ctx.lineWidth = 6;
  ctx.strokeRect(40,40,ARENA.size-80, ARENA.size-80);

  // 円形の土俵
  const grad = ctx.createRadialGradient(cx,cy-60,80, cx,cy, ARENA.ringRadius);
  grad.addColorStop(0, '#e3b67a');
  grad.addColorStop(0.5, '#d4a968');
  grad.addColorStop(1, '#a76f3a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx,cy, ARENA.ringRadius, 0, Math.PI*2);
  ctx.fill();

  // 土俵の外枠（白）
  ctx.lineWidth = 18;
  ctx.strokeStyle = '#f1e1bc';
  ctx.beginPath();
  ctx.arc(cx,cy, ARENA.ringRadius-10, 0, Math.PI*2);
  ctx.stroke();
  
  // 土俵の外枠（黒）
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#7a5a30';
  ctx.beginPath();
  ctx.arc(cx,cy, ARENA.ringRadius-10, 0, Math.PI*2);
  ctx.stroke();

  // 中央ラインと装飾
  ctx.fillStyle = '#fff';
  ctx.fillRect(cx-50, cy-2, 100, 4);
  ctx.fillRect(cx-50, cy-50, 100, 4);
  ctx.fillRect(cx-50, cy+46, 100, 4);
  
  // 土俵の質感を追加
  ctx.strokeStyle = 'rgba(0,0,0,0.1)';
  ctx.lineWidth = 1;
  for(let i=0;i<8;i++){
    const angle = (i / 8) * Math.PI * 2;
    const x1 = cx + Math.cos(angle) * (ARENA.ringRadius - 20);
    const y1 = cy + Math.sin(angle) * (ARENA.ringRadius - 20);
    const x2 = cx + Math.cos(angle) * ARENA.ringRadius;
    const y2 = cy + Math.sin(angle) * ARENA.ringRadius;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

function drawShadow(p){
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(p.x+6, p.y+14, PLAYER.radius*0.95, PLAYER.radius*0.4, 0, 0, Math.PI*2);
  ctx.fill();
}

function drawRikishi(p, color, isMe){
  const r = PLAYER.radius;
  
  // 体のグラデーション
  const grad = ctx.createRadialGradient(p.x-r*0.3, p.y-r*0.3, r*0.1, p.x, p.y, r);
  grad.addColorStop(0, lighten(color, 0.25));
  grad.addColorStop(0.6, lighten(color, 0.1));
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI*2);
  ctx.fill();

  // mawashi（褌）
  ctx.fillStyle = isMe ? '#f5e6c4' : '#dcd0b0';
  ctx.beginPath();
  ctx.arc(p.x, p.y+6, r*0.7, 0, Math.PI, false);
  ctx.fill();
  
  // mawashi の装飾
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y+6, r*0.7, 0, Math.PI, false);
  ctx.stroke();

  // 体の輪郭
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#2b2118';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI*2);
  ctx.stroke();

  // tackle aura - 強化版
  if(p.tackleT>0){
    const tackleAlpha = p.tackleT / PLAYER.tackleDuration;
    ctx.strokeStyle = `rgba(255,240,180,${0.8 * tackleAlpha})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(p.x,p.y, r+10, 0, Math.PI*2);
    ctx.stroke();
    
    ctx.strokeStyle = `rgba(255,255,200,${0.6 * tackleAlpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x,p.y, r+18, 0, Math.PI*2);
    ctx.stroke();
    
    const dir = Math.atan2(p.vy, p.vx);
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * tackleAlpha})`;
    ctx.lineWidth = 4;
    for(let i=0;i<6;i++){
      const a = dir + (i-2.5)*0.12;
      const x1 = p.x - Math.cos(a)*r;
      const y1 = p.y - Math.sin(a)*r;
      const x2 = x1 - Math.cos(a)*40;
      const y2 = y1 - Math.sin(a)*40;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
  }

  // spin aura - 強化版
  if(p.spinT>0){
    const spinAlpha = p.spinT / PLAYER.spinDuration;
    ctx.strokeStyle = `rgba(200,255,100,${0.7 * spinAlpha})`;
    ctx.lineWidth = 7;
    const rotation = (performance.now() / 150) % (Math.PI*2);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r+14, rotation, rotation + Math.PI*0.8);
    ctx.stroke();
    
    ctx.strokeStyle = `rgba(150,255,50,${0.4 * spinAlpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r+22, rotation + Math.PI*0.3, rotation + Math.PI*1.1);
    ctx.stroke();
  }

  // defense shield - 強化版
  if(p.isDefending){
    const defendAlpha = p.defendT / PLAYER.defenseDuration;
    ctx.strokeStyle = `rgba(100,150,255,${0.6 * defendAlpha})`;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r+18, 0, Math.PI*2);
    ctx.stroke();
    
    ctx.strokeStyle = `rgba(150,200,255,${0.4 * defendAlpha})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r+26, 0, Math.PI*2);
    ctx.stroke();
    
    // シールドの装飾
    for(let i=0;i<8;i++){
      const angle = (i / 8) * Math.PI * 2;
      const x = p.x + Math.cos(angle) * (r + 22);
      const y = p.y + Math.sin(angle) * (r + 22);
      ctx.fillStyle = `rgba(100,150,255,${0.5 * defendAlpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI*2);
      ctx.fill();
    }
  }

  // marker
  if(isMe){
    ctx.save();
    if(state.mode === 'guest'){
      ctx.translate(p.x, p.y-r-14);
      ctx.rotate(Math.PI);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px "Hiragino Mincho ProN", serif';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 3;
      ctx.fillText('己', 0, 0);
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px "Hiragino Mincho ProN", serif';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 3;
      ctx.fillText('己', p.x, p.y-r-14);
    }
    ctx.restore();
  }
}

function lighten(hex, amt){
  const c = hex.replace('#','');
  const r = parseInt(c.slice(0,2),16);
  const g = parseInt(c.slice(2,4),16);
  const b = parseInt(c.slice(4,6),16);
  const f = (v)=> Math.min(255, Math.round(v + (255-v)*amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function drawCountdown(w,h){
}

// ---------- Result ----------
function showResult(win){
  state.matchOver = true;
  state.game.paused = true;
  $('result-title').textContent = win ? '勝利！' : '敗北…';
  $('result-sub').textContent = win ? 'あなたの勝ちです！' : '相手の勝ちです…';
  showScreen('result');
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  setupCanvas();
  attachUI();
  showScreen('lobby');
});

})();
