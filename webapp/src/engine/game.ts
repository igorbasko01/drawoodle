/**
 * The rules of Drawoodle, shared by the server and the browser.
 *
 * A game has 1–3 rounds. In every round each player draws a secret prompt; then the
 * drawings are shown one at a time. For each one the other players write a fake
 * title (a "fib"), then everyone but the artist votes for the title they think is real.
 * Finding the real title scores for you and for the artist; fooling someone scores for
 * whoever wrote the fib they picked.
 */

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const MAX_ROUNDS = 3;
/** Longest fake title, in characters. */
export const FIB_MAX = 45;

export type Phase = 'draw' | 'fib' | 'vote' | 'reveal' | 'over';
export type Pace = 'normal' | 'relaxed';
export type Pack = 'en' | 'he';

/** Seconds for each timed phase. */
export const TIMES: Record<Pace, { draw: number; fib: number; vote: number }> = {
  normal: { draw: 80, fib: 50, vote: 25 },
  relaxed: { draw: 120, fib: 80, vote: 40 },
};

/** Extra time after a deadline for the last submissions to arrive (phones send what they have when time runs out). */
export const GRACE_MS = 2500;

/** The reveal: a short intro, then one option after another (the real title last), then the scores. */
export const REVEAL = { introMs: 2500, perOptionMs: 3200, scoresMs: 6500 };
export const revealMs = (options: number) => REVEAL.introMs + options * REVEAL.perOptionMs + REVEAL.scoresMs;

export const POINTS = {
  /** For voting for the real title. */
  truth: 1000,
  /** For the artist, per player who found the real title. */
  artist: 500,
  /** For the author of a fib, per player it fooled. */
  fooled: 500,
};

// ------------------------------------------------------------------ randomness

/** A small, fast seeded random generator (mulberry32). */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Mixes numbers into one seed. */
export const mix = (...nums: number[]) => {
  let h = 0x811c9dc5;
  for (const n of nums) {
    h ^= n >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
};

export const shuffle = <T>(list: readonly T[], rand: () => number): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ------------------------------------------------------------------ prompts

/** A prompt for every player in every round: rounds × seats, all different. */
export const dealPrompts = (seed: number, pack: readonly string[], rounds: number, seats: number): string[][] => {
  const deck = shuffle(pack, rng(seed));
  const out: string[][] = [];
  for (let r = 0; r < rounds; r++) out.push(deck.slice(r * seats, (r + 1) * seats));
  return out;
};

// ------------------------------------------------------------------ titles

/** What a title means for comparing: case, accents, Hebrew vowel marks, punctuation and spacing don't count. */
export const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-֑ͯ-ׇ]/g, '')
    .toLowerCase()
    .replace(/^(an?|the)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const cleanText = (raw: unknown, max: number) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export interface Fib {
  seat: number;
  text: string;
}

/** A title to vote for: the real one, or a fib (fibs that read the same are merged, and score for all their authors). */
export interface Option {
  /** 'truth', or 'fib:<seat of its first author>'. */
  key: string;
  truth: boolean;
  text: string;
  authors: number[];
}

/** The titles to vote on for one drawing, in a shuffled order that is the same for everyone. */
export const optionsFor = (seed: number, round: number, artist: number, truth: string, fibs: readonly Fib[]): Option[] => {
  const real = normalize(truth);
  const groups = new Map<string, Option>();
  for (const f of [...fibs].sort((a, b) => a.seat - b.seat)) {
    const n = normalize(f.text);
    if (!n || n === real || f.seat === artist) continue;
    const g = groups.get(n);
    if (g) g.authors.push(f.seat);
    else groups.set(n, { key: `fib:${f.seat}`, truth: false, text: f.text, authors: [f.seat] });
  }
  const list: Option[] = [{ key: 'truth', truth: true, text: truth, authors: [] }, ...groups.values()];
  return shuffle(list, rng(mix(seed, round, artist, 7)));
};

export interface Vote {
  seat: number;
  key: string;
}

/** Points each seat earned from one drawing, and who voted for each option. */
export const scoreDrawing = (options: readonly Option[], votes: readonly Vote[], artist: number) => {
  const points: Record<number, number> = {};
  const add = (seat: number, n: number) => (points[seat] = (points[seat] ?? 0) + n);
  const voters: Record<string, number[]> = {};
  for (const o of options) voters[o.key] = [];
  for (const v of [...votes].sort((a, b) => a.seat - b.seat)) {
    const o = options.find((x) => x.key === v.key);
    if (!o || v.seat === artist || o.authors.includes(v.seat)) continue;
    voters[o.key].push(v.seat);
    if (o.truth) {
      add(v.seat, POINTS.truth);
      add(artist, POINTS.artist);
    } else for (const a of o.authors) add(a, POINTS.fooled);
  }
  return { points, voters };
};

/** The order of the reveal: fibs from the least to the most picked, then the real title. */
export const revealOrder = (options: readonly Option[], voters: Record<string, number[]>) => {
  const fibs = options.filter((o) => !o.truth);
  const order = fibs.map((o, i) => ({ o, i })).sort((a, b) => voters[a.o.key].length - voters[b.o.key].length || a.i - b.i);
  return [...order.map((x) => x.o), options.find((o) => o.truth)!];
};

// ------------------------------------------------------------------ the flow of a game

export interface Position {
  round: number;
  phase: Phase;
  /** Which drawing of the round is being shown (fib, vote, reveal). */
  step: number;
}

export interface Next extends Position {
  /** When this phase is over; 0 for a game that is over. */
  endsAt: number;
}

/**
 * The phase after this one. `drawings` is how many drawings the current round has,
 * `options` how many titles the current drawing has to vote on.
 */
export const nextPosition = (
  at: Position,
  ctx: { rounds: number; drawings: number; options: number; pace: Pace; now: number },
): Next => {
  const t = TIMES[ctx.pace];
  const s = (secs: number) => ctx.now + secs * 1000;
  const nextRound = (): Next =>
    at.round + 1 < ctx.rounds ? { round: at.round + 1, phase: 'draw', step: 0, endsAt: s(t.draw) } : { round: at.round, phase: 'over', step: 0, endsAt: 0 };
  switch (at.phase) {
    case 'draw':
      return ctx.drawings > 0 ? { round: at.round, phase: 'fib', step: 0, endsAt: s(t.fib) } : nextRound();
    case 'fib':
      return { ...at, phase: 'vote', endsAt: s(t.vote) };
    case 'vote':
      return { ...at, phase: 'reveal', endsAt: ctx.now + revealMs(ctx.options) };
    case 'reveal':
      return at.step + 1 < ctx.drawings ? { round: at.round, phase: 'fib', step: at.step + 1, endsAt: s(t.fib) } : nextRound();
    case 'over':
      return { ...at, endsAt: 0 };
  }
};
