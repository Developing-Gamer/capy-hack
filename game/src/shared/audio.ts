import { rand } from './util';

/**
 * Procedural industrial audio. Everything is synthesised; no files. The context is created on the
 * first touch (iOS requires a gesture), and every method is a no-op until then.
 */
class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private muffler!: BiquadFilterNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private verb!: ConvolverNode;
  private noise!: AudioBuffer;
  private droneNodes: { stop: () => void } | null = null;
  private beatTimer = 0;
  private beatStep = 0;
  private beatNext = 0;
  /** 0..1, raises the density and volume of the mechanical beat. */
  intensity = 0.4;
  bpm = 100;

  constructor() {
    const unlock = () => {
      this.unlock();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('touchend', unlock);
        window.removeEventListener('keydown', unlock);
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('touchend', unlock);
    window.addEventListener('keydown', unlock);
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.muffler = ctx.createBiquadFilter();
      this.muffler.type = 'lowpass';
      this.muffler.frequency.value = 20000;
      this.master.connect(this.muffler).connect(comp).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.55;
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.verb = ctx.createConvolver();
      const ir = ctx.createBuffer(2, ctx.sampleRate * 1.8, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 2.6);
      }
      this.verb.buffer = ir;
      const verbGain = ctx.createGain();
      verbGain.gain.value = 0.35;
      this.verb.connect(verbGain).connect(this.master);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private get t() {
    return this.ctx!.currentTime;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseSrc(t: number, dur: number) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.start(t, rand(0, 1.5), dur + 0.05);
    return s;
  }

  private filter(type: BiquadFilterType, freq: number, q = 1) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private out(node: AudioNode, wet = 0, bus: AudioNode = this.sfxBus) {
    node.connect(bus);
    if (wet > 0) {
      const w = this.ctx!.createGain();
      w.gain.value = wet;
      node.connect(w).connect(this.verb);
    }
  }

  private osc(type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, wet = 0, bus?: AudioNode) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = this.ctx!.createGain();
    this.env(g, t, peak, 0.004, dur);
    o.connect(g);
    this.out(g, wet, bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(t: number, dur: number, type: BiquadFilterType, freq: number, peak: number, q = 1, wet = 0, bus?: AudioNode) {
    const s = this.noiseSrc(t, dur);
    const g = this.ctx!.createGain();
    this.env(g, t, peak, 0.002, dur);
    s.connect(this.filter(type, freq, q)).connect(g);
    this.out(g, wet, bus);
  }

  /** Desert Eagle: crack, body, sub thump, long room tail. */
  gunshot() {
    if (!this.ctx) return;
    const t = this.t;
    this.burst(t, 0.09, 'highpass', 900, 1.6, 0.7, 0.8);
    this.burst(t, 0.5, 'lowpass', 1400, 1.4, 0.8, 1.2);
    this.osc('sine', 150, 38, t, 0.32, 1.6, 0.4);
    this.osc('square', 90, 30, t, 0.12, 0.35);
    this.burst(t + 0.05, 1.4, 'bandpass', 500, 0.12, 0.6, 1.5);
  }

  /** Wet meat. */
  squelch(size = 1) {
    if (!this.ctx) return;
    const t = this.t;
    const dur = 0.25 + size * 0.2;
    const s = this.noiseSrc(t, dur);
    const f = this.filter('bandpass', 500, 5);
    f.frequency.setValueAtTime(rand(300, 600), t);
    f.frequency.exponentialRampToValueAtTime(rand(1200, 2200), t + dur * 0.3);
    f.frequency.exponentialRampToValueAtTime(rand(200, 400), t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, 0.9 * size, 0.01, dur);
    s.connect(f).connect(g);
    this.out(g, 0.3);
    this.osc('sine', rand(90, 140), 40, t, dur * 0.8, 0.5 * size);
  }

  /** Bone crunch: a fast run of clicks over a thud. */
  crunch(size = 1) {
    if (!this.ctx) return;
    const t = this.t;
    let tt = t;
    const n = Math.round(6 + size * 5);
    for (let i = 0; i < n; i++) {
      this.burst(tt, 0.018, 'bandpass', rand(1800, 4200), rand(0.4, 0.9) * size, 2);
      tt += rand(0.012, 0.035);
    }
    this.osc('sine', 110, 45, t, 0.18, 0.7 * size);
  }

  /** Gib hitting a hard surface. */
  splat(speed: number) {
    if (!this.ctx) return;
    const v = Math.min(1, speed / 6);
    this.burst(this.t, 0.06 + v * 0.06, 'bandpass', rand(400, 900), 0.15 + v * 0.4, 1.5);
  }

  /** Newspaper rustle. */
  rustle(dur = 0.5, vol = 0.6) {
    if (!this.ctx) return;
    let tt = this.t;
    while (tt < this.t + dur) {
      this.burst(tt, rand(0.02, 0.07), 'bandpass', rand(2500, 6000), rand(0.15, 0.5) * vol, 1.2, 0.2);
      tt += rand(0.012, 0.04);
    }
  }

  /** Sharp paper snap for a sudden lower. */
  snap() {
    if (!this.ctx) return;
    this.burst(this.t, 0.08, 'highpass', 2500, 0.9, 0.7, 0.4);
    this.rustle(0.15, 0.8);
  }

  /** Fork on china. */
  clink(high = false) {
    if (!this.ctx) return;
    const t = this.t;
    const f = high ? 3600 : 2600;
    this.osc('sine', f, f * 0.98, t, 0.25, 0.18, 0.2);
    this.osc('sine', f * 1.51, f * 1.5, t, 0.15, 0.08, 0.2);
    this.burst(t, 0.015, 'highpass', 5000, 0.2);
  }

  /** Soft chewing. */
  chew() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) this.burst(this.t + i * 0.09, 0.06, 'lowpass', 700, 0.18, 1);
  }

  /** Low metallic sting when he looks up. */
  sting() {
    if (!this.ctx) return;
    const t = this.t;
    this.metal(t, 70, 0.6, 1.2);
    this.osc('sawtooth', 55, 52, t, 1.1, 0.22, 0.8);
  }

  /** Tinnitus after a close gunshot or your own death. */
  ring(dur = 3) {
    if (!this.ctx) return;
    this.osc('sine', 3900, 3850, this.t, dur, 0.06);
  }

  /** Lowpass the whole mix (0 = clear, 1 = underwater). */
  muffle(amount: number) {
    if (!this.ctx) return;
    this.muffler.frequency.setTargetAtTime(20000 * Math.pow(0.012, amount), this.t, 0.08);
  }

  private metal(t: number, f: number, peak: number, dur: number, bus?: AudioNode) {
    const ctx = this.ctx!;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    car.type = 'square';
    car.frequency.value = f;
    mod.frequency.value = f * 3.73;
    mg.gain.setValueAtTime(f * 8, t);
    mg.gain.exponentialRampToValueAtTime(1, t + dur);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    this.env(g, t, peak, 0.002, dur);
    car.connect(this.filter('bandpass', f * 6, 1.5)).connect(g);
    this.out(g, 0.6, bus);
    car.start(t);
    mod.start(t);
    car.stop(t + dur + 0.1);
    mod.stop(t + dur + 0.1);
  }

  /** Low drone bed: detuned saws through a slowly breathing lowpass, mains hum and air. */
  drone(on: boolean) {
    if (!this.ctx) return;
    if (!on) {
      this.droneNodes?.stop();
      this.droneNodes = null;
      return;
    }
    if (this.droneNodes) return;
    const ctx = this.ctx, t = this.t;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 2);
    const lp = this.filter('lowpass', 240, 3);
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoG.gain.value = 120;
    lfo.connect(lfoG).connect(lp.frequency);
    const oscs = [55, 55.6, 82.4, 110.3].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i < 2 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = i < 2 ? 0.3 : 0.08;
      o.connect(og).connect(lp);
      return o;
    });
    const hum = ctx.createOscillator();
    hum.type = 'square';
    hum.frequency.value = 50;
    const humG = ctx.createGain();
    humG.gain.value = 0.025;
    hum.connect(this.filter('lowpass', 400)).connect(humG).connect(g);
    const air = ctx.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    const airG = ctx.createGain();
    airG.gain.value = 0.05;
    air.connect(this.filter('bandpass', 300, 0.5)).connect(airG).connect(g);
    lp.connect(g);
    g.connect(this.musicBus);
    const all = [...oscs, hum, lfo, air];
    all.forEach((o) => o.start(t));
    this.droneNodes = {
      stop: () => {
        const n = this.t;
        g.gain.setTargetAtTime(0.0001, n, 0.4);
        all.forEach((o) => o.stop(n + 2));
      },
    };
  }

  /** Mechanical beat: kick, clank, hiss and pistons, scheduled ahead on a timer. */
  beat(on: boolean) {
    if (!this.ctx) return;
    clearInterval(this.beatTimer);
    if (!on) return;
    this.beatNext = this.t + 0.1;
    this.beatStep = 0;
    this.beatTimer = window.setInterval(() => {
      if (!this.ctx) return;
      const step = 60 / this.bpm / 4;
      while (this.beatNext < this.t + 0.2) {
        this.beatTick(this.beatNext, this.beatStep % 16);
        this.beatNext += step;
        this.beatStep++;
      }
    }, 50);
  }

  private beatTick(t: number, s: number) {
    const k = this.intensity, bus = this.musicBus;
    if (s === 0 || s === 8 || (k > 0.6 && s === 10)) this.osc('sine', 120, 38, t, 0.28, 0.5 + k * 0.4, 0.1, bus);
    if (s === 4 || s === 12) this.metal(t, s === 4 ? 92 : 87, 0.07 + k * 0.12, 0.25, bus);
    if (s % 2 === 1 && k > 0.3) this.burst(t, 0.03, 'highpass', 7000, 0.04 + k * 0.05, 1, 0, bus);
    if (s === 14) this.burst(t, 0.22, 'bandpass', 3000, 0.05 + k * 0.08, 0.8, 0.3, bus);
    if (k > 0.75 && (s === 6 || s === 7)) this.metal(t, 140, 0.05, 0.08, bus);
  }
}

export const sound = new Sound();
