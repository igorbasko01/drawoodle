import { checkDrawing, MAX_BYTES } from '../../webapp/src/engine/drawing';
import {
  cleanText,
  dealPrompts,
  FIB_MAX,
  GRACE_MS,
  MAX_PLAYERS,
  MAX_ROUNDS,
  MIN_PLAYERS,
  nextPosition,
  normalize,
  optionsFor,
  POINTS,
  revealOrder,
  scoreDrawing,
  TIMES,
  type Next,
  type Option,
  type Pace,
  type Pack,
  type Phase,
} from '../../webapp/src/engine/game';
import { PACKS } from '../../webapp/src/engine/prompts';
import type { GameView, MemberView, RoomView } from '../../webapp/src/online/types';

export interface Env {
  DB: D1Database;
}

/** A room nobody has used for this long is forgotten, and its code can be reused. */
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
/** A player or TV that checked in this recently counts as connected. */
const ONLINE_MS = 8000;
/** "Last seen" is only written when it's older than this, so most polls write nothing. */
const SEEN_EVERY_MS = 3000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

interface PlayerRow {
  id: string;
  nickname: string;
}

interface RoomRow {
  id: string;
  code: string;
  host_id: string;
  rounds: number;
  pack: Pack;
  pace: Pace;
  status: RoomView['status'];
  game_id: string | null;
  tv_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  player_id: string;
  nickname: string;
  joined_at: number;
  last_seen: number;
}

interface GameRow {
  id: string;
  room_id: string;
  seed: number;
  seats: string;
  prompts: string;
  pack: Pack;
  pace: Pace;
  rounds: number;
  status: GameView['status'];
  round: number;
  phase: Phase;
  step: number;
  phase_at: number;
  ends_at: number;
  started_at: number;
  finished_at: number | null;
}

interface DrawingRow {
  id: string;
  round: number;
  seat: number;
}

interface FibRow {
  round: number;
  artist: number;
  seat: number;
  text: string;
}

interface VoteRow {
  round: number;
  artist: number;
  seat: number;
  choice: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
  'access-control-expose-headers': 'x-db-trips, x-db-writes',
};

const json = (data: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...CORS } });

const randomString = (alphabet: string, length: number) =>
  [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join('');

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const parse = (text: string): Record<string, unknown> => {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const body = async (req: Request) => parse(await req.text());

const cleanNickname = (raw: unknown) => cleanText(raw, 16);

const tokenHashOf = async (req: Request) => {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing token');
  return sha256(token);
};

/** The caller's player id, as a subquery: bound with the token's hash, so no request needs a separate lookup. */
const ME = '(SELECT id FROM players WHERE token_hash = ?)';

// ------------------------------------------------------------------ players

const createPlayer = async (req: Request, env: Env) => {
  const nickname = cleanNickname((await body(req)).nickname);
  if (!nickname) throw new HttpError(400, 'Choose a nickname');
  const id = randomHex(8);
  const token = randomHex(24);
  await env.DB.prepare('INSERT INTO players (id, nickname, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, nickname, await sha256(token), Date.now())
    .run();
  return json({ player: { id, nickname }, token }, 201);
};

const renamePlayer = async (req: Request, env: Env) => {
  const [tokenHash, data] = await Promise.all([tokenHashOf(req), body(req)]);
  const nickname = cleanNickname(data.nickname);
  if (!nickname) throw new HttpError(400, 'Choose a nickname');
  const p = await env.DB.prepare('UPDATE players SET nickname = ? WHERE token_hash = ? RETURNING id, nickname').bind(nickname, tokenHash).first<PlayerRow>();
  if (!p) throw new HttpError(401, 'Unknown token');
  return json({ player: p });
};

const whoAmI = async (req: Request, env: Env) => {
  const p = await env.DB.prepare('SELECT id, nickname FROM players WHERE token_hash = ?').bind(await tokenHashOf(req)).first<PlayerRow>();
  if (!p) throw new HttpError(401, 'Unknown token');
  return json({ player: p });
};

// ------------------------------------------------------------------ loading a room

/** Which room: by id, by its code (joining, the TV), or any SQL that selects its id. */
type Sql = { sql: string; params: unknown[] };
type RoomRef = { id: string } | { code: string } | Sql;

/** SQL that selects the room's id, with its parameters, to use as a subquery. */
const roomIdSql = (ref: RoomRef, now: number): Sql =>
  'sql' in ref
    ? ref
    : 'id' in ref
      ? { sql: '?', params: [ref.id] }
      : {
          sql: "(SELECT id FROM rooms WHERE code = ? AND status != 'closed' AND updated_at > ? ORDER BY created_at DESC LIMIT 1)",
          params: [String(ref.code).toUpperCase().replace(/[^A-Z]/g, ''), now - ROOM_TTL_MS],
        };

/** Reads everything about a room and its game; appended to every batch so a write and its result are one round trip. */
const readStatements = (env: Env, R: Sql) => {
  const G = `(SELECT game_id FROM rooms WHERE id = ${R.sql})`;
  const p = R.params;
  return [
    env.DB.prepare(`SELECT * FROM rooms WHERE id = ${R.sql}`).bind(...p),
    // The members, then (without joined_at) the game's players who have left the room: their names are still shown.
    env.DB.prepare(
      `SELECT m.player_id, p.nickname, m.joined_at, m.last_seen FROM room_members m JOIN players p ON p.id = m.player_id WHERE m.room_id = ${R.sql}
       UNION ALL
       SELECT p.id, p.nickname, NULL, NULL FROM players p
       WHERE p.id IN (SELECT value FROM json_each((SELECT seats FROM games WHERE id = ${G})))
         AND p.id NOT IN (SELECT player_id FROM room_members WHERE room_id = ${R.sql})`,
    ).bind(...p, ...p, ...p),
    env.DB.prepare(`SELECT * FROM games WHERE id = ${G}`).bind(...p),
    // Drawings are shown in the order of their random ids. Their strokes are fetched separately, once, and cached.
    env.DB.prepare(`SELECT id, round, seat FROM drawings WHERE game_id = ${G} ORDER BY round, id`).bind(...p),
    env.DB.prepare(`SELECT round, artist, seat, text FROM fibs WHERE game_id = ${G}`).bind(...p),
    env.DB.prepare(`SELECT round, artist, seat, choice FROM votes WHERE game_id = ${G}`).bind(...p),
  ];
};

/** Everything needed to show or play a room. */
interface RoomState {
  /** The caller, when identified by a token. */
  me: PlayerRow | null;
  room: RoomRow;
  members: MemberRow[];
  game: GameRow | null;
  drawings: DrawingRow[];
  fibs: FibRow[];
  votes: VoteRow[];
  /** Names of the game's players, including any who left the room. */
  seatPlayers: PlayerRow[];
}

const parseReads = (res: D1Result[], at: number, me: PlayerRow | null, missing: string): RoomState => {
  const rows = <T>(i: number) => (res[at + i].results ?? []) as T[];
  const room = rows<RoomRow>(0)[0];
  if (!room) throw new HttpError(404, missing);
  const people = rows<Omit<MemberRow, 'joined_at' | 'last_seen'> & { joined_at: number | null; last_seen: number | null }>(1);
  return {
    me,
    room,
    members: people.filter((m): m is MemberRow => m.joined_at !== null).sort((a, b) => a.joined_at - b.joined_at),
    game: rows<GameRow>(2)[0] ?? null,
    drawings: rows<DrawingRow>(3),
    fibs: rows<FibRow>(4),
    votes: rows<VoteRow>(5),
    seatPlayers: people.map((m) => ({ id: m.player_id, nickname: m.nickname })),
  };
};

/**
 * One round trip for any request about a room: a single batch (a transaction) that
 * identifies the caller by their token, runs the request's writes, and reads the room
 * back. Writes get the room's id and the caller's id as SQL (`R`, `ME` bound with
 * `tokenHash`), so the rules (only the host, room full, your own seat) are conditions
 * in the writes themselves, and the read-back shows whether they applied.
 * With `seen`, it also records that the caller (a member, or the TV) is still connected,
 * at most every few seconds, so most polls write nothing.
 */
const run = async (
  env: Env,
  ref: RoomRef,
  opts: { tokenHash?: string; writes?: (R: Sql, now: number) => D1PreparedStatement[]; seen?: boolean; tv?: boolean; missing?: string } = {},
) => {
  const now = Date.now();
  const R = roomIdSql(ref, now);
  const t = opts.tokenHash;
  const stmts: D1PreparedStatement[] = [];
  if (t) stmts.push(env.DB.prepare('SELECT id, nickname FROM players WHERE token_hash = ?').bind(t));
  stmts.push(...(opts.writes?.(R, now) ?? []));
  if (t && opts.seen)
    stmts.push(
      env.DB.prepare(`UPDATE room_members SET last_seen = ? WHERE room_id = ${R.sql} AND player_id = ${ME} AND last_seen < ?`).bind(now, ...R.params, t, now - SEEN_EVERY_MS),
    );
  if (opts.tv)
    stmts.push(env.DB.prepare(`UPDATE rooms SET tv_seen_at = ? WHERE id = ${R.sql} AND (tv_seen_at IS NULL OR tv_seen_at < ?)`).bind(now, ...R.params, now - SEEN_EVERY_MS));
  const first = stmts.length;
  stmts.push(...readStatements(env, R));
  const res = await env.DB.batch(stmts);
  const me = t ? (((res[0].results ?? [])[0] as PlayerRow | undefined) ?? null) : null;
  if (t && !me) throw new HttpError(401, 'Unknown token');
  return parseReads(res, first, me, opts.missing ?? ('code' in ref ? 'No room with that code' : 'Room not found'));
};

/** `run` for a caller who must be a member of the room. */
const runAsMember = async (env: Env, ref: RoomRef, tokenHash: string, opts: Parameters<typeof run>[2] = {}) => {
  const st = await run(env, ref, { ...opts, tokenHash });
  requireMember(st, st.me!.id);
  return st as RoomState & { me: PlayerRow };
};

/** Runs writes and reads the room back, in one batch (a transaction, one round trip). */
const commit = async (env: Env, st: RoomState, writes: D1PreparedStatement[]) => {
  const res = await env.DB.batch([...writes, ...readStatements(env, { sql: '?', params: [st.room.id] })]);
  return parseReads(res, writes.length, st.me, 'Room not found');
};

// ------------------------------------------------------------------ the game

const fibsOf = (st: RoomState, round: number, artist: number) => st.fibs.filter((f) => f.round === round && f.artist === artist);
const votesOf = (st: RoomState, round: number, artist: number) => st.votes.filter((v) => v.round === round && v.artist === artist);

/** The game worked out from what is stored: whose turn it is, the titles to vote on, who is done, the scores. */
const derive = (st: RoomState) => {
  const g = st.game!;
  const seats = JSON.parse(g.seats) as string[];
  const prompts = JSON.parse(g.prompts) as string[][];
  const present = new Set(st.members.map((m) => m.player_id));
  const presentSeats = seats.map((_, i) => i).filter((i) => present.has(seats[i]));
  const roundDrawings = st.drawings.filter((d) => d.round === g.round);
  const showing = g.phase === 'fib' || g.phase === 'vote' || g.phase === 'reveal';
  const current = showing ? (roundDrawings[g.step] ?? null) : null;
  const optionsOf = (d: DrawingRow) => optionsFor(g.seed, d.round, d.seat, prompts[d.round][d.seat], fibsOf(st, d.round, d.seat));
  const options: Option[] | null = current ? optionsOf(current) : null;
  const artist = current ? current.seat : -1;

  const done = (seat: number) => {
    switch (g.phase) {
      case 'draw':
        return roundDrawings.some((d) => d.seat === seat);
      case 'fib':
        return seat === artist || fibsOf(st, g.round, artist).some((f) => f.seat === seat);
      case 'vote':
        return seat === artist || votesOf(st, g.round, artist).some((v) => v.seat === seat);
      default:
        return true;
    }
  };
  // Who the phase waits for: the players still in the room (the artist doesn't write a fib or vote).
  const needed = presentSeats.filter((s) => g.phase === 'draw' || s !== artist);
  const complete = (g.phase === 'draw' || g.phase === 'fib' || g.phase === 'vote') && needed.every(done);

  // Scores count only drawings whose reveal has begun, so votes coming in don't give anything away.
  const scores = seats.map(() => 0);
  const byRound = new Map<number, DrawingRow[]>();
  for (const d of st.drawings) byRound.set(d.round, [...(byRound.get(d.round) ?? []), d]);
  const revealed = (d: DrawingRow) => {
    const k = byRound.get(d.round)!.indexOf(d);
    return g.phase === 'over' || d.round < g.round || (d.round === g.round && (k < g.step || (k === g.step && g.phase === 'reveal')));
  };
  const scoreOf = (d: DrawingRow) =>
    scoreDrawing(
      optionsOf(d),
      votesOf(st, d.round, d.seat).map((v) => ({ seat: v.seat, key: v.choice })),
      d.seat,
    );
  for (const d of st.drawings) {
    if (!revealed(d)) continue;
    for (const [seat, n] of Object.entries(scoreOf(d).points)) scores[Number(seat)] += n;
  }
  return { g, seats, prompts, presentSeats, roundDrawings, current, options, artist, done, needed, complete, scores, scoreOf };
};

type Play = ReturnType<typeof derive>;

const playing = (st: RoomState) => (st.game && st.room.status === 'playing' && st.game.id === st.room.game_id && st.game.status === 'playing' ? derive(st) : null);

/** Whether the time for this phase (and the grace for late submissions) has run out. */
const expired = (play: Play, now: number) => now >= play.g.ends_at + (play.g.phase === 'reveal' ? 0 : GRACE_MS);

const nextOf = (play: Play, now: number, drawings = play.roundDrawings.length) =>
  nextPosition(play.g, { rounds: play.g.rounds, drawings, options: play.options?.length ?? 1, pace: play.g.pace, now });

/**
 * Moves the game to `to`, but only if it is still where `play` saw it (so two requests
 * can't both move it on) and, with `cond`, only if that SQL condition holds.
 */
const advanceStatements = (env: Env, play: Play, to: Next, now: number, cond?: Sql) => {
  const g = play.g;
  const over = to.phase === 'over';
  const stmts = [
    env.DB.prepare(
      `UPDATE games SET round = ?, phase = ?, step = ?, phase_at = ?, ends_at = ?${over ? ", status = 'over', finished_at = ?" : ''}
       WHERE id = ? AND status = 'playing' AND round = ? AND phase = ? AND step = ?${cond ? ` AND ${cond.sql}` : ''}`,
    ).bind(to.round, to.phase, to.step, now, to.endsAt, ...(over ? [now] : []), g.id, g.round, g.phase, g.step, ...(cond?.params ?? [])),
    env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(now, g.room_id),
  ];
  if (over)
    stmts.push(
      env.DB.prepare("UPDATE rooms SET status = 'finished' WHERE id = ? AND game_id = ? AND status = 'playing' AND (SELECT status FROM games WHERE id = ?) = 'over'").bind(
        g.room_id,
        g.id,
        g.id,
      ),
    );
  return stmts;
};

/**
 * There are no timers on the server: whoever looks at the room after a phase is over
 * (any player's poll, or the TV) moves the game on. One more round trip, only then.
 */
const settle = async (env: Env, st: RoomState) => {
  const play = playing(st);
  const now = Date.now();
  if (!play || !(play.complete || expired(play, now))) return st;
  return commit(env, st, advanceStatements(env, play, nextOf(play, now), now));
};

/** SQL that holds when every seat in `seats` has a row in `table` for this drawing (or round). */
const allIn = (table: 'drawings' | 'fibs' | 'votes', play: Play, seats: number[]): Sql => ({
  sql: `(SELECT COUNT(*) FROM ${table} WHERE game_id = ? AND round = ?${table === 'drawings' ? '' : ' AND artist = ?'} AND seat IN (SELECT value FROM json_each(?))) >= ?`,
  params: [play.g.id, play.g.round, ...(table === 'drawings' ? [] : [play.artist]), JSON.stringify(seats), seats.length],
});

// ------------------------------------------------------------------ views

const gameView = (st: RoomState, play: Play, seat: number): GameView => {
  const { g, current, options, prompts, artist } = play;
  const scored = current && g.phase === 'reveal' ? play.scoreOf(current) : null;
  const myVote = current && seat >= 0 ? votesOf(st, g.round, artist).find((v) => v.seat === seat) : undefined;
  const over = g.status !== 'playing' || g.phase === 'over';
  let prompt: string | null = null;
  if (g.phase === 'draw' && seat >= 0) prompt = prompts[g.round][seat];
  else if (current && (g.phase === 'reveal' || seat === artist)) prompt = prompts[g.round][artist];
  return {
    id: g.id,
    status: g.status,
    pack: g.pack,
    rounds: g.rounds,
    round: g.round,
    phase: g.phase,
    step: g.step,
    steps: play.roundDrawings.length,
    phaseAt: g.phase_at,
    endsAt: g.ends_at,
    startedAt: g.started_at,
    finishedAt: g.finished_at,
    drawing: current ? { id: current.id, artist } : null,
    prompt,
    you:
      seat >= 0
        ? {
            seat,
            drew: play.roundDrawings.some((d) => d.seat === seat),
            fib: (current && fibsOf(st, g.round, artist).find((f) => f.seat === seat)?.text) ?? null,
            vote: myVote && options ? options.findIndex((o) => o.key === myVote.choice) : null,
            artist: seat === artist,
          }
        : null,
    options: g.phase === 'vote' && options ? options.map((o) => ({ text: o.text, mine: o.authors.includes(seat) || (o.truth && seat === artist) })) : null,
    reveal:
      scored && options
        ? revealOrder(options, scored.voters).map((o) => ({
            text: o.text,
            truth: o.truth,
            authors: o.authors,
            voters: scored.voters[o.key],
            points: scored.voters[o.key].length * (o.truth ? POINTS.artist : POINTS.fooled),
          }))
        : null,
    gains: scored ? play.seats.map((_, s) => scored.points[s] ?? 0) : null,
    gallery: over ? st.drawings.map((d) => ({ id: d.id, prompt: prompts[d.round][d.seat], artist: d.seat, round: d.round })) : null,
  };
};

/** The room as one viewer sees it, built from a loaded state without further queries. */
const buildView = (st: RoomState, you: string | null): RoomView => {
  const now = Date.now();
  const r = st.room;
  const g = st.game && r.status !== 'lobby' ? st.game : null;
  const play = g ? derive(st) : null;
  const member = (m: MemberRow, seat: number): MemberView => ({
    id: m.player_id,
    nickname: m.nickname,
    seat,
    host: m.player_id === r.host_id,
    online: m.last_seen > now - ONLINE_MS,
    left: false,
    done: play && g!.status === 'playing' ? play.done(seat) : false,
    artist: !!play && play.artist === seat,
    score: play ? play.scores[seat] : 0,
  });
  let shown: MemberView[];
  let waiting: MemberView[] = [];
  if (play) {
    // The game's players, in seat order, even if someone has left the room since.
    shown = play.seats.map((id, seat) => {
      const m = st.members.find((x) => x.player_id === id);
      if (m) return member(m, seat);
      const nickname = st.seatPlayers.find((p) => p.id === id)?.nickname ?? 'Player';
      return { ...member({ player_id: id, nickname, joined_at: 0, last_seen: 0 }, seat), host: false, left: true };
    });
    waiting = st.members.filter((m) => !play.seats.includes(m.player_id)).map((m, i) => member(m, play.seats.length + i));
  } else {
    shown = st.members.map((m, seat) => member(m, seat));
  }
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    hostId: r.host_id,
    you,
    members: shown,
    waiting,
    tv: !!r.tv_seen_at && r.tv_seen_at > now - ONLINE_MS,
    settings: { rounds: r.rounds, pack: r.pack, pace: r.pace },
    game: play ? gameView(st, play, you ? play.seats.indexOf(you) : -1) : null,
    now,
  };
};

const requireMember = (st: RoomState, playerId: string) => {
  if (!st.members.some((m) => m.player_id === playerId)) throw new HttpError(403, 'You are not in this room');
};

/** A poll of the room: one round trip (two when it moves the game on). */
const getRoom = async (req: Request, env: Env, id: string) => {
  const st = await runAsMember(env, { id }, await tokenHashOf(req), { seen: true });
  return json(buildView(await settle(env, st), st.me.id));
};

/** A TV screen: shows the room by its code, without an account and without being a player. It moves the game on too. */
const tvView = async (env: Env, code: string) => json(buildView(await settle(env, await run(env, { code }, { tv: true })), null));

// ------------------------------------------------------------------ rooms
// Every request here is one round trip: the rules are conditions in the SQL, and the
// room read back in the same batch shows whether a write applied, and if not, why.

const readSettings = (data: Record<string, unknown>) => {
  const given = (v: unknown) => v !== undefined && v !== null;
  const rounds = given(data.rounds) ? Number(data.rounds) : null;
  const pack = given(data.pack) ? (String(data.pack) as Pack) : null;
  const pace = given(data.pace) ? (String(data.pace) as Pace) : null;
  if (rounds !== null && (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)) throw new HttpError(400, `Choose 1 to ${MAX_ROUNDS} rounds`);
  if (pack !== null && !(pack in PACKS)) throw new HttpError(400, 'Unknown prompt language');
  if (pace !== null && !(pace in TIMES)) throw new HttpError(400, 'Unknown pace');
  return { rounds, pack, pace };
};

const requireHost = (st: RoomState) => {
  if (st.room.host_id !== st.me?.id) throw new HttpError(403, 'Only the host can do that');
};

/** Creates a room with a free 4-letter code; the creator is the host. */
const createRoom = async (req: Request, env: Env) => {
  const [tokenHash, data] = await Promise.all([tokenHashOf(req), body(req)]);
  const s = readSettings(data);
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = randomHex(8);
    const code = randomString(CODE_ALPHABET, 4);
    try {
      const st = await runAsMember(env, { id }, tokenHash, {
        writes: (_R, now) => [
          // Only if the code isn't in use: otherwise nothing is written, and we try another.
          env.DB.prepare(
            `INSERT INTO rooms (id, code, host_id, rounds, pack, pace, status, created_at, updated_at)
             SELECT ?, ?, p.id, ?, ?, ?, 'lobby', ?, ? FROM players p WHERE p.token_hash = ?
               AND NOT EXISTS (SELECT 1 FROM rooms WHERE code = ? AND status != 'closed' AND updated_at > ?)`,
          ).bind(id, code, s.rounds ?? 2, s.pack ?? 'en', s.pace ?? 'normal', now, now, tokenHash, code, now - ROOM_TTL_MS),
          env.DB.prepare(`INSERT INTO room_members (room_id, player_id, joined_at, last_seen) SELECT id, host_id, ?, ? FROM rooms WHERE id = ?`).bind(now, now, id),
        ],
      });
      return json(buildView(st, st.me.id), 201);
    } catch (e) {
      // The code was taken (the room wasn't created): try another one.
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
  }
  throw new HttpError(503, 'Could not find a free room code, try again');
};

/**
 * Joins a room by its code: between games if there's a place, or during a game to
 * your own seat (after leaving it). Rejoining a room you're in changes nothing. The
 * check and the insert are one statement in one transaction, so two players can't
 * both take the last place.
 */
const joinRoom = async (req: Request, env: Env) => {
  const [tokenHash, data] = await Promise.all([tokenHashOf(req), body(req)]);
  const st = await run(env, { code: String(data.code ?? '') }, {
    tokenHash,
    writes: (R, now) => [
      env.DB.prepare(
        `INSERT OR IGNORE INTO room_members (room_id, player_id, joined_at, last_seen)
         SELECT r.id, ${ME}, ?, ? FROM rooms r WHERE r.id = ${R.sql} AND ${ME} IS NOT NULL AND (
           (r.status != 'playing' AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) < ?)
           OR (r.status = 'playing' AND EXISTS (SELECT 1 FROM games g, json_each(g.seats) s WHERE g.id = r.game_id AND s.value = ${ME}))
         )`,
      ).bind(tokenHash, now, now, ...R.params, tokenHash, MAX_PLAYERS, tokenHash),
      env.DB.prepare(`UPDATE rooms SET updated_at = ? WHERE id = ${R.sql} AND EXISTS (SELECT 1 FROM room_members WHERE room_id = rooms.id AND player_id = ${ME})`).bind(
        now,
        ...R.params,
        tokenHash,
      ),
    ],
  });
  const me = st.me!;
  if (!st.members.some((m) => m.player_id === me.id)) {
    if (st.room.status === 'playing') throw new HttpError(409, 'A game is in progress in that room. Join when it ends, or watch it on a TV.');
    throw new HttpError(409, `That room is full (${MAX_PLAYERS} players)`);
  }
  return json(buildView(st, me.id));
};

/** The host changes the game's settings between games (only the ones given). */
const changeSettings = async (req: Request, env: Env, id: string) => {
  const [tokenHash, data] = await Promise.all([tokenHashOf(req), body(req)]);
  const s = readSettings(data);
  const st = await runAsMember(env, { id }, tokenHash, {
    writes: (_R, now) => [
      env.DB.prepare(
        `UPDATE rooms SET rounds = COALESCE(?, rounds), pack = COALESCE(?, pack), pace = COALESCE(?, pace), updated_at = ?
         WHERE id = ? AND host_id = ${ME} AND status != 'playing'`,
      ).bind(s.rounds, s.pack, s.pace, now, id, tokenHash),
    ],
  });
  requireHost(st);
  if (st.room.status === 'playing') throw new HttpError(409, 'Settings can be changed between games');
  return json(buildView(st, st.me.id));
};

/**
 * The host starts a game with everyone in the room, in join order (also "play again").
 * Prompts are dealt for the most rounds and players a game can have, in both prompt
 * languages, so the room's settings and players can be read inside the same statement.
 */
const startGame = async (req: Request, env: Env, id: string) => {
  const tokenHash = await tokenHashOf(req);
  const gameId = randomHex(8);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const deal = (pack: Pack) => JSON.stringify(dealPrompts(seed, PACKS[pack].prompts, MAX_ROUNDS, MAX_PLAYERS));
  const draw = (pace: Pace) => TIMES[pace].draw * 1000;
  const st = await runAsMember(env, { id }, tokenHash, {
    writes: (_R, now) => [
      // The game first, so a room never points at a game that isn't there.
      env.DB.prepare(
        `INSERT INTO games (id, room_id, seed, seats, prompts, pack, pace, rounds, status, round, phase, step, phase_at, ends_at, started_at)
         SELECT ?, r.id, ?, (SELECT json_group_array(player_id) FROM (SELECT player_id FROM room_members WHERE room_id = r.id ORDER BY joined_at)),
           CASE r.pack WHEN 'he' THEN ? ELSE ? END, r.pack, r.pace, r.rounds, 'playing', 0, 'draw', 0, ?,
           ? + CASE r.pace WHEN 'relaxed' THEN ? ELSE ? END, ?
         FROM rooms r WHERE r.id = ? AND r.host_id = ${ME} AND r.status != 'playing'
           AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) >= ?`,
      ).bind(gameId, seed, deal('he'), deal('en'), now, now, draw('relaxed'), draw('normal'), now, id, tokenHash, MIN_PLAYERS),
      env.DB.prepare("UPDATE rooms SET status = 'playing', game_id = ?, updated_at = ? WHERE id = ? AND status != 'playing' AND EXISTS (SELECT 1 FROM games WHERE id = ?)").bind(
        gameId,
        now,
        id,
        gameId,
      ),
    ],
  });
  if (st.room.game_id !== gameId && st.room.status !== 'playing') {
    requireHost(st);
    throw new HttpError(400, `You need at least ${MIN_PLAYERS} players`);
  }
  return json(buildView(st, st.me.id));
};

/** The host stops the game in progress; the room goes back to choosing the next one. */
const endGame = async (req: Request, env: Env, id: string) => {
  const tokenHash = await tokenHashOf(req);
  const st = await runAsMember(env, { id }, tokenHash, {
    writes: (_R, now) => [
      env.DB.prepare(
        `UPDATE games SET status = 'ended', finished_at = ?
         WHERE id = (SELECT game_id FROM rooms WHERE id = ? AND host_id = ${ME} AND status = 'playing') AND status = 'playing'`,
      ).bind(now, id, tokenHash),
      env.DB.prepare(`UPDATE rooms SET status = 'finished', updated_at = ? WHERE id = ? AND host_id = ${ME} AND status = 'playing'`).bind(now, id, tokenHash),
    ],
  });
  requireHost(st);
  return json(buildView(st, st.me.id));
};

/**
 * Takes a player out of the room, as SQL: `who` selects the player to remove. In a
 * game in progress their seat stays and the game stops waiting for them; it ends only
 * when none of its players are left. The host role passes to the next player in the
 * room, and a room nobody is left in closes.
 */
const removeStatements = (env: Env, id: string, who: Sql, now: number) => [
  env.DB.prepare(`DELETE FROM room_members WHERE room_id = ? AND player_id = ${who.sql}`).bind(id, ...who.params),
  env.DB.prepare(
    `UPDATE games SET status = 'ended', finished_at = ?
     WHERE id = (SELECT game_id FROM rooms WHERE id = ? AND status = 'playing') AND status = 'playing'
       AND NOT EXISTS (SELECT 1 FROM room_members m, json_each(games.seats) s WHERE m.room_id = ? AND m.player_id = s.value)`,
  ).bind(now, id, id),
  env.DB.prepare(
    "UPDATE rooms SET status = 'finished', updated_at = ? WHERE id = ? AND status = 'playing' AND (SELECT status FROM games WHERE id = rooms.game_id) = 'ended'",
  ).bind(now, id),
  env.DB.prepare(
    `UPDATE rooms SET host_id = (SELECT player_id FROM room_members WHERE room_id = rooms.id ORDER BY joined_at LIMIT 1), updated_at = ?
     WHERE id = ? AND host_id NOT IN (SELECT player_id FROM room_members WHERE room_id = rooms.id)
       AND EXISTS (SELECT 1 FROM room_members WHERE room_id = rooms.id)`,
  ).bind(now, id),
  env.DB.prepare("UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = rooms.id)").bind(now, id),
];

/** Leaves the room, also mid-game. One round trip, with no room to read back. */
const leaveRoom = async (req: Request, env: Env, id: string) => {
  const tokenHash = await tokenHashOf(req);
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare('SELECT id FROM players WHERE token_hash = ?').bind(tokenHash),
    ...removeStatements(env, id, { sql: ME, params: [tokenHash] }, now),
  ]);
  if (!res[0].results?.length) throw new HttpError(401, 'Unknown token');
  return json({ ok: true });
};

/** The host takes another player out of the room, the same way as leaving. */
const removePlayer = async (req: Request, env: Env, id: string) => {
  const [tokenHash, data] = await Promise.all([tokenHashOf(req), body(req)]);
  const target = String(data.playerId ?? '');
  const st = await runAsMember(env, { id }, tokenHash, {
    // Only the host, and not themselves: otherwise `who` selects nobody and nothing changes.
    writes: (_R, now) =>
      removeStatements(env, id, { sql: `(SELECT ? WHERE (SELECT host_id FROM rooms WHERE id = ?) = ${ME} AND ? != ${ME})`, params: [target, id, tokenHash, target, tokenHash] }, now),
  });
  requireHost(st);
  if (target === st.me.id) throw new HttpError(400, 'Use Leave room to leave yourself');
  return json(buildView(st, st.me.id));
};

/** The room this player was in most recently, so a reload can return to it. */
const currentRoom = async (req: Request, env: Env) => {
  const tokenHash = await tokenHashOf(req);
  const now = Date.now();
  try {
    const st = await run(
      env,
      {
        sql: `(SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.player_id = ${ME} AND r.status != 'closed' AND r.updated_at > ? ORDER BY m.last_seen DESC LIMIT 1)`,
        params: [tokenHash, now - ROOM_TTL_MS],
      },
      { tokenHash },
    );
    return json({ room: buildView(st, st.me!.id) });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return json({ room: null });
    throw e;
  }
};

// ------------------------------------------------------------------ playing

/**
 * The common start of every move: one round trip reads the room and identifies the
 * caller. Returns the game if the move is meant for where it is now; otherwise (a
 * stale phone, or time ran out) the room as it is, moved on if it's due.
 */
const beginMove = async (req: Request, env: Env, id: string, data: Record<string, unknown>, phase: Phase) => {
  const st = await runAsMember(env, { id }, await tokenHashOf(req), { seen: true });
  const play = playing(st);
  const now = Date.now();
  const stale = !play || play.g.phase !== phase || Number(data.round) !== play.g.round || (phase !== 'draw' && Number(data.step) !== play.g.step);
  if (stale || expired(play, now)) return { ok: false, done: json(buildView(await settle(env, st), st.me.id)) } as const;
  const seat = play.seats.indexOf(st.me.id);
  if (seat < 0) throw new HttpError(403, 'You are not playing in this game');
  return { ok: true, st, play, seat, now, me: st.me } as const;
};

/** Hands in a drawing. If it's the last one, the round moves on to the first drawing in the same transaction. */
const draw = async (req: Request, env: Env, id: string) => {
  const text = await req.text();
  if (text.length > MAX_BYTES) throw new HttpError(413, 'That drawing is too big');
  const data = parse(text);
  const m = await beginMove(req, env, id, data, 'draw');
  if (!m.ok) return m.done;
  const { st, play, seat, now, me } = m;
  if (play.done(seat)) return json(buildView(st, me.id));
  const checked = checkDrawing(data.drawing);
  if ('problem' in checked) throw new HttpError(400, checked.problem);
  const after = await commit(env, st, [
    env.DB.prepare('INSERT OR IGNORE INTO drawings (id, game_id, round, seat, strokes, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      randomHex(8),
      play.g.id,
      play.g.round,
      seat,
      JSON.stringify(checked.drawing),
      now,
    ),
    ...advanceStatements(env, play, nextOf(play, now, play.roundDrawings.length + 1), now, allIn('drawings', play, play.needed)),
  ]);
  return json(buildView(after, me.id));
};

/** Writes (or rewrites) a fake title for the drawing being shown. The last one moves on to the vote. */
const fib = async (req: Request, env: Env, id: string) => {
  const data = await body(req);
  const m = await beginMove(req, env, id, data, 'fib');
  if (!m.ok) return m.done;
  const { st, play, seat, now, me } = m;
  if (seat === play.artist) throw new HttpError(403, 'This is your drawing: wait for the others');
  const text = cleanText(data.text, FIB_MAX);
  if (!normalize(text)) throw new HttpError(400, 'Write a title');
  if (normalize(text) === normalize(play.prompts[play.g.round][play.artist]))
    throw new HttpError(409, 'Wow, that’s the real title! Write a fake one, so the others fall for it.');
  const after = await commit(env, st, [
    env.DB.prepare(
      `INSERT INTO fibs (game_id, round, artist, seat, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, round, artist, seat) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
    ).bind(play.g.id, play.g.round, play.artist, seat, text, now),
    ...advanceStatements(env, play, nextOf(play, now), now, allIn('fibs', play, play.needed)),
  ]);
  return json(buildView(after, me.id));
};

/** Votes for one of the titles (by its place in the list everyone sees). The last vote starts the reveal. */
const vote = async (req: Request, env: Env, id: string) => {
  const data = await body(req);
  const m = await beginMove(req, env, id, data, 'vote');
  if (!m.ok) return m.done;
  const { st, play, seat, now, me } = m;
  if (seat === play.artist) throw new HttpError(403, 'This is your drawing: you don’t vote on it');
  const i = Number(data.option);
  const option = Number.isInteger(i) ? play.options![i] : undefined;
  if (!option) throw new HttpError(400, 'Pick one of the titles');
  if (option.authors.includes(seat)) throw new HttpError(409, 'That’s the one you wrote! Pick another.');
  const after = await commit(env, st, [
    env.DB.prepare(
      `INSERT INTO votes (game_id, round, artist, seat, choice, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, round, artist, seat) DO UPDATE SET choice = excluded.choice, created_at = excluded.created_at`,
    ).bind(play.g.id, play.g.round, play.artist, seat, option.key, now),
    ...advanceStatements(env, play, nextOf(play, now), now, allIn('votes', play, play.needed)),
  ]);
  return json(buildView(after, me.id));
};

/** The host moves the game on without waiting (for the timer, or for someone who is away). */
const skip = async (req: Request, env: Env, id: string) => {
  const data = await body(req);
  const st = await runAsMember(env, { id }, await tokenHashOf(req), { seen: true });
  requireHost(st);
  const play = playing(st);
  if (!play || play.g.phase !== data.phase || play.g.round !== Number(data.round) || play.g.step !== Number(data.step)) return json(buildView(st, st.me.id));
  const now = Date.now();
  return json(buildView(await commit(env, st, advanceStatements(env, play, nextOf(play, now), now)), st.me.id));
};

/** A drawing's strokes. They never change, so browsers and Cloudflare's edge may keep them. */
const getDrawing = async (env: Env, id: string) => {
  const d = await env.DB.prepare('SELECT strokes FROM drawings WHERE id = ?').bind(id).first<{ strokes: string }>();
  if (!d) throw new HttpError(404, 'No such drawing');
  return new Response(d.strokes, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', ...CORS },
  });
};

// ------------------------------------------------------------------ routing

const route = async (req: Request, env: Env): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/api/health') return json({ ok: true });
  if (path === '/api/players' && method === 'POST') return createPlayer(req, env);
  const tv = path.match(/^\/api\/tv\/([A-Za-z]{4})$/);
  if (tv && method === 'GET') return tvView(env, tv[1]);
  const drawing = path.match(/^\/api\/drawings\/([0-9a-f]{16})$/);
  if (drawing && method === 'GET') return getDrawing(env, drawing[1]);

  // Every call identifies the player inside its first batch: no extra round trip.
  const fast = path.match(/^\/api\/rooms\/([0-9a-f]{16})(?:\/(draw|fib|vote|next))?$/);
  if (fast && !fast[2] && method === 'GET') return getRoom(req, env, fast[1]);
  if (fast && fast[2] && method === 'POST') {
    switch (fast[2]) {
      case 'draw':
        return draw(req, env, fast[1]);
      case 'fib':
        return fib(req, env, fast[1]);
      case 'vote':
        return vote(req, env, fast[1]);
      case 'next':
        return skip(req, env, fast[1]);
    }
  }

  // Every other call identifies the player inside its single batch too.
  if (path === '/api/me' && method === 'GET') return whoAmI(req, env);
  if (path === '/api/me' && method === 'POST') return renamePlayer(req, env);
  if (path === '/api/me/room' && method === 'GET') return currentRoom(req, env);
  if (path === '/api/rooms' && method === 'POST') return createRoom(req, env);
  if (path === '/api/rooms/join' && method === 'POST') return joinRoom(req, env);
  const room = path.match(/^\/api\/rooms\/([0-9a-f]{16})\/(settings|start|end|leave|remove)$/);
  if (room && method === 'POST') {
    const id = room[1];
    switch (room[2]) {
      case 'settings':
        return changeSettings(req, env, id);
      case 'start':
        return startGame(req, env, id);
      case 'end':
        return endGame(req, env, id);
      case 'leave':
        return leaveRoom(req, env, id);
      case 'remove':
        return removePlayer(req, env, id);
    }
  }
  throw new HttpError(404, 'Not found');
};

/**
 * Wraps the database to count round trips (each run/first/all, or one batch), so every
 * response can report them in an `x-db-trips` header: latency grows with each one. It also
 * counts the rows that batches and `run` calls changed (`x-db-writes`), so a poll can be
 * seen to write nothing.
 */
const countingDb = (db: D1Database) => {
  const counter = { trips: 0, writes: 0 };
  const changed = (r: unknown) => (counter.writes += Number((r as D1Result | null)?.meta?.changes ?? 0));
  const real = new WeakMap<object, D1PreparedStatement>();
  /** Whether each statement writes: a SELECT's result can still carry a stale `changes`. */
  const writes = new WeakMap<object, boolean>();
  const wrap = (st: D1PreparedStatement, isWrite: boolean): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), isWrite);
        if (key === 'run' || key === 'first' || key === 'all' || key === 'raw')
          return async (...args: unknown[]) => {
            counter.trips++;
            const r = await (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (key === 'run' && isWrite) changed(r);
            return r;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    real.set(proxy, st);
    writes.set(proxy, isWrite);
    return proxy;
  };
  const wrapped = {
    prepare: (query: string) => wrap(db.prepare(query), /^\s*(insert|update|delete)\b/i.test(query)),
    batch: async (statements: D1PreparedStatement[]) => {
      counter.trips++;
      const results = await db.batch(statements.map((x) => real.get(x) ?? x));
      results.forEach((r, i) => writes.get(statements[i]) && changed(r));
      return results;
    },
    exec: (query: string) => {
      counter.trips++;
      return db.exec(query);
    },
  } as unknown as D1Database;
  return { db: wrapped, counter };
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { db, counter } = countingDb(env.DB);
    let res: Response;
    try {
      res = await route(req, { ...env, DB: db });
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else {
        console.error(e);
        res = json({ error: 'Server error' }, 500);
      }
    }
    res.headers.set('x-db-trips', String(counter.trips));
    res.headers.set('x-db-writes', String(counter.writes));
    return res;
  },
} satisfies ExportedHandler<Env>;
