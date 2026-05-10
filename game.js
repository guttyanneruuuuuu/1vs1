/* =========================================================
   土俵バトル - 1vs1 ジャイロ相撲
   - PeerJS で合言葉マッチング (host/guest 決定はID辞書順)
   - WebRTC DataChannel で 入力同期 (authoritative host)
   - ジャイロ操作 + 突進ボタン
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
  // logical units (we render scaled to fit screen)
  size: 1000,            // square logical canvas
  ringRadius: 420,       // 土俵 radius
  ringInnerRadius: 405,
};
const PLAYER = {
  radius: 56,
  mass: 1.0,
  accel: 1600,           // px/s^2 (logical) - 強化
  maxSpeed: 650,         // 強化
  friction: 0.86,        // per-frame multiplicative
  tackleAccel: 5500,     // 強化
  tackleDuration: 0.28,  // sec
  tackleCooldown: 1.1,   // sec
  tackleStaminaCost: 35,
  staminaMax: 100,
  staminaRegen: 28,      // per sec
  restitution: 1.15,    // 強化 - より強い反発
};
const ROUND = {
  winsToMatch: 2,
  startCountdown: 3, // seconds
};

// ---------- State ----------
const state = {
  mode: null,           // 'host' | 'guest' | 'cpu'
  peer: null,
  conn: null,
  myPeerId: null,
  opPeerId: null,
  passphrase: null,
  myMotionEnabled: false,
  motionTilt: { x:0, y:0 }, // -1..1
  motionRaw: { gamma: 0, beta: 0 },
  motionCalibration: { gamma: 0, beta: 30 }, // subtracted before normalize
  hasReceivedMotion: false,
  // Authoritative shared state
  game: null,
  // Inputs received from opponent (latest)
  opInput: { tx:0, ty:0, tackle:false, seq:0 },
  myInput: { tx:0, ty:0, tackle:false, seq:0 },
  scoreMe: 0,
  scoreOp: 0,
  round: 1,
  matchOver: false,
  rafId: null,
  lastTime: 0,
  // For non-host (guest) interpolation
  remoteSnapshot: null,
  prevSnapshot: null,
  snapshotTime: 0,
  // CPU
  cpuTarget: { x:500, y:500 },
};

// ---------- PeerJS matchmaking ----------
// Passphrase => deterministic peer IDs
// We try to claim "sumo-<phrase>-A". If that fails, we claim "sumo-<phrase>-B".
// The "A" peer waits for connection from "B"; "B" connects to "A".

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

  // Try to be "A" (host)
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
    // ID taken => act as guest
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
  // Initialize match
  state.scoreMe = 0; state.scoreOp = 0; state.round = 1; state.matchOver = false;
  // Both sides go to game screen
  enterGame();
}

// ---------- Network protocol ----------
// host -> guest : { t:'snap', s: gameState }
// guest -> host : { t:'in',  i: input }
// host -> guest : { t:'round', mine, opp, round, banner }
// any -> any   : { t:'rematch' }
function onPeerData(data){
  if(!data || typeof data !== 'object') return;
  switch(data.t){
    case 'snap':
      // guest receives authoritative snapshot
      state.prevSnapshot = state.remoteSnapshot;
      state.remoteSnapshot = data.s;
      state.snapshotTime = performance.now();
      break;
    case 'in':
      // host receives guest input
      if(state.mode==='host'){
        state.opInput = data.i;
      }
      break;
    case 'round':
      // guest receives round result
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
  // iOS 13+
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
    const g = e.gamma; // -90..90 (left/right)
    const b = e.beta;  // -180..180 (front/back)
    if(g == null || b == null) return;
    state.motionRaw.gamma = g;
    state.motionRaw.beta = b;
    if(!state.hasReceivedMotion){
      // First reading -> auto-calibrate to "this is neutral"
      state.motionCalibration.gamma = g;
      state.motionCalibration.beta  = b;
      state.hasReceivedMotion = true;
    }
    const dg = g - state.motionCalibration.gamma;
    const db = b - state.motionCalibration.beta;
    // dead-zone of ~3deg, full tilt at ~25deg
    const tx = clamp(softZone(dg, 3, 25), -1, 1);
    const ty = clamp(softZone(db, 3, 25), -1, 1);
    state.motionTilt.x = tx;
    state.motionTilt.y = ty;
  }, true);
}
function softZone(v, dead, full){
  if(Math.abs(v) <= dead) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.min(1, (Math.abs(v) - dead) / (full - dead));
}
function clamp(v, a, b){ return Math.max(a, Math.min(b,v)); }

// ---------- Audio (WebAudio synth, no asset files) ----------
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
    // low whoosh
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(180, t0); o.frequency.exponentialRampToValueAtTime(80, t0+0.18);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.22);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.25);
  } else if(kind === 'hit'){
    // wood thud
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='triangle'; o.frequency.setValueAtTime(220, t0); o.frequency.exponentialRampToValueAtTime(80, t0+0.12);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0+0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.16);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.18);
    // noise burst
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate*0.08, audioCtx.sampleRate);
    const d = buf.getChannelData(0); for(let i=0;i<d.length;i++) d[i] = (Math.random()*2-1) * (1 - i/d.length);
    const n = audioCtx.createBufferSource(), ng = audioCtx.createGain();
    n.buffer = buf; ng.gain.value = 0.18;
    n.connect(ng).connect(audioCtx.destination); n.start(t0);
  } else if(kind === 'win'){
    // happy chime
    [523, 659, 784].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const s = t0 + i*0.12;
      o.type='triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.2, s+0.02); g.gain.exponentialRampToValueAtTime(0.0001, s+0.35);
      o.connect(g).connect(audioCtx.destination); o.start(s); o.stop(s+0.4);
    });
  } else if(kind === 'lose'){
    [330, 262, 220].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const s = t0 + i*0.14;
      o.type='sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.18, s+0.02); g.gain.exponentialRampToValueAtTime(0.0001, s+0.45);
      o.connect(g).connect(audioCtx.destination); o.start(s); o.stop(s+0.5);
    });
  } else if(kind === 'bell'){
    // round start bell
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(880, t0); o.frequency.exponentialRampToValueAtTime(660, t0+0.6);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.22, t0+0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0+0.7);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0+0.75);
  }
}

// Touch fallback (drag on canvas) -- helps desktop testing & non-permission devices
function attachTouchFallback(canvas){
  let dragging = false, cx=0, cy=0;
  const start = (x,y)=>{ dragging=true; cx=x; cy=y; };
  const move = (x,y)=>{
    if(!dragging) return;
    const dx = (x-cx) / 80;
    const dy = (y-cy) / 80;
    state.motionTilt.x = clamp(dx, -1, 1);
    state.motionTilt.y = clamp(dy, -1, 1);
  };
  const end = ()=>{ dragging=false; state.motionTilt.x=0; state.motionTilt.y=0; };
  canvas.addEventListener('touchstart', e => { const t=e.touches[0]; start(t.clientX,t.clientY); }, {passive:true});
  canvas.addEventListener('touchmove',  e => { const t=e.touches[0]; move(t.clientX,t.clientY); }, {passive:true});
  canvas.addEventListener('touchend',   end);
  canvas.addEventListener('mousedown',  e => start(e.clientX,e.clientY));
  canvas.addEventListener('mousemove',  e => move(e.clientX,e.clientY));
  window.addEventListener('mouseup',    end);

  // Keyboard for desktop
  const keys = {};
  window.addEventListener('keydown', e => { keys[e.key]=true; updateKeys(); });
  window.addEventListener('keyup',   e => { keys[e.key]=false; updateKeys(); if(e.key===' '){ requestTackle(); }});
  function updateKeys(){
    let x=0,y=0;
    if(keys['ArrowLeft']||keys['a']) x-=1;
    if(keys['ArrowRight']||keys['d']) x+=1;
    if(keys['ArrowUp']||keys['w']) y-=1;
    if(keys['ArrowDown']||keys['s']) y+=1;
    if(x||y){ state.motionTilt.x=x; state.motionTilt.y=y; }
    else if(!dragging){ state.motionTilt.x=0; state.motionTilt.y=0; }
  }
}

// ---------- Game flow ----------
let _gameInited = false;
function enterGame(){
  showScreen('game');
  if(!_gameInited){
    setupCanvas();
    setupTackleButton();
    _gameInited = true;
  }
  setupMotion();
  initMatchState();
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId = null; }
  startCountdownThenRun();
}

function setupMotion(){
  // Show prompt for iOS-style permission once
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function' &&
      !state.myMotionEnabled){
    const prompt = $('enable-motion');
    prompt.classList.remove('hidden');
    $('btn-enable-motion').onclick = async () => {
      const ok = await ensureMotionPermission();
      prompt.classList.add('hidden');
      if(!ok) {
        // we still allow touch fallback
      }
    };
  } else {
    // Try non-iOS attach; permission isn't needed
    attachOrientation();
    state.myMotionEnabled = true;
  }
}

function setupTackleButton(){
  const btn = $('btn-tackle');
  const fire = (e) => {
    if(e) e.preventDefault();
    requestTackle();
  };
  btn.ontouchstart = fire;
  btn.onmousedown = fire;

  // Long-press the tackle button to recalibrate gyro neutral pose
  let pressTimer = null;
  const startPress = () => {
    pressTimer = setTimeout(() => {
      state.hasReceivedMotion = false; // forces recalibrate on next reading
      navigator.vibrate && navigator.vibrate([20,40,20]);
      flashMsg('構え直し（ジャイロ再調整）');
    }, 700);
  };
  const cancelPress = () => { if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; } };
  btn.addEventListener('touchstart', startPress, {passive:true});
  btn.addEventListener('touchend', cancelPress);
  btn.addEventListener('touchcancel', cancelPress);
  btn.addEventListener('mousedown', startPress);
  btn.addEventListener('mouseup', cancelPress);
  btn.addEventListener('mouseleave', cancelPress);
}

function flashMsg(text){
  let el = document.getElementById('flash-msg');
  if(!el){
    el = document.createElement('div');
    el.id = 'flash-msg';
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(40,28,16,.85);color:#fbf2d9;padding:8px 18px;border-radius:18px;z-index:30;font-size:14px;letter-spacing:.1em;pointer-events:none;transition:opacity .3s;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(flashMsg._t);
  flashMsg._t = setTimeout(()=> { el.style.opacity='0'; }, 1400);
}

function requestTackle(){
  state.myInput.tackle = true;
  navigator.vibrate && navigator.vibrate(20);
  playSfx('tackle');
}

function initMatchState(){
  // Both clients initialize game positions; host is authoritative.
  state.game = createInitialGameState();
  state.matchOver = false;
}

function createInitialGameState(){
  // host = red (player 1), guest = blue (player 2)
  return {
    p1: { x: ARENA.size*0.5 - 180, y: ARENA.size*0.5, vx:0, vy:0, stamina: PLAYER.staminaMax, tackleT:0, cooldown:0, color:'red', alive:true },
    p2: { x: ARENA.size*0.5 + 180, y: ARENA.size*0.5, vx:0, vy:0, stamina: PLAYER.staminaMax, tackleT:0, cooldown:0, color:'blue', alive:true },
    t: 0,
    paused: true,
    countdown: ROUND.startCountdown,
    roundEnded: false,
    winner: null, // 'p1'|'p2'|'draw'
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

  // Build my input from local sources
  state.myInput.tx = state.motionTilt.x;
  state.myInput.ty = state.motionTilt.y;

  if(state.mode === 'host' || state.mode === 'cpu'){
    // simulate
    if(state.mode === 'cpu'){
      // CPU produces opInput
      cpuThink(dt);
    }
    simulate(dt);
    // send snapshot to guest
    if(state.mode === 'host'){
      sendSnapshot();
    }
    // consume tackle press
    state.myInput.tackle = false;
    state.opInput.tackle = false;
    updateFx(dt);
  } else if (state.mode === 'guest'){
    state.myInput.seq = (state.myInput.seq+1)|0;
    safeSend({ t:'in', i: {
      tx: -state.myInput.tx,
      ty: -state.myInput.ty,
      tackle: state.myInput.tackle,
      seq: state.myInput.seq
    }});
    state.myInput.tackle = false;
    interpFromSnapshot();
    updateFx(dt);
  }

  render();
}

// ---------- Simulation (host authoritative) ----------
function simulate(dt){
  const g = state.game;
  if(g.paused){
    // countdown anim still ticks visually but no movement
    return;
  }
  if(g.roundEnded) return;

  // Apply inputs
  applyInput(g.p1, state.myInput, dt);
  applyInput(g.p2, state.opInput, dt);

  // Integrate
  integrate(g.p1, dt);
  integrate(g.p2, dt);

  // Collision player-player
  resolveCollision(g.p1, g.p2);

  // Stamina regen
  g.p1.stamina = Math.min(PLAYER.staminaMax, g.p1.stamina + PLAYER.staminaRegen*dt);
  g.p2.stamina = Math.min(PLAYER.staminaMax, g.p2.stamina + PLAYER.staminaRegen*dt);

  // Cooldown / tackle timer
  g.p1.tackleT = Math.max(0, g.p1.tackleT - dt);
  g.p2.tackleT = Math.max(0, g.p2.tackleT - dt);
  g.p1.cooldown = Math.max(0, g.p1.cooldown - dt);
  g.p2.cooldown = Math.max(0, g.p2.cooldown - dt);

  // Out of ring check
  const cx = ARENA.size/2, cy = ARENA.size/2;
  const r = ARENA.ringRadius;
  const out1 = dist(g.p1.x,g.p1.y,cx,cy) > r + 4; // center out of ring
  const out2 = dist(g.p2.x,g.p2.y,cx,cy) > r + 4;

  if(out1 || out2){
    g.roundEnded = true;
    let winner = null;
    if(out1 && out2){
      // who fell first - approximate by which is further out
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
  // Tackle?
  if(inp.tackle && p.cooldown<=0 && p.stamina>=PLAYER.tackleStaminaCost){
    p.stamina -= PLAYER.tackleStaminaCost;
    p.tackleT = PLAYER.tackleDuration;
    p.cooldown = PLAYER.tackleCooldown;
    // boost in current input direction (or current vel if no tilt)
    const mag = Math.hypot(inp.tx, inp.ty);
    let dx, dy;
    if(mag > 0.05){ dx = inp.tx/mag; dy = inp.ty/mag; }
    else {
      const vmag = Math.hypot(p.vx,p.vy);
      if(vmag>1){ dx = p.vx/vmag; dy = p.vy/vmag; }
      else { dx = (p===state.game.p1?1:-1); dy = 0; }
    }
    p.vx += dx * 420;  // タックル威力強化
    p.vy += dy * 420;
  }

  // Normal acceleration
  const accel = (p.tackleT>0) ? PLAYER.tackleAccel : PLAYER.accel;
  p.vx += inp.tx * accel * dt;
  p.vy += inp.ty * accel * dt;

  // Cap speed
  const maxV = (p.tackleT>0) ? PLAYER.maxSpeed*1.7 : PLAYER.maxSpeed;
  const sp = Math.hypot(p.vx,p.vy);
  if(sp>maxV){ p.vx*=maxV/sp; p.vy*=maxV/sp; }
}

function integrate(p, dt){
  // friction
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
  const e = PLAYER.restitution;
  const bonusA = (a.tackleT>0)?1.6:1.0;
  const bonusB = (b.tackleT>0)?1.6:1.0;
  const j = -(1+e)*vn / 2;
  const ja = j*bonusA, jb = j*bonusB;
  a.vx -= ja*nx; a.vy -= ja*ny;
  b.vx += jb*nx; b.vy += jb*ny;

  if(a.tackleT>0){ b.vx += nx*240; b.vy += ny*240; }  // タックル時の追加押し出し力強化
  if(b.tackleT>0){ a.vx -= nx*240; a.vy -= ny*240; }

  // Haptic + sfx (impact strength gates)
  const strength = Math.abs(vn);
  if(strength > 60){
    navigator.vibrate && navigator.vibrate(20);  // バイブレーション強化
    playSfx('hit');
    spawnImpactFx((a.x+b.x)/2, (a.y+b.y)/2);
  }
}

// ---------- FX particles ----------
const fxParticles = [];
function spawnImpactFx(x,y){
  for(let i=0;i<16;i++){  // パーティクル数を10から16に増加
    const a = Math.random()*Math.PI*2;
    const sp = 80 + Math.random()*220;  // スピード強化
    fxParticles.push({
      x, y,
      vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
      life: 0.4 + Math.random()*0.3,
      max: 0.6,
      size: 5 + Math.random()*5,  // サイズ強化
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
}
function drawFx(){
  for(const p of fxParticles){
    const a = Math.max(0, p.life / p.max);
    ctx.fillStyle = `rgba(245,230,196,${a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size*a, 0, Math.PI*2);
    ctx.fill();
  }
}

function dist(x1,y1,x2,y2){ const dx=x2-x1, dy=y2-y1; return Math.hypot(dx,dy); }

// ---------- Round end ----------
function onRoundEnd(winner){
  // host POV: p1=me, p2=opponent
  let myWin = (winner === 'p1');
  if(state.mode === 'cpu'){
    // p1 is me, p2 is cpu
  }
  if(myWin) state.scoreMe++; else state.scoreOp++;

  const matchOver = (state.scoreMe>=ROUND.winsToMatch || state.scoreOp>=ROUND.winsToMatch);

  // notify guest
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
      startCountdownThenRun();
    }, 1700);
  }
}

// ---------- Snapshot for guest (sent ~30Hz directly from loop) ----------
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
  return [Math.round(p.x), Math.round(p.y), Math.round(p.vx), Math.round(p.vy), Math.round(p.stamina), Math.round(p.tackleT*1000), Math.round(p.cooldown*1000)];
}
function unpack(arr){
  return { x:arr[0], y:arr[1], vx:arr[2], vy:arr[3], stamina:arr[4], tackleT:arr[5]/1000, cooldown:arr[6]/1000, alive:true, color: null };
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
    // For guest, host's scoreMe = guest's scoreOp
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

  // translate to arena
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  // For guest, rotate the whole world 180° so their character appears at bottom.
  // Note: we also invert their tilt input upstream, so controls remain natural.
  if(state.mode === 'guest'){
    ctx.translate(ARENA.size, ARENA.size);
    ctx.rotate(Math.PI);
  }

  drawDohyo();

  // host: me=p1, op=p2
  // guest: me=p2, op=p1 (rendered upside-down so visually 'me' appears at bottom)
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

  // Stamina UI
  const myStamina = me.stamina;
  $('stamina-fill').style.width = (myStamina/PLAYER.staminaMax*100)+'%';
  $('btn-tackle').classList.toggle('cooldown', myStamina < PLAYER.tackleStaminaCost || me.cooldown>0);

  // countdown overlay
  if(state.game.paused){
    drawCountdown(w,h);
  }
}

function drawPlanks(w,h){
  // background already CSS gradient; nothing extra to keep it light
}

function drawDohyo(){
  const cx = ARENA.size/2, cy = ARENA.size/2;
  // outer square (tatami)
  ctx.fillStyle = '#cdb070';
  ctx.fillRect(40,40,ARENA.size-80, ARENA.size-80);
  // border
  ctx.strokeStyle = '#6b4a22';
  ctx.lineWidth = 6;
  ctx.strokeRect(40,40,ARENA.size-80, ARENA.size-80);

  // ring (clay)
  const grad = ctx.createRadialGradient(cx,cy-60,80, cx,cy, ARENA.ringRadius);
  grad.addColorStop(0, '#e3b67a');
  grad.addColorStop(1, '#a76f3a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx,cy, ARENA.ringRadius, 0, Math.PI*2);
  ctx.fill();

  // straw bales (white circle outline)
  ctx.lineWidth = 18;
  ctx.strokeStyle = '#f1e1bc';
  ctx.beginPath();
  ctx.arc(cx,cy, ARENA.ringRadius-10, 0, Math.PI*2);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#7a5a30';
  ctx.beginPath();
  ctx.arc(cx,cy, ARENA.ringRadius-10, 0, Math.PI*2);
  ctx.stroke();

  // center lines
  ctx.fillStyle = '#fff';
  ctx.fillRect(cx-50, cy-2, 100, 4);
  ctx.fillRect(cx-50, cy-50, 100, 4);
  ctx.fillRect(cx-50, cy+46, 100, 4);

  // sand grain noise
  // (skipped to keep mobile perf)
}

function drawShadow(p){
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(p.x+6, p.y+12, PLAYER.radius*0.95, PLAYER.radius*0.45, 0, 0, Math.PI*2);
  ctx.fill();
}

function drawRikishi(p, color, isMe){
  // body
  const r = PLAYER.radius;
  const grad = ctx.createRadialGradient(p.x-r*0.4, p.y-r*0.4, r*0.2, p.x, p.y, r);
  grad.addColorStop(0, lighten(color, 0.2));
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI*2);
  ctx.fill();

  // mawashi (belt)
  ctx.fillStyle = isMe ? '#f5e6c4' : '#dcd0b0';
  ctx.beginPath();
  ctx.arc(p.x, p.y+6, r*0.7, 0, Math.PI, false);
  ctx.fill();

  // outline
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#2b2118';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI*2);
  ctx.stroke();

  // tackle aura
  if(p.tackleT>0){
    ctx.strokeStyle = 'rgba(255,240,180,0.7)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(p.x,p.y, r+8, 0, Math.PI*2);
    ctx.stroke();
    // motion lines
    const dir = Math.atan2(p.vy, p.vx);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3;
    for(let i=0;i<4;i++){
      const a = dir + (i-1.5)*0.15;
      const x1 = p.x - Math.cos(a)*r;
      const y1 = p.y - Math.sin(a)*r;
      const x2 = x1 - Math.cos(a)*30;
      const y2 = y1 - Math.sin(a)*30;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
  }

  // marker (you) — counter-rotate text for guest so it reads upright
  if(isMe){
    ctx.save();
    if(state.mode === 'guest'){
      ctx.translate(p.x, p.y-r-12);
      ctx.rotate(Math.PI);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px "Hiragino Mincho ProN", serif';
      ctx.textAlign='center';
      ctx.fillText('己', 0, 8);
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px "Hiragino Mincho ProN", serif';
      ctx.textAlign='center';
      ctx.fillText('己', p.x, p.y-r-12);
    }
    ctx.restore();
  }
}

function lighten(hex, amt){
  // hex like #aabbcc
  const c = hex.replace('#','');
  const r = parseInt(c.slice(0,2),16);
  const g = parseInt(c.slice(2,4),16);
  const b = parseInt(c.slice(4,6),16);
  const f = (v)=> Math.min(255, Math.round(v + (255-v)*amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function drawCountdown(w,h){
  // countdown via game time prefix
  // We don't track countdown numbers precisely (banner does). Skip dim overlay.
}

// ---------- Result ----------
function showResult(win){
  state.matchOver = true;
  state.game.paused = true;
  $('result-title').textContent = win ? '勝利！' : '敗北…';
  $('result-sub').textContent = `${state.scoreMe} － ${state.scoreOp}`;
  playSfx(win ? 'win' : 'lose');
  hideBanner();
  setTimeout(()=> showScreen('result'), 300);
}

// ---------- Rematch / back ----------
$('btn-rematch').onclick = () => {
  if(state.mode === 'cpu'){
    state.scoreMe=0; state.scoreOp=0; state.round=1;
    enterGame(); // restart
    return;
  }
  if(state.mode === 'guest'){
    safeSend({ t:'rematch' });
    setStatus && setStatus('再戦リクエストを送信…');
  }
  startNewMatch();
};
function startNewMatch(){
  state.scoreMe=0; state.scoreOp=0; state.round=1;
  enterGame();
}
$('btn-back').onclick = () => {
  cleanupConn();
  showScreen('lobby');
  setStatus('');
};
function cleanupConn(){
  try{ if(state.conn) state.conn.close(); }catch(e){}
  try{ if(state.peer) state.peer.destroy(); }catch(e){}
  state.conn = null; state.peer = null;
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId=null; }
}
function cleanupConn(){
  try{ if(state.conn) state.conn.close(); }catch(e){}
  try{ if(state.peer) state.peer.destroy(); }catch(e){}
  state.conn = null; state.peer = null;
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId=null; }
}
function endMatchAbort(){
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId=null; }
  showScreen('lobby');
}

// ---------- Lobby buttons ----------
$('btn-match').onclick = async () => {
  const phrase = $('passphrase').value.trim();
  if(phrase.length < 2){
    setStatus('合言葉は2文字以上で', true);
    return;
  }
  ensureAudio();
  try { await ensureMotionPermission(); } catch(e){}
  await startMatchmaking(phrase);
};

$('btn-solo').onclick = async () => {
  state.mode = 'cpu';
  state.scoreMe = 0; state.scoreOp = 0; state.round=1;
  ensureAudio();
  try { await ensureMotionPermission(); } catch(e){}
  enterGame();
};

// Auto-start solo via URL for testing
if (new URLSearchParams(location.search).get('autoSolo') === '1'){
  setTimeout(() => $('btn-solo').click(), 300);
}

// ---------- CPU ----------
function cpuThink(dt){
  const g = state.game;
  if(g.paused || g.roundEnded){ state.opInput = {tx:0,ty:0,tackle:false,seq:0}; return; }
  const me = g.p2; // CPU is p2
  const target = g.p1;
  const cx = ARENA.size/2, cy = ARENA.size/2;
  // Aim toward player; if player is near edge, push outward more
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const d = Math.hypot(dx,dy)||1;

  // direction toward target
  let ix = dx/d, iy = dy/d;

  // if player is near edge, push from opposite of center (extra)
  const pdToCenter = Math.hypot(target.x-cx, target.y-cy);
  if(pdToCenter > ARENA.ringRadius*0.6){
    const ox = (target.x - cx)/Math.max(1,pdToCenter);
    const oy = (target.y - cy)/Math.max(1,pdToCenter);
    ix = (ix+ox)/2; iy = (iy+oy)/2;
    const m = Math.hypot(ix,iy)||1;
    ix/=m; iy/=m;
  }
  // avoid going off ring myself
  const myDtoC = Math.hypot(me.x-cx, me.y-cy);
  if(myDtoC > ARENA.ringRadius*0.78){
    // pull toward center
    ix = (cx-me.x)/Math.max(1,myDtoC);
    iy = (cy-me.y)/Math.max(1,myDtoC);
  }

  // jitter
  ix += (Math.random()-0.5)*0.1;
  iy += (Math.random()-0.5)*0.1;

  state.opInput.tx = clamp(ix, -1, 1);
  state.opInput.ty = clamp(iy, -1, 1);

  // tackle when close & aligned & has stamina
  state.opInput.tackle = false;
  if(d < PLAYER.radius*3 && me.stamina > 50 && me.cooldown<=0 && Math.random()<0.04){
    state.opInput.tackle = true;
  }
}

})();
