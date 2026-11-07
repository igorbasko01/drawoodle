import type { Drawing } from '../engine/drawing';
import type { Player, RoomSettings, RoomView } from './types';

/**
 * The online server: the same site the game is served from (/api).
 * Override at build time with VITE_API_URL, e.g. a local `wrangler dev` while running `vite`.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** This device's player: kept in the browser. */
export interface Identity {
  player: Player;
  token: string;
}

const IDENTITY_KEY = 'drawoodle-identity';

export const loadIdentity = (): Identity | null => {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    const id = raw ? (JSON.parse(raw) as Identity) : null;
    return id?.token && id.player?.id ? id : null;
  } catch {
    return null;
  }
};

export const saveIdentity = (id: Identity | null) => {
  try {
    if (id) localStorage.setItem(IDENTITY_KEY, JSON.stringify(id));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {
    // Storage can be unavailable (private mode); the identity then lasts this visit only.
  }
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const call = async <T>(path: string, token?: string, data?: unknown): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the game server. Check your connection.');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Server error (${res.status})`);
  return body as T;
};

/** Drawings never change: each is fetched once and kept. */
const drawings = new Map<string, Promise<Drawing>>();

export const api = {
  register: (nickname: string) => call<Identity>('/api/players', undefined, { nickname }),
  rename: (token: string, nickname: string) => call<{ player: Player }>('/api/me', token, { nickname }),
  currentRoom: (token: string) => call<{ room: RoomView | null }>('/api/me/room', token),
  createRoom: (token: string, settings: Partial<RoomSettings>) => call<RoomView>('/api/rooms', token, settings),
  join: (token: string, code: string) => call<RoomView>('/api/rooms/join', token, { code }),
  room: (token: string, id: string) => call<RoomView>(`/api/rooms/${id}`, token),
  settings: (token: string, id: string, settings: Partial<RoomSettings>) => call<RoomView>(`/api/rooms/${id}/settings`, token, settings),
  start: (token: string, id: string) => call<RoomView>(`/api/rooms/${id}/start`, token, {}),
  draw: (token: string, id: string, round: number, drawing: Drawing) => call<RoomView>(`/api/rooms/${id}/draw`, token, { round, drawing }),
  fib: (token: string, id: string, round: number, step: number, text: string) => call<RoomView>(`/api/rooms/${id}/fib`, token, { round, step, text }),
  vote: (token: string, id: string, round: number, step: number, option: number) => call<RoomView>(`/api/rooms/${id}/vote`, token, { round, step, option }),
  next: (token: string, id: string, at: { round: number; phase: string; step: number }) => call<RoomView>(`/api/rooms/${id}/next`, token, at),
  end: (token: string, id: string) => call<RoomView>(`/api/rooms/${id}/end`, token, {}),
  leave: (token: string, id: string) => call<{ ok: true }>(`/api/rooms/${id}/leave`, token, {}),
  remove: (token: string, id: string, playerId: string) => call<RoomView>(`/api/rooms/${id}/remove`, token, { playerId }),
  tv: (code: string) => call<RoomView>(`/api/tv/${code}`),
  drawing: (id: string) => {
    let p = drawings.get(id);
    if (!p) {
      p = call<Drawing>(`/api/drawings/${id}`);
      p.catch(() => drawings.delete(id));
      drawings.set(id, p);
    }
    return p;
  },
};

/** A link to the game with a query, e.g. `?join=ABCD` or `?tv=ABCD`. */
export const linkWith = (key: 'join' | 'tv', code: string) => {
  const url = new URL(window.location.href);
  url.search = `?${key}=${code}`;
  url.hash = '';
  return url.toString();
};
