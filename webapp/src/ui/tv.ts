import { api, ApiError, linkWith } from '../online/client';
import type { GameView, RoomView } from '../online/types';
import { galleryHtml } from './app';
import { clockHtml, esc, fixed, lobbySlotsHtml, memberHtml, nameHtml, nextPlayers, patch, qrSvg, ranking, scoreboardHtml, settingsLine, sleep, textHtml, tickClocks, winnerHtml } from './parts';
import { fillPictures, pictureHtml, showPicture, watchPictures } from './picture';
import { revealHtml, revealStage } from './reveal';

const POLL_MS = 800;
const CODE_KEY = 'drawoodle-tv-code';
/** How long each drawing shows in the gallery at the end. */
const GALLERY_MS = 5000;

/**
 * The big screen: joins a room by its code, without being a player, and shows the
 * room's QR code, the drawings, the titles to vote on and the reveal for everyone.
 * Built for TV browsers: no input needed but the code, big type, and old-browser safe.
 */
export class TvApp {
  private generation = 0;
  private layoutKey = '';
  private room: RoomView | null = null;
  private clockOffset = 0;
  private tickTimer = 0;
  private slide = 0;
  private slideAt = 0;

  constructor(private readonly root: HTMLElement) {
    watchPictures(root);
  }

  start(code: string | null) {
    document.body.classList.add('tv-mode');
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(CODE_KEY);
    } catch {
      // No storage: the code is asked again after a reload.
    }
    const c = (code || saved || '').toUpperCase();
    if (/^[A-Z]{4}$/.test(c)) this.watch(c);
    else this.entry();
  }

  private stop() {
    this.generation++;
    this.layoutKey = '';
    this.room = null;
    clearInterval(this.tickTimer);
  }

  private remember(code: string | null) {
    try {
      if (code) localStorage.setItem(CODE_KEY, code);
      else localStorage.removeItem(CODE_KEY);
    } catch {
      // Ignore.
    }
    history.replaceState(null, '', code ? `?tv=${code}` : '?tv');
  }

  private entry(message = '') {
    this.stop();
    this.remember(null);
    this.root.className = 'tv';
    this.root.innerHTML = `
      <div class="tv-entry">
        <div class="logo big" aria-hidden="true"><span class="logo-pencil">✏️</span><span class="logo-word notranslate" translate="no">Drawoodle</span></div>
        <p class="tv-lead">Create a room on a phone, then enter its code here.</p>
        <form id="tv-form">
          <input name="code" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD" aria-label="Room code" class="notranslate" translate="no" dir="ltr" required />
          <button class="primary big">Show room</button>
        </form>
        ${message ? `<p class="warn">${esc(message)}</p>` : ''}
        <a class="link" href="${esc(location.pathname)}">← Play on this device instead</a>
      </div>`;
    const form = this.root.querySelector<HTMLFormElement>('#tv-form')!;
    const input = form.querySelector('input')!;
    input.focus();
    input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (input.value.length === 4) this.watch(input.value);
    });
  }

  private async watch(code: string) {
    this.stop();
    const generation = this.generation;
    this.root.className = 'tv';
    this.root.innerHTML = `<div class="tv-loading">Connecting to room ${fixed(code)}…</div>`;
    let first = true;
    let failures = 0;
    this.tickTimer = window.setInterval(() => this.tick(), 250);
    while (generation === this.generation) {
      try {
        const room = await api.tv(code);
        if (generation !== this.generation) return;
        if (first) this.remember(code);
        first = false;
        failures = 0;
        if (room.status === 'closed') return this.entry(`Room ${code} was closed.`);
        this.apply(room);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return this.entry(first ? `No room with the code ${code}.` : `Room ${code} has ended.`);
        if (++failures === 5) this.root.querySelector('.tv-offline')?.removeAttribute('hidden');
      }
      await sleep(POLL_MS);
    }
  }

  private get serverNow() {
    return Date.now() + this.clockOffset;
  }

  private tick() {
    tickClocks(this.root, this.clockOffset);
    const room = this.room;
    const g = room?.game;
    if (!room || !g) return;
    if (room.status === 'playing' && g.phase === 'reveal') this.renderReveal(room, g);
    if (room.status === 'finished' && g.gallery?.length && Date.now() - this.slideAt > GALLERY_MS) this.nextSlide(g);
  }

  private apply(room: RoomView) {
    this.room = room;
    this.clockOffset = room.now - Date.now();
    const g = room.game;
    const playing = room.status === 'playing' && g;
    const layout = playing ? `game:${g!.id}` : room.status === 'finished' && g ? `done:${g.id}` : 'lobby';
    if (layout !== this.layoutKey) {
      this.layoutKey = layout;
      this.slide = 0;
      this.slideAt = Date.now();
      const offline = '<p class="tv-offline" hidden>Reconnecting…</p>';
      if (playing)
        this.root.innerHTML = `<div class="tv-game"><header class="tv-top"></header><div class="tv-stage"></div><footer class="tv-bottom"></footer></div>${offline}`;
      else if (layout.startsWith('done')) this.root.innerHTML = `<div class="tv-done"></div>${offline}`;
      else this.root.innerHTML = `<div class="tv-lobby"></div>${offline}`;
    }
    this.root.querySelector('.tv-offline')?.setAttribute('hidden', '');
    if (playing) this.renderGame(room, g!);
    else if (layout.startsWith('done')) this.renderDone(room, g!);
    else this.renderLobby(room);
  }

  private joinHtml(room: RoomView, compact = false) {
    const link = linkWith('join', room.code);
    return `<div class="tv-join${compact ? ' compact' : ''}">
      <div class="qr">${qrSvg(link)}</div>
      <div class="tv-join-text">
        <p class="tv-join-label">Scan to join, or enter the code</p>
        <p class="big-code">${fixed(room.code)}</p>
        <p class="tv-url">${fixed(link.replace(/^https?:\/\//, '').replace(/\?.*$/, ''))}</p>
      </div>
    </div>`;
  }

  private titleHtml(room: RoomView) {
    return `<div class="tv-title"><span class="logo-word notranslate" translate="no">Drawoodle</span><span class="tv-room">Room ${fixed(room.code, 'code')}</span></div>`;
  }

  private renderLobby(room: RoomView) {
    const n = nextPlayers(room).length;
    patch(
      this.root.querySelector('.tv-lobby'),
      `<header class="tv-head">${this.titleHtml(room)}</header>
      <div class="tv-lobby-main">
        ${this.joinHtml(room)}
        <section class="tv-players">
          <h2>Players ${fixed(`${n}/8`)}</h2>
          ${lobbySlotsHtml(room)}
          <p class="muted">${esc(settingsLine(room.settings))}</p>
          <p class="tv-hint">${n < 3 ? `Waiting for at least ${fixed(3)} players…` : 'The host starts the game from their phone.'}</p>
        </section>
      </div>`,
    );
  }

  private renderGame(room: RoomView, game: GameView) {
    const where =
      game.phase === 'draw'
        ? `Round ${fixed(`${game.round + 1}/${game.rounds}`)}`
        : `Round ${fixed(`${game.round + 1}/${game.rounds}`)} · Drawing ${fixed(`${game.step + 1}/${game.steps}`)}`;
    const what = {
      draw: 'Everyone, draw your secret prompt!',
      fib: 'What is this? Write a fake title on your phone',
      vote: 'Which is the real title? Vote on your phone',
      reveal: 'The reveal',
      over: 'Game over',
    }[game.phase];
    patch(
      this.root.querySelector('.tv-top'),
      `${this.titleHtml(room)}<div class="tv-phase"><p class="tv-where">${where}</p><h1>${what}</h1></div>${
        game.phase === 'reveal' ? '<span class="tv-clock-spacer"></span>' : `<div class="tv-clock">${clockHtml(game.endsAt, this.serverNow)}</div>`
      }`,
    );
    const stage = this.root.querySelector<HTMLElement>('.tv-stage')!;
    const artist = game.drawing ? room.members[game.drawing.artist] : undefined;
    const by = artist ? `<p class="tv-byline">by ${nameHtml(artist.nickname)}</p>` : '';
    let html: string;
    switch (game.phase) {
      case 'draw':
        html = `<div class="tv-drawing-time"><p class="big-emoji">✏️</p><p class="tv-lead">Draw it so the others can guess it, but not <i>too</i> easily…</p></div>`;
        break;
      case 'fib':
        html = `<div class="tv-split">${pictureHtml(game.drawing?.id ?? null, 'tv-picture')}<div class="tv-side">${by}<p class="tv-lead">Make up a title that sounds real. If others pick yours, you score!</p></div></div>`;
        break;
      case 'vote':
        html = `<div class="tv-split">${pictureHtml(game.drawing?.id ?? null, 'tv-picture')}<div class="tv-side">${by}<ol class="tv-options">${(game.options ?? [])
          .map((o) => `<li>${textHtml(o.text)}</li>`)
          .join('')}</ol></div></div>`;
        break;
      case 'reveal':
        html = `<div class="tv-split">${pictureHtml(game.drawing?.id ?? null, 'tv-picture')}<div class="tv-side"><div class="reveal big"></div></div></div>`;
        break;
      default:
        html = '';
    }
    if (patch(stage, html)) fillPictures(stage);
    else for (const box of stage.querySelectorAll<HTMLElement>('[data-picture]')) showPicture(box, box.dataset.picture || null);
    if (game.phase === 'reveal') this.renderReveal(room, game);
    const status = game.phase === 'draw' || game.phase === 'fib' || game.phase === 'vote';
    patch(
      this.root.querySelector('.tv-bottom'),
      `<ul class="members row">${(status ? room.members : ranking(room.members)).map((m) => memberHtml(m, { status, score: !status })).join('')}</ul>`,
    );
    tickClocks(this.root, this.clockOffset);
  }

  private renderReveal(room: RoomView, game: GameView) {
    patch(this.root.querySelector('.tv-stage .reveal'), revealHtml(game, room.members, revealStage(game, this.serverNow)));
  }

  private renderDone(room: RoomView, game: GameView) {
    const box = this.root.querySelector<HTMLElement>('.tv-done')!;
    const changed = patch(
      box,
      `<header class="tv-head">${this.titleHtml(room)}</header>
      <div class="tv-done-main">
        <section class="tv-final">
          <h1>${game.status === 'ended' ? 'Game over' : 'And the winner is…'}</h1>
          ${winnerHtml(room.members)}
          ${scoreboardHtml(room.members)}
          <p class="tv-hint">The host can start the next game from their phone.</p>
          ${nextPlayers(room).length < 8 ? this.joinHtml(room, true) : ''}
        </section>
        <section class="tv-slides">${game.gallery?.length ? galleryHtml(room, game) : ''}</section>
      </div>`,
    );
    if (changed) {
      fillPictures(box);
      this.showSlide();
    }
  }

  private nextSlide(game: GameView) {
    this.slide = (this.slide + 1) % (game.gallery?.length || 1);
    this.slideAt = Date.now();
    this.showSlide();
  }

  /** The gallery at the end shows one drawing at a time with its real title. */
  private showSlide() {
    const items = this.root.querySelectorAll<HTMLElement>('.tv-slides .gallery-item');
    items.forEach((el, i) => el.classList.toggle('on', i === this.slide % items.length));
  }
}
