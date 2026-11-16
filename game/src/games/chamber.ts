import * as THREE from 'three';
import { sound } from '../shared/audio';
import { inApp } from '../shared/bridge';
import type { GameFactory } from '../shared/game';
import { Gore, type Surface, type Wall } from '../shared/gore';
import type { Placement, PlayerInfo } from '../shared/protocol';
import { Flicker } from '../shared/renderer';
import { Subject } from '../shared/rig';
import { blotches, canvasTex, speckle, Tex } from '../shared/textures';
import { clamp, damp, lerp, rand, smooth } from '../shared/util';

/*
 * LAST CHAMBER. One revolver, six chambers, a green felt table under a swinging lamp. On your turn
 * you PULL (survive and the chamber pays coins), PASS for 15c (the next subject faces the same
 * chamber), or TURN IT for 35c (point your chamber at the next subject instead). Every death reloads
 * the gun with one more round. Last one seated takes the pot.
 *
 * Determinism: ctx.rng is only consumed at discrete events (loading, each turn's bot decision), so the
 * round replays from the seed plus the ordered list of human actions, whatever the frame timing.
 */

const CHAMBERS = 6;
const START_COINS = 20;
const PASS_COST = 15;
const TURN_COST = 35;
/** Seconds a human holder gets before The Machine pulls for them. */
const DECIDE = 8;
/** After this many turns The Machine adds a round to speed things up. */
const SUDDEN_TURN = 16;
const TABLE_Y = 0.76;
const TABLE_R = 0.7;
const SEAT_R = 0.92;
const ROOM = { x: 2.4, z0: -2.7, z1: 1.9, h: 3.0 };
const CAM = new THREE.Vector3(0, 1.24, 0.84);
const SHOULDER = new THREE.Vector3(0.3, 0.86, 0.8);
/** Seat 0 is you (south, the camera). Turn order runs 0 → 1 (left) → 2 (across) → 3 (right). */
const SEAT_ANGLES = [Math.PI, -0.95, 0, 0.95];
const GUN_SCALE = 1.0;
const MUZZLE = new THREE.Vector3(0, 0.022, 0.19);
const GRIP = new THREE.Vector3(0, -0.045, -0.06);
const DOWN = new THREE.Vector3(0, -1, 0);

type Kind = 'gambler' | 'coward' | 'snake';
type Action = 'pull' | 'pass' | 'turn';
type Phase = 'intro' | 'load' | 'handoff' | 'decide' | 'pass' | 'aim' | 'cock' | 'hold' | 'after' | 'death' | 'finale' | 'over';

interface Personality {
  kind: Kind;
  /** Seconds spent staring at the gun before acting. */
  ponder: [number, number];
  /** Passes when the odds of dying reach this. */
  passAt: number;
  /** Turns the gun on the next subject when the odds reach this. */
  turnAt: number;
  /** Lowers turnAt when the next subject is the human. */
  spite: number;
  /** Chance of following through on a turn. */
  nerve: number;
  tremble: number;
  lines: Record<Action, string[]>;
}

const PERSONALITIES: Record<Kind, Personality> = {
  gambler: {
    kind: 'gambler',
    ponder: [0.45, 0.9],
    passAt: 0.55,
    turnAt: 0.6,
    spite: 0.1,
    nerve: 0.7,
    tremble: 0.15,
    lines: {
      pull: ['%s grins and pulls.', "%s doesn't even look.", '%s blows you a kiss.'],
      pass: ['%s passes. Boring.', '%s slides it on with a shrug.'],
      turn: ['%s turns it on %t. Why not.', '%s points it at %t, laughing.'],
    },
  },
  coward: {
    kind: 'coward',
    ponder: [1.2, 2.1],
    passAt: 0.2,
    turnAt: 0.45,
    spite: 0,
    nerve: 0.6,
    tremble: 1,
    lines: {
      pull: ['%s is crying.', '%s mutters a prayer.', "%s's hand won't stop shaking."],
      pass: ['%s pays to get rid of it.', '%s shoves it away, sobbing.'],
      turn: ['%s panics and turns it on %t.', '%s whispers "sorry" to %t.'],
    },
  },
  snake: {
    kind: 'snake',
    ponder: [0.9, 1.7],
    passAt: 0.32,
    turnAt: 0.3,
    spite: 0.12,
    nerve: 0.9,
    tremble: 0.3,
    lines: {
      pull: ['%s pulls without blinking.', '%s watches you while pulling.'],
      pass: ['%s passes it along with a smile.', '%s pays. %n inherits the chamber.'],
      turn: ['%s turns it on %t. Nothing personal.', '%s has been saving up for %t.'],
    },
  },
};

const BOT_POOL: PlayerInfo[] = [
  { id: 'bot-bruno', name: 'Bruno', hat: 'top', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
  { id: 'bot-maude', name: 'Maude', hat: 'bucket', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
  { id: 'bot-dex', name: 'Dex', hat: 'cone', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
  { id: 'bot-ivo', name: 'Ivo', hat: 'none', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
];

const REMARKS = {
  won: ['Outlasted the table. Retain for further testing.', 'Survived on luck and the misfortune of others. Both are acceptable.'],
  self: ['Pulled a live chamber. Contents distributed across the felt.', 'The odds were displayed. Subject pulled anyway.'],
  passed: ['Inherited a passed chamber. Unlucky. Unmourned.', 'Another subject paid 15 coins for this outcome. Market rate.'],
  shot: ['Shot by a fellow subject. Trust is not a survival trait.', 'Sold out for 35 coins. The Machine approves of commerce.'],
};

interface Seat {
  info: PlayerInfo;
  index: number;
  number: number;
  you: boolean;
  pos: THREE.Vector3;
  subject: Subject | null;
  arm: 'ra' | 'la' | null;
  kind: Kind | null;
  coins: number;
  alive: boolean;
  pulls: number;
  survived: number;
  passes: number;
  turns: number;
  diedAt: number;
  cause: string;
  causeKind: 'self' | 'passed' | 'shot' | '';
  hold: number;
  stack: THREE.InstancedMesh;
  stackShown: number;
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

function revolver() {
  const g = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0x5a5d62, emissive: 0x0e0e0e, flatShading: true });
  const dark = lam(0x18181a);
  const wood = lam(0xffffff, { map: Tex.wood() });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.012, 0.15, 8), steel);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.022, 0.115);
  barrel.castShadow = true;
  g.add(barrel);
  box(0.006, 0.006, 0.15, steel, g, 0, 0.034, 0.115);
  box(0.004, 0.009, 0.006, steel, g, 0, 0.039, 0.185);
  box(0.024, 0.05, 0.1, steel, g, 0, 0.012, 0.0);
  box(0.02, 0.01, 0.07, steel, g, 0, 0.041, 0.0);
  const drum = new THREE.Group();
  drum.position.set(0, 0.014, 0.012);
  g.add(drum);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.052, 12), steel);
  cyl.rotation.x = Math.PI / 2;
  cyl.castShadow = true;
  drum.add(cyl);
  const hole = new THREE.CylinderGeometry(0.0065, 0.0065, 0.006, 6);
  for (let i = 0; i < CHAMBERS; i++) {
    const a = (i / CHAMBERS) * Math.PI * 2;
    const m = new THREE.Mesh(hole, dark);
    m.rotation.x = Math.PI / 2;
    m.position.set(Math.cos(a) * 0.018, Math.sin(a) * 0.018, 0.025);
    drum.add(m);
    const flute = box(0.006, 0.004, 0.04, dark, drum, Math.cos(a + 0.52) * 0.029, Math.sin(a + 0.52) * 0.029, 0, false);
    flute.rotation.z = a + 0.52;
  }
  const hammer = new THREE.Group();
  hammer.position.set(0, 0.03, -0.048);
  g.add(hammer);
  box(0.008, 0.032, 0.012, steel, hammer, 0, 0.014, 0);
  box(0.012, 0.006, 0.016, dark, hammer, 0, 0.03, -0.006);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.003, 4, 10, Math.PI), steel);
  guard.rotation.set(0, Math.PI / 2, Math.PI);
  guard.position.set(0, -0.016, 0.004);
  g.add(guard);
  box(0.004, 0.018, 0.006, steel, g, 0, -0.02, 0.0);
  const grip = box(0.026, 0.09, 0.038, wood, g, 0, -0.045, -0.062);
  grip.rotation.x = 0.35;
  g.scale.setScalar(GUN_SCALE);
  return { g, drum, hammer };
}

function feltTex() {
  return canvasTex(
    64,
    64,
    (g, w, h) => {
      g.fillStyle = '#1d3a25';
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, ['#122a19', '#2a4d33', '#0b1a10'], 700, 2);
      blotches(g, w, h, '#09140c', 10, 4, 16, 0.1, 0.3);
      blotches(g, w, h, '#3a2a14', 3, 3, 8, 0.1, 0.25);
    },
    [3, 3],
  );
}

function billTex() {
  return canvasTex(32, 16, (g, w, h) => {
    g.fillStyle = '#5f6a4a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#3b4430';
    g.fillRect(2, 2, w - 4, h - 4);
    g.fillStyle = '#8a8f6a';
    g.fillRect(12, 4, 8, 8);
    g.fillStyle = '#d8d0b0';
    g.fillRect(14, 0, 4, h);
  });
}

function neonSign(text: string, color: string) {
  const tex = canvasTex(256, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(22, 50);
    g.lineTo(38, 14);
    g.lineTo(54, 50);
    g.closePath();
    g.stroke();
    g.fillRect(37, 26, 2, 12);
    g.fillRect(37, 42, 2, 3);
    g.font = 'bold 21px monospace';
    g.textBaseline = 'middle';
    g.fillText(text, 66, 33);
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.375), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false }));
}

/** A pendulum lamp: cord, shade, bulb and a shadow-casting spot that swings with it. */
class Lamp {
  readonly pivot = new THREE.Group();
  readonly light: THREE.SpotLight;
  readonly bulb: THREE.MeshBasicMaterial;
  private ax = 0.12;
  private az = 0;
  private vx = 0;
  private vz = 0.18;
  private readonly len = 1.05;
  /** Swing the lamp keeps up on its own (radians). */
  amp = 0.12;

  constructor(scene: THREE.Scene) {
    this.pivot.position.set(0, ROOM.h, 0);
    scene.add(this.pivot);
    box(0.01, this.len - 0.1, 0.01, lam(0x111111), this.pivot, 0, -(this.len - 0.1) / 2, 0, false);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.18, 8, 1, true), new THREE.MeshLambertMaterial({ color: 0x3a3832, emissive: 0x0a0806, side: THREE.DoubleSide }));
    shade.position.y = -this.len + 0.06;
    this.pivot.add(shade);
    this.bulb = new THREE.MeshBasicMaterial({ color: 0xffe2b0, fog: false });
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), this.bulb);
    bulb.position.y = -this.len;
    this.pivot.add(bulb);
    this.light = new THREE.SpotLight(0xffd2a0, 26, 7, 0.95, 0.5, 1.25);
    this.light.position.y = -this.len;
    this.light.target.position.set(0, -3, 0);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(512, 512);
    this.light.shadow.bias = -0.002;
    this.pivot.add(this.light, this.light.target);
  }

  kick(power: number) {
    this.vx += rand(-1, 1) * power;
    this.vz += rand(-1, 1) * power;
  }

  update(dt: number) {
    const g = 9.8 / this.len;
    this.vx += (-g * Math.sin(this.ax) - this.vx * 0.12) * dt;
    this.vz += (-g * Math.sin(this.az) - this.vz * 0.12) * dt;
    const e = Math.hypot(this.ax, this.vx / Math.sqrt(g)) + Math.hypot(this.az, this.vz / Math.sqrt(g)) * 0.5;
    if (e < this.amp) {
      this.vx += Math.sign(this.vx || 1) * 0.25 * dt;
      this.vz += Math.sign(this.vz || 1) * 0.1 * dt;
    }
    this.ax += this.vx * dt;
    this.az += this.vz * dt;
    this.pivot.rotation.set(this.ax, 0, this.az);
  }
}

function buildRoom(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x040303);
  scene.fog = new THREE.FogExp2(0x060505, 0.2);
  const W = ROOM.x * 2, D = ROOM.z1 - ROOM.z0, cz = (ROOM.z1 + ROOM.z0) / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0xffffff, { map: Tex.floor([W, D]) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = cz;
  floor.receiveShadow = true;
  scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0x151311));
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
  box(0.02, 0.22, D, haz, scene, -ROOM.x + 0.011, 0.11, cz, false);
  box(0.02, 0.22, D, haz, scene, ROOM.x - 0.011, 0.11, cz, false);
  box(W, 0.22, 0.02, lam(0xffffff, { map: Tex.hazard([W * 2, 1]) }), scene, 0, 0.11, ROOM.z0 + 0.011, false);
  const rust = lam(0xffffff, { map: Tex.rust([6, 1]) });
  for (const [y, r] of [[2.35, 0.07], [2.55, 0.045]] as const) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, W, 8), rust);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, y, ROOM.z0 + 0.14);
    scene.add(pipe);
  }
  for (const x of [-1.6, 1.3]) {
    const v = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, ROOM.h, 8), rust);
    v.position.set(x, ROOM.h / 2, ROOM.z0 + 0.12);
    scene.add(v);
  }
  const metal = lam(0xffffff, { map: Tex.metal() });
  box(1.0, 2.1, 0.06, metal, scene, 1.25, 1.05, ROOM.z0 + 0.03);
  box(0.08, 2.2, 0.07, rust, scene, 0.71, 1.1, ROOM.z0 + 0.035);
  box(0.08, 2.2, 0.07, rust, scene, 1.79, 1.1, ROOM.z0 + 0.035);
  box(0.06, 1.6, 1.4, metal, scene, -ROOM.x + 0.03, 0.8, -0.6);
  const sign = neonSign('ONE LEAVES', '#ff5a3a');
  sign.position.set(-0.55, 2.0, ROOM.z0 + 0.02);
  scene.add(sign);
  const signLight = new THREE.PointLight(0xff4a2a, 1.6, 4.5, 1.4);
  signLight.position.set(-0.55, 1.9, ROOM.z0 + 0.5);
  scene.add(signLight);

  const felt = lam(0xffffff, { map: feltTex() });
  const top = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_R, TABLE_R, 0.05, 24), felt);
  top.position.y = TABLE_Y - 0.025;
  top.receiveShadow = true;
  top.castShadow = true;
  scene.add(top);
  const woodDark = lam(0x2a1a10);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(TABLE_R, 0.035, 5, 24), woodDark);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = TABLE_Y - 0.01;
  rim.castShadow = true;
  scene.add(rim);
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.26, TABLE_Y - 0.05, 8), woodDark);
  ped.position.y = (TABLE_Y - 0.05) / 2;
  scene.add(ped);

  scene.add(new THREE.HemisphereLight(0x3d352d, 0x080606, 0.6));
  const lamp = new Lamp(scene);
  const tube = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.04), new THREE.MeshBasicMaterial({ color: 0xcfe0ff, fog: false }));
  tube.position.set(0.9, 2.65, ROOM.z0 + 0.06);
  scene.add(tube);
  const cold = new THREE.PointLight(0x9fb8ff, 2.4, 4.5, 1.4);
  cold.position.set(0.9, 2.5, ROOM.z0 + 0.4);
  scene.add(cold);
  const fill = new THREE.PointLight(0xffc89a, 0.9, 1.6, 1.5);
  fill.position.set(0.2, 1.3, 0.6);
  scene.add(fill);
  const bounce = new THREE.PointLight(0xcfb890, 1.6, 2.2, 1.4);
  bounce.position.set(0, TABLE_Y + 0.3, 0);
  scene.add(bounce);
  const danger = new THREE.PointLight(0xff2010, 0, 6, 1.2);
  danger.position.set(0, 2.2, -0.5);
  scene.add(danger);
  const flickers = [new Flicker(lamp.light, lamp.bulb, lamp.light.intensity, 0.25), new Flicker(cold, tube.material as THREE.MeshBasicMaterial, cold.intensity, 1.4)];

  const inner = TABLE_R * 0.72;
  const surfaces: Surface[] = [
    { y: TABLE_Y, x0: -inner, x1: inner, z0: -inner, z1: inner },
    { y: TABLE_Y, x0: -TABLE_R + 0.03, x1: TABLE_R - 0.03, z0: -0.3, z1: 0.3 },
    { y: TABLE_Y, x0: -0.3, x1: 0.3, z0: -TABLE_R + 0.03, z1: TABLE_R - 0.03 },
    { y: 0, x0: -ROOM.x, x1: ROOM.x, z0: ROOM.z0, z1: ROOM.z1 },
  ];
  const walls: Wall[] = [
    { axis: 'x', at: -ROOM.x, normal: 1 },
    { axis: 'x', at: ROOM.x, normal: -1 },
    { axis: 'z', at: ROOM.z0, normal: 1 },
    { axis: 'z', at: ROOM.z1, normal: -1 },
  ];
  return { surfaces, walls, lamp, flickers, danger, metal, rust };
}

const CSS = `
.lc-cyl { position:absolute; right:12px; top:calc(env(safe-area-inset-top) + 58px); width:108px; text-align:center; transform-origin:50% 0; transition:transform .45s cubic-bezier(.2,.9,.3,1), opacity .4s; }
.lc-cyl.big { transform:translate(calc(-50vw + 66px), 16vh) scale(2.1); }
.lc-cyl svg { width:84px; height:84px; display:block; margin:0 auto; overflow:visible; }
.lc-cyl .idx { transition:transform .3s cubic-bezier(.3,1.5,.5,1); }
.lc-cyl .spin { animation:lcspin 1.5s cubic-bezier(.12,.6,.2,1); }
@keyframes lcspin { from { transform:rotate(0); } to { transform:rotate(1500deg); } }
.lc-cyl .ch { fill:#1a1714; stroke:#6b6253; stroke-width:2; }
.lc-cyl .ch.spent { fill:#070606; stroke:#2e2923; }
.lc-cyl .ch.live { fill:#c9a24a; stroke:#f2d28a; }
.lc-cyl .ch.now { stroke:#ff3b2a; stroke-width:4; }
.lc-cyl .body { fill:#0d0b0a; stroke:#4a4236; stroke-width:2; }
.lc-cyl .ptr { fill:#ff3b2a; }
.lc-cyl .x { stroke:#4a4236; stroke-width:2; }
.lc-cyl .odds b { display:block; font-size:22px; font-weight:900; letter-spacing:1px; text-shadow:0 2px 0 #000; margin-top:2px; }
.lc-cyl .odds span { font-size:12px; font-weight:800; letter-spacing:2px; text-shadow:0 1px 0 #000; }
.lc-cyl .face { font-size:9px; letter-spacing:2px; color:#b5aa92; margin-top:3px; text-shadow:0 1px 0 #000; background:rgba(0,0,0,.45); padding:2px 0; }
.lc-panel { position:absolute; left:12px; right:12px; bottom:calc(env(safe-area-inset-bottom) + 12px); display:grid; gap:8px; pointer-events:auto; transition:opacity .25s, transform .25s; }
.lc-panel.wait { opacity:.45; }
.lc-panel.gone { opacity:0; transform:translateY(24px); pointer-events:none; }
.lc-info { display:flex; justify-content:space-between; align-items:baseline; font-size:10px; letter-spacing:2px; color:#9a8f78; text-shadow:0 1px 0 #000; }
.lc-info b { color:#f2c14a; font-size:20px; letter-spacing:1px; margin-left:6px; }
.lc-clock { height:4px; background:#2a241c; }
.lc-clock i { display:block; height:100%; width:100%; background:#ff3b2a; }
.lc-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.lc-panel button { font:inherit; color:#e6dcc6; background:rgba(22,18,15,.92); border:1px solid #5a4d40; padding:10px 6px; font-weight:900; letter-spacing:3px; font-size:15px; touch-action:manipulation; -webkit-appearance:none; border-radius:0; }
.lc-panel button small { display:block; font-size:9px; letter-spacing:1px; color:#a3967f; font-weight:600; margin-top:3px; }
.lc-panel button.turn { border-color:#8a6a1a; }
.lc-panel button.turn small { color:#f2c14a; }
.lc-panel button.pull { background:#a50f0c; border-color:#ff3b2a; font-size:30px; letter-spacing:10px; padding:16px 6px; }
.lc-panel button:disabled { opacity:.28; }
.lc-panel button:active:not(:disabled) { transform:scale(.97); }
.lc-big { position:absolute; left:0; right:0; top:40%; text-align:center; font-size:54px; font-weight:900; letter-spacing:6px; opacity:0; pointer-events:none; text-shadow:0 3px 0 #000; }
.lc-big.go { animation:lcbig 1.1s ease-out forwards; }
.lc-big.click { color:#d8cfb8; }
.lc-big.bang { color:#ff2a1a; font-size:86px; }
.lc-big.info { color:#f2c14a; font-size:26px; letter-spacing:4px; }
@keyframes lcbig { 0% { opacity:0; transform:scale(1.7); } 10% { opacity:1; transform:scale(1); } 70% { opacity:1; } 100% { opacity:0; transform:scale(.96); } }
.lc-fade { position:absolute; inset:0; background:#000; opacity:0; pointer-events:none; }
.lc-win { position:absolute; left:16px; right:16px; top:33%; text-align:center; opacity:0; transform:scale(1.4); transition:opacity .3s, transform .6s cubic-bezier(.2,1.5,.4,1); pointer-events:none; }
.lc-win.in { opacity:1; transform:scale(1); }
.lc-win small { display:block; font-size:11px; letter-spacing:5px; color:#b5aa92; text-shadow:0 1px 0 #000; }
.lc-win b { display:block; font-size:30px; letter-spacing:4px; font-weight:900; color:#f2c14a; text-shadow:0 3px 0 #000; margin:8px 0 4px; }
.lc-win span { font-size:52px; font-weight:900; color:#9fd08a; letter-spacing:2px; text-shadow:0 3px 0 #000; }
.lc-win.lost b { color:#ff3b2a; }
`;

export const createChamber: GameFactory = (ctx) => {
  const { engine, hud, rng, start } = ctx;
  const scene = engine.scene;
  const room = buildRoom(scene);
  const gore = new Gore(engine, room.surfaces, room.walls, { onImpact: (v) => sound.splat(v) });
  const cam = engine.camera;
  cam.fov = 74;
  cam.updateProjectionMatrix();
  const { g: gun, drum, hammer } = revolver();
  scene.add(gun);
  const auto = new URLSearchParams(location.search).has('auto');
  const pot = start.pot ?? 40;

  const me = start.players.find((p) => p.id === start.you) ?? start.players[0];
  const table: PlayerInfo[] = start.players.slice(0, 4);
  for (const b of BOT_POOL) if (table.length < 4 && !table.some((p) => p.id === b.id || p.name === b.name)) table.push(b);
  /** Seat 0 is the camera. Seats keep the table's turn order, rotated so you sit at 0. */
  const shift = Math.max(0, table.indexOf(me));
  const roster = table.map((_, i) => table[(i + shift) % table.length]);
  const seatOf = (n: number) => (n - shift + table.length) % table.length;
  /** Bot brains play the bots, and the other humans too when there is no server to sync with. */
  const net = ctx.net;
  const brains = table.filter((p) => p.isBot || (!net && p !== me));
  /** Online: every human choice goes through the server, keyed by turn number, so all phones agree. */
  const decided = new Map<number, Action>();
  const proposed = new Set<number>();
  net?.on((view) => {
    for (const [k, a] of Object.entries((view as { actions?: Record<string, Action> }).actions ?? {})) decided.set(Number(k), a);
  });
  const seated = start.players.some((p) => p.id === start.you);
  const purchases = start.purchases ?? [];
  const on = (offer: string, id: string) => purchases.filter((p) => p.offer === offer && p.victim === id).length;
  /** One More Round still owed to each victim's next turn. */
  const owed = new Map(table.map((p) => [p.id, on('one_more_round', p.id)]));

  const numbers = new Set<number>();
  const numberFor = () => {
    let n = rng.int(1, 99);
    while (numbers.has(n)) n = (n % 99) + 1;
    numbers.add(n);
    return n;
  };
  const kinds: Kind[] = ['gambler', 'coward', 'snake'];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  const numberOf = new Map(table.map((p) => [p.id, numberFor()]));

  const coinGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.007, 8);
  const coinMat = lam(0xb08a3a, { emissive: 0x1a1204 });
  const chair = (pos: THREE.Vector3) => {
    const g = new THREE.Group();
    g.position.set(pos.x * 1.04, 0, pos.z * 1.04);
    g.rotation.y = Math.atan2(-pos.x, -pos.z);
    box(0.42, 0.04, 0.42, room.metal, g, 0, 0.45, 0);
    box(0.42, 0.5, 0.04, room.metal, g, 0, 0.72, -0.2);
    for (const sx of [-0.18, 0.18]) for (const sz of [-0.18, 0.18]) box(0.03, 0.45, 0.03, room.rust, g, sx, 0.225, sz);
    scene.add(g);
  };

  const seats: Seat[] = roster.map((info, i) => {
    const a = SEAT_ANGLES[i];
    const pos = new THREE.Vector3(Math.sin(a) * SEAT_R, 0, -Math.cos(a) * SEAT_R);
    const you = i === 0;
    const number = numberOf.get(info.id)!;
    let subject: Subject | null = null;
    let arm: Seat['arm'] = null;
    if (!you) {
      subject = new Subject({ number, hat: info.hat, limbs: info.limbs });
      subject.root.position.copy(pos);
      subject.root.rotation.y = Math.atan2(-pos.x, -pos.z);
      scene.add(subject.root);
      arm = subject.limbs.ra.attached ? 'ra' : subject.limbs.la.attached ? 'la' : null;
    }
    chair(pos);
    const stack = new THREE.InstancedMesh(coinGeo, coinMat, 24);
    stack.castShadow = true;
    stack.count = 0;
    scene.add(stack);
    const kind: Kind | null = brains.includes(info) ? kinds[brains.indexOf(info) % 3] : you && auto ? 'snake' : null;
    return { info, index: i, number, you, pos, subject, arm, kind, coins: START_COINS, alive: true, pulls: 0, survived: 0, passes: 0, turns: 0, diedAt: 0, cause: '', causeKind: '', hold: 0, stack, stackShown: -1 };
  });
  const you = seats[0];
  const tag = (s: Seat) => `#${String(s.number).padStart(2, '0')} ${s.info.name.toUpperCase()}`;
  const nameOf = (s: Seat) => (s.you ? 'YOU' : s.info.name.toUpperCase());

  const potGroup = new THREE.Group();
  const billMat = lam(0xffffff, { map: billTex() });
  for (let i = 0; i < 5; i++) {
    const b = box(0.15, 0.03, 0.07, billMat, potGroup, (i % 2) * 0.03 - 0.015, 0.015 + Math.floor(i / 2) * 0.031, (i % 3) * 0.012);
    b.rotation.y = (i - 2) * 0.12;
  }
  potGroup.position.set(0.05, TABLE_Y, -0.22);
  scene.add(potGroup);

  const sleeve = box(1, 1, 1, lam(0xffffff, { map: Tex.jumpsuit('#77705f', 0) }), scene, 0, 0, 0, false);
  const fist = box(0.06, 0.07, 0.08, lam(0xc4ae98), scene, 0, 0, 0, false);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const el = (tagName: string, cls: string, parent: HTMLElement, html = '') => {
    const e = document.createElement(tagName);
    e.className = cls;
    e.innerHTML = html;
    parent.appendChild(e);
    return e;
  };
  const fade = document.createElement('div');
  fade.className = 'lc-fade';
  ctx.surface.insertBefore(fade, hud.root);
  const cylEl = el('div', 'lc-cyl', hud.root);
  const bigEl = el('div', 'lc-big', hud.root);
  const winEl = el('div', 'lc-win', hud.root);
  const panel = el('div', 'lc-panel wait', hud.root);
  const info = el('div', 'lc-info', panel, '<span>COINS<b>20c</b></span>');
  const clock = el('div', 'lc-clock', panel, '<i></i>');
  const row = el('div', 'lc-row', panel);
  const passBtn = el('button', 'pass', row, `PASS<small>${PASS_COST}c</small>`) as HTMLButtonElement;
  const turnBtn = el('button', 'turn', row, `TURN IT<small>${TURN_COST}c</small>`) as HTMLButtonElement;
  const pullBtn = el('button', 'pull', panel, 'PULL') as HTMLButtonElement;
  const coinsEl = info.querySelector('b')!;
  const clockBar = clock.querySelector('i') as HTMLElement;

  let phase: Phase = 'intro';
  let pt = 0;
  let dur = 0;
  let elapsed = 0;
  let chambers: boolean[] = [];
  let idx = 0;
  let bullets = 1;
  let deaths = 0;
  let turnNo = 0;
  let sudden = false;
  let holder = 0;
  let queued = 0;
  let nextHolder = 0;
  let target = -1;
  let action: Action | null = null;
  let planned: Action = 'pull';
  let ponder = 1;
  let passedFrom: Seat | null = null;
  let victim: Seat | null = null;
  let winner: Seat | null = null;
  let finished = false;
  let forceBang = false;
  let youDeadAt = -1;
  let gunYaw = 0;
  let spinFrom = 0;
  let spinTo = 0;
  let spinAt = -1;
  let drumAngle = 0;
  let drumTarget = 0;
  let hammerTarget = 0;
  let showLive = false;
  let beatT = 0;
  const glance = new THREE.Vector3();
  let glanceK = 0;
  const camLook = new THREE.Vector3(0, TABLE_Y, 0);

  const aliveSeats = () => seats.filter((s) => s.alive);
  const nextAlive = (i: number) => {
    for (let k = 1; k <= seats.length; k++) {
      const j = (i + k) % seats.length;
      if (seats[j].alive && j !== i) return j;
    }
    return i;
  };
  const bulletsLeft = () => chambers.slice(idx).filter(Boolean).length;
  const risk = () => bulletsLeft() / (CHAMBERS - idx);
  const yawTo = (s: Seat) => Math.atan2(s.pos.x, s.pos.z);
  const duel = () => aliveSeats().length === 2;
  /** Seconds a human holder gets; Short Fuse takes 3 s off per purchase. */
  const limit = (s: Seat) => Math.max(2, DECIDE - 3 * on('short_fuse', s.info.id));

  /** Asks the server to record this turn's choice; it comes back through `decided`. */
  function propose(a: Action) {
    if (!net || proposed.has(turnNo)) return;
    proposed.add(turnNo);
    net.send({ kind: 'act', turn: turnNo, action: a });
  }

  function choose(a: Action) {
    if (phase !== 'decide' || !seats[holder].you || you.kind) return;
    if (a === 'pass' && you.coins < PASS_COST) return;
    if (a === 'turn' && you.coins < TURN_COST) return;
    if (!net) act(a);
    else if (seated) propose(a);
  }

  function enter(p: Phase, d = 0) {
    phase = p;
    pt = 0;
    dur = d;
  }

  function big(text: string, cls: 'click' | 'bang' | 'info') {
    bigEl.textContent = text;
    bigEl.className = 'lc-big';
    void bigEl.offsetWidth;
    bigEl.className = `lc-big go ${cls}`;
  }

  function line(s: Seat, a: Action, t?: Seat) {
    if (!s.kind || s.you) return;
    const pool = PERSONALITIES[s.kind].lines[a];
    const n = seats[nextAlive(s.index)];
    hud.feed(
      pool[Math.floor(rand(0, pool.length))]
        .replace('%s', `<b>${tag(s)}</b>`)
        .replace('%t', t ? `<b>${t.you ? 'YOU' : tag(t)}</b>` : '')
        .replace('%n', `<b>${n.you ? 'You' : tag(n)}</b>`),
    );
  }

  function reload() {
    bullets = Math.min(CHAMBERS - 1, 1 + deaths + (sudden ? 1 : 0));
    chambers = new Array(CHAMBERS).fill(false);
    let placed = 0;
    while (placed < bullets) {
      const k = rng.int(0, CHAMBERS - 1);
      if (!chambers[k]) {
        chambers[k] = true;
        placed++;
      }
    }
    idx = 0;
    action = null;
    passedFrom = null;
    spinAt = -1;
    showLive = true;
    cylEl.classList.add('big');
    enter('load');
  }

  function decide(s: Seat): Action {
    const p = PERSONALITIES[s.kind!];
    const r = risk();
    const j = rng.range(-0.05, 0.05);
    const next = seats[nextAlive(s.index)];
    const canPass = s.coins >= PASS_COST, canTurn = s.coins >= TURN_COST;
    const turnAt = p.turnAt - (next.you ? p.spite : 0) - (duel() ? 0.1 : 0);
    if (canTurn && r + j >= turnAt && rng.chance(p.nerve)) return 'turn';
    if (canPass && r + j >= p.passAt && rng.chance(0.9)) return 'pass';
    if (r > 0.99) return canTurn ? 'turn' : canPass ? 'pass' : 'pull';
    return 'pull';
  }

  function startTurn(i: number, from: Seat | null = null) {
    turnNo++;
    if (!sudden && turnNo > SUDDEN_TURN) {
      sudden = true;
      const empty = chambers.map((c, k) => (!c && k >= idx ? k : -1)).filter((k) => k >= 0);
      if (empty.length > 1) {
        chambers[empty[rng.int(0, empty.length - 1)]] = true;
        bullets++;
      }
      big('+1 ROUND', 'info');
      sound.sting();
    }
    holder = i;
    passedFrom = from;
    action = null;
    target = -1;
    const s = seats[i];
    const extra = owed.get(s.info.id) ?? 0;
    if (extra > 0) {
      owed.set(s.info.id, extra - 1);
      const empty = chambers.map((c, k) => (!c && k >= idx ? k : -1)).filter((k) => k >= 0);
      if (empty.length > 1) {
        chambers[empty[rng.int(0, empty.length - 1)]] = true;
        bullets++;
        big('+1 ROUND', 'info');
        sound.sting();
      }
    }
    if (s.kind) {
      planned = decide(s);
      ponder = rng.range(...PERSONALITIES[s.kind].ponder) * (0.7 + risk());
    }
    sound.slide();
    enter('handoff', 0.75);
  }

  function act(a: Action) {
    if (phase !== 'decide') return;
    const s = seats[holder];
    if (a === 'pass' && s.coins < PASS_COST) return;
    if (a === 'turn' && s.coins < TURN_COST) return;
    action = a;
    if (s.you) ctx.haptic('light');
    if (a === 'pass') {
      s.coins -= PASS_COST;
      s.passes++;
      nextHolder = nextAlive(holder);
      line(s, 'pass');
      if (seats[nextHolder].you) big('YOUR PROBLEM NOW', 'info');
      sound.coins(3);
      enter('pass', 0.75);
      return;
    }
    if (a === 'turn') {
      s.coins -= TURN_COST;
      s.turns++;
      target = nextAlive(holder);
      line(s, 'turn', seats[target]);
      if (seats[target].you) big('ON YOU', 'bang');
      sound.coins(5);
      sound.sting();
      enter('aim', 0.8);
      return;
    }
    s.pulls++;
    if (Math.random() < 0.25) line(s, 'pull');
    cock();
  }

  function cock() {
    sound.cock();
    hammerTarget = -0.9;
    drumTarget += Math.PI / 3;
    if (seats[holder].you || seats[target]?.you) ctx.haptic('light');
    enter('cock', 0.45);
  }

  function resolve() {
    hammerTarget = 0;
    const shooter = seats[holder];
    const v = action === 'turn' ? seats[target] : shooter;
    const live = chambers[idx] || forceBang;
    forceBang = false;
    if (live) {
      chambers[idx] = true;
      bang(shooter, v);
      return;
    }
    const pay = Math.round(risk() * 60);
    sound.click();
    idx++;
    big('click.', 'click');
    if (action === 'pull') {
      shooter.survived++;
      shooter.coins += pay;
      sound.coins(Math.max(2, Math.round(pay / 6)));
      if (shooter.you) {
        hud.feed(`<b>+${pay}c</b>`);
        ctx.haptic('light');
      }
      shooter.subject?.flinch(rand(-1, 1));
      nextHolder = nextAlive(holder);
    } else {
      v.subject?.flinch(rand(-1, 1));
      if (v.you) ctx.haptic('heavy');
      nextHolder = target;
    }
    enter('after', 0.85);
  }

  function bang(shooter: Seat, v: Seat) {
    const last = aliveSeats().length === 2;
    const muzzle = gun.localToWorld(MUZZLE.clone());
    const at = v.you ? cam.position.clone() : v.subject!.headWorld();
    const dir = at.clone().sub(muzzle).normalize();
    gore.muzzleFlash(muzzle, dir);
    sound.gunshot();
    engine.flash(last ? 0.45 : 0.28);
    engine.slowmo(last ? 1.6 : 0.8, last ? 0.14 : 0.22);
    room.lamp.kick(last ? 2.2 : 1.2);
    big('BANG', 'bang');
    v.alive = false;
    v.diedAt = elapsed;
    deaths++;
    victim = v;
    if (v !== shooter) {
      v.cause = `Shot by ${tag(shooter)}`;
      v.causeKind = 'shot';
    } else if (passedFrom) {
      v.cause = `Faced the chamber ${tag(passedFrom)} passed`;
      v.causeKind = 'passed';
    } else {
      v.cause = `Pulled a live chamber (${idx + 1} of ${CHAMBERS})`;
      v.causeKind = 'self';
    }
    ctx.death(v.info.id, v.cause);
    queued = nextAlive(v.index);
    for (const o of seats) if (o !== v && o.alive) o.subject?.flinch(o.pos.x - at.x);
    if (v.you) {
      youDeadAt = elapsed;
      engine.lens.cover();
      engine.flash(1, 0xff4020);
      engine.shake(1);
      sound.crunch(1.5);
      sound.squelch(1.5);
      sound.ring(5);
      sound.muffle(0.8);
      hud.stamp('TERMINATED');
      panel.className = 'lc-panel gone';
      fist.visible = sleeve.visible = false;
      enter('death', 3.6);
      return;
    }
    const s = v.subject!;
    s.explodeHead(gore, dir);
    gore.spray(at, dir, 140, [3, 9], 0.22, [0.012, 0.03]);
    for (let i = 0; i < 3; i++) gore.gib('brain', at, dir.clone().multiplyScalar(rand(1.5, 3.5)).add(new THREE.Vector3(rand(-0.6, 0.6), rand(0.5, 1.5), rand(-0.6, 0.6))), 1.3);
    s.die(v === shooter ? 'slump' : 'fall');
    sound.crunch(last ? 1.5 : 1.1);
    sound.squelch(last ? 1.5 : 1.1);
    ctx.haptic('heavy');
    const dist = at.distanceTo(cam.position);
    engine.shake((last ? 0.5 : 0.3) + Math.max(0, 2.8 - dist) * 0.2);
    if (dist < 3.2) {
      const ndc = at.clone().project(cam);
      engine.lens.burst(clamp((ndc.x + 1) / 2, 0.15, 0.85), clamp((1 - ndc.y) / 2, 0.2, 0.7), ((3.2 - dist) / 1.6) * (v === shooter ? 0.7 : 1));
      sound.ring(1.5);
    }
    glance.copy(at);
    glanceK = 1;
    const neck = s.neck;
    setTimeout(() => gore.pool(new THREE.Vector3().setFromMatrixPosition(neck.matrixWorld).multiplyScalar(0.85).setY(TABLE_Y), 0.3), 900);
    hud.feed(`<b>${tag(v)}</b> TERMINATED`);
    enter('death', last ? 3.2 : 2.4);
  }

  function enterFinale() {
    winner = aliveSeats()[0];
    enter('finale', 6.2);
    sound.beat(false);
    sound.intensity = 0.2;
    sound.sting();
    room.lamp.amp = 0.03;
    panel.className = 'lc-panel gone';
    cylEl.style.opacity = '0';
    hud.root.querySelectorAll('.stamp').forEach((e) => e.remove());
    winEl.className = 'lc-win' + (winner.you ? '' : ' lost');
    winEl.innerHTML = `<small>LAST ONE SEATED</small><b>${winner.you ? 'YOU TAKE THE POT' : `${tag(winner)} TAKES THE POT`}</b><span>$${pot}</span>`;
  }

  function finish() {
    finished = true;
    phase = 'over';
    const dead = seats.filter((s) => !s.alive).sort((a, b) => b.diedAt - a.diedAt);
    const order = [...seats.filter((s) => s.alive), ...dead];
    const placements: Placement[] = order.map((s, i) => ({ id: s.info.id, place: i + 1, status: s.alive ? 'survived' : 'dead', score: s.coins }));
    ctx.finish(placements);
    const perf = engine.perf();
    console.log('[round]', JSON.stringify({ perf, seed: start.seed, elapsed: elapsed.toFixed(1), turns: turnNo, seats: seats.map((s) => [s.info.name, s.kind, s.alive ? 'won' : s.cause, s.coins, s.pulls, s.passes, s.turns, s.diedAt.toFixed(1)]) }));
    winEl.className = 'lc-win';
    const pool = you.alive ? REMARKS.won : REMARKS[you.causeKind || 'self'];
    hud.assessment({
      kicker: 'ASSESSMENT · LAST CHAMBER',
      subject: `SUBJECT ${tag(you)}`,
      verdict: you.alive ? 'RETAINED' : 'TERMINATED',
      lines: [
        ['CAUSE', you.alive ? 'NONE' : you.cause.toUpperCase()],
        ['CHAMBERS SURVIVED', `${you.survived}`],
        ['POT', you.alive ? `$${pot} · YOURS` : `$${pot} · ${tag(winner!)}`],
      ],
      remark: pool[rng.int(0, pool.length - 1)],
      table: order.map((s) => `${tag(s)} — ${s.alive ? 'SEATED' : s.causeKind === 'shot' ? 'SHOT' : s.causeKind === 'passed' ? 'INHERITED' : 'OWN HAND'}${s.you ? ' (YOU)' : ''}`),
      fine: '',
    });
  }

  const onBtn = (b: HTMLButtonElement, a: Action) =>
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!b.disabled) choose(a);
    });
  onBtn(pullBtn, 'pull');
  onBtn(passBtn, 'pass');
  onBtn(turnBtn, 'turn');
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter') choose('pull');
    else if (e.code === 'KeyP') choose('pass');
    else if (e.code === 'KeyT') choose('turn');
    if (!inApp() && e.code === 'KeyK') forceBang = true;
  });

  /* ---------- poses ---------- */

  const tmpO = new THREE.Object3D();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
  const poseP = new THREE.Vector3();
  const poseQ = new THREE.Quaternion();
  const euler = new THREE.Euler();

  const lookQ = (from: THREE.Vector3, to: THREE.Vector3, out: THREE.Quaternion) => {
    tmpO.position.copy(from);
    tmpO.lookAt(to);
    return out.copy(tmpO.quaternion);
  };
  /** Gun origin such that its local point `local` sits at `world` with rotation q. */
  const placeBy = (local: THREE.Vector3, world: THREE.Vector3, q: THREE.Quaternion) => poseP.copy(world).sub(v3.copy(local).multiplyScalar(GUN_SCALE).applyQuaternion(q));
  const headOf = (s: Seat, out: THREE.Vector3) => (s.you ? out.copy(cam.position) : s.subject!.headWorld(out));

  function tablePose(s: Seat, r: number, yaw = yawTo(s)) {
    const a = yawTo(s);
    poseP.set(Math.sin(a) * r, TABLE_Y + 0.02, Math.cos(a) * r);
    poseQ.setFromEuler(euler.set(0, yaw, Math.PI / 2));
  }

  function headPose(s: Seat, t: number) {
    if (s.you) {
      const muzzle = v1.set(0.015, CAM.y - 0.13, CAM.z - 0.2);
      lookQ(muzzle, v2.set(0, CAM.y - 0.05, CAM.z + 0.1), poseQ);
      placeBy(MUZZLE, muzzle, poseQ);
    } else {
      const sub = s.subject!;
      const side = s.arm === 'la' ? 1 : -1;
      const temple = sub.head.localToWorld(v1.set(side * 0.135, 0.13, 0.01));
      lookQ(temple, sub.head.localToWorld(v2.set(0, 0.12, 0)), poseQ);
      placeBy(MUZZLE, temple, poseQ);
    }
    const tr = (s.kind ? PERSONALITIES[s.kind].tremble : 0.4) * (0.3 + risk()) * (phase === 'hold' ? 1.6 : 1) * 0.006;
    poseP.x += Math.sin(t * 37) * tr;
    poseP.y += Math.sin(t * 29 + 1) * tr;
    poseP.z += Math.sin(t * 23 + 2) * tr;
  }

  function aimPose(s: Seat, at: THREE.Vector3) {
    const shoulder = s.you ? v1.copy(SHOULDER) : s.subject!.limbs[s.arm ?? 'ra'].root.getWorldPosition(v1);
    const hand = v2.copy(at).sub(shoulder).normalize().multiplyScalar(s.you ? 0.48 : 0.44).add(shoulder);
    hand.y -= 0.03;
    lookQ(hand, at, poseQ);
    placeBy(GRIP, hand, poseQ);
  }

  function gunPose(t: number) {
    const h = seats[holder];
    if (phase === 'intro' || phase === 'load') return tablePose(seats[queued], 0.12, gunYaw);
    if (phase === 'pass' || phase === 'after') return tablePose(seats[nextHolder], 0.3);
    if (phase === 'death' || phase === 'finale' || phase === 'over') return tablePose(h, 0.36, yawTo(h) + 1.2);
    if (action === 'turn' && (phase === 'aim' || phase === 'cock' || phase === 'hold')) return aimPose(h, headOf(seats[target], new THREE.Vector3()));
    return headPose(h, t);
  }

  /** Two-bone IK: put the subject's hand on `handWorld`, blended over its own pose by w. */
  function armIK(s: Seat, handWorld: THREE.Vector3, w: number) {
    if (!s.subject || !s.arm) return;
    const rig = s.subject.limbs[s.arm];
    const parent = rig.root.parent!;
    parent.updateWorldMatrix(true, false);
    const S = rig.root.position;
    const T = parent.worldToLocal(handWorld.clone());
    const a = 0.28, b = 0.27;
    const dir = T.clone().sub(S);
    const d = clamp(dir.length(), 0.1, a + b - 0.01);
    dir.normalize();
    const pole = new THREE.Vector3(s.arm === 'la' ? 1 : -1, -0.7, -0.25);
    const n = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const elbow = S.clone().addScaledVector(dir, a * cosA).addScaledVector(n, a * Math.sqrt(1 - cosA * cosA));
    qA.setFromUnitVectors(DOWN, elbow.sub(S).normalize());
    const tip = dir.clone().multiplyScalar(d).applyQuaternion(qB.copy(qA).invert());
    qB.setFromUnitVectors(DOWN, tip.sub(v3.set(0, -a, 0)).normalize());
    rig.root.quaternion.slerp(qA, w);
    rig.joint.quaternion.slerp(qB, w);
  }

  /* ---------- per-frame ---------- */

  function stepPhase(dt: number) {
    const prev = pt;
    pt += dt;
    const at = (x: number) => prev < x && pt >= x;
    if (phase === 'load') {
      const gap = 0.32;
      for (let i = 0; i < bullets; i++) if (at(0.3 + i * gap)) sound.insert();
      const sAt = 0.45 + bullets * gap;
      if (at(sAt)) {
        sound.spin(1.4);
        spinFrom = gunYaw;
        spinTo = yawTo(seats[queued]);
        while (spinTo < spinFrom + Math.PI * 4) spinTo += Math.PI * 2;
        drumTarget += Math.PI * 10;
        spinAt = sAt;
        showLive = false;
        lastUi = '';
        requestAnimationFrame(() => cylEl.querySelector('.spin-g')?.classList.add('spin'));
      }
      if (spinAt >= 0) gunYaw = lerp(spinFrom, spinTo, 1 - Math.pow(1 - clamp((pt - spinAt) / 1.5, 0, 1), 3));
      if (spinAt >= 0 && pt >= spinAt + 1.75) {
        cylEl.classList.remove('big');
        gunYaw = spinTo;
        startTurn(queued);
      }
    } else if (phase === 'handoff') {
      if (pt >= dur) {
        enter('decide');
        if (seats[holder].you && !you.kind) ctx.haptic('light');
      }
    } else if (phase === 'decide') {
      const s = seats[holder];
      if (s.kind) {
        if (pt >= ponder) act(planned);
      } else if (!net) {
        if (pt >= limit(s)) act('pull');
      } else if (decided.has(turnNo)) {
        act(decided.get(turnNo)!);
        if (!action) act('pull');
      } else if (seated && you.alive && pt >= limit(s) + (s.you ? 0 : 6)) propose('pull');
    } else if (phase === 'pass') {
      if (pt >= dur) startTurn(nextHolder, seats[holder]);
    } else if (phase === 'aim') {
      if (pt >= dur) cock();
    } else if (phase === 'cock') {
      if (pt >= dur) enter('hold', 0.45 + risk() * 1.1 + (duel() ? 0.5 : 0));
    } else if (phase === 'hold') {
      if (pt >= dur) resolve();
    } else if (phase === 'after') {
      if (pt >= dur) startTurn(nextHolder);
    } else if (phase === 'death') {
      if (pt >= dur) {
        if (aliveSeats().length <= 1) enterFinale();
        else {
          if (duel()) {
            sound.bpm = 124;
            sound.intensity = 1;
            room.lamp.amp = 0.22;
            big('FINAL CHAMBER', 'info');
          } else sound.intensity = Math.min(1, sound.intensity + 0.2);
          reload();
        }
      }
    } else if (phase === 'finale') {
      const w = winner!;
      if (at(1.0)) sound.coins(14);
      if (at(2.2)) {
        winEl.classList.add('in');
        engine.flash(0.25, 0xffe0a0);
        sound.coins(24);
        sound.gunshot();
        engine.shake(0.25);
        if (w.you) {
          ctx.haptic('heavy');
          setTimeout(() => ctx.haptic('heavy'), 180);
          setTimeout(() => ctx.haptic('heavy'), 420);
        }
        const from = potGroup.position.clone().add(v1.set(0, 0.1, 0));
        for (let i = 0; i < 16; i++) {
          const bill = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.003, 0.036), billMat);
          bill.position.copy(from);
          scene.add(bill);
          gore.throwObject(bill, new THREE.Vector3(rand(-1.2, 1.2), rand(2.2, 3.6), rand(-1.2, 1.2)), new THREE.Vector3(rand(-14, 14), rand(-14, 14), rand(-14, 14)), 0.012);
        }
        if (w.subject) w.subject.relaxed = true;
      }
      if (pt >= dur) finish();
    }
  }

  function seatsTick(dt: number, t: number) {
    const h = seats[holder];
    const holdHead = headOf(h, new THREE.Vector3());
    const tense = phase === 'cock' || phase === 'hold';
    for (const s of seats) {
      const holding = s === h && s.alive && (phase === 'handoff' || phase === 'decide' || phase === 'aim' || tense);
      s.hold = damp(s.hold, holding ? 1 : 0, 7, dt);
      const sub = s.subject;
      if (!sub) continue;
      if (s.arm && sub.alive) {
        const rig = sub.limbs[s.arm];
        rig.root.rotation.y = damp(rig.root.rotation.y, 0, 10, dt);
        rig.joint.rotation.y = damp(rig.joint.rotation.y, 0, 10, dt);
        rig.joint.rotation.z = damp(rig.joint.rotation.z, 0, 10, dt);
      }
      sub.freeze = tense || (s === h && phase === 'decide');
      if (phase === 'finale' || phase === 'over') sub.lookAt = s === winner ? cam.position.clone() : headOf(winner ?? h, new THREE.Vector3());
      else if (s === h) sub.lookAt = action === 'turn' && target >= 0 ? headOf(seats[target], new THREE.Vector3()) : new THREE.Vector3(s.pos.x * 0.3, TABLE_Y, s.pos.z * 0.3);
      else sub.lookAt = phase === 'load' ? gun.position.clone() : holdHead.clone();
      sub.chew = s === h && tense && s.kind === 'coward';
      sub.update(dt, t);
      if (sub.alive && s.hold > 0.002) armIK(s, gun.localToWorld(v1.copy(GRIP)), smooth(s.hold));
    }
  }

  function gunTick(dt: number, t: number) {
    gunPose(t);
    const rate = phase === 'load' || phase === 'intro' ? 16 : phase === 'death' ? 6 : 9;
    gun.position.lerp(poseP, 1 - Math.exp(-rate * dt));
    gun.quaternion.slerp(poseQ, 1 - Math.exp(-rate * dt));
    drumAngle = damp(drumAngle, drumTarget, phase === 'load' ? 2.2 : 14, dt);
    drum.rotation.z = drumAngle;
    hammer.rotation.x = damp(hammer.rotation.x, hammerTarget, hammerTarget === 0 ? 40 : 12, dt);
  }

  const handPos = new THREE.Vector3();
  function handTick() {
    const k = you.alive ? smooth(clamp(you.hold, 0, 1)) : 0;
    handPos.lerpVectors(v2.set(0.17, TABLE_Y + 0.04, 0.52), gun.localToWorld(v1.copy(GRIP)), k);
    fist.position.copy(handPos);
    fist.quaternion.slerpQuaternions(qA.identity(), gun.quaternion, k);
    sleeve.position.lerpVectors(handPos, SHOULDER, 0.5);
    sleeve.lookAt(SHOULDER);
    sleeve.scale.set(0.09, 0.08, handPos.distanceTo(SHOULDER) + 0.05);
  }

  const mtx = new THREE.Matrix4();
  function potTick(dt: number) {
    if ((phase === 'finale' || phase === 'over') && winner && (phase === 'over' || pt > 0.8)) {
      const to = v1.copy(winner.pos).multiplyScalar(winner.you ? 0.42 : 0.5).setY(TABLE_Y);
      potGroup.position.lerp(to, 1 - Math.exp(-3 * dt));
    }
    for (const s of seats) {
      const n = Math.min(24, Math.round(s.coins / 5));
      if (n === s.stackShown) continue;
      s.stackShown = n;
      s.stack.count = n;
      const yaw = yawTo(s);
      const r = 0.5;
      const sx = Math.cos(yaw) * (s.you ? -0.22 : 0.2), sz = -Math.sin(yaw) * (s.you ? -0.22 : 0.2);
      for (let i = 0; i < n; i++) {
        const col = Math.floor(i / 12);
        mtx.makeTranslation(Math.sin(yaw) * (r - col * 0.05) + sx, TABLE_Y + 0.004 + (i % 12) * 0.0072, Math.cos(yaw) * (r - col * 0.05) + sz);
        s.stack.setMatrixAt(i, mtx);
      }
      s.stack.instanceMatrix.needsUpdate = true;
    }
  }

  function cameraTick(dt: number, t: number) {
    const h = seats[holder];
    const goal = v2;
    const aimedAtYou = action === 'turn' && seats[target]?.you && (phase === 'aim' || phase === 'cock' || phase === 'hold');
    if (phase === 'intro' || phase === 'load') goal.set(0, TABLE_Y + 0.1, -0.05);
    else if (phase === 'finale' || phase === 'over') {
      if (winner!.you) goal.copy(potGroup.position).add(v1.set(0, 0.3, -0.6));
      else headOf(winner!, goal).lerp(potGroup.position, 0.3);
    } else if (h.you && you.alive && phase !== 'death') {
      if (action === 'turn' && target >= 0) headOf(seats[target], goal).lerp(gun.position, 0.2);
      else goal.copy(gun.position).lerp(v1.set(0, TABLE_Y + 0.2, -0.5), 0.35);
    } else if (aimedAtYou) gun.localToWorld(goal.copy(MUZZLE));
    else headOf(h, goal).lerp(v1.set(0, TABLE_Y, 0), 0.45);
    if (glanceK > 0) goal.lerp(glance, smooth(Math.min(1, glanceK * 1.5)) * 0.5);
    glanceK = Math.max(0, glanceK - dt * 0.6);
    camLook.lerp(goal, 1 - Math.exp(-4 * dt));
    if (youDeadAt >= 0) {
      const k = smooth(clamp((elapsed - youDeadAt) / 0.9, 0, 1));
      cam.position.set(lerp(CAM.x, 0.12, k), lerp(CAM.y, TABLE_Y + 0.12, k), lerp(CAM.z, 0.5, k));
      cam.lookAt(camLook.x, lerp(camLook.y, TABLE_Y + 0.2, k * 0.5), camLook.z);
      cam.rotateZ(-0.85 * k + Math.sin(elapsed * 30) * 0.05 * (1 - k));
    } else {
      const sway = 0.006;
      const lean = winner?.you ? 0.1 : 0;
      cam.position.set(CAM.x + Math.sin(t * 0.7) * sway, CAM.y + Math.sin(t * 1.3) * sway * 0.6 + lean * 0.4, CAM.z + lean);
      cam.lookAt(camLook);
    }
    const danger = (h.you && you.alive && (phase === 'cock' || phase === 'hold')) || aimedAtYou;
    const fov = danger ? 62 : duel() && phase !== 'finale' && phase !== 'over' ? 70 : 78;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, 4, dt);
      cam.updateProjectionMatrix();
    }
    engine.tint = damp(engine.tint, danger ? 0.35 : duel() && phase !== 'finale' && phase !== 'over' ? 0.12 : 0, 5, dt);
    room.danger.intensity = engine.tint * 12;
    if (youDeadAt >= 0) {
      const d = elapsed - youDeadAt;
      if (d > 1.8 && engine.lens.permanent) engine.lens.permanent = false;
      fade.style.opacity = String(d < 1.6 ? smooth(d / 1.6) * 0.94 : Math.max(0.3, 0.94 - (d - 2.4) * 0.5));
    }
  }

  let lastUi = '';
  let boardT = 0;
  function uiTick(dt: number) {
    const h = seats[holder];
    const mine = h.you && !you.kind && you.alive && phase === 'decide';
    const loading = phase === 'load' || phase === 'intro';
    const r = chambers.length ? risk() : 1 / CHAMBERS;
    const left = chambers.length ? bulletsLeft() : 1;
    const next = seats[nextAlive(holder)];
    const key = [phase, idx, showLive, left, bullets, mine, you.coins, next.index, spinAt >= 0].join('|');
    if (key !== lastUi) {
      lastUi = key;
      const col = r >= 0.5 ? '#ff3b2a' : r >= 0.25 ? '#f2c14a' : '#d8cfb8';
      const dots = Array.from({ length: CHAMBERS }, (_, i) => {
        const a = (i / CHAMBERS) * Math.PI * 2 - Math.PI / 2;
        const spent = i < idx && !loading;
        const x = Math.cos(a) * 25, y = Math.sin(a) * 25;
        const xm = spent ? `<path class="x" d="M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}"/>` : '';
        return `<circle class="ch ${showLive && chambers[i] ? 'live' : spent ? 'spent' : ''} ${i === idx && !loading ? 'now' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"/>${xm}`;
      }).join('');
      const rot = loading ? 0 : -idx * 60;
      const prevRot = (cylEl.querySelector('.idx') as SVGGElement | null)?.style.transform || `rotate(${rot}deg)`;
      const spinning = phase === 'load' && spinAt >= 0;
      cylEl.innerHTML = `<svg viewBox="-50 -50 100 100"><circle class="body" r="44"/><g class="idx" style="transform:${prevRot}"><g class="spin-g ${spinning ? 'spin' : ''}">${dots}</g></g><path class="ptr" d="M-6 -50L6 -50L0 -40Z"/></svg><div class="odds"><b style="color:${col}">${loading ? `${bullets} ROUND${bullets > 1 ? 'S' : ''}` : r >= 0.999 ? 'LIVE' : `${left} IN ${CHAMBERS - idx}`}</b></div>`;
      const g = cylEl.querySelector('.idx') as SVGGElement;
      requestAnimationFrame(() => (g.style.transform = `rotate(${rot}deg)`));
      coinsEl.textContent = `${you.coins}c`;
      pullBtn.disabled = !mine;
      passBtn.disabled = !mine || you.coins < PASS_COST;
      turnBtn.disabled = !mine || you.coins < TURN_COST;
      turnBtn.innerHTML = `TURN IT<small>${TURN_COST}c · ${nameOf(next)}</small>`;
      if (you.alive && phase !== 'finale' && phase !== 'over') panel.className = `lc-panel ${mine ? '' : 'wait'}`;
    }
    const lim = limit(h);
    clockBar.style.width = phase === 'decide' ? `${clamp(1 - pt / lim, 0, 1) * 100}%` : '100%';
    if (!finished) hud.setTimer(phase === 'decide' ? Math.max(0, lim - pt) : lim);

    if (!you.alive || phase === 'intro' || phase === 'death' || phase === 'finale' || phase === 'over') hud.setStatus('', 'hidden');
    else if (phase === 'load') hud.setStatus(duel() ? 'FINAL CHAMBER' : '', duel() ? 'warn' : 'hidden');
    else if (action === 'turn' && seats[target]?.you && phase !== 'after') hud.setStatus("IT'S POINTED AT YOU", 'danger');
    else if (h.you && passedFrom && (phase === 'decide' || phase === 'handoff')) hud.setStatus(`${passedFrom.info.name.toUpperCase()} PASSED IT`, 'danger');
    else if (h.you && (phase === 'decide' || phase === 'handoff')) hud.setStatus('YOUR TURN', 'danger');
    else if (phase === 'cock' || phase === 'hold') hud.setStatus('…', 'warn');
    else hud.setStatus(h.you ? 'YOUR TURN' : `${h.info.name.toUpperCase()}'S TURN`, 'calm');

    boardT += dt;
    if (boardT > 0.15) {
      boardT = 0;
      hud.setBoard(
        seats.map((s) => ({
          name: `${s === h && s.alive && !loading && phase !== 'finale' && phase !== 'over' ? '▸ ' : ''}${tag(s)}`,
          value: Math.min(s.coins, 100),
          max: 100,
          me: s.you,
          dead: !s.alive,
          label: winner === s ? `$${pot}` : `${s.coins}c`,
        })),
      );
    }

    const myHold = h.you && you.alive && (phase === 'decide' || phase === 'hold' || phase === 'cock');
    const pointed = action === 'turn' && seats[target]?.you && (phase === 'aim' || phase === 'cock' || phase === 'hold');
    if (myHold || pointed) {
      beatT -= dt;
      if (beatT <= 0) {
        beatT = 60 / (72 + r * 90 + (phase === 'hold' ? 30 : 0));
        sound.heartbeat(0.5 + r * 0.6);
        if (phase === 'hold') ctx.haptic('light');
      }
    } else beatT = 0;
  }

  /** Online, every phone loads the gun at the same moment, tapped through or not. */
  const begin = net && start.startAt !== undefined ? start.startAt + 3000 : 0;
  hud.setTitle('FINAL SIMULATION', 'LAST CHAMBER');
  hud.setPot(pot);
  hud.setLimbs(me.limbs);
  hud.setTimer(DECIDE);
  queued = seatOf(rng.int(0, table.length - 1));
  const marked = seats.find((s) => on('marked', s.info.id) > 0);
  if (marked) queued = marked.index;
  gunYaw = yawTo(seats[queued]) + 2.1;
  void hud
    .intro('FINAL SIMULATION', 'LAST CHAMBER', ['<b>PULL</b>. SURVIVE. GET PAID.', '<b>PASS</b> IT ON, OR <b>TURN IT</b> ON THEM. LAST ONE SEATED TAKES THE POT.'])
    .then(() => new Promise((go) => setTimeout(go, begin - Date.now())))
    .then(() => {
      sound.unlock();
      sound.drone(true);
      sound.bpm = 96;
      sound.intensity = 0.5;
      sound.beat(true);
      reload();
    });
  if (auto) document.querySelector<HTMLElement>('.overlay')?.dispatchEvent(new PointerEvent('pointerdown'));
  if (net) setTimeout(() => document.querySelector<HTMLElement>('.overlay.intro')?.dispatchEvent(new PointerEvent('pointerdown')), begin - Date.now());

  function step(dt: number, t: number) {
    if (phase !== 'intro') elapsed += dt;
    if (phase !== 'intro' && phase !== 'over') stepPhase(dt);
    room.lamp.update(dt);
    for (const f of room.flickers) f.update(dt);
    gunTick(dt, t);
    seatsTick(dt, t);
    gore.update(dt);
    potTick(dt);
    handTick();
    cameraTick(dt, t);
    uiTick(dt);
  }

  return {
    update(dt, t) {
      const ff = youDeadAt >= 0 && elapsed - youDeadAt > 3.5 && phase !== 'finale' && phase !== 'over' && phase !== 'death' ? 2 : 1;
      for (let i = 0; i < ff; i++) step(dt, t + i * dt);
    },
  };
};
