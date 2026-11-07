import { COLORS, PAPER, SIZE, SIZES, type Stroke } from '../engine/drawing';

/** Draws one stroke at a scale (pixels per unit). */
export const paintStroke = (ctx: CanvasRenderingContext2D, s: Stroke, scale: number) => {
  ctx.strokeStyle = ctx.fillStyle = COLORS[s[0]] ?? COLORS[0];
  const w = (SIZES[s[1]] ?? SIZES[0]) * scale;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.length === 4) {
    ctx.beginPath();
    ctx.arc(s[2] * scale, s[3] * scale, w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(s[2] * scale, s[3] * scale);
  // Smooth the line through the midpoints between points.
  for (let i = 4; i < s.length - 2; i += 2) {
    const mx = ((s[i] + s[i + 2]) / 2) * scale;
    const my = ((s[i + 1] + s[i + 3]) / 2) * scale;
    ctx.quadraticCurveTo(s[i] * scale, s[i + 1] * scale, mx, my);
  }
  ctx.lineTo(s[s.length - 2] * scale, s[s.length - 1] * scale);
  ctx.stroke();
};

/** Paints a whole drawing onto a canvas of `px` × `px` pixels. */
export const paint = (ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], px: number) => {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, px, px);
  const scale = px / SIZE;
  for (const s of strokes) paintStroke(ctx, s, scale);
};
