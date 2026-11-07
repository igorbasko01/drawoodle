import { FIB_MAX, MAX_PLAYERS, MAX_ROUNDS, MIN_PLAYERS } from '../engine/game';
import { PACKS } from '../engine/prompts';
import { api, ApiError, linkWith, loadIdentity, saveIdentity, type Identity } from '../online/client';
import type { GameView, RoomSettings, RoomView } from '../online/types';
import { Pad } from './pad';
import {
  clockHtml,
  esc,
  fixed,
  howToPlayHtml,
  lobbySlotsHtml,
  memberHtml,
  nameHtml,
  nextPlayers,
  patch,
  ranking,
  scoreboardHtml,
  settingsLine,
  sleep,
  textHtml,
  tickClocks,
  winnerHtml,
} from './parts';
import { fillPictures, pictureHtml, watchPictures } from './picture';
import { revealHtml, revealStage, yourGainLine } from './reveal';

const POLL_MS = 1000;
/** Phones hand in what they have this long before time runs out (the server waits a little longer). */
const AUTO_SEND_MS = 700;

const logoHtml = (big = false) =>
  `<div class="logo${big ? ' big' : ''}" aria-hidden="true"><span class="logo-pencil">✏️</span><span class="logo-word notranslate" translate="no">Drawoodle</span></div>`;

/** The game on a phone: name, home, lobby, then drawing, fake titles, votes and the reveal. */
export class PhoneApp {
  private identity: Identity | null = loadIdentity();
  private room: RoomView | null = null;
  /** Bumped to stop the room's background polling. */
  private generation = 0;
  /** Server clock minus this device's clock. */
  private clockOffset = 0;
  /** Requests sent and not answered yet: the screen already shows them, so polls wait. */
  private pending = 0;
  /** Bumped on every move, so a poll that started before it can't undo it. */
  private moves = 0;
  private layoutKey = '';
  private phaseKey = '';
  private pad: Pad | null = null;
  /** The fake title being typed, kept across updates. */
  private draft = '';
  private editingFib = false;
  /** The position this device last showed, to notice when a new phase starts. */
  private shownPhase = '';
  private tickTimer = 0;
  private autoTimer = 0;

  constructor(private readonly root: HTMLElement) {
    watchPictures(root);
  }

  async start(params: URLSearchParams) {
    const join = params.get('join');
    if (join) history.replaceState(null, '', location.pathname);
    if (!this.identity) return this.welcome(join);
    if (join) return this.joinCode(join);
    try {
      const { room } = await api.currentRoom(this.identity.token);
      if (room && room.status !== 'closed') return this.enterRoom(room);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        saveIdentity((this.identity = null));
        return this.welcome(null);
      }
    }
    this.home();
  }

  private get token() {
    return this.identity!.token;
  }

  private screen(html: string) {
    this.stopRoom();
    this.root.className = 'phone';
    this.root.innerHTML = html;
    return this.root;
  }

  toast(message: string) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2800);
    setTimeout(() => el.remove(), 3300);
  }

  private fail(e: unknown) {
    this.toast(e instanceof Error ? e.message : 'Something went wrong');
  }

  // ---------------------------------------------------------------- welcome & home

  private welcome(join: string | null) {
    const root = this.screen(`
      <div class="screen center">
        <div class="hero">
          ${logoHtml(true)}
          <p class="tagline">Draw silly things. Make up fake titles. Fool your friends. 3–8 players.</p>
        </div>
        <form class="panel" id="name-form">
          <label class="field">Your name
            <input name="nickname" maxlength="16" autocomplete="nickname" dir="auto" placeholder="e.g. Sam" required />
          </label>
          <button class="primary big">${join ? `Join room ${fixed(join.toUpperCase())}` : 'Continue'}</button>
        </form>
        <button class="ghost" data-tv>📺 Use this screen as a TV</button>
      </div>`);
    const form = root.querySelector<HTMLFormElement>('#name-form')!;
    form.querySelector('input')!.focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const nickname = new FormData(form).get('nickname') as string;
      const button = form.querySelector('button')!;
      button.disabled = true;
      try {
        this.identity = await api.register(nickname);
        saveIdentity(this.identity);
        if (join) await this.joinCode(join);
        else this.home();
      } catch (e) {
        this.fail(e);
        button.disabled = false;
      }
    });
    root.querySelector('[data-tv]')!.addEventListener('click', () => this.openTv());
  }

  private openTv() {
    location.href = linkWith('tv', '').replace(/=$/, '');
  }

  private home() {
    const me = this.identity!.player;
    const root = this.screen(`
      <div class="screen">
        <div class="hero small">${logoHtml()}</div>
        <p class="hello">Hi ${nameHtml(me.nickname)}! <button class="link" data-rename>Change name</button></p>
        <button class="primary big" data-create>Create a room</button>
        <form class="panel join" id="join-form">
          <label class="field">Join with a room code
            <input name="code" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD" class="notranslate code-input" translate="no" dir="ltr" required />
          </label>
          <button class="secondary">Join</button>
        </form>
        <button class="ghost" data-tv>📺 Use this screen as a TV</button>
        <details class="panel how"><summary>How to play</summary>${howToPlayHtml}</details>
      </div>`);
    root.querySelector('[data-create]')!.addEventListener('click', async (ev) => {
      const button = ev.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        // Hebrew phones get Hebrew prompts to start with; the host can change it in the lobby.
        const he = /^(he|iw)\b/i.test(navigator.language || '');
        this.enterRoom(await api.createRoom(this.token, { pack: he ? 'he' : 'en' }));
      } catch (e) {
        this.fail(e);
        button.disabled = false;
      }
    });
    const form = root.querySelector<HTMLFormElement>('#join-form')!;
    const input = form.querySelector('input')!;
    input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.joinCode(input.value);
    });
    root.querySelector('[data-tv]')!.addEventListener('click', () => this.openTv());
    root.querySelector('[data-rename]')!.addEventListener('click', async () => {
      const nickname = prompt('Your name', me.nickname)?.trim();
      if (!nickname) return;
      try {
        const { player } = await api.rename(this.token, nickname);
        this.identity = { ...this.identity!, player };
        saveIdentity(this.identity);
        this.home();
      } catch (e) {
        this.fail(e);
      }
    });
  }

  private async joinCode(code: string) {
    try {
      this.enterRoom(await api.join(this.token, code));
    } catch (e) {
      this.fail(e);
      this.home();
    }
  }

  // ---------------------------------------------------------------- the room

  private stopRoom() {
    this.generation++;
    this.pad?.destroy();
    this.pad = null;
    this.room = null;
    this.layoutKey = '';
    this.phaseKey = '';
    this.pending = 0;
    clearInterval(this.tickTimer);
    clearTimeout(this.autoTimer);
  }

  private enterRoom(room: RoomView) {
    this.screen('');
    const generation = this.generation;
    this.apply(room);
    this.tickTimer = window.setInterval(() => this.tick(), 250);
    void this.poll(generation);
  }

  private tick() {
    tickClocks(this.root, this.clockOffset);
    const g = this.room?.game;
    if (g && g.phase === 'reveal' && this.room?.status === 'playing') this.renderReveal(this.room, g);
  }

  private async poll(generation: number) {
    while (generation === this.generation) {
      await sleep(POLL_MS);
      if (generation !== this.generation || !this.room || this.pending) continue;
      const moves = this.moves;
      try {
        const room = await api.room(this.token, this.room.id);
        if (generation === this.generation && !this.pending && moves === this.moves) this.apply(room);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          this.toast('You are no longer in that room');
          return this.home();
        }
        // A dropped connection: keep trying.
      }
    }
  }

  private get serverNow() {
    return Date.now() + this.clockOffset;
  }

  private apply(room: RoomView) {
    this.room = room;
    this.clockOffset = room.now - Date.now();
    const inGame = room.status === 'playing' && room.game;
    const layout = inGame ? `game:${room.game!.id}` : 'lobby';
    if (layout !== this.layoutKey) {
      this.layoutKey = layout;
      this.phaseKey = '';
      this.pad?.destroy();
      this.pad = null;
      this.root.innerHTML = `
        <div class="room">
          <header class="room-bar">
            <span class="code-chip">Room ${fixed(room.code, 'code')}</span>
            <span class="tv-chip" hidden>📺 TV on</span>
            <span class="spacer"></span>
            <details class="menu">
              <summary aria-label="Menu">⋯</summary>
              <div class="menu-items">
                <button data-share>Invite players</button>
                <button data-skip hidden>Skip ahead ⏭</button>
                <button data-end hidden>End game</button>
                <div class="menu-remove"></div>
                <button data-leave class="danger">Leave room</button>
              </div>
            </details>
          </header>
          <main class="room-body">${
            inGame
              ? `<div class="phase-head"></div>
                 <div class="phase-main"></div>
                 <div class="phase-foot"></div>`
              : ''
          }</main>
        </div>`;
      this.root.querySelector('[data-leave]')!.addEventListener('click', () => this.leave());
      this.root.querySelector('[data-end]')!.addEventListener('click', () => this.endGame());
      this.root.querySelector('[data-skip]')!.addEventListener('click', () => this.skip());
      this.root.querySelector('[data-share]')!.addEventListener('click', () => this.share());
      for (const b of this.root.querySelectorAll('.menu-items button'))
        b.addEventListener('click', () => this.root.querySelector<HTMLDetailsElement>('.menu')!.removeAttribute('open'));
    }
    this.root.querySelector<HTMLElement>('.tv-chip')!.hidden = !room.tv;
    const host = room.hostId === room.you;
    this.root.querySelector<HTMLElement>('[data-end]')!.hidden = !(host && room.status === 'playing');
    this.root.querySelector<HTMLElement>('[data-skip]')!.hidden = !(host && room.status === 'playing');
    this.renderRemoveMenu(room, host);
    if (inGame) this.renderGame(room, room.game!);
    else this.renderLobby(room);
  }

  private async share() {
    if (!this.room) return;
    const url = linkWith('join', this.room.code);
    const text = `Join my Drawoodle room: ${this.room.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Drawoodle', text, url });
      else {
        await navigator.clipboard.writeText(url);
        this.toast('Invite link copied');
      }
    } catch {
      // The share sheet was closed.
    }
  }

  /** The host's "Remove …" entries in the menu: everyone else still in the room. */
  private renderRemoveMenu(room: RoomView, host: boolean) {
    const others = host ? [...room.members, ...room.waiting].filter((m) => !m.left && m.id !== room.you) : [];
    const box = this.root.querySelector<HTMLElement>('.menu-remove')!;
    if (!patch(box, others.map((m) => `<button class="danger" data-remove="${esc(m.id)}">Remove ${nameHtml(m.nickname)}</button>`).join(''))) return;
    for (const b of box.querySelectorAll<HTMLButtonElement>('[data-remove]'))
      b.addEventListener('click', () => {
        this.root.querySelector<HTMLDetailsElement>('.menu')!.removeAttribute('open');
        const m = others.find((x) => x.id === b.dataset.remove);
        if (m) this.removePlayer(m.id, m.nickname);
      });
  }

  private async removePlayer(playerId: string, nickname: string) {
    if (!this.room) return;
    const playing = this.room.status === 'playing';
    if (!confirm(`Remove ${nickname} from the room?${playing ? ' The game won’t wait for them any more.' : ''}`)) return;
    try {
      this.apply(await api.remove(this.token, this.room.id, playerId));
    } catch (e) {
      this.fail(e);
    }
  }

  private async leave() {
    if (!this.room) return;
    const inGame = this.room.status === 'playing' && !!this.room.game?.you;
    if (inGame && !confirm('Leave the game? You can come back with the room code.')) return;
    try {
      await api.leave(this.token, this.room.id);
      this.home();
    } catch (e) {
      this.fail(e);
    }
  }

  private async endGame() {
    if (!this.room || !confirm('End this game for everyone?')) return;
    try {
      this.apply(await api.end(this.token, this.room.id));
    } catch (e) {
      this.fail(e);
    }
  }

  private async skip() {
    const g = this.room?.game;
    if (!this.room || !g) return;
    const what = { draw: 'Stop drawing now? Drawings not handed in are lost.', fib: 'Stop writing fake titles now?', vote: 'Stop voting now?', reveal: '', over: '' }[g.phase];
    if (what && !confirm(what)) return;
    await this.send(() => api.next(this.token, this.room!.id, { round: g.round, phase: g.phase, step: g.step }));
  }

  /** Sends a move; while it's on its way, polls wait, so the screen doesn't jump back. */
  private async send(request: () => Promise<RoomView>) {
    const generation = this.generation;
    this.moves++;
    this.pending++;
    try {
      const answer = await request();
      this.pending--;
      if (generation === this.generation && !this.pending) this.apply(answer);
      return true;
    } catch (e) {
      this.pending--;
      if (generation === this.generation) {
        this.fail(e);
        if (!this.pending && this.room) this.apply(this.room);
      }
      return false;
    }
  }

  // ---------------------------------------------------------------- lobby & results

  private renderLobby(room: RoomView) {
    const host = room.hostId === room.you;
    const next = nextPlayers(room);
    const s = room.settings;
    const finished = room.status === 'finished' && room.game ? room.game : null;
    const enough = next.length >= MIN_PLAYERS;
    const segment = <K extends keyof RoomSettings>(key: K, options: [RoomSettings[K], string][]) =>
      `<div class="segmented" role="radiogroup">${options
        .map(([v, label]) => `<button class="seg${s[key] === v ? ' on' : ''}" role="radio" aria-checked="${s[key] === v}" data-key="${key}" data-value="${v}">${label}</button>`)
        .join('')}</div>`;
    const body = this.root.querySelector<HTMLElement>('.room-body')!;
    const changed = patch(
      body,
      `<div class="lobby">
        ${finished ? this.resultHtml(room, finished) : ''}
        <section class="panel">
          <h2>${finished ? 'Next game' : 'Players'} <small>${fixed(`${next.length}/${MAX_PLAYERS}`)}</small></h2>
          ${lobbySlotsHtml(room, true)}
          ${next.length < MAX_PLAYERS ? `<button class="secondary wide" data-invite>Invite players · code ${fixed(room.code, 'code')}</button>` : ''}
        </section>
        <section class="panel">
          <h2>Game</h2>
          ${
            host
              ? `<p class="setting-label">Rounds</p>
                 ${segment(
                   'rounds',
                   [...Array(MAX_ROUNDS).keys()].map((i) => [i + 1, String(i + 1)] as [number, string]),
                 )}
                 <p class="setting-label">Prompts</p>
                 ${segment('pack', [
                   ['en', `<span lang="en">English</span>`],
                   ['he', `<span class="notranslate" translate="no" lang="he" dir="rtl">${PACKS.he.name}</span>`],
                 ])}
                 <p class="setting-label">Pace</p>
                 ${segment('pace', [
                   ['normal', 'Normal'],
                   ['relaxed', 'Relaxed'],
                 ])}`
              : ''
          }
          <p class="muted">${esc(settingsLine(s))}</p>
        </section>
        <section class="panel tv-panel">
          <h2>📺 Big screen ${room.tv ? '<small class="ok">connected</small>' : ''}</h2>
          <p class="muted">${
            room.tv
              ? 'The TV is showing this room.'
              : `Best with a TV everyone can see: open this game on a TV or laptop, choose <b>Use this screen as a TV</b> and enter ${fixed(room.code, 'code')}.`
          }</p>
        </section>
        ${
          host
            ? `<button class="primary big start" data-start ${enough ? '' : 'disabled'}>${finished ? 'Play again' : 'Start game'}</button>
               ${enough ? '' : `<p class="waiting-host">You need at least ${MIN_PLAYERS} players.</p>`}`
            : `<p class="waiting-host">Waiting for the host to ${finished ? 'start the next game' : 'start'}…</p>`
        }
      </div>`,
    );
    if (!changed) return;
    fillPictures(body);
    body.querySelector('[data-invite]')?.addEventListener('click', () => this.share());
    body.querySelector('[data-start]')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      b.disabled = true;
      if (!(await this.send(() => api.start(this.token, room.id)))) b.disabled = false;
    });
    for (const b of body.querySelectorAll<HTMLButtonElement>('.seg'))
      b.addEventListener('click', () => {
        const key = b.dataset.key as keyof RoomSettings;
        const value = key === 'rounds' ? Number(b.dataset.value) : b.dataset.value;
        void this.send(() => api.settings(this.token, room.id, { [key]: value }));
      });
  }

  private resultHtml(room: RoomView, game: GameView) {
    return `<section class="panel result">
      <h2>${game.status === 'ended' ? 'Game over' : 'And the winner is…'}</h2>
      ${winnerHtml(room.members)}
      ${scoreboardHtml(room.members, null, room.you)}
      ${game.gallery?.length ? `<h3>The drawings</h3>${galleryHtml(room, game)}` : ''}
    </section>`;
  }

  // ---------------------------------------------------------------- the game

  private renderGame(room: RoomView, game: GameView) {
    const you = game.you;
    const position = `${game.round}:${game.phase}:${game.step}`;
    if (position !== this.shownPhase) {
      if (this.shownPhase) navigator.vibrate?.(60);
      this.shownPhase = position;
      this.draft = '';
      this.editingFib = false;
    }
    const role = !you ? 'watch' : game.phase === 'draw' ? (you.drew ? 'drew' : 'drawing') : you.artist ? 'artist' : game.phase === 'fib' ? (you.fib && !this.editingFib ? 'sent' : 'writing') : 'player';
    const key = `${position}:${role}`;
    const head = this.root.querySelector<HTMLElement>('.phase-head')!;
    const main = this.root.querySelector<HTMLElement>('.phase-main')!;
    const foot = this.root.querySelector<HTMLElement>('.phase-foot')!;
    patch(head, this.headHtml(game));

    if (key !== this.phaseKey) {
      this.phaseKey = key;
      if (this.pad && role !== 'drawing') {
        this.pad.destroy();
        this.pad = null;
      }
      main.className = `phase-main phase-${game.phase} role-${role}`;
      (main as HTMLElement & { __html?: string }).__html = undefined;
      main.innerHTML = this.mainHtml(room, game, role);
      fillPictures(main);
      this.wire(main, room, game, role);
    }
    if (game.phase === 'vote') this.markVote(main, game);
    if (game.phase === 'reveal') this.renderReveal(room, game);
    const showStatus = game.phase === 'draw' || game.phase === 'fib' || game.phase === 'vote';
    patch(
      foot,
      showStatus
        ? `<ul class="members mini">${room.members.map((m) => memberHtml(m, { you: room.you, status: true })).join('')}</ul>`
        : `<ul class="members mini">${ranking(room.members)
            .map((m) => memberHtml(m, { you: room.you, score: true }))
            .join('')}</ul>`,
    );
    tickClocks(this.root, this.clockOffset);
    this.scheduleAutoSend(room, game, role);
  }

  private headHtml(game: GameView) {
    const clock = game.phase === 'reveal' ? '' : clockHtml(game.endsAt, this.serverNow);
    const where =
      game.phase === 'draw'
        ? `Round ${fixed(`${game.round + 1}/${game.rounds}`)}`
        : `Round ${fixed(`${game.round + 1}/${game.rounds}`)} · Drawing ${fixed(`${game.step + 1}/${game.steps}`)}`;
    const what = { draw: 'Draw!', fib: 'Make up a title', vote: 'Find the real title', reveal: 'The reveal', over: 'Game over' }[game.phase];
    return `<div class="phase-where">${where}</div><div class="phase-what"><h1>${what}</h1>${clock}</div>`;
  }

  private mainHtml(room: RoomView, game: GameView, role: string) {
    const prompt = game.prompt ? `<p class="prompt" lang="${game.pack}">${textHtml(game.prompt)}</p>` : '';
    const picture = game.drawing ? pictureHtml(game.drawing.id) : '';
    const artist = game.drawing ? room.members[game.drawing.artist] : undefined;
    const byline = artist ? `<p class="byline">Drawn by ${nameHtml(artist.nickname)}</p>` : '';
    switch (`${game.phase}:${role}`) {
      case 'draw:drawing':
        return `<p class="prompt-label">Your secret prompt. Draw it, no letters!</p>${prompt}
          <div class="pad"></div>
          <button class="primary big" data-send-drawing>Done!</button>`;
      case 'draw:drew':
        return `<div class="waiting-card"><p class="big-emoji">🎨</p><p><b>Nice!</b> Waiting for the others to finish their masterpieces…</p></div>`;
      case 'fib:artist':
        return `${picture}<div class="artist-note"><p>This is <b>your</b> drawing of</p>${prompt}<p class="muted">The others are making up titles for it. Keep a straight face!</p></div>`;
      case 'fib:writing':
        return `${picture}${byline}
          <form class="fib-form" id="fib-form">
            <label class="field">What is it really? Write a fake title that will fool the others
              <input name="text" maxlength="${FIB_MAX}" dir="auto" autocomplete="off" placeholder="A fake title…" required value="${esc(this.draft || (game.you?.fib ?? ''))}" />
            </label>
            <button class="primary big">Send fake title</button>
          </form>`;
      case 'fib:sent':
        return `${picture}${byline}<div class="sent-card"><p>Your fake title</p><p class="sent-fib">“${textHtml(game.you!.fib!)}”</p><button class="link" data-edit-fib>Change it</button></div>`;
      case 'vote:artist':
        return `${picture}<div class="artist-note"><p>Your drawing! Will they find</p>${prompt}</div>`;
      case 'vote:player':
        return `${picture}${byline}<p class="vote-help">Which one is the real title?</p>
          <div class="options">${(game.options ?? [])
            .map(
              (o, i) =>
                `<button class="option${o.mine ? ' mine' : ''}" data-option="${i}" ${o.mine ? 'disabled' : ''}>${textHtml(o.text)}${
                  o.mine ? ' <small class="tag">yours</small>' : ''
                }</button>`,
            )
            .join('')}</div>`;
      case 'reveal:artist':
      case 'reveal:player':
      case 'reveal:watch':
        return `${pictureHtml(game.drawing?.id ?? null, 'small')}<div class="reveal"></div><p class="your-gain"></p>`;
      default:
        return `${picture}<p class="muted center">You’re watching this game. You can play in the next one.</p>`;
    }
  }

  private wire(main: HTMLElement, room: RoomView, game: GameView, role: string) {
    if (role === 'drawing') {
      this.pad = new Pad(main.querySelector('.pad')!, `drawoodle-pad:${game.id}:${game.round}`);
      main.querySelector('[data-send-drawing]')!.addEventListener('click', () => this.sendDrawing(room, game));
    }
    const form = main.querySelector<HTMLFormElement>('#fib-form');
    if (form) {
      const input = form.querySelector('input')!;
      input.addEventListener('input', () => (this.draft = input.value));
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        this.sendFib(room, game, input.value);
      });
    }
    main.querySelector('[data-edit-fib]')?.addEventListener('click', () => {
      this.editingFib = true;
      this.draft = game.you?.fib ?? '';
      if (this.room) this.apply(this.room);
      this.root.querySelector<HTMLInputElement>('#fib-form input')?.focus();
    });
    for (const b of main.querySelectorAll<HTMLButtonElement>('[data-option]'))
      b.addEventListener('click', () => this.sendVote(room, game, Number(b.dataset.option)));
  }

  private markVote(main: HTMLElement, game: GameView) {
    for (const b of main.querySelectorAll<HTMLElement>('[data-option]')) b.classList.toggle('chosen', Number(b.dataset.option) === game.you?.vote);
  }

  private renderReveal(room: RoomView, game: GameView) {
    const box = this.root.querySelector<HTMLElement>('.reveal');
    if (!box) return;
    const stage = revealStage(game, this.serverNow);
    patch(box, revealHtml(game, room.members, stage, room.you));
    patch(this.root.querySelector('.your-gain'), stage.kind === 'scores' ? esc(yourGainLine(game)) : '');
  }

  /** Hands in what's on the pad, or what's typed, just before time runs out. */
  private scheduleAutoSend(room: RoomView, game: GameView, role: string) {
    clearTimeout(this.autoTimer);
    if (role !== 'drawing' && role !== 'writing') return;
    const wait = game.endsAt - AUTO_SEND_MS - this.serverNow;
    const generation = this.generation;
    this.autoTimer = window.setTimeout(() => {
      if (generation !== this.generation || this.phaseKey !== `${game.round}:${game.phase}:${game.step}:${role}`) return;
      if (role === 'drawing' && this.pad && !this.pad.empty) this.sendDrawing(room, game);
      if (role === 'writing' && this.draft.trim()) this.sendFib(room, game, this.draft);
    }, Math.max(0, wait));
  }

  private sendDrawing(room: RoomView, game: GameView) {
    const pad = this.pad;
    if (!pad || this.pending) return;
    if (pad.empty) return this.toast('Draw something first!');
    const drawing = pad.drawing();
    // Show "done" at once; the server's answer follows.
    this.room = { ...room, game: { ...game, you: { ...game.you!, drew: true } } };
    this.apply(this.room);
    void this.send(() => api.draw(this.token, room.id, game.round, drawing)).then((ok) => {
      if (ok) pad.forget();
      // If it didn't arrive, the pad comes back with the drawing (it was saved in the browser).
      if (!ok && this.room?.game?.phase === 'draw') this.apply({ ...this.room, game: { ...this.room.game, you: { ...this.room.game.you!, drew: false } } });
    });
  }

  private sendFib(room: RoomView, game: GameView, text: string) {
    const t = text.trim();
    if (!t) return;
    this.editingFib = false;
    this.draft = t;
    this.room = { ...room, game: { ...game, you: { ...game.you!, fib: t } } };
    this.apply(this.room);
    void this.send(() => api.fib(this.token, room.id, game.round, game.step, t)).then((ok) => {
      if (!ok && this.room?.game?.phase === 'fib') {
        this.editingFib = true;
        this.apply(this.room);
      }
    });
  }

  private sendVote(room: RoomView, game: GameView, option: number) {
    this.room = { ...room, game: { ...game, you: { ...game.you!, vote: option } } };
    this.apply(this.room);
    void this.send(() => api.vote(this.token, room.id, game.round, game.step, option));
  }
}

/** Every drawing of a finished game with its real title. */
export const galleryHtml = (room: RoomView, game: GameView) =>
  `<div class="gallery">${(game.gallery ?? [])
    .map((d) => {
      const m = room.members[d.artist];
      return `<figure class="gallery-item">${pictureHtml(d.id)}<figcaption><span lang="${game.pack}">${textHtml(d.prompt)}</span>${
        m ? `<small>by ${nameHtml(m.nickname)}</small>` : ''
      }</figcaption></figure>`;
    })
    .join('')}</div>`;
