import { describe, expect, it } from 'vitest';
import { READY_MS, REVEAL } from '../engine/game';
import type { GameView, RoomView } from '../online/types';
import { Director, TICK_FROM_S, type SoundOut } from './director';

const fake = () => {
  const log: string[] = [];
  let track: string | null = null;
  const out: SoundOut = {
    setTrack: (t) => {
      if (t !== track) log.push(`music:${t ?? 'off'}`);
      track = t;
    },
    play: (name, opts) => log.push(opts?.count !== undefined ? `${name}(${opts.count})` : name),
    voters: (n) => log.push(`voters(${n})`),
  };
  return { out, log, take: () => log.splice(0, log.length) };
};

const game = (g: Partial<GameView>): GameView =>
  ({ id: 'g1', status: 'playing', round: 0, rounds: 1, phase: 'draw', step: 0, steps: 3, phaseAt: 0, endsAt: 80_000, reveal: null, gains: null, ...g }) as GameView;
const room = (status: RoomView['status'], g: GameView | null): RoomView => ({ status, game: g }) as RoomView;

describe('the sound director', () => {
  it('plays nothing for what was already going on when the screen opened, just the music', () => {
    const s = fake();
    new Director(s.out).update(room('playing', game({ phase: 'reveal', reveal: [] })), 1000);
    expect(s.log).toEqual([]);
    const t = fake();
    new Director(t.out).update(room('playing', game({ phase: 'draw' })), 1000);
    expect(t.log).toEqual(['music:draw']);
  });

  it('follows a whole drawing: music, the clock, the countdown, the reveal', () => {
    const s = fake();
    const d = new Director(s.out);
    d.update(room('lobby', null), 0);
    expect(s.take()).toEqual(['music:lobby']);

    // Drawing starts: a chime and the drawing music; the clock ticks only in the last 20 s, sharper in the last 5.
    const draw = room('playing', game({ phase: 'draw', endsAt: 80_000 }));
    d.update(draw, 1000);
    expect(s.take()).toEqual(['music:draw', 'chime']);
    for (let t = 1000; t < 80_000; t += 250) d.update(draw, t);
    const ticks = s.take();
    expect(ticks).toHaveLength(TICK_FROM_S);
    expect(ticks.slice(0, 2)).toEqual(['tick', 'tock']);
    expect(ticks.slice(-5)).toEqual(Array(5).fill('tickUrgent'));

    // All drawings in: music stops for the countdown's beeps, then "go" and the writing music.
    const fib = room('playing', game({ phase: 'fib', phaseAt: 80_000, endsAt: 80_000 + READY_MS + 50_000 }));
    for (let t = 80_000; t <= 80_000 + READY_MS + 500; t += 250) d.update(fib, t);
    expect(s.take()).toEqual(['music:off', 'countdown', 'countdown', 'countdown', 'countdown', 'music:fib', 'go']);

    // The vote: a chime and the voting music.
    d.update(room('playing', game({ phase: 'vote', phaseAt: 140_000, endsAt: 165_000 })), 140_000);
    expect(s.take()).toEqual(['music:vote', 'chime']);

    // The reveal: silence, a drum roll, then each title in step with the screen.
    const reveal = room(
      'playing',
      game({
        phase: 'reveal',
        phaseAt: 200_000,
        endsAt: 260_000,
        reveal: [
          { text: 'a', truth: false, authors: [1], voters: [], points: 0 },
          { text: 'b', truth: false, authors: [2], voters: [0, 3], points: 1000 },
          { text: 'c', truth: true, authors: [], voters: [1], points: 500 },
        ],
        gains: [500, 1000, 1000, 0],
      }),
    );
    for (let t = 200_000; t < 245_000; t += 250) d.update(reveal, t);
    expect(s.take()).toEqual([
      'music:off',
      'drumroll',
      'whoosh',
      'nobody',
      'whoosh',
      'voters(2)',
      'fooled',
      'whoosh',
      'voters(1)',
      'truth',
      'scores(3)',
    ]);

    // Game over: a fanfare, and the calm music again.
    d.update(room('finished', game({ status: 'over', phase: 'over' })), 260_000);
    expect(s.take()).toEqual(['music:lobby', 'gameOver']);
  });

  it('times the reveal effects with what the screen shows', () => {
    const s = fake();
    const d = new Director(s.out);
    const r = room('playing', game({ phase: 'reveal', phaseAt: 0, reveal: [{ text: 'c', truth: true, authors: [], voters: [], points: 0 }], gains: [0] }));
    d.update(room('playing', game({ phase: 'vote', step: 0 })), -1);
    s.take();
    d.update(r, 0);
    d.update(r, REVEAL.introMs - 1);
    expect(s.take()).toEqual(['music:off', 'drumroll']);
    d.update(r, REVEAL.introMs);
    expect(s.take()).toEqual(['whoosh']);
    d.update(r, REVEAL.introMs + REVEAL.titleMs);
    expect(s.take()).toEqual(['nobody']);
    d.update(r, REVEAL.introMs + REVEAL.titleMs + REVEAL.votersMs);
    expect(s.take()).toEqual(['truth']);
  });
});
