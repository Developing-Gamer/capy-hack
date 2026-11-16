import * as THREE from 'three';
import { sound } from '../shared/audio';
import type { GameFactory } from '../shared/game';
import { Gore, type Surface, type Wall } from '../shared/gore';
import { TouchPad } from '../shared/input';
import type { Limb, Placement, PlayerInfo } from '../shared/protocol';
import { Flicker } from '../shared/renderer';
import { Subject } from '../shared/rig';
import { canvasTex, Tex } from '../shared/textures';
import { clamp, damp, lerp, rand, Rng, smooth } from '../shared/util';

/*
 * SMOKE BREAK. Hold to drag, let go to exhale, and do not touch the button again until the smoke
 * is out. Dragging too long coughs, and so does dragging too soon. When the timer ends the subject
 * with the fewest puffs is executed by the gun on the trolley.
 *
 * Every bot has its own Rng seeded from the round seed, so a round replays identically from the
 * same seed plus the human's inputs.
 */

const ROUND = 55;
const DRAG_RATE = 0.55;
const GOOD_MIN = 0.62;
const EXHALE_BASE = 0.55;
const EXHALE_PER = 1.2;
const COUGH_T = 1.7;
const PUFFS_PER_CIG = 5;
const MAX_PUFFS = 20;

const ROOM = { x0: -3.2, x1: 3.2, z0: -5.0, z1: 1.8, h: 3.0 };
const BENCH_Z = -2.75;
const SEAT_X = [-0.85, 0, 0.85];
const RAIL_Z = -1.5;
const TROLLEY_FROM = 3.0;
const CAM = new THREE.Vector3(0, 1.25, 1.1);
const LOOK = new THREE.Vector3(0, 0.95, -2.7);

type Kind = 'chain' | 'careful' | 'panicky';
type State = 'idle' | 'drag' | 'exhale' | 'cough';

const KINDS: Kind[] = ['chain', 'careful', 'panicky'];
const TARGET: Record<Kind, [number, number]> = { chain: [0.78, 1.04], careful: [0.74, 0.86], panicky: [0.6, 1.06] };
const WAIT: Record<Kind, [number, number]> = { chain: [0.05, 0.3], careful: [0.3, 0.6], panicky: [0.1, 0.5] };
const EARLY: Record<Kind, number> = { chain: 0.3, careful: 0, panicky: 0.12 };

interface Cig {
  g: THREE.Group;
  body: THREE.Mesh;
  ash: THREE.Mesh;
  ember: THREE.Mesh;
}

interface Smoker {
  info: PlayerInfo;
  number: number;
  you: boolean;
  kind: Kind | null;
  rng: Rng;
  subject: Subject | null;
  cig: Cig;
  seatX: number;
  state: State;
  t: number;
  lung: number;
  drawn: number;
  exhaleT: number;
  early: number;
  wait: number;
  tgt: number;
  puffs: number;
  cigs: number;
  inCig: number;
  coughs: number;
  alive: boolean;
  tie: number;
  plumeT: number;
  cause: string;
}

const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

function box(w: number, h: number, d: number, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, shadow = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

const PAPER = lam(0xe6dfcf, { emissive: 0x1a1812 });
const ASH = lam(0x8a8884);

function makeCig(): Cig {
  const g = new THREE.Group();
  const body = box(0.011, 0.011, 1, PAPER, g, 0, 0, 0, false);
  box(0.0115, 0.0115, 0.02, lam(0xb8742c), g, 0, 0, 0.005, false);
  const ash = box(0.01, 0.01, 1, ASH, g, 0, 0, 0, false);
  const ember = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.011, 0.006), new THREE.MeshBasicMaterial({ color: 0xff7a20, fog: false }));
  g.add(ember);
  return { g, body, ash, ember };
}

function layoutCig(c: Cig, inCig: number, glow: number) {
  const L = 0.1 * (1 - inCig / PUFFS_PER_CIG) + 0.03;
  const a = 0.004 + inCig * 0.0045;
  c.body.scale.z = L;
  c.body.position.z = -L / 2;
  c.ash.scale.z = a;
  c.ash.position.z = -L - a / 2;
  c.ember.position.z = -L - a - 0.003;
  (c.ember.material as THREE.MeshBasicMaterial).color.setRGB(0.5 + glow * 0.5, 0.18 + glow * 0.32, 0.05 + glow * 0.08);
  c.ember.scale.setScalar(1 + glow * 0.35);
}

function desertEagle() {
  const g = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0xa8a8a4, emissive: 0x161616, flatShading: true });
  const dark = lam(0x1a1a1a);
  box(0.034, 0.042, 0.27, steel, g, 0, 0.022, 0.06);
  box(0.03, 0.026, 0.17, steel, g, 0, -0.01, 0.02);
  box(0.012, 0.012, 0.012, dark, g, 0, 0.026, 0.196);
  const grip = box(0.032, 0.12, 0.058, dark, g, 0, -0.07, -0.045);
  grip.rotation.x = 0.28;
  g.scale.setScalar(2);
  return g;
}

class Trolley {
  readonly root = new THREE.Group();
  readonly turret = new THREE.Group();
  readonly gun = desertEagle();
  private lamp: THREE.Mesh;
  constructor(scene: THREE.Scene) {
    const metal = lam(0xffffff, { map: Tex.metal() });
    const rust = lam(0xffffff, { map: Tex.rust([2, 1]) });
    box(0.85, 0.1, 0.5, rust, this.root, 0, 0.26, 0);
    box(0.7, 0.05, 0.4, metal, this.root, 0, 0.32, 0);
    for (const sx of [-0.3, 0.3]) {
      for (const sz of [-0.2, 0.2]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 8), lam(0x1a1a1a));
        w.rotation.x = Math.PI / 2;
        w.position.set(sx, 0.1, sz);
        this.root.add(w);
      }
    }
    box(0.07, 0.65, 0.07, metal, this.root, 0, 0.67, 0);
    box(0.14, 0.12, 0.16, rust, this.root, 0.3, 0.2, 0);
    this.lamp = box(0.05, 0.05, 0.05, new THREE.MeshBasicMaterial({ color: 0xff2010, fog: false }), this.root, -0.3, 0.42, 0, false);
    this.turret.position.set(0, 1.0, 0);
    this.root.add(this.turret);
    this.gun.position.set(0, 0, 0.05);
    this.turret.add(this.gun);
    scene.add(this.root);
  }
  aim(at: THREE.Vector3, k: number) {
    this.root.updateMatrixWorld();
    const p = this.turret.getWorldPosition(new THREE.Vector3());
    const d = at.clone().sub(p);
    const yaw = Math.atan2(d.x, d.z);
    const pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
    this.turret.rotation.order = 'YXZ';
    const rest = Math.PI;
    const dy = Math.atan2(Math.sin(yaw - rest), Math.cos(yaw - rest));
    this.turret.rotation.set(lerp(0.2, pitch, k), rest + dy * k, 0);
  }
  muzzle(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.gun.localToWorld(out.set(0, 0.022, 0.2));
  }
  blink(t: number, on: boolean) {
    (this.lamp.material as THREE.MeshBasicMaterial).color.setHex(on && Math.sin(t * 14) > 0 ? 0xff2010 : 0x3a0806);
  }
}

function buildRoom(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x050404);
  scene.fog = new THREE.FogExp2(0x080706, 0.16);
  const W = ROOM.x1 - ROOM.x0, D = ROOM.z1 - ROOM.z0, cx = (ROOM.x0 + ROOM.x1) / 2, cz = (ROOM.z0 + ROOM.z1) / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0xffffff, { map: Tex.floor([W, D]) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0x1a1816));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(cx, ROOM.h, cz);
  scene.add(ceil);
  const conc = lam(0xffffff, { map: Tex.concrete([D / 2, ROOM.h / 2]) });
  const concB = lam(0xffffff, { map: Tex.concrete([W / 2, ROOM.h / 2]) });
  const wall = (w: number, m: THREE.Material, x: number, z: number, ry: number) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, ROOM.h), m);
    p.position.set(x, ROOM.h / 2, z);
    p.rotation.y = ry;
    p.receiveShadow = true;
    scene.add(p);
  };
  wall(D, conc, ROOM.x0, cz, Math.PI / 2);
  wall(D, conc, ROOM.x1, cz, -Math.PI / 2);
  wall(W, concB, cx, ROOM.z0, 0);
  wall(W, concB, cx, ROOM.z1, Math.PI);
  const haz = lam(0xffffff, { map: Tex.hazard([D * 2, 1]) });
  box(0.02, 0.22, D, haz, scene, ROOM.x0 + 0.011, 0.11, cz, false);
  box(0.02, 0.22, D, haz, scene, ROOM.x1 - 0.011, 0.11, cz, false);
  const rust = lam(0xffffff, { map: Tex.rust([6, 1]) });
  for (const [y, r] of [[2.45, 0.06], [2.62, 0.04]] as const) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, D, 8), rust);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(ROOM.x1 - 0.12, y, cz);
    scene.add(pipe);
  }
  const metal = lam(0xffffff, { map: Tex.metal() });
  const wood = lam(0xffffff, { map: Tex.wood() });
  box(3.4, 0.06, 0.5, wood, scene, 0, 0.43, BENCH_Z - 0.02);
  for (const x of [-1.5, 0, 1.5]) box(0.06, 0.4, 0.46, metal, scene, x, 0.2, BENCH_Z - 0.02);
  box(3.4, 0.5, 0.04, metal, scene, 0, 0.72, BENCH_Z - 0.27);
  box(W, 0.02, 0.03, metal, scene, cx, 0.01, RAIL_Z - 0.2, false);
  box(W, 0.02, 0.03, metal, scene, cx, 0.01, RAIL_Z + 0.2, false);
  for (let x = ROOM.x0 + 0.3; x < ROOM.x1; x += 0.5) box(0.05, 0.012, 0.5, lam(0x1c1812), scene, x, 0.006, RAIL_Z, false);

  const tex = canvasTex(320, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#ffd38a';
    g.fillRect(14, 38, 34, 8);
    g.fillStyle = '#ff7a20';
    g.fillRect(48, 38, 8, 8);
    g.fillStyle = '#ffd38a';
    g.font = 'bold 24px monospace';
    g.textBaseline = 'middle';
    g.fillText('SMOKE BREAK', 70, 34);
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.34), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false }));
  sign.position.set(0, 2.35, ROOM.z0 + 0.02);
  scene.add(sign);
  const signLight = new THREE.PointLight(0xffb060, 1.3, 4, 1.5);
  signLight.position.set(0, 2.2, ROOM.z0 + 0.5);
  scene.add(signLight);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.85, 8), lam(0xffffff, { map: Tex.rust([2, 1]) }));
  barrel.position.set(2.5, 0.42, -4.2);
  scene.add(barrel);
  const fire = new THREE.PointLight(0xff7a30, 1.6, 4.5, 1.4);
  fire.position.set(2.5, 1.05, -4.0);
  scene.add(fire);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 5), new THREE.MeshBasicMaterial({ color: 0xff9a40, fog: false }));
  flame.position.set(2.5, 1.0, -4.2);
  scene.add(flame);

  scene.add(new THREE.HemisphereLight(0x4a4038, 0x0a0806, 0.75));
  const LAMP_Y = 2.75;
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.2, 8, 1, true), new THREE.MeshLambertMaterial({ color: 0x3a3832, emissive: 0x0a0806, side: THREE.DoubleSide }));
  shade.position.set(2.2, LAMP_Y + 0.09, -2.1);
  scene.add(shade);
  const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), new THREE.MeshBasicMaterial({ color: 0xffe2b0, fog: false }));
  bulb.position.set(2.2, LAMP_Y, -2.1);
  scene.add(bulb);
  box(0.01, ROOM.h - LAMP_Y - 0.19, 0.01, lam(0x111111), scene, 2.2, (ROOM.h + LAMP_Y + 0.19) / 2, -2.1, false);
  const lamp = new THREE.SpotLight(0xffd2a0, 30, 10, 1.2, 0.55, 1.2);
  lamp.position.set(2.2, LAMP_Y, -2.1);
  lamp.target.position.set(0, 0, -2.6);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(512, 512);
  lamp.shadow.bias = -0.002;
  scene.add(lamp, lamp.target);
  const fill = new THREE.PointLight(0xffc89a, 1.2, 2.2, 1.5);
  fill.position.set(0.3, 1.5, 0.2);
  scene.add(fill);
  const danger = new THREE.PointLight(0xff2010, 0, 6, 1.2);
  danger.position.set(0, 2.2, -2.0);
  scene.add(danger);

  const flickers = [new Flicker(lamp, bulb.material as THREE.MeshBasicMaterial, lamp.intensity, 0.35), new Flicker(fire, null, fire.intensity, 3)];
  const surfaces: Surface[] = [{ y: 0, x0: ROOM.x0, x1: ROOM.x1, z0: ROOM.z0, z1: ROOM.z1 }];
  const walls: Wall[] = [
    { axis: 'x', at: ROOM.x0, normal: 1 },
    { axis: 'x', at: ROOM.x1, normal: -1 },
    { axis: 'z', at: ROOM.z0, normal: 1 },
    { axis: 'z', at: ROOM.z1, normal: -1 },
  ];
  return { surfaces, walls, flickers, flame, shade, danger };
}

function noiseBurst(t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, attack = 0.02, q = 1) {
  const r = sound.raw;
  if (!r) return;
  const c = r.ctx;
  const now = c.currentTime + t0;
  const src = c.createBufferSource();
  src.buffer = r.noise;
  src.start(now, rand(0, 0.2), dur + 0.05);
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, now);
  f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), now + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f).connect(g).connect(r.sfx);
}

const sfx = {
  inhale: () => noiseBurst(0, 1.5, 'bandpass', 500, 2400, 0.2, 0.3, 1.4),
  exhale: (d: number) => noiseBurst(0, d, 'lowpass', 2600, 300, 0.22, 0.05),
  cough(v: number) {
    for (let i = 0; i < 3; i++) noiseBurst(i * 0.16, 0.12, 'bandpass', 900 - i * 120, 300, 0.45 * v, 0.004, 1.1);
    const r = sound.raw;
    if (!r) return;
    const o = r.ctx.createOscillator();
    const g = r.ctx.createGain();
    const t = r.ctx.currentTime;
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * v, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(r.sfx);
    o.start(t);
    o.stop(t + 0.55);
  },
  crackle: () => noiseBurst(0, 0.06, 'highpass', 3000, 4000, 0.06, 0.002),
};

const REMARKS = {
  kept: ['Subject smoked with acceptable discipline. Retain for further testing.', 'Lung capacity adequate. Habit noted.', 'Subject outlasted the others. Do not read into this.'],
  dead: ['Subject smoked the least. The trolley does not take requests.', 'Lungs unremarkable. Skull: no longer applicable.', 'Insufficient dependence on tobacco. Corrected.'],
};

const CSS = [
  '.sb-meter { position:absolute; left:8%; right:8%; bottom:calc(env(safe-area-inset-bottom) + 50px); height:16px; background:rgba(0,0,0,.65); border:1px solid #4a4332; }',
  '.sb-meter .zone { position:absolute; top:0; bottom:0; background:rgba(120,200,110,.22); border-left:1px solid #9fd08a; }',
  '.sb-meter .fill { position:absolute; left:0; top:0; bottom:0; width:0; background:#f2c14a; }',
  '.sb-meter.out .fill { background:#8a8576; }',
  '.sb-meter.cough .fill { background:#ff3b2a; width:100% !important; animation:pulse .2s infinite alternate; }',
  '.sb-meter.hot .fill { background:#9fd08a; }',
  '.sb-cig { position:absolute; right:12px; bottom:calc(env(safe-area-inset-bottom) + 72px); font-size:11px; letter-spacing:2px; color:#b5aa92; }',
].join('\n');

export const createSmoke: GameFactory = (ctx) => {
  const { engine, hud, start } = ctx;
  const scene = engine.scene;
  const cam = engine.camera;
  cam.fov = 78;
  scene.add(cam);
  const room = buildRoom(scene);
  const gore = new Gore(engine, room.surfaces, room.walls, { onImpact: (v) => sound.splat(v) });
  const trolley = new Trolley(scene);
  trolley.root.position.set(TROLLEY_FROM, 0, RAIL_Z);
  trolley.aim(new THREE.Vector3(TROLLEY_FROM, 1.2, BENCH_Z), 0);
  const auto = new URLSearchParams(location.search).has('auto');

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const meter = document.createElement('div');
  meter.className = 'sb-meter';
  meter.innerHTML = '<div class="zone"></div><div class="fill"></div>';
  hud.root.appendChild(meter);
  const zoneEl = meter.querySelector('.zone') as HTMLElement;
  zoneEl.style.left = GOOD_MIN * 100 + '%';
  zoneEl.style.right = '0';
  const fillEl = meter.querySelector('.fill') as HTMLElement;
  const cigEl = document.createElement('div');
  cigEl.className = 'sb-cig';
  hud.root.appendChild(cigEl);

  const players = start.players.slice(0, 4);
  const me = players.find((p) => p.id === start.you) ?? players[0];
  const used = new Set<number>();
  const numRng = new Rng(start.seed ^ 0x5bd1e995);
  const numberFor = () => {
    let n = numRng.int(1, 99);
    while (used.has(n)) n = (n % 99) + 1;
    used.add(n);
    return n;
  };
  const tag = (s: Smoker) => '#' + String(s.number).padStart(2, '0') + ' ' + s.info.name.toUpperCase();

  let botIdx = 0;
  const smokers: Smoker[] = players.map((info, i) => {
    const you = info === me;
    const rng = new Rng(start.seed * 7919 + i * 104729 + 13);
    const kind: Kind | null = you ? (auto ? 'careful' : null) : KINDS[botIdx++ % KINDS.length];
    const seat = you ? 0 : Math.min(SEAT_X.length - 1, botIdx - 1);
    const number = numberFor();
    const cig = makeCig();
    let subject: Subject | null = null;
    if (!you) {
      subject = new Subject({ number, hat: info.hat, limbs: info.limbs });
      subject.root.position.set(SEAT_X[seat], 0, BENCH_Z);
      scene.add(subject.root);
      cig.g.rotation.set(Math.PI / 2 + 0.5, 0, 0);
      cig.g.position.set(0, -0.03, 0);
      cig.g.scale.setScalar(1.6);
      subject.hand('r').add(cig.g);
    }
    return {
      info, number, you, kind, rng, subject, cig, seatX: you ? 0 : SEAT_X[seat], state: 'idle', t: 0, lung: 0, drawn: 0, exhaleT: 0, early: -1,
      wait: kind ? rng.range(...WAIT[kind]) + rng.range(0.4, 1.6) : 0, tgt: 0, puffs: 0, cigs: 0, inCig: 0, coughs: 0, alive: true, tie: rng.next(), plumeT: 0, cause: '',
    } as Smoker;
  });
  const you = smokers.find((s) => s.you)!;
  const bots = smokers.filter((s) => !s.you);

  const fp = new THREE.Group();
  cam.add(fp);
  const sleeve = box(1, 1, 1, lam(0xffffff, { map: Tex.jumpsuit('#77705f', you.number), emissive: 0x2c2a22 }), fp, 0, 0, 0, false);
  const fist = box(0.055, 0.06, 0.075, lam(0xc4ae98, { emissive: 0x3a3028 }), fp, 0, 0, 0, false);
  const hand = new THREE.Group();
  fp.add(hand);
  hand.add(you.cig.g);
  you.cig.g.scale.setScalar(1.15);
  const emberLight = new THREE.PointLight(0xff7a30, 0, 1.4, 1.5);
  hand.add(emberLight);
  const REST = new THREE.Vector3(0.2, -0.3, -0.5);
  const MOUTH = new THREE.Vector3(0.05, -0.2, -0.4);
  const SHOULDER = new THREE.Vector3(0.6, -1.0, -0.5);
  let handK = 0;

  const smokeTex = canvasTex(32, 32, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  smokeTex.wrapS = smokeTex.wrapT = THREE.ClampToEdgeWrapping;
  interface Plume { sp: THREE.Sprite; vel: THREE.Vector3; age: number; life: number; size: number }
  const plumes: Plume[] = [];
  for (let i = 0; i < 56; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0xb9b2a4, transparent: true, opacity: 0, depthWrite: false }));
    sp.visible = false;
    scene.add(sp);
    plumes.push({ sp, vel: new THREE.Vector3(), age: 1, life: 1, size: 0.1 });
  }
  let plumeI = 0;
  const puff = (pos: THREE.Vector3, dir: THREE.Vector3, size: number, speed = 0.6) => {
    const p = plumes[plumeI++ % plumes.length];
    p.sp.position.copy(pos);
    p.vel.copy(dir).multiplyScalar(speed * rand(0.7, 1.2)).add(new THREE.Vector3(rand(-0.12, 0.12), rand(0.02, 0.14), rand(-0.12, 0.12)));
    p.age = 0;
    p.life = rand(1.5, 2.4);
    p.size = size;
    p.sp.visible = true;
  };

  let elapsed = 0;
  let begun = false;
  let phase: 'play' | 'exec' = 'play';
  let execT = 0;
  let fired = false;
  let finished = false;
  let endAt = -1;
  let loser: Smoker | null = null;
  let youDeadAt = -1;
  let coughK = 0;
  let boardT = 0;
  let firstPuff = false;
  let motorOn = false;
  const glance = new THREE.Vector3();
  let glanceK = 0;

  const mouthOf = (s: Smoker) => (s.subject ? s.subject.headWorld().add(new THREE.Vector3(0, -0.05, 0.1)) : new THREE.Vector3(CAM.x - 0.02, CAM.y - 0.12, CAM.z - 0.2));

  function startDrag(s: Smoker) {
    s.state = 'drag';
    s.t = 0;
    s.lung = 0;
    if (s.kind) s.tgt = s.rng.range(...TARGET[s.kind]);
    if (s.you) {
      sfx.inhale();
      ctx.haptic('light');
    }
    sfx.crackle();
  }

  function finishCig(s: Smoker) {
    s.cigs++;
    s.inCig = 0;
    hud.feed('<b>' + tag(s) + '</b> ' + (s.you ? 'LIT ANOTHER.' : 'FINISHED ONE.'));
    sound.click();
    sfx.crackle();
  }

  function release(s: Smoker) {
    if (s.state !== 'drag') return;
    s.drawn = s.lung;
    const good = s.lung >= GOOD_MIN;
    s.state = 'exhale';
    s.t = 0;
    s.exhaleT = good ? EXHALE_BASE + EXHALE_PER * s.lung : 0.4;
    s.plumeT = 0;
    const last = smokers.every((o) => o === s || o.puffs >= s.puffs);
    s.early = s.kind && s.rng.chance(EARLY[s.kind] + (s.kind === 'panicky' && elapsed > 30 && last ? 0.3 : 0)) ? s.exhaleT * s.rng.range(0.5, 0.9) : -1;
    if (good) {
      s.puffs++;
      s.inCig++;
      if (s.inCig >= PUFFS_PER_CIG) finishCig(s);
      if (s.you) {
        ctx.haptic('light');
        if (!firstPuff) {
          firstPuff = true;
          hud.setHint('');
        }
      }
    }
    if (s.you) sfx.exhale(s.exhaleT);
  }

  function cough(s: Smoker) {
    s.state = 'cough';
    s.t = 0;
    s.lung = 0;
    s.coughs++;
    const m = mouthOf(s);
    for (let i = 0; i < 4; i++) puff(m, new THREE.Vector3(0, 0, s.you ? -1 : 1), 0.14, 1.2);
    if (s.you) {
      coughK = 1;
      sfx.cough(1);
      ctx.haptic('heavy');
      engine.shake(0.6);
      if (s.coughs >= 2) engine.lens.burst(rand(0.3, 0.7), rand(0.5, 0.75), 0.35 + Math.min(0.5, s.coughs * 0.1));
    } else if (s.subject) {
      sfx.cough(0.25);
      s.subject.flinch(-1);
      if (s.coughs >= 2) gore.spray(m, new THREE.Vector3(0, -0.1, 1), 10, [0.5, 1.6], 0.4, [0.004, 0.01]);
    }
  }

  function tickSmoker(s: Smoker, dt: number) {
    if (!s.alive) return;
    s.t += dt;
    if (s.state === 'drag') {
      s.lung += DRAG_RATE * dt;
      if (s.kind && s.lung >= s.tgt && s.tgt < 1) release(s);
      else if (s.lung >= 1) cough(s);
    } else if (s.state === 'exhale') {
      s.plumeT -= dt;
      if (s.plumeT <= 0 && s.drawn >= GOOD_MIN) {
        s.plumeT = 0.07;
        const d = s.you ? new THREE.Vector3(0.05, 0.02, -1) : new THREE.Vector3(0.05, 0, 1);
        puff(mouthOf(s), d, 0.09 + s.drawn * 0.06, 0.55 + s.drawn * 0.3);
      }
      if (s.early > 0 && s.t >= s.early) cough(s);
      else if (s.t >= s.exhaleT) {
        s.state = 'idle';
        s.t = 0;
        if (s.kind) s.wait = s.rng.range(...WAIT[s.kind]);
      }
    } else if (s.state === 'cough') {
      if (s.t >= COUGH_T) {
        s.state = 'idle';
        s.t = 0;
        if (s.kind) s.wait = s.rng.range(...WAIT[s.kind]);
      }
    } else if (s.kind) {
      s.wait -= dt;
      if (s.wait <= 0) startDrag(s);
    }
  }

  const order = () => [...smokers].sort((a, b) => b.puffs - a.puffs || a.coughs - b.coughs || b.tie - a.tie);

  function beginExec() {
    phase = 'exec';
    execT = 0;
    const ranked = order();
    loser = ranked[ranked.length - 1];
    for (const s of smokers) if (s.state === 'drag') s.state = 'idle';
    sound.klaxon(1.4);
    sound.intensity = 1;
    hud.feed('<b>TIME.</b> The trolley is coming.');
  }

  function execTick(dt: number) {
    execT += dt;
    const roll0 = 1.0, rollT = 2.6;
    const k = smooth(clamp((execT - roll0) / rollT, 0, 1));
    const stopX = loser ? loser.seatX : 0;
    if (execT > roll0 && !motorOn && execT < roll0 + rollT) {
      motorOn = true;
      sound.motor(true);
    }
    trolley.root.position.x = lerp(TROLLEY_FROM, stopX, k);
    if (motorOn) sound.motorLoad(0.4 + (1 - Math.abs(k * 2 - 1)) * 0.6);
    const arrived = execT > roll0 + rollT;
    if (arrived && motorOn) {
      motorOn = false;
      sound.motor(false);
      sound.clink(true);
    }
    const aimK = clamp((execT - roll0 - rollT) / 0.7, 0, 1);
    if (loser) {
      const at = loser.you ? new THREE.Vector3(CAM.x, CAM.y, CAM.z) : loser.subject!.headWorld();
      trolley.aim(at, smooth(aimK));
    }
    if (!fired && loser && execT > roll0 + rollT + 0.9) fire(loser);
  }

  function fire(s: Smoker) {
    fired = true;
    const target = s.you ? new THREE.Vector3(CAM.x, CAM.y, CAM.z) : s.subject!.headWorld();
    const muzzle = trolley.muzzle();
    const dir = target.clone().sub(muzzle).normalize();
    gore.muzzleFlash(muzzle, dir);
    sound.gunshot();
    engine.flash(0.25);
    engine.slowmo(0.7, 0.22);
    s.alive = false;
    s.cause = 'Smoked the least. Executed by trolley gun';
    ctx.death(s.info.id, s.cause);
    endAt = elapsed + 3;
    if (s.you) {
      youDeadAt = elapsed;
      engine.lens.cover();
      engine.flash(0.9, 0xff4020);
      engine.shake(1);
      sound.crunch(1.4);
      sound.squelch(1.4);
      sound.ring(4);
      sound.muffle(0.75);
      hud.stamp('TERMINATED');
      hud.setHint('');
      pad.enabled = false;
      fp.visible = false;
      return;
    }
    const sub = s.subject!;
    sub.explodeHead(gore, dir);
    sub.die('slump');
    sound.crunch();
    sound.squelch();
    ctx.haptic('heavy');
    const dist = target.distanceTo(cam.position);
    engine.shake(0.35 + Math.max(0, 3 - dist) * 0.25);
    const ndc = target.clone().project(cam);
    if (dist < 4) {
      engine.lens.burst(clamp((ndc.x + 1) / 2, 0.15, 0.85), clamp((1 - ndc.y) / 2, 0.2, 0.7), (4 - dist) / 2.2);
      sound.ring(1.5);
    }
    glance.copy(target);
    glanceK = 1;
    for (const o of bots) if (o !== s) o.subject?.flinch(1);
    const neck = sub.neck;
    setTimeout(() => gore.pool(new THREE.Vector3().setFromMatrixPosition(neck.matrixWorld).setY(0.02), 0.4), 800);
    hud.feed('<b>' + tag(s) + '</b> terminated.');
  }

  function finish() {
    finished = true;
    const ranked = order();
    const placements: Placement[] = ranked.map((s, i) => ({
      id: s.info.id,
      place: i + 1,
      status: s.alive ? 'survived' : 'dead',
      score: s.puffs,
      limbs: s.alive ? s.info.limbs : [],
    }));
    const limbs: Record<string, Limb[]> = {};
    for (const p of placements) limbs[p.id] = p.limbs ?? [];
    ctx.finish(placements, { limbs });
    console.log('[round]', JSON.stringify({ elapsed: elapsed.toFixed(1), loser: loser?.info.id, smokers: smokers.map((s) => [s.info.name, s.kind ?? 'human', s.puffs, s.cigs, s.coughs]) }));
    const pool = you.alive ? REMARKS.kept : REMARKS.dead;
    hud.assessment({
      kicker: 'ASSESSMENT',
      subject: 'SUBJECT ' + tag(you),
      verdict: you.alive ? 'RETAINED' : 'TERMINATED',
      lines: [['PUFFS', String(you.puffs)], ['CIGARETTES', String(you.cigs)], ['COUGHS', String(you.coughs)]],
      remark: pool[Math.floor(Math.random() * pool.length)],
      table: ranked.map((s, i) => tag(s) + ' — ' + s.puffs + ' PUFFS' + (s.alive ? '' : ' — TERMINATED')),
      fine: '',
    });
  }

  const pad = new TouchPad(ctx.surface, {
    down: () => {
      if (!begun || phase !== 'play' || !you.alive) return;
      if (you.state === 'idle') startDrag(you);
      else if (you.state === 'exhale') cough(you);
    },
    up: () => {
      if (you.state === 'drag') release(you);
    },
  });
  if (auto) pad.enabled = false;

  function visuals(dt: number, t: number) {
    const dragging = you.state === 'drag';
    const glow = dragging ? clamp(you.lung * 1.2, 0, 1) : you.state === 'exhale' ? 0.45 : 0.25;
    handK = damp(handK, dragging ? 1 : you.state === 'exhale' ? 0.55 : you.state === 'cough' ? 0.3 : 0, 9, dt);
    const e = smooth(handK);
    const pos = new THREE.Vector3().lerpVectors(REST, MOUTH, e);
    if (you.state === 'cough') pos.x += Math.sin(t * 60) * 0.012 * (1 - you.t / COUGH_T);
    pos.y += Math.sin(t * 1.4) * 0.003;
    hand.position.copy(pos);
    hand.rotation.set(lerp(0.7, 0.95, e), lerp(0.2, 0.08, e), 0);
    fist.position.copy(pos).add(new THREE.Vector3(0, -0.015, 0.02));
    sleeve.position.lerpVectors(pos, SHOULDER, 0.5);
    fp.updateMatrixWorld();
    sleeve.lookAt(fp.localToWorld(SHOULDER.clone()));
    sleeve.scale.set(0.075, 0.07, pos.distanceTo(SHOULDER) + 0.05);
    layoutCig(you.cig, you.inCig, glow);
    emberLight.position.copy(you.cig.ember.position);
    emberLight.intensity = glow * 1.6;
    for (const s of bots) {
      layoutCig(s.cig, s.inCig, s.state === 'drag' ? clamp(s.lung * 1.2, 0, 1) : 0.3);
      if (!s.subject) continue;
      if (s.alive) {
        const target = s.state === 'drag' ? 1 : s.state === 'exhale' ? 0.5 : s.state === 'cough' ? 0.4 + Math.abs(Math.sin(t * 25)) * 0.4 : 0.1;
        s.subject.eat = damp(s.subject.eat, target, 7, dt);
        s.subject.chew = s.state === 'cough';
        s.subject.freeze = phase === 'exec';
        s.subject.lookAt = phase === 'exec' ? trolley.root.position.clone().setY(1.0) : new THREE.Vector3(s.seatX * 0.4, 1.1, 1.0);
      }
      s.subject.update(dt, t);
    }
    for (const p of plumes) {
      if (p.age >= p.life) {
        p.sp.visible = false;
        continue;
      }
      p.age += dt;
      p.sp.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-1.2 * dt));
      p.vel.y += 0.05 * dt;
      p.sp.scale.setScalar(p.size * (1 + p.age * 1.6));
      (p.sp.material as THREE.SpriteMaterial).opacity = 0.34 * (1 - p.age / p.life) * Math.min(1, p.age * 6);
    }
  }

  function cameraTick(dt: number, t: number) {
    coughK = Math.max(0, coughK - dt * 1.4);
    glanceK = Math.max(0, glanceK - dt * 0.6);
    const look = LOOK.clone();
    const lean = you.state === 'drag' ? 0.03 : 0;
    cam.position.set(CAM.x + Math.sin(t * 0.7) * 0.006, CAM.y + Math.sin(t * 1.3) * 0.004 - lean - coughK * 0.04, CAM.z - lean);
    const dk = youDeadAt >= 0 ? smooth(clamp((elapsed - youDeadAt) / 0.9, 0, 1)) : 0;
    if (phase === 'exec' && loser) {
      const k = smooth(clamp((execT - 1) / 1.6, 0, 1));
      look.lerp(new THREE.Vector3(loser.seatX * 0.7, loser.you ? 1.1 : 1.0, loser.you ? RAIL_Z : BENCH_Z), loser.you ? k : k * 0.5);
    }
    look.lerp(glance, smooth(Math.min(1, glanceK * 1.5)) * 0.3);
    cam.lookAt(look);
    cam.rotateZ(Math.sin(t * 38) * 0.03 * coughK - 0.4 * dk);
    const fov = you.state === 'drag' ? 74 : 78;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, 6, dt);
      cam.updateProjectionMatrix();
    }
  }

  function hudTick(dt: number) {
    if (!finished) hud.setTimer(Math.max(0, ROUND - elapsed));
    if (!begun || !you.alive) hud.setStatus('', 'hidden');
    else if (phase === 'exec') hud.setStatus('TIME', 'danger');
    else if (you.state === 'cough') hud.setStatus('COUGH', 'danger');
    else if (you.state === 'exhale') hud.setStatus('LET IT OUT', 'calm');
    else if (you.state === 'drag' && you.lung >= GOOD_MIN) hud.setStatus('LET GO', 'warn');
    else hud.setStatus('', 'hidden');
    let cls = 'sb-meter';
    let v = 0;
    if (you.state === 'drag') {
      v = you.lung;
      if (you.lung >= GOOD_MIN) cls += ' hot';
    } else if (you.state === 'exhale') {
      v = you.drawn * (1 - clamp(you.t / you.exhaleT, 0, 1));
      cls += ' out';
    } else if (you.state === 'cough') cls += ' cough';
    if (meter.className !== cls) meter.className = cls;
    fillEl.style.width = clamp(v, 0, 1) * 100 + '%';
    cigEl.textContent = you.cigs + ' CIG';
    boardT += dt;
    if (boardT > 0.12) {
      boardT = 0;
      hud.setBoard(smokers.map((s) => ({ name: tag(s), value: s.puffs, max: MAX_PUFFS, me: s.you, dead: !s.alive, label: s.alive ? s.cigs + ' CIG' : 'DEAD' })));
    }
    engine.tint = damp(engine.tint, phase === 'exec' ? 0.3 : you.state === 'cough' ? 0.2 : 0, 6, dt);
    room.danger.intensity = engine.tint * 12;
  }

  hud.setTitle('SIMULATION 05', 'SMOKE BREAK');
  hud.setPot(start.pot);
  hud.setLimbs(me.limbs);
  hud.setTimer(ROUND);
  hud.setHint('<b>HOLD</b> TO DRAG · <b>LET GO</b> TO EXHALE');
  void hud
    .intro('SIMULATION 05', 'SMOKE BREAK', ['<b>HOLD</b> TO DRAG. <b>LET GO</b> TO EXHALE.', 'MOST SMOKED LIVES.'])
    .then(() => {
      sound.unlock();
      sound.drone(true);
      sound.beat(true);
      begun = true;
    });
  if (auto) document.querySelector<HTMLElement>('.overlay')?.dispatchEvent(new PointerEvent('pointerdown'));

  function step(dt: number, t: number) {
    if (begun) {
      if (phase === 'play') {
        for (const s of smokers) tickSmoker(s, dt);
        if (elapsed >= ROUND) beginExec();
      } else execTick(dt);
      if (endAt >= 0 && elapsed >= endAt && !finished) finish();
    }
    trolley.blink(t, phase === 'exec');
    room.flame.scale.set(1, 0.85 + Math.sin(t * 11) * 0.15 + Math.random() * 0.1, 1);
    room.shade.rotation.z = Math.sin(t * 0.8) * 0.03;
    for (const f of room.flickers) f.update(dt);
    gore.update(dt);
    visuals(dt, t);
    cameraTick(dt, t);
    hudTick(dt);
  }

  return {
    update(dt, t) {
      const ff = youDeadAt >= 0 && elapsed - youDeadAt > 2 && !finished ? 3 : 1;
      for (let i = 0; i < ff; i++) {
        if (begun) elapsed += dt;
        step(dt, t + i * dt);
      }
    },
  };
};
