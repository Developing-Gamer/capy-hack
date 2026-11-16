import * as THREE from 'three';
import { sound } from '../shared/audio';
import { inApp } from '../shared/bridge';
import type { GameFactory } from '../shared/game';
import { Gore, type Surface, type Wall } from '../shared/gore';
import { TouchPad } from '../shared/input';
import type { Limb, OfferId, Placement, PlayerInfo, Purchase } from '../shared/protocol';
import { Flicker } from '../shared/renderer';
import { Subject } from '../shared/rig';
import { canvasTex, Tex } from '../shared/textures';
import { clamp, damp, lerp, rand, smooth } from '../shared/util';

/*
 * THE MACHINE. The intermission between trials. A rusty vending creature sells sabotage for coins.
 * Pick an offer and a victim, then hold your hand in the payment slot to feed coins. When the CRT
 * eye turns red every slot bites: the first bite takes the arm, the second gets you pressed.
 * Stock is one short of the batch, so the last subject still shopping becomes stock. Purchases
 * are secret and handed to the next trials through the result's `purchases`.
 */

const WINDOW = 60;
const WAKE = 3.6;
const COIN_T = 1.5;
const START_COINS = 12;
const INSERT = 0.24;
const WITHDRAW = 0.13;
/** Hand depth past which a bite catches it. */
const CAUGHT = 0.5;
const ROOM = { x: 2.1, z0: -3.4, z1: 2.1, h: 3.4 };
const FRONT = ROOM.z0;
const CAM = new THREE.Vector3(0, 1.58, 1.05);
const LOOK = new THREE.Vector3(0, 1.22, -3.0);
const PRESS_REST = 2.72;
const FOV = 74;
const HATCH = new THREE.Vector3(0, 0.62, FRONT + 0.3);
const EYE = new THREE.Vector3(0, 2.1, FRONT + 0.52);
const STATIONS = [
  { x: 0.72, z: -1.15 },
  { x: -0.72, z: -1.75 },
  { x: 0.72, z: -2.35 },
];

interface Offer {
  id: OfferId;
  name: string;
  cost: number;
  desc: string;
  done: (victim: string) => string;
}

const OFFERS: Offer[] = [
  { id: 'short_fuse', name: 'SHORT FUSE', cost: 7, desc: '−3s on their next timer.', done: (v) => `<b>${v}</b> RUNS 3s SHORT.` },
  { id: 'marked', name: 'MARKED', cost: 8, desc: 'The next host watches them first.', done: (v) => `<b>${v}</b> IS MARKED.` },
  { id: 'one_more_round', name: 'ONE MORE ROUND', cost: 10, desc: '+1 bullet in their next chamber.', done: (v) => `<b>${v}</b> GETS A SECOND BULLET.` },
  { id: 'limb_swap', name: 'LIMB SWAP', cost: 12, desc: 'Your limbs for theirs.', done: (v) => `YOU AND <b>${v}</b> SWAP LIMBS.` },
];

type Phase = 'intro' | 'wake' | 'idle' | 'tell' | 'bite' | 'digest' | 'exec' | 'close';
type Kind = 'greedy' | 'cautious' | 'spiteful';
type Step = 'arm' | 'gut' | 'press';
type Mode = 'off' | 'green' | 'amber' | 'red';

interface Persona {
  kind: Kind;
  offers: OfferId[];
  react: [number, number];
  heed: number;
  /** Seconds after the slot reopens before reaching in (doubles per bite taken). */
  delay: number;
  /** Only start reaching in this long after the slot reopens. */
  window: number;
  /** Chance to leave the hand in through a tell when one coin is left. */
  greed: number;
  prey: 'you' | 'rich' | 'random';
}

const PERSONAS: Record<Kind, Persona> = {
  greedy: { kind: 'greedy', offers: ['limb_swap', 'one_more_round'], react: [0.3, 0.52], heed: 0.8, delay: 0.05, window: 99, greed: 0.55, prey: 'rich' },
  cautious: { kind: 'cautious', offers: ['short_fuse', 'marked'], react: [0.12, 0.24], heed: 0.95, delay: 0.4, window: 1.8, greed: 0, prey: 'random' },
  spiteful: { kind: 'spiteful', offers: ['one_more_round', 'marked', 'short_fuse'], react: [0.18, 0.36], heed: 0.68, delay: 0, window: 99, greed: 0.35, prey: 'you' },
};

interface Brain {
  p: Persona;
  react: number;
  heeding: boolean;
  seenAlert: number;
  keep: boolean;
}

interface Station {
  group: THREE.Group;
  podium: Podium;
  press: Press;
  mouth: THREE.Vector3;
  tray: THREE.Vector3;
}

interface Shopper {
  info: PlayerInfo;
  number: number;
  you: boolean;
  subject: Subject | null;
  station: Station;
  brain: Brain | null;
  offer: Offer | null;
  victim: Shopper | null;
  coins: number;
  paid: number;
  payT: number;
  depth: number;
  want: boolean;
  arm: Limb | null;
  limbs: Limb[];
  bites: number;
  alive: boolean;
  done: boolean;
  endAt: number;
  cause: string;
  deadAt: number;
}

/** Once a coin is in, the choice is final. */
const locked = (s: Shopper) => s.paid > 0 || s.done;

const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

function box(w: number, h: number, d: number, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, shadow = false) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** A row of triangular teeth, pointing down or up from y = 0, extruded 12 mm toward +z. */
function teethGeo(w: number, h: number, n: number, down: boolean) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + (i / n) * w;
    s.lineTo(x0 + w / n / 2, down ? -h : h);
    s.lineTo(x0 + w / n, 0);
  }
  s.lineTo(-w / 2, 0);
  return new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: false });
}

function labelTex(text: string, fg: string, bg: string, w = 64, h = 24, font = 'bold 9px monospace') {
  const t = canvasTex(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.strokeRect(1.5, 1.5, w - 3, h - 3);
    g.fillStyle = fg;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 1);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Dried blood running down from the top edge. */
function dripTex() {
  const t = canvasTex(32, 48, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 9; i++) {
      const x = rand(2, w - 2), len = rand(6, h - 4), wd = rand(1, 3.5);
      g.fillStyle = `rgba(${Math.floor(rand(70, 120))},6,4,${rand(0.6, 0.95)})`;
      g.fillRect(x, 0, wd, len);
      g.beginPath();
      g.arc(x + wd / 2, len, wd * 0.8, 0, 7);
      g.fill();
    }
    g.fillStyle = 'rgba(90,6,4,.9)';
    g.fillRect(0, 0, w, 4);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------- procedural machine audio, layered on the shared sound graph

function env(g: GainNode, t: number, peak: number, a: number, d: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function route(g: AudioNode, wet: number) {
  const a = sound.raw!;
  g.connect(a.sfx);
  if (wet > 0) {
    const w = a.ctx.createGain();
    w.gain.value = wet;
    g.connect(w).connect(a.verb);
  }
}

function tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0, wet = 0, filt?: [BiquadFilterType, number, number]) {
  const a = sound.raw;
  if (!a) return;
  const t = a.ctx.currentTime + delay;
  const o = a.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  const g = a.ctx.createGain();
  env(g, t, peak, 0.005, dur);
  let n: AudioNode = o;
  if (filt) {
    const f = a.ctx.createBiquadFilter();
    f.type = filt[0];
    f.frequency.value = filt[1];
    f.Q.value = filt[2];
    n.connect(f);
    n = f;
  }
  n.connect(g);
  route(g, wet);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur: number, type: BiquadFilterType, freq: number, q: number, peak: number, delay = 0, wet = 0, sweep?: number) {
  const a = sound.raw;
  if (!a) return;
  const t = a.ctx.currentTime + delay;
  const s = a.ctx.createBufferSource();
  s.buffer = a.noise;
  s.start(t, rand(0, 1.5), dur + 0.05);
  const f = a.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  f.Q.value = q;
  const g = a.ctx.createGain();
  env(g, t, peak, 0.003, dur);
  s.connect(f).connect(g);
  route(g, wet);
}

const sfx = {
  hum: null as null | { g: GainNode; lp: BiquadFilterNode; buzz: GainNode; o2: OscillatorNode },
  humStart() {
    const a = sound.raw;
    if (!a || this.hum) return;
    const ctx = a.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 4;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = 49;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = 98.5;
    const og = ctx.createGain();
    og.gain.value = 0.3;
    o1.connect(lp);
    o2.connect(og).connect(lp);
    lp.connect(g);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 2;
    const buzz = ctx.createGain();
    buzz.gain.value = 0;
    o2.connect(bp).connect(buzz).connect(g);
    g.connect(a.sfx);
    o1.start();
    o2.start();
    this.hum = { g, lp, buzz, o2 };
  },
  humSet(power: number, tension: number) {
    const a = sound.raw;
    if (!a || !this.hum) return;
    const t = a.ctx.currentTime;
    this.hum.g.gain.setTargetAtTime(0.0001 + power * (0.08 + tension * 0.1), t, 0.05);
    this.hum.lp.frequency.setTargetAtTime(240 + tension * 1500, t, 0.05);
    this.hum.buzz.gain.setTargetAtTime(tension * 0.35, t, 0.03);
    this.hum.o2.frequency.setTargetAtTime(98.5 + tension * 40, t, 0.08);
  },
  /** Stuttering square-wave syllables, one burst per few letters. */
  voice(text: string, angry = false) {
    let d = 0;
    for (const word of text.split(' ').slice(0, 9)) {
      const syl = Math.max(1, Math.ceil(word.length / 3));
      for (let i = 0; i < syl; i++) {
        const f = angry ? rand(70, 110) : rand(95, 165);
        tone('square', f, f * rand(0.85, 1.15), 0.065, 0.07, d, 0.25, ['bandpass', rand(700, 1500), 3]);
        d += 0.085;
      }
      d += 0.07;
    }
  },
  chomp() {
    noise(0.07, 'highpass', 3000, 0.7, 1.0, 0, 0.3);
    tone('square', 190, 40, 0.14, 0.45, 0, 0.3, ['lowpass', 900, 1]);
    tone('triangle', 430, 400, 0.5, 0.18, 0.01, 0.7);
    tone('sine', 95, 35, 0.28, 1.0);
  },
  coin(vol = 1) {
    tone('sine', 2900, 2860, 0.14, 0.14 * vol, 0, 0.2);
    tone('sine', 4150, 4100, 0.09, 0.07 * vol, 0.025, 0.2);
    for (let i = 0; i < 4; i++) noise(0.025, 'bandpass', rand(2500, 4000), 3, 0.06 * vol, 0.12 + i * rand(0.05, 0.09), 0.3);
  },
  servo(dur: number, up: boolean) {
    tone('sawtooth', up ? 170 : 300, up ? 330 : 140, dur, 0.05, 0, 0.1, ['bandpass', 1300, 2]);
    tone('square', 88, 92, dur, 0.025);
  },
  hydraulic(dur: number) {
    noise(dur, 'highpass', 2200, 0.5, 0.3, 0, 0.3, 5000);
    tone('sawtooth', 60, 45, dur, 0.08, 0, 0.2, ['lowpass', 300, 3]);
  },
  slam() {
    tone('sine', 72, 26, 0.55, 1.5);
    noise(0.35, 'lowpass', 700, 0.8, 1.3, 0, 0.7);
    tone('square', 230, 55, 0.2, 0.4);
    tone('triangle', 310, 300, 1.1, 0.18, 0, 0.9);
  },
  tell(dur: number) {
    tone('sawtooth', 110, 260, dur, 0.1, 0, 0.2, ['bandpass', 900, 4]);
    tone('square', 50, 52, dur, 0.04);
  },
  growl() {
    tone('sawtooth', 75, 48, 0.55, 0.16, 0, 0.4, ['lowpass', 420, 5]);
  },
  ding() {
    tone('sine', 1320, 1318, 0.3, 0.08, 0, 0.3);
    tone('sine', 990, 988, 0.45, 0.07, 0.12, 0.3);
  },
  scream() {
    tone('sawtooth', rand(520, 700), 280, 0.75, 0.16, 0, 0.5, ['bandpass', 1100, 4]);
    tone('sawtooth', rand(700, 950), 360, 0.65, 0.09, 0.02, 0.5, ['bandpass', 2500, 5]);
  },
  drill() {
    noise(0.3, 'bandpass', 1800, 4, 0.5, 0, 0.2, 900);
    tone('sawtooth', 420, 950, 0.18, 0.12);
  },
  thunk() {
    tone('sine', 320, 120, 0.12, 0.3);
    noise(0.05, 'bandpass', 1300, 2, 0.25);
  },
  power() {
    tone('sawtooth', 38, 130, 1.8, 0.14, 0, 0.5, ['lowpass', 700, 3]);
    for (let i = 0; i < 6; i++) noise(0.02, 'highpass', 4000, 1, 0.12, i * rand(0.05, 0.2), 0.3);
  },
};

// ---------- the room

function buildRoom(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x040505);
  scene.fog = new THREE.FogExp2(0x060706, 0.14);
  const W = ROOM.x * 2, D = ROOM.z1 - ROOM.z0, cz = (ROOM.z1 + ROOM.z0) / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0xffffff, { map: Tex.floor([W, D]) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = cz;
  floor.receiveShadow = true;
  scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0x161514));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, ROOM.h, cz);
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
  wall(D, conc, -ROOM.x, cz, Math.PI / 2);
  wall(D, conc, ROOM.x, cz, -Math.PI / 2);
  wall(W, concB, 0, ROOM.z0, 0);
  wall(W, concB, 0, ROOM.z1, Math.PI);
  const haz = lam(0xffffff, { map: Tex.hazard([D * 2, 1]) });
  box(0.02, 0.22, D, haz, scene, -ROOM.x + 0.011, 0.11, cz);
  box(0.02, 0.22, D, haz, scene, ROOM.x - 0.011, 0.11, cz);
  box(0.9, 0.004, 0.08, lam(0xffffff, { map: Tex.hazard([3, 1]) }), scene, 0, 0.002, 0.62);
  const rust = lam(0xffffff, { map: Tex.rust([6, 1]) });
  for (const [y, r] of [[2.5, 0.06], [2.68, 0.04]] as const) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, D, 8), rust);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(-ROOM.x + 0.12, y, cz);
    scene.add(pipe);
  }
  const beam = lam(0xffffff, { map: Tex.rust([8, 1]) });
  box(0.16, 0.18, D, beam, scene, 0.68, ROOM.h - 0.09, cz);
  box(0.16, 0.18, D, beam, scene, -0.68, ROOM.h - 0.09, cz);
  box(W, 0.14, 0.14, beam, scene, 0, ROOM.h - 0.25, 0.2);

  scene.add(new THREE.HemisphereLight(0x4a4038, 0x0a0806, 0.75));
  const LAMP = new THREE.Vector3(0, 2.55, -1.6);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.2, 8, 1, true), new THREE.MeshLambertMaterial({ color: 0x3a3832, emissive: 0x0a0806, side: THREE.DoubleSide }));
  shade.position.set(LAMP.x, LAMP.y + 0.09, LAMP.z);
  scene.add(shade);
  const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), new THREE.MeshBasicMaterial({ color: 0xffe2b0, fog: false }));
  bulb.position.copy(LAMP);
  scene.add(bulb);
  box(0.01, ROOM.h - LAMP.y - 0.19, 0.01, lam(0x111111), scene, LAMP.x, (ROOM.h + LAMP.y + 0.19) / 2, LAMP.z);
  const lamp = new THREE.SpotLight(0xffd2a0, 20, 8, 1.05, 0.55, 1.3);
  lamp.position.copy(LAMP);
  lamp.target.position.set(0, 0, -1.9);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(512, 512);
  lamp.shadow.bias = -0.002;
  scene.add(lamp, lamp.target);

  const tube = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1.0), new THREE.MeshBasicMaterial({ color: 0xcfe0ff, fog: false }));
  tube.position.set(-ROOM.x + 0.05, 2.7, -0.4);
  scene.add(tube);
  const cold = new THREE.PointLight(0x9fb8ff, 2.0, 4, 1.4);
  cold.position.set(-ROOM.x + 0.3, 2.6, -0.4);
  scene.add(cold);
  const fill = new THREE.PointLight(0xffc89a, 1.2, 1.8, 1.5);
  fill.position.set(0.3, 1.55, 0.75);
  scene.add(fill);
  const danger = new THREE.PointLight(0xff2010, 0, 6, 1.2);
  danger.position.set(0, 2.4, -1.8);
  scene.add(danger);
  const flickers = [
    new Flicker(lamp, bulb.material as THREE.MeshBasicMaterial, lamp.intensity, 0.4),
    new Flicker(cold, tube.material as THREE.MeshBasicMaterial, cold.intensity, 1.8),
  ];
  const surfaces: Surface[] = [{ y: 0, x0: -ROOM.x, x1: ROOM.x, z0: ROOM.z0, z1: ROOM.z1 }];
  const walls: Wall[] = [
    { axis: 'x', at: -ROOM.x, normal: 1 },
    { axis: 'x', at: ROOM.x, normal: -1 },
    { axis: 'z', at: ROOM.z0 + 0.26, normal: 1 },
    { axis: 'z', at: ROOM.z1, normal: -1 },
  ];
  return { surfaces, walls, flickers, danger, shade };
}

// ---------- the machine

const MODE_CSS: Record<Mode, string> = { off: '#0a1a0c', green: '#3cff6a', amber: '#ffb020', red: '#ff2a1a' };
const MODE_RGB: Record<Mode, [number, number, number]> = { off: [0, 0, 0], green: [0.24, 1, 0.42], amber: [1, 0.66, 0.12], red: [1, 0.12, 0.06] };

class Machine {
  readonly root = new THREE.Group();
  readonly head = new THREE.Group();
  readonly glow: THREE.PointLight;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private screen: THREE.MeshBasicMaterial;
  private leds: THREE.MeshBasicMaterial[] = [];
  private needles: THREE.Object3D[] = [];
  private slats: THREE.Mesh[] = [];
  private stock: THREE.Object3D[] = [];
  private jar = new THREE.Group();
  private fingers: { m: THREE.Mesh; y: number; target: number; spin: number }[] = [];
  private fingerGeo = new THREE.CapsuleGeometry(0.009, 0.045, 2, 5);
  private fingerMat = lam(0xb59c86, { emissive: 0x100804 });
  private nailMat = lam(0x5a0606, { emissive: 0x1a0000 });
  private flap = new THREE.Group();
  private steam: { m: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private steamMat = new THREE.MeshBasicMaterial({ color: 0x8a8a84, transparent: true, opacity: 0.2, depthWrite: false });
  private puffGeo = new THREE.IcosahedronGeometry(1, 0);
  private drawT = 0;
  private blinkT = 2.5;
  private blink = 0;
  power = 0;
  mode: Mode = 'off';
  lid = 1;
  look = new THREE.Vector2();
  lookTarget = new THREE.Vector2();
  text = '';
  talk = 0;
  tension = 0;
  hatch = 0;

  constructor(scene: THREE.Scene) {
    const r = this.root;
    r.position.set(0, 0, FRONT);
    scene.add(r);
    const rust = lam(0xffffff, { map: Tex.rust([2, 3]) });
    const rustDark = lam(0x8a7a70, { map: Tex.rust([1, 2]) });
    const metal = lam(0xffffff, { map: Tex.metal([2, 2]) });
    const dark = lam(0x121212);
    const black = lam(0x040303);
    box(1.9, 2.9, 0.52, rust, r, 0, 1.45, 0, true);
    for (const s of [-1, 1]) box(0.14, 3.0, 0.62, rustDark, r, s * 1.0, 1.5, 0.02, true);
    box(2.16, 0.26, 0.66, lam(0xffffff, { map: Tex.hazard([5, 1]) }), r, 0, 3.0, 0.04);
    box(1.9, 0.42, 0.58, lam(0xffffff, { map: Tex.hazard([5, 1]) }), r, 0, 0.21, 0.04);

    this.canvas.width = 160;
    this.canvas.height = 120;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.screen = new THREE.MeshBasicMaterial({ map: this.tex, fog: false });
    this.head.position.set(0, 2.1, 0.26);
    r.add(this.head);
    box(1.08, 0.84, 0.56, metal, this.head, 0, 0, 0.0, true);
    box(1.0, 0.06, 0.06, dark, this.head, 0, 0.36, 0.28);
    box(1.0, 0.06, 0.06, dark, this.head, 0, -0.36, 0.28);
    box(0.06, 0.78, 0.06, dark, this.head, -0.5, 0, 0.28);
    box(0.06, 0.78, 0.06, dark, this.head, 0.5, 0, 0.28);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.68), this.screen);
    scr.position.z = 0.282;
    this.head.add(scr);
    for (const s of [-1, 1]) {
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6), dark);
      cable.position.set(s * 0.42, 0.55, -0.1);
      cable.rotation.z = s * 0.5;
      this.head.add(cable);
    }
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.4, 4), dark);
    antenna.position.set(0.3, 0.6, -0.1);
    antenna.rotation.z = -0.3;
    this.head.add(antenna);

    box(0.64, 0.2, 0.05, dark, r, 0, 1.5, 0.27);
    for (let i = 0; i < 5; i++) this.slats.push(box(0.58, 0.018, 0.03, metal, r, 0, 1.43 + i * 0.035, 0.29));

    box(1.24, 0.52, 0.08, rustDark, r, 0, 1.06, 0.26);
    box(1.12, 0.42, 0.04, black, r, 0, 1.06, 0.29);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 0.42), new THREE.MeshLambertMaterial({ color: 0x8fb89a, transparent: true, opacity: 0.14, depthWrite: false }));
    glass.position.set(0, 1.06, 0.315);
    r.add(glass);
    const coil = lam(0x8a8a80);
    const capMat = lam(0x7a1a10, { emissive: 0x140202 });
    const capBand = lam(0xd8cfa8);
    for (let i = 0; i < 4; i++) {
      const x = -0.42 + i * 0.28;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.006, 4, 10), coil);
      ring.position.set(x, 1.02, 0.3);
      r.add(ring);
      const item = new THREE.Group();
      item.position.set(x, 1.05, 0.3);
      item.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.11, 8), capMat));
      item.add(new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.03, 8), capBand));
      r.add(item);
      this.stock.push(item);
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.04), new THREE.MeshBasicMaterial({ map: labelTex(`${OFFERS[i].cost}c`, '#ffb020', '#1a0d04', 32, 14), fog: false }));
      tag.position.set(x, 0.885, 0.31);
      r.add(tag);
    }

    box(0.66, 0.3, 0.06, rustDark, r, 0, HATCH.y, 0.26);
    box(0.54, 0.2, 0.04, black, r, 0, HATCH.y, 0.29);
    this.flap.position.set(0, HATCH.y + 0.1, 0.31);
    r.add(this.flap);
    box(0.54, 0.2, 0.012, metal, this.flap, 0, -0.1, 0);
    const flapSign = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.06), new THREE.MeshBasicMaterial({ map: labelTex('COLLECT ITEM', '#d8cfa8', '#2a0a06', 96, 14) }));
    flapSign.position.set(0, -0.1, 0.007);
    this.flap.add(flapSign);
    const drip = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.42), new THREE.MeshLambertMaterial({ map: dripTex(), transparent: true, depthWrite: false }));
    drip.position.set(0.04, HATCH.y - 0.36, 0.333);
    r.add(drip);

    box(0.16, 0.24, 0.06, dark, r, 0.75, 1.3, 0.27);
    box(0.09, 0.016, 0.03, black, r, 0.75, 1.36, 0.3);
    const slotDrip = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.3), new THREE.MeshLambertMaterial({ map: dripTex(), transparent: true, depthWrite: false }));
    slotDrip.position.set(0.75, 1.2, 0.305);
    r.add(slotDrip);
    const slotSign = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.05), new THREE.MeshBasicMaterial({ map: labelTex('COINS / FINGERS', '#ffb020', '#120804', 96, 16), fog: false }));
    slotSign.position.set(0.75, 1.46, 0.31);
    r.add(slotSign);

    for (const x of [-0.75, 0.75]) {
      const y = x < 0 ? 1.3 : 0.95;
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 14), lam(0xd8d0bc));
      dial.rotation.x = Math.PI / 2;
      dial.position.set(x, y, 0.28);
      r.add(dial);
      const n = new THREE.Group();
      n.position.set(x, y, 0.3);
      box(0.008, 0.09, 0.004, lam(0xaa0000), n, 0, 0.04, 0);
      r.add(n);
      this.needles.push(n);
    }
    for (let i = 0; i < 8; i++) {
      const m = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff2200 : 0xffaa00, fog: false });
      this.leds.push(m);
      box(0.03, 0.03, 0.02, m, r, -0.35 + i * 0.1, 1.66, 0.28);
    }

    box(0.34, 0.03, 0.26, rustDark, r, -0.78, 1.73, 0.38, true);
    const jar = this.jar;
    jar.position.set(-0.78, 1.745, 0.4);
    r.add(jar);
    const fluid = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.22, 12), new THREE.MeshLambertMaterial({ color: 0x7a8a2a, emissive: 0x141a04, transparent: true, opacity: 0.42, depthWrite: false }));
    fluid.position.y = 0.115;
    fluid.renderOrder = 2;
    jar.add(fluid);
    const glassJar = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.28, 12, 1, true), new THREE.MeshLambertMaterial({ color: 0xbfd8c0, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    glassJar.position.y = 0.14;
    glassJar.renderOrder = 3;
    jar.add(glassJar);
    box(0.2, 0.035, 0.2, rustDark, jar, 0, 0.3, 0);
    const jarLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.05), new THREE.MeshBasicMaterial({ map: labelTex('TIPS', '#1a1a1a', '#d8cfa8', 48, 20) }));
    jarLabel.position.set(0, 0.06, 0.097);
    jar.add(jarLabel);
    for (let i = 0; i < 11; i++) this.addFinger(true);

    const pipe = lam(0xffffff, { map: Tex.rust([1, 4]) });
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, ROOM.h, 8), pipe);
      p.position.set(s * 1.22, ROOM.h / 2, 0.15);
      r.add(p);
    }
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.2, 8), pipe);
    vent.position.set(0.62, 3.2, 0.2);
    r.add(vent);

    this.glow = new THREE.PointLight(0x3cff6a, 0, 4.8, 1.3);
    this.glow.position.set(0, 2.05, 0.95);
    r.add(this.glow);
  }

  setStock(n: number) {
    this.stock.forEach((s, i) => (s.visible = i < n));
  }

  /** Drop one more finger into the jar (it sinks). */
  addFinger(initial = false) {
    if (this.fingers.length >= 26) return;
    const m = new THREE.Mesh(this.fingerGeo, this.fingerMat);
    const nail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.012), this.nailMat);
    nail.position.y = 0.03;
    m.add(nail);
    const a = rand(0, 6.28), rr = rand(0, 0.055);
    const target = 0.025 + Math.floor(this.fingers.length / 6) * 0.018 + rand(0, 0.012);
    m.position.set(Math.cos(a) * rr, initial ? target : 0.24, Math.sin(a) * rr);
    m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
    this.jar.add(m);
    this.fingers.push({ m, y: m.position.y, target, spin: rand(-0.4, 0.4) });
  }

  puff(n: number, at = new THREE.Vector3(0.62, 3.25, FRONT + 0.2)) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.puffGeo, this.steamMat.clone());
      m.position.copy(at);
      m.scale.setScalar(rand(0.04, 0.08));
      this.root.parent!.add(m);
      this.steam.push({ m, v: new THREE.Vector3(rand(-0.2, 0.2), rand(0.4, 0.9), rand(0, 0.5)), life: 1 });
    }
  }

  /** Point the eye at a world position. */
  watch(p: THREE.Vector3) {
    this.lookTarget.set(clamp(p.x / 1.1, -1, 1), clamp((EYE.y - p.y) / 1.4, -1, 1));
  }

  update(dt: number, t: number) {
    const k = this.power;
    this.look.x = damp(this.look.x, this.lookTarget.x, 9, dt);
    this.look.y = damp(this.look.y, this.lookTarget.y, 9, dt);
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blinkT = rand(2, 5);
      this.blink = 1;
    }
    this.blink = Math.max(0, this.blink - dt * 7);
    const squint = this.mode === 'amber' ? 0.45 : this.mode === 'red' ? 1.15 : 1;
    this.lid = damp(this.lid, squint * (1 - Math.sin(this.blink * Math.PI) * 0.95), 14, dt);
    const shake = this.tension * 0.006;
    this.root.position.x = rand(-shake, shake);
    this.root.position.y = rand(0, shake * 0.5);
    this.head.rotation.y = damp(this.head.rotation.y, this.look.x * 0.16, 6, dt);
    this.head.rotation.x = damp(this.head.rotation.x, this.look.y * 0.12, 6, dt);
    this.head.rotation.z = Math.sin(t * 0.7) * 0.015 + rand(-1, 1) * this.tension * 0.01;
    this.talk = Math.max(0, this.talk - dt);
    this.slats.forEach((s, i) => (s.position.z = 0.29 + (this.talk > 0 ? Math.abs(Math.sin(t * 38 + i * 1.3)) * 0.018 : 0)));
    this.needles.forEach((n, i) => (n.rotation.z = Math.sin(t * (1.3 + i)) * 0.6 * (0.3 + this.tension) + rand(-0.06, 0.06) * (1 + this.tension * 3) - this.tension * 1.2));
    this.leds.forEach((l, i) => {
      const on = k > 0.5 && (this.mode === 'red' ? Math.sin(t * 22) > 0 : Math.sin(t * 5 + i * 1.7) > 0.2);
      l.color.setHex(on ? (i % 2 ? 0xff2200 : 0xffaa00) : 0x1a0a04);
    });
    this.flap.rotation.x = damp(this.flap.rotation.x, -this.hatch * 1.25, 10, dt);
    for (const f of this.fingers) {
      f.y = damp(f.y, f.target, 1.2, dt);
      f.m.position.y = f.y + Math.sin(t * 0.8 + f.spin * 10) * 0.003;
      f.m.rotation.y += f.spin * dt;
    }
    for (let i = this.steam.length - 1; i >= 0; i--) {
      const s = this.steam[i];
      s.life -= dt * 0.7;
      s.m.position.addScaledVector(s.v, dt);
      s.m.scale.multiplyScalar(1 + dt * 1.4);
      (s.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, s.life * 0.22);
      if (s.life <= 0) {
        s.m.removeFromParent();
        (s.m.material as THREE.Material).dispose();
        this.steam.splice(i, 1);
      }
    }
    const [cr, cg, cb] = MODE_RGB[this.mode];
    this.glow.color.setRGB(cr, cg, cb);
    this.glow.intensity = k * (this.mode === 'red' ? 6 : 3) * (0.9 + Math.random() * 0.15);
    this.screen.color.setScalar(0.85 + Math.random() * 0.15);
    this.drawT -= dt;
    if (this.drawT <= 0) {
      this.drawT = 1 / 30;
      this.draw(t);
    }
  }

  private draw(t: number) {
    const g = this.g, w = 160, h = 120;
    const col = MODE_CSS[this.mode];
    g.globalAlpha = 1;
    g.fillStyle = this.mode === 'red' ? '#140202' : '#010803';
    g.fillRect(0, 0, w, h);
    if (this.power > 0.01) {
      const band = smooth(clamp(this.power, 0, 1));
      g.save();
      g.beginPath();
      g.rect(0, h / 2 - (band * h) / 2, w, Math.max(1, band * h));
      g.clip();
      const cx = w / 2, cy = h * 0.42;
      const rx = w * 0.36, ry = Math.max(0.6, h * 0.25 * this.lid);
      if (this.mode === 'red') {
        g.strokeStyle = '#ff2a1a';
        g.lineWidth = 1;
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + 0.3;
          let x = cx + Math.cos(a) * rx * 0.9, y = cy + Math.sin(a) * ry * 0.9;
          g.beginPath();
          g.moveTo(x, y);
          for (let s = 0; s < 4; s++) g.lineTo((x += Math.cos(a) * 7 + rand(-3, 3)), (y += Math.sin(a) * 5 + rand(-3, 3)));
          g.stroke();
        }
      }
      g.strokeStyle = col;
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      g.stroke();
      g.save();
      g.beginPath();
      g.ellipse(cx, cy, rx - 2, Math.max(0.3, ry - 2), 0, 0, Math.PI * 2);
      g.clip();
      const ir = h * 0.17;
      const ix = cx + this.look.x * rx * 0.55, iy = cy + this.look.y * h * 0.1;
      g.fillStyle = col;
      g.globalAlpha = 0.22;
      g.beginPath();
      g.arc(ix, iy, ir, 0, 7);
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(ix, iy, ir, 0, 7);
      g.stroke();
      g.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + t * 0.2;
        g.beginPath();
        g.moveTo(ix + Math.cos(a) * ir * 0.5, iy + Math.sin(a) * ir * 0.5);
        g.lineTo(ix + Math.cos(a) * ir * 0.92, iy + Math.sin(a) * ir * 0.92);
        g.stroke();
      }
      g.fillStyle = '#000';
      const pr = this.mode === 'red' ? ir * 0.7 : this.mode === 'amber' ? ir * 0.22 : ir * (0.4 + Math.sin(t * 1.3) * 0.04);
      g.beginPath();
      if (this.mode === 'amber') g.ellipse(ix, iy, pr, ir * 0.85, 0, 0, 7);
      else g.arc(ix, iy, pr, 0, 7);
      g.fill();
      g.fillStyle = '#fff';
      g.globalAlpha = 0.7;
      g.fillRect(ix - ir * 0.45, iy - ir * 0.5, 3, 3);
      g.globalAlpha = 1;
      g.restore();
      g.fillStyle = col;
      g.font = 'bold 12px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(this.text + (Math.floor(t * 2.5) % 2 ? '_' : ' '), cx, h * 0.86);
      g.restore();
    }
    g.fillStyle = 'rgba(0,0,0,.38)';
    for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
    const by = ((t * 34) % (h + 24)) - 24;
    g.fillStyle = 'rgba(255,255,255,.05)';
    g.fillRect(0, by, w, 12);
    if (this.power > 0.5 && Math.random() < 0.04 + this.tension * 0.35) {
      const y0 = Math.floor(rand(0, h - 8));
      const img = g.getImageData(0, y0, w, Math.floor(rand(2, 8)));
      g.putImageData(img, Math.floor(rand(-10, 10)), y0);
    }
    this.tex.needsUpdate = true;
  }
}

// ---------- payment podium, overhead press, the dispensing hand

interface Mats {
  rust: THREE.Material;
  metal: THREE.Material;
  dark: THREE.Material;
  black: THREE.Material;
  haz: THREE.Material;
  teeth: THREE.Material;
  drip: THREE.Material;
  sign: THREE.Material;
  hose: THREE.Material;
}

/** Pedestal with a toothed payment mouth on its -z face (toward the subject). */
class Podium {
  readonly root = new THREE.Group();
  private blade = new THREE.Group();
  private spike: THREE.Mesh;
  private led = new THREE.MeshBasicMaterial({ color: 0x111111, fog: false });
  jaw = 0;
  jawTarget = 0;
  spikeOut = 0;
  spikeTarget = 0;

  constructor(parent: THREE.Object3D, m: Mats, readonly mouthY: number, z: number) {
    const r = this.root;
    r.position.set(0, 0, z);
    parent.add(r);
    const ph = mouthY - 0.13;
    box(0.24, ph, 0.2, m.rust, r, 0, ph / 2, 0, true);
    box(0.32, 0.05, 0.28, m.dark, r, 0, 0.025, 0);
    box(0.36, 0.26, 0.3, m.metal, r, 0, mouthY, 0, true);
    box(0.18, 0.08, 0.02, m.black, r, 0, mouthY, -0.151);
    for (const [w, h, x, y] of [[0.22, 0.02, 0, 0.05], [0.22, 0.02, 0, -0.05], [0.02, 0.1, -0.1, 0], [0.02, 0.1, 0.1, 0]] as const) box(w, h, 0.02, m.rust, r, x, mouthY + y, -0.158);
    this.blade.position.set(0, mouthY + 0.04, -0.18);
    r.add(this.blade);
    box(0.2, 0.05, 0.008, m.haz, this.blade, 0, 0.025, 0.006);
    this.blade.add(new THREE.Mesh(teethGeo(0.18, 0.032, 7, true), m.teeth));
    const lower = new THREE.Mesh(teethGeo(0.18, 0.026, 7, false), m.teeth);
    lower.position.set(0, mouthY - 0.042, -0.18);
    r.add(lower);
    const drip = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.2), m.drip);
    drip.position.set(0.01, mouthY - 0.15, -0.153);
    drip.rotation.y = Math.PI;
    r.add(drip);
    box(0.03, 0.03, 0.012, this.led, r, 0.14, mouthY + 0.1, -0.154);
    box(0.2, 0.02, 0.1, m.metal, r, 0, mouthY - 0.26, -0.2);
    box(0.2, 0.035, 0.01, m.metal, r, 0, mouthY - 0.245, -0.25);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.06), m.sign);
    sign.position.set(0, ph * 0.6, -0.101);
    sign.rotation.y = Math.PI;
    r.add(sign);
    const sg = new THREE.ConeGeometry(0.02, 0.5, 5).translate(0, 0.25, 0).rotateX(-Math.PI / 2);
    this.spike = new THREE.Mesh(sg, m.metal);
    this.spike.position.set(0, 1.07, -0.1);
    this.spike.visible = false;
    r.add(this.spike);
  }


  setLed(hex: number) {
    this.led.color.setHex(hex);
  }

  update(dt: number) {
    this.jaw = this.jawTarget > this.jaw ? Math.min(1, this.jaw + dt / 0.045) : Math.max(this.jawTarget, this.jaw - dt / 0.4);
    this.blade.position.y = this.mouthY + 0.04 - 0.072 * smooth(this.jaw);
    this.spikeOut = this.spikeTarget > this.spikeOut ? Math.min(1, this.spikeOut + dt / 0.06) : Math.max(0, this.spikeOut - dt / 0.5);
    this.spike.visible = this.spikeOut > 0.01;
    this.spike.scale.set(1, 1, Math.max(0.01, this.spikeOut));
  }
}

/** Hazard-striped hydraulic press hanging over a station. */
class Press {
  readonly root = new THREE.Group();
  private block = new THREE.Group();
  private rod: THREE.Mesh;
  private blood: THREE.Mesh;
  y = PRESS_REST;
  private state: 'rest' | 'windup' | 'slam' | 'hold' | 'up' = 'rest';
  private t = 0;
  private from = PRESS_REST;
  private target = 1.5;
  private onHit: (() => void) | null = null;

  constructor(scene: THREE.Scene, m: Mats, x: number, z: number) {
    this.root.position.set(x, 0, z);
    scene.add(this.root);
    this.root.add(this.block);
    box(0.44, 0.3, 0.44, m.haz, this.block, 0, 0.17, 0, true);
    box(0.48, 0.05, 0.48, m.dark, this.block, 0, 0.025, 0, true);
    box(0.3, 0.06, 0.3, m.rust, this.block, 0, 0.35, 0);
    this.blood = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.46), new THREE.MeshLambertMaterial({ map: Tex.splat(3), color: 0x7a0606, emissive: 0x200000, alphaTest: 0.5 }));
    this.blood.rotation.x = Math.PI / 2;
    this.blood.position.y = -0.002;
    this.blood.visible = false;
    this.block.add(this.blood);
    this.rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8).translate(0, 0.5, 0), m.metal);
    this.root.add(this.rod);
    box(0.22, 0.12, 0.22, m.dark, this.root, 0, ROOM.h - 0.06, 0);
    this.place();
  }

  trigger(target: number, onHit: () => void) {
    this.state = 'windup';
    this.t = 0;
    this.target = target;
    this.onHit = onHit;
    sfx.hydraulic(0.6);
  }

  private place() {
    this.block.position.y = this.y;
    this.rod.position.y = this.y + 0.38;
    this.rod.scale.y = Math.max(0.01, ROOM.h - 0.12 - (this.y + 0.38));
  }

  update(dt: number) {
    this.t += dt;
    if (this.state === 'windup') {
      this.y = PRESS_REST - 0.16 * smooth(clamp(this.t / 0.55, 0, 1)) + rand(-0.004, 0.004);
      if (this.t >= 0.55) {
        this.state = 'slam';
        this.t = 0;
        this.from = this.y;
      }
    } else if (this.state === 'slam') {
      const k = clamp(this.t / 0.07, 0, 1);
      this.y = lerp(this.from, this.target, k * k);
      if (k >= 1) {
        this.state = 'hold';
        this.t = 0;
        this.blood.visible = true;
        sfx.slam();
        const f = this.onHit;
        this.onHit = null;
        f?.();
      }
    } else if (this.state === 'hold') {
      if (this.t >= 0.4) {
        this.state = 'up';
        this.t = 0;
        sfx.hydraulic(1.2);
      }
    } else if (this.state === 'up') {
      this.y = lerp(this.target, PRESS_REST, smooth(clamp(this.t / 1.4, 0, 1)));
      if (this.t >= 1.4) this.state = 'rest';
    }
    this.place();
  }
}

interface Job {
  to: THREE.Vector3;
  done: () => void;
}

/** A severed hand on a telescoping rod that reaches out of the hatch and drops your capsule. */
class Grabber {
  private segs: THREE.Mesh[] = [];
  private hand = new THREE.Group();
  private fingers: THREE.Group[] = [];
  private capsule: THREE.Group;
  private jobs: Job[] = [];
  private job: Job | null = null;
  private state: 'home' | 'out' | 'drop' | 'back' = 'home';
  private t = 0;
  private drops: { m: THREE.Group; v: number; floor: number }[] = [];
  private p0 = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private p2 = new THREE.Vector3();
  ext = 0;

  constructor(readonly scene: THREE.Scene, m: Mats, readonly gore: Gore, readonly machine: Machine) {
    const seg = new THREE.CylinderGeometry(0.022, 0.026, 1, 6).translate(0, 0.5, 0);
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Mesh(seg, i % 2 ? m.rust : m.metal);
      s.visible = false;
      scene.add(s);
      this.segs.push(s);
    }
    const skin = lam(0x9a8a78, { emissive: 0x0c0806 });
    const h = this.hand;
    scene.add(h);
    h.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 8).rotateX(Math.PI / 2), m.rust));
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.035, 0.02, 7).rotateX(Math.PI / 2), lam(0x6e0606, { emissive: 0x220000 }));
    wrist.position.z = 0.02;
    h.add(wrist);
    box(0.012, 0.012, 0.03, lam(0xd9ccb0), h, 0, 0, 0.012);
    box(0.08, 0.026, 0.09, skin, h, 0, 0, 0.075);
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Group();
      p.position.set(-0.028 + i * 0.0187, 0, 0.118);
      h.add(p);
      box(0.015, 0.016, 0.055 - Math.abs(i - 1.5) * 0.006, skin, p, 0, 0, 0.026);
      box(0.012, 0.004, 0.01, lam(0x4a3a30), p, 0, 0.009, 0.045);
      this.fingers.push(p);
    }
    const th = new THREE.Group();
    th.position.set(0.045, -0.005, 0.07);
    th.rotation.y = 0.7;
    h.add(th);
    box(0.016, 0.016, 0.045, skin, th, 0, 0, 0.02);
    this.fingers.push(th);
    this.capsule = this.makeCapsule();
    h.visible = false;
  }

  private makeCapsule() {
    const g = new THREE.Group();
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.09, 8), lam(0x7a1a10, { emissive: 0x140202 }));
    c.rotation.z = Math.PI / 2;
    g.add(c);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.025, 8), lam(0xd8cfa8));
    b.rotation.z = Math.PI / 2;
    g.add(b);
    g.position.set(0, -0.04, 0.08);
    this.hand.add(g);
    return g;
  }

  deliver(to: THREE.Vector3, done: () => void) {
    this.jobs.push({ to: to.clone(), done });
  }

  get idle() {
    return !this.job && this.jobs.length === 0;
  }

  handWorld(out = new THREE.Vector3()) {
    return out.copy(this.hand.position);
  }

  private curve(u: number, out: THREE.Vector3) {
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    return out.set(a * this.p0.x + b * this.p1.x + c * this.p2.x, a * this.p0.y + b * this.p1.y + c * this.p2.y, a * this.p0.z + b * this.p1.z + c * this.p2.z);
  }

  update(dt: number) {
    if (!this.job && this.jobs.length) {
      this.job = this.jobs.shift()!;
      this.state = 'out';
      this.t = 0;
      this.p0.copy(HATCH).setZ(HATCH.z - 0.05);
      this.p2.copy(this.job.to).add(new THREE.Vector3(0, 0.1, 0));
      this.p1.addVectors(this.p0, this.p2).multiplyScalar(0.5);
      this.p1.y = Math.max(this.p0.y, this.p2.y) + 0.7;
      if (this.capsule.parent !== this.hand) this.capsule = this.makeCapsule();
      sfx.servo(1.0, true);
      this.machine.hatch = 1;
    }
    this.t += dt;
    let curl = 1;
    if (this.state === 'out') {
      this.ext = smooth(clamp(this.t / 1.05, 0, 1));
      if (this.t >= 1.05) {
        this.state = 'drop';
        this.t = 0;
      }
    } else if (this.state === 'drop') {
      curl = this.t < 0.18 ? 1 : 0;
      if (this.t >= 0.18 && this.capsule.parent === this.hand) {
        this.scene.attach(this.capsule);
        this.drops.push({ m: this.capsule, v: 0, floor: this.job!.to.y + 0.03 });
        this.job!.done();
      }
      if (this.t >= 0.5) {
        this.state = 'back';
        this.t = 0;
        sfx.servo(0.85, false);
      }
    } else if (this.state === 'back') {
      curl = 0.3;
      this.ext = 1 - smooth(clamp(this.t / 0.85, 0, 1));
      if (this.t >= 0.85) {
        this.state = 'home';
        this.job = null;
        this.ext = 0;
        if (!this.jobs.length) this.machine.hatch = 0;
      }
    }
    for (const f of this.fingers) f.rotation.x = damp(f.rotation.x, curl * 1.05, 14, dt);
    const show = this.ext > 0.01 && this.state !== 'home';
    this.hand.visible = show;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const n = this.segs.length;
    for (let i = 0; i < n; i++) {
      const s = this.segs[i];
      s.visible = show;
      if (!show) continue;
      this.curve((this.ext * i) / n, a);
      this.curve((this.ext * (i + 1)) / n, b);
      const d = b.clone().sub(a);
      s.position.copy(a);
      s.scale.set(1, d.length() + 0.01, 1);
      s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    }
    if (show) {
      this.curve(this.ext, a);
      this.curve(Math.max(0, this.ext - 0.04), b);
      this.hand.position.copy(a);
      const dir = a.clone().sub(b).setY(0);
      if (dir.lengthSq() > 1e-8) this.hand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
      if (Math.random() < 8 * dt) this.gore.spray(this.hand.localToWorld(new THREE.Vector3(0, 0, 0.02)), new THREE.Vector3(0, -1, 0), 1, [0.1, 0.4], 0.3);
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.v -= 9.8 * dt;
      d.m.position.y += d.v * dt;
      d.m.rotation.z += dt * 4;
      if (d.m.position.y <= d.floor) {
        d.m.position.y = d.floor;
        d.m.rotation.z = Math.round(d.m.rotation.z / Math.PI) * Math.PI;
        sfx.thunk();
        this.drops.splice(i, 1);
      }
    }
  }
}

// ---------- copy

const REMARKS = {
  kept: [
    'Transaction completed. Subject displays a healthy appetite for the misfortune of others.',
    'Subject paid in full. The Machine has noted the preference.',
    'Purchase sealed. The victim will be informed by experience.',
  ],
  keptBitten: ['Subject paid in coins and, briefly, an arm. Both were accepted.'],
  bitten: ['Subject left a hand in the slot twice. The Machine considers this a tip.', 'Second bite. Remains filed under inventory.'],
  stock: ['Stock depleted. Subject reclassified as stock.', 'Subject browsed too long. Subject is now on the shelf.'],
  unpaid: ['Outstanding balance collected in kind.', 'The Machine does not extend credit.'],
};

const CHATTER = ['PRICES INCLUDE A FEE.', 'NO REFUNDS. NO WITNESSES.', 'THE JAR IS NOT FULL.', 'STOCK IS LIMITED.', 'KEEP YOUR HAND STILL. IT HELPS.'];

const CSS = `
.mx-say { position:absolute; left:14px; right:14px; top:calc(env(safe-area-inset-top) + 72px); text-align:center; color:#6dff92; font-size:12px; font-weight:700; letter-spacing:1.5px; line-height:1.35; text-shadow:0 0 6px rgba(60,255,106,.55), 0 1px 0 #000; min-height:34px; }
.mx-say.red { color:#ff5a44; text-shadow:0 0 6px rgba(255,40,20,.65), 0 1px 0 #000; }
.mx-roster { position:absolute; left:12px; top:calc(env(safe-area-inset-top) + 116px); display:grid; gap:2px; font-size:10px; }
.mx-roster div { background:rgba(0,0,0,.55); padding:2px 6px; display:flex; gap:10px; justify-content:space-between; min-width:168px; }
.mx-roster small { margin-left:5px; font-size:8px; letter-spacing:1px; color:#8a7f68; text-transform:uppercase; }
.mx-roster em { font-style:normal; color:#b5aa92; letter-spacing:1px; }
.mx-roster .me { outline:1px solid #c9b98a55; }
.mx-roster .paid em { color:#9fd08a; }
.mx-roster .bit em { color:#f2c14a; }
.mx-roster .dead, .mx-roster .dead em { color:#ff3b2a; }
.mx-stock { font-size:11px; color:#6dff92; letter-spacing:2px; margin-top:2px; }
.mx-shop { position:absolute; left:10px; right:10px; bottom:calc(env(safe-area-inset-bottom) + 10px); pointer-events:auto; background:rgba(6,8,6,.92); border:1px solid #2f3f2f; padding:10px; display:grid; gap:7px; box-shadow:0 0 0 3px #000; }
.mx-shop .k { font-size:9px; letter-spacing:2px; color:#7f8f78; display:flex; justify-content:space-between; gap:8px; }
.mx-shop .k b { color:#f2c14a; }
.mx-cards { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.mx-card { all:unset; box-sizing:border-box; position:relative; border:1px solid #2f4a34; background:#0b130c; padding:8px 8px 7px; min-height:66px; display:grid; align-content:start; gap:3px; color:#bfe0c0; }
.mx-card b { font-size:12px; letter-spacing:1.5px; color:#6dff92; padding-right:26px; }
.mx-card em { position:absolute; right:7px; top:7px; font-style:normal; font-size:11px; font-weight:800; color:#f2c14a; }
.mx-card span { font-size:10px; line-height:1.25; color:#93ad93; }
.mx-card.on { border-color:#6dff92; background:#123018; box-shadow:inset 0 0 0 1px #6dff92; }
.mx-card.off { opacity:.3; }
.mx-chips { display:flex; gap:6px; }
.mx-chip { all:unset; box-sizing:border-box; flex:1; text-align:center; padding:12px 2px; border:1px solid #5a4d40; background:#140c0a; font-size:11px; font-weight:700; letter-spacing:1px; color:#e6dcc6; }
.mx-chip.on { border-color:#ff4a3a; background:#3a0c08; color:#fff; }
.mx-chip.off { opacity:.3; text-decoration:line-through; }
.mx-receipt { position:absolute; left:10px; right:10px; bottom:calc(env(safe-area-inset-bottom) + 38px); pointer-events:auto; display:flex; align-items:center; gap:8px; background:rgba(6,8,6,.85); border:1px solid #2f4a34; padding:8px 10px; font-size:11px; letter-spacing:1px; }
.mx-receipt b { color:#6dff92; }
.mx-receipt .pips { display:flex; gap:2px; margin-left:auto; }
.mx-receipt .pips i { width:6px; height:12px; background:#2a2a1c; display:block; }
.mx-receipt .pips i.on { background:#f2c14a; }
.mx-receipt button { all:unset; padding:6px 8px; border:1px solid #5a4d40; font-size:9px; letter-spacing:2px; color:#b5aa92; }
.mx-receipt.done { border-color:#9fd08a; }
.mx-hide { display:none !important; }
`;

export const createMachine: GameFactory = (ctx) => {
  const { engine, hud, rng, start } = ctx;
  const scene = engine.scene;
  const room = buildRoom(scene);
  const gore = new Gore(engine, room.surfaces, room.walls, { onImpact: (v) => sound.splat(v) });
  const machine = new Machine(scene);
  const cam = engine.camera;
  cam.fov = FOV;
  cam.updateProjectionMatrix();
  const auto = new URLSearchParams(location.search).has('auto');

  const mats: Mats = {
    rust: lam(0xffffff, { map: Tex.rust([1, 2]) }),
    metal: lam(0xffffff, { map: Tex.metal() }),
    dark: lam(0x151413),
    black: lam(0x030202),
    haz: lam(0xffffff, { map: Tex.hazard([1.5, 1]) }),
    teeth: lam(0xcfc8b8, { emissive: 0x111111 }),
    drip: new THREE.MeshLambertMaterial({ map: dripTex(), transparent: true, depthWrite: false }),
    sign: new THREE.MeshBasicMaterial({ map: labelTex('NO REFUNDS', '#ffb020', '#140a04', 64, 22) }),
    hose: lam(0x2a2622),
  };

  const numbers = new Set<number>();
  const numberFor = () => {
    let n = rng.int(1, 99);
    while (numbers.has(n)) n = (n % 99) + 1;
    numbers.add(n);
    return n;
  };
  const kinds: Kind[] = ['greedy', 'cautious', 'spiteful'];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

  /** mouthY is the world height of the slot; scale shrinks the podium around it. */
  function makeStation(x: number, z: number, yaw: number, podZ: number, mouthY: number, scale = 1): Station {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw;
    scene.add(group);
    const podium = new Podium(group, mats, mouthY / scale, podZ);
    podium.root.scale.setScalar(scale);
    group.updateMatrixWorld(true);
    const mouth = podium.root.localToWorld(new THREE.Vector3(0, mouthY / scale, -0.15));
    const tray = podium.root.localToWorld(new THREE.Vector3(0, mouthY / scale - 0.25, -0.2));
    const base = group.localToWorld(new THREE.Vector3(0, 0.05, podZ + 0.08));
    const curve = new THREE.CatmullRomCurve3([base, base.clone().add(new THREE.Vector3(0, -0.02, -0.25)), new THREE.Vector3(base.x * 0.6, 0.05, (base.z + FRONT) / 2), new THREE.Vector3(base.x * 0.3, 0.12, FRONT + 0.28)]);
    const hose = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.032, 6), mats.hose);
    hose.receiveShadow = true;
    scene.add(hose);
    const press = new Press(scene, mats, x, z);
    return { group, podium, press, mouth, tray };
  }

  const me = start.players.find((p) => p.id === start.you) ?? start.players[0];
  const others = start.players.filter((p) => p !== me).slice(0, STATIONS.length);

  const makeShopper = (info: PlayerInfo, seat: number): Shopper => {
    const you = seat < 0;
    const number = numberFor();
    let station: Station;
    let subject: Subject | null = null;
    let arm: Limb | null;
    if (you) {
      station = makeStation(0, CAM.z, Math.PI, 0.95, 1.22, 0.78);
      arm = info.limbs.includes('ra') ? 'ra' : info.limbs.includes('la') ? 'la' : null;
    } else {
      const s = STATIONS[seat];
      station = makeStation(s.x, s.z, Math.atan2(-Math.sign(s.x), 0.12), 0.6, 1.2);
      subject = new Subject({ number, hat: info.hat, limbs: info.limbs, seated: false });
      station.group.add(subject.root);
      const pref: Limb = s.x > 0 ? 'la' : 'ra';
      const alt: Limb = pref === 'la' ? 'ra' : 'la';
      arm = info.limbs.includes(pref) ? pref : info.limbs.includes(alt) ? alt : null;
    }
    const brain: Brain | null = info.isBot && !you ? { p: PERSONAS[kinds[seat % 3]], react: 0.3, heeding: true, seenAlert: -1, keep: false } : null;
    return { info, number, you, subject, station, brain, offer: null, victim: null, coins: info.coins ?? START_COINS, paid: 0, payT: 0, depth: 0, want: false, arm, limbs: [...info.limbs], bites: 0, alive: true, done: false, endAt: 0, cause: '', deadAt: -1 };
  };
  const you = makeShopper(me, -1);
  if (auto) you.brain = { p: PERSONAS.cautious, react: 0.2, heeding: true, seenAlert: -1, keep: false };
  const shoppers = [you, ...others.map((p, i) => makeShopper(p, i))];
  const tag = (s: Shopper) => `#${String(s.number).padStart(2, '0')} ${s.info.name.toUpperCase()}`;
  const num = (s: Shopper) => String(s.number).padStart(2, '0');
  const grabber = new Grabber(scene, mats, gore, machine);
  for (const s of shoppers) {
    const m = s.station.mouth, top = m.y + 0.12;
    gore.surfaces.push({ y: top, x0: m.x - 0.16, x1: m.x + 0.16, z0: m.z - 0.16, z1: m.z + 0.16 });
  }

  let stock = Math.max(1, shoppers.length - 1);
  machine.setStock(stock);
  const purchases: Purchase[] = [];

  function pickFor(s: Shopper) {
    const b = s.brain!;
    const afford = OFFERS.filter((o) => o.cost <= s.coins);
    if (!afford.length) return;
    const pref = b.p.offers.map((id) => afford.find((o) => o.id === id)).filter((o): o is Offer => !!o);
    s.offer = pref.length && !rng.chance(0.2) ? pref[0] : rng.pick(afford);
    const prey = shoppers.filter((o) => o !== s && o.alive);
    if (!prey.length) return;
    if (b.p.prey === 'you' && you !== s && rng.chance(0.75)) s.victim = you;
    else if (b.p.prey === 'rich') {
      const most = Math.max(...prey.map((o) => o.limbs.length));
      s.victim = rng.pick(prey.filter((o) => o.limbs.length === most));
    } else s.victim = rng.pick(prey);
  }

  // ---------- state

  let elapsed = 0;
  let openAt = -1;
  let phase: Phase = 'intro';
  let pt = 0;
  let dur = 99;
  let fake = false;
  let snapNext = false;
  let alertAt = -1;
  let clearAt = 0;
  let openSince = 0;
  let closing = false;
  let closeReason: 'time' | 'sold' | '' = '';
  let finished = false;
  const queue: { s: Shopper; cause: string; steps: Step[] }[] = [];
  let execT = 0;
  let pressing = false;
  let youPressAt = -1;
  let youDeadAt = -1;
  const glance = new THREE.Vector3();
  let glanceK = 0;
  let chatterT = 9;
  let hudT = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const later = (sec: number, fn: () => void) => timers.push({ at: elapsed + sec, fn });

  const opened = () => openAt >= 0;
  const openFor = () => (opened() ? elapsed - openAt : 0);
  const progress = () => clamp(openFor() / WINDOW, 0, 1);
  const slotsOpen = () => phase === 'idle' || phase === 'tell';
  const shopping = () => shoppers.filter((s) => s.alive && !s.done);

  // ---------- HUD

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const sayEl = document.createElement('div');
  sayEl.className = 'mx-say';
  hud.root.appendChild(sayEl);
  const roster = document.createElement('div');
  roster.className = 'mx-roster';
  hud.root.appendChild(roster);
  const stockEl = document.createElement('div');
  stockEl.className = 'mx-stock';
  (hud.root.querySelector('.tr') ?? hud.root).appendChild(stockEl);
  const shop = document.createElement('div');
  shop.className = 'mx-shop mx-hide';
  hud.root.appendChild(shop);
  const receipt = document.createElement('div');
  receipt.className = 'mx-receipt mx-hide';
  hud.root.appendChild(receipt);

  let sayFull = '';
  let sayShown = 0;
  let sayHold = 0;
  const sayQ: { line: string; crt?: string; angry: boolean }[] = [];
  function say(line: string, crt?: string, angry = false) {
    sayQ.push({ line, crt, angry });
    sayQ.splice(0, sayQ.length - 2);
    if (sayShown >= sayFull.length && sayHold <= 0) sayNext();
  }
  function sayNext() {
    const { line, crt, angry } = sayQ.shift()!;
    sayFull = line;
    sayShown = 0;
    sayHold = 1.3;
    sayEl.className = 'mx-say' + (angry ? ' red' : '');
    if (crt !== undefined) machine.text = crt;
    machine.talk = Math.min(3.5, 0.6 + line.length * 0.035);
    sfx.voice(line, angry);
  }

  const tap = (el: HTMLElement, fn: () => void) =>
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });

  function buildShop() {
    shop.innerHTML = `<div class="k"><span>OFFERS</span><b>${you.coins}c</b></div>
      <div class="mx-cards">${OFFERS.map((o, i) => `<button class="mx-card ${o.cost > you.coins ? 'off' : ''}" data-i="${i}"><b>${o.name}</b><em>${o.cost}c</em><span>${o.desc}</span></button>`).join('')}</div>
      <div class="k"><span>VICTIM</span></div>
      <div class="mx-chips">${shoppers.filter((s) => s !== you).map((s) => `<button class="mx-chip" data-n="${s.number}">${tag(s)}</button>`).join('')}</div>`;
    shop.querySelectorAll<HTMLElement>('.mx-card').forEach((c) => tap(c, () => chooseOffer(OFFERS[Number(c.dataset.i)])));
    shop.querySelectorAll<HTMLElement>('.mx-chip').forEach((c) => tap(c, () => chooseVictim(shoppers.find((s) => s.number === Number(c.dataset.n)) ?? null)));
    refreshShop();
  }

  function refreshShop() {
    shop.querySelectorAll<HTMLElement>('.mx-card').forEach((c) => c.classList.toggle('on', you.offer === OFFERS[Number(c.dataset.i)]));
    shop.querySelectorAll<HTMLElement>('.mx-chip').forEach((c) => {
      const s = shoppers.find((x) => x.number === Number(c.dataset.n));
      c.classList.toggle('on', !!s && you.victim === s);
      c.classList.toggle('off', !s?.alive);
    });
  }

  function chooseOffer(o: Offer) {
    if (locked(you) || o.cost > you.coins || !you.alive) return;
    you.offer = o;
    sound.clink(true);
    refreshShop();
    maybeCollapse();
  }

  function chooseVictim(s: Shopper | null) {
    if (!s || !s.alive || s === you || locked(you) || !you.alive) return;
    you.victim = s;
    sound.clink();
    refreshShop();
    maybeCollapse();
  }

  function maybeCollapse() {
    if (!you.offer || !you.victim) return;
    setTimeout(() => {
      if (!you.offer || !you.victim || !you.alive) return;
      shop.classList.add('mx-hide');
      renderReceipt();
      hud.setHint('<b>HOLD</b> TO PAY · <b>LET GO</b> ON RED');
    }, 220);
  }

  let receiptKey = '';
  function renderReceipt() {
    if (!you.offer || !you.victim || !shop.classList.contains('mx-hide')) return;
    const key = `${you.offer.id}|${you.victim.number}|${you.paid}|${you.done}`;
    if (key === receiptKey) return;
    receiptKey = key;
    receipt.className = 'mx-receipt' + (you.done ? ' done' : '');
    receipt.innerHTML = `<span><b>${you.offer.name}</b> → ${tag(you.victim)}</span><span class="pips">${Array.from({ length: you.offer.cost }, (_, i) => `<i class="${i < you.paid || you.done ? 'on' : ''}"></i>`).join('')}</span>${locked(you) ? '' : '<button>CHANGE</button>'}`;
    const btn = receipt.querySelector<HTMLElement>('button');
    if (btn)
      tap(btn, () => {
        if (locked(you)) return;
        you.offer = null;
        you.victim = null;
        receiptKey = '';
        receipt.classList.add('mx-hide');
        shop.classList.remove('mx-hide');
        refreshShop();
        hud.setHint('PICK AN OFFER · PICK A VICTIM');
      });
  }

  function renderRoster() {
    roster.innerHTML = shoppers
      .map((s) => {
        const st = !s.alive ? 'STOCKED' : s.done ? 'PAID' : s.depth > 0.5 ? 'PAYING' : s.bites ? 'BITTEN' : 'BROWSING';
        const cls = `${s.you ? 'me' : ''} ${!s.alive ? 'dead' : s.done ? 'paid' : s.bites ? 'bit' : ''}`;
        return `<div class="${cls}"><b>${tag(s)}</b><em>${st}</em></div>`;
      })
      .join('');
    stockEl.textContent = `STOCK ${stock}`;
  }

  // ---------- the machine's cycle

  function enter(p: Phase) {
    phase = p;
    pt = 0;
    if (p === 'wake') {
      dur = WAKE;
      sfx.humStart();
      sfx.power();
      machine.mode = 'green';
      machine.text = '';
    } else if (p === 'idle') {
      dur = rng.range(1.2, 3.0) * (1 - 0.3 * progress());
      snapNext = progress() > 0.45 && rng.chance(0.2);
      clearAt = elapsed;
      machine.mode = 'green';
      sound.intensity = 0.45;
    } else if (p === 'tell') {
      dur = snapNext ? 0.36 : Math.max(0.4, rng.range(0.5, 0.85) * (1 - 0.3 * progress()));
      fake = !snapNext && rng.chance(0.25);
      alertAt = elapsed;
      machine.mode = 'amber';
      sfx.tell(dur);
      sound.intensity = 0.85;
    } else if (p === 'bite') {
      dur = 0.3;
      machine.mode = 'red';
      sfx.chomp();
      engine.shake(0.12);
      machine.puff(4);
      for (const s of shoppers) s.station.podium.jawTarget = 1;
      for (const s of shoppers) s.subject?.flinch();
      const caught = shoppers.filter((s) => s.alive && !s.done && s.arm && s.depth > CAUGHT);
      for (const s of caught) bitten(s);
      if (!caught.length) ctx.haptic('light');
    } else if (p === 'digest') {
      dur = rng.range(1.4, 2.3);
      machine.mode = 'red';
      machine.text = 'DIGESTING';
      sound.intensity = 0.5;
    }
  }

  function reopen() {
    for (const s of shoppers) s.station.podium.jawTarget = 0;
    openSince = elapsed;
    sfx.ding();
    machine.text = rng.chance(0.5) ? 'INSERT HAND' : 'I HAVE AN OFFER';
    enter('idle');
  }

  function machineTick(dt: number) {
    pt += dt;
    if (phase === 'wake') {
      machine.power = clamp(pt / 1.4, 0, 1);
      if (pt >= 1.3 && !machine.text) say('I HAVE AN OFFER.', 'I HAVE AN OFFER');
      if (pt >= dur) {
        openAt = elapsed;
        say('INSERT HAND. THIS IS NORMAL.', 'INSERT HAND');
        reopen();
      }
    } else if (phase === 'idle') {
      if (pt >= dur) enter('tell');
    } else if (phase === 'tell') {
      if (pt >= dur) {
        if (fake) {
          sfx.growl();
          machine.mode = 'green';
          phase = 'idle';
          pt = 0;
          dur = rng.range(0.8, 2.2);
          clearAt = elapsed;
          sound.intensity = 0.45;
        } else enter('bite');
      }
    } else if (phase === 'bite') {
      if (pt >= dur) enter('digest');
    } else if (phase === 'digest') {
      if (pt >= dur && !closing) reopen();
    } else if (phase === 'exec') execTick(dt);
    else if (phase === 'close') {
      if (pt >= dur && !finished) finish();
    }
  }

  // ---------- bites, collections, deaths

  function severArm(s: Shopper) {
    const arm = s.arm;
    if (!arm) return;
    s.limbs = s.limbs.filter((l) => l !== arm);
    const alt: Limb = arm === 'ra' ? 'la' : 'ra';
    s.arm = s.limbs.includes(alt) ? alt : null;
    s.depth = 0;
    s.paid = 0;
    s.payT = 0;
    const mouth = s.station.mouth;
    sound.crunch(1.2);
    sound.squelch(1.2);
    sfx.scream();
    later(0.9, () => {
      machine.addFinger();
      later(0.25, () => machine.addFinger());
      later(0.5, () => machine.addFinger());
    });
    if (s.subject) {
      const sh = s.subject.limbs[arm].root.getWorldPosition(new THREE.Vector3());
      const back = sh.clone().sub(mouth).setY(0).normalize();
      s.subject.severLimb(gore, arm, back.clone().add(new THREE.Vector3(0, 0.4, 0)));
      gore.spray(mouth, back, 90, [1, 3.5], 0.45);
      s.subject.flinch();
      engine.shake(0.15 + Math.max(0, 3 - mouth.distanceTo(cam.position)) * 0.1);
      ctx.haptic('heavy');
    } else youSever(arm);
    if (s.you) hud.setLimbs(s.limbs);
  }

  function bitten(s: Shopper) {
    s.bites++;
    const last = s.bites >= 2 || !s.limbs.some((l) => l !== s.arm && (l === 'ra' || l === 'la'));
    severArm(s);
    if (last) {
      schedule(s, 'Bitten twice by the payment slot', ['press']);
      say(`SUBJECT ${num(s)} IS OUT OF ARMS.`, 'COLLECTING', true);
    } else {
      say(`I KEEP THE ARM, SUBJECT ${num(s)}.`, 'THANK YOU', true);
    }
    glance.copy(s.station.mouth);
    glanceK = 1;
  }

  function schedule(s: Shopper, cause: string, steps: Step[]) {
    if (queue.some((e) => e.s === s) || !s.alive) return;
    queue.push({ s, cause, steps });
    s.want = false;
    for (const o of shoppers) o.station.podium.jawTarget = 1;
    if (phase !== 'exec') {
      phase = 'exec';
      pt = 0;
      execT = 0;
      machine.mode = 'red';
      sound.intensity = 1;
    }
  }

  function execTick(dt: number) {
    const cur = queue[0];
    if (cur) {
      machine.watch(cur.s.subject ? cur.s.subject.headWorld() : cam.position);
      if (pressing) return;
      execT += dt;
      if (execT < 0.55) return;
      execT = 0;
      const step = cur.steps.shift();
      const s = cur.s;
      if (step === 'arm') severArm(s);
      else if (step === 'gut') {
        s.station.podium.spikeTarget = 1;
        later(0.35, () => (s.station.podium.spikeTarget = 0));
        sfx.drill();
        sfx.scream();
        s.subject?.gutSpill(gore);
        s.subject?.flinch();
        ctx.haptic('heavy');
        engine.shake(0.15);
      } else if (step === 'press') {
        pressing = true;
        const target = s.subject ? s.subject.headWorld().y - 0.04 : CAM.y + 0.12;
        if (s.you) youPressAt = elapsed;
        glance.copy(s.subject ? s.subject.headWorld() : cam.position);
        glanceK = s.you ? 0 : 1;
        s.station.press.trigger(target, () => {
          kill(s, cur.cause);
          pressing = false;
          queue.shift();
          execT = 0;
        });
      } else queue.shift();
      return;
    }
    execT += dt;
    if (execT > 0.9) {
      if (!closing) enter('digest');
      else if (!shopping().length && grabber.idle) closeShop();
    }
  }

  function kill(s: Shopper, cause: string) {
    s.alive = false;
    s.endAt = elapsed;
    s.deadAt = elapsed;
    s.cause = cause;
    s.want = false;
    ctx.death(s.info.id, cause);
    engine.slowmo(0.7, 0.22);
    machine.puff(6);
    if (s.you) {
      youDeadAt = elapsed;
      engine.lens.cover();
      engine.flash(0.9, 0xff4020);
      engine.shake(1);
      sound.crunch(1.5);
      sound.squelch(1.5);
      sound.ring(4);
      sound.muffle(0.75);
      hud.stamp('STOCKED');
      hud.setHint('');
      pad.enabled = false;
      shop.classList.add('mx-hide');
      receipt.classList.add('mx-hide');
      for (const a of fpArms) a.group.visible = false;
      return;
    }
    const sub = s.subject!;
    const head = sub.headWorld();
    const toCam = cam.position.clone().sub(head).setY(0).normalize();
    sub.explodeHead(gore, toCam.clone().add(new THREE.Vector3(rand(-0.6, 0.6), -0.15, 0)));
    gore.spray(head, new THREE.Vector3(0, -0.2, 0), 160, [1.5, 4.5], 1, [0.008, 0.024]);
    sub.die('slump');
    sound.crunch(1.3);
    sound.squelch(1.2);
    ctx.haptic('heavy');
    const dist = head.distanceTo(cam.position);
    engine.shake(0.35 + Math.max(0, 3 - dist) * 0.25);
    engine.flash(0.12, 0xff6040);
    if (dist < 3.6) {
      const ndc = head.clone().project(cam);
      engine.lens.burst(clamp((ndc.x + 1) / 2, 0.15, 0.85), clamp((1 - ndc.y) / 2, 0.2, 0.7), (3.6 - dist) / 1.8);
    }
    later(0.8, () => gore.pool(new THREE.Vector3().setFromMatrixPosition(sub.neck.matrixWorld).setY(0), 0.4));
    for (const o of shoppers) if (o !== s && o.alive) o.subject?.flinch(o.station.group.position.x - head.x);
    hud.feed(`<b>${tag(s)}</b> STOCKED.`);
  }

  function complete(s: Shopper) {
    if (!s.offer || !s.victim) return;
    s.done = true;
    s.endAt = elapsed;
    s.coins -= s.offer.cost;
    s.want = false;
    stock = Math.max(0, stock - 1);
    machine.setStock(stock);
    purchases.push({ buyer: s.info.id, offer: s.offer.id, victim: s.victim.info.id });
    sfx.ding();
    machine.text = `SEALED #${String(purchases.length).padStart(2, '0')}`;
    if (s.subject) s.subject.relaxed = true;
    hud.feed(`<b>${tag(s)}</b> PAID.`);
    if (s.you) {
      say('PAID. YOUR SECRET IS SAFE.', 'ACCEPTED');
      hud.setHint('');
      ctx.haptic('heavy');
    } else say(`SEALED. STOCK: ${stock}.`);
    grabber.deliver(s.station.tray, () => {
      if (s.you && s.offer && s.victim) {
        hud.feed(s.offer.done(s.victim.info.name.toUpperCase()));
        glance.copy(s.station.tray);
        glanceK = 1.2;
      }
    });
    if (stock === 0 && shopping().length && !closing) {
      closing = true;
      closeReason = 'sold';
      later(0.8, () => {
        say('SOLD OUT. THE LAST ONE IS STOCK.', 'SOLD OUT', true);
        for (const o of shopping()) schedule(o, 'Sold out. Retained as stock', o.you ? ['press'] : ['gut', 'press']);
      });
    }
  }

  function closeShop() {
    if (phase === 'close') return;
    phase = 'close';
    pt = 0;
    dur = 4;
    machine.mode = 'green';
    machine.lookTarget.set(0, 0.2);
    for (const s of shoppers) s.station.podium.jawTarget = 1;
    say('THANK YOU. THEY WILL FIND OUT.', 'THANK YOU');
    sound.intensity = 0.3;
  }

  function endTick() {
    if (finished || !opened() || phase === 'close') return;
    if (!closing && openFor() >= WINDOW) {
      closing = true;
      closeReason = 'time';
      const left = shopping().sort((a, b) => a.paid - b.paid);
      if (left.length) {
        say('CLOSED. DEBTS COLLECTED IN KIND.', 'CLOSED', true);
        for (const s of left) schedule(s, 'Unpaid at closing. Balance collected in kind', s.you ? ['press'] : ['gut', 'press']);
      }
    }
    if (!shopping().length && !queue.length && !pressing && grabber.idle && phase !== 'exec') closeShop();
  }

  function finish() {
    finished = true;
    const alive = shoppers.filter((s) => s.alive).sort((a, b) => a.endAt - b.endAt);
    const dead = shoppers.filter((s) => !s.alive).sort((a, b) => b.endAt - a.endAt);
    const order = [...alive, ...dead];
    const placements: Placement[] = order.map((s, i) => ({ id: s.info.id, place: i + 1, status: s.alive ? 'survived' : 'dead', score: s.coins, limbs: s.limbs }));
    ctx.finish(placements, { purchases });
    console.log('[round]', JSON.stringify({ elapsed: elapsed.toFixed(1), open: openFor().toFixed(1), reason: closeReason, purchases, shoppers: shoppers.map((s) => [s.info.name, s.brain?.p.kind, s.alive ? 'paid' : s.cause, s.offer?.id, s.bites, s.endAt.toFixed(1)]) }));
    const mine = purchases.find((p) => p.buyer === you.info.id);
    const victim = mine && shoppers.find((s) => s.info.id === mine.victim);
    const pool = you.alive ? (you.bites ? REMARKS.keptBitten : REMARKS.kept) : you.cause.startsWith('Bitten') ? REMARKS.bitten : you.cause.startsWith('Sold') ? REMARKS.stock : REMARKS.unpaid;
    hud.assessment({
      kicker: 'ASSESSMENT · INTERMISSION · THE MACHINE',
      subject: `SUBJECT ${tag(you)}`,
      verdict: you.alive ? 'RETAINED' : 'TERMINATED',
      lines: [
        ['PURCHASE', mine && victim ? `${OFFERS.find((o) => o.id === mine.offer)!.name} → ${tag(victim)}` : 'None'],
        ['BITES', `${you.bites}`],
        ['LIMBS', `${you.limbs.length} / 4`],
        ['CAUSE', you.alive ? 'None' : you.cause],
      ],
      remark: pool[rng.int(0, pool.length - 1)],
      table: order.map((s) => `${tag(s)} — ${s.alive ? 'RETAINED' : 'STOCKED'}${s.you ? ' (you)' : ''}`),
      fine: 'TRANSACTIONS SEALED UNTIL THE NEXT TRIAL',
    });
  }

  // ---------- paying

  function brainTick(s: Shopper) {
    const b = s.brain;
    if (!b || !s.alive || s.done || !s.arm || !s.offer || !s.victim) return;
    const p = b.p;
    if (alertAt > clearAt && b.seenAlert !== alertAt) {
      b.seenAlert = alertAt;
      b.react = rng.range(...p.react);
      b.heeding = rng.chance(Math.min(0.97, p.heed + s.bites * 0.25));
      b.keep = s.depth > 0.9 && s.offer.cost - s.paid <= 1 && rng.chance(p.greed);
    }
    if (!slotsOpen() || queue.some((e) => e.s === s)) {
      s.want = false;
      return;
    }
    const alertFor = phase === 'tell' && alertAt > clearAt ? elapsed - alertAt : -1;
    if (alertFor >= b.react && b.heeding && !b.keep) {
      s.want = false;
      return;
    }
    if (phase === 'tell') return;
    const since = elapsed - openSince;
    if (s.depth < 0.05) s.want = since >= p.delay * (1 + s.bites) && since < p.window * (s.bites ? 0.7 : 1);
    else if (p.kind === 'cautious' && since > p.window + 1.6) s.want = false;
  }

  function payTick(s: Shopper, dt: number) {
    if (!s.alive) return;
    const can = s.want && slotsOpen() && !s.done && !!s.arm && !!s.offer && !!s.victim;
    s.depth = can ? Math.min(1, s.depth + dt / INSERT) : Math.max(0, s.depth - dt / WITHDRAW);
    if (!can || s.depth < 1 || !s.offer) return;
    s.payT += dt;
    while (s.payT >= COIN_T && !s.done) {
      s.payT -= COIN_T;
      s.paid++;
      if (s.you) {
        sfx.coin();
        ctx.haptic('light');
      } else sfx.coin(0.35);
      if (s.paid >= s.offer.cost) complete(s);
    }
  }

  // ---------- first-person arms

  interface FpArm {
    side: 1 | -1;
    limb: Limb;
    group: THREE.Group;
    sleeve: THREE.Mesh;
    fist: THREE.Mesh;
    coin: THREE.Mesh;
    stump: THREE.Object3D;
    lostAt: number;
  }
  const sleeveMat = lam(0xffffff, { map: Tex.jumpsuit('#77705f', you.number) });
  const fistMat = lam(0xc4ae98);
  const coinMat = lam(0xc9a040, { emissive: 0x2a1c00 });
  const fpArms: FpArm[] = (['ra', 'la'] as Limb[]).map((limb) => {
    const side: 1 | -1 = limb === 'ra' ? 1 : -1;
    const group = new THREE.Group();
    scene.add(group);
    const sleeve = box(1, 1, 1, sleeveMat, group);
    const fist = box(0.06, 0.065, 0.085, fistMat, group);
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.005, 10), coinMat);
    coin.rotation.x = Math.PI / 2;
    coin.position.set(0, 0.012, 0.055);
    fist.add(coin);
    const stump = new THREE.Object3D();
    group.add(stump);
    group.visible = you.limbs.includes(limb);
    return { side, limb, group, sleeve, fist, coin, stump, lostAt: -1 };
  });
  const youMouth = you.station.mouth;

  function youSever(limb: Limb) {
    const a = fpArms.find((x) => x.limb === limb)!;
    a.lostAt = elapsed;
    gore.throwObject(a.fist, new THREE.Vector3(rand(-0.5, 0.5), rand(2, 2.8), rand(-1.6, -1.1)), new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), 0.05, 1.2);
    gore.spray(youMouth, new THREE.Vector3(0, 0.3, 1), 140, [1.5, 4], 0.35);
    gore.stump(a.stump, new THREE.Vector3(), new THREE.Vector3(-a.side * 0.2, 0.25, -1), 3.5, 1.6, 1);
    engine.lens.burst(0.5 + a.side * 0.15, 0.62, 0.9);
    engine.flash(0.45, 0xff3020);
    engine.shake(0.7);
    sound.ring(1.2);
    ctx.haptic('heavy');
    later(0.12, () => ctx.haptic('heavy'));
  }

  const tmp = new THREE.Vector3();
  function fpTick(t: number) {
    for (const a of fpArms) {
      if (!a.group.visible) continue;
      const active = you.arm === a.limb;
      const rest = new THREE.Vector3(a.side * 0.25, 1.3 + Math.sin(t * 1.4) * 0.005, 0.62);
      const front = youMouth.clone().add(new THREE.Vector3(a.side * 0.015, 0, 0.1));
      const inside = youMouth.clone().add(new THREE.Vector3(0, 0, -0.06));
      const d = active ? you.depth : 0;
      const hand = new THREE.Vector3();
      if (d < 0.5) hand.lerpVectors(rest, front, smooth(d / 0.5));
      else hand.lerpVectors(front, inside, smooth((d - 0.5) / 0.5));
      const shoulder = new THREE.Vector3(a.side * 0.3, 1.32, CAM.z + 0.08);
      if (a.lostAt >= 0) {
        const k = clamp((elapsed - a.lostAt) / 0.35, 0, 1);
        const stumpAt = rest.clone().add(new THREE.Vector3(a.side * 0.03, -0.04 - Math.max(0, elapsed - a.lostAt - 2.5) * 0.4, 0.12));
        hand.lerpVectors(youMouth.clone().add(new THREE.Vector3(0, 0, 0.12)), stumpAt, smooth(k));
        if (elapsed - a.lostAt > 4) a.group.visible = false;
      } else {
        a.fist.position.copy(hand);
        a.fist.lookAt(tmp.copy(hand).add(new THREE.Vector3(-a.side * 0.1, -0.05, -1)));
        a.coin.visible = active && !you.done && d > 0.05;
      }
      a.stump.position.copy(hand);
      a.sleeve.position.lerpVectors(hand, shoulder, 0.5);
      a.sleeve.lookAt(shoulder);
      a.sleeve.scale.set(0.07, 0.065, hand.distanceTo(shoulder) + 0.04);
    }
  }

  // ---------- input

  const pad = new TouchPad(ctx.surface, {
    down: () => {
      if (!you.alive || you.done || phase === 'intro') return;
      if (!you.offer || !you.victim) hud.setHint('PICK AN OFFER · PICK A VICTIM');
      else if (!you.arm) hud.setHint('NO HANDS.');
    },
  });
  if (auto) pad.enabled = false;
  if (!inApp())
    window.addEventListener('keydown', (e) => {
      if (phase === 'intro') return;
      const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (i >= 0) chooseOffer(OFFERS[i]);
      const v = ['Digit5', 'Digit6', 'Digit7'].indexOf(e.code);
      if (v >= 0) chooseVictim(shoppers[v + 1] ?? null);
      if (e.code === 'KeyB' && phase === 'idle') {
        snapNext = true;
        enter('tell');
      }
    });

  // ---------- camera and HUD per frame

  function cameraTick(dt: number, t: number) {
    if (youDeadAt >= 0) {
      const k = smooth(clamp((elapsed - youDeadAt) / 0.7, 0, 1));
      cam.position.set(lerp(CAM.x, 0.15, k), lerp(CAM.y - 0.1, 0.16, k), lerp(CAM.z, CAM.z - 0.25, k));
      cam.lookAt(lerp(0, -0.6, k), lerp(CAM.y + 1.2, 0.25, k), lerp(CAM.z - 0.5, -2.5, k));
      cam.rotateZ(-1.1 * k + Math.sin(elapsed * 30) * 0.05 * (1 - k));
      return;
    }
    if (youPressAt >= 0) {
      const k = smooth(clamp((elapsed - youPressAt) / 0.35, 0, 1));
      cam.position.set(CAM.x + rand(-0.003, 0.003), CAM.y - k * 0.05, CAM.z);
      cam.lookAt(0, lerp(LOOK.y, CAM.y + 3, k), lerp(LOOK.z, CAM.z - 0.6, k));
      if (Math.abs(cam.fov - 82) > 0.05) {
        cam.fov = damp(cam.fov, 82, 6, dt);
        cam.updateProjectionMatrix();
      }
      return;
    }
    glanceK = Math.max(0, glanceK - dt * 0.6);
    const reach = you.depth * 0.05;
    const sway = 0.006;
    cam.position.set(CAM.x + Math.sin(t * 0.7) * sway, CAM.y + Math.sin(t * 1.3) * sway * 0.6 - reach * 0.4, CAM.z + Math.sin(t * 0.5) * 0.004 - reach);
    const look = LOOK.clone();
    look.lerp(glance, smooth(Math.min(1, glanceK * 1.5)) * 0.4);
    look.y += Math.sin(t * 0.5) * 0.02;
    cam.lookAt(look);
    const tense = phase === 'tell' || phase === 'bite' || phase === 'exec';
    const fov = tense ? FOV - 7 : FOV;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, phase === 'bite' ? 12 : 4, dt);
      cam.updateProjectionMatrix();
    }
  }

  function hudTick(dt: number) {
    if (!finished && opened()) hud.setTimer(WINDOW - openFor());
    if (sayShown < sayFull.length) {
      sayShown = Math.min(sayFull.length, sayShown + dt * 60);
      sayEl.textContent = sayFull.slice(0, Math.ceil(sayShown));
    } else if ((sayHold -= dt) <= 0 && sayQ.length) sayNext();
    if (!you.alive || phase === 'intro' || phase === 'wake') hud.setStatus('', 'hidden');
    else if (phase === 'close') hud.setStatus('CLOSED', 'calm');
    else if (phase === 'exec') hud.setStatus(closing ? (closeReason === 'sold' ? 'SOLD OUT' : 'CLOSED') : 'COLLECTING', 'danger');
    else if (phase === 'bite') hud.setStatus('BITE', 'danger');
    else if (phase === 'tell') hud.setStatus('…', 'warn');
    else if (phase === 'digest') hud.setStatus('SLOT SHUT', 'calm');
    else if (you.done) hud.setStatus('PAID', 'calm');
    else hud.setStatus(you.depth > 0.5 ? 'PAYING' : 'SLOT OPEN', 'calm');
    const red = phase === 'bite' || phase === 'exec';
    engine.tint = damp(engine.tint, red ? 0.3 : phase === 'tell' ? 0.08 : 0, 8, dt);
    room.danger.intensity = engine.tint * 12;
    hudT += dt;
    if (hudT > 0.15) {
      hudT = 0;
      renderRoster();
      if (you.alive) renderReceipt();
      refreshShop();
    }
  }

  function chatterTick(dt: number) {
    if (phase !== 'idle' || closing) return;
    chatterT -= dt;
    if (chatterT > 0) return;
    chatterT = rand(7, 11);
    const browsing = shopping().filter((s) => s.depth < 0.1 && !s.you);
    if (browsing.length && Math.random() < 0.4) say(`I SEE YOU, SUBJECT ${num(browsing[Math.floor(Math.random() * browsing.length)])}.`);
    else say(CHATTER[Math.floor(Math.random() * CHATTER.length)]);
  }

  const down = new THREE.Vector3(0, -1, 0);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qt = new THREE.Quaternion();
  const eul = new THREE.Euler();
  /** Standing arms hang; the paying arm reaches into the podium mouth by `depth`. */
  function poseArms(s: Shopper, t: number) {
    const sub = s.subject!;
    sub.torso.updateWorldMatrix(true, false);
    sub.torso.getWorldQuaternion(qt).invert();
    for (const limb of ['ra', 'la'] as const) {
      const rig = sub.limbs[limb];
      if (!rig.attached) continue;
      const side = limb === 'ra' ? -1 : 1;
      qa.setFromEuler(eul.set(0.06 + Math.sin(t * 1.3 + side) * 0.03, 0, side * 0.1));
      const d = limb === s.arm ? s.depth : 0;
      if (d > 0) {
        const sh = rig.root.getWorldPosition(tmp);
        const dir = s.station.mouth.clone().sub(sh).normalize().applyQuaternion(qt);
        qb.setFromUnitVectors(down, dir);
        qa.slerp(qb, smooth(d));
      }
      rig.root.quaternion.copy(qa);
      rig.joint.rotation.set(-0.1 * (1 - d), 0, 0);
    }
  }

  hud.setTitle('INTERMISSION', 'THE MACHINE');
  hud.setPot(start.pot);
  hud.setLimbs(you.limbs);
  hud.setTimer(WINDOW);
  hud.setHint('PICK AN OFFER · PICK A VICTIM');
  void hud
    .intro('INTERMISSION', 'THE MACHINE', ['BUY SABOTAGE. <b>HOLD</b> YOUR HAND IN THE SLOT TO PAY.', '<b>LET GO</b> WHEN THE EYE TURNS RED. LAST TO PAY BECOMES STOCK.'])
    .then(() => {
      sound.unlock();
      sound.drone(true);
      sound.bpm = 92;
      sound.beat(true);
      buildShop();
      if (!auto) shop.classList.remove('mx-hide');
      for (const s of shoppers) if (s.brain) pickFor(s);
      enter('wake');
    });
  if (auto) document.querySelector<HTMLElement>('.overlay')?.dispatchEvent(new PointerEvent('pointerdown'));

  function step(dt: number, t: number) {
    if (phase !== 'intro') elapsed += dt;
    for (let i = timers.length - 1; i >= 0; i--) {
      if (elapsed < timers[i].at) continue;
      const f = timers[i].fn;
      timers.splice(i, 1);
      f();
    }
    machineTick(dt);
    if (!you.brain) you.want = pad.held && pad.enabled;
    for (const s of shoppers) brainTick(s);
    for (const s of shoppers) payTick(s, dt);
    endTick();
    chatterTick(dt);
    const led = phase === 'intro' || phase === 'wake' ? 0x101010 : phase === 'idle' ? 0x3cff6a : phase === 'tell' ? 0xffaa10 : 0xff2010;
    for (const s of shoppers) {
      s.station.podium.setLed(led);
      s.station.podium.update(dt);
      s.station.press.update(dt);
      const sub = s.subject;
      if (!sub) continue;
      if (s.alive) {
        sub.lookAt = phase === 'exec' && queue[0] && queue[0].s !== s ? (queue[0].s.subject?.headWorld() ?? cam.position) : !grabber.idle && grabber.ext > 0.2 ? grabber.handWorld() : s.depth > 0.5 ? s.station.mouth : EYE;
        sub.freeze = phase === 'tell' || phase === 'exec';
      }
      sub.update(dt, t);
      if (s.alive) poseArms(s, t);
      else {
        const k = clamp((elapsed - s.deadAt) / 0.28, 0, 1);
        sub.root.position.y = -0.55 * k * k;
      }
    }
    const tension = phase === 'tell' ? 0.6 + pt * 0.5 : phase === 'bite' || phase === 'exec' ? 1 : 0;
    machine.tension = damp(machine.tension, tension, 10, dt);
    if (phase !== 'exec' && phase !== 'close') {
      const payer = shoppers.find((s) => s.alive && s.depth > 0.5);
      machine.watch(payer ? payer.station.mouth : !grabber.idle ? grabber.handWorld() : cam.position);
    }
    sfx.humSet(machine.power, machine.tension);
    machine.update(dt, t);
    grabber.update(dt);
    for (const f of room.flickers) f.update(dt);
    room.shade.rotation.z = Math.sin(t * 0.8) * 0.03;
    gore.update(dt);
    fpTick(t);
    cameraTick(dt, t);
    hudTick(dt);
  }

  return {
    update(dt, t) {
      const ff = youDeadAt >= 0 && elapsed - youDeadAt > 2.5 && !finished ? 3 : 1;
      for (let i = 0; i < ff; i++) step(dt, t + i * dt);
    },
  };
};
