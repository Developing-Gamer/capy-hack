import * as THREE from 'three';
import { sound } from '../shared/audio';
import { inApp } from '../shared/bridge';
import type { GameFactory } from '../shared/game';
import { Gore, type Surface, type Wall } from '../shared/gore';
import type { Limb, Placement, PlayerInfo } from '../shared/protocol';
import { Flicker } from '../shared/renderer';
import { Subject } from '../shared/rig';
import { blotches, canvasTex, speckle, Tex } from '../shared/textures';
import { clamp, damp, lerp, rand, smooth } from '../shared/util';

/*
 * THE GRINDER. Everyone sits on a conveyor that feeds a meat grinder, feet first. Alternate
 * LEFT / RIGHT to haul yourself back along the side rails; using the same hand twice slips and
 * the belt yanks you forward. The belt speeds up and surges. Whoever reaches the teeth is fed
 * through. The belt stops once only the quota is left alive (2 of 4, otherwise 1).
 *
 * The sim runs on a fixed 60 Hz step from ctx.rng plus the queued human taps, so a seed and an
 * input log replay the same round.
 */

const ROUND = 75;
const STEP = 1 / 60;
const BELT_Y = 0.55;
const BELT_LEN = 7.4;
const BELT_W = 0.46;
const LANES = [-1.0, -0.33, 0.33, 1.0];
const ME_LANE = 1;
const RAIL_X = 0.21;
const RAIL_Y = BELT_Y + 0.3;
const GZ = 0;
const P_START = 3.4;
const P_MAX = 5;
/** Metres one clean haul is worth. */
const PULL = 0.24;
const HAUL_DECAY = 9;
/** Feet in the teeth: extra drag and a foot comes off. */
const BITE = 0.3;
const BITE_DRAG = 0.45;
const SLIP_LOCK = 0.38;
const SLIP_YANK = 0.14;
const SLIP_DRAG = 0.7;
const FEED_OUT = 2.3;
const HIP_Y = BELT_Y + 0.07;
const LEG_REACH = 0.92;
const ROOM = { x: 3, z0: -2, z1: 9.2, h: 4 };
const MOUTH = { x: 1.42, y0: BELT_Y - 0.08, y1: BELT_Y + 0.72 };
const CLIP = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(GZ - 0.05));

type Hand = 'L' | 'R';
type Kind = 'steady' | 'panicky' | 'showoff';

interface Personality {
  kind: Kind;
  /** Taps per second at the start, before fatigue. */
  base: [number, number];
  /** Taps per second lost per second of work. */
  decay: number;
  /** Gap (m) it tries to hold. */
  target: number;
  gain: number;
  jitter: number;
  slip: number;
  /** Extra slip chance when close to the teeth. */
  panicSlip: number;
  /** Seconds before it notices a surge. */
  react: number;
  /** Chance per tap decision to stop hauling and show off. */
  pause: number;
}

const PERSONALITIES: Record<Kind, Personality> = {
  steady: { kind: 'steady', base: [6.8, 7.5], decay: 0.03, target: 2.5, gain: 1.5, jitter: 0.08, slip: 0.008, panicSlip: 0.03, react: 0.25, pause: 0 },
  panicky: { kind: 'panicky', base: [7.4, 8.2], decay: 0.046, target: 2.8, gain: 2.4, jitter: 0.3, slip: 0.02, panicSlip: 0.12, react: 0.1, pause: 0 },
  showoff: { kind: 'showoff', base: [6.6, 7.3], decay: 0.022, target: 1.5, gain: 1.1, jitter: 0.18, slip: 0.015, panicSlip: 0.05, react: 0.45, pause: 0.03 },
};

interface Brain {
  p: Personality;
  max0: number;
  nextTap: number;
  pauseUntil: number;
}

interface Runner {
  info: PlayerInfo;
  number: number;
  you: boolean;
  x: number;
  subject: Subject;
  brain: Brain | null;
  /** Gap from the front of the body to the teeth, metres. */
  p: number;
  /** Distance from the hips to the front of the body. */
  front: number;
  hv: number;
  last: Hand | null;
  slipT: number;
  slipAt: number;
  slipHand: Hand | null;
  alive: boolean;
  state: 'belt' | 'feed' | 'gone';
  feed: number;
  feedV: number;
  inBite: boolean;
  bites: number;
  minP: number;
  slips: number;
  hauled: number;
  taps: number;
  endAt: number;
  cause: string;
  grip: Record<Hand, number>;
  lean: number;
  fx: { gib: number; crunch: number; gutted: boolean; headGone: boolean };
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

function rod(r: number, len: number, m: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number, axis: 'x' | 'y' | 'z') {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), m);
  mesh.position.set(x, y, z);
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

const beltTex = () =>
  canvasTex(
    32,
    64,
    (g, w, h) => {
      g.fillStyle = '#272523';
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, ['#0e0d0c', '#3d3a36'], 240, 2);
      for (let y = 0; y < h; y += 8) {
        g.fillStyle = '#0b0a09';
        g.fillRect(0, y, w, 2);
        g.fillStyle = '#4a4640';
        g.fillRect(0, y + 2, w, 1);
      }
      blotches(g, w, h, '#2a0806', 7, 2, 8, 0.2, 0.5);
      g.fillStyle = '#0a0a0a';
      g.fillRect(0, 0, 2, h);
      g.fillRect(w - 2, 0, 2, h);
    },
    [1, BELT_LEN / 0.5],
  );

/** Stencilled text lines [text, px, colour] on a transparent canvas. */
function stencil(lines: [string, number, string][], w = 256, h = 96) {
  const tex = canvasTex(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let y = (h - lines.reduce((a, [, s]) => a + s * 1.15, 0)) / 2;
    for (const [text, size, color] of lines) {
      g.fillStyle = color;
      g.font = 'bold ' + size + 'px monospace';
      g.fillText(text, w / 2, y + size * 0.6);
      y += size * 1.15;
    }
    g.globalCompositeOperation = 'destination-out';
    blotches(g, w, h, '#000', 14, 2, 9, 0.2, 0.6);
    g.globalCompositeOperation = 'source-over';
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function buildFactory(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x060404);
  scene.fog = new THREE.FogExp2(0x090605, 0.1);
  const W = ROOM.x * 2, D = ROOM.z1 - ROOM.z0, cz = (ROOM.z1 + ROOM.z0) / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0xffffff, { map: Tex.floor([W, D]) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = cz;
  floor.receiveShadow = true;
  scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0x141210));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, ROOM.h, cz);
  scene.add(ceil);
  const conc = lam(0xffffff, { map: Tex.concrete([D / 2, ROOM.h / 2]) });
  const wall = (w: number, m: THREE.Material, x: number, z: number, ry: number) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, ROOM.h), m);
    p.position.set(x, ROOM.h / 2, z);
    p.rotation.y = ry;
    p.receiveShadow = true;
    scene.add(p);
  };
  wall(D, conc, -ROOM.x, cz, Math.PI / 2);
  wall(D, conc, ROOM.x, cz, -Math.PI / 2);
  wall(W, lam(0xffffff, { map: Tex.concrete([W / 2, ROOM.h / 2]) }), 0, ROOM.z1, Math.PI);
  const rust = lam(0xffffff, { map: Tex.rust([4, 2]) });
  const metal = lam(0xffffff, { map: Tex.metal([2, 2]) });
  const dark = lam(0x0f0d0c);
  const haz = (len: number) => lam(0xffffff, { map: Tex.hazard([len * 2, 1]) });

  for (const s of [-1, 1]) {
    box(0.02, 0.24, D, haz(D), scene, s * (ROOM.x - 0.011), 0.12, cz, false);
    rod(0.07, D, rust, scene, s * (ROOM.x - 0.15), 3.3, cz, 'z');
    rod(0.045, D, rust, scene, s * (ROOM.x - 0.32), 3.55, cz, 'z');
  }

  // The grinder: the whole front wall of the room is the machine, with one wide toothed maw.
  const machine = lam(0xffffff, { map: Tex.rust([6, 3]) });
  const slabZ = GZ - 0.35;
  box(W, MOUTH.y0, 0.7, machine, scene, 0, MOUTH.y0 / 2, slabZ);
  box(W, ROOM.h - MOUTH.y1, 0.7, machine, scene, 0, (MOUTH.y1 + ROOM.h) / 2, slabZ);
  for (const s of [-1, 1]) box(ROOM.x - MOUTH.x, MOUTH.y1 - MOUTH.y0, 0.7, machine, scene, (s * (ROOM.x + MOUTH.x)) / 2, (MOUTH.y0 + MOUTH.y1) / 2, slabZ);
  box(MOUTH.x * 2, MOUTH.y1 - MOUTH.y0, 0.1, dark, scene, 0, (MOUTH.y0 + MOUTH.y1) / 2, GZ - 1.1, false);
  for (const s of [-1, 1]) box(0.05, MOUTH.y1 - MOUTH.y0, 1.1, dark, scene, s * MOUTH.x, (MOUTH.y0 + MOUTH.y1) / 2, GZ - 0.55, false);
  box(MOUTH.x * 2 + 0.3, 0.16, 0.03, haz(4), scene, 0, MOUTH.y1 + 0.08, GZ + 0.015, false);
  const vhaz = lam(0xffffff, { map: Tex.hazard([2, 1]) });
  for (const s of [-1, 1]) {
    const v = box(MOUTH.y1 - MOUTH.y0 + 0.32, 0.16, 0.03, vhaz, scene, s * (MOUTH.x + 0.08), (MOUTH.y0 + MOUTH.y1) / 2, GZ + 0.015, false);
    v.rotation.z = Math.PI / 2;
  }
  for (let i = 0; i < 9; i++) box(0.08, ROOM.h - MOUTH.y1 - 0.35, 0.06, metal, scene, -2.6 + i * 0.65, (MOUTH.y1 + 0.3 + ROOM.h) / 2, GZ + 0.03);
  box(4.2, 0.08, 0.1, metal, scene, 0, MOUTH.y1 + 0.3, GZ + 0.04);

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.56),
    lam(0xffffff, { map: stencil([['GRINDER 04', 30, '#d8cfb0'], ['FEED \u25bc FEET FIRST', 15, '#c99a12']]), transparent: true, emissive: 0x0a0806 }),
  );
  plate.position.set(0, MOUTH.y1 + 0.75, GZ + 0.07);
  scene.add(plate);
  const neon = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.42),
    new THREE.MeshBasicMaterial({ map: stencil([['\u25b2 KEEP HAULING \u25b2', 24, '#ff4a2a']], 256, 64), transparent: true, fog: false }),
  );
  neon.position.set(0, MOUTH.y1 + 1.55, GZ + 0.07);
  scene.add(neon);
  const neonLight = new THREE.PointLight(0xff3a1a, 1.4, 4, 1.5);
  neonLight.position.set(0, MOUTH.y1 + 1.4, GZ + 0.5);
  scene.add(neonLight);

  const rollerMat = lam(0x8a8480, { map: Tex.metal([4, 1]) });
  const teethMat = lam(0xa8a8a8, { emissive: 0x141414 });
  const dummy = new THREE.Object3D();
  const rollers = ([[BELT_Y - 0.2, 0.18, -1], [BELT_Y + 0.42, 0.21, 1]] as const).map(([y, r, dir]) => {
    const grp = new THREE.Group();
    grp.position.set(0, y, GZ - 0.3);
    scene.add(grp);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, MOUTH.x * 2, 12), rollerMat);
    cyl.rotation.z = Math.PI / 2;
    grp.add(cyl);
    const AR = 10, AC = 24;
    const teeth = new THREE.InstancedMesh(new THREE.ConeGeometry(0.045, 0.14, 4), teethMat, AR * AC);
    let n = 0;
    for (let a = 0; a < AR; a++)
      for (let c = 0; c < AC; c++) {
        const ang = (a / AR) * Math.PI * 2 + (c % 2) * (Math.PI / AR);
        dummy.position.set(-MOUTH.x + 0.06 + (c / (AC - 1)) * (MOUTH.x * 2 - 0.12), Math.cos(ang) * (r + 0.05), Math.sin(ang) * (r + 0.05));
        dummy.rotation.set(ang, 0, 0);
        dummy.updateMatrix();
        teeth.setMatrixAt(n++, dummy.matrix);
      }
    grp.add(teeth);
    return { grp, dir };
  });

  const beaconMat = [0, 1].map(() => new THREE.MeshBasicMaterial({ color: 0x330000, fog: false }));
  [-1, 1].forEach((s, i) => {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 1), beaconMat[i]);
    b.position.set(s * (MOUTH.x + 0.35), MOUTH.y1 + 0.3, GZ + 0.12);
    scene.add(b);
    box(0.14, 0.05, 0.14, dark, scene, s * (MOUTH.x + 0.35), MOUTH.y1 + 0.23, GZ + 0.12, false);
  });
  const mouthLight = new THREE.PointLight(0xff1a08, 3, 6, 1.4);
  mouthLight.position.set(0, BELT_Y + 0.5, GZ + 0.6);
  scene.add(mouthLight);
  const innerLight = new THREE.PointLight(0xff3010, 2.5, 2.2, 1.3);
  innerLight.position.set(0, BELT_Y + 0.15, GZ - 0.65);
  scene.add(innerLight);

  // Conveyors.
  const belt = beltTex();
  const beltMat = lam(0xffffff, { map: belt });
  const railMat = lam(0xb08a1a, { emissive: 0x1a1200 });
  const frameMat = lam(0x2a2826);
  for (const x of LANES) {
    const top = new THREE.Mesh(new THREE.PlaneGeometry(BELT_W, BELT_LEN + 0.4), beltMat);
    top.rotation.x = -Math.PI / 2;
    top.position.set(x, BELT_Y, GZ + (BELT_LEN - 0.4) / 2);
    top.receiveShadow = true;
    scene.add(top);
    box(BELT_W + 0.04, 0.14, BELT_LEN, frameMat, scene, x, BELT_Y - 0.08, GZ + BELT_LEN / 2, false);
    for (const s of [-1, 1]) {
      box(0.03, 0.05, BELT_LEN, haz(BELT_LEN), scene, x + s * (BELT_W / 2 + 0.015), BELT_Y + 0.01, GZ + BELT_LEN / 2, false);
      rod(0.022, BELT_LEN, railMat, scene, x + s * RAIL_X, RAIL_Y, GZ + BELT_LEN / 2, 'z');
      for (let z = 0.5; z < BELT_LEN; z += 1.3) rod(0.016, RAIL_Y - BELT_Y + 0.05, railMat, scene, x + s * RAIL_X, (RAIL_Y + BELT_Y) / 2 - 0.02, GZ + z, 'y');
    }
    for (let z = 0.6; z < BELT_LEN; z += 1.6) for (const s of [-1, 1]) box(0.05, BELT_Y - 0.15, 0.05, frameMat, scene, x + s * 0.18, (BELT_Y - 0.15) / 2, GZ + z, false);
    rod(0.09, BELT_W, metal, scene, x, BELT_Y - 0.09, GZ + BELT_LEN, 'x');
    const stop = box(BELT_W + 0.1, 0.12, 0.06, haz(1), scene, x, BELT_Y + 0.2, GZ + P_MAX + LEG_REACH + 0.38, false);
    stop.rotation.x = 0.2;
  }

  // Meat hooks along the walls.
  const meat = lam(0x5a0c0a, { emissive: 0x120000 });
  const fat = lam(0xc9b8a0);
  for (const [x, z] of [[-2.4, 2.2], [-2.5, 4.6], [2.45, 3.1], [2.35, 6.2], [-2.45, 7.4]]) {
    rod(0.008, 1.3, dark, scene, x, ROOM.h - 0.65, z, 'y');
    const m = box(0.34, 0.75, 0.2, meat, scene, x, ROOM.h - 1.75, z);
    m.rotation.y = rand(-0.6, 0.6);
    box(0.2, 0.12, 0.21, fat, m, 0.06, 0.25, 0, false);
  }

  scene.add(new THREE.HemisphereLight(0x4a3e34, 0x0a0606, 0.6));
  const flickers: Flicker[] = [];
  for (const z of [1.6, 4.2, 6.8]) {
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: 0xffd8a0, fog: false }));
    bulb.position.set(0, ROOM.h - 0.55, z);
    scene.add(bulb);
    const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.2, 6, 1, true), new THREE.MeshLambertMaterial({ color: 0x2a2620, wireframe: true }));
    cage.position.copy(bulb.position);
    scene.add(cage);
    box(0.01, 0.45, 0.01, dark, scene, 0, ROOM.h - 0.22, z, false);
    const l = new THREE.PointLight(0xffb878, 3.2, 5.5, 1.4);
    l.position.copy(bulb.position);
    scene.add(l);
    flickers.push(new Flicker(l, bulb.material as THREE.MeshBasicMaterial, l.intensity, z < 3 ? 1.4 : 0.5));
  }
  const spot = new THREE.SpotLight(0xffd2a8, 26, 9, 0.75, 0.6, 1.3);
  spot.position.set(0, ROOM.h - 0.3, 3.4);
  spot.target.position.set(0, 0, 1.6);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.bias = -0.002;
  scene.add(spot, spot.target);
  flickers.push(new Flicker(spot, null, spot.intensity, 0.3));

  const beltSurface: Surface = { y: BELT_Y, x0: -1.36, x1: 1.36, z0: GZ, z1: GZ + BELT_LEN, vel: { x: 0, z: 0 } };
  const surfaces: Surface[] = [beltSurface, { y: 0, x0: -ROOM.x, x1: ROOM.x, z0: ROOM.z0, z1: ROOM.z1 }];
  const walls: Wall[] = [
    { axis: 'x', at: -ROOM.x, normal: 1 },
    { axis: 'x', at: ROOM.x, normal: -1 },
    { axis: 'z', at: ROOM.z1, normal: -1 },
    { axis: 'z', at: GZ, normal: 1 },
  ];
  return { surfaces, walls, beltSurface, belt, rollers, rollerMat, teethMat, beaconMat, mouthLight, innerLight, flickers };
}

/** Additive spark spray off the teeth (cosmetic). */
class Sparks {
  private n = 180;
  private pos = new Float32Array(this.n * 3).fill(-99);
  private vel = new Float32Array(this.n * 3);
  private life = new Float32Array(this.n);
  private i = 0;
  readonly points: THREE.Points;
  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffa040, size: 0.012, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(x: number, y: number, z: number, count: number, power = 1) {
    for (let k = 0; k < count; k++) {
      const i = this.i++ % this.n;
      this.pos.set([x + rand(-0.05, 0.05), y, z], i * 3);
      this.vel.set([rand(-0.8, 0.8) * power, rand(0.8, 3) * power, rand(0.3, 2.4) * power], i * 3);
      this.life[i] = rand(0.2, 0.6);
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -99;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 7 * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      if (this.pos[i * 3 + 1] < BELT_Y) {
        this.pos[i * 3 + 1] = BELT_Y;
        this.vel[i * 3 + 1] *= -0.3;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

const REMARKS = {
  retained: [
    'Subject maintained rhythm under load. Retain for further testing.',
    'Subject out-hauled a rising belt speed. Grip strength noted.',
    'Subject remained outside the machine. This is the minimum expectation.',
  ],
  maimed: ['Subject lost a foot and kept hauling. Commendable. Unnecessary, but commendable.', 'Subject surrendered a foot to remain eligible. Footwear allowance revoked.'],
  ground: [
    'Subject was processed feet first. Yield: approximately 61 kg of product.',
    'Rhythm failure. The grinder does not negotiate.',
    'Subject entered the machine. Output consistency: coarse.',
  ],
  slipped: ['Subject used the same hand twice. The belt noticed.', 'Grip discipline insufficient. Subject reclassified as mince.'],
};

const PADS_CSS = [
  '.gr { position: absolute; inset: 0; pointer-events: none; }',
  '.gr-gap { position: absolute; left: 0; right: 0; bottom: calc(env(safe-area-inset-bottom) + 112px); text-align: center; text-shadow: 0 2px 0 #000; }',
  '.gr-gap small { display: block; font-size: 9px; letter-spacing: 3px; color: #9a8f78; }',
  '.gr-gap b { font-size: 44px; font-weight: 900; letter-spacing: 1px; color: #e6dcc6; }',
  '.gr-gap i { font-style: normal; font-size: 16px; color: #9a8f78; margin-left: 2px; }',
  '.gr-gap.warn b { color: #f2c14a; }',
  '.gr-gap.danger b { color: #ff3b2a; animation: pulse .18s infinite alternate; }',
  '.gr-pads { position: absolute; left: 10px; right: 10px; bottom: calc(env(safe-area-inset-bottom) + 30px); height: 72px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }',
  '.gr-pad { border: 2px solid #4a4236; background: rgba(10,8,6,.15); display: flex; flex-direction: column; align-items: center; justify-content: center; transition: background .08s, border-color .08s, transform .08s; }',
  '.gr-pad b { font-size: 34px; font-weight: 900; color: #6b6150; }',
  '.gr-pad small { font-size: 8px; letter-spacing: 3px; color: #6b6150; }',
  '.gr-pad.next { border-color: #f2c14a; }',
  '.gr-pad.next b, .gr-pad.next small { color: #f2c14a; }',
  '.gr-pad.hit { background: rgba(242,193,74,.28); transform: scale(.97); }',
  '.gr-pad.slip { border-color: #ff3b2a; background: rgba(165,15,12,.45); }',
  '.gr-pad.slip b, .gr-pad.slip small { color: #ff3b2a; }',
  '.gr.off .gr-pads, .gr.off .gr-gap { opacity: 0; transition: opacity .6s; }',
].join('\n');

const DOWN = new THREE.Vector3(0, -1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

export const createGrinder: GameFactory = (ctx) => {
  const { engine, hud, rng, start } = ctx;
  const scene = engine.scene;
  engine.renderer.localClippingEnabled = true;
  const room = buildFactory(scene);
  const gore = new Gore(engine, room.surfaces, room.walls, { onImpact: (v) => sound.splat(v) });
  const sparks = new Sparks(scene);
  const cam = engine.camera;
  cam.fov = 84;
  cam.updateProjectionMatrix();

  const numbers = new Set<number>();
  const numberFor = () => {
    let n = rng.int(1, 99);
    while (numbers.has(n)) n = (n % 99) + 1;
    numbers.add(n);
    return n;
  };
  const kinds: Kind[] = ['steady', 'panicky', 'showoff'];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

  const me = start.players.find((p) => p.id === start.you) ?? start.players[0];
  const others = start.players.filter((p) => p !== me).slice(0, LANES.length - 1);
  const botLanes = LANES.map((_, i) => i).filter((i) => i !== ME_LANE);
  const auto = new URLSearchParams(location.search).has('auto');
  const tp = new URLSearchParams(location.search).has('tp');

  const makeRunner = (info: PlayerInfo, lane: number, botIndex: number): Runner => {
    const you = info === me;
    const number = numberFor();
    const subject = new Subject({ number, hat: info.hat, limbs: info.limbs, seated: true });
    subject.root.rotation.y = Math.PI;
    scene.add(subject.root);
    subject.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m) return;
      m.clippingPlanes = [CLIP];
      m.clipShadows = true;
    });
    if (you) {
      subject.neck.visible = false;
      subject.hand('r').scale.setScalar(1.5);
      subject.hand('l').scale.setScalar(1.5);
    }
    const legs = (['rl', 'll'] as const).filter((l) => subject.limbs[l].attached).length;
    let brain: Brain | null = null;
    if (info.isBot && !you) {
      const p = PERSONALITIES[kinds[botIndex % kinds.length]];
      brain = { p, max0: rng.range(...p.base), nextTap: rng.range(0, 0.3), pauseUntil: 0 };
    } else if (you && auto) brain = { p: PERSONALITIES.steady, max0: 8.2, nextTap: 0, pauseUntil: 0 };
    return {
      info,
      number,
      you,
      x: LANES[lane],
      subject,
      brain,
      p: P_START + (you ? 0 : rng.range(-0.25, 0.25)),
      front: legs ? LEG_REACH : 0.16,
      hv: 0,
      last: null,
      slipT: 0,
      slipAt: -9,
      slipHand: null,
      alive: true,
      state: 'belt',
      feed: 0,
      feedV: 0,
      inBite: false,
      bites: 0,
      minP: 99,
      slips: 0,
      hauled: 0,
      taps: 0,
      endAt: 0,
      cause: '',
      grip: { L: 9, R: 9 },
      lean: 0.15,
      fx: { gib: 0, crunch: 0, gutted: false, headGone: false },
    };
  };
  const you = makeRunner(me, ME_LANE, -1);
  const runners = [you, ...others.map((p, i) => makeRunner(p, botLanes[i], i))];
  const quota = runners.length >= 4 ? 2 : 1;
  const tag = (r: Runner) => '#' + String(r.number).padStart(2, '0') + ' ' + r.info.name.toUpperCase();

  let phase: 'intro' | 'run' = 'intro';
  let simT = 0;
  let acc = 0;
  let step = 0;
  let travel = 0;
  let v = 0;
  let over = false;
  let overAt = 0;
  let finished = false;
  let kills = 0;
  let youDeadAt = -1;
  let covered = false;
  let surge = { at: rng.range(11, 15), warn: 1.1, run: 0, k: 1, start: -1 };
  let surgeOn = false;
  let surgeWarn = false;
  let overdrive = false;
  const inputs: Hand[] = [];
  /** [step, hand] for every human tap, for replay / sync. */
  const inputLog: [number, Hand][] = [];
  const devKills: Runner[] = [];
  const glance = new THREE.Vector3();
  let glanceK = 0;
  let watchK = 0;
  const watchPt = new THREE.Vector3();
  let boardT = 0;
  let motorLoad = 0;

  function baseSpeed(t: number) {
    const ramp = smooth(clamp(t / 2, 0, 1));
    return ramp * (0.5 + 0.017 * t) + (t > ROUND ? (t - ROUND) * 0.3 : 0);
  }

  function surgeTick() {
    if (!surgeWarn && !surgeOn && simT >= surge.at) {
      surgeWarn = true;
      sound.klaxon(1.1);
    }
    if (surgeWarn && simT >= surge.at + surge.warn) {
      surgeWarn = false;
      surgeOn = true;
      surge.start = simT;
      surge.run = rng.range(1.0, 1.6);
      surge.k = rng.range(1.5, 1.85);
      engine.shake(0.25);
      ctx.haptic('heavy');
    }
    if (surgeOn && simT >= surge.start + surge.run) {
      surgeOn = false;
      surge = { at: simT + rng.range(7, 12), warn: 1.1, run: 0, k: 1, start: -1 };
    }
  }

  function tap(r: Runner, hand: Hand) {
    if (!r.alive || r.state !== 'belt' || over) return;
    if (r.slipT > 0) return;
    if (r.last === hand) {
      r.slipT = SLIP_LOCK;
      r.slipAt = simT;
      r.slipHand = hand;
      r.hv = 0;
      r.p -= SLIP_YANK;
      r.slips++;
      r.last = null;
      r.subject.flinch(rand(-1, 1));
      if (r.you) {
        sound.scrape();
        engine.shake(0.35);
        engine.flash(0.12, 0xff2010);
        ctx.haptic('heavy');
        padSlip(hand);
      } else if (Math.abs(r.x - you.x) < 1) sound.scrape();
      return;
    }
    const arm = r.subject.limbs[hand === 'R' ? 'ra' : 'la'].attached;
    r.hv += PULL * HAUL_DECAY * (arm ? 1 : 0.5);
    r.last = hand;
    r.taps++;
    r.grip[hand] = 0;
    if (r.you) {
      sound.grab();
      ctx.haptic('light');
    }
  }

  function brainTick(r: Runner) {
    const b = r.brain!;
    if (simT < b.nextTap) return;
    if (r.slipT > 0) {
      b.nextTap = simT + r.slipT + rng.range(0.05, 0.2);
      return;
    }
    const P = b.p;
    if (simT < b.pauseUntil) return;
    if (P.pause > 0 && r.p > 1.6 && rng.chance(P.pause)) {
      b.pauseUntil = simT + rng.range(0.45, 0.95);
      b.nextTap = b.pauseUntil;
      return;
    }
    const seen = surgeOn && simT - surge.start < P.react ? baseSpeed(simT) : v;
    const maxRate = Math.max(2.5, b.max0 - P.decay * simT);
    const want = (seen + P.gain * (P.target - r.p)) / PULL;
    const panic = clamp((1.2 - r.p) / 1.2, 0, 1);
    const rate = lerp(clamp(want, 0, maxRate), maxRate, panic * (P.kind === 'panicky' ? 1 : 0.6));
    if (rate < 0.6) {
      b.nextTap = simT + 0.12;
      return;
    }
    const slipP = P.slip + P.panicSlip * panic + (rate > maxRate * 0.95 ? 0.025 : 0);
    const hand: Hand = r.last && rng.chance(slipP) ? r.last : r.last === 'L' ? 'R' : 'L';
    tap(r, hand);
    b.nextTap = simT + (1 / rate) * (1 + rng.range(-P.jitter, P.jitter));
  }

  function bite(r: Runner) {
    r.inBite = true;
    r.bites++;
    const s = r.subject;
    const leg = (['rl', 'll'] as const).find((l) => s.limbs[l].attached && s.limbs[l].end.visible);
    const at = new THREE.Vector3(r.x, BELT_Y + 0.12, GZ + 0.05);
    sound.grind(r.you || Math.abs(r.x - you.x) < 1 ? 0.8 : 0.4);
    sparks.emit(r.x, BELT_Y + 0.1, GZ + 0.02, 30, 1.3);
    if (leg) {
      const L = s.limbs[leg];
      L.end.getWorldPosition(at);
      L.end.visible = false;
      gore.spray(at, new THREE.Vector3(0, 1, 0.6).normalize(), 140, [1.5, 4.5], 0.4);
      for (let i = 0; i < 4; i++) gore.gib(i % 2 ? 'bone' : 'meat', at, new THREE.Vector3(rand(-0.8, 0.8), rand(1.5, 3), rand(0.8, 2.5)), 0.8);
      gore.stump(L.joint, new THREE.Vector3(0, -0.42, 0), new THREE.Vector3(0, -1, 0), 4, 1.8, 0.7);
      hud.feed(r.you ? '<b>FOOT LOST.</b>' : '<b>' + tag(r) + '</b> lost a foot.');
    }
    if (r.you) {
      ctx.haptic('heavy');
      engine.shake(0.5);
      engine.flash(0.25, 0xff1a0a);
      engine.lens.burst(0.5, 0.75, 0.5);
    } else {
      s.flinch(rand(-1, 1));
      if (Math.abs(r.x - you.x) < 1) ctx.haptic('light');
    }
  }

  function escape(r: Runner) {
    r.inBite = false;
    if (r.you) {
      hud.feed('<b>NEAR MISS.</b>');
      sound.sting();
    }
  }

  function causeFor(r: Runner) {
    if (simT - r.slipAt < 0.9) return 'Slipped. Fed feet-first into The Grinder';
    if (surgeOn) return 'Caught by a belt surge';
    if (overdrive) return 'Outpaced by the overdrive';
    if (r.front < 0.5) return 'Fed hips-first into The Grinder';
    return 'Fed feet-first into The Grinder';
  }

  function catchRunner(r: Runner, cause = causeFor(r)) {
    if (!r.alive) return;
    r.alive = false;
    r.state = 'feed';
    r.feed = -r.p;
    r.feedV = 0.45;
    r.p = 0;
    r.endAt = simT;
    r.cause = cause;
    kills++;
    ctx.death(r.info.id, cause);
    const s = r.subject;
    if (r.you) s.torso.children.forEach((c) => c instanceof THREE.Mesh && (c.visible = false));
    else s.die('fall');
    const contact = new THREE.Vector3(r.x, BELT_Y + 0.12, GZ + 0.05);
    for (const leg of ['rl', 'll'] as const) {
      const L = s.limbs[leg];
      if (!L.attached || !L.end.visible || rand(0, 1) < 0.5) continue;
      gore.throwObject(L.end, new THREE.Vector3(rand(-0.6, 0.6), rand(2.5, 4), rand(1.2, 2.4)), new THREE.Vector3(rand(-14, 14), rand(-14, 14), rand(-14, 14)), 0.06, 1.2);
      gore.stump(L.joint, new THREE.Vector3(0, -0.42, 0), new THREE.Vector3(0, -1, 0), 3, 2, 0.9);
    }
    gore.spray(contact, new THREE.Vector3(0, 1, 0.9).normalize(), 220, [2, 6], 0.45);
    sparks.emit(r.x, BELT_Y + 0.1, GZ + 0.02, 60, 1.6);
    sound.grind(1.4);
    engine.slowmo(0.7, 0.3);
    room.rollerMat.color.lerp(new THREE.Color(0x6a1010), 0.35);
    room.teethMat.color.lerp(new THREE.Color(0x8a2020), 0.35);
    for (const o of runners) if (o !== r && o.alive) o.subject.flinch(o.x - r.x);
    if (r.you) {
      youDeadAt = simT;
      engine.shake(1);
      engine.flash(0.5, 0xff2a10);
      sound.muffle(0.35);
      ui.classList.add('off');
      return;
    }
    engine.shake(0.35 + Math.max(0, 1.6 - Math.abs(r.x - you.x)) * 0.25);
    ctx.haptic('heavy');
    glance.set(r.x, BELT_Y + 0.3, GZ + 0.4);
    glanceK = 1;
    hud.feed('<b>' + tag(r) + '</b> processed.');
  }

  function endCheck() {
    if (over) return;
    const alive = runners.filter((r) => r.alive);
    if (alive.length > quota) return;
    over = true;
    overAt = simT;
    for (const r of alive) r.hv = 0;
    hud.feed('<b>BELT STOPPED.</b>');
    sound.sting();
  }

  function simStep() {
    step++;
    simT += STEP;
    if (!over) surgeTick();
    overdrive = !over && simT > ROUND;
    v = over ? v * Math.exp(-2.5 * STEP) : baseSpeed(simT) * (surgeOn ? surge.k : 1);
    travel += v * STEP;
    room.beltSurface.vel!.z = -v;
    while (devKills.length) catchRunner(devKills.shift()!, 'Fed to The Grinder by the operator');
    for (const r of runners) {
      if (r.state === 'belt') {
        if (r.alive && !over) {
          if (r.brain) brainTick(r);
          if (r.you)
            while (inputs.length) {
              const h = inputs.shift()!;
              inputLog.push([step, h]);
              tap(r, h);
            }
        }
        r.slipT = Math.max(0, r.slipT - STEP);
        const drag = over ? v : v + (r.p < BITE ? BITE_DRAG : 0) + (r.slipT > 0 ? SLIP_DRAG : 0);
        r.p += (r.hv - drag) * STEP;
        r.hauled += r.hv * STEP;
        r.hv *= Math.exp(-HAUL_DECAY * STEP);
        if (r.p > P_MAX) {
          r.p = P_MAX;
          r.hv = 0;
        }
        r.minP = Math.min(r.minP, r.p);
        for (const h of ['L', 'R'] as const) r.grip[h] += STEP;
        if (!over && r.p < BITE && !r.inBite) bite(r);
        else if (r.inBite && r.p > BITE + 0.35) escape(r);
        if (r.p <= 0 && !over) catchRunner(r);
      } else if (r.state === 'feed') {
        r.feedV = Math.min(1.1, r.feedV + 0.45 * STEP);
        r.feed += r.feedV * STEP;
        if (r.feed > FEED_OUT) {
          r.state = 'gone';
          r.subject.root.visible = false;
        }
      }
    }
    endCheck();
    if (over && !finished && simT > overAt + 2.4 && !runners.some((r) => r.state === 'feed')) finish();
  }

  function finish() {
    finished = true;
    sound.motor(false);
    sound.beat(false);
    const alive = runners.filter((r) => r.alive).sort((a, b) => b.p - a.p);
    const dead = runners.filter((r) => !r.alive).sort((a, b) => b.endAt - a.endAt);
    const order = [...alive, ...dead];
    const placements: Placement[] = order.map((r, i) => ({ id: r.info.id, place: i + 1, status: r.alive ? 'survived' : 'dead', score: Math.round(r.hauled * 10) / 10 }));
    const kept = (r: Runner): Limb[] =>
      (['ra', 'la', 'rl', 'll'] as const).filter((l) => r.subject.limbs[l].attached && r.subject.limbs[l].end.visible);
    ctx.finish(placements, Object.fromEntries(runners.filter((r) => r.alive).map((r) => [r.info.id, kept(r)])));
    console.log(
      '[round]',
      JSON.stringify({ t: simT.toFixed(1), perf: engine.perf(), taps: inputLog.length, runners: runners.map((r) => [r.info.name, r.brain?.p.kind, r.alive ? 'retained' : r.cause, r.endAt.toFixed(1), r.slips, r.bites, r.minP.toFixed(2)]) }),
    );
    const pool = !you.alive ? (you.cause.startsWith('Slipped') ? REMARKS.slipped : REMARKS.ground) : you.bites ? REMARKS.maimed : REMARKS.retained;
    const feet = you.alive ? (['rl', 'll'] as const).filter((l) => you.subject.limbs[l].attached && you.subject.limbs[l].end.visible).length : 0;
    hud.assessment({
      kicker: 'SIMULATION 03 \u00b7 THE GRINDER',
      subject: 'SUBJECT ' + tag(you),
      verdict: you.alive ? 'RETAINED' : 'TERMINATED',
      lines: [
        ['TIME ON BELT', (you.alive ? simT : you.endAt).toFixed(1) + ' s'],
        ['METRES HAULED', you.hauled.toFixed(1) + ' m'],
        ['SLIPS', String(you.slips)],
        ['CLOSEST CALL', you.minP <= 0 ? 'Contact' : Math.round(you.minP * 100) + ' cm'],
        ...(feet < 2 && you.alive ? [['FEET', feet + ' / 2'] as [string, string]] : []),
        ...(you.alive ? [] : [['CAUSE', you.cause] as [string, string]]),
      ],
      remark: pool[rng.int(0, pool.length - 1)],
      table: order.map((r) => tag(r) + ' \u2014 ' + (r.alive ? 'RETAINED' : 'PROCESSED') + (r.you ? ' (you)' : '')),
      fine: '',
    });
  }

  // Input: left half / right half of the screen, or A / D and the arrow keys.
  const css = document.createElement('style');
  css.textContent = PADS_CSS;
  document.head.appendChild(css);
  const ui = document.createElement('div');
  ui.className = 'gr';
  ui.innerHTML =
    '<div class="gr-gap"><small>GAP</small><b>' +
    P_START.toFixed(1) +
    '</b><i>m</i></div><div class="gr-pads"><div class="gr-pad L next"><b>L</b></div><div class="gr-pad R next"><b>R</b></div></div>';
  hud.root.appendChild(ui);
  const gapEl = ui.querySelector('.gr-gap') as HTMLElement;
  const gapNum = gapEl.querySelector('b') as HTMLElement;
  const padEl = { L: ui.querySelector('.gr-pad.L') as HTMLElement, R: ui.querySelector('.gr-pad.R') as HTMLElement };

  function padSlip(hand: Hand) {
    for (const h of ['L', 'R'] as const) padEl[h].classList.add('slip');
    padEl[hand].classList.remove('hit');
    setTimeout(() => (['L', 'R'] as const).forEach((h) => padEl[h].classList.remove('slip')), SLIP_LOCK * 1000);
  }

  const canTap = () => phase === 'run' && you.alive && !over && !auto;
  function press(hand: Hand) {
    if (!canTap()) return;
    inputs.push(hand);
    padEl[hand].classList.add('hit');
    setTimeout(() => padEl[hand].classList.remove('hit'), 90);
  }
  ctx.surface.addEventListener('pointerdown', (e) => {
    if (!canTap()) return;
    e.preventDefault();
    const rect = ctx.surface.getBoundingClientRect();
    press(e.clientX < rect.left + rect.width / 2 ? 'L' : 'R');
  });
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') press('L');
    else if (e.code === 'KeyD' || e.code === 'ArrowRight') press('R');
    else if (!inApp() && phase === 'run') {
      const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
      const r = e.code === 'KeyY' ? you : i >= 0 ? runners[i + 1] : null;
      if (r?.alive) devKills.push(r);
    }
  });

  // Visuals.
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const qx = new THREE.Quaternion();

  /** Two-bone reach of one arm toward a world point (planar, elbow down and back). */
  function reachArm(r: Runner, hand: Hand, target: THREE.Vector3) {
    const s = r.subject;
    const L = s.limbs[hand === 'R' ? 'ra' : 'la'];
    if (!L.attached) return;
    const local = s.torso.worldToLocal(tmp2.copy(target)).sub(L.root.position);
    const a = 0.28, b = 0.27;
    const d = clamp(local.length(), 0.12, a + b - 0.001);
    local.normalize();
    const alpha = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
    const gamma = Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
    L.root.quaternion.setFromUnitVectors(DOWN, local).multiply(qx.setFromAxisAngle(X_AXIS, alpha));
    L.joint.rotation.set(-(Math.PI - gamma), 0, 0);
  }

  function poseRunner(r: Runner, dt: number, t: number) {
    const s = r.subject;
    const z = r.state === 'belt' ? GZ + r.front + r.p : GZ + r.front - r.feed;
    s.root.position.set(r.x, HIP_Y - 0.47, z);
    const danger = clamp(1 - r.p / 1.4, 0, 1);
    if (r.state === 'belt') {
      const hauling = Math.min(r.grip.L, r.grip.R) < 0.32;
      const target = over ? -0.22 : hauling ? -0.1 - danger * 0.15 : 0.16 + danger * 0.1;
      r.lean = damp(r.lean, target, 8, dt);
      if (!r.you) {
        const victim = runners.find((o) => o.state === 'feed' && o !== r);
        s.lookAt = victim
          ? victim.subject.headWorld(new THREE.Vector3())
          : danger > 0.3
            ? new THREE.Vector3(r.x, BELT_Y, GZ)
            : new THREE.Vector3(r.x + Math.sin(t * 0.4 + r.number) * 0.8, BELT_Y + 0.4, GZ - 0.5);
      }
      s.freeze = danger > 0.5;
    }
    s.update(dt, t);
    const L = s.limbs;
    for (const leg of ['rl', 'll'] as const) {
      if (!L[leg].attached) continue;
      L[leg].root.rotation.set(-Math.PI / 2 + 0.05, 0, leg === 'rl' ? 0.06 : -0.06);
      L[leg].joint.rotation.x = 0;
    }
    if (r.state === 'belt') {
      s.torso.rotation.x = r.lean;
      s.root.updateMatrixWorld(true);
      for (const hand of ['L', 'R'] as const) {
        const side = hand === 'R' ? 1 : -1;
        const g = r.grip[hand];
        let fwd: number;
        let lift = 0;
        if (r.slipT > 0 && r.slipHand === hand) {
          const k = 1 - r.slipT / SLIP_LOCK;
          fwd = 0.7 + k * 0.25;
          lift = Math.sin(k * Math.PI) * 0.3 + 0.05;
        } else if (over) {
          fwd = 0.12;
          lift = 0.06;
        } else if (g < 0.06) fwd = lerp(0.3, 0.62, smooth(g / 0.06));
        else if (g < 0.32) fwd = lerp(0.62, 0.18, smooth((g - 0.06) / 0.26));
        else fwd = lerp(0.18, 0.32, smooth(clamp((g - 0.32) / 0.3, 0, 1)));
        if (g > 0.32 && !over) lift = 0.04 + Math.sin(t * 7 + side) * 0.01 * (1 + danger * 4);
        reachArm(r, hand, tmp.set(r.x + side * (r.you ? RAIL_X - 0.04 : RAIL_X), RAIL_Y + 0.03 + lift, z - fwd));
      }
    } else if (r.state === 'feed') {
      for (const [arm, sgn] of [['ra', -1], ['la', 1]] as const) {
        if (!L[arm].attached) continue;
        L[arm].root.rotation.set(-2.4 + Math.sin(t * 19 + sgn) * 0.7, 0, sgn * (0.5 + Math.sin(t * 13 + sgn * 2) * 0.4));
        L[arm].joint.rotation.x = -0.6 + Math.sin(t * 23) * 0.5;
      }
    }
  }

  function feedFx(r: Runner, dt: number) {
    const s = r.subject;
    const near = Math.abs(r.x - you.x) < 1.2 || r.you;
    r.fx.gib -= dt;
    r.fx.crunch -= dt;
    const hipsIn = s.root.position.z < GZ + 0.12;
    const contact = tmp.set(r.x + rand(-0.14, 0.14), BELT_Y + 0.14, GZ + 0.04);
    gore.spray(contact, tmp2.set(rand(-0.3, 0.3), 1, rand(0.8, 1.5)).normalize(), Math.ceil((hipsIn ? 160 : 90) * dt), [1.5, 5.5], 0.35, [0.008, 0.024]);
    if (rand(0, 1) < 12 * dt) sparks.emit(r.x, BELT_Y + 0.1, GZ + 0.02, 6, 1.2);
    if (r.fx.gib <= 0) {
      r.fx.gib = rand(0.035, 0.08);
      gore.gib(rand(0, 1) < 0.35 ? 'bone' : 'meat', contact, tmp2.set(rand(-1, 1), rand(2, 4.5), rand(0.8, 3.2)), rand(0.8, 1.5));
    }
    if (r.fx.crunch <= 0) {
      r.fx.crunch = rand(0.12, 0.2);
      sound.grind(near ? rand(0.7, 1.1) : rand(0.3, 0.5));
      if (r.you) ctx.haptic('heavy');
    }
    if (hipsIn && !r.fx.gutted) {
      r.fx.gutted = true;
      s.gutSpill(gore);
      gore.spray(contact, tmp2.set(0, 1, 1).normalize(), 260, [2, 7], 0.5, [0.01, 0.03]);
      for (let i = 0; i < 6; i++) gore.gib('meat', contact, tmp2.set(rand(-1.2, 1.2), rand(2.5, 5), rand(1, 3)), 1.4);
      sound.squelch(1.5);
      engine.shake(r.you ? 0.7 : 0.3);
      if (near) engine.slowmo(0.4, 0.4);
    }
    if (!r.fx.headGone && s.headWorld(tmp2).z < GZ + 0.18) {
      r.fx.headGone = true;
      if (r.you) return;
      s.explodeHead(gore, new THREE.Vector3(rand(-0.3, 0.3), 0.9, 1).normalize());
      sound.crunch(1.6);
      sound.squelch(1.3);
      engine.shake(0.4);
      const at = s.headWorld(new THREE.Vector3());
      const dist = at.distanceTo(cam.position);
      if (dist < 3.4) {
        const ndc = at.project(cam);
        engine.lens.burst(clamp((ndc.x + 1) / 2, 0.15, 0.85), clamp((1 - ndc.y) / 2, 0.2, 0.7), (3.4 - dist) / 2);
      }
    }
  }

  function cameraTick(dt: number, t: number) {
    const head = you.subject.headWorld(new THREE.Vector3());
    if (tp) {
      cam.position.set(2.2, 1.6, head.z + 0.4);
      cam.lookAt(-0.33, 0.6, head.z - 1.2);
      return;
    }
    if (youDeadAt >= 0) {
      const k = simT - youDeadAt;
      const hips = you.subject.root.position;
      cam.position.set(you.x, HIP_Y + 0.62 - Math.min(k, 1.5) * 0.2, Math.max(hips.z + 0.05, GZ + 0.22));
      const thrash = Math.min(1, k * 2);
      cam.lookAt(you.x + Math.sin(t * 9) * 0.15 * thrash, BELT_Y + 0.08, GZ - 0.2);
      cam.rotateZ(Math.sin(t * 27) * 0.08 * thrash);
      engine.shake(dt * 2.5);
      if (rand(0, 1) < 5 * dt) engine.lens.splat(rand(0.2, 0.8), rand(0.3, 0.9), rand(4, 10));
      if (!covered && (cam.position.z < GZ + 0.45 || k > 2.6)) {
        covered = true;
        engine.lens.cover();
        engine.flash(0.9, 0xff3010);
        engine.shake(1);
        sound.crunch(1.6);
        sound.squelch(1.6);
        sound.ring(4);
        sound.muffle(0.8);
        hud.stamp('PROCESSED');
      }
      return;
    }
    glanceK = Math.max(0, glanceK - dt * 0.6);
    const danger = clamp(1 - you.p / 1.6, 0, 1);
    cam.position.copy(head).add(tmp.set(0, 0.03, -0.09));
    const look = tmp.set(you.x, BELT_Y + 0.1 - danger * 0.1, Math.max(GZ - 0.3, head.z - 2.2 + danger * 0.5));
    let watch: Runner | null = null;
    let watchW = 0;
    for (const r of runners) {
      if (r === you || r.state !== 'belt' || !r.alive) continue;
      const w = clamp((you.p - r.p - 0.5) / 1.2, 0, 1) * clamp((1.6 - r.p) / 1.2, 0, 1);
      if (w > watchW) {
        watch = r;
        watchW = w;
      }
    }
    watchK = damp(watchK, watchW, 3, dt);
    if (watch) watchPt.set(watch.x, BELT_Y + 0.3, GZ + watch.front * 0.5 + watch.p);
    if (watchK > 0.01) look.lerp(watchPt, watchK * 0.55);
    if (glanceK > 0) look.lerp(glance, smooth(Math.min(1, glanceK * 1.4)) * 0.6);
    look.y += Math.sin(t * 0.6) * 0.02;
    cam.lookAt(look);
    if (you.slipT > 0) cam.rotateZ(Math.sin((you.slipT / SLIP_LOCK) * Math.PI) * (you.slipHand === 'L' ? 0.08 : -0.08));
    engine.shake(Math.max(0, 0.9 - you.p) * dt * 1.4);
    const fov = 84 - danger * 6;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, 4, dt);
      cam.updateProjectionMatrix();
    }
  }

  function hudTick(dt: number) {
    if (!finished) hud.setTimer(Math.max(0, ROUND - simT));
    const danger = you.alive ? clamp(1 - you.p / 1.6, 0, 1) : 0;
    if (!you.alive || phase === 'intro') hud.setStatus('', 'hidden');
    else if (over) hud.setStatus('SHIFT COMPLETE', 'calm');
    else if (you.slipT > 0) hud.setStatus('SLIPPED', 'danger');
    else if (you.p < BITE) hud.setStatus('IT HAS YOUR FEET', 'danger');
    else if (overdrive) hud.setStatus('OVERDRIVE', 'danger');
    else if (surgeWarn || surgeOn) hud.setStatus('SURGE', 'warn');
    else if (you.p < 1) hud.setStatus('HAUL', 'warn');
    else hud.setStatus('', 'hidden');
    engine.tint = damp(engine.tint, you.alive ? danger * 0.4 + (you.p < BITE ? 0.2 : 0) : 0.3, 6, dt);
    if (you.alive) {
      const gap = Math.max(0, you.p);
      gapNum.textContent = gap.toFixed(1);
      gapEl.className = 'gr-gap ' + (gap < 0.6 ? 'danger' : gap < 1.4 ? 'warn' : '');
      const next: Hand | null = you.last === 'L' ? 'R' : you.last === 'R' ? 'L' : null;
      for (const h of ['L', 'R'] as const) padEl[h].classList.toggle('next', you.slipT <= 0 && (next === null || next === h));
    }
    boardT += dt;
    if (boardT > 0.12) {
      boardT = 0;
      hud.setBoard(
        runners.map((r) => ({
          name: tag(r),
          value: Math.max(0, r.p),
          max: P_MAX,
          me: r.you,
          dead: !r.alive,
          done: over && r.alive,
          label: !r.alive ? 'GROUND' : over ? 'RETAINED' : Math.max(0, r.p).toFixed(1) + 'm',
        })),
      );
    }
  }

  function machineTick(dt: number, t: number) {
    room.belt.offset.y = -((travel / 0.5) % 1);
    const feeding = runners.some((r) => r.state === 'feed');
    const spin = (over && !feeding ? Math.max(0, 1 - (simT - overAt)) : 1) * (2.5 + v * 3);
    for (const r of room.rollers) r.grp.rotation.x += r.dir * spin * dt;
    motorLoad = damp(motorLoad, feeding ? 1 : you.alive && you.p < BITE ? 0.5 : 0, 6, dt);
    sound.motorLoad(motorLoad);
    const alarm = surgeWarn || surgeOn || overdrive || feeding;
    room.beaconMat.forEach((m, i) => m.color.setHex(Math.sin(t * (alarm ? 14 : 5) + i * Math.PI) > 0 ? 0xff2010 : 0x2a0000));
    room.mouthLight.intensity = 2.5 + Math.sin(t * 8) * 1.2 + (feeding ? 3 : 0);
    room.innerLight.intensity = 2.2 + Math.random() * 0.8;
    for (const f of room.flickers) f.update(dt);
    if (spin > 1 && rand(0, 1) < 10 * dt) sparks.emit(rand(-MOUTH.x + 0.1, MOUTH.x - 0.1), BELT_Y + 0.1, GZ + 0.02, Math.ceil(rand(1, 4)), 0.8);
    if (kills > 0 && spin > 1 && rand(0, 1) < (6 + kills * 6) * dt)
      gore.spray(tmp.set(rand(-MOUTH.x, MOUTH.x), BELT_Y + 0.15, GZ + 0.02), tmp2.set(0, 1, 0.7).normalize(), 2, [0.4, 1.8], 0.7, [0.004, 0.01]);
    (scene.fog as THREE.FogExp2).color.setRGB(0.035 + Math.min(kills, 3) * 0.018, 0.024, 0.02);
    sparks.update(dt);
    sound.intensity = you.alive ? 0.45 + clamp(1 - you.p / 2, 0, 1) * 0.55 : 0.8;
  }

  hud.setTitle('SIMULATION 03', 'THE GRINDER');
  hud.setPot(start.pot);
  hud.setLimbs(me.limbs);
  hud.setTimer(ROUND);
  void hud
    .intro('SIMULATION 03', 'THE GRINDER', ['TAP <b>LEFT</b>, <b>RIGHT</b>, <b>LEFT</b>. HAUL AWAY FROM THE TEETH.', '<b>SAME HAND TWICE</b> AND YOU SLIP.'])
    .then(() => {
      sound.unlock();
      sound.drone(true);
      sound.beat(true);
      sound.motor(true);
      sound.bpm = 108;
      phase = 'run';
    });
  if (auto) document.querySelector<HTMLElement>('.overlay')?.dispatchEvent(new PointerEvent('pointerdown'));

  function frame(dt: number, t: number) {
    if (phase === 'run') {
      acc += dt;
      while (acc >= STEP) {
        acc -= STEP;
        simStep();
      }
    } else travel += 0.15 * dt;
    for (const r of runners) {
      if (r.state === 'gone') continue;
      poseRunner(r, dt, t);
      if (r.state === 'feed') feedFx(r, dt);
    }
    machineTick(dt, t);
    gore.update(dt);
    cameraTick(dt, t);
    hudTick(dt);
  }

  return {
    update(dt, t) {
      const ff = youDeadAt >= 0 && simT - youDeadAt > 3.2 && !finished ? 3 : 1;
      for (let i = 0; i < ff; i++) frame(dt, t + i * dt);
    },
  };
};
