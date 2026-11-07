import { REVEAL } from '../engine/game';
import type { GameView, MemberView, RevealItem } from '../online/types';
import { facesHtml, fixed, nameHtml, scoreboardHtml, textHtml } from './parts';

/** Where the reveal is, from the time since it began: the same moment on every screen. */
export type Stage = { kind: 'intro' } | { kind: 'item'; k: number; sub: 0 | 1 | 2 } | { kind: 'scores' };

export const revealStage = (game: GameView, serverNow: number): Stage => {
  const items = game.reveal ?? [];
  const t = serverNow - game.phaseAt;
  if (t < REVEAL.introMs) return { kind: 'intro' };
  const k = Math.floor((t - REVEAL.introMs) / REVEAL.perOptionMs);
  if (k >= items.length) return { kind: 'scores' };
  const within = t - REVEAL.introMs - k * REVEAL.perOptionMs;
  return { kind: 'item', k, sub: within < 900 ? 0 : within < 1900 ? 1 : 2 };
};

const names = (seats: number[], members: MemberView[]) => {
  const list = seats.map((s) => members[s]).filter(Boolean).map((m) => nameHtml(m.nickname));
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

const itemHtml = (item: RevealItem, sub: number, game: GameView, members: MemberView[]) => {
  const artist = game.drawing ? members[game.drawing.artist] : undefined;
  const voters = item.voters.length
    ? `${facesHtml(item.voters, members)}<span>${names(item.voters, members)} picked this</span>`
    : '<span>Nobody picked this</span>';
  const verdict = item.truth
    ? `<b>The real title!</b> ${artist ? `${nameHtml(artist.nickname)} drew it` : ''}${item.points ? ` · ${fixed(`+${item.points}`, 'pts')}` : ''}`
    : `<b>A fake</b> by ${names(item.authors, members)}${item.points ? ` · ${fixed(`+${item.points}`, 'pts')}` : ''}`;
  return `<div class="reveal-card ${item.truth ? 'truth' : 'fib'}">
    <p class="reveal-title">“${textHtml(item.text)}”</p>
    <div class="reveal-voters"${sub >= 1 ? '' : ' hidden'}>${voters}</div>
    <p class="reveal-verdict"${sub >= 2 ? '' : ' hidden'}>${verdict}</p>
  </div>`;
};

/** The reveal at a stage: one title at a time (who picked it, who wrote it), then the scores. */
export const revealHtml = (game: GameView, members: MemberView[], stage: Stage, you: string | null = null) => {
  const items = game.reveal ?? [];
  switch (stage.kind) {
    case 'intro':
      return `<div class="reveal-intro"><p>Let’s see who fell for what…</p><p class="muted">${fixed(items.length)} titles</p></div>`;
    case 'item':
      return `<div class="reveal-count">${fixed(`${stage.k + 1} / ${items.length}`)}</div>${itemHtml(items[stage.k], stage.sub, game, members)}`;
    case 'scores':
      return `<div class="reveal-scores"><h3>Scores</h3>${scoreboardHtml(members, game.gains, you)}</div>`;
  }
};

/** What this drawing did for you, in a line. */
export const yourGainLine = (game: GameView) => {
  const you = game.you;
  if (!you || !game.gains) return '';
  const got = game.gains[you.seat] ?? 0;
  const truth = game.reveal?.find((r) => r.truth);
  if (you.artist) return got ? `Your drawing scored ${got.toLocaleString('en')}!` : 'Nobody found your title this time.';
  const found = truth?.voters.includes(you.seat);
  const fooled = (game.reveal ?? []).filter((r) => !r.truth && r.authors.includes(you.seat)).reduce((n, r) => n + r.voters.length, 0);
  const parts = [found ? 'You found the real title' : 'You didn’t find the real title', fooled ? `you fooled ${fooled}` : ''].filter(Boolean);
  return `${parts.join(', ')}${got ? ` · +${got.toLocaleString('en')}` : ''}`;
};
