// Plays a whole game between four scripted players, with a TV watching, against a running server.
// Usage: npx tsx test/e2e.ts [http://localhost:8787]
import { POINTS } from '../../webapp/src/engine/game';
import type { RoomView } from '../../webapp/src/online/types';

const base = process.argv[2] ?? 'http://localhost:8787';

const request = async (path: string, token?: string, data?: unknown) => {
  const res = await fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: res.status, body: (await res.json()) as any, trips: Number(res.headers.get('x-db-trips')), headers: res.headers };
};

const call = async (path: string, token?: string, data?: unknown) => {
  const { status, body } = await request(path, token, data);
  if (status >= 400) throw new Error(`${path}: ${status} ${JSON.stringify(body)}`);
  return body;
};

const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};

const doodle = (n: number) => ({ v: 1, s: [[n % 8, 1, 100, 100, 300 + n * 10, 400, 600, 650]] });

const main = async () => {
  const names = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'נועה'];
  const ps = await Promise.all(names.map((nickname) => call('/api/players', undefined, { nickname })));
  const [a, b, c, d] = ps;
  assert(ps[9].player.nickname === 'נועה', 'Hebrew nicknames are kept');
  const created: RoomView = await call('/api/rooms', a.token, { rounds: 1, pace: 'normal', pack: 'en' });
  assert(created.status === 'lobby' && created.code.length === 4 && created.settings.rounds === 1, 'room waits in the lobby with a code');
  const id = created.id;
  const code = created.code;
  await call('/api/rooms/join', b.token, { code: code.toLowerCase() });
  assert((await request(`/api/rooms/${id}/start`, a.token, {})).status === 400, 'a game needs at least three players');
  await call('/api/rooms/join', c.token, { code });
  let room: RoomView = await call('/api/rooms/join', d.token, { code });
  assert(room.members.map((m) => m.nickname).join() === 'Ana,Ben,Cy,Dee', 'players join in order');
  assert((await request(`/api/rooms/${id}/start`, b.token, {})).status === 403, 'only the host starts the game');
  await call(`/api/rooms/${id}/settings`, a.token, { pack: 'he' });
  room = await call(`/api/rooms/${id}/settings`, a.token, { pack: 'en', rounds: 1 });
  assert(room.settings.pack === 'en', 'the host changes the settings');

  const tv: RoomView = await call(`/api/tv/${code}`);
  assert(tv.you === null && tv.status === 'lobby', 'a TV watches the room by its code');
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.tv, 'players see that a TV is connected');

  // Drawing: everyone has their own secret prompt.
  room = await call(`/api/rooms/${id}/start`, a.token, {});
  const g0 = room.game!;
  assert(room.status === 'playing' && g0.phase === 'draw' && g0.round === 0 && !!g0.prompt, 'the game starts with drawing, and you see your prompt');
  assert((await request('/api/rooms/join', ps[4].token, { code })).status === 409, 'nobody joins a game in progress');
  const tokens = [a.token, b.token, c.token, d.token];
  const prompts: string[] = [];
  for (const t of tokens) prompts.push((await call(`/api/rooms/${id}`, t)).game.prompt);
  assert(new Set(prompts).size === 4, 'every player draws something different');
  const tvDraw: RoomView = await call(`/api/tv/${code}`);
  assert(tvDraw.game!.prompt === null && JSON.stringify(tvDraw).indexOf(prompts[0]) < 0, 'the TV never sees a prompt while drawing');
  assert(JSON.stringify(await call(`/api/rooms/${id}`, b.token)).indexOf(prompts[0]) < 0, 'nobody sees another player’s prompt');

  assert((await request(`/api/rooms/${id}/draw`, a.token, { round: 0, drawing: { v: 1, s: [] } })).status === 400, 'an empty drawing is refused');
  const draw = await request(`/api/rooms/${id}/draw`, a.token, { round: 0, drawing: doodle(0) });
  assert(draw.status === 200 && draw.body.game.you.drew && draw.body.members[0].done, 'a drawing is handed in');
  assert(draw.trips === 2, 'handing in a drawing is two database round trips');
  assert((await request(`/api/rooms/${id}`, a.token)).trips === 1, 'a poll is one database round trip');
  assert((await request(`/api/tv/${code}`)).trips === 1, 'the TV view is one database round trip');
  await call(`/api/rooms/${id}/draw`, b.token, { round: 0, drawing: doodle(1) });
  // The last two drawings arrive together: the game moves on exactly once.
  await Promise.all([call(`/api/rooms/${id}/draw`, c.token, { round: 0, drawing: doodle(2) }), call(`/api/rooms/${id}/draw`, d.token, { round: 0, drawing: doodle(3) })]);
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.game!.phase === 'fib' && room.game!.step === 0 && room.game!.steps === 4, 'once everyone has drawn, the first drawing is shown');

  const drawingRes = await request(`/api/drawings/${room.game!.drawing!.id}`);
  assert(Array.isArray(drawingRes.body.s) && /immutable/.test(drawingRes.headers.get('cache-control') ?? ''), 'a drawing’s strokes are fetched once and cached');

  // Play every drawing of the round: fibs, votes, reveal.
  const total = [0, 0, 0, 0];
  for (let step = 0; step < 4; step++) {
    room = await call(`/api/rooms/${id}`, a.token);
    const g = room.game!;
    assert(g.phase === 'fib' && g.step === step, `drawing ${step + 1}: write fake titles`);
    const artist = g.drawing!.artist;
    const artistView: RoomView = await call(`/api/rooms/${id}`, tokens[artist]);
    const truth = artistView.game!.prompt!;
    assert(truth === prompts[artist] && artistView.game!.you!.artist, 'the artist sees their own title');
    const other = tokens.find((_, i) => i !== artist)!;
    assert((await call(`/api/rooms/${id}`, other)).game.prompt === null, 'the others don’t');
    assert((await request(`/api/rooms/${id}/fib`, tokens[artist], { round: 0, step, text: 'mine' })).status === 403, 'the artist writes no fake title');
    assert((await request(`/api/rooms/${id}/fib`, other, { round: 0, step, text: truth.toUpperCase() + '!' })).status === 409, 'the real title can’t be a fake one');
    const writers = [0, 1, 2, 3].filter((i) => i !== artist);
    // Two players write the same fake title: they share it.
    for (const [k, w] of writers.entries()) {
      room = await call(`/api/rooms/${id}/fib`, tokens[w], { round: 0, step, text: k < 2 ? 'A purple banana' : `Fake ${w}` });
      if (k === 0) {
        room = await call(`/api/rooms/${id}/fib`, tokens[w], { round: 0, step, text: 'a purple banana' });
        assert(room.game!.you!.fib === 'a purple banana', 'a fake title can be changed');
      }
    }
    assert(room.game!.phase === 'vote', 'once every fake title is in, the vote starts');
    const options = room.game!.options!;
    assert(options.length === 3, 'the same fake titles are merged: the real one, plus two fakes');
    const tvVote: RoomView = await call(`/api/tv/${code}`);
    assert(tvVote.game!.options!.length === 3 && !tvVote.game!.options!.some((o) => o.mine), 'the TV shows the titles');

    // Voting: the first writer finds the truth, the others pick something that isn't theirs.
    const views = await Promise.all(writers.map((w) => call(`/api/rooms/${id}`, tokens[w])));
    const truthAt = options.findIndex((o) => o.text === truth);
    const mineAt = views[0].game.options.findIndex((o: { mine: boolean }) => o.mine);
    assert(mineAt >= 0 && (await request(`/api/rooms/${id}/vote`, tokens[writers[0]], { round: 0, step, option: mineAt })).status === 409, 'you can’t vote for your own fake title');
    assert((await request(`/api/rooms/${id}/vote`, tokens[artist], { round: 0, step, option: truthAt })).status === 403, 'the artist doesn’t vote');
    const choices = writers.map((w, k) => {
      if (k === 0) return truthAt;
      return views[k].game.options.findIndex((o: { mine: boolean; text: string }, i: number) => !o.mine && i !== truthAt);
    });
    await call(`/api/rooms/${id}/vote`, tokens[writers[0]], { round: 0, step, option: choices[0] });
    const mid: RoomView = await call(`/api/rooms/${id}`, a.token);
    assert(mid.members.every((m) => m.score === total[m.seat]), 'scores don’t change while votes come in');
    await Promise.all(writers.slice(1).map((w, k) => call(`/api/rooms/${id}/vote`, tokens[w], { round: 0, step, option: choices[k + 1] })));
    room = await call(`/api/rooms/${id}`, a.token);
    const rg = room.game!;
    assert(rg.phase === 'reveal' && rg.reveal!.length === 3 && rg.reveal![2].truth && rg.prompt === truth, 'once everyone has voted, the reveal shows the real title last');
    // Score it ourselves: finding the truth, the artist, and fooling others.
    const gains = [0, 0, 0, 0];
    gains[writers[0]] += POINTS.truth;
    gains[artist] += POINTS.artist;
    for (let k = 1; k < writers.length; k++) {
      const picked = options[choices[k]];
      const authors = rg.reveal!.find((r) => r.text === picked.text)!.authors;
      for (const s of authors) gains[s] += POINTS.fooled;
    }
    assert(rg.gains!.join() === gains.join(), `drawing ${step + 1}: points are ${gains.join(', ')}`);
    gains.forEach((n, s) => (total[s] += n));
    assert(room.members.every((m) => m.score === total[m.seat]), 'scores add up');
    // The host skips the rest of the reveal (a stale skip does nothing).
    await call(`/api/rooms/${id}/next`, a.token, { round: 0, phase: 'vote', step });
    assert((await request(`/api/rooms/${id}/next`, b.token, { round: 0, phase: 'reveal', step })).status === 403, 'only the host skips ahead');
    room = await call(`/api/rooms/${id}/next`, a.token, { round: 0, phase: 'reveal', step });
  }
  assert(room.status === 'finished' && room.game!.status === 'over' && room.game!.gallery!.length === 4, 'after the last drawing the game is over, with a gallery');
  const watched: RoomView = await call(`/api/tv/${code}`);
  assert(watched.game!.gallery!.every((x) => prompts[x.artist] === x.prompt), 'the gallery shows every drawing with its real title');

  // A full room: eight players.
  for (const p of ps.slice(4, 8)) await call('/api/rooms/join', p.token, { code });
  assert((await request('/api/rooms/join', ps[8].token, { code })).status === 409, 'a room holds eight players');
  room = await call(`/api/rooms/${id}/start`, a.token, {});
  assert(room.members.length === 8 && room.game!.phase === 'draw', 'play again with eight players');

  // Leaving mid-game: the game stops waiting for that player.
  await call(`/api/rooms/${id}/leave`, ps[7].token, {});
  room = await call(`/api/rooms/${id}`, a.token);
  assert(room.members[7].left, 'a player can leave a game in progress; their seat stays');
  for (const [i, p] of ps.slice(0, 7).entries()) room = await call(`/api/rooms/${id}/draw`, p.token, { round: 0, drawing: doodle(i) });
  assert(room.game!.phase === 'fib' && room.game!.steps === 7, 'the round goes on without the player who left');
  room = await call('/api/rooms/join', ps[7].token, { code });
  assert(room.status === 'playing' && !room.members[7].left, 'a player who left can rejoin the game in progress');

  // Time running out: the host skips the fake titles, nobody wrote one; the vote has only the real title.
  room = await call(`/api/rooms/${id}/next`, a.token, { round: 0, phase: 'fib', step: 0 });
  assert(room.game!.phase === 'vote' && room.game!.options!.length === 1, 'skipping ahead moves on without the missing answers');

  // The host can remove a player; only the host.
  assert((await request(`/api/rooms/${id}/remove`, b.token, { playerId: d.player.id })).status === 403, 'only the host removes players');
  room = await call(`/api/rooms/${id}/remove`, a.token, { playerId: d.player.id });
  assert(room.members[3].left && room.status === 'playing', 'the host removes a player; their seat stays in the game');
  assert((await request(`/api/rooms/${id}`, d.token)).status === 403, 'a removed player is out of the room');
  room = await call(`/api/rooms/${id}/end`, a.token, {});
  assert(room.status === 'finished' && room.game?.status === 'ended', 'the host can end the game');
  await call(`/api/rooms/${id}/leave`, a.token, {});
  room = await call(`/api/rooms/${id}`, b.token);
  assert(room.hostId === b.player.id, 'the host passes on when they leave');
  const current = await call('/api/me/room', c.token);
  assert(current.room?.id === id, 'a player returns to their room after a reload');
  console.log('\nAll good.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
