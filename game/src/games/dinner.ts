import * as THREE from 'three';
import { sound } from '../shared/audio';
import type { GameFactory } from '../shared/game';
import { Gore, type Surface, type Wall } from '../shared/gore';
import { TouchPad } from '../shared/input';
import type { PlayerInfo } from '../shared/protocol';
import { Flicker } from '../shared/renderer';
import { Subject } from '../shared/rig';
import { canvasTex, Tex } from '../shared/textures';
import { clamp, damp, lerp, rand, smooth } from '../shared/util';
import {
  type Act,
  advance,
  type BotPlan,
  botFrame,
  botPlan,
  CAUSE,
  CHEW,
  DROP,
  type DinnerView,
  type Fork,
  hostAt,
  liftOf,
  LOWER,
  MAX_LOAD,
  newReferee,
  type Outcome,
  PEAS,
  type Placement,
  placements,
  RAISE,
  recordAct,
  ROUND,
  type Seat,
  type Segment,
  STAB,
  tableFor,
} from './dinner-rules';

/*
 * DINNER PARTY. Eat your peas while the host reads. If he sees you moving (stabbing, lifting,
 * chewing), he shoots your head off with the Desert Eagle by his plate. Finish your plate to be
 * excused; the last diner still eating is shot, and anyone still eating at the bell is shot.
 *
 * The rules (host schedule, bot plans, who dies when) live in dinner-rules.ts and are a pure
 * function of the seed plus the humans' fork moves. Solo rounds referee locally; online rounds
 * send fork moves to the Convex server, which referees for every phone.
 */

const TABLE_Y = 0.76;
const TABLE = { x: 0.42, z0: -4.25, z1: 0.42 };
const ROOM = { x: 2, z0: -5.4, z1: 1.6, h: 3.2 };
const CAM = new THREE.Vector3(0, 1.17, 0.62);
const LOOK = new THREE.Vector3(0, 0.72, -3.0);
const HOST_Z = -4.62;
const SEATS = [
  { x: 0.58, z: -1.5 },
  { x: -0.58, z: -2.2 },
  { x: 0.58, z: -2.9 },
];

type Shot = 'head' | 'arm' | 'gut';

interface Diner {
  info: PlayerInfo;
  number: number;
  you: boolean;
  subject: Subject | null;
  plate: Plate;
  /** Bots follow a precomputed plan; humans have none. */
  plan: BotPlan | null;
  fork: Fork;
  forkT: number;
  lift: number;
  dropFrom: number;
  loaded: number;
  eaten: number;
  alive: boolean;
  done: boolean;
  endAt: number;
  cause: string;
  forkPeas: THREE.Mesh[];
}

/** Who decides deaths: the local referee (solo) or the server (online). */
interface Authority {
  act(a: Act): void;
  poll(t: number): Outcome[];
  latest(id: string): Act | undefined;
  over(): boolean;
  placements(): Placement[];
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

const PEA_GEO = new THREE.IcosahedronGeometry(0.0105, 0);
const PEA_MAT = lam(0x6a8a2e, { emissive: 0x0b1203 });

class Plate {
  readonly peas: THREE.InstancedMesh;
  private spots: THREE.Vector3[] = [];
  remaining = PEAS;

  constructor(parent: THREE.Object3D, x: number, z: number) {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.11, 0.02, 14), lam(0xd9d2c2));
    plate.position.set(x, TABLE_Y + 0.012, z);
    plate.receiveShadow = true;
    parent.add(plate);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.006, 4, 14), lam(0x8a7a5a));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x, TABLE_Y + 0.022, z);
    parent.add(rim);
    this.peas = new THREE.InstancedMesh(PEA_GEO, PEA_MAT, PEAS);
    this.peas.castShadow = true;
    for (let i = 0; i < PEAS; i++) {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 0.075 * (1 - i / PEAS / 2);
      this.spots.push(new THREE.Vector3(x + Math.cos(a) * r, TABLE_Y + 0.034 + (i / PEAS) * 0.02, z + Math.sin(a) * r));
    }
    parent.add(this.peas);
    this.sync();
  }

  sync() {
    const m = new THREE.Matrix4();
    for (let i = 0; i < PEAS; i++) {
      m.makeTranslation(this.spots[i]);
      if (i >= this.remaining) m.scale(new THREE.Vector3(0, 0, 0));
      this.peas.setMatrixAt(i, m);
    }
    this.peas.instanceMatrix.needsUpdate = true;
  }
}

function forkMesh(scale = 1) {
  const g = new THREE.Group();
  const m = new THREE.MeshLambertMaterial({ color: 0xb8bcc0, emissive: 0x111111, flatShading: true });
  box(0.012, 0.006, 0.17, m, g, 0, 0.004, 0.11, false);
  box(0.026, 0.005, 0.03, m, g, 0, 0, 0.01, false);
  for (let i = 0; i < 4; i++) box(0.003, 0.004, 0.05, m, g, -0.0098 + i * 0.0065, 0, -0.025, false);
  const peas: THREE.Mesh[] = [];
  for (let i = 0; i < MAX_LOAD; i++) {
    const p = new THREE.Mesh(PEA_GEO, PEA_MAT);
    p.position.set(((i % 2) - 0.5) * 0.012, 0.01, -0.012 - i * 0.009);
    p.visible = false;
    g.add(p);
    peas.push(p);
  }
  g.scale.setScalar(scale);
  return { g, peas };
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
  box(0.006, 0.04, 0.04, dark, g, 0, -0.04, 0.03);
  g.scale.setScalar(1.5);
  return g;
}

function neonSign() {
  const tex = canvasTex(256, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#ffd38a';
    g.fillStyle = '#ffd38a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(26, 50);
    g.lineTo(42, 14);
    g.lineTo(58, 50);
    g.closePath();
    g.stroke();
    g.fillRect(41, 26, 2, 12);
    g.fillRect(41, 42, 2, 3);
    g.font = 'bold 22px monospace';
    g.textBaseline = 'middle';
    g.fillText('EAT QUIETLY', 72, 33);
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), new THREE.MeshBasicMaterial({ map: tex, transparent: true, color: 0xffffff, fog: false }));
  return m;
}

function buildRoom(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x050404);
  scene.fog = new THREE.FogExp2(0x070605, 0.17);
  const W = ROOM.x * 2, D = ROOM.z1 - ROOM.z0, cz = (ROOM.z1 + ROOM.z0) / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0xffffff, { map: Tex.floor([W, D]) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = cz;
  floor.receiveShadow = true;
  scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0x1a1816));
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
  for (const [y, r] of [[2.45, 0.06], [2.62, 0.04]] as const) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, D, 8), rust);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(-ROOM.x + 0.12, y, cz);
    scene.add(pipe);
  }
  const vpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, ROOM.h, 8), rust);
  vpipe.position.set(-ROOM.x + 0.12, ROOM.h / 2, -3.4);
  scene.add(vpipe);
  const metal = lam(0xffffff, { map: Tex.metal() });
  box(0.06, 2.1, 1.0, metal, scene, ROOM.x - 0.03, 1.05, -3.3);
  box(0.07, 2.2, 0.08, rust, scene, ROOM.x - 0.035, 1.1, -3.84);
  box(0.07, 2.2, 0.08, rust, scene, ROOM.x - 0.035, 1.1, -2.76);
  const sign = neonSign();
  sign.position.set(0, 2.75, ROOM.z0 + 0.02);
  scene.add(sign);
  const signLight = new THREE.PointLight(0xffb060, 1.2, 4, 1.5);
  signLight.position.set(0, 2.7, ROOM.z0 + 0.4);
  scene.add(signLight);

  const cloth = lam(0xffffff, { map: Tex.cloth([1, 5]) });
  const len = TABLE.z1 - TABLE.z0, tz = (TABLE.z1 + TABLE.z0) / 2;
  box(TABLE.x * 2, 0.04, len, cloth, scene, 0, TABLE_Y - 0.02, tz);
  box(0.01, 0.2, len, cloth, scene, -TABLE.x - 0.005, TABLE_Y - 0.1, tz);
  box(0.01, 0.2, len, cloth, scene, TABLE.x + 0.005, TABLE_Y - 0.1, tz);
  const wood = lam(0xffffff, { map: Tex.wood() });
  for (const x of [-TABLE.x + 0.05, TABLE.x - 0.05]) for (const z of [TABLE.z1 - 0.08, TABLE.z0 + 0.08, tz]) box(0.05, TABLE_Y - 0.04, 0.05, wood, scene, x, (TABLE_Y - 0.04) / 2, z);

  const chair = (x: number, z: number, ry: number) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    box(0.42, 0.04, 0.42, metal, g, 0, 0.45, 0);
    box(0.42, 0.5, 0.04, metal, g, 0, 0.72, -0.2);
    for (const sx of [-0.18, 0.18]) for (const sz of [-0.18, 0.18]) box(0.03, 0.45, 0.03, rust, g, sx, 0.225, sz);
    scene.add(g);
  };
  SEATS.forEach((s) => chair(s.x + Math.sign(s.x) * 0.04, s.z, s.x > 0 ? -Math.PI / 2 : Math.PI / 2));
  chair(0, HOST_Z - 0.04, 0);

  const plateMat = lam(0xd9d2c2);
  const hostPlate = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.02, 14), plateMat);
  hostPlate.position.set(0, TABLE_Y + 0.012, -3.98);
  scene.add(hostPlate);
  const steak = box(0.16, 0.035, 0.11, lam(0x4a0f0a, { emissive: 0x120000 }), scene, 0.01, TABLE_Y + 0.04, -3.98);
  steak.rotation.y = 0.4;
  box(0.012, 0.012, 0.14, lam(0xd9ccb0), scene, -0.02, TABLE_Y + 0.06, -3.97).rotation.y = 0.4;
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.025, 0.09, 8), new THREE.MeshLambertMaterial({ color: 0x4a0808, transparent: true, opacity: 0.85 }));
  glass.position.set(-0.24, TABLE_Y + 0.12, -3.9);
  scene.add(glass);
  box(0.006, 0.08, 0.006, lam(0xc8c8c8), scene, -0.24, TABLE_Y + 0.04, -3.9, false);
  const wax = lam(0xd8cfb0, { emissive: 0x2a2010 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffd080, fog: false });
  const candles: THREE.Mesh[] = [];
  for (const x of [-0.3, 0.3]) {
    box(0.03, 0.2, 0.03, wax, scene, x, TABLE_Y + 0.1, -3.62);
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.04, 5), flameMat);
    f.position.set(x, TABLE_Y + 0.225, -3.62);
    scene.add(f);
    candles.push(f);
  }
  const candleLight = new THREE.PointLight(0xffa050, 1.6, 3.2, 1.3);
  candleLight.position.set(0, TABLE_Y + 0.35, -3.5);
  scene.add(candleLight);

  scene.add(new THREE.HemisphereLight(0x4a4038, 0x0a0806, 0.7));
  const LAMP_Y = 2.1;
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.2, 8, 1, true), new THREE.MeshLambertMaterial({ color: 0x3a3832, emissive: 0x0a0806, side: THREE.DoubleSide }));
  shade.position.set(0, LAMP_Y + 0.09, -1.75);
  scene.add(shade);
  const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), new THREE.MeshBasicMaterial({ color: 0xffe2b0, fog: false }));
  bulb.position.set(0, LAMP_Y, -1.75);
  scene.add(bulb);
  box(0.01, ROOM.h - LAMP_Y - 0.19, 0.01, lam(0x111111), scene, 0, (ROOM.h + LAMP_Y + 0.19) / 2, -1.75, false);
  const lamp = new THREE.SpotLight(0xffd2a0, 22, 8, 1.0, 0.55, 1.3);
  lamp.position.set(0, LAMP_Y, -1.75);
  lamp.target.position.set(0, 0, -1.9);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(512, 512);
  lamp.shadow.bias = -0.002;
  scene.add(lamp, lamp.target);

  const tube = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1.0), new THREE.MeshBasicMaterial({ color: 0xcfe0ff, fog: false }));
  tube.position.set(ROOM.x - 0.05, 2.6, -1.0);
  scene.add(tube);
  const cold = new THREE.PointLight(0x9fb8ff, 2.2, 4, 1.4);
  cold.position.set(ROOM.x - 0.3, 2.5, -1.0);
  scene.add(cold);

  const fill = new THREE.PointLight(0xffc89a, 1.4, 1.8, 1.5);
  fill.position.set(0.25, 1.35, 0.45);
  scene.add(fill);

  const danger = new THREE.PointLight(0xff2010, 0, 6, 1.2);
  danger.position.set(0, 2.2, -3.4);
  scene.add(danger);

  const flickers = [
    new Flicker(lamp, bulb.material as THREE.MeshBasicMaterial, lamp.intensity, 0.35),
    new Flicker(cold, tube.material as THREE.MeshBasicMaterial, cold.intensity, 1.6),
    new Flicker(candleLight, null, candleLight.intensity, 2.5),
  ];

  const surfaces: Surface[] = [
    { y: TABLE_Y, x0: -TABLE.x, x1: TABLE.x, z0: TABLE.z0, z1: TABLE.z1 },
    { y: 0, x0: -ROOM.x, x1: ROOM.x, z0: ROOM.z0, z1: ROOM.z1 },
  ];
  const walls: Wall[] = [
    { axis: 'x', at: -ROOM.x, normal: 1 },
    { axis: 'x', at: ROOM.x, normal: -1 },
    { axis: 'z', at: ROOM.z0, normal: 1 },
    { axis: 'z', at: ROOM.z1, normal: -1 },
  ];
  return { surfaces, walls, flickers, lamp: { shade, bulb, light: lamp }, danger, candles };
}

class Host {
  readonly root = new THREE.Group();
  readonly head = new THREE.Group();
  readonly paper = new THREE.Group();
  readonly paperTop = new THREE.Group();
  readonly gun = desertEagle();
  private eyeMat = new THREE.MeshBasicMaterial({ color: 0x8a8070 });
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private grip = 0;
  private gunTable = { p: new THREE.Vector3(0.3, TABLE_Y + 0.025, -3.75), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -2.3, Math.PI / 2)) };
  down = 0;
  fold = 0;
  shake = 0;
  aim = 0;
  scan = 0;
  aimAt = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const r = this.root;
    r.position.set(0, 0, HOST_Z);
    scene.add(r);
    const suit = lam(0x16161a);
    const shirt = lam(0xd8d2c6);
    const skin = lam(0xc9b29c);
    box(0.58, 0.62, 0.32, suit, r, 0, 0.8, 0);
    box(0.16, 0.5, 0.01, shirt, r, 0, 0.86, 0.162);
    box(0.05, 0.36, 0.012, lam(0x5a0606), r, 0, 0.83, 0.17);
    box(0.24, 0.06, 0.012, lam(0x0b0b0d), r, 0, 1.06, 0.164);
    for (const s of [-1, 1]) box(0.17, 0.42, 0.17, suit, r, s * 0.12, 0.47, 0.2).rotation.x = Math.PI / 2;
    box(0.09, 0.08, 0.09, skin, r, 0, 1.14, 0);
    this.head.position.set(0, 1.18, 0.0);
    r.add(this.head);
    const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 1), skin);
    skull.scale.set(0.95, 1.12, 1);
    skull.position.y = 0.13;
    skull.castShadow = true;
    this.head.add(skull);
    const hair = new THREE.Mesh(new THREE.IcosahedronGeometry(0.145, 1), lam(0x141210));
    hair.scale.set(0.98, 0.6, 1.02);
    hair.position.set(0, 0.2, -0.015);
    this.head.add(hair);
    for (const s of [-1, 1]) box(0.035, 0.022, 0.01, this.eyeMat, this.head, s * 0.05, 0.15, 0.132, false);
    box(0.08, 0.018, 0.02, lam(0x1a1210), this.head, 0, 0.085, 0.132, false);
    box(0.028, 0.05, 0.035, skin, this.head, 0, 0.115, 0.14, false);

    for (const [arm, s] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(s * 0.31, 1.02, 0.02);
      r.add(arm);
      box(0.12, 0.56, 0.12, suit, arm, 0, -0.28, 0);
      box(0.08, 0.08, 0.08, skin, arm, 0, -0.58, 0);
    }

    const tex = Tex.newspaper();
    const top = tex.clone();
    tex.repeat.set(1, 0.5);
    top.repeat.set(1, 0.5);
    top.offset.set(0, 0.5);
    top.needsUpdate = true;
    const pm = (t: THREE.Texture) => new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide });
    this.paper.position.set(0, 0.92, 0.44);
    r.add(this.paper);
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.27).translate(0, 0.135, 0), pm(tex));
    bottom.castShadow = true;
    this.paper.add(bottom);
    this.paperTop.position.y = 0.27;
    this.paper.add(this.paperTop);
    const topM = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.27).translate(0, 0.135, 0), pm(top));
    topM.castShadow = true;
    this.paperTop.add(topM);

    scene.add(this.gun);
    this.gun.position.copy(this.gunTable.p);
    this.gun.quaternion.copy(this.gunTable.q);
  }

  headWorld(out = new THREE.Vector3()) {
    return this.head.localToWorld(out.set(0, 0.13, 0.05));
  }

  muzzle(out = new THREE.Vector3()) {
    return this.gun.localToWorld(out.set(0, 0.022, 0.2));
  }

  private pointArm(arm: THREE.Group, worldTarget: THREE.Vector3, blend = 1) {
    const local = this.root.worldToLocal(worldTarget.clone()).sub(arm.position).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), local);
    arm.quaternion.slerp(q, blend);
  }

  update(dt: number, t: number) {
    const d = smooth(clamp(this.down, 0, 1));
    this.paper.position.y = lerp(0.92, 0.8, d);
    this.paper.position.z = lerp(0.44, 0.5, d);
    this.paper.rotation.x = lerp(-0.08, 0.95, d);
    this.paper.rotation.z = this.shake * Math.sin(t * 47) * 0.05;
    this.paper.position.x = this.shake * Math.sin(t * 31) * 0.01;
    this.paperTop.rotation.x = this.fold * 1.1 * (1 - d) + d * 0.2;
    const lookK = clamp((d - 0.5) * 2, 0, 1);
    this.eyeMat.color.setRGB(0.55 + lookK * 0.45, 0.5 + lookK * 0.45, 0.45 + lookK * 0.4);
    this.head.rotation.y = Math.sin(this.scan) * 0.4 * lookK;
    this.head.rotation.x = lerp(0.25, 0.05, lookK);

    const corner = (s: number) => this.paper.localToWorld(new THREE.Vector3(s * 0.3, 0.05, 0));
    this.root.updateMatrixWorld();
    this.armL.quaternion.identity();
    this.pointArm(this.armL, corner(-1));
    this.armR.quaternion.identity();
    this.pointArm(this.armR, corner(1));
    if (this.aim > 0.001) {
      const q0 = this.armR.quaternion.clone();
      this.pointArm(this.armR, this.aimAt);
      const q1 = this.armR.quaternion.clone();
      this.armR.quaternion.copy(q0).slerp(q1, smooth(this.aim));
      this.head.rotation.y = lerp(this.head.rotation.y, Math.atan2(this.aimAt.x - this.root.position.x, this.aimAt.z - this.root.position.z) * 0.8, this.aim);
    }
    this.grip = damp(this.grip, this.aim > 0.2 ? 1 : 0, 12, dt);
    this.armR.updateMatrixWorld();
    const hand = this.armR.localToWorld(new THREE.Vector3(0, -0.62, 0.02));
    const look = new THREE.Object3D();
    look.position.copy(hand);
    look.lookAt(this.aimAt);
    const g = smooth(this.grip);
    this.gun.position.lerpVectors(this.gunTable.p, hand, g);
    this.gun.quaternion.slerpQuaternions(this.gunTable.q, look.quaternion, g);
  }
}

const REMARKS = {
  excused: [
    'Subject ate with acceptable discretion. Retain for further testing.',
    'Table manners: adequate. Appetite: noted. Proceed to next simulation.',
    'Subject finished before the host took an interest. Unremarkable.',
  ],
  caught: [
    'Subject was observed chewing. Cranial contents redistributed across the tablecloth.',
    'Subject prioritised peas over survival. The host does not tolerate this.',
    'Impulse control insufficient. Remains to be scraped from the china.',
  ],
  last: ['Subject finished last. The host does not wait for stragglers.', 'Slowest eater at the table. Dessert was served early.'],
  time: ['Subject failed to finish within the allotted time. Dinner is over.'],
};

export const createDinner: GameFactory = (ctx) => {
  const { engine, hud, rng, start } = ctx;
  const scene = engine.scene;
  const room = buildRoom(scene);
  const gore = new Gore(engine, room.surfaces, room.walls, { onImpact: (v) => sound.splat(v) });
  const host = new Host(scene);
  const cam = engine.camera;
  cam.fov = 70;

  const players = start.players.slice(0, SEATS.length + 1);
  const seats: Seat[] = players.map((p) => ({ id: p.id, bot: p.isBot, arm: p.limbs.includes('ra') }));
  const table = tableFor(start.seed, seats);
  const segs = table.segs;
  const online = !!ctx.net && start.startAt !== undefined;
  const auto = new URLSearchParams(location.search).has('auto');
  const autoPlan = auto ? botPlan(start.seed, 7, 'cautious', segs, table.windows) : null;

  const numbers = new Map<string, number>();
  for (const p of players) {
    let n = rng.int(1, 99);
    while ([...numbers.values()].includes(n)) n = (n % 99) + 1;
    numbers.set(p.id, n);
  }

  const me = players.find((p) => p.id === start.you) ?? players[0];
  const others = players.filter((p) => p !== me);
  const playerFork = forkMesh(1.6);
  scene.add(playerFork.g);
  const sleeve = box(1, 1, 1, lam(0xffffff, { map: Tex.jumpsuit('#77705f', 0) }), scene, 0, 0, 0, false);
  const fist = box(0.06, 0.07, 0.08, lam(0xc4ae98), scene, 0, 0, 0, false);

  const makeDiner = (info: PlayerInfo, seat: number): Diner => {
    const you = seat < 0;
    const number = numbers.get(info.id)!;
    let subject: Subject | null = null;
    let forkPeas: THREE.Mesh[] = playerFork.peas;
    let plate: Plate;
    if (you) {
      plate = new Plate(scene, 0, 0.07);
    } else {
      const s = SEATS[seat];
      subject = new Subject({ number, hat: info.hat, limbs: info.limbs });
      subject.root.position.set(s.x, 0, s.z);
      subject.root.rotation.y = s.x > 0 ? -Math.PI / 2 : Math.PI / 2;
      scene.add(subject.root);
      plate = new Plate(scene, Math.sign(s.x) * 0.2, s.z);
      const f = forkMesh(1.1);
      f.g.rotation.set(Math.PI / 2 + 0.5, 0, 0);
      f.g.position.set(0, -0.03, 0);
      subject.hand('r').add(f.g);
      forkPeas = f.peas;
    }
    const plan = info.isBot ? (table.plans.get(info.id) ?? null) : null;
    return { info, number, you, subject, plate, plan, fork: 'idle', forkT: 0, lift: 0, dropFrom: 0, loaded: 0, eaten: 0, alive: true, done: false, endAt: 0, cause: '', forkPeas };
  };
  const you = makeDiner(me, -1);
  const diners = [you, ...others.map((p, i) => makeDiner(p, i))];
  const tag = (d: Diner) => `#${String(d.number).padStart(2, '0')} ${d.info.name.toUpperCase()}`;

  const authority: Authority = online ? netAuthority() : localAuthority();

  function localAuthority(): Authority {
    const ref = newReferee(start.seed, seats);
    return {
      act: (a) => recordAct(ref, me.id, a),
      poll: (t) => advance(ref, t),
      latest: () => undefined,
      over: () => ref.over,
      placements: () => placements(ref),
    };
  }

  function netAuthority(): Authority {
    let view: DinnerView = { outcomes: [], acts: {}, over: false, placements: [] };
    let seen = 0;
    ctx.net!.on((data) => {
      view = data as DinnerView;
    });
    return {
      act: (a) => ctx.net!.send({ kind: 'act', ...a }),
      poll: () => {
        const fresh = view.outcomes.slice(seen);
        seen = view.outcomes.length;
        return fresh;
      },
      latest: (id) => view.acts[id],
      over: () => view.over && seen >= view.outcomes.length,
      placements: () => view.placements,
    };
  }

  let elapsed = 0;
  let begun = false;
  let introDone = false;
  let hs = hostAt(segs, 0);
  let lastSeg = -1;
  let settling = false;
  let execing = false;
  let execQueue: { d: Diner; cause: string; shots: Shot[] }[] = [];
  let execT = 0;
  let execCooldown = 0;
  let timeUp = false;
  let lastPlate = false;
  let finished = false;
  let endAt = -1;
  let youDeadAt = -1;
  let glance = new THREE.Vector3();
  let glanceK = 0;
  let boardT = 0;
  let firstBite = false;

  function onSegment(s: Segment) {
    if (s.phase === 'read') sound.intensity = 0.4;
    else if (s.phase === 'rustle') sound.rustle(0.6);
    else if (s.phase === 'fold') sound.rustle(0.3, 0.4);
    else if (s.phase === 'lower') {
      if (s.snap) sound.snap();
      sound.sting();
      sound.intensity = 0.9;
    } else if (s.phase === 'raise') sound.rustle(0.25, 0.4);
  }

  function hostTick(dt: number) {
    hs = hostAt(segs, elapsed, hs.index);
    if (hs.index !== lastSeg) {
      lastSeg = hs.index;
      if (!execing) onSegment(hs.seg);
    }
    const s = hs.seg;
    host.shake = s.phase === 'rustle' ? 1 - hs.pt / s.dur : 0;
    host.fold = s.phase === 'fold' ? Math.sin((hs.pt / s.dur) * Math.PI) * 0.45 : 0;
    if (s.phase === 'look') host.scan += dt * 2.4;
    if (execing || settling) {
      host.down = damp(host.down, execing ? 1 : hs.down, 14, dt);
      settling = execing || Math.abs(host.down - hs.down) > 0.02;
    } else host.down = hs.down;
  }

  function setFork(d: Diner, f: Fork) {
    if (f === 'drop') d.dropFrom = d.lift;
    d.fork = f;
    d.forkT = 0;
    if (d.you) authority.act({ t: elapsed, fork: f, loaded: d.loaded, eaten: d.eaten });
  }

  /** Puts a diner in a fork state taken from a plan or the server; returns whether it changed. */
  function applyFrame(d: Diner, fork: Fork, forkT: number, loaded: number, eaten: number, from: number) {
    const changed = fork !== d.fork || loaded !== d.loaded || eaten !== d.eaten;
    d.fork = fork;
    d.forkT = forkT;
    d.loaded = loaded;
    d.eaten = eaten;
    d.lift = liftOf(fork, forkT, from);
    const remaining = Math.max(0, PEAS - eaten - loaded);
    if (remaining !== d.plate.remaining) {
      d.plate.remaining = remaining;
      d.plate.sync();
    }
    d.forkPeas.forEach((p, i) => (p.visible = i < loaded));
    return changed;
  }

  const busy = (d: Diner) => !d.alive || d.done || execQueue.some((e) => e.d === d);

  function youTick(dt: number) {
    const d = you;
    if (busy(d)) return;
    if (autoPlan) {
      const f = botFrame(autoPlan, elapsed);
      if (applyFrame(d, f.fork, f.forkT, f.loaded, f.eaten, f.from)) authority.act({ t: elapsed, fork: f.fork, loaded: f.loaded, eaten: f.eaten });
      return;
    }
    d.forkT += dt;
    if (d.fork === 'stab') {
      while (d.forkT >= STAB) {
        d.forkT -= STAB;
        if (d.loaded < MAX_LOAD && d.plate.remaining > 0 && Math.random() < 0.55) {
          d.loaded++;
          d.plate.remaining--;
          d.plate.sync();
          if (d.loaded === MAX_LOAD || d.plate.remaining === 0) sound.clink(true);
          else sound.clink();
        } else sound.clink();
      }
      d.lift = 0;
    } else if (d.fork === 'raise') {
      d.lift = liftOf('raise', d.forkT);
      if (d.forkT >= RAISE) {
        d.eaten += d.loaded;
        d.loaded = 0;
        setFork(d, 'chew');
        sound.chew();
        ctx.haptic('light');
      }
    } else if (d.fork === 'chew') {
      d.lift = 1;
      if (d.forkT >= CHEW) setFork(d, 'lower');
    } else if (d.fork === 'lower') {
      d.lift = liftOf('lower', d.forkT);
      if (d.forkT >= LOWER) setFork(d, 'idle');
    } else if (d.fork === 'drop') {
      d.lift = liftOf('drop', d.forkT, d.dropFrom);
      if (d.forkT >= DROP) {
        d.plate.remaining += d.loaded;
        d.loaded = 0;
        d.plate.sync();
        setFork(d, 'idle');
        sound.clink();
      }
    } else d.lift = 0;
    if (d.eaten >= PEAS && d.fork === 'idle') {
      pad.enabled = false;
      hud.setHint('Plate clean. Stay still.');
    }
    d.forkPeas.forEach((p, i) => (p.visible = i < d.loaded));
  }

  function othersTick() {
    for (const d of diners) {
      if (d.you || busy(d)) continue;
      if (d.plan) {
        const f = botFrame(d.plan, elapsed);
        applyFrame(d, f.fork, f.forkT, f.loaded, f.eaten, f.from);
      } else {
        const a = authority.latest(d.info.id);
        if (a) applyFrame(d, a.fork, Math.max(0, elapsed - a.t), a.loaded, a.eaten, 0.8);
      }
    }
  }

  function applyOutcomes() {
    for (const o of authority.poll(elapsed)) {
      const d = diners.find((x) => x.info.id === o.id);
      if (!d) continue;
      if (o.status === 'excused') {
        excuse(d);
        continue;
      }
      if (o.cause === CAUSE.last && !lastPlate) {
        lastPlate = true;
        hud.feed('<b>LAST PLATE.</b> The host does not wait.');
      }
      if (o.cause === CAUSE.time && !timeUp) {
        timeUp = true;
        hud.feed('<b>DINNER IS OVER.</b> Unfinished plates are not tolerated.');
      }
      d.eaten = o.eaten;
      schedule(d, o.cause);
    }
  }

  function excuse(d: Diner) {
    if (d.done) return;
    d.done = true;
    d.endAt = elapsed;
    if (d.subject) d.subject.relaxed = true;
    hud.feed(`<b>${tag(d)}</b> cleaned the plate. Excused.`);
    if (d.you) {
      hud.setHint('Excused. Stay still and watch.');
      pad.enabled = false;
    }
  }

  function schedule(d: Diner, cause: string) {
    if (execQueue.some((e) => e.d === d)) return;
    const shots: Shot[] = d.you || !d.subject ? ['head'] : cause === CAUSE.stab && d.subject.limbs.ra.attached ? ['arm', 'head'] : cause === CAUSE.eat || cause === CAUSE.stab ? ['head'] : ['gut', 'head'];
    execQueue.push({ d, cause, shots });
    if (!execing) {
      execing = true;
      execT = 0;
      execCooldown = 0;
      sound.intensity = 1;
    }
  }

  function aimPoint(d: Diner, shot: Shot) {
    if (d.you) return cam.position.clone();
    const s = d.subject!;
    if (shot === 'arm') return s.limbs.ra.joint.getWorldPosition(new THREE.Vector3());
    if (shot === 'gut') return s.torso.localToWorld(new THREE.Vector3(0, 0.18, 0.1));
    return s.headWorld();
  }

  /** A non-lethal shot first: blow the stabbing arm off, or open the belly. */
  function wound(d: Diner, shot: Shot) {
    const s = d.subject!;
    const target = aimPoint(d, shot);
    const muzzle = host.muzzle();
    const dir = target.clone().sub(muzzle).normalize();
    gore.muzzleFlash(muzzle, dir);
    sound.gunshot();
    engine.flash(0.15);
    engine.shake(0.25);
    sound.squelch(1.2);
    ctx.haptic('heavy');
    if (shot === 'arm') {
      s.severLimb(gore, 'ra', dir);
      sound.crunch(0.8);
      d.loaded = 0;
      d.forkPeas.forEach((p) => (p.visible = false));
    } else s.gutSpill(gore);
    s.flinch(-dir.x);
    d.fork = 'idle';
  }

  function fire(d: Diner, cause: string) {
    const target = aimPoint(d, 'head');
    const muzzle = host.muzzle();
    const dir = target.clone().sub(muzzle).normalize();
    gore.muzzleFlash(muzzle, dir);
    sound.gunshot();
    engine.flash(0.22);
    engine.slowmo(0.65, 0.22);
    d.alive = false;
    d.endAt = elapsed;
    d.cause = cause;
    d.fork = 'idle';
    d.forkPeas.forEach((p) => (p.visible = false));
    ctx.death(d.info.id, cause);
    if (d.you) {
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
      playerFork.g.visible = false;
      sleeve.visible = fist.visible = false;
      return;
    }
    const s = d.subject!;
    s.explodeHead(gore, dir);
    s.die('slump');
    sound.crunch();
    sound.squelch();
    ctx.haptic('heavy');
    const dist = target.distanceTo(cam.position);
    engine.shake(0.3 + Math.max(0, 2.8 - dist) * 0.25);
    if (dist < 3.2) {
      const ndc = target.clone().project(cam);
      engine.lens.burst(clamp((ndc.x + 1) / 2, 0.15, 0.85), clamp((1 - ndc.y) / 2, 0.2, 0.7), (3.2 - dist) / 1.6);
      sound.ring(1.5);
    }
    glance.copy(target);
    glanceK = 1;
    for (const o of diners) if (o !== d && o.alive) o.subject?.flinch(o.subject.root.position.x - target.x);
    const neck = s.neck;
    setTimeout(() => gore.pool(new THREE.Vector3().setFromMatrixPosition(neck.matrixWorld).setY(TABLE_Y), 0.32), 900);
    hud.feed(`<b>${tag(d)}</b> ${cause.toLowerCase()}. Terminated.`);
  }

  function execTick(dt: number) {
    const cur = execQueue[0];
    if (cur) {
      host.aimAt.copy(aimPoint(cur.d, cur.shots[0]));
      host.aim = damp(host.aim, 1, 10, dt);
      execT += dt;
      if (execT > (execCooldown > 0 ? 0.4 : 0.5)) {
        const shot = cur.shots.shift()!;
        if (shot === 'head') {
          fire(cur.d, cur.cause);
          execQueue.shift();
        } else wound(cur.d, shot);
        execT = 0;
        execCooldown = 1;
      }
      return;
    }
    execT += dt;
    if (execT > 0.7) host.aim = damp(host.aim, 0, 8, dt);
    if (execT > 1.3) {
      host.aim = 0;
      execing = false;
      settling = true;
      sound.intensity = 0.4;
    }
  }

  function endTick() {
    if (finished) return;
    if (endAt < 0 && !execing && authority.over()) endAt = elapsed + 2.2;
    if (endAt >= 0 && elapsed >= endAt) finish();
  }

  function finish() {
    finished = true;
    const result = authority.placements();
    ctx.finish(result);
    const order = result.map((r) => diners.find((d) => d.info.id === r.id)).filter((d): d is Diner => !!d);
    console.log('[round]', JSON.stringify({ elapsed: elapsed.toFixed(1), online, diners: diners.map((d) => [d.info.name, d.plan?.kind ?? 'human', d.alive ? 'excused' : d.cause, d.eaten, d.endAt.toFixed(1)]) }));
    const perf = engine.perf();
    const pool = !you.alive ? (you.cause === CAUSE.last ? REMARKS.last : you.cause === CAUSE.time ? REMARKS.time : REMARKS.caught) : REMARKS.excused;
    hud.assessment({
      kicker: 'ASSESSMENT · SIMULATION 01 · DINNER PARTY',
      subject: `SUBJECT ${tag(you)}`,
      verdict: you.alive ? 'RETAINED' : 'TERMINATED',
      lines: [
        ['PEAS CONSUMED', `${you.eaten} / ${PEAS}`],
        ['TIME AT TABLE', `${(you.endAt || elapsed).toFixed(1)} s`],
        ['CAUSE', you.alive ? 'None. Plate cleared.' : you.cause],
        ['LIMBS', `${me.limbs.length} / 4 retained`],
      ],
      remark: pool[Math.floor(Math.random() * pool.length)],
      table: order.map((d) => `${tag(d)} — ${d.alive ? 'EXCUSED' : 'TERMINATED'}${d.you ? ' (you)' : ''}`),
      fine: `SEED ${start.seed}${online ? ' · ONLINE' : ''} · ${perf.fps} FPS AVG · ${perf.minFps} MIN`,
    });
  }

  const pad = new TouchPad(ctx.surface, {
    down: () => {
      if (busy(you) || !begun) return;
      if (you.fork === 'raise' || you.fork === 'chew' || you.fork === 'lower') setFork(you, 'drop');
      else if (you.fork === 'idle' && you.loaded < MAX_LOAD && you.plate.remaining > 0) setFork(you, 'stab');
    },
    up: () => {
      if (you.fork === 'stab' && !busy(you)) setFork(you, 'idle');
    },
    swipeUp: () => {
      if (busy(you) || !begun) return;
      if ((you.fork === 'idle' || you.fork === 'stab') && you.loaded > 0) {
        setFork(you, 'raise');
        if (!firstBite) {
          firstBite = true;
          hud.setHint('');
        }
      }
    },
  });
  if (auto) pad.enabled = false;

  const restTip = new THREE.Vector3(0.035, TABLE_Y + 0.05, 0.08);
  const mouthTip = new THREE.Vector3(0.02, 1.06, 0.4);
  const orient = (tip: THREE.Vector3, handle: THREE.Vector3) => {
    const o = new THREE.Object3D();
    o.position.copy(tip);
    o.lookAt(tip.clone().add(handle));
    return o.quaternion.clone();
  };
  const restQ = orient(restTip, new THREE.Vector3(0.22, 0.3, 0.5));
  const mouthQ = orient(mouthTip, new THREE.Vector3(0.1, -0.16, 0.14));
  const shoulder = new THREE.Vector3();

  function playerVisuals(t: number) {
    const e = smooth(you.lift);
    const jab = you.fork === 'stab' ? Math.abs(Math.sin(t * 22)) * 0.03 : 0;
    playerFork.g.position.lerpVectors(restTip, mouthTip, e);
    playerFork.g.position.y += jab;
    playerFork.g.quaternion.slerpQuaternions(restQ, mouthQ, e);
    playerFork.g.updateMatrixWorld();
    const hand = playerFork.g.localToWorld(new THREE.Vector3(0, 0, 0.21));
    fist.position.copy(hand);
    fist.quaternion.copy(playerFork.g.quaternion);
    shoulder.set(0.34, 0.78, 0.6);
    sleeve.position.lerpVectors(hand, shoulder, 0.5);
    sleeve.lookAt(shoulder);
    sleeve.scale.set(0.09, 0.08, hand.distanceTo(shoulder) + 0.05);
  }

  function cameraTick(dt: number, t: number) {
    const observing = host.down > 0.5;
    if (youDeadAt >= 0) {
      const k = smooth(clamp((elapsed - youDeadAt) / 0.9, 0, 1));
      cam.position.set(lerp(CAM.x, 0.06, k), lerp(CAM.y, TABLE_Y + 0.13, k), lerp(CAM.z, 0.22, k));
      cam.lookAt(lerp(LOOK.x, -0.15, k), lerp(LOOK.y, 0.95, k), LOOK.z);
      cam.rotateZ(-0.95 * k + Math.sin(elapsed * 30) * 0.05 * (1 - k));
      return;
    }
    glanceK = Math.max(0, glanceK - dt * 0.7);
    const sway = 0.006;
    const lean = you.done ? 0.12 : 0;
    cam.position.set(CAM.x + Math.sin(t * 0.7) * sway, CAM.y + Math.sin(t * 1.3) * sway * 0.6 + lean * 0.3, CAM.z + lean);
    const look = LOOK.clone();
    look.lerp(glance, smooth(Math.min(1, glanceK * 1.5)) * 0.35);
    look.y += Math.sin(t * 0.5) * 0.02;
    cam.lookAt(look);
    const fov = observing || execing ? 62 : 70;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = damp(cam.fov, fov, 5, dt);
      cam.updateProjectionMatrix();
    }
  }

  function hudTick(dt: number) {
    if (!finished) hud.setTimer(ROUND - elapsed);
    const watching = host.down > 0.5;
    const phase = hs.seg.phase;
    if (!begun) {
      const wait = online ? Math.ceil((start.startAt! - Date.now()) / 1000) : 0;
      if (wait > 0) hud.setStatus(`DINNER IN ${wait}`, 'warn');
      else hud.setStatus('', 'hidden');
    } else if (!you.alive) hud.setStatus('', 'hidden');
    else if (execing) hud.setStatus(lastPlate ? 'LAST PLATE' : timeUp ? 'DINNER IS OVER' : "DON'T. MOVE.", 'danger');
    else if (watching) hud.setStatus("HE'S WATCHING", 'danger');
    else if (phase === 'rustle' || phase === 'fold' || (phase === 'lower' && !watching)) hud.setStatus('…', 'warn');
    else if (you.done) hud.setStatus('EXCUSED', 'calm');
    else hud.setStatus("HE'S READING", 'calm');
    engine.tint = damp(engine.tint, watching || execing ? 0.3 : 0, 6, dt);
    room.danger.intensity = engine.tint * 12;
    boardT += dt;
    if (boardT > 0.12) {
      boardT = 0;
      hud.setBoard(
        diners.map((d) => ({
          name: d.you ? tag(d) : `${tag(d)}<small>${d.plan?.kind ?? ''}</small>`,
          value: d.eaten,
          max: PEAS,
          me: d.you,
          dead: !d.alive,
          done: d.done,
        })),
      );
    }
  }

  hud.setTitle('SIMULATION 01', 'DINNER PARTY');
  hud.setPot(start.pot);
  hud.setLimbs(me.limbs);
  hud.setTimer(ROUND);
  hud.setHint('<b>HOLD</b> to stab peas · <b>FLICK UP</b> to eat · <b>TAP</b> mid-bite to drop it');
  void hud
    .intro('SIMULATION 01', 'DINNER PARTY', [
      'Eat your peas while the host reads.',
      '<b>Hold</b> to stab peas onto the fork. <b>Flick up</b> to eat.',
      'If he sees you stabbing, lifting or chewing, he shoots.',
      'Clean your plate to be excused. The last plate is shot.',
    ])
    .then(() => {
      introDone = true;
      sound.unlock();
      sound.drone(true);
      sound.beat(true);
      if (!online) begun = true;
    });
  const closeIntro = () => document.querySelector<HTMLElement>('.overlay')?.dispatchEvent(new PointerEvent('pointerdown'));
  if (auto) closeIntro();

  function step(dt: number, t: number) {
    if (begun) {
      hostTick(dt);
      applyOutcomes();
      youTick(dt);
      othersTick();
      if (execing) execTick(dt);
      endTick();
    }
    host.update(dt, t);
    for (const d of diners) {
      const s = d.subject;
      if (!s) continue;
      s.eat = d.lift;
      s.stab = d.fork === 'stab';
      s.chew = d.fork === 'chew';
      const alert = begun && (host.down > 0.3 || execing || hs.seg.phase !== 'read');
      s.freeze = alert;
      s.lookAt = alert || d.done ? host.headWorld() : new THREE.Vector3(Math.sign(s.root.position.x) * 0.2, TABLE_Y, s.root.position.z);
      s.update(dt, t);
    }
    for (const f of room.flickers) f.update(dt);
    room.candles.forEach((c, i) => (c.scale.y = 0.8 + Math.sin(t * 13 + i * 2) * 0.15 + Math.random() * 0.1));
    room.lamp.shade.rotation.z = Math.sin(t * 0.8) * 0.03;
    gore.update(dt);
    playerVisuals(t);
    cameraTick(dt, t);
    hudTick(dt);
  }

  return {
    update(dt, t) {
      if (online) {
        const now = (Date.now() - start.startAt!) / 1000;
        if (!begun && now >= 0) {
          begun = true;
          if (!introDone) closeIntro();
        }
        if (begun) elapsed = Math.max(elapsed, now);
        step(dt, t);
        return;
      }
      const ff = youDeadAt >= 0 && elapsed - youDeadAt > 2.5 && !finished ? 3 : 1;
      for (let i = 0; i < ff; i++) {
        if (begun) elapsed += dt;
        step(dt, t + i * dt);
      }
    },
  };
};
