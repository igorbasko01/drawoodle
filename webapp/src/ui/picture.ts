import { api } from '../online/client';
import { paint } from './paint';

/**
 * Shows a drawing in a box: fetches its strokes (once per drawing) and paints them at the
 * box's real pixel size. Call `show` as often as you like: it only repaints when the
 * drawing or the box's size changed.
 */
export const showPicture = (box: HTMLElement | null, id: string | null) => {
  if (!box) return;
  const el = box as HTMLElement & { __picture?: string };
  const px = Math.round(Math.min(1600, Math.max(200, box.clientWidth * (window.devicePixelRatio || 1))));
  const key = `${id}:${px}`;
  if (el.__picture === key) return;
  el.__picture = key;
  if (!id) {
    box.innerHTML = '';
    return;
  }
  let canvas = box.querySelector('canvas');
  if (!canvas) {
    box.innerHTML = '<canvas class="picture-canvas" role="img" aria-label="A player’s drawing"></canvas>';
    canvas = box.querySelector('canvas')!;
  }
  const c = canvas;
  api.drawing(id).then(
    (d) => {
      if (el.__picture !== key) return;
      c.width = c.height = px;
      paint(c.getContext('2d')!, d.s, px);
    },
    () => {
      // Try again on the next update.
      el.__picture = '';
    },
  );
};

/** Repaints pictures whose box changed size (rotating a phone, resizing a window). */
export const watchPictures = (root: HTMLElement) => {
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      for (const box of root.querySelectorAll<HTMLElement>('[data-picture]')) showPicture(box, box.dataset.picture || null);
    }, 150);
  });
};

/** A box for a drawing; fill it with `fillPictures` after it's in the page. */
export const pictureHtml = (id: string | null, cls = '') => `<div class="picture ${cls}" data-picture="${id ?? ''}"></div>`;

export const fillPictures = (root: HTMLElement) => {
  for (const box of root.querySelectorAll<HTMLElement>('[data-picture]')) showPicture(box, box.dataset.picture || null);
};
