import * as THREE from 'three';
import type { Gore } from './gore';
import type { Hat, Limb } from './protocol';
import { ALL_LIMBS } from './protocol';
import { canvasTex, Tex } from './textures';
import { clamp, damp, rand, smooth } from './util';

/** Desaturated jumpsuit colours; blood stays the only real colour. */
export const SUIT_COLORS = ['#8a7a3a', '#5d6b5a', '#6b6f78', '#8a5a3a', '#77705f', '#4f5a66'];
const SKIN = 0xc4ae98;

const mat = (color: number | string, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

function part(geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function pivot(parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

export function makeHat(kind: Hat, tint = '#7a2a2a'): THREE.Object3D | null {
  if (kind === 'none') return null;
  const g = new THREE.Group();
  if (kind === 'cone') {
    const tex = canvasTex(16, 32, (c, w, h) => {
      for (let y = 0; y < h; y += 8) {
        c.fillStyle = (y / 8) % 2 ? '#d8cfa8' : tint;
        c.fillRect(0, y, w, 8);
      }
    });
    part(new THREE.ConeGeometry(0.085, 0.26, 7), mat(0xffffff, { map: tex }), g, 0, 0.13, 0);
    part(new THREE.IcosahedronGeometry(0.03, 0), mat(0xd8cfa8), g, 0, 0.27, 0);
  } else if (kind === 'top') {
    const m = mat(0x18181a);
    part(new THREE.CylinderGeometry(0.085, 0.09, 0.2, 8), m, g, 0, 0.1, 0);
    part(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 10), m, g, 0, 0.005, 0);
    part(new THREE.CylinderGeometry(0.092, 0.092, 0.035, 8), mat(0x4a1010), g, 0, 0.03, 0);
  } else {
    const m = mat(0x6b6a4a);
    part(new THREE.CylinderGeometry(0.09, 0.115, 0.1, 8), m, g, 0, 0.05, 0);
    part(new THREE.CylinderGeometry(0.17, 0.17, 0.01, 10), m, g, 0, 0.004, 0);
  }
  return g;
}

export interface SubjectOptions {
  number: number;
  hat: Hat;
  limbs?: Limb[];
  suit?: string;
  seated?: boolean;
}

interface LimbRig {
  root: THREE.Group;
  joint: THREE.Group;
  end: THREE.Group;
  attached: boolean;
}

/**
 * Low-poly test subject: numbered jumpsuit, hat, detachable head/arms/legs, procedural
 * idle/eat/flinch/death animation. Origin is the floor under the hips; it faces +Z.
 * Drive it by setting the public pose fields each frame and calling update().
 */
export class Subject {
  readonly root = new THREE.Group();
  readonly hips: THREE.Group;
  readonly torso: THREE.Group;
  readonly neck: THREE.Group;
  readonly head: THREE.Group;
  readonly hat: THREE.Object3D | null;
  readonly limbs: Record<Limb, LimbRig>;
  private mouth: THREE.Mesh;
  private flinchT = 0;
  private flinchDir = 1;
  private deathT = -1;
  private deathKind: 'slump' | 'fall' = 'slump';
  private kick = 0;
  private headGone = false;
  private phase = rand(0, 10);
  private yaw = 0;
  private pitch = 0;
  readonly seated: boolean;

  /** 0 = arm resting on the table, 1 = hand at the mouth. */
  eat = 0;
  /** Small stabbing jiggle of the right hand. */
  stab = false;
  /** Opens the mouth (chewing). */
  chew = false;
  /** Suppress idle sway (holding still). */
  freeze = false;
  /** Lean back with arms down (finished). */
  relaxed = false;
  /** World point the head turns toward. */
  lookAt: THREE.Vector3 | null = null;

  constructor(opts: SubjectOptions) {
    this.seated = opts.seated ?? true;
    const suitHex = opts.suit ?? SUIT_COLORS[opts.number % SUIT_COLORS.length];
    const suit = mat(0xffffff, { map: Tex.jumpsuit(suitHex, opts.number) });
    const suitPlain = mat(suitHex);
    const skin = mat(SKIN);
    const dark = mat(0x111111);
    const hipY = this.seated ? 0.47 : 0.9;

    this.hips = pivot(this.root, 0, hipY, 0);
    this.torso = pivot(this.hips);
    part(new THREE.BoxGeometry(0.36, 0.5, 0.22), suit, this.torso, 0, 0.25, 0);
    part(new THREE.BoxGeometry(0.38, 0.1, 0.24), suitPlain, this.torso, 0, 0.02, 0);
    this.neck = pivot(this.torso, 0, 0.5, 0);
    part(new THREE.CylinderGeometry(0.045, 0.055, 0.07, 6), skin, this.neck, 0, 0.03, 0);
    this.head = pivot(this.neck, 0, 0.06, 0);
    const skull = part(new THREE.IcosahedronGeometry(0.12, 1), skin, this.head, 0, 0.12, 0);
    skull.scale.set(0.95, 1.15, 1);
    part(new THREE.BoxGeometry(0.03, 0.018, 0.01), dark, this.head, -0.045, 0.15, 0.112);
    part(new THREE.BoxGeometry(0.03, 0.018, 0.01), dark, this.head, 0.045, 0.15, 0.112);
    part(new THREE.BoxGeometry(0.025, 0.045, 0.03), skin, this.head, 0, 0.11, 0.12);
    this.mouth = part(new THREE.BoxGeometry(0.06, 0.012, 0.01), mat(0x2a0808), this.head, 0, 0.065, 0.11);
    this.hat = makeHat(opts.hat, suitHex);
    if (this.hat) {
      this.hat.position.set(0, 0.245, -0.005);
      this.hat.rotation.z = rand(-0.12, 0.12);
      this.head.add(this.hat);
    }

    const arm = (side: 1 | -1): LimbRig => {
      const root = pivot(this.torso, side * 0.22, 0.45, 0);
      part(new THREE.BoxGeometry(0.1, 0.1, 0.1), suitPlain, root, 0, 0, 0);
      part(new THREE.BoxGeometry(0.085, 0.28, 0.085), suitPlain, root, 0, -0.14, 0);
      const joint = pivot(root, 0, -0.28, 0);
      part(new THREE.BoxGeometry(0.075, 0.25, 0.075), suitPlain, joint, 0, -0.12, 0);
      const end = pivot(joint, 0, -0.27, 0);
      part(new THREE.BoxGeometry(0.07, 0.08, 0.05), skin, end, 0, 0.0, 0);
      return { root, joint, end, attached: true };
    };
    const leg = (side: 1 | -1): LimbRig => {
      const root = pivot(this.hips, side * 0.1, 0, 0);
      part(new THREE.BoxGeometry(0.13, 0.42, 0.13), suitPlain, root, 0, -0.21, 0);
      const joint = pivot(root, 0, -0.42, 0);
      part(new THREE.BoxGeometry(0.11, 0.42, 0.11), suitPlain, joint, 0, -0.21, 0);
      const end = pivot(joint, 0, -0.44, 0.04);
      part(new THREE.BoxGeometry(0.12, 0.06, 0.2), dark, end, 0, 0, 0.03);
      return { root, joint, end, attached: true };
    };
    this.limbs = { ra: arm(-1), la: arm(1), rl: leg(-1), ll: leg(1) };
    const keep = opts.limbs ?? ALL_LIMBS;
    for (const l of ALL_LIMBS) if (!keep.includes(l)) this.removeLimb(l);
  }

  get alive() {
    return this.deathT < 0;
  }

  /** World position of the centre of the head (for aiming, gore). */
  headWorld(out = new THREE.Vector3()) {
    return this.head.localToWorld(out.set(0, 0.12, 0));
  }

  /** A group in the hand where props (fork, cigarette, gun) can be attached. */
  hand(side: 'r' | 'l' = 'r') {
    return this.limbs[side === 'r' ? 'ra' : 'la'].end;
  }

  flinch(fromX = rand(-1, 1)) {
    if (!this.alive) return;
    this.flinchT = 1;
    this.flinchDir = fromX >= 0 ? 1 : -1;
  }

  private stumpCap(parent: THREE.Object3D, x: number, y: number, z: number, r: number, rotX = 0, rotZ = 0) {
    const g = pivot(parent, x, y, z);
    g.rotation.set(rotX, 0, rotZ);
    part(new THREE.CylinderGeometry(r, r * 1.1, 0.02, 7), mat(0x6e0606, { emissive: 0x220000 }), g);
    part(new THREE.CylinderGeometry(r * 0.35, r * 0.35, 0.024, 5), mat(0xd9ccb0), g);
    return g;
  }

  private removeLimb(l: Limb) {
    const rig = this.limbs[l];
    rig.root.visible = false;
    rig.attached = false;
    const p = rig.root.position;
    this.stumpCap(rig.root.parent!, p.x, p.y - (l[1] === 'a' ? 0.05 : 0.02), p.z, 0.05);
  }

  /** Blow the head off along dir: skull and brains fly, the hat tumbles, the neck stump pulses. */
  explodeHead(gore: Gore, dir: THREE.Vector3) {
    if (this.headGone) return;
    this.headGone = true;
    const at = this.headWorld();
    if (this.hat) {
      gore.throwObject(this.hat, dir.clone().multiplyScalar(rand(1.5, 2.5)).add(new THREE.Vector3(rand(-0.5, 0.5), rand(2.5, 3.5), 0)), new THREE.Vector3(rand(-12, 12), rand(-6, 6), rand(-12, 12)), 0.06);
    }
    this.head.visible = false;
    this.stumpCap(this.neck, 0, 0.065, 0, 0.05);
    gore.explodeHead(at, dir);
    gore.stump(this.neck, new THREE.Vector3(0, 0.08, 0), new THREE.Vector3(0, 1, 0.15), 7, 1.3, 1);
    this.kick = 1;
  }

  /** Sever one limb at the root; it is thrown and the stump spurts. */
  severLimb(gore: Gore, l: Limb, dir: THREE.Vector3) {
    const rig = this.limbs[l];
    if (!rig.attached) return;
    rig.attached = false;
    const isArm = l[1] === 'a';
    const parent = rig.root.parent!;
    const local = rig.root.position.clone();
    const at = rig.root.getWorldPosition(new THREE.Vector3());
    gore.throwObject(rig.root, dir.clone().multiplyScalar(rand(1, 2)).add(new THREE.Vector3(0, rand(1, 2), 0)), new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)), 0.08, 1.5);
    this.stumpCap(parent, local.x, local.y, local.z, 0.05);
    gore.spray(at, dir, 120, [1, 4], 0.5);
    gore.stump(parent, local, isArm ? new THREE.Vector3(Math.sign(local.x) || 1, 0, 0) : new THREE.Vector3(0, -1, 0.2), 5, 1.6, 0.8);
  }

  /** Open the belly: guts slide out the front and pool below. */
  gutSpill(gore: Gore) {
    part(new THREE.BoxGeometry(0.2, 0.16, 0.02), mat(0x5a0505, { emissive: 0x200000 }), this.torso, 0, 0.18, 0.112);
    gore.gutSpill(this.torso, new THREE.Vector3(0, 0.18, 0.13), new THREE.Vector3(0, -0.3, 1).applyQuaternion(this.torso.getWorldQuaternion(new THREE.Quaternion())));
  }

  /** Start the death animation. slump = forward onto the table; fall = topple backwards. */
  die(kind: 'slump' | 'fall' = 'slump') {
    if (!this.alive) return;
    this.deathT = 0;
    this.deathKind = kind;
  }

  update(dt: number, t: number) {
    const L = this.limbs;
    const tt = t + this.phase;
    if (this.deathT >= 0) {
      this.deathT += dt;
      const d = this.deathT;
      const jerk = Math.exp(-d * 9) * Math.sin(d * 30) * 0.35 * this.kick;
      if (this.deathKind === 'slump') {
        const k = smooth(clamp((d - 0.25) / 0.7, 0, 1));
        this.torso.rotation.x = -0.35 * Math.min(1, d * 8) * (1 - k) + k * 0.7 + jerk;
        this.torso.rotation.z = Math.sin(d * 3) * 0.05 * (1 - k);
      } else {
        const k = smooth(clamp(d / 0.9, 0, 1));
        this.torso.rotation.x = -k * 1.3 + jerk;
      }
      for (const s of ['ra', 'la'] as const) {
        if (!L[s].attached) continue;
        L[s].root.rotation.x = damp(L[s].root.rotation.x, this.deathKind === 'slump' ? -1.1 : 0.2, 6, dt);
        L[s].root.rotation.z = damp(L[s].root.rotation.z, (s === 'ra' ? -1 : 1) * 0.15, 6, dt);
        L[s].joint.rotation.x = damp(L[s].joint.rotation.x, -0.3, 6, dt);
      }
      this.neck.rotation.x = damp(this.neck.rotation.x, 0.4, 5, dt);
      return;
    }
    const breathe = this.freeze ? 0 : Math.sin(tt * 1.7) * 0.015;
    this.flinchT = Math.max(0, this.flinchT - dt * 2.2);
    const fl = smooth(this.flinchT);
    this.torso.rotation.x = damp(this.torso.rotation.x, (this.relaxed ? -0.18 : 0.08) + breathe - fl * 0.35, 10, dt);
    this.torso.rotation.z = damp(this.torso.rotation.z, fl * 0.2 * this.flinchDir, 10, dt);

    let yaw = 0, pitch = 0;
    if (this.lookAt) {
      const local = this.neck.worldToLocal(this.lookAt.clone());
      yaw = clamp(Math.atan2(local.x, local.z), -1.2, 1.2);
      pitch = clamp(-Math.atan2(local.y - 0.12, Math.hypot(local.x, local.z)), -0.6, 0.6);
    }
    if (!this.freeze) {
      yaw += Math.sin(tt * 0.6) * 0.08;
      pitch += Math.sin(tt * 0.9) * 0.04;
    }
    yaw += fl * this.flinchDir * -0.6;
    this.yaw = damp(this.yaw, yaw, 8, dt);
    this.pitch = damp(this.pitch, pitch, 8, dt);
    this.head.rotation.set(this.pitch, this.yaw, 0);
    this.mouth.scale.y = this.chew ? 1 + Math.abs(Math.sin(tt * 18)) * 2.5 : 1;

    const e = smooth(clamp(this.eat, 0, 1));
    const jig = this.stab ? Math.abs(Math.sin(tt * 22)) * 0.18 : 0;
    const rest = this.relaxed ? { sx: -0.15, ex: -0.3 } : { sx: -0.75, ex: -1.0 };
    if (L.ra.attached) {
      L.ra.root.rotation.x = damp(L.ra.root.rotation.x, rest.sx + (-0.95 - rest.sx) * e - jig * 0.4 - fl * 0.5, 18, dt);
      L.ra.root.rotation.z = damp(L.ra.root.rotation.z, -0.1 + e * 0.35, 18, dt);
      L.ra.joint.rotation.x = damp(L.ra.joint.rotation.x, rest.ex + (-2.25 - rest.ex) * e + jig, 18, dt);
    }
    if (L.la.attached) {
      L.la.root.rotation.x = damp(L.la.root.rotation.x, rest.sx - fl * 0.8, 10, dt);
      L.la.root.rotation.z = damp(L.la.root.rotation.z, 0.1, 10, dt);
      L.la.joint.rotation.x = damp(L.la.joint.rotation.x, rest.ex - fl * 0.6, 10, dt);
    }
    if (this.seated) {
      for (const s of ['rl', 'll'] as const) {
        if (!L[s].attached) continue;
        L[s].root.rotation.x = -Math.PI / 2;
        L[s].joint.rotation.x = Math.PI / 2;
      }
    }
  }
}
