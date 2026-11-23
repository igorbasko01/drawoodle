import { readyUntil, revealStageAt } from '../engine/game';
import type { GameView, RoomView } from '../online/types';
import type { Effect, Track } from './sound';

/** What the director needs from the sound: a fake one in tests. */
export interface SoundOut {
  setTrack(track: Track | null): void;
  play(name: Effect, opts?: { count?: number }): void;
  voters(count: number): void;
}

/** The clock ticks for the last this many seconds of a timed phase. */
export const TICK_FROM_S = 20;
/** And ticks sharper for the last this many. */
export const URGENT_FROM_S = 5;

/**
 * Decides what to play from the room as it is, at a moment in server time: the music
 * for the phase, the clock in the last seconds, the countdown beeps, and the reveal's
 * effects in step with what the screen shows. Call `update` often (every screen ticks
 * four times a second); each sound plays once, when its moment comes. Nothing plays for
 * what was already happening when the screen opened.
 */
export class Director {
  private primed = false;
  private last = new Map<string, string>();

  constructor(private readonly out: SoundOut) {}

  /** Fires `fn` when the value for `key` changes, except during the very first update (what was already going on). */
  private on(key: string, value: string, fn: () => void) {
    const before = this.last.get(key);
    this.last.set(key, value);
    if (this.primed && before !== value) fn();
  }

  update(room: RoomView | null, serverNow: number) {
    const game: GameView | null = room?.game ?? null;
    const playing = !!room && room.status === 'playing' && !!game;
    const g = playing ? game! : null;
    const until = g ? readyUntil(g) : 0;
    const ready = until > 0 && serverNow < until;

    // Music: a tune for each phase where people are busy, a calm one in the lobby, silence for the reveal.
    let track: Track | null = null;
    if (room && (room.status === 'lobby' || room.status === 'finished')) track = 'lobby';
    if (g && !ready && (g.phase === 'draw' || g.phase === 'fib' || g.phase === 'vote')) track = g.phase;
    this.out.setTrack(track);

    // Something new starts.
    const position = g ? `${g.id}:${g.round}:${g.phase}:${g.step}` : `${room?.status ?? 'none'}:${game?.id ?? ''}`;
    this.on('position', position, () => {
      if (g && (g.phase === 'draw' || g.phase === 'vote' || (g.phase === 'fib' && !ready))) this.out.play('chime');
      if (room?.status === 'finished' && game?.status === 'over') this.out.play('gameOver');
    });

    // The countdown before the first drawing: a beep a second, then "go".
    if (g && g.phase === 'fib' && g.step === 0) {
      const left = ready ? Math.ceil((until - serverNow) / 1000) : 0;
      this.on('countdown', `${position}:${left}`, () => this.out.play(left > 0 ? 'countdown' : 'go'));
    }

    // The clock in the last seconds of a timed phase.
    if (g && !ready && (g.phase === 'draw' || g.phase === 'fib' || g.phase === 'vote')) {
      const left = Math.ceil((g.endsAt - serverNow) / 1000);
      const ticking = left > 0 && left <= TICK_FROM_S;
      this.on('clock', `${position}:${ticking ? left : '-'}`, () => {
        if (ticking) this.out.play(left <= URGENT_FROM_S ? 'tickUrgent' : left % 2 ? 'tock' : 'tick');
      });
    }

    // The reveal, in step with the screen: a drum roll, then for each title a whoosh,
    // who picked it, and who wrote it; then the scores.
    if (g && g.phase === 'reveal' && g.reveal) {
      const stage = revealStageAt(g.reveal.length, serverNow - g.phaseAt);
      const at = stage.kind === 'item' ? `${stage.k}:${stage.sub}` : stage.kind;
      this.on('reveal', `${position}:${at}`, () => {
        if (stage.kind === 'intro') this.out.play('drumroll');
        if (stage.kind === 'scores') this.out.play('scores', { count: (g.gains ?? []).filter((n) => n > 0).length });
        if (stage.kind !== 'item') return;
        const item = g.reveal![stage.k];
        if (stage.sub === 0) this.out.play('whoosh');
        if (stage.sub === 1) {
          if (item.voters.length) this.out.voters(item.voters.length);
          else this.out.play('nobody');
        }
        if (stage.sub === 2) {
          if (item.truth) this.out.play('truth');
          else if (item.voters.length) this.out.play('fooled');
        }
      });
    }
    this.primed = true;
  }
}
