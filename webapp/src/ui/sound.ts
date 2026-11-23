/**
 * Music and sound effects, made in the browser with the Web Audio API: no sound files to
 * download, nothing to license, and it works on the old Chromium of TV browsers.
 *
 * `Synth` plays on any AudioContext (also an OfflineAudioContext, to render a sound to
 * a file). `Sound` owns the page's AudioContext: it starts silent and needs one press or
 * tap to start (browsers block sound until then), and remembers whether it's switched on.
 */

export type Track = 'lobby' | 'draw' | 'fib' | 'vote';
export type Effect =
  | 'tick'
  | 'tock'
  | 'tickUrgent'
  | 'countdown'
  | 'go'
  | 'chime'
  | 'drumroll'
  | 'whoosh'
  | 'nobody'
  | 'fooled'
  | 'truth'
  | 'scores'
  | 'gameOver';

type Ctx = BaseAudioContext;

/** Note number (MIDI: 60 is middle C) to frequency. */
const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

/** A small seeded random generator, so a tune can vary but stays the same while it loops. */
const rand = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
};

interface Voice {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** How long the note takes to fade out after `dur`. */
  release?: number;
  /** Glide to this frequency over the note. */
  glideTo?: number;
  /** A low-pass filter's cutoff, for a softer sound. */
  lowpass?: number;
  /** Vibrato depth in Hz. */
  vibrato?: number;
}

/** One musical idea, as a function of the 16th-note step: the notes and drums to play there. */
interface TrackDef {
  bpm: number;
  /** How loud the whole track plays. */
  level: number;
  /** Bars before the melody is made up anew. */
  phrase: number;
  play: (synth: Synth, step: number, t: number, r: () => number, phrase: number[]) => void;
  /** Makes up a melody for a phrase: a note (or -1 for a rest) per 16th step. */
  compose: (r: () => number) => number[];
}

const PENTA = [0, 2, 4, 7, 9];
const MINOR_PENTA = [0, 3, 5, 7, 10];

/** A wandering melody on a scale: mostly small steps, some rests, on the given steps of a bar. */
const melody = (r: () => number, root: number, scale: number[], steps: number[], bars: number, restChance: number) => {
  const out: number[] = new Array(bars * 16).fill(-1);
  let i = Math.floor(r() * scale.length) + scale.length;
  for (let b = 0; b < bars; b++)
    for (const s of steps) {
      if (r() < restChance) continue;
      i = Math.max(0, Math.min(scale.length * 3 - 1, i + Math.floor(r() * 5) - 2));
      out[b * 16 + s] = root + scale[i % scale.length] + 12 * Math.floor(i / scale.length);
    }
  return out;
};

const TRACKS: Record<Track, TrackDef> = {
  // Bouncy and bright, for drawing: plucky bass on I–vi–IV–V, a toy-piano tune, soft drums.
  draw: {
    bpm: 112,
    level: 0.9,
    phrase: 4,
    compose: (r) => melody(r, 72, PENTA, [0, 3, 6, 8, 10, 12, 14], 4, 0.35),
    play: (s, step, t, _r, tune) => {
      const bar = Math.floor(step / 16) % 4;
      const beat = step % 16;
      const root = [48, 45, 41, 43][bar];
      if (beat === 0 || beat === 8) s.tone(hz(root), t, 0.18, { type: 'triangle', gain: 0.32, release: 0.12 });
      if (beat === 6 || beat === 14) s.tone(hz(root + 12), t, 0.1, { type: 'triangle', gain: 0.2, release: 0.08 });
      const n = tune[step % tune.length];
      if (n > 0) s.tone(hz(n), t, 0.09, { type: 'square', gain: 0.07, release: 0.18, lowpass: 2600 });
      if (beat === 0 || beat === 8) s.kick(t, 0.35);
      if (beat === 4 || beat === 12) s.snap(t, 0.12);
      if (beat % 2 === 0) s.hat(t, beat % 4 === 2 ? 0.06 : 0.035);
    },
  },
  // Sneaky, for making up fake titles: a creeping pizzicato bass, a few marimba notes, finger snaps.
  fib: {
    bpm: 96,
    level: 0.85,
    phrase: 4,
    compose: (r) => melody(r, 69, MINOR_PENTA, [2, 7, 10, 15], 4, 0.4),
    play: (s, step, t, _r, tune) => {
      const beat = step % 16;
      const walk = [45, 48, 50, 51, 52, 50, 48, 47];
      if (beat % 4 === 0) s.tone(hz(walk[(step / 4) % walk.length]), t, 0.08, { type: 'triangle', gain: 0.34, release: 0.1, lowpass: 900 });
      const n = tune[step % tune.length];
      if (n > 0) s.tone(hz(n), t, 0.05, { type: 'sine', gain: 0.16, release: 0.35 });
      if (beat === 4 || beat === 12) s.snap(t, 0.16);
      if (beat % 4 === 2) s.hat(t, 0.04);
    },
  },
  // Suspense, for voting: a slow heartbeat bass and a few high, glassy notes.
  vote: {
    bpm: 84,
    level: 0.8,
    phrase: 4,
    compose: (r) => melody(r, 81, MINOR_PENTA, [6, 14], 4, 0.45),
    play: (s, step, t, _r, tune) => {
      const beat = step % 16;
      if (beat === 0 || beat === 3) s.tone(hz(33), t, 0.2, { type: 'sine', gain: beat === 0 ? 0.5 : 0.3, release: 0.2, glideTo: hz(31) });
      if (beat === 8) s.tone(hz(40), t, 0.25, { type: 'sine', gain: 0.25, release: 0.3 });
      const n = tune[step % tune.length];
      if (n > 0) s.tone(hz(n), t, 0.04, { type: 'sine', gain: 0.07, release: 0.6 });
      if (beat % 4 === 0) s.hat(t, 0.025);
    },
  },
  // Calm and friendly, while everyone joins: the drawing tune's chords, slower, without drums.
  lobby: {
    bpm: 92,
    level: 0.6,
    phrase: 4,
    compose: (r) => melody(r, 72, PENTA, [0, 6, 10], 4, 0.4),
    play: (s, step, t, _r, tune) => {
      const bar = Math.floor(step / 16) % 4;
      const beat = step % 16;
      const root = [48, 45, 41, 43][bar];
      if (beat === 0) for (const i of [0, 4, 7]) s.tone(hz(root + 12 + i), t, 0.5, { type: 'triangle', gain: 0.08, attack: 0.03, release: 0.6 });
      if (beat === 8) s.tone(hz(root), t, 0.3, { type: 'triangle', gain: 0.22, release: 0.2 });
      const n = tune[step % tune.length];
      if (n > 0) s.tone(hz(n), t, 0.08, { type: 'sine', gain: 0.12, release: 0.4 });
    },
  },
};

/** Instruments and effects on an audio context, all routed into one output. */
export class Synth {
  private noiseBuffer: AudioBuffer | null = null;

  constructor(
    readonly ctx: Ctx,
    readonly out: AudioNode,
  ) {}

  /** A note: an oscillator with an envelope (and optionally a filter, a glide, a vibrato). */
  tone(freq: number, t: number, dur: number, v: Voice = {}, dest: AudioNode = this.out) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = v.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (v.glideTo) osc.frequency.exponentialRampToValueAtTime(v.glideTo, t + dur);
    const peak = v.gain ?? 0.2;
    const attack = v.attack ?? 0.005;
    const release = v.release ?? 0.08;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + attack);
    env.gain.setValueAtTime(peak, t + Math.max(attack, dur));
    env.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack, dur) + release);
    let node: AudioNode = osc;
    if (v.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = v.lowpass;
      node.connect(f);
      node = f;
    }
    if (v.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.value = v.vibrato;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + release + 0.05);
    }
    node.connect(env);
    env.connect(dest);
    osc.start(t);
    osc.stop(t + Math.max(attack, dur) + release + 0.05);
  }

  private noise() {
    if (!this.noiseBuffer) {
      const len = Math.floor(this.ctx.sampleRate * 1);
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  /** A burst of filtered noise: drums, clicks, whooshes. */
  hiss(t: number, dur: number, opts: { gain: number; type: BiquadFilterType; freq: number; freqTo?: number; q?: number; attack?: number }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(opts.freqTo, t + dur);
    f.Q.value = opts.q ?? 1;
    const env = ctx.createGain();
    const attack = opts.attack ?? 0.002;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(opts.gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(env);
    env.connect(this.out);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  kick(t: number, gain: number) {
    this.tone(120, t, 0.09, { type: 'sine', gain, glideTo: 42, release: 0.06 });
  }

  hat(t: number, gain: number) {
    this.hiss(t, 0.04, { gain, type: 'highpass', freq: 7000 });
  }

  snap(t: number, gain: number) {
    this.hiss(t, 0.07, { gain, type: 'bandpass', freq: 2200, q: 2 });
  }

  /** A sound effect, starting at `t`. */
  effect(name: Effect, t: number, opts: { count?: number } = {}) {
    switch (name) {
      // A wooden clock: tick, tock, and a sharper tick for the last seconds.
      case 'tick':
        this.tone(1900, t, 0.012, { type: 'sine', gain: 0.35, release: 0.04 });
        this.hiss(t, 0.025, { gain: 0.15, type: 'bandpass', freq: 3500, q: 4 });
        break;
      case 'tock':
        this.tone(1300, t, 0.012, { type: 'sine', gain: 0.3, release: 0.05 });
        this.hiss(t, 0.025, { gain: 0.12, type: 'bandpass', freq: 2400, q: 4 });
        break;
      case 'tickUrgent':
        this.tone(2400, t, 0.02, { type: 'square', gain: 0.12, release: 0.05, lowpass: 5000 });
        this.tone(1200, t, 0.02, { type: 'sine', gain: 0.3, release: 0.06 });
        break;
      case 'countdown':
        this.tone(hz(76), t, 0.12, { type: 'triangle', gain: 0.35, release: 0.1 });
        break;
      case 'go':
        this.tone(hz(83), t, 0.25, { type: 'triangle', gain: 0.35, release: 0.25 });
        this.tone(hz(88), t, 0.25, { type: 'sine', gain: 0.2, release: 0.25 });
        break;
      // A rising three-note marimba: something new starts.
      case 'chime':
        [72, 76, 79, 84].forEach((n, i) => this.tone(hz(n), t + i * 0.09, 0.05, { type: 'sine', gain: 0.25, release: 0.4 }));
        break;
      // A snare roll that grows, then a crash.
      case 'drumroll': {
        const len = 2.6;
        for (let x = 0; x < len; x += 0.045) this.hiss(t + x, 0.05, { gain: 0.04 + (x / len) * 0.16, type: 'bandpass', freq: 1800, q: 1.2 });
        this.hiss(t + len, 1.2, { gain: 0.3, type: 'highpass', freq: 4000 });
        this.kick(t + len, 0.5);
        break;
      }
      // A title flies in.
      case 'whoosh':
        this.hiss(t, 0.4, { gain: 0.22, type: 'bandpass', freq: 400, freqTo: 3500, q: 1.5, attack: 0.2 });
        this.tone(hz(84), t + 0.32, 0.03, { type: 'sine', gain: 0.18, release: 0.25 });
        break;
      // Who picked it: a rising blip per voter (or a shrug of two low notes for nobody).
      case 'nobody':
        this.tone(hz(60), t, 0.1, { type: 'triangle', gain: 0.22, release: 0.1 });
        this.tone(hz(55), t + 0.16, 0.18, { type: 'triangle', gain: 0.2, release: 0.15 });
        break;
      // A fake fooled someone: a sad, sliding horn.
      case 'fooled':
        [55, 54, 53].forEach((n, i) => this.tone(hz(n), t + i * 0.32, 0.24, { type: 'sawtooth', gain: 0.13, release: 0.06, lowpass: 1300, glideTo: hz(n - 0.3) }));
        this.tone(hz(52), t + 0.96, 0.75, { type: 'sawtooth', gain: 0.13, release: 0.25, lowpass: 1300, vibrato: 6 });
        break;
      // The real title: a bright fanfare.
      case 'truth':
        [60, 64, 67].forEach((n, i) => this.tone(hz(n + 12), t + i * 0.11, 0.08, { type: 'square', gain: 0.1, release: 0.06, lowpass: 3500 }));
        for (const n of [72, 76, 79, 84]) this.tone(hz(n), t + 0.36, 0.7, { type: 'triangle', gain: 0.14, release: 0.6 });
        this.hiss(t + 0.36, 1.1, { gain: 0.18, type: 'highpass', freq: 5000 });
        this.kick(t + 0.36, 0.45);
        break;
      // The scoreboard: "ta-da", then coins.
      case 'scores': {
        this.tone(hz(67), t, 0.1, { type: 'triangle', gain: 0.25, release: 0.05 });
        for (const n of [72, 76, 79]) this.tone(hz(n), t + 0.14, 0.5, { type: 'triangle', gain: 0.16, release: 0.5 });
        const coins = Math.min(8, opts.count ?? 3);
        for (let i = 0; i < coins; i++) {
          const at = t + 0.75 + i * 0.13;
          this.tone(hz(88), at, 0.04, { type: 'square', gain: 0.07, release: 0.05, lowpass: 6000 });
          this.tone(hz(95), at + 0.05, 0.08, { type: 'square', gain: 0.07, release: 0.15, lowpass: 6000 });
        }
        break;
      }
      case 'gameOver':
        [60, 64, 67, 72, 67, 72].forEach((n, i) => this.tone(hz(n + 12), t + i * 0.13, 0.1, { type: 'square', gain: 0.09, release: 0.05, lowpass: 3000 }));
        for (const n of [72, 76, 79, 84, 88]) this.tone(hz(n), t + 0.8, 1.2, { type: 'triangle', gain: 0.12, release: 1 });
        this.hiss(t + 0.8, 1.6, { gain: 0.2, type: 'highpass', freq: 4500 });
        this.kick(t + 0.8, 0.5);
        break;
    }
  }

  /** Blips for the players who picked a title: rising, one per voter. */
  voters(t: number, count: number) {
    for (let i = 0; i < count; i++) this.tone(hz(72 + PENTA[i % 5] + 12 * Math.floor(i / 5)), t + i * 0.14, 0.05, { type: 'sine', gain: 0.25, release: 0.2 });
  }

  /** Plays `bars` of a track from `t`: for rendering a sample to a file. */
  renderTrack(track: Track, t: number, bars: number, seed = 1) {
    const def = TRACKS[track];
    const r = rand(seed);
    const tune = def.compose(r);
    const step = 60 / def.bpm / 4;
    for (let i = 0; i < bars * 16; i++) def.play(this, i, t + i * step, r, tune);
  }
}

const SETTING_KEY = 'drawoodle-sound';

/**
 * The page's sound: music that follows the game, and effects. Off until switched on;
 * once on, it needs one press or tap before the browser lets it play (`unlock`).
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private synth: Synth | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private track: Track | null = null;
  /** Whether the current track's notes are being scheduled (not yet, before the first press). */
  private scheduling = false;
  private trackGen = 0;
  private timer = 0;
  private listeners: (() => void)[] = [];

  constructor(private enabled: boolean) {
    try {
      const saved = localStorage.getItem(SETTING_KEY);
      if (saved) this.enabled = saved === 'on';
    } catch {
      // No storage: the default stands.
    }
  }

  static supported() {
    return !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
  }

  get on() {
    return this.enabled;
  }

  /** Whether sound is on and the browser lets it play. */
  get playing() {
    return this.enabled && this.ctx?.state === 'running';
  }

  /** Called when `on` or `playing` changes. */
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem(SETTING_KEY, on ? 'on' : 'off');
    } catch {
      // Ignore.
    }
    if (on) this.unlock();
    else {
      this.setTrack(null);
      void this.ctx?.suspend();
    }
    this.changed();
  }

  /** Starts the audio: call it from a press or tap (browsers allow sound to start only then). */
  unlock() {
    if (!this.enabled || !Sound.supported()) return;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0;
      this.musicBus.connect(this.master);
      this.synth = new Synth(this.ctx, this.master);
      this.ctx.onstatechange = () => this.changed();
      // Music chosen before the first press starts now.
      const waiting = this.track;
      this.track = null;
      this.setTrack(waiting);
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().then(() => this.changed());
    this.changed();
    // Some browsers start the audio without saying so: look again in a moment.
    setTimeout(() => this.changed(), 400);
  }

  /**
   * Lets any press, tap or remote button start the audio (browsers only allow it from one).
   * Presses on a sound switch (`[data-sound-switch]`) are left to it, so it can tell "turn on"
   * from "mute".
   */
  unlockOnGesture() {
    const go = (e: Event) => {
      const target = e.target as Element | null;
      if (target?.closest?.('[data-sound-switch]')) return;
      this.unlock();
    };
    for (const type of ['pointerdown', 'touchend', 'keydown', 'click']) document.addEventListener(type, go, true);
  }

  /** Plays an effect now (if sound is playing). */
  play(name: Effect, opts: { count?: number } = {}) {
    if (this.playing) this.synth!.effect(name, this.ctx!.currentTime + 0.02, opts);
  }

  voters(count: number) {
    if (this.playing) this.synth!.voters(this.ctx!.currentTime + 0.02, count);
  }

  /** Switches the music to a track (or silence), fading between them. */
  setTrack(wanted: Track | null) {
    const track = this.enabled ? wanted : null;
    if (track === this.track && (track === null || this.scheduling || !this.ctx)) return;
    this.track = track;
    this.scheduling = false;
    const gen = ++this.trackGen;
    clearInterval(this.timer);
    if (!this.ctx || !this.musicBus) return;
    const now = this.ctx.currentTime;
    const bus = this.musicBus;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(bus.gain.value, now);
    bus.gain.linearRampToValueAtTime(0, now + 0.4);
    if (!track) return;
    // A new bus for the new track, so the old one's last notes fade out on their own.
    const next = this.ctx.createGain();
    next.gain.setValueAtTime(0, now);
    next.gain.linearRampToValueAtTime(0.5 * TRACKS[track].level, now + 1.2);
    next.connect(this.master!);
    this.musicBus = next;
    const synth = new Synth(this.ctx, next);
    const def = TRACKS[track];
    const stepLength = 60 / def.bpm / 4;
    const r = rand(Math.floor(Math.random() * 1e9));
    let tune = def.compose(r);
    let step = 0;
    let at = now + 0.1;
    // The usual Web Audio scheduler: wake up often, schedule the notes of the next moment ahead.
    const schedule = () => {
      if (gen !== this.trackGen || !this.ctx) return;
      if (this.ctx.state !== 'running') {
        at = this.ctx.currentTime + 0.1;
        return;
      }
      while (at < this.ctx.currentTime + 0.25) {
        if (step % (def.phrase * 16) === 0 && step > 0) tune = def.compose(r);
        def.play(synth, step, at, r, tune);
        step++;
        at += stepLength;
      }
    };
    schedule();
    this.scheduling = true;
    this.timer = window.setInterval(schedule, 60);
  }

  /** What's playing, for tests and the page's state. */
  get currentTrack() {
    return this.track;
  }
}
