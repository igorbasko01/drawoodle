# Drawoodle: online server

A Cloudflare Worker with a D1 (SQLite) database. It also serves the built web app, so the API lives under `/api/*` on the same address.

## API

All endpoints except creating a player, the TV view and drawings need `Authorization: Bearer <token>`. Room endpoints return the room as the caller sees it (`RoomView` in `webapp/src/online/types.ts`).

| Method & path | What it does |
| --- | --- |
| `POST /api/players` `{nickname}` | Creates a device player: `{player, token}` |
| `POST /api/me` `{nickname}` | Renames the player |
| `GET /api/me/room` | The room the player was in most recently (to resume after a reload) |
| `POST /api/rooms` `{rounds?, pack?, pace?}` | Creates a room with a 4-letter code; the creator is the host |
| `POST /api/rooms/join` `{code}` | Joins a room in the lobby or between games (max 8); rejoins if already a member, or the game in progress if you were in it |
| `GET /api/rooms/:id` | The room; also marks the player as connected, and moves the game on if a phase is over |
| `POST /api/rooms/:id/settings` `{rounds?, pack?, pace?}` | Host: rounds (1–3), prompts (`en`/`he`), pace (`normal`/`relaxed`) between games |
| `POST /api/rooms/:id/start` | Host: starts a game with everyone in the room, in join order (at least 3; also *play again*) |
| `POST /api/rooms/:id/draw` `{round, drawing}` | Hands in your drawing for the round (once) |
| `POST /api/rooms/:id/fib` `{round, step, text}` | Writes (or rewrites) your fake title for the drawing being shown |
| `POST /api/rooms/:id/vote` `{round, step, option}` | Votes for a title by its place in `game.options` (can be changed until the vote ends) |
| `POST /api/rooms/:id/next` `{round, phase, step}` | Host: moves on without waiting (ignored if the game has already moved) |
| `POST /api/rooms/:id/end` | Host: ends the game in progress |
| `POST /api/rooms/:id/leave` | Leaves the room, also mid-game: the seat stays and the game stops waiting for it. The host role passes on; the game ends when none of its players are left |
| `POST /api/rooms/:id/remove` `{playerId}` | Host: removes another player, the same way as leaving |
| `GET /api/tv/:code` | The TV view of a room, no account needed. Marks a TV as connected, and moves the game on too |
| `GET /api/drawings/:id` | A drawing's strokes; never changes, cached as `immutable` |

Moves for a phase or drawing that is no longer current are ignored, and the answer is the room as it is now. Submissions are accepted for 2.5 seconds after a phase's timer runs out, because phones hand in what they have just before the end.

## Rules the server enforces

- A prompt is only ever sent to its artist until its reveal. Fake titles are hidden until the reveal, and scores only include drawings whose reveal has started.
- The artist writes no fake title and doesn't vote. A fake title can't be the real title (compared ignoring case, punctuation, accents and Hebrew vowel marks). Nobody can vote for their own fake.
- Fake titles that read the same are merged into one option, which scores for all its authors.
- Drawings are checked: stroke format, colours, sizes, coordinates inside the 1000×1000 square, and at most 16,000 points / 200 KB.

## Develop

```sh
npm ci
npx wrangler d1 migrations apply drawoodle --local
npm run dev    # http://localhost:8787 (build webapp/ first: it serves webapp/dist)
npm run e2e    # plays full games between scripted players, with a TV watching
```
