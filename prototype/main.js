import * as THREE from 'three';

const $ = (s, r = document) => r.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

const screenEl = $('#screen');
const hud = $('#hud');
const vig = $('#vig');
const flashEl = $('#flash');
const bloodCv = $('#blood');
const bctx = bloodCv.getContext('2d');

const renderer = new THREE.WebGLRenderer({ canvas: $('#gl'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const game = { pot: 30, coins: 62, lost: [], muted: false };
const LIMBS = [['ra', 'RIGHT ARM'], ['la', 'LEFT ARM'], ['rl', 'RIGHT LEG'], ['ll', 'LEFT LEG']];
const YOU = { id: 'you', name: 'YOU', suit: 0xc98f00, hat: 'none' };
const NPC = [
  { id: 'cone', name: 'CONE', suit: 0x3f6e4b, hat: 'cone' },
  { id: 'top', name: 'TOP HAT', suit: 0x7a2f2a, hat: 'top' },
  { id: 'bucket', name: 'BUCKET', suit: 0x2f4f74, hat: 'bucket' },
];
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// ---------- textures

function canvasTex(w, h, draw, rep = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h, c);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rep[0], rep[1]);
  t.anisotropy = 4;
  return t;
}

function speckle(g, w, h, cols, n = 260, max = 14) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = Math.random() * 0.22;
    g.fillStyle = cols[i % cols.length];
    g.beginPath();
    g.arc(Math.random() * w, Math.random() * h, Math.random() * max + 1, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
}

function streaks(g, w, h, col, n = 40) {
  g.globalAlpha = 0.14;
  g.fillStyle = col;
  for (let i = 0; i < n; i++) g.fillRect(Math.random() * w, Math.random() * h * 0.4, rand(1, 4), rand(h * 0.2, h));
  g.globalAlpha = 1;
}

const T = {
  concrete: (rep) => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#35302b'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, ['#211d1a', '#4a443e', '#5a2a17', '#15110f']);
    streaks(g, w, h, '#6b2e14');
  }, rep),
  rust: (rep) => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#5b2a16'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, ['#8a3b1c', '#2b140b', '#a0522d', '#3a3a3a'], 420, 10);
  }, rep),
  grate: (rep) => canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#121212'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3d3b38'; g.lineWidth = 7;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(w, i * 32); g.stroke();
    }
    speckle(g, w, h, ['#5a2a17', '#000'], 60, 6);
  }, rep),
  hazard: (rep) => canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#c99a00'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#121212';
    for (let x = -h; x < w + h; x += 64) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 32, 0); g.lineTo(x + 32 - h, h); g.lineTo(x - h, h); g.fill();
    }
    speckle(g, w, h, ['#000', '#5a2a17'], 120, 6);
  }, rep),
  cloth: (rep) => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#cfc4ad'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, ['#a89a7e', '#b8ab90'], 200, 10);
    g.globalAlpha = 0.55;
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i < 3 ? '#5a0a0a' : '#7a6a4a';
      g.beginPath(); g.arc(Math.random() * w, Math.random() * h, rand(6, 22), 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  }, rep),
};

const splatTex = canvasTex(256, 256, (g) => {
  g.fillStyle = '#6a0606';
  const blob = (x, y, r) => {
    g.beginPath();
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const rr = r * rand(0.65, 1);
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.fill();
  };
  blob(128, 128, 70);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * 7, d = rand(70, 120);
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, rand(3, 12));
  }
});

// ---------- scene helpers

function std(color, o = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.1, ...o });
}

function mesh(geo, mat, x = 0, y = 0, z = 0, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent?.add(m);
  return m;
}

function fpCam(fov = 84) {
  return new THREE.PerspectiveCamera(fov, 0.46, 0.02, 60);
}

function sway(cam, base, look, t, amt = 1) {
  cam.position.set(base.x + Math.sin(t * 0.7) * 0.012 * amt, base.y + Math.sin(t * 1.3) * 0.009 * amt, base.z);
  cam.lookAt(look.x + Math.sin(t * 0.4) * 0.05 * amt, look.y + Math.sin(t * 0.9) * 0.02 * amt, look.z);
}

function buildRoom(scene, { w = 6, d = 8, h = 3.2, z = 0 } = {}) {
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ map: T.concrete([w / 2, h / 2]), side: THREE.BackSide, roughness: 0.95 }),
  );
  walls.position.set(0, h / 2, z);
  walls.receiveShadow = true;
  scene.add(walls);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ map: T.grate([w * 2, d * 2]), roughness: 0.6, metalness: 0.5 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.005, z);
  floor.receiveShadow = true;
  scene.add(floor);
  const pipeM = new THREE.MeshStandardMaterial({ map: T.rust([1, 6]), roughness: 0.7, metalness: 0.5 });
  for (const s of [-1, 1]) {
    for (const [r, y] of [[0.07, h - 0.25], [0.045, h - 0.45]]) {
      const p = mesh(new THREE.CylinderGeometry(r, r, d, 12), pipeM, s * (w / 2 - 0.16 - r), y, z, scene);
      p.rotation.x = Math.PI / 2;
    }
  }
  const strip = mesh(new THREE.PlaneGeometry(w, 0.22), std(0xffffff, { map: T.hazard([w / 1.2, 1]) }), 0, 0.11, z - d / 2 + 0.01, scene);
  strip.castShadow = false;
}

function hangingLamp(scene, pos, color = 0xffc58a, intensity = 8, dist = 8, cord = 0.8) {
  const pivot = new THREE.Group();
  pivot.position.copy(pos);
  scene.add(pivot);
  const c = mesh(new THREE.CylinderGeometry(0.006, 0.006, cord, 6), std(0x111111), 0, -cord / 2, 0, pivot);
  c.castShadow = false;
  const shade = mesh(new THREE.ConeGeometry(0.24, 0.2, 24, 1, true), std(0x2b2f2a, { metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide }), 0, -cord - 0.06, 0, pivot);
  shade.castShadow = false;
  const bulb = mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 2.5 }), 0, -cord - 0.13, 0, pivot);
  bulb.castShadow = false;
  const light = new THREE.PointLight(color, intensity, dist, 1.25);
  light.position.set(0, -cord - 0.17, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(512, 512);
  light.shadow.bias = -0.004;
  light.shadow.radius = 4;
  pivot.add(light);
  return { pivot, light, bulb, base: intensity, off: 0 };
}

function flicker(l, dt, chance = 0.012) {
  if (l.off > 0) {
    l.off -= dt;
    l.light.intensity = l.base * 0.06;
    l.bulb.material.emissiveIntensity = 0.15;
    return;
  }
  if (Math.random() < chance) l.off = rand(0.04, 0.16);
  l.light.intensity = l.base * (0.92 + Math.random() * 0.08);
  l.bulb.material.emissiveIntensity = 2.5;
}

function subject(p, seated = false) {
  const g = new THREE.Group();
  const suit = std(p.suit, { roughness: 0.9 });
  const skin = std(0xc8a18a, { roughness: 0.6 });
  const body = new THREE.Group();
  g.add(body);
  mesh(new THREE.CapsuleGeometry(0.2, 0.32, 6, 14), suit, 0, 0.62, 0, body);
  const head = mesh(new THREE.SphereGeometry(0.15, 24, 18), skin, 0, 1.03, 0, body);
  const eyeM = std(0x0a0a0a, { roughness: 0.2 });
  mesh(new THREE.SphereGeometry(0.022, 8, 8), eyeM, -0.055, 0.03, 0.132, head);
  mesh(new THREE.SphereGeometry(0.022, 8, 8), eyeM, 0.055, 0.03, 0.132, head);
  const limbs = {};
  for (const [k, x] of [['la', -0.27], ['ra', 0.27]]) {
    const a = new THREE.Group();
    a.position.set(x, 0.84, 0);
    mesh(new THREE.CapsuleGeometry(0.06, 0.3, 4, 8), suit, 0, -0.2, 0, a);
    mesh(new THREE.SphereGeometry(0.055, 10, 8), skin, 0, -0.42, 0, a);
    a.rotation.z = x < 0 ? -0.15 : 0.15;
    body.add(a);
    limbs[k] = a;
  }
  for (const [k, x] of [['ll', -0.1], ['rl', 0.1]]) {
    const l = new THREE.Group();
    l.position.set(x, 0.38, 0);
    mesh(new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), suit, 0, -0.2, 0, l);
    if (seated) l.rotation.x = -Math.PI / 2;
    body.add(l);
    limbs[k] = l;
  }
  if (p.hat === 'cone') {
    const cone = mesh(new THREE.ConeGeometry(0.12, 0.32, 20), std(0xff5a00, { roughness: 0.5 }), 0, 0.27, 0, head);
    mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.05, 20), std(0xf2f2f2), 0, 0.0, 0, cone);
    mesh(new THREE.BoxGeometry(0.26, 0.02, 0.26), std(0xff5a00), 0, -0.15, 0, cone);
  }
  if (p.hat === 'top') {
    mesh(new THREE.CylinderGeometry(0.105, 0.11, 0.24, 20), std(0x0d0d0d, { roughness: 0.4 }), 0, 0.24, 0, head);
    mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.015, 24), std(0x0d0d0d, { roughness: 0.4 }), 0, 0.125, 0, head);
    mesh(new THREE.CylinderGeometry(0.112, 0.112, 0.04, 20), std(0x7a1010), 0, 0.15, 0, head);
  }
  if (p.hat === 'bucket') {
    mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.2, 20), std(0x8a8d8f, { metalness: 0.8, roughness: 0.35 }), 0, 0.13, 0, head);
  }
  g.userData = { body, head, limbs };
  return g;
}

function decal(scene, x, y, z, r) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), new THREE.MeshStandardMaterial({ map: splatTex, transparent: true, roughness: 0.25, metalness: 0.1, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = Math.random() * 7;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  m.userData.decal = true;
  scene.add(m);
  return m;
}

function revolver() {
  const g = new THREE.Group();
  const steel = std(0x2b2c2f, { metalness: 0.9, roughness: 0.3 });
  const wood = std(0x5a3418, { roughness: 0.6 });
  const barrel = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.2, 14), steel, 0, 0.02, 0.13, g);
  barrel.rotation.x = Math.PI / 2;
  const drum = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.065, 12), steel, 0, 0, 0.0, g);
  drum.rotation.x = Math.PI / 2;
  mesh(new THREE.BoxGeometry(0.03, 0.05, 0.13), steel, 0, 0.025, 0.03, g);
  const grip = mesh(new THREE.BoxGeometry(0.034, 0.12, 0.05), wood, 0, -0.06, -0.07, g);
  grip.rotation.x = 0.4;
  mesh(new THREE.BoxGeometry(0.01, 0.03, 0.02), steel, 0, 0.05, -0.05, g);
  const guard = mesh(new THREE.TorusGeometry(0.024, 0.004, 6, 16, Math.PI), steel, 0, -0.03, -0.01, g);
  guard.rotation.y = Math.PI / 2;
  guard.rotation.z = Math.PI;
  const flash = new THREE.PointLight(0xffa040, 0, 4, 1.5);
  flash.position.set(0, 0.02, 0.26);
  g.add(flash);
  g.userData.flash = flash;
  return g;
}

function cashStack() {
  const g = new THREE.Group();
  mesh(new THREE.BoxGeometry(0.15, 0.09, 0.07), std(0x5f8a45, { roughness: 0.8 }), 0, 0, 0, g);
  mesh(new THREE.BoxGeometry(0.035, 0.092, 0.072), std(0xe6d7a8), 0, 0, 0, g);
  return g;
}

// ---------- effects: blood, shake, flash

let drips = [];
function sizeBlood() {
  const r = screenEl.getBoundingClientRect();
  bloodCv.width = Math.round(r.width * devicePixelRatio);
  bloodCv.height = Math.round(r.height * devicePixelRatio);
  drips = [];
}

function bblob(x, y, r) {
  const grd = bctx.createRadialGradient(x, y, r * 0.1, x, y, r);
  grd.addColorStop(0, 'rgba(105,0,0,.96)');
  grd.addColorStop(0.75, 'rgba(150,8,6,.92)');
  grd.addColorStop(1, 'rgba(90,0,0,.0)');
  bctx.fillStyle = grd;
  bctx.beginPath();
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const rr = r * rand(0.6, 1);
    bctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  bctx.fill();
}

function splatter(n = 3) {
  const W = bloodCv.width, H = bloodCv.height;
  for (let k = 0; k < n; k++) {
    const x = rand(0.08, 0.92) * W, y = rand(0.05, 0.62) * H, r = rand(0.07, 0.17) * W;
    bblob(x, y, r);
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * 7, d = r * rand(1, 2.8);
      bblob(x + Math.cos(a) * d, y + Math.sin(a) * d, rand(0.004, 0.018) * W);
    }
    for (let i = 0; i < 4; i++) drips.push({ x: x + rand(-r * 0.6, r * 0.6), y: y + r * 0.4, w: rand(0.006, 0.014) * W, v: rand(0.04, 0.1) * H, life: rand(1, 3) });
  }
}

function updateBlood(dt) {
  if (!drips.length) return;
  bctx.fillStyle = 'rgba(125,4,4,.95)';
  for (const d of drips) {
    d.life -= dt;
    const ny = d.y + d.v * dt;
    bctx.fillRect(d.x - d.w / 2, d.y, d.w, ny - d.y + 1);
    bctx.beginPath();
    bctx.ellipse(d.x, ny, d.w / 2, d.w * 0.7, 0, 0, 7);
    bctx.fill();
    d.y = ny;
    d.v *= 0.993;
  }
  drips = drips.filter((d) => d.life > 0);
}

function clearBlood() {
  bctx.clearRect(0, 0, bloodCv.width, bloodCv.height);
  drips = [];
}

function shake() {
  screenEl.classList.remove('shake');
  void screenEl.offsetWidth;
  screenEl.classList.add('shake');
}

function flash(color = 'rgba(255,60,30,.9)') {
  flashEl.style.transition = 'none';
  flashEl.style.background = color;
  flashEl.style.opacity = 1;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    flashEl.style.transition = 'opacity .45s';
    flashEl.style.opacity = 0;
  }));
}

// ---------- audio (synthesized, no assets)

let ac = null;
function A() {
  if (game.muted) return null;
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch {
    return null;
  }
}

function noise(dur, freq, vol, type = 'lowpass') {
  const a = A();
  if (!a) return;
  const len = Math.floor(a.sampleRate * dur);
  const b = a.createBuffer(1, len, a.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  const s = a.createBufferSource();
  s.buffer = b;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = a.createGain();
  g.gain.value = vol;
  s.connect(f).connect(g).connect(a.destination);
  s.start();
}

function tone(freq, dur, type = 'square', vol = 0.15, slide = 0) {
  const a = A();
  if (!a) return;
  const o = a.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, a.currentTime + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}

const sfx = {
  shot() { noise(0.7, 2600, 1.2); tone(90, 0.3, 'sine', 0.7, 30); },
  click() { tone(2200, 0.025, 'square', 0.12); setTimeout(() => tone(700, 0.04, 'square', 0.1), 40); },
  crunch() { noise(1.1, 420, 1.3); noise(0.5, 2800, 0.5, 'highpass'); tone(70, 0.6, 'sawtooth', 0.4, 30); },
  rustle() { noise(0.3, 4500, 0.25, 'highpass'); },
  tick() { tone(1500, 0.02, 'square', 0.05); },
  pay() { tone(880, 0.1, 'triangle', 0.22); setTimeout(() => tone(1320, 0.18, 'triangle', 0.22), 90); },
  slip() { tone(300, 0.12, 'sawtooth', 0.12, 120); },
  grab() { noise(0.06, 1200, 0.25); },
};

let drone = null;
function droneOn() {
  const a = A();
  if (!a || drone) return;
  const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 46;
  const o2 = a.createOscillator(); o2.type = 'square'; o2.frequency.value = 93;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 340;
  const g = a.createGain(); g.gain.value = 0.04;
  o.connect(f); o2.connect(f); f.connect(g).connect(a.destination);
  o.start(); o2.start();
  drone = { o, o2, g };
}
function droneLevel(v) { if (drone) drone.g.gain.value = v; }
function droneOff() {
  if (!drone) return;
  drone.o.stop(); drone.o2.stop();
  drone = null;
}

// ---------- HUD helpers

function limbsHtml() {
  const L = (k) => (game.lost.includes(k) ? 'lost' : '');
  return `<svg class="body" viewBox="0 0 40 56"><circle cx="20" cy="8" r="6"/><line x1="20" y1="15" x2="20" y2="33"/>
    <line class="${L('la')}" x1="20" y1="19" x2="8" y2="31"/><line class="${L('ra')}" x1="20" y1="19" x2="32" y2="31"/>
    <line class="${L('ll')}" x1="20" y1="33" x2="12" y2="52"/><line class="${L('rl')}" x1="20" y1="33" x2="28" y2="52"/></svg>
    <span>${4 - game.lost.length}/4</span>`;
}

function topbar(title, kicker = 'TRIAL') {
  return `<div class="top"><div class="limbs" id="limbs">${limbsHtml()}</div>
    <div class="game"><small>${kicker}</small>${title}</div>
    <div class="pot"><small>POT</small><b>$${game.pot}</b></div></div>
    <div id="feed" class="feed"></div>`;
}

function feed(msg) {
  const f = $('#feed');
  if (!f) return;
  const d = document.createElement('div');
  d.innerHTML = msg;
  f.prepend(d);
  setTimeout(() => d.classList.add('out'), 3800);
  setTimeout(() => d.remove(), 4400);
}

let toastTimer;
function toast(html, ms = 1400) {
  const t = $('#toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function countUp(el, from, to, ms = 700, fmt = (v) => `$${Math.round(v)}`) {
  const t0 = performance.now();
  const step = (now) => {
    const k = clamp((now - t0) / ms, 0, 1);
    el.textContent = fmt(lerp(from, to, ease(k)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- overlay (death / survived)

const overEl = $('#over');
function overlay({ kind, kicker, title, cause, line, next }) {
  overEl.className = 'over show' + (kind === 'win' ? ' win' : '');
  $('#ovk').textContent = kicker;
  $('#ovt').textContent = title;
  $('#ovc').textContent = cause;
  $('#ovl').textContent = line;
  $('#ovnext').textContent = next ? `NEXT: ${LABEL[next].toUpperCase()} →` : '';
  $('#ovnext').style.display = next ? '' : 'none';
  $('#ovnext').onclick = () => go(next);
  $('#ovretry').style.display = kind === 'win' ? 'none' : '';
}
function hideOverlay() { overEl.className = 'over'; }
$('#ovretry').onclick = () => go(cur.name);

function die(cause, title, sound = 'shot') {
  if (cur.dead) return;
  cur.dead = true;
  const limb = LIMBS.find(([k]) => !game.lost.includes(k));
  if (limb) game.lost.push(limb[0]);
  const left = 4 - game.lost.length;
  sfx[sound]();
  splatter(sound === 'crunch' ? 6 : 4);
  shake();
  flash();
  navigator.vibrate?.([60, 30, 240]);
  const l = $('#limbs');
  if (l) l.innerHTML = limbsHtml();
  setTimeout(() => overlay({
    kind: 'death',
    kicker: 'TRIAL FAILED',
    title,
    cause,
    line: left > 0 ? `−1 ${limb[1]} · ${left} LIMB${left === 1 ? '' : 'S'} LEFT` : 'NO LIMBS LEFT · TERMINATED',
    next: NEXT[cur.name],
  }), 350);
}

function survive(title, cause) {
  if (cur.dead) return;
  cur.dead = true;
  sfx.pay();
  overlay({ kind: 'win', kicker: 'TRIAL SURVIVED', title, cause, line: `${4 - game.lost.length}/4 LIMBS INTACT`, next: NEXT[cur.name] });
}

// ---------- scene: lobby / waiver

function buildLobby() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060504);
  scene.fog = new THREE.Fog(0x060504, 3.5, 9);
  const cam = fpCam();
  scene.add(cam);
  buildRoom(scene, { w: 5, d: 7, h: 3.4, z: -0.5 });
  scene.add(new THREE.HemisphereLight(0x6b5a4a, 0x0a0606, 0.5));
  const lamp = hangingLamp(scene, new THREE.Vector3(0.55, 3.4, -0.75), 0xffb877, 10, 8, 0.85);
  const fill = new THREE.PointLight(0xffb070, 3, 5, 1.5);
  fill.position.set(0, 1.9, 1.2);
  scene.add(fill);

  const steel = std(0x55585a, { metalness: 0.7, roughness: 0.45 });
  mesh(new THREE.BoxGeometry(1.9, 0.07, 1.0), steel, 0, 0.78, 0, scene);
  for (const x of [-0.85, 0.85]) for (const z of [-0.42, 0.42]) mesh(new THREE.BoxGeometry(0.06, 0.78, 0.06), steel, x, 0.39, z, scene);

  const wc = document.createElement('canvas');
  wc.width = 384;
  wc.height = 512;
  const wtex = new THREE.CanvasTexture(wc);
  wtex.colorSpace = THREE.SRGBColorSpace;
  wtex.anisotropy = 8;
  const waiver = mesh(new THREE.PlaneGeometry(0.36, 0.48), std(0xffffff, { map: wtex, roughness: 0.95 }), 0, 0.818, 0.2, scene);
  waiver.rotation.x = -Math.PI / 2;
  waiver.rotation.z = 0.06;
  const pen = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 8), std(0x111111), 0.27, 0.826, 0.26, scene);
  pen.rotation.z = Math.PI / 2;
  pen.rotation.y = 0.5;

  const cage = new THREE.Group();
  cage.position.set(0, 1.95, -0.15);
  scene.add(cage);
  const barM = std(0x2a2a2a, { metalness: 0.85, roughness: 0.35 });
  const s = 0.27, hgt = 0.5;
  for (let i = 0; i < 16; i++) {
    const side = Math.floor(i / 4), u = -s + (i % 4) * ((2 * s) / 4);
    const [x, z] = [[u, -s], [s, u], [-u, s], [-s, -u]][side];
    mesh(new THREE.CylinderGeometry(0.008, 0.008, hgt, 6), barM, x, 0, z, cage);
  }
  for (const y of [-hgt / 2, hgt / 2]) mesh(new THREE.BoxGeometry(2 * s + 0.03, 0.025, 2 * s + 0.03), barM, 0, y, 0, cage);
  mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.3, 6), barM, 0, hgt / 2 + 0.65, 0, cage);
  const cash = new THREE.Group();
  cage.add(cash);
  const fillCash = () => {
    cash.clear();
    const grid = [[-0.085, -0.06], [0.085, -0.06], [-0.085, 0.06], [0.085, 0.06]];
    for (let i = 0; i < game.pot / 10; i++) {
      const c = cashStack();
      c.position.set(grid[i % 4][0], -hgt / 2 + 0.06 + Math.floor(i / 4) * 0.09, grid[i % 4][1]);
      c.rotation.y = rand(-0.15, 0.15);
      cash.add(c);
    }
  };
  const spot = new THREE.SpotLight(0xff2a14, 10, 5, 0.22, 0.5, 1);
  spot.position.set(0, 3.35, -0.15);
  spot.target = cage;
  scene.add(spot);

  const npcs = NPC.map((p, i) => {
    const g = subject(p);
    g.position.set([-0.62, 0, 0.62][i], 0, -0.95);
    g.rotation.y = [0.3, 0, -0.3][i];
    scene.add(g);
    return g;
  });

  const base = new THREE.Vector3(0, 1.5, 1.95), look = new THREE.Vector3(0, 1.08, -0.3);
  const st = { signed: false };
  const row = (p, signed, id = '') => `<div class="r ${signed ? 'in' : 'wait'}" ${id && `id="${id}"`}>
    <div class="dot" style="background:${hex(p.suit)}"></div><div class="n">${p.name}</div>
    <div class="h">${p.hat === 'none' ? 'no hat' : p.hat === 'top' ? 'top hat' : p.hat}</div>
    <div class="st">${signed ? 'SIGNED · $10' : 'UNSIGNED'}</div></div>`;

  return {
    scene, camera: cam,
    help: '<b>Tap SIGN WAIVER</b> to pay the $10 buy-in (Whop sandbox). The pot fills and the cage over the table gets heavier.',
    enter() {
      game.pot = 30;
      game.coins = 62;
      game.lost = [];
      st.signed = false;
      drawWaiver(wc, false);
      wtex.needsUpdate = true;
      fillCash();
    },
    hud: () => `
      <div class="brand"><div class="logo">MEAT<br><span>MARKET</span></div><div class="batch">TEST BATCH #0427<br>3 TRIALS · 4 SUBJECTS</div></div>
      <div class="roster">${row(YOU, false, 'r-you')}${NPC.map((p) => row(p, true)).join('')}</div>
      <div class="spacer"></div>
      <div class="bottom panel">
        <div class="potrow"><div><small>THE POT</small><b id="potbig">$${game.pot}</b></div><div class="wta">WINNER<br>TAKES ALL</div></div>
        <button class="cta" id="sign">SIGN WAIVER · PAY $10</button>
        <div class="fine">Whop sandbox · test card 4242 4242 4242 4242</div>
      </div>`,
    bind() {
      $('#sign').onclick = () => {
        const b = $('#sign');
        if (st.signed) return go('dinner');
        if (b.classList.contains('ghost')) return;
        b.textContent = 'PROCESSING…';
        b.classList.add('ghost');
        setTimeout(() => {
          st.signed = true;
          sfx.pay();
          countUp($('#potbig'), 30, 40);
          game.pot = 40;
          fillCash();
          drawWaiver(wc, true);
          wtex.needsUpdate = true;
          const r = $('#r-you');
          r.className = 'r in';
          r.querySelector('.st').textContent = 'SIGNED · $10';
          b.classList.remove('ghost');
          b.textContent = 'ENTER THE FACILITY →';
        }, 1000);
      };
    },
    update(dt, t) {
      sway(cam, base, look, t);
      cage.rotation.y = Math.sin(t * 0.5) * 0.3;
      cage.position.x = Math.sin(t * 0.8) * 0.02;
      lamp.pivot.rotation.z = Math.sin(t * 0.7) * 0.05;
      flicker(lamp, dt);
      npcs.forEach((g, i) => {
        g.userData.body.position.y = Math.sin(t * 2 + i) * 0.01;
        g.userData.head.rotation.y = Math.sin(t * 0.6 + i * 2) * 0.4;
      });
    },
  };
}

function drawWaiver(c, signed) {
  const g = c.getContext('2d'), w = c.width, h = c.height;
  g.fillStyle = '#e8e0cb';
  g.fillRect(0, 0, w, h);
  speckle(g, w, h, ['#b9ab8a', '#8a6a4a'], 80, 10);
  g.fillStyle = '#1d1a16';
  g.textAlign = 'center';
  g.font = 'bold 34px Georgia, serif';
  g.fillText('WAIVER', w / 2, 56);
  g.font = 'bold 18px Georgia, serif';
  g.fillText('OF LIFE & LIMB', w / 2, 82);
  g.fillRect(30, 94, w - 60, 2);
  g.textAlign = 'left';
  g.font = '15px Georgia, serif';
  ['1. The Facility accepts no liability', '    for limbs, lives, or lunch.', '2. Entry: $10. Non-refundable.', '3. Lose a trial, lose a limb.', '4. Last subject standing', '    takes the entire pot.']
    .forEach((l, i) => g.fillText(l, 34, 130 + i * 25));
  g.fillStyle = '#9a8f7a';
  for (let i = 0; i < 6; i++) g.fillRect(34, 300 + i * 16, w - 68 - (i % 3) * 40, 3);
  g.fillStyle = '#1d1a16';
  g.font = 'bold 24px Georgia, serif';
  g.fillText('X', 34, 460);
  g.fillRect(58, 462, w - 92, 2);
  if (!signed) return;
  g.strokeStyle = '#1b2a6b';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(70, 456);
  g.bezierCurveTo(100, 410, 120, 480, 150, 440);
  g.bezierCurveTo(170, 415, 190, 470, 215, 448);
  g.bezierCurveTo(240, 430, 250, 460, 300, 442);
  g.stroke();
  g.save();
  g.translate(262, 395);
  g.rotate(-0.25);
  g.strokeStyle = '#b0120f';
  g.lineWidth = 5;
  g.strokeRect(-78, -30, 156, 60);
  g.fillStyle = '#b0120f';
  g.font = 'bold 32px Impact, sans-serif';
  g.textAlign = 'center';
  g.fillText('PAID $10', 0, 12);
  g.restore();
}

// ---------- scene: dinner party

function newspaperTex() {
  return canvasTex(512, 340, (g, w, h) => {
    g.fillStyle = '#d6cdb6'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b1b1b'; g.textAlign = 'center';
    g.font = 'bold 46px Georgia, serif'; g.fillText('THE DAILY GRIND', w / 2, 54);
    g.fillRect(16, 64, w - 32, 3);
    g.font = 'bold 25px Georgia, serif'; g.fillText('WORKPLACE ACCIDENTS AT RECORD LOW', w / 2, 100);
    g.fillStyle = '#4a4a4a'; g.fillRect(20, 118, 170, 118);
    g.fillStyle = '#7a7a7a';
    for (let r = 0; r < 7; r++) g.fillRect(20, 250 + r * 11, 170, 4);
    for (let c = 0; c < 2; c++) for (let r = 0; r < 19; r++) g.fillRect(205 + c * 150, 120 + r * 11, 138, 4);
    speckle(g, w, h, ['#8a7a5a'], 60, 8);
  });
}

function host() {
  const g = new THREE.Group();
  const suitM = std(0x141418, { roughness: 0.55 });
  mesh(new THREE.BoxGeometry(0.52, 0.64, 0.3), suitM, 0, 0.98, 0, g);
  mesh(new THREE.BoxGeometry(0.13, 0.46, 0.01), std(0xe8e4dc), 0, 1.06, 0.152, g);
  mesh(new THREE.BoxGeometry(0.045, 0.32, 0.012), std(0x7a0a0a), 0, 1.04, 0.16, g);
  for (const s of [-1, 1]) {
    const arm = mesh(new THREE.CapsuleGeometry(0.06, 0.32, 4, 8), suitM, s * 0.3, 1.0, 0.12, g);
    arm.rotation.x = -1.0;
  }
  const head = mesh(new THREE.SphereGeometry(0.16, 24, 18), std(0xd9d0c4, { roughness: 0.5 }), 0, 1.44, 0, g);
  const hair = mesh(new THREE.SphereGeometry(0.165, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), std(0x111111, { roughness: 0.4 }), 0, 0.01, -0.01, head);
  hair.castShadow = false;
  const eyeM = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1100, emissiveIntensity: 0 });
  mesh(new THREE.SphereGeometry(0.02, 8, 8), eyeM, -0.055, 0.02, 0.145, head);
  mesh(new THREE.SphereGeometry(0.02, 8, 8), eyeM, 0.055, 0.02, 0.145, head);
  const paper = mesh(new THREE.PlaneGeometry(0.82, 0.55), std(0xffffff, { map: newspaperTex(), side: THREE.DoubleSide, roughness: 0.95 }), 0, 1.36, 0.36, g);
  const gun = revolver();
  gun.scale.setScalar(1.6);
  gun.position.set(0.24, 1.2, 0.42);
  gun.visible = false;
  g.add(gun);
  return { g, head, eyeM, paper, gun };
}

function buildDinner() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050404);
  scene.fog = new THREE.Fog(0x050404, 4, 10);
  const cam = fpCam();
  scene.add(cam);
  buildRoom(scene, { w: 4.4, d: 7.5, h: 3.2, z: -1 });
  scene.add(new THREE.HemisphereLight(0x5a4a3a, 0x080505, 0.45));
  const lamp = hangingLamp(scene, new THREE.Vector3(0, 3.2, -0.7), 0xffc58a, 11, 9, 0.95);
  const red = new THREE.PointLight(0xff1a0a, 0, 7, 1.2);
  red.position.set(0, 2.3, -2.2);
  scene.add(red);

  mesh(new THREE.BoxGeometry(1.0, 0.06, 4.4), std(0xffffff, { map: T.cloth([2, 8]), roughness: 0.95 }), 0, 0.77, -0.6, scene);
  const wood = std(0x2a1a10, { roughness: 0.7 });
  for (const x of [-0.45, 0.45]) for (const z of [1.5, -2.7]) mesh(new THREE.BoxGeometry(0.06, 0.74, 0.06), wood, x, 0.37, z, scene);
  mesh(new THREE.BoxGeometry(0.75, 2.1, 0.08), wood, 0, 1.05, -3.3, scene);

  const plateM = std(0xe8e2d6, { roughness: 0.35 });
  const plate = (x, z) => mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.018, 28), plateM, x, 0.81, z, scene);
  plate(0, 1.02);

  const PEAS = 20;
  const peaM = std(0x6f9e2a, { roughness: 0.45 });
  const peas = new THREE.InstancedMesh(new THREE.SphereGeometry(0.017, 10, 8), peaM, PEAS);
  const dummy = new THREE.Object3D();
  const peaPos = [];
  for (let i = 0; i < PEAS; i++) {
    const a = Math.random() * 7, r = Math.sqrt(Math.random()) * 0.08;
    peaPos.push([Math.cos(a) * r, 0.835, 1.02 + Math.sin(a) * r]);
  }
  const resetPeas = (n) => {
    for (let i = 0; i < PEAS; i++) {
      dummy.position.set(...peaPos[i]);
      dummy.scale.setScalar(i < n ? 0 : 1);
      dummy.updateMatrix();
      peas.setMatrixAt(i, dummy.matrix);
    }
    peas.instanceMatrix.needsUpdate = true;
  };
  peas.castShadow = true;
  scene.add(peas);

  const seats = [{ x: -0.6, z: 0.2, ry: Math.PI / 2 }, { x: 0.6, z: -0.55, ry: -Math.PI / 2 }, { x: -0.6, z: -1.4, ry: Math.PI / 2 }];
  const npcs = NPC.map((p, i) => {
    const s = seats[i];
    const g = subject(p, true);
    g.position.set(s.x, 0.16, s.z);
    g.rotation.y = s.ry;
    scene.add(g);
    plate(s.x * 0.62, s.z);
    mesh(new THREE.BoxGeometry(0.45, 0.05, 0.45), wood, s.x - Math.sign(s.x) * 0.02, 0.45, s.z, scene);
    return { p, g, eaten: 0, rate: rand(0.75, 1.05), alive: true, slump: 0 };
  });

  const H = host();
  H.g.position.set(0, 0, -3.0);
  scene.add(H.g);

  const fork = new THREE.Group();
  cam.add(fork);
  const forkM = std(0xc5c9cd, { metalness: 0.95, roughness: 0.22 });
  mesh(new THREE.BoxGeometry(0.014, 0.006, 0.2), forkM, 0, 0, 0.1, fork);
  mesh(new THREE.BoxGeometry(0.024, 0.005, 0.03), forkM, 0, 0, -0.01, fork);
  for (let i = 0; i < 4; i++) mesh(new THREE.BoxGeometry(0.003, 0.004, 0.05), forkM, -0.0098 + i * 0.0065, 0, -0.05, fork);
  const loaded = mesh(new THREE.SphereGeometry(0.016, 10, 8), peaM, 0, 0.012, -0.05, fork);
  const fist = mesh(new THREE.SphereGeometry(0.035, 12, 10), std(0xc8a18a, { roughness: 0.6 }), 0, -0.01, 0.2, fork);
  const sleeve = mesh(new THREE.CapsuleGeometry(0.045, 0.3, 4, 10), std(YOU.suit, { roughness: 0.9 }), 0.02, -0.06, 0.38, fork);
  sleeve.rotation.x = Math.PI / 2 - 0.3;
  fist.castShadow = sleeve.castShadow = false;
  const rest = { p: new THREE.Vector3(0.1, -0.21, -0.42), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.95, 0.3, 0)) };
  const mouth = { p: new THREE.Vector3(0.02, -0.075, -0.17), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0.05, 0)) };

  const st = {};
  const DUR = { reading: () => rand(2.4, 4.4), tell: () => 0.6, lower: () => 0.22, looking: () => rand(1.7, 2.5), raise: () => 0.3 };
  const NEXTPH = { reading: 'tell', tell: 'lower', lower: 'looking', looking: 'raise', raise: 'reading' };
  const VICTIMS = { 2: 0, 4: 2 };

  function setPhase(ph) {
    st.phase = ph;
    st.pt = 0;
    st.dur = DUR[ph]();
    if (ph === 'tell') sfx.rustle();
    if (ph === 'looking') { st.cycles++; st.shotThisCycle = false; }
    const s = $('#status');
    if (!s) return;
    const m = { reading: ['HE’S READING', ''], tell: ['…', 'warn'], lower: ['FREEZE', 'freeze'], looking: ['FREEZE', 'freeze'], raise: ['…', 'warn'] }[ph];
    s.textContent = m[0];
    s.className = 'status ' + m[1];
  }

  function fire(targetPos) {
    H.gun.lookAt(targetPos);
    H.gun.userData.flash.intensity = 40;
    setTimeout(() => (H.gun.userData.flash.intensity = 0), 70);
    sfx.shot();
  }

  const base = new THREE.Vector3(0, 1.22, 1.55), look = new THREE.Vector3(0, 0.82, -2.2);
  const tmp = new THREE.Vector3();
  let boardT = 0;

  function board() {
    const el = $('#board');
    if (!el) return;
    const rows = [{ name: 'YOU', n: st.eaten, me: true, alive: true }, ...npcs.map((n) => ({ name: n.p.name, n: Math.floor(n.eaten), alive: n.alive }))];
    el.innerHTML = rows.map((r) => `<div class="${r.me ? 'me' : ''} ${r.alive ? '' : 'dead'}">${r.name}</div><div class="bar"><i style="width:${(r.n / PEAS) * 100}%"></i></div><div>${r.alive ? `${r.n}/${PEAS}` : 'SHOT'}</div>`).join('');
  }

  return {
    scene, camera: cam,
    help: '<b>Hold</b> the button (or Space) to eat a pea. When the newspaper drops, <b>let go</b>. Anyone moving while he looks gets shot.',
    enter() {
      Object.assign(st, { holding: false, p: 0, back: false, eaten: 0, cycles: 0, won: false });
      resetPeas(0);
      npcs.forEach((n) => {
        n.eaten = 0;
        n.alive = true;
        n.slump = 0;
        n.g.userData.body.rotation.x = 0;
      });
      scene.children.filter((c) => c.userData.decal).forEach((c) => scene.remove(c));
      setPhase('reading');
    },
    hud: () => `${topbar('DINNER PARTY')}
      <div id="status" class="status">HE’S READING</div>
      <div class="board top" id="board"></div>
      <div class="spacer"></div>
      <div class="bottom">
        <div class="holdwrap"><button class="hold" id="hold"><span>HOLD<br>TO EAT</span></button></div>
        <div class="fine">First to ${PEAS} peas lives. Don’t move when he looks up.</div>
      </div>`,
    bind() {
      const b = $('#hold');
      const down = (e) => { e.preventDefault(); st.holding = true; b.classList.add('on'); b.setPointerCapture?.(e.pointerId); };
      const up = () => { st.holding = false; b.classList.remove('on'); };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      board();
      setPhase(st.phase);
    },
    key(e, isDown) {
      if (e.code !== 'Space') return;
      e.preventDefault();
      st.holding = isDown;
      $('#hold')?.classList.toggle('on', isDown);
    },
    kill() { H.gun.visible = true; fire(cam.getWorldPosition(tmp)); die('Shot by The Host for moving', 'YOU MOVED.'); },
    update(dt, t) {
      sway(cam, base, look, t, 0.6);
      lamp.pivot.rotation.z = Math.sin(t * 0.9) * 0.22;
      lamp.pivot.rotation.x = Math.sin(t * 0.6) * 0.08;
      flicker(lamp, dt, 0.006);

      st.pt += dt;
      if (!cur.dead && st.pt >= st.dur) setPhase(NEXTPH[st.phase]);
      const k = clamp(st.pt / st.dur, 0, 1);
      const ph = st.phase;
      const looking = ph === 'lower' || ph === 'looking' || ph === 'raise';
      const paperY = ph === 'lower' ? lerp(1.36, 0.95, ease(k)) : ph === 'raise' ? lerp(0.95, 1.36, ease(k)) : ph === 'looking' ? 0.95 : 1.36;
      H.paper.position.y = paperY;
      H.paper.rotation.x = ((1.36 - paperY) / 0.41) * -1.1;
      H.paper.rotation.z = ph === 'tell' ? Math.sin(t * 45) * 0.03 : 0;
      H.eyeM.emissiveIntensity = ph === 'looking' ? 4 : ph === 'lower' ? 4 * k : 0;
      if (!cur.dead) H.gun.visible = looking;
      H.head.rotation.y = ph === 'looking' ? Math.sin(st.pt * 2.6) * 0.45 : 0;
      red.intensity = looking ? 9 + Math.sin(t * 20) * 2 : 0;
      if (looking && ph !== 'raise' && !cur.dead && !st.shotThisCycle) H.gun.lookAt(cam.getWorldPosition(tmp));

      if (!cur.dead && !st.won) {
        if (st.holding && !st.back) {
          st.p += dt / 0.6;
          if (st.p >= 1) {
            st.p = 1;
            st.back = true;
            st.eaten++;
            resetPeas(st.eaten);
            sfx.tick();
            if (st.eaten >= PEAS) {
              st.won = true;
              survive('CLEAN PLATE.', 'You ate every pea and kept your arms.');
            }
          }
        } else {
          st.p -= dt / 0.35;
          if (st.p <= 0) { st.p = 0; st.back = false; }
        }
        if (st.holding && ((ph === 'lower' && k > 0.5) || ph === 'looking')) {
          fire(cam.getWorldPosition(tmp));
          die('Shot by The Host for moving', 'YOU MOVED.');
        }
      }
      const pe = ease(clamp(st.p, 0, 1));
      fork.position.lerpVectors(rest.p, mouth.p, pe);
      fork.quaternion.slerpQuaternions(rest.q, mouth.q, pe);
      loaded.visible = !st.back && st.p > 0.05;
      const hb = $('#hold');
      if (hb) hb.style.setProperty('--p', st.p.toFixed(3));

      npcs.forEach((n, i) => {
        const arm = n.g.userData.limbs.ra;
        if (n.alive) {
          if (ph === 'reading') {
            n.eaten = Math.min(PEAS - 1, n.eaten + n.rate * dt);
            arm.rotation.x = -0.9 - Math.abs(Math.sin(t * 5 + i)) * 0.9;
          } else arm.rotation.x = lerp(arm.rotation.x, -0.9, 0.2);
          n.g.userData.head.rotation.y = looking ? 0 : Math.sin(t * 0.8 + i) * 0.2;
        } else {
          n.slump = Math.min(1, n.slump + dt * 3);
          n.g.userData.body.rotation.x = ease(n.slump) * 0.95;
        }
      });
      const vi = VICTIMS[st.cycles];
      if (ph === 'looking' && st.pt > 0.8 && vi !== undefined && !st.shotThisCycle && !cur.dead) {
        st.shotThisCycle = true;
        const n = npcs[vi];
        if (n.alive) {
          n.alive = false;
          fire(n.g.userData.head.getWorldPosition(tmp));
          decal(scene, n.g.position.x * 0.55, 0.802, n.g.position.z + 0.05, 0.16);
          feed(`<b>${n.p.name}</b> twitched. Shot. −1 arm`);
          shake();
        }
      }
      boardT += dt;
      if (boardT > 0.15) { boardT = 0; board(); }
    },
  };
}

// ---------- scene: the grinder

function buildGrinder() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070404);
  scene.fog = new THREE.Fog(0x0a0505, 3, 13);
  const cam = fpCam(86);
  scene.add(cam);
  const Z0 = -6.15;
  buildRoom(scene, { w: 3.8, d: 15, h: 3.4, z: -0.4 });
  scene.add(new THREE.HemisphereLight(0x5a4a3a, 0x080505, 0.4));
  const cages = [3.2, -0.6, -4.2].map((z) => {
    const l = new THREE.PointLight(0xffa860, 4, 6, 1.4);
    l.position.set(0, 3.0, z);
    scene.add(l);
    mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshStandardMaterial({ emissive: 0xffa860, emissiveIntensity: 2.5, color: 0xffffff }), 0, 3.1, z, scene).castShadow = false;
    return l;
  });
  const redL = new THREE.PointLight(0xff200a, 6, 6, 1.4);
  redL.position.set(0, 1.4, Z0 + 0.6);
  scene.add(redL);

  const lanesX = [-1.275, -0.425, 0.425, 1.275];
  const ME = 2;
  mesh(new THREE.BoxGeometry(3.45, 0.1, 13.5), std(0x161616, { roughness: 0.9 }), 0, 0.05, 0.4, scene);
  const SL = 60, SP = 0.225, LEN = SL * SP;
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.76, 0.03, 0.16), std(0x2e2e2e, { metalness: 0.7, roughness: 0.45 }), SL * 4);
  slats.receiveShadow = true;
  scene.add(slats);
  const dummy = new THREE.Object3D();
  const railM = std(0xb08a10, { metalness: 0.6, roughness: 0.5 });
  for (const x of [-1.7, -0.85, 0, 0.85, 1.7]) {
    const r = mesh(new THREE.CylinderGeometry(0.025, 0.025, 13, 10), railM, x, 1.0, 0.4, scene);
    r.rotation.x = Math.PI / 2;
    for (let z = -5.5; z < 7; z += 1.6) mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.95, 8), railM, x, 0.52, z, scene);
  }

  const rustM = new THREE.MeshStandardMaterial({ map: T.rust([3, 3]), roughness: 0.8, metalness: 0.5 });
  mesh(new THREE.BoxGeometry(3.8, 2.0, 1.0), rustM, 0, 2.4, Z0 - 0.8, scene);
  const haz = mesh(new THREE.PlaneGeometry(3.8, 0.28), std(0xffffff, { map: T.hazard([5, 1]) }), 0, 1.5, Z0 - 0.29, scene);
  haz.castShadow = false;
  const toothM = std(0x8a8c8e, { metalness: 0.9, roughness: 0.3 });
  const rollers = [[0.42, 0.4, -1], [1.14, 0.32, 1]].map(([y, r, dir]) => {
    const grp = new THREE.Group();
    grp.position.set(0, y, Z0 - 0.35);
    scene.add(grp);
    const cyl = mesh(new THREE.CylinderGeometry(r, r, 3.7, 24), std(0x3a3634, { metalness: 0.7, roughness: 0.5 }), 0, 0, 0, grp);
    cyl.rotation.z = Math.PI / 2;
    const AR = 14, AC = 14;
    const teeth = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.14, 4), toothM, AR * AC);
    let n = 0;
    for (let a = 0; a < AR; a++) for (let c = 0; c < AC; c++) {
      const ang = (a / AR) * Math.PI * 2 + (c % 2) * 0.2;
      dummy.position.set(-1.75 + (c / (AC - 1)) * 3.5, Math.cos(ang) * (r + 0.05), Math.sin(ang) * (r + 0.05));
      dummy.rotation.set(ang, 0, 0);
      dummy.updateMatrix();
      teeth.setMatrixAt(n++, dummy.matrix);
    }
    grp.add(teeth);
    return { grp, dir, cyl };
  });
  const beacons = [-1.4, 1.4].map((x) => mesh(new THREE.SphereGeometry(0.08, 12, 10), new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1100, emissiveIntensity: 3 }), x, 3.45, Z0 - 0.3, scene));

  const PN = 220;
  const mkParticles = (color, size, blending) => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(PN * 3).fill(-99);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true, blending, depthWrite: false }));
    pts.frustumCulled = false;
    scene.add(pts);
    return { pts, pos, vel: new Float32Array(PN * 3), life: new Float32Array(PN), i: 0 };
  };
  const sparks = mkParticles(0xffa040, 0.035, THREE.AdditiveBlending);
  const gore = mkParticles(0xa00000, 0.06, THREE.NormalBlending);
  const emit = (P, x, y, z, vx, vy, vz, life) => {
    const i = P.i++ % PN;
    P.pos.set([x, y, z], i * 3);
    P.vel.set([vx, vy, vz], i * 3);
    P.life[i] = life;
  };
  const stepParticles = (P, dt, g) => {
    for (let i = 0; i < PN; i++) {
      if (P.life[i] <= 0) { P.pos[i * 3 + 1] = -99; continue; }
      P.life[i] -= dt;
      P.vel[i * 3 + 1] -= g * dt;
      for (let k = 0; k < 3; k++) P.pos[i * 3 + k] += P.vel[i * 3 + k] * dt;
      if (P.pos[i * 3 + 1] < 0.13) { P.pos[i * 3 + 1] = 0.13; P.vel[i * 3 + 1] *= -0.2; P.vel[i * 3] *= 0.6; P.vel[i * 3 + 2] *= 0.6; }
    }
    P.pts.geometry.attributes.position.needsUpdate = true;
  };

  const runners = NPC.map((p, i) => {
    const g = subject(p);
    g.rotation.y = Math.PI;
    scene.add(g);
    return { p, g, lane: [0, 1, 3][i], d: 4, rate: rand(4.2, 5.2), alive: true, weak: i === 1, gone: 0 };
  });

  const hands = {};
  const skin = std(0xc8a18a, { roughness: 0.6 });
  for (const [k, s] of [['L', -1], ['R', 1]]) {
    const h = new THREE.Group();
    const sl = mesh(new THREE.CapsuleGeometry(0.05, 0.34, 4, 10), std(YOU.suit, { roughness: 0.9 }), 0, 0, 0.2, h);
    sl.rotation.x = Math.PI / 2;
    mesh(new THREE.SphereGeometry(0.05, 12, 10), skin, 0, 0, -0.03, h);
    h.children.forEach((c) => (c.castShadow = false));
    cam.add(h);
    hands[k] = { h, s, a: 0 };
  }

  const st = {};
  const TIME = 20;

  function tap(side) {
    if (cur.dead || st.done) return;
    hands[side].a = 1;
    if (side !== st.last) {
      st.d = Math.min(5, st.d + 0.34);
      sfx.grab();
    } else {
      st.d += 0.04;
      sfx.slip();
      shake();
    }
    st.last = side;
    const el = $(side === 'L' ? '#hl' : '#hr');
    el?.classList.add('hit');
    setTimeout(() => el?.classList.remove('hit'), 90);
    $('#hl')?.classList.toggle('next', side === 'R');
    $('#hr')?.classList.toggle('next', side === 'L');
  }

  return {
    scene, camera: cam,
    help: '<b>Alternate LEFT / RIGHT</b> (or A / D) to haul yourself back along the rails. The belt never stops. Same hand twice and you slip.',
    enter() {
      Object.assign(st, { d: 4.2, t: 0, last: null, done: false, v: 1.0 });
      runners.forEach((r) => {
        r.d = 4.2 + rand(-0.4, 0.4);
        r.alive = true;
        r.gone = 0;
        r.g.visible = true;
        r.g.scale.setScalar(1);
      });
      gore.life.fill(0);
      rollers.forEach((r) => r.cyl.material.color.setHex(0x3a3634));
      droneOn();
    },
    exit() { droneOff(); },
    hud: () => `${topbar('THE GRINDER')}
      <div class="timer" id="gtimer">SURVIVE<b>0:${TIME}</b></div>
      <div class="meter"><div class="mlabel">GAP</div><div class="mbar"><i id="mfill"></i></div><div class="mval" id="mval">4.2m</div></div>
      <div class="spacer"></div>
      <div class="bottom">
        <div class="hands"><button class="hand next" id="hl">LEFT<small>HAND</small></button><button class="hand next" id="hr">RIGHT<small>HAND</small></button></div>
        <div class="fine">Alternate hands to haul back. Same hand twice = slip.</div>
      </div>`,
    bind() {
      $('#hl').addEventListener('pointerdown', (e) => { e.preventDefault(); tap('L'); });
      $('#hr').addEventListener('pointerdown', (e) => { e.preventDefault(); tap('R'); });
    },
    key(e, isDown) {
      if (!isDown || e.repeat) return;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') tap('L');
      if (e.code === 'KeyD' || e.code === 'ArrowRight') tap('R');
    },
    kill() { st.d = 0; },
    update(dt, t) {
      const alive = !cur.dead && !st.done;
      if (alive) {
        st.t += dt;
        st.v = 0.95 + st.t * 0.035;
        st.d -= st.v * dt;
        if (st.t >= TIME) {
          st.done = true;
          survive('STILL WHOLE.', 'The belt stopped. You didn’t go in.');
        }
        if (st.d <= 0.3) {
          st.d = 0.3;
          for (let i = 0; i < 160; i++) emit(gore, lanesX[ME] + rand(-0.3, 0.3), 0.8, Z0 + 0.2, rand(-1, 1), rand(1, 4), rand(1, 4.5), rand(0.6, 1.4));
          rollers.forEach((r) => r.cyl.material.color.setHex(0x5a1010));
          die('Fed feet-first into The Grinder', 'GROUND.', 'crunch');
        }
      }
      const off = (t * (alive ? st.v : 0.4)) % SP;
      let n = 0;
      for (let l = 0; l < 4; l++) for (let i = 0; i < SL; i++) {
        dummy.position.set(lanesX[l], 0.115, Z0 + 0.05 + ((i * SP - off + LEN) % LEN));
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        slats.setMatrixAt(n++, dummy.matrix);
      }
      slats.instanceMatrix.needsUpdate = true;
      rollers.forEach((r) => (r.grp.rotation.x += r.dir * dt * 4.5));
      beacons.forEach((b, i) => (b.material.emissiveIntensity = Math.sin(t * 8 + i * 3) > 0 ? 4 : 0.3));
      redL.intensity = 5 + Math.sin(t * 8) * 2;
      cages.forEach((l) => (l.intensity = Math.random() < 0.01 ? 0.3 : 4));
      for (let i = 0; i < 6; i++) emit(sparks, rand(-1.7, 1.7), 0.78, Z0 - 0.05, rand(-0.6, 0.6), rand(1, 3.2), rand(0.4, 2.6), rand(0.3, 0.8));
      stepParticles(sparks, dt, 6);
      stepParticles(gore, dt, 7);

      runners.forEach((r) => {
        if (r.alive && alive) {
          const rate = r.weak && st.t > 6 ? 2.3 : r.rate + Math.sin(t * 1.3 + r.lane) * 0.6;
          r.d = Math.min(5, r.d + (rate * 0.34 - st.v) * dt);
          if (!r.weak) r.d = Math.max(r.d, 1.2);
          if (r.d <= 0.3) {
            r.alive = false;
            sfx.crunch();
            shake();
            for (let i = 0; i < 160; i++) emit(gore, lanesX[r.lane] + rand(-0.3, 0.3), 0.8, Z0 + 0.15, rand(-1.2, 1.2), rand(1, 4.5), rand(0.5, 4), rand(0.6, 1.6));
            rollers.forEach((ro) => ro.cyl.material.color.setHex(0x5a1010));
            feed(`<b>${r.p.name}</b> went in. −1 leg`);
          }
        }
        if (!r.alive) {
          r.gone = Math.min(1, r.gone + dt * 2.5);
          r.g.position.y = -r.gone * 0.8;
          r.g.scale.setScalar(1 - r.gone * 0.6);
          if (r.gone >= 1) r.g.visible = false;
        } else r.g.position.y = Math.abs(Math.sin(t * 9 + r.lane)) * 0.05;
        r.g.position.x = lanesX[r.lane];
        r.g.position.z = Z0 + (r.alive ? r.d : 0.1);
        const ls = r.g.userData.limbs;
        ls.la.rotation.x = -1.4 + Math.sin(t * 9 + r.lane) * 0.5;
        ls.ra.rotation.x = -1.4 - Math.sin(t * 9 + r.lane) * 0.5;
      });

      const near = clamp(1 - (st.d - 0.3) / 3.2, 0, 1);
      const bob = Math.sin(t * 12) * 0.012;
      const sh = near * near * 0.035;
      cam.position.set(lanesX[ME] + rand(-sh, sh), 1.55 + bob + rand(-sh, sh), Z0 + st.d + 0.35);
      cam.lookAt(lanesX[ME] - 0.2, 0.95, Z0 - 2.5);
      for (const k of ['L', 'R']) {
        const hd = hands[k];
        hd.a = Math.max(0, hd.a - dt * 7);
        const reach = Math.sin(hd.a * Math.PI);
        hd.h.position.set(hd.s * 0.2, -0.27 + reach * 0.03, -0.42 - reach * 0.12);
        hd.h.rotation.set(-0.2, 0, 0);
      }
      vig.style.opacity = (near * 0.95).toFixed(2);
      droneLevel(0.03 + near * 0.12);
      const fill = $('#mfill');
      if (fill) {
        fill.style.height = `${clamp((st.d - 0.3) / 4.7, 0, 1) * 100}%`;
        $('#mval').textContent = `${Math.max(0, st.d - 0.3).toFixed(1)}m`;
        const left = Math.max(0, Math.ceil(TIME - st.t));
        $('#gtimer b').textContent = `0:${String(left).padStart(2, '0')}`;
      }
    },
  };
}

// ---------- scene: last chamber

function buildChamber() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050404);
  scene.fog = new THREE.Fog(0x050404, 3, 8);
  const cam = fpCam(84);
  scene.add(cam);
  buildRoom(scene, { w: 4.5, d: 5.5, h: 3.2, z: -0.5 });
  scene.add(new THREE.HemisphereLight(0x5a4a3a, 0x080505, 0.4));
  const lamp = hangingLamp(scene, new THREE.Vector3(0, 3.2, -0.55), 0xffc07a, 9, 7, 0.95);
  const C = new THREE.Vector3(0, 0, -0.35);
  mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.06, 48), std(0x1e2e22, { roughness: 0.95 }), C.x, 0.78, C.z, scene);
  mesh(new THREE.TorusGeometry(0.72, 0.03, 8, 48), std(0x2a1a10, { roughness: 0.6 }), C.x, 0.8, C.z, scene).rotation.x = Math.PI / 2;
  mesh(new THREE.CylinderGeometry(0.1, 0.25, 0.75, 16), std(0x2a1a10), C.x, 0.375, C.z, scene);

  const angles = [Math.PI / 2, (200 * Math.PI) / 180, (270 * Math.PI) / 180, (340 * Math.PI) / 180];
  const R = 0.98;
  const seatPos = angles.map((a) => new THREE.Vector3(C.x + Math.cos(a) * R, 0, C.z + Math.sin(a) * R));
  const players = [{ p: YOU, alive: true, you: true }, ...NPC.map((p, i) => {
    const g = subject(p, true);
    const sp = seatPos[i + 1];
    g.position.set(sp.x, 0.16, sp.z);
    g.rotation.y = Math.atan2(C.x - sp.x, C.z - sp.z);
    scene.add(g);
    return { p, g, alive: true, slump: 0 };
  })];

  const spinner = new THREE.Group();
  spinner.position.set(C.x, 0.84, C.z);
  scene.add(spinner);
  const gun = revolver();
  gun.scale.setScalar(1.9);
  gun.rotation.z = Math.PI / 2;
  spinner.add(gun);

  const st = {};
  const aimAt = (i) => Math.atan2(seatPos[i].x - C.x, seatPos[i].z - C.z);
  const reload = () => { st.bullet = Math.floor(rand(1, 6)); st.idx = 0; };

  function cyl() {
    const el = $('#cyl');
    if (!el) return;
    const dots = [...Array(6)].map((_, i) => {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      return `<circle class="${i < st.idx ? 'spent' : i === st.idx ? 'now' : ''}" cx="${20 + Math.cos(a) * 12}" cy="${20 + Math.sin(a) * 12}" r="4.6"/>`;
    }).join('');
    el.innerHTML = `<svg class="cyl" viewBox="0 0 40 40">${dots}</svg><div class="odds">1 IN ${6 - st.idx}<small>ODDS</small></div>`;
  }

  function setTurn(i) {
    st.turn = i;
    st.from = spinner.rotation.y;
    let to = aimAt(i);
    while (to < st.from + Math.PI * 1.2) to += Math.PI * 2;
    st.to = to;
    st.spinT = 0;
    st.phase = 'spin';
    const mine = !!players[i].you;
    const t = $('#turn');
    if (t) {
      t.textContent = mine ? 'YOUR TURN' : `${players[i].p.name}’S TURN`;
      t.className = 'turn' + (mine ? ' me' : '');
    }
    if ($('#pull')) $('#pull').disabled = !mine;
    if ($('#pass')) $('#pass').disabled = !mine || game.coins < 15;
    cyl();
  }

  function nextTurn() {
    if (cur.dead) return;
    if (players.filter((p) => p.alive).length === 1 && players[0].alive) {
      st.phase = 'done';
      return survive('LAST ONE SEATED.', 'Everyone else pulled the wrong chamber.');
    }
    let i = st.turn;
    do i = (i + 1) % 4; while (!players[i].alive);
    setTurn(i);
  }

  function pull() {
    const pl = players[st.turn];
    st.phase = 'pulled';
    if ($('#pull')) $('#pull').disabled = true;
    if ($('#pass')) $('#pass').disabled = true;
    if (st.idx === st.bullet) {
      gun.userData.flash.intensity = 40;
      setTimeout(() => (gun.userData.flash.intensity = 0), 80);
      if (pl.you) return die('The chamber was not empty', 'BANG.');
      sfx.shot();
      shake();
      flash('rgba(255,180,120,.5)');
      pl.alive = false;
      decal(scene, C.x + (pl.g.position.x - C.x) * 0.62, 0.812, C.z + (pl.g.position.z - C.z) * 0.62, 0.18);
      feed(`<b>${pl.p.name}</b> pulled. BANG. −1 arm`);
      reload();
    } else {
      sfx.click();
      st.idx++;
      toast(pl.you ? '…click.<small>you live. for now.</small>' : `<b>click.</b><small>${pl.p.name} lives</small>`, 1100);
    }
    cyl();
    setTimeout(nextTurn, 1300);
  }

  return {
    scene, camera: cam,
    help: '<b>Pull</b> the trigger or <b>pass</b> it for 15 coins. Passing means the next subject faces the same chamber.',
    enter() {
      reload();
      players.forEach((p) => {
        p.alive = true;
        if (p.g) { p.slump = 0; p.g.userData.body.rotation.x = 0; }
      });
      scene.children.filter((c) => c.userData.decal).forEach((c) => scene.remove(c));
      spinner.rotation.y = aimAt(3);
      st.turn = 3;
      st.phase = 'idle';
    },
    hud: () => `${topbar('LAST CHAMBER')}
      <div id="turn" class="turn">SPINNING…</div>
      <div class="cylwrap" id="cyl"></div>
      <div class="spacer"></div>
      <div class="bottom">
        <div class="coins"><span>YOUR COINS</span><b id="coins">${game.coins}c</b></div>
        <div class="row2"><button class="cta" id="pull" disabled>PULL</button><button class="cta ghost" id="pass" disabled>PASS · 15c</button></div>
        <div class="fine">Pass and the next subject faces your chamber.</div>
      </div>`,
    bind() {
      $('#pull').onclick = () => st.phase === 'wait' && players[st.turn].you && pull();
      $('#pass').onclick = () => {
        if (st.phase !== 'wait' || !players[st.turn].you || game.coins < 15) return;
        game.coins -= 15;
        $('#coins').textContent = `${game.coins}c`;
        st.phase = 'pulled';
        toast('PASSED.<small>−15 coins</small>', 900);
        setTimeout(nextTurn, 700);
      };
      cyl();
      setTimeout(() => setTurn(0), 400);
    },
    kill() {
      st.idx = st.bullet;
      if (players[st.turn].you) return pull();
      gun.userData.flash.intensity = 40;
      setTimeout(() => (gun.userData.flash.intensity = 0), 80);
      die('The chamber was not empty', 'BANG.');
    },
    update(dt, t) {
      lamp.pivot.rotation.z = Math.sin(t * 0.8) * 0.06;
      flicker(lamp, dt, 0.008);
      const mine = !!players[st.turn]?.you;
      if (st.phase === 'spin') {
        st.spinT += dt / 1.1;
        const k = clamp(st.spinT, 0, 1);
        const prev = spinner.rotation.y;
        spinner.rotation.y = lerp(st.from, st.to, 1 - Math.pow(1 - k, 3));
        if (Math.floor(prev * 3) !== Math.floor(spinner.rotation.y * 3)) sfx.tick();
        if (k >= 1) { st.phase = 'wait'; st.waitT = 0; }
      } else if (st.phase === 'wait' && !mine && !cur.dead) {
        st.waitT += dt;
        if (st.waitT > 1.0) pull();
      }
      players.forEach((p, i) => {
        if (!p.g) return;
        if (!p.alive) {
          p.slump = Math.min(1, p.slump + dt * 3);
          p.g.userData.body.rotation.x = ease(p.slump) * 1.0;
        } else {
          p.g.userData.head.rotation.y = Math.sin(t * 0.7 + i) * 0.15;
          p.g.userData.body.position.y = Math.sin(t * 6 + i) * 0.004;
        }
      });
      sway(cam, new THREE.Vector3(0, 1.26, C.z + R + 0.15), new THREE.Vector3(0, 0.82, C.z - 0.55), t, mine ? 1.8 : 0.8);
    },
  };
}

// ---------- scene: the machine's offer

function crtDraw(g, w, h, t) {
  g.fillStyle = '#020a03';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#3cff6a';
  g.lineWidth = 4;
  g.beginPath();
  g.ellipse(w / 2, h * 0.42, w * 0.3, h * 0.2, 0, 0, 7);
  g.stroke();
  const px = w / 2 + Math.sin(t * 0.9) * w * 0.12, py = h * 0.42 + Math.sin(t * 1.7) * h * 0.04;
  g.fillStyle = '#ff2a1a';
  g.beginPath();
  g.arc(px, py, h * 0.09, 0, 7);
  g.fill();
  g.fillStyle = '#000';
  g.beginPath();
  g.arc(px, py, h * 0.04, 0, 7);
  g.fill();
  g.fillStyle = '#3cff6a';
  g.font = 'bold 22px monospace';
  g.textAlign = 'center';
  g.fillText('I HAVE AN OFFER', w / 2, h * 0.82);
  if (Math.floor(t * 2) % 2) g.fillRect(w / 2 + 104, h * 0.82 - 18, 12, 20);
  g.globalAlpha = 0.25;
  g.fillStyle = '#000';
  for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 2);
  g.globalAlpha = 1;
}

function buildOffer() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040505);
  scene.fog = new THREE.Fog(0x040505, 3, 8);
  const cam = fpCam(84);
  scene.add(cam);
  buildRoom(scene, { w: 4.2, d: 5, h: 3.4, z: -0.6 });
  scene.add(new THREE.HemisphereLight(0x4a5a4a, 0x060505, 0.4));
  const lamp = hangingLamp(scene, new THREE.Vector3(0, 3.4, 0.3), 0xffb070, 5, 6, 0.6);
  const rustM = new THREE.MeshStandardMaterial({ map: T.rust([2, 2]), roughness: 0.75, metalness: 0.55 });
  const Z = -2.75;
  mesh(new THREE.BoxGeometry(2.3, 2.9, 0.8), rustM, 0, 1.45, Z, scene);
  mesh(new THREE.BoxGeometry(1.15, 0.92, 0.12), std(0x1a1a1a, { metalness: 0.6 }), 0, 2.0, Z + 0.43, scene);
  const crtC = document.createElement('canvas');
  crtC.width = 320;
  crtC.height = 240;
  const crtTex = new THREE.CanvasTexture(crtC);
  crtTex.colorSpace = THREE.SRGBColorSpace;
  const screenM = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: crtTex, emissiveIntensity: 1.4 });
  mesh(new THREE.PlaneGeometry(0.98, 0.74), screenM, 0, 2.0, Z + 0.495, scene).castShadow = false;
  const glow = new THREE.PointLight(0x3cff6a, 4, 4, 1.4);
  glow.position.set(0, 2.0, Z + 1.0);
  scene.add(glow);
  const leds = [];
  for (let i = 0; i < 7; i++) {
    leds.push(mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: i % 2 ? 0xff2200 : 0xffaa00, emissiveIntensity: 2 }), -0.45 + i * 0.15, 1.35, Z + 0.42, scene));
  }
  for (const x of [-0.6, 0.6]) {
    const dial = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 24), std(0xd8d0bc, { roughness: 0.6 }), x, 1.0, Z + 0.42, scene);
    dial.rotation.x = Math.PI / 2;
  }
  const needles = [-0.6, 0.6].map((x) => mesh(new THREE.BoxGeometry(0.01, 0.11, 0.005), std(0xaa0000), x, 1.0, Z + 0.45, scene));
  mesh(new THREE.BoxGeometry(0.4, 0.04, 0.06), std(0x0a0a0a), 0, 0.72, Z + 0.42, scene);
  mesh(new THREE.BoxGeometry(0.36, 0.02, 0.05), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffaa00, emissiveIntensity: 1.5 }), 0, 0.72, Z + 0.44, scene);
  const pipeM = new THREE.MeshStandardMaterial({ map: T.rust([1, 4]), roughness: 0.6, metalness: 0.6 });
  for (const x of [-1.0, 1.0]) mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.4, 12), pipeM, x * 1.35, 1.7, Z + 0.1, scene);
  mesh(new THREE.TorusGeometry(0.5, 0.06, 10, 24, Math.PI), pipeM, 0, 2.95, Z + 0.1, scene).castShadow = false;

  const CARDS = [
    { id: 'fuse', name: 'SHORT FUSE', cost: 20, desc: 'Cut a rival’s next timer by 3 seconds.', done: 'gets 3 fewer seconds next trial.' },
    { id: 'swap', name: 'LIMB SWAP', cost: 45, desc: 'Trade limb counts with a rival. Yours for theirs.', done: 'now has your limb count. You have theirs.' },
    { id: 'load', name: 'ONE MORE ROUND', cost: 30, desc: 'Load a second bullet for their next pull.', done: 'is getting a second bullet. They don’t know.' },
  ];
  const st = { card: null, target: null, done: false, t: 0 };
  const base = new THREE.Vector3(0, 1.5, 0.9), look = new THREE.Vector3(0, 1.75, Z);
  const OFFER_T = 15;

  const refresh = () => {
    document.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', c.dataset.id === st.card));
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.id === st.target));
    if (st.done) return;
    const card = CARDS.find((c) => c.id === st.card);
    const b = $('#rig');
    b.disabled = !(card && st.target && game.coins >= card.cost);
    b.textContent = !card ? 'PICK AN OFFER' : !st.target ? 'PICK A VICTIM' : `RIG IT · ${card.cost}c`;
  };

  return {
    scene, camera: cam,
    help: 'Between trials <b>The Machine</b> sells sabotage for coins. Pick an offer and a victim. They won’t know it was you.',
    enter() { Object.assign(st, { card: null, target: null, done: false, t: 0 }); },
    hud: () => `${topbar('THE MACHINE', 'INTERMISSION')}
      <div class="spacer"></div>
      <div class="bottom panel">
        <div class="coins"><span>YOUR COINS</span><b id="coins">${game.coins}c</b></div>
        <div class="cards">${CARDS.map((c) => `<button class="card" data-id="${c.id}"><b>${c.name}</b><em>${c.cost}c</em><span>${c.desc}</span></button>`).join('')}</div>
        <div class="label">VICTIM</div>
        <div class="chips">${NPC.map((p) => `<button class="chip" data-id="${p.id}">${p.name}</button>`).join('')}</div>
        <div class="expire"><i id="exp"></i></div>
        <button class="cta" id="rig" disabled>PICK AN OFFER</button>
      </div>`,
    bind() {
      document.querySelectorAll('.card').forEach((c) => (c.onclick = () => { st.card = c.dataset.id; sfx.tick(); refresh(); }));
      document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { st.target = c.dataset.id; sfx.tick(); refresh(); }));
      $('#rig').onclick = () => {
        if (st.done) return go('grinder');
        const card = CARDS.find((c) => c.id === st.card);
        const victim = NPC.find((p) => p.id === st.target);
        game.coins -= card.cost;
        countUp($('#coins'), game.coins + card.cost, game.coins, 500, (v) => `${Math.round(v)}c`);
        st.done = true;
        sfx.pay();
        flash('rgba(60,255,106,.35)');
        toast(`<b>${victim.name}</b> ${card.done}<small>the machine thanks you</small>`, 2200);
        $('#rig').disabled = false;
        $('#rig').textContent = 'NEXT TRIAL: THE GRINDER →';
      };
      refresh();
    },
    update(dt, t) {
      sway(cam, base, look, t, 0.7);
      flicker(lamp, dt, 0.02);
      crtDraw(crtC.getContext('2d'), 320, 240, t);
      crtTex.needsUpdate = true;
      screenM.emissiveIntensity = 1.3 + Math.random() * 0.15;
      glow.intensity = 3.5 + Math.random() * 0.8;
      leds.forEach((l, i) => (l.material.emissiveIntensity = Math.sin(t * 5 + i * 1.7) > 0.2 ? 2.5 : 0.1));
      needles.forEach((n, i) => (n.rotation.z = Math.sin(t * (1.3 + i)) * 0.8 + (Math.random() - 0.5) * 0.1));
      if (!st.done) st.t += dt;
      const e = $('#exp');
      if (e) e.style.width = `${clamp(1 - st.t / OFFER_T, 0, 1) * 100}%`;
    },
  };
}

// ---------- scene: payout

function buildPayout() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060504);
  scene.fog = new THREE.Fog(0x060504, 3, 9);
  const cam = fpCam(84);
  scene.add(cam);
  buildRoom(scene, { w: 5, d: 7, h: 3.4, z: -0.5 });
  scene.add(new THREE.HemisphereLight(0x6b5a4a, 0x0a0606, 0.5));
  const lamp = hangingLamp(scene, new THREE.Vector3(0, 3.4, -0.7), 0xffd59a, 12, 8, 0.9);
  const fill = new THREE.PointLight(0xffc080, 4, 5, 1.5);
  fill.position.set(0, 1.8, 1.0);
  scene.add(fill);
  const steel = std(0x55585a, { metalness: 0.7, roughness: 0.45 });
  mesh(new THREE.BoxGeometry(1.9, 0.07, 1.0), steel, 0, 0.78, 0, scene);
  for (const x of [-0.85, 0.85]) for (const z of [-0.42, 0.42]) mesh(new THREE.BoxGeometry(0.06, 0.78, 0.06), steel, x, 0.39, z, scene);
  const barM = std(0x2a2a2a, { metalness: 0.85, roughness: 0.35 });
  const cage = new THREE.Group();
  cage.position.set(0, 1.07, -0.1);
  scene.add(cage);
  const s = 0.27, hgt = 0.5;
  for (let i = 0; i < 16; i++) {
    const side = Math.floor(i / 4), u = -s + (i % 4) * ((2 * s) / 4);
    if (side === 2) continue;
    const [x, z] = [[u, -s], [s, u], [-u, s], [-s, -u]][side];
    mesh(new THREE.CylinderGeometry(0.008, 0.008, hgt, 6), barM, x, 0, z, cage);
  }
  for (const y of [-hgt / 2, hgt / 2]) mesh(new THREE.BoxGeometry(2 * s + 0.03, 0.025, 2 * s + 0.03), barM, 0, y, 0, cage);
  const door = new THREE.Group();
  door.position.set(-s, 0, s);
  door.rotation.y = -1.9;
  cage.add(door);
  for (let i = 0; i < 4; i++) mesh(new THREE.CylinderGeometry(0.008, 0.008, hgt, 6), barM, i * ((2 * s) / 4) + 0.03, 0, 0, door);
  mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.1, 6), barM, 0, hgt / 2 + 1.05, 0, cage);
  [[-0.085, -0.06], [0.085, -0.06], [-0.085, 0.06], [0.085, 0.06]].forEach(([x, z]) => {
    const c = cashStack();
    c.position.set(x, -hgt / 2 + 0.06, z);
    c.rotation.y = rand(-0.2, 0.2);
    cage.add(c);
  });
  [{ hat: 'cone', pos: [-0.62, 0.81, 0.25], rz: 0.5 }, { hat: 'top', pos: [0.6, 0.81, 0.2], rz: 0.3 }, { hat: 'bucket', pos: [0.45, 0.02, 0.9], rz: 1.4 }].forEach(({ hat, pos, rz }) => {
    const src = subject({ suit: 0, hat }).userData.head;
    const holder = new THREE.Group();
    src.children.slice(2).forEach((c) => holder.add(c.clone()));
    holder.position.set(pos[0], pos[1] - 0.12, pos[2]);
    holder.rotation.z = rz;
    scene.add(holder);
  });
  decal(scene, -0.6, 0.817, 0.15, 0.14);
  decal(scene, 0.4, 0.012, 0.95, 0.3);
  decal(scene, -1.2, 0.012, -0.6, 0.25);

  const BILLS = 70;
  const bills = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.13, 0.06), std(0x6f9a52, { side: THREE.DoubleSide, roughness: 0.8 }), BILLS);
  scene.add(bills);
  const bd = [...Array(BILLS)].map(() => ({ x: rand(-1.2, 1.2), y: rand(0.8, 3.2), z: rand(-1.2, 1.2), r: rand(0, 7), v: rand(0.3, 0.6), s: rand(1, 3) }));
  const dummy = new THREE.Object3D();
  const base = new THREE.Vector3(0, 1.5, 1.5), look = new THREE.Vector3(0, 0.95, -0.2);

  return {
    scene, camera: cam,
    help: 'The sole survivor gets the pot through a <b>Whop payout</b> (sandbox). The losers’ hats stay behind.',
    hud: () => `<div class="sole"><small>BATCH #0427 · COMPLETE</small><h2>SOLE SURVIVOR</h2><div class="amt" id="amt">+$0.00</div></div>
      <div class="spacer"></div>
      <div class="bottom panel">
        <div class="receipt">
          <div class="hd"><span>WHOP · PAYOUT</span><span>SANDBOX</span></div>
          <div class="rr"><span>Pot ($10 × 4)</span><span>$40.00</span></div>
          <div class="rr"><span>Status</span><span class="ok">● Sent</span></div>
          <div class="rr"><span>ID</span><span>pay_8KZ2…Q7</span></div>
        </div>
        <div class="stand">
          <div class="w"><i>1</i><span>YOU</span><em>${4 - game.lost.length}/4 limbs</em></div>
          <div><i>2</i><span>BUCKET</span><em>shot · Last Chamber</em></div>
          <div><i>3</i><span>TOP HAT</span><em>ground · The Grinder</em></div>
          <div><i>4</i><span>CONE</span><em>shot · Dinner Party</em></div>
        </div>
        <button class="cta" id="again">RUN IT BACK · $10</button>
      </div>`,
    bind() {
      countUp($('#amt'), 0, 40, 1400, (v) => `+$${v.toFixed(2)}`);
      setTimeout(() => sfx.pay(), 300);
      $('#again').onclick = () => go('lobby');
    },
    update(dt, t) {
      sway(cam, base, look, t, 0.6);
      flicker(lamp, dt, 0.004);
      lamp.pivot.rotation.z = Math.sin(t * 0.5) * 0.04;
      bd.forEach((b, i) => {
        b.y -= b.v * dt;
        if (b.y < 0.05) b.y = 3.2;
        dummy.position.set(b.x + Math.sin(t * b.s + i) * 0.1, b.y, b.z);
        dummy.rotation.set(t * b.s + b.r, b.r, Math.sin(t * 2 + i) * 0.6);
        dummy.updateMatrix();
        bills.setMatrixAt(i, dummy.matrix);
      });
      bills.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------- router + loop

const BUILDERS = { lobby: buildLobby, dinner: buildDinner, offer: buildOffer, grinder: buildGrinder, chamber: buildChamber, payout: buildPayout };
const LABEL = { lobby: 'The Waiver', dinner: 'Dinner Party', offer: 'The Machine', grinder: 'The Grinder', chamber: 'Last Chamber', payout: 'Payout' };
const NEXT = { lobby: 'dinner', dinner: 'offer', offer: 'grinder', grinder: 'chamber', chamber: 'payout', payout: 'lobby' };
const built = {};
let cur = null;

$('#tabs').innerHTML = Object.keys(BUILDERS).map((k, i) => `<button data-go="${k}"><i>0${i + 1}</i>${LABEL[k]}</button>`).join('');
document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));

function go(name) {
  cur?.exit?.();
  droneOff();
  hideOverlay();
  clearBlood();
  vig.style.opacity = 0;
  $('#toast').classList.remove('show');
  cur = built[name] ||= BUILDERS[name]();
  cur.name = name;
  cur.dead = false;
  cur.enter?.();
  hud.innerHTML = cur.hud();
  cur.bind?.();
  $('#help').innerHTML = cur.help || '';
  document.querySelectorAll('[data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
  history.replaceState(null, '', '#' + name);
  resize();
}

function resize() {
  const r = screenEl.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  if (cur) {
    cur.camera.aspect = r.width / r.height;
    cur.camera.updateProjectionMatrix();
  }
  sizeBlood();
}
new ResizeObserver(resize).observe(screenEl);

$('#kill').onclick = () => {
  if (!cur || cur.dead) return;
  if (cur.kill) cur.kill();
  else die('The Facility decided', 'TERMINATED.');
};
$('#heal').onclick = () => {
  game.lost = [];
  const l = $('#limbs');
  if (l) l.innerHTML = limbsHtml();
};
$('#mute').onclick = () => {
  game.muted = !game.muted;
  $('#mute').textContent = `Sound: ${game.muted ? 'off' : 'on'}`;
  if (game.muted) droneOff();
  else if (cur?.name === 'grinder') droneOn();
};
window.addEventListener('pointerdown', () => { A(); if (cur?.name === 'grinder') droneOn(); }, { once: true });
window.addEventListener('keydown', (e) => cur?.key?.(e, true));
window.addEventListener('keyup', (e) => cur?.key?.(e, false));

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (cur) {
    cur.update(dt, now / 1000);
    renderer.render(cur.scene, cur.camera);
  }
  updateBlood(dt);
  requestAnimationFrame(frame);
}

const start = location.hash.slice(1);
go(BUILDERS[start] ? start : 'lobby');
requestAnimationFrame(frame);
