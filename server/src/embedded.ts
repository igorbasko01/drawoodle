/**
 * The same Worker, but serving the web app from files built into the script instead of
 * Cloudflare's static assets. Used by `npm run deploy:embedded` (wrangler.embedded.toml),
 * for deploying from places where the separate asset upload isn't possible.
 */
import api, { type Env } from './index';
import { FILES } from './embedded.gen';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  webmanifest: 'application/manifest+json',
  json: 'application/json',
  png: 'image/png',
};

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return api.fetch(req, env);
    // Unknown paths get the app itself, like a single-page app.
    const path = FILES[url.pathname] ? url.pathname : '/index.html';
    const ext = path.split('.').pop() ?? '';
    return new Response(bytes(FILES[path]), {
      headers: {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        // Built files have hashed names and never change; the page itself is always checked.
        'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  },
} satisfies ExportedHandler<Env>;
