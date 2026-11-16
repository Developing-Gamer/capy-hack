import * as THREE from 'three';
import { clamp, rand } from './util';

/** CSS pixels per rendered pixel. ~1.6 gives roughly a third of a 3x phone's physical resolution. */
const PIXEL = 1.6;

const POST_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const POST_FRAG = `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBlood;
uniform vec2 res;
uniform vec2 bloodRes;
uniform float time;
uniform float flash;
uniform vec3 flashColor;
uniform float vignette;
uniform float levels;
uniform float grain;
uniform float tint;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0)); int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  float m[16];
  m[0]=0.0; m[1]=8.0; m[2]=2.0; m[3]=10.0; m[4]=12.0; m[5]=4.0; m[6]=14.0; m[7]=6.0;
  m[8]=3.0; m[9]=11.0; m[10]=1.0; m[11]=9.0; m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
  for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0;
  return 0.0;
}
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

void main() {
  vec2 px = floor(vUv * res);
  vec2 uv = (px + 0.5) / res;
  vec4 b = texture2D(tBlood, vUv);
  float bu = texture2D(tBlood, vUv + vec2(0.0, 2.0 / bloodRes.y)).a;
  float br = texture2D(tBlood, vUv + vec2(2.0 / bloodRes.x, 0.0)).a;
  vec2 grad = vec2(br - b.a, bu - b.a);
  vec3 c = toSrgb(texture2D(tScene, uv + grad * 0.04).rgb);
  c = mix(c, c * vec3(1.25, 0.55, 0.5), tint);
  float d = bayer4(px) - 0.5;
  c = floor(c * levels + 0.5 + d * 0.9) / levels;
  c += (hash(px + fract(time * 7.13) * 97.0) - 0.5) * grain;
  vec2 q = vUv - 0.5;
  c *= clamp(1.0 - dot(q * vec2(1.25, 0.9), q * vec2(1.25, 0.9)) * vignette, 0.0, 1.0);
  float wet = clamp(b.a * 1.4, 0.0, 1.0);
  vec3 blood = b.rgb * (0.35 + 0.5 * dot(c, vec3(0.33)));
  c = mix(c, blood, wet * 0.92);
  c += vec3(1.0, 0.6, 0.55) * clamp(-grad.y * 4.0 - 0.15, 0.0, 1.0) * wet * 0.3;
  c += flashColor * flash;
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * Blood on the lens: a small 2D canvas the post shader composites over the frame with a wet
 * refraction edge. Splats run down as drips and slowly dry off.
 */
export class LensBlood {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private drips: { x: number; y: number; w: number; v: number; life: number }[] = [];
  private dirty = true;
  private fadeT = 0;
  /** While true, blood never dries (the subject is dead). */
  permanent = false;

  constructor() {
    this.canvas.width = 160;
    this.canvas.height = 320;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
  }

  private color(a = 1) {
    const r = Math.floor(rand(120, 170)), gg = Math.floor(rand(4, 16));
    return `rgba(${r},${gg},${gg},${a})`;
  }

  private dot(x: number, y: number, r: number, a: number) {
    const g = this.g;
    g.fillStyle = this.color(a);
    g.beginPath();
    g.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    g.fill();
  }

  /** Splat at normalised screen coords (0..1, y down). size is in canvas pixels. */
  splat(x: number, y: number, size: number) {
    const W = this.canvas.width, H = this.canvas.height;
    const cx = x * W, cy = y * H;
    const blobs = 3 + Math.floor(size / 3);
    for (let i = 0; i < blobs; i++) {
      const a = rand(0, Math.PI * 2), d = rand(0, size * 0.55);
      this.dot(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * rand(0.25, 0.55), rand(0.55, 0.9));
    }
    const rays = 2 + Math.floor(size / 4);
    for (let i = 0; i < rays; i++) {
      const a = rand(0, Math.PI * 2), len = size * rand(1.1, 2.4);
      for (let s = 0.4; s < 1; s += 0.12) this.dot(cx + Math.cos(a) * len * s, cy + Math.sin(a) * len * s, size * 0.12 * (1.1 - s), 0.8);
      this.dot(cx + Math.cos(a) * len, cy + Math.sin(a) * len, size * rand(0.06, 0.14), 0.9);
    }
    const drops = Math.floor(size * 0.6);
    for (let i = 0; i < drops; i++) {
      const a = rand(0, 7), d = rand(size * 0.8, size * 2.8);
      this.dot(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rand(0.4, Math.max(0.6, size * 0.09)), rand(0.6, 0.95));
    }
    const n = 1 + Math.floor(size / 7);
    for (let i = 0; i < n; i++) this.drips.push({ x: cx + rand(-size * 0.7, size * 0.7), y: cy + rand(0, size * 0.4), w: rand(1.2, 2.8), v: rand(6, 22), life: rand(1.5, 5) });
    this.dirty = true;
  }

  /** A burst of splats around a point, scaled by intensity 0..1+. */
  burst(x: number, y: number, intensity: number) {
    const n = Math.ceil(2 + intensity * 7);
    for (let i = 0; i < n; i++) this.splat(x + rand(-0.4, 0.4) * intensity, y + rand(-0.3, 0.3) * intensity, rand(2, 5 + intensity * 7));
  }

  /** Full coverage for the subject's own death. */
  cover() {
    this.permanent = true;
    for (let i = 0; i < 7; i++) this.splat(rand(0.2, 0.8), rand(0.15, 0.6), rand(16, 30));
    for (let i = 0; i < 22; i++) this.splat(rand(0, 1), rand(0, 0.95), rand(3, 12));
  }

  clear() {
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drips = [];
    this.permanent = false;
    this.dirty = true;
  }

  update(dt: number) {
    const g = this.g;
    for (const d of this.drips) {
      const ny = d.y + d.v * dt;
      g.fillStyle = this.color(0.85);
      g.fillRect(d.x - d.w / 2, d.y, d.w, ny - d.y + 1);
      g.beginPath();
      g.arc(d.x, ny, d.w * 0.75, 0, 7);
      g.fill();
      d.y = ny;
      d.v *= 1 - 0.25 * dt;
      d.life -= dt;
      this.dirty = true;
    }
    this.drips = this.drips.filter((d) => d.life > 0 && d.y < this.canvas.height + 4);
    if (!this.permanent) {
      this.fadeT += dt;
      if (this.fadeT > 0.15) {
        this.fadeT = 0;
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = 'rgba(0,0,0,0.035)';
        g.fillRect(0, 0, this.canvas.width, this.canvas.height);
        g.globalCompositeOperation = 'source-over';
        this.dirty = true;
      }
    }
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }
}

/** A practical light: emissive bulb mesh + light that buzzes and drops out at random. */
export class Flicker {
  private t = 0;
  private out = 0;
  constructor(
    readonly light: THREE.Light,
    readonly bulb: THREE.MeshBasicMaterial | null,
    readonly base = light.intensity,
    readonly chance = 0.6,
  ) {}
  update(dt: number) {
    this.t += dt;
    if (this.out > 0) this.out -= dt;
    else if (Math.random() < this.chance * dt) this.out = rand(0.03, 0.18);
    const buzz = 0.92 + Math.sin(this.t * 120) * 0.04 + Math.random() * 0.04;
    const k = this.out > 0 ? rand(0.05, 0.35) : buzz;
    this.light.intensity = this.base * k;
    if (this.bulb) this.bulb.color.setScalar(0.35 + k * 0.65);
  }
}

/**
 * The Machine Party renderer: scene → low-res half-float target → one post pass (dither/posterize,
 * grain, vignette, lens blood, flashes) drawn with nearest sampling at screen size.
 * Also owns camera shake, slow-mo and the frame loop.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.03, 60);
  readonly lens = new LensBlood();
  private rt: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private post: THREE.ShaderMaterial;
  private trauma = 0;
  private flashV = 0;
  private slowT = 0;
  private slowScale = 1;
  private last = 0;
  private frameTimes: number[] = [];
  private fpsSamples: number[] = [];
  private lastSample = 0;
  private warmup = 0;
  /** Red tint 0..1 the game can drive for danger. */
  tint = 0;
  timeScale = 1;
  time = 0;
  onUpdate: (dt: number, t: number) => void = () => {};

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    const ext = this.renderer.extensions;
    const half = ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.post = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.rt.texture },
        tBlood: { value: this.lens.texture },
        res: { value: new THREE.Vector2() },
        bloodRes: { value: new THREE.Vector2(this.lens.canvas.width, this.lens.canvas.height) },
        time: { value: 0 },
        flash: { value: 0 },
        flashColor: { value: new THREE.Color(1, 0.85, 0.6) },
        vignette: { value: 1.35 },
        levels: { value: 28 },
        grain: { value: 0.05 },
        tint: { value: 0 },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    quad.frustumCulled = false;
    this.postScene.add(quad);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const rw = Math.max(64, Math.round(w / PIXEL)), rh = Math.max(64, Math.round(h / PIXEL));
    this.rt.setSize(rw, rh);
    (this.post.uniforms.res.value as THREE.Vector2).set(rw, rh);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Add camera trauma (0..1). Shake grows with trauma squared. */
  shake(amount: number) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  flash(amount: number, color = 0xffd9a0) {
    this.flashV = Math.max(this.flashV, amount);
    (this.post.uniforms.flashColor.value as THREE.Color).set(color);
  }

  /** Slow time to `scale` for `seconds` of real time, then ease back. */
  slowmo(seconds: number, scale = 0.25) {
    this.slowT = Math.max(this.slowT, seconds);
    this.slowScale = Math.min(this.slowScale, scale);
  }

  /**
   * Compile every material in the scene, hidden objects included, and draw one frame, so shaders
   * (and shadow variants) build at load instead of at the first kill. Call once after the game is built.
   */
  prewarm() {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.visible) return;
      o.visible = true;
      hidden.push(o);
    });
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    for (const o of hidden) o.visible = false;
  }

  /** Average and worst-second fps since start. */
  perf() {
    const s = this.fpsSamples.length ? this.fpsSamples : [60];
    return { fps: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, minFps: Math.round(Math.min(...s) * 10) / 10 };
  }

  start() {
    this.last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const real = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      this.trackFps(now);
      if (this.slowT > 0) {
        this.slowT -= real;
        if (this.slowT <= 0) this.slowScale = 1;
      }
      const target = this.slowT > 0 ? this.slowScale : 1;
      this.timeScale += (target - this.timeScale) * (1 - Math.exp(-(this.slowT > 0 ? 30 : 4) * real));
      const dt = real * this.timeScale;
      this.time += dt;
      this.onUpdate(dt, this.time);
      this.lens.update(real);
      this.render(real);
    };
    requestAnimationFrame(loop);
  }

  private trackFps(now: number) {
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    if (!this.lastSample) this.lastSample = now;
    if (now - this.lastSample < 1000) return;
    this.lastSample = now;
    if (++this.warmup <= 3) return;
    this.fpsSamples.push(this.frameTimes.length);
    if (this.fpsSamples.length > 600) this.fpsSamples.shift();
  }

  private render(real: number) {
    const cam = this.camera;
    const s = this.trauma * this.trauma;
    const px = cam.position.clone(), rot = cam.rotation.clone();
    if (s > 0.0001) {
      cam.position.x += rand(-1, 1) * 0.05 * s;
      cam.position.y += rand(-1, 1) * 0.05 * s;
      cam.rotation.z += rand(-1, 1) * 0.06 * s;
      cam.rotation.x += rand(-1, 1) * 0.03 * s;
    }
    this.trauma = Math.max(0, this.trauma - real * 1.6);
    this.flashV = Math.max(0, this.flashV - real * 7);
    const u = this.post.uniforms;
    u.time.value = this.time;
    u.flash.value = this.flashV;
    u.tint.value = this.tint;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, cam);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
    cam.position.copy(px);
    cam.rotation.copy(rot);
  }
}
