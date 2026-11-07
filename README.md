# ✏️ Drawoodle

An online **party drawing game** for 3–8 players: phones are the controllers, a TV (or laptop) is the big screen.
Play it at **https://drawoodle.baskorp.com**.

## How it plays

- One player creates a **room**; everyone else joins on their phone with the 4-letter code, the invite link, or the QR code on the TV.
- **Draw:** everyone gets a secret, silly prompt ("A snail winning a race") and draws it on their phone.
- **Fake titles:** the drawings are shown one at a time. For each, the other players write a fake title that could pass for the real one.
- **Vote:** the real title is mixed in with the fakes, and everyone except the artist votes for the one they think is real.
- **Reveal:** the titles are revealed one by one, showing who picked each and who wrote it, with the real one last.
- **Points:** +1000 for finding the real title; +500 to whoever wrote a fake for every player it fooled; +500 to the artist for every player who found theirs. Identical fakes are merged and score for every author.
- A game has 1–3 rounds (the host picks), with English or Hebrew prompts and a normal or relaxed pace. When it's over, the TV plays a gallery of every drawing with its real title.
- Each phase has a timer. Phones hand in what they have when time runs out, and the game moves on as soon as everyone is done. The host can skip ahead, end the game, or remove a player; anyone can leave (and rejoin) mid-game, and the game stops waiting for them.

## Built for TVs, translation and right-to-left languages

- **TV browsers** run old Chromium (Samsung: ~56 on 2018 models). The build ships an ES5 bundle with polyfills for browsers without ES modules (`@vitejs/plugin-legacy`), lowers the modern bundle to Chrome 64, and the CSS has fallbacks for flex `gap`, CSS Grid, `dvh` and `aspect-ratio`. The TV view is sized in `vh`, so it fills any screen, and it needs no input beyond the room code (`/?tv=ABCD` skips even that).
- **Chrome's automatic translation** works on phones: the page is plain English text with `lang="en"`. Screens are only re-rendered when what they show changes (timers update just a number), so translated text isn't undone every second. The game never reads text back from the page. Names, room codes and numbers are marked `translate="no"`.
- **Right-to-left:** when Chrome translates into Hebrew (or Arabic/Persian) it marks the page `translated-rtl`, and the layout flips to `dir="rtl"`. Player-written text (names, fake titles) is isolated with `dir="auto"`, so Hebrew and English mix correctly. There's a native **Hebrew prompt pack** too, picked automatically when the host's phone is set to Hebrew. Add `?dir=rtl` to the URL to try the right-to-left layout.

## Architecture

The same shape as [memory-game-coop](https://github.com/igorbasko01/memory-game-coop):

```
webapp/                    # Vite + TypeScript, no framework (DOM + CSS)
├── src/engine/game.ts     # The rules: dealing prompts, merging fakes, scoring, the order of phases. Shared with the server, unit tested
├── src/engine/drawing.ts  # Drawings as strokes (1000×1000 units), checked by the server
├── src/engine/prompts.ts  # The English and Hebrew prompt packs
├── src/online/            # API client, device identity, the view types shared with the server
└── src/ui/                # app.ts (phone), tv.ts (big screen), pad.ts (drawing), reveal.ts, picture.ts, parts.ts
server/                    # One Cloudflare Worker + D1 (SQLite): serves webapp/dist and the API under /api/*
├── src/index.ts
├── migrations/
└── test/e2e.ts            # Plays whole games between scripted players (and a TV) against a running server
```

- **No timers on the server, no Durable Objects.** A game stores where it is (round, phase, drawing) and when the phase ends. Any request that finds the phase finished, because everyone is done or time ran out, moves it on with a compare-and-set `UPDATE`, so two requests can never both move it. The TV polls every 800 ms, so the game keeps moving even when nobody is touching a phone.
- **Batched queries.** Every request reads the whole room in **one D1 batch**: dependent lookups are subqueries, and the caller's token is checked inside the same batch. A poll or the TV view is one round trip (two when it moves the game on). A drawing, fake title or vote is two: one batch reads, one batch writes. The write batch also moves the game on in SQL (`… AND (SELECT COUNT(*) …) >= ?`) when that submission was the last one, and reads the room back. Batches are transactions, so when the last two players submit at the same moment the game still moves on exactly once. Every response reports its round trips in an `x-db-trips` header.
- **Drawings are strokes**, not images: a few KB each, sharp on a phone and a 4K TV alike. Polls only carry drawing ids. The strokes are fetched once from `/api/drawings/:id`, which is served with `immutable` caching.
- **Quick responses.** Hand-ins, fake titles and votes show on the phone at once and are confirmed by the server's answer. A drawing in progress is saved in the browser, so a reload doesn't lose it.
- **Secrets stay on the server.** A prompt is only sent to the player drawing it (and later to the artist), and scores only count drawings whose reveal has started, so votes coming in give nothing away.

See [server/README.md](server/README.md) for the API.

## Develop

```bash
cd webapp && npm install && npm test && npm run build
cd ../server && npm install
npx wrangler d1 migrations apply drawoodle --local
npm run dev        # http://localhost:8787 serves the built app and the API
npm run e2e        # in another terminal
```

Or run `VITE_API_URL=http://localhost:8787 npm run dev` in `webapp/` for hot reload. Open several browser windows (or a private window per player) to play with yourself, and one with `?tv` for the TV.

## Deploy

The game is served at **https://drawoodle.baskorp.com** by one Cloudflare Worker (`drawoodle`) with a D1 database (`drawoodle`), both set in `server/wrangler.toml`. `.github/workflows/deploy.yml` tests and builds the web app and type-checks the Worker on pull requests. On `main` it applies D1 migrations and deploys. It needs the repo secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, Workers Routes Edit, D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`.

`npm run deploy:embedded` (in `server/`, after building `webapp/`) deploys the same Worker with the web app built into the script (`wrangler.embedded.toml`, `src/embedded.ts`), for places where Cloudflare's separate static-asset upload isn't possible. The first deploy was made this way. A deploy from the workflow switches back to static assets.
