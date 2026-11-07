import { COLORS, PAPER, SIZE, SIZES, simplify, type Drawing, type Stroke } from '../engine/drawing';
import { paint, paintStroke } from './paint';

const COLOR_NAMES = ['Black', 'Red', 'Yellow', 'Green', 'Blue', 'Purple', 'Brown', 'Pink', 'Eraser'];
const SIZE_NAMES = ['Thin', 'Medium', 'Thick', 'Huge'];

/**
 * The drawing pad on a phone: a square canvas, colours, brush sizes, undo and clear.
 * Strokes are kept in units (0–1000), so the drawing looks the same on every screen.
 * What's drawn is saved in the browser as you go, so a reload doesn't lose it.
 */
export class Pad {
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private color = 0;
  private size = 1;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private px = 0;
  private readonly onResize = () => this.fit();

  constructor(
    private readonly root: HTMLElement,
    private readonly saveKey: string,
  ) {
    root.innerHTML = `
      <div class="pad-paper"><canvas class="pad-canvas" aria-label="Drawing area"></canvas></div>
      <div class="pad-tools">
        <div class="pad-colors" role="radiogroup" aria-label="Colour">${COLORS.map(
          (c, i) =>
            `<button type="button" class="swatch${i === COLORS.length - 1 ? ' eraser' : ''}" data-color="${i}" style="--swatch:${c}" role="radio" aria-label="${COLOR_NAMES[i]}" title="${
              COLOR_NAMES[i]
            }">${i === COLORS.length - 1 ? '⌫' : ''}</button>`,
        ).join('')}</div>
        <div class="pad-row">
          <div class="pad-sizes" role="radiogroup" aria-label="Brush size">${SIZES.map(
            (s, i) =>
              `<button type="button" class="size" data-size="${i}" role="radio" aria-label="${SIZE_NAMES[i]}" title="${SIZE_NAMES[i]}"><span style="width:${Math.max(
                4,
                s / 2.4,
              )}px;height:${Math.max(4, s / 2.4)}px"></span></button>`,
          ).join('')}</div>
          <button type="button" class="tool" data-undo>↶ Undo</button>
          <button type="button" class="tool" data-clear>Clear</button>
        </div>
      </div>`;
    this.canvas = root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    try {
      const saved = sessionStorage.getItem(saveKey);
      if (saved) this.strokes = (JSON.parse(saved) as Drawing).s;
    } catch {
      // Nothing saved.
    }
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-color]')) b.addEventListener('click', () => this.pickColor(Number(b.dataset.color)));
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-size]')) b.addEventListener('click', () => this.pickSize(Number(b.dataset.size)));
    root.querySelector('[data-undo]')!.addEventListener('click', () => {
      this.strokes.pop();
      this.changed();
    });
    root.querySelector('[data-clear]')!.addEventListener('click', () => {
      if (this.strokes.length && confirm('Clear your drawing?')) {
        this.strokes = [];
        this.changed();
      }
    });
    this.listen();
    this.pickColor(0);
    this.pickSize(1);
    window.addEventListener('resize', this.onResize);
    this.fit();
  }

  /** Whether anything has been drawn. */
  get empty() {
    return this.strokes.length === 0;
  }

  drawing(): Drawing {
    return { v: 1, s: this.strokes.map((s) => simplify(s)) };
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
  }

  forget() {
    try {
      sessionStorage.removeItem(this.saveKey);
    } catch {
      // Ignore.
    }
  }

  private pickColor(i: number) {
    this.color = i;
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-color]')) b.setAttribute('aria-checked', String(Number(b.dataset.color) === i));
  }

  private pickSize(i: number) {
    this.size = i;
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === i));
  }

  private fit() {
    const w = this.canvas.parentElement!.clientWidth;
    const px = Math.round(Math.min(1600, Math.max(200, w * (window.devicePixelRatio || 1))));
    if (px === this.px) return;
    this.px = px;
    this.canvas.width = this.canvas.height = px;
    this.redraw();
  }

  private redraw() {
    paint(this.ctx, this.current ? [...this.strokes, this.current] : this.strokes, this.px);
  }

  private changed() {
    this.redraw();
    try {
      sessionStorage.setItem(this.saveKey, JSON.stringify({ v: 1, s: this.strokes }));
    } catch {
      // Storage full or unavailable: the drawing only lives on this page.
    }
  }

  /** A point of a touch or the mouse, in drawing units. */
  private unit(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    const clamp = (n: number) => Math.max(0, Math.min(SIZE, Math.round(n)));
    return [clamp(((clientX - r.left) / r.width) * SIZE), clamp(((clientY - r.top) / r.height) * SIZE)];
  }

  private begin(x: number, y: number) {
    this.current = [this.color, this.size, ...this.unit(x, y)];
    paintStroke(this.ctx, this.current, this.px / SIZE);
  }

  private move(x: number, y: number) {
    const s = this.current;
    if (!s) return;
    const [ux, uy] = this.unit(x, y);
    const lx = s[s.length - 2];
    const ly = s[s.length - 1];
    if (Math.abs(ux - lx) + Math.abs(uy - ly) < 2) return;
    s.push(ux, uy);
    // Draw just the new piece; the whole stroke is smoothed when it ends.
    const scale = this.px / SIZE;
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS[s[0]] ?? PAPER;
    ctx.lineWidth = SIZES[s[1]] * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lx * scale, ly * scale);
    ctx.lineTo(ux * scale, uy * scale);
    ctx.stroke();
  }

  private end() {
    if (!this.current) return;
    this.strokes.push(this.current);
    this.current = null;
    this.changed();
  }

  private listen() {
    const c = this.canvas;
    if (window.PointerEvent) {
      let active: number | null = null;
      c.addEventListener('pointerdown', (e) => {
        if (active !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
        active = e.pointerId;
        c.setPointerCapture?.(e.pointerId);
        this.begin(e.clientX, e.clientY);
        e.preventDefault();
      });
      c.addEventListener('pointermove', (e) => {
        if (e.pointerId !== active) return;
        const events = (e as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }).getCoalescedEvents?.() ?? [];
        for (const p of events.length ? events : [e]) this.move(p.clientX, p.clientY);
        e.preventDefault();
      });
      const stop = (e: PointerEvent) => {
        if (e.pointerId !== active) return;
        active = null;
        this.end();
      };
      c.addEventListener('pointerup', stop);
      c.addEventListener('pointercancel', stop);
    } else {
      // Older Safari: touch and mouse events.
      c.addEventListener(
        'touchstart',
        (e) => {
          const t = e.changedTouches[0];
          this.begin(t.clientX, t.clientY);
          e.preventDefault();
        },
        { passive: false },
      );
      c.addEventListener(
        'touchmove',
        (e) => {
          const t = e.changedTouches[0];
          this.move(t.clientX, t.clientY);
          e.preventDefault();
        },
        { passive: false },
      );
      c.addEventListener('touchend', () => this.end());
      c.addEventListener('touchcancel', () => this.end());
      let down = false;
      c.addEventListener('mousedown', (e) => {
        down = true;
        this.begin(e.clientX, e.clientY);
      });
      window.addEventListener('mousemove', (e) => down && this.move(e.clientX, e.clientY));
      window.addEventListener('mouseup', () => {
        if (down) this.end();
        down = false;
      });
    }
  }
}
