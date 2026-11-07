import qrcode from 'qrcode-generator';
import { MAX_PLAYERS, TIMES } from '../engine/game';
import type { MemberView, RoomSettings, RoomView } from '../online/types';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const SEAT_COLORS = ['#ff5d8f', '#3ec7ff', '#ffd23f', '#5ee08a', '#b78cff', '#ff8a3d', '#2ee6d6', '#f2f2f2'];
export const seatColor = (seat: number) => SEAT_COLORS[((seat % SEAT_COLORS.length) + SEAT_COLORS.length) % SEAT_COLORS.length];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sets an element's HTML only when it changed: fewer repaints, and the browser's page translation isn't undone every second. */
export const patch = (el: Element | null, html: string) => {
  if (!el) return false;
  const box = el as HTMLElement & { __html?: string };
  if (box.__html === html) return false;
  box.__html = html;
  el.innerHTML = html;
  return true;
};

/** Words a player wrote (names, fake titles): their own direction (Hebrew reads right to left), and left alone by translation for names. */
export const nameHtml = (name: string) => `<bdi class="name notranslate" translate="no" dir="auto">${esc(name)}</bdi>`;
export const textHtml = (text: string) => `<bdi dir="auto">${esc(text)}</bdi>`;
/** Codes, numbers and clocks never get translated. */
export const fixed = (text: string | number, cls = '') => `<span class="notranslate ${cls}" translate="no">${esc(String(text))}</span>`;

/** A QR code for a link, as an SVG that scales to its box. */
export const qrSvg = (text: string) => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
};

export const avatarHtml = (m: { nickname: string; seat: number }, cls = '') =>
  `<span class="avatar ${cls}" style="--seat-color:${seatColor(m.seat)}" aria-hidden="true"><span class="notranslate" translate="no">${esc(
    Array.from(m.nickname)[0]?.toUpperCase() ?? '?',
  )}</span></span>`;

/** A member as a row. `status` adds ✓ / … for the current phase. */
export const memberHtml = (m: MemberView, opts: { you?: string | null; status?: boolean; score?: boolean } = {}) => {
  const tags = [m.host ? 'host' : '', m.id === opts.you ? 'you' : '', m.artist ? 'artist' : '', m.left ? 'left' : !m.online ? 'away' : ''].filter(Boolean);
  const cls = [opts.status ? (m.done ? 'is-done' : 'is-busy') : '', m.online && !m.left ? '' : 'is-away'].join(' ');
  return `<li class="member ${cls}" style="--seat-color:${seatColor(m.seat)}">
    ${avatarHtml(m)}
    <span class="member-name">${nameHtml(m.nickname)}${tags.map((t) => ` <small class="tag">${t}</small>`).join('')}</span>
    ${opts.score ? `<span class="member-score">${fixed(m.score.toLocaleString('en'))}</span>` : ''}
    ${opts.status ? `<span class="member-status" aria-label="${m.done ? 'done' : 'not yet'}">${m.done ? '✓' : '…'}</span>` : ''}
  </li>`;
};

/** Avatars in a row, e.g. who voted for a title. */
export const facesHtml = (seats: number[], members: MemberView[]) =>
  `<span class="faces">${seats
    .map((s) => members[s])
    .filter(Boolean)
    .map((m) => avatarHtml(m, 'small'))
    .join('')}</span>`;

/** Players by score, the leader first. */
export const ranking = (members: MemberView[]) => [...members].sort((a, b) => b.score - a.score || a.seat - b.seat);

export const scoreboardHtml = (members: MemberView[], gains: number[] | null = null, you: string | null = null) =>
  `<ol class="scoreboard">${ranking(members)
    .map(
      (m, i) => `<li class="score-row${m.id === you ? ' me' : ''}" style="--seat-color:${seatColor(m.seat)}">
        <span class="rank">${fixed(i + 1)}</span>
        ${avatarHtml(m)}
        <span class="member-name">${nameHtml(m.nickname)}</span>
        ${gains && gains[m.seat] ? `<span class="gain">${fixed(`+${gains[m.seat].toLocaleString('en')}`)}</span>` : ''}
        <span class="member-score">${fixed(m.score.toLocaleString('en'))}</span>
      </li>`,
    )
    .join('')}</ol>`;

/** A countdown to `endsAt` (server time); kept ticking by tickClocks. */
export const clockHtml = (endsAt: number, serverNow: number) =>
  `<span class="clock notranslate" translate="no" data-ends="${endsAt}">${Math.max(0, Math.ceil((endsAt - serverNow) / 1000))}</span>`;

/** Keeps every on-screen countdown ticking between server updates. Only numbers change: nothing to retranslate. */
export const tickClocks = (root: HTMLElement, clockOffset: number) => {
  const now = Date.now() + clockOffset;
  for (const el of root.querySelectorAll<HTMLElement>('.clock[data-ends]')) {
    const left = Math.max(0, Math.ceil((Number(el.dataset.ends) - now) / 1000));
    const text = String(left);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('hurry', left <= 10);
  }
};

export const settingsLine = (s: RoomSettings) =>
  `${s.rounds} ${s.rounds === 1 ? 'round' : 'rounds'} · ${s.pack === 'he' ? 'Hebrew prompts' : 'English prompts'} · ${s.pace === 'relaxed' ? 'relaxed' : 'normal'} pace (${
    TIMES[s.pace].draw
  }s to draw)`;

/** Everyone in the room for the next game. */
export const nextPlayers = (room: RoomView) => [...room.members.filter((m) => !m.left), ...room.waiting];

/** The players for the next game, and empty places: all of them on the TV, just the next one on a phone. */
export const lobbySlotsHtml = (room: RoomView, compact = false) => {
  const next = nextPlayers(room);
  const slots: string[] = [];
  const shown = compact ? Math.min(MAX_PLAYERS, next.length + 1) : MAX_PLAYERS;
  for (let seat = 0; seat < shown; seat++) {
    const m = next[seat];
    slots.push(
      m
        ? memberHtml({ ...m, seat })
        : `<li class="member empty" style="--seat-color:${seatColor(seat)}"><span class="avatar">?</span><span class="member-name">Waiting for a player…</span></li>`,
    );
  }
  return `<ul class="members slots${compact ? ' compact' : ''}">${slots.join('')}</ul>`;
};

export const howToPlayHtml = `
  <ol class="rules">
    <li>One player creates a room; everyone else joins on their phone with the room code (3–8 players).</li>
    <li>Everyone gets a <b>secret, silly prompt</b> and draws it on their phone.</li>
    <li>Then the drawings are shown one by one. For each, the others <b>write a fake title</b> that sounds like it could be real.</li>
    <li>All the titles are mixed up, and everyone <b>votes for the one they think is real</b>.</li>
    <li>Finding the real title: <b>+1000</b>. Every player your fake title fools: <b>+500</b>. The artist gets <b>+500</b> for everyone who found theirs, so draw clearly!</li>
    <li>Got a TV? Open the game on it, choose <b>Use this screen as a TV</b> and enter the room code: it shows the drawings and the reveal for everyone.</li>
  </ol>`;

/** The winner, or everyone tied for first. */
export const winnerHtml = (members: MemberView[]) => {
  const top = ranking(members);
  const best = top[0]?.score ?? 0;
  if (best <= 0) return '';
  const first = top.filter((m) => m.score === best);
  return `<p class="winner">🏆 ${first.map((m) => nameHtml(m.nickname)).join(' & ')}${first.length > 1 ? ' <small>(a tie!)</small>' : ''}</p>`;
};
