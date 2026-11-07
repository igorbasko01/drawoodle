/**
 * Drawings are kept as strokes, not pictures: small to send, and sharp on any screen.
 * A drawing is square, 1000 × 1000 units. Each stroke is [colour, size, x0, y0, x1, y1, …].
 */

export const SIZE = 1000;
export const PAPER = '#fffdf7';
/** The last colour is the paper: drawing with it rubs out. */
export const COLORS = ['#1d1d1f', '#e63946', '#f4a20c', '#2a9d54', '#1e6bd6', '#8e44ad', '#8b5a2b', '#ff8fb1', PAPER];
export const SIZES = [6, 14, 30, 64];

export const MAX_STROKES = 800;
export const MAX_POINTS = 16000;
export const MAX_BYTES = 200_000;

export type Stroke = number[];

export interface Drawing {
  v: 1;
  s: Stroke[];
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** Checks a drawing sent by a phone; returns it as stored, or a problem. */
export const checkDrawing = (raw: unknown): { drawing: Drawing } | { problem: string } => {
  const d = raw as Partial<Drawing> | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.s)) return { problem: 'That drawing could not be read' };
  if (d.s.length === 0) return { problem: 'Draw something first!' };
  if (d.s.length > MAX_STROKES) return { problem: 'That drawing has too many lines' };
  let points = 0;
  for (const s of d.s) {
    if (!Array.isArray(s) || s.length < 4 || s.length % 2 !== 0 || !s.every(isInt)) return { problem: 'That drawing could not be read' };
    if (s[0] < 0 || s[0] >= COLORS.length || s[1] < 0 || s[1] >= SIZES.length) return { problem: 'That drawing could not be read' };
    for (let i = 2; i < s.length; i++) if (s[i] < 0 || s[i] > SIZE) return { problem: 'That drawing could not be read' };
    points += (s.length - 2) / 2;
  }
  if (points > MAX_POINTS) return { problem: 'That drawing is too detailed' };
  return { drawing: { v: 1, s: d.s } };
};

/** Drops points closer than `min` units to the previous one (keeps the last), so strokes stay small. */
export const simplify = (stroke: Stroke, min = 4): Stroke => {
  const out = stroke.slice(0, 4);
  for (let i = 4; i < stroke.length; i += 2) {
    const last = i === stroke.length - 2;
    const dx = stroke[i] - out[out.length - 2];
    const dy = stroke[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= min * min || last) out.push(stroke[i], stroke[i + 1]);
  }
  return out;
};
