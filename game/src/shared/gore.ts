import * as THREE from 'three';
import type { Engine } from './renderer';
import { Tex } from './textures';
import { rand } from './util';

/** Horizontal surface blood lands on (table top, floor). Bounds are world-space XZ. */
export interface Surface {
  y: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Vertical wall: the plane where position[axis] === at. normal points into the room (+1 or -1). */
export interface Wall {
  axis: 'x' | 'z';
  at: number;
  normal: 1 | -1;
}

export interface GoreHooks {
  /** A gib hit a surface hard. speed is m/s. */
  onImpact?: (speed: number) => void;
}

const MAX_PARTICLES = 1400;
const DECALS_PER_VARIANT = 220;
const MAX_GIBS = 70;
const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

interface Gib {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  r: number;
  bleed: number;
  rest: boolean;
  owned: boolean;
}

interface Stump {
  obj: THREE.Object3D;
  local: THREE.Vector3;
  dir: THREE.Vector3;
  t: number;
  dur: number;
  hz: number;
  power: number;
}

interface Pool {
  variant: number;
  index: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  angle: number;
  cur: number;
  target: number;
}

interface Rope {
  pts: THREE.Vector3[];
  prev: THREE.Vector3[];
  anchor: THREE.Object3D | null;
  anchorLocal: THREE.Vector3;
  anchorT: number;
  mesh: THREE.InstancedMesh;
}

/**
 * Everything wet: blood particles, persistent decals, bouncing gibs, pulsing neck stumps, gut ropes,
 * blood on the lens, muzzle flashes. One instance per round; call reset() between rounds.
 */
export class Gore {
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pVel = new Float32Array(MAX_PARTICLES * 3);
  private pSize = new Float32Array(MAX_PARTICLES);
  private pLife = new Float32Array(MAX_PARTICLES);
  private count = 0;
  private particles: THREE.InstancedMesh;
  private decals: THREE.InstancedMesh[] = [];
  private decalNext: number[] = [];
  private pools: Pool[] = [];
  private gibs: Gib[] = [];
  private stumps: Stump[] = [];
  private ropes: Rope[] = [];
  private smoke: { m: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private flash: THREE.Group;
  private flashLight: THREE.PointLight;
  private flashT = 0;
  private lensBudget = 0;
  private geo = {
    meat: new THREE.IcosahedronGeometry(1, 0),
    bone: new THREE.TetrahedronGeometry(1, 0),
    tooth: new THREE.BoxGeometry(1, 1.3, 0.8),
    eye: new THREE.IcosahedronGeometry(1, 1),
    gut: new THREE.CylinderGeometry(1, 1, 1, 6, 1).rotateX(Math.PI / 2),
    puff: new THREE.IcosahedronGeometry(1, 0),
  };
  private mat = {
    meat: new THREE.MeshLambertMaterial({ color: 0x6e0b0b, emissive: 0x1a0000, flatShading: true }),
    meatDark: new THREE.MeshLambertMaterial({ color: 0x3d0505, flatShading: true }),
    bone: new THREE.MeshLambertMaterial({ color: 0xd9ccb0, flatShading: true }),
    brain: new THREE.MeshLambertMaterial({ color: 0xc27f86, emissive: 0x1a0505, flatShading: true }),
    eye: new THREE.MeshLambertMaterial({ color: 0xece6da, flatShading: true }),
    gut: new THREE.MeshLambertMaterial({ color: 0xa0484d, emissive: 0x200404, flatShading: true }),
    smoke: new THREE.MeshBasicMaterial({ color: 0x6a6560, transparent: true, opacity: 0.2, depthWrite: false }),
  };

  constructor(
    readonly engine: Engine,
    public surfaces: Surface[],
    public walls: Wall[],
    readonly hooks: GoreHooks = {},
  ) {
    const scene = engine.scene;
    this.particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x8a0505 }), MAX_PARTICLES);
    this.particles.frustumCulled = false;
    this.particles.count = 0;
    scene.add(this.particles);

    for (let v = 0; v < 4; v++) {
      const m = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshLambertMaterial({ map: Tex.splat(v), color: 0xffffff, emissive: 0x2a0000, alphaTest: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
        DECALS_PER_VARIANT,
      );
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = 1;
      m.receiveShadow = true;
      scene.add(m);
      this.decals.push(m);
      this.decalNext.push(0);
    }

    this.flash = new THREE.Group();
    const star = new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.36, 5, 1, true), star);
      p.rotation.x = Math.PI / 2;
      p.position.z = 0.16;
      p.scale.set(1 + i * 0.4, 1 - i * 0.25, 1 + i * 0.4);
      this.flash.add(p);
    }
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), star);
    this.flash.add(core);
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffc070, 0, 9, 1.4);
    scene.add(this.flashLight);
  }

  /** Clear decals, gibs and stumps for a new round. */
  reset() {
    this.count = 0;
    this.decals.forEach((d, i) => {
      d.count = 0;
      this.decalNext[i] = 0;
    });
    this.pools = [];
    for (const g of this.gibs) if (g.owned) g.obj.removeFromParent();
    this.gibs = [];
    this.stumps = [];
    for (const r of this.ropes) r.mesh.removeFromParent();
    this.ropes = [];
  }

  /** Emit blood particles from origin along dir (normalised) with a cone spread (0 = laser, 1 = hemisphere). */
  spray(origin: THREE.Vector3, dir: THREE.Vector3, count: number, speed: [number, number], spread: number, size: [number, number] = [0.008, 0.02]) {
    for (let i = 0; i < count; i++) {
      if (this.count >= MAX_PARTICLES) return;
      const k = this.count++;
      tmpV.set(dir.x + rand(-1, 1) * spread, dir.y + rand(-1, 1) * spread, dir.z + rand(-1, 1) * spread).normalize().multiplyScalar(rand(speed[0], speed[1]));
      this.pPos[k * 3] = origin.x + rand(-0.02, 0.02);
      this.pPos[k * 3 + 1] = origin.y + rand(-0.02, 0.02);
      this.pPos[k * 3 + 2] = origin.z + rand(-0.02, 0.02);
      this.pVel[k * 3] = tmpV.x;
      this.pVel[k * 3 + 1] = tmpV.y;
      this.pVel[k * 3 + 2] = tmpV.z;
      this.pSize[k] = rand(size[0], size[1]);
      this.pLife[k] = rand(2, 4);
    }
  }

  /** Stamp a decal. normal must be axis-aligned-ish; size in metres. */
  decal(pos: THREE.Vector3, normal: THREE.Vector3, size: number, variant = Math.floor(rand(0, 3)), shade = rand(0.55, 1)) {
    const m = this.decals[variant];
    const i = this.decalNext[variant];
    this.decalNext[variant] = (i + 1) % DECALS_PER_VARIANT;
    m.count = Math.max(m.count, i + 1);
    this.writeDecal(m, i, pos, normal, rand(0, Math.PI * 2), size);
    m.setColorAt(i, tmpC.setRGB(shade, shade * 0.06, shade * 0.05));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    return i;
  }

  private writeDecal(m: THREE.InstancedMesh, i: number, pos: THREE.Vector3, normal: THREE.Vector3, angle: number, size: number) {
    tmpQ.setFromUnitVectors(Z, normal);
    tmpQ2.setFromAxisAngle(Z, angle);
    tmpQ.multiply(tmpQ2);
    tmpV2.copy(pos).addScaledVector(normal, 0.002);
    tmpM.compose(tmpV2, tmpQ, tmpS.set(size, size, 1));
    m.setMatrixAt(i, tmpM);
    m.instanceMatrix.needsUpdate = true;
  }

  /** A pool that spreads from 0 to radius over a few seconds (under a slumped body). */
  pool(pos: THREE.Vector3, radius: number) {
    const normal = new THREE.Vector3(0, 1, 0);
    const index = this.decal(pos, normal, 0.01, 3, rand(0.5, 0.7));
    this.pools.push({ variant: 3, index, pos: pos.clone(), normal, angle: rand(0, 6.28), cur: 0.01, target: radius });
  }

  /** Throw an existing object (hat, severed limb) as a physics gib. It is re-parented to the scene. */
  throwObject(obj: THREE.Object3D, vel: THREE.Vector3, spin: THREE.Vector3, radius: number, bleed = 0) {
    this.engine.scene.attach(obj);
    this.addGib({ obj, vel: vel.clone(), spin: spin.clone(), r: radius, bleed, rest: false, owned: false });
  }

  private addGib(g: Gib) {
    if (this.gibs.length >= MAX_GIBS) {
      const old = this.gibs.findIndex((x) => x.owned);
      if (old >= 0) {
        this.gibs[old].obj.removeFromParent();
        this.gibs.splice(old, 1);
      }
    }
    this.gibs.push(g);
  }

  /** Spawn a chunk: meat, bone, brain, eye or tooth. */
  gib(kind: 'meat' | 'bone' | 'brain' | 'eye' | 'tooth', origin: THREE.Vector3, vel: THREE.Vector3, size = 1) {
    let obj: THREE.Object3D;
    let r: number;
    if (kind === 'eye') {
      r = 0.017 * size;
      obj = new THREE.Mesh(this.geo.eye, this.mat.eye);
      obj.scale.setScalar(r);
      const iris = new THREE.Mesh(this.geo.eye, this.mat.meatDark);
      iris.scale.setScalar(0.45);
      iris.position.z = 0.8;
      obj.add(iris);
    } else if (kind === 'tooth') {
      r = 0.008 * size;
      obj = new THREE.Mesh(this.geo.tooth, this.mat.bone);
      obj.scale.setScalar(r);
    } else {
      r = rand(0.014, 0.04) * size;
      const geo = kind === 'bone' ? this.geo.bone : this.geo.meat;
      const mat = kind === 'bone' ? this.mat.bone : kind === 'brain' ? this.mat.brain : Math.random() < 0.5 ? this.mat.meat : this.mat.meatDark;
      obj = new THREE.Mesh(geo, mat);
      obj.scale.set(r * rand(0.7, 1.4), r * (kind === 'bone' ? 0.35 : rand(0.6, 1.2)), r * rand(0.7, 1.4));
    }
    obj.castShadow = true;
    obj.position.copy(origin);
    obj.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
    this.engine.scene.add(obj);
    this.addGib({ obj, vel: vel.clone(), spin: new THREE.Vector3(rand(-20, 20), rand(-20, 20), rand(-20, 20)), r, bleed: kind === 'bone' || kind === 'tooth' ? 0 : rand(0.5, 2), rest: false, owned: true });
  }

  /** A severed neck/limb that spurts in pulses. local/dir are in obj's space. */
  stump(obj: THREE.Object3D, local: THREE.Vector3, dir: THREE.Vector3, dur = 7, hz = 1.4, power = 1) {
    this.stumps.push({ obj, local: local.clone(), dir: dir.clone().normalize(), t: 0, dur, hz, power });
  }

  /** The full head-shot: skull, brain, eyes and teeth fly along dir, with a huge spray and mist. */
  explodeHead(origin: THREE.Vector3, dir: THREE.Vector3, scale = 1) {
    const d = dir.clone().normalize();
    this.spray(origin, d, Math.round(260 * scale), [2, 7], 0.45, [0.008, 0.026]);
    this.spray(origin, d, Math.round(90 * scale), [6, 11], 0.18, [0.005, 0.012]);
    this.spray(origin, UP, Math.round(90 * scale), [0.6, 2.6], 0.9, [0.01, 0.03]);
    const v = (sp: number, up: number) => d.clone().multiplyScalar(rand(sp * 0.5, sp)).add(tmpV.set(rand(-1, 1), rand(0.3, 1) * up, rand(-1, 1)));
    for (let i = 0; i < 7; i++) this.gib('bone', origin, v(5, 2.5), 1.3);
    for (let i = 0; i < 9; i++) this.gib('meat', origin, v(5, 2.5), 1.1);
    for (let i = 0; i < 4; i++) this.gib('brain', origin, v(4, 3), 1.2);
    for (let i = 0; i < 2; i++) this.gib('eye', origin, v(3, 3));
    for (let i = 0; i < 5; i++) this.gib('tooth', origin, v(4, 2));
  }

  /** Intestines slither out of obj at local, and drop to whatever is below. */
  gutSpill(obj: THREE.Object3D, local: THREE.Vector3, dir: THREE.Vector3) {
    const n = 16;
    obj.updateWorldMatrix(true, false);
    const start = obj.localToWorld(local.clone());
    const wd = dir.clone().normalize();
    const pts: THREE.Vector3[] = [], prev: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const p = start.clone().addScaledVector(wd, i * 0.01).add(tmpV.set(rand(-0.01, 0.01), -i * 0.004, rand(-0.01, 0.01)));
      pts.push(p);
      prev.push(p.clone().addScaledVector(wd, -0.02 - rand(0, 0.02)));
    }
    const mesh = new THREE.InstancedMesh(this.geo.gut, this.mat.gut, n - 1);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.engine.scene.add(mesh);
    this.ropes.push({ pts, prev, anchor: obj, anchorLocal: local.clone(), anchorT: 3, mesh });
    this.spray(start, wd, 120, [0.5, 2.5], 0.6, [0.01, 0.025]);
    this.pool(new THREE.Vector3(start.x, this.surfaceBelow(start)?.y ?? 0, start.z), 0.35);
  }

  /** Muzzle flash at pos facing dir, plus a puff of smoke. */
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.flash.position.copy(pos);
    this.flash.quaternion.setFromUnitVectors(Z, dir.clone().normalize());
    this.flash.rotateZ(rand(0, 6));
    this.flash.visible = true;
    this.flashLight.position.copy(pos).addScaledVector(dir, 0.1);
    this.flashLight.intensity = 60;
    this.flashT = 0.07;
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(this.geo.puff, this.mat.smoke.clone());
      m.position.copy(pos);
      m.scale.setScalar(rand(0.015, 0.035));
      this.engine.scene.add(m);
      this.smoke.push({ m, v: dir.clone().multiplyScalar(rand(0.3, 1.2)).add(tmpV.set(rand(-0.2, 0.2), rand(0, 0.3), rand(-0.2, 0.2))), life: 1 });
    }
  }

  private surfaceBelow(p: THREE.Vector3) {
    let best: Surface | null = null;
    for (const s of this.surfaces) if (p.x >= s.x0 && p.x <= s.x1 && p.z >= s.z0 && p.z <= s.z1 && s.y <= p.y + 0.001 && (!best || s.y > best.y)) best = s;
    return best;
  }

  update(dt: number) {
    if (dt <= 0) return;
    this.updateParticles(dt);
    this.updateGibs(dt);
    this.updateStumps(dt);
    this.updateRopes(dt);
    for (let i = this.pools.length - 1; i >= 0; i--) {
      const p = this.pools[i];
      p.cur += (p.target - p.cur) * (1 - Math.exp(-0.6 * dt));
      this.writeDecal(this.decals[p.variant], p.index, p.pos, p.normal, p.angle, p.cur);
      if (p.target - p.cur < 0.005) this.pools.splice(i, 1);
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life -= dt * 0.8;
      s.m.position.addScaledVector(s.v, dt);
      s.v.multiplyScalar(1 - 1.5 * dt);
      s.m.scale.multiplyScalar(1 + dt * 1.6);
      (s.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, s.life * 0.18);
      if (s.life <= 0) {
        s.m.removeFromParent();
        (s.m.material as THREE.Material).dispose();
        this.smoke.splice(i, 1);
      }
    }
  }

  private updateParticles(dt: number) {
    const cam = this.engine.camera;
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    this.lensBudget = 6;
    const P = this.pPos, V = this.pVel;
    let i = 0;
    while (i < this.count) {
      const k = i * 3;
      const ox = P[k], oy = P[k + 1], oz = P[k + 2];
      V[k + 1] -= 9.8 * dt;
      const drag = 1 - 0.35 * dt;
      V[k] *= drag;
      V[k + 2] *= drag;
      const nx = ox + V[k] * dt, ny = oy + V[k + 1] * dt, nz = oz + V[k + 2] * dt;
      this.pLife[i] -= dt;
      let dead = this.pLife[i] <= 0;
      if (!dead) {
        const dx = nx - cx, dy = ny - cy, dz = nz - cz;
        if (dx * dx + dy * dy + dz * dz < 0.09 && this.lensBudget > 0) {
          tmpV.set(nx, ny, nz).project(cam);
          if (tmpV.z < 1 && Math.abs(tmpV.x) < 1.2 && Math.abs(tmpV.y) < 1.2) {
            this.lensBudget--;
            this.engine.lens.splat((tmpV.x + 1) / 2, (1 - tmpV.y) / 2, rand(3, 9));
          }
          dead = true;
        }
      }
      if (!dead) {
        for (const s of this.surfaces) {
          if (oy >= s.y && ny < s.y && nx >= s.x0 && nx <= s.x1 && nz >= s.z0 && nz <= s.z1) {
            if (Math.random() < 0.55) this.decal(tmpV2.set(nx, s.y, nz), UP, this.pSize[i] * rand(3, 7));
            dead = true;
            break;
          }
        }
      }
      if (!dead) {
        for (const w of this.walls) {
          const o = w.axis === 'x' ? ox : oz, n = w.axis === 'x' ? nx : nz;
          if ((o - w.at) * w.normal >= 0 && (n - w.at) * w.normal < 0) {
            const pos = w.axis === 'x' ? tmpV2.set(w.at, ny, nz) : tmpV2.set(nx, ny, w.at);
            const normal = w.axis === 'x' ? tmpV.set(w.normal, 0, 0) : tmpV.set(0, 0, w.normal);
            if (Math.random() < 0.6) this.decal(pos, normal.clone(), this.pSize[i] * rand(3, 8), 2);
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        const last = --this.count;
        if (i !== last) {
          P[k] = P[last * 3];
          P[k + 1] = P[last * 3 + 1];
          P[k + 2] = P[last * 3 + 2];
          V[k] = V[last * 3];
          V[k + 1] = V[last * 3 + 1];
          V[k + 2] = V[last * 3 + 2];
          this.pSize[i] = this.pSize[last];
          this.pLife[i] = this.pLife[last];
        }
        continue;
      }
      P[k] = nx;
      P[k + 1] = ny;
      P[k + 2] = nz;
      const sp = Math.hypot(V[k], V[k + 1], V[k + 2]);
      tmpV.set(V[k], V[k + 1], V[k + 2]).divideScalar(sp || 1);
      tmpQ.setFromUnitVectors(UP, tmpV);
      const s = this.pSize[i];
      tmpM.compose(tmpV2.set(nx, ny, nz), tmpQ, tmpS.set(s, s * (1 + sp * 0.35), s));
      this.particles.setMatrixAt(i, tmpM);
      i++;
    }
    this.particles.count = this.count;
    this.particles.instanceMatrix.needsUpdate = true;
  }

  private updateGibs(dt: number) {
    for (const g of this.gibs) {
      if (g.rest) continue;
      const o = g.obj;
      g.vel.y -= 9.8 * dt;
      const prevY = o.position.y;
      o.position.addScaledVector(g.vel, dt);
      o.rotation.x += g.spin.x * dt;
      o.rotation.y += g.spin.y * dt;
      o.rotation.z += g.spin.z * dt;
      if (g.bleed > 0 && Math.random() < 30 * dt) {
        this.spray(o.position, g.vel.clone().normalize().negate(), 1, [0.1, 0.5], 0.8);
        g.bleed -= dt;
      }
      for (const s of this.surfaces) {
        const p = o.position;
        if (prevY - g.r >= s.y - 0.02 && p.y - g.r < s.y && p.x >= s.x0 && p.x <= s.x1 && p.z >= s.z0 && p.z <= s.z1) {
          const impact = -g.vel.y;
          p.y = s.y + g.r;
          g.vel.y = impact > 0.6 ? impact * 0.32 : 0;
          g.vel.x *= 0.6;
          g.vel.z *= 0.6;
          g.spin.multiplyScalar(0.5);
          if (impact > 1.2) {
            if (g.bleed > 0 || g.owned) this.decal(tmpV2.set(p.x, s.y, p.z), UP, g.r * rand(3, 6), 1);
            this.hooks.onImpact?.(impact);
          }
          if (impact <= 0.6 && Math.hypot(g.vel.x, g.vel.z) < 0.15) g.rest = true;
          break;
        }
      }
      for (const w of this.walls) {
        const p = o.position;
        const v = w.axis === 'x' ? p.x : p.z;
        if ((v - w.at) * w.normal < g.r) {
          if (w.axis === 'x') {
            p.x = w.at + w.normal * g.r;
            g.vel.x = Math.abs(g.vel.x) * w.normal * 0.3;
          } else {
            p.z = w.at + w.normal * g.r;
            g.vel.z = Math.abs(g.vel.z) * w.normal * 0.3;
          }
        }
      }
    }
  }

  private updateStumps(dt: number) {
    for (let i = this.stumps.length - 1; i >= 0; i--) {
      const s = this.stumps[i];
      s.t += dt;
      if (s.t > s.dur) {
        this.stumps.splice(i, 1);
        continue;
      }
      const fade = 1 - s.t / s.dur;
      const pulse = Math.pow(Math.max(0, Math.sin(s.t * Math.PI * 2 * s.hz)), 3) * fade * s.power;
      const pos = s.obj.localToWorld(tmpV.copy(s.local)).clone();
      s.obj.getWorldQuaternion(tmpQ);
      const dir = s.dir.clone().applyQuaternion(tmpQ);
      const n = Math.round(pulse * 160 * dt * 10) / 10 + (Math.random() < 6 * dt * fade ? 1 : 0);
      this.spray(pos, dir, Math.floor(n + Math.random()), [0.4 + pulse * 2.2, 0.8 + pulse * 3.2], 0.16, [0.008, 0.02]);
    }
  }

  private updateRopes(dt: number) {
    const seg = 0.045;
    for (const r of this.ropes) {
      const n = r.pts.length;
      for (let i = 0; i < n; i++) {
        const p = r.pts[i], q = r.prev[i];
        const vx = (p.x - q.x) * 0.98, vy = (p.y - q.y) * 0.98, vz = (p.z - q.z) * 0.98;
        q.copy(p);
        p.x += vx;
        p.y += vy - 9.8 * dt * dt;
        p.z += vz;
      }
      if (r.anchor && r.anchorT > 0) {
        r.anchorT -= dt;
        r.anchor.localToWorld(r.pts[0].copy(r.anchorLocal));
      }
      for (let it = 0; it < 4; it++) {
        for (let i = 0; i < n - 1; i++) {
          const a = r.pts[i], b = r.pts[i + 1];
          tmpV.subVectors(b, a);
          const d = tmpV.length() || 1e-5;
          const diff = (d - seg) / d / 2;
          if (i === 0 && r.anchorT > 0) b.addScaledVector(tmpV, -diff * 2);
          else {
            a.addScaledVector(tmpV, diff);
            b.addScaledVector(tmpV, -diff);
          }
        }
        for (const p of r.pts) {
          const s = this.surfaceBelow(tmpV2.copy(p).setY(p.y + 0.03));
          const floor = (s ? s.y : 0) + 0.016;
          if (p.y < floor) p.y = floor;
        }
      }
      for (let i = 0; i < n - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        tmpV.subVectors(b, a);
        const len = tmpV.length();
        tmpQ.setFromUnitVectors(Z, tmpV.divideScalar(len || 1));
        tmpM.compose(tmpV2.addVectors(a, b).multiplyScalar(0.5), tmpQ, tmpS.set(0.019, 0.019, len * 1.15));
        r.mesh.setMatrixAt(i, tmpM);
      }
      r.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

