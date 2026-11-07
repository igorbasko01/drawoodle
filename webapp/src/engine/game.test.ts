import { describe, expect, it } from 'vitest';
import { checkDrawing, simplify } from './drawing';
import { dealPrompts, nextPosition, normalize, optionsFor, POINTS, revealOrder, scoreDrawing, TIMES } from './game';
import { PACKS } from './prompts';

describe('prompts', () => {
  it('deals different prompts to every player in every round', () => {
    for (const pack of Object.values(PACKS)) {
      const dealt = dealPrompts(42, pack.prompts, 3, 8);
      expect(dealt).toHaveLength(3);
      expect(new Set(dealt.flat()).size).toBe(24);
    }
  });
  it('deals the same way from the same seed', () => {
    expect(dealPrompts(7, PACKS.en.prompts, 2, 4)).toEqual(dealPrompts(7, PACKS.en.prompts, 2, 4));
    expect(dealPrompts(7, PACKS.en.prompts, 2, 4)).not.toEqual(dealPrompts(8, PACKS.en.prompts, 2, 4));
  });
});

describe('titles', () => {
  it('compares titles loosely', () => {
    expect(normalize('A Snail, winning   a race!')).toBe(normalize('snail winning a race'));
    expect(normalize('חתול שמנהל בנק')).toBe(normalize('חָתוּל שמנהל בנק!'));
    expect(normalize('Café')).toBe(normalize('cafe'));
  });

  it('merges fibs that read the same and drops ones that are the real title', () => {
    const opts = optionsFor(1, 0, 0, 'A happy cow', [
      { seat: 2, text: 'Angry dog' },
      { seat: 1, text: 'angry  DOG' },
      { seat: 3, text: 'the happy cow' },
      { seat: 0, text: 'artist cannot fib' },
    ]);
    expect(opts).toHaveLength(2);
    const fib = opts.find((o) => !o.truth)!;
    expect(fib.authors).toEqual([1, 2]);
    expect(fib.key).toBe('fib:1');
    expect(fib.text).toBe('angry  DOG');
  });

  it('shuffles the same for everyone', () => {
    const fibs = [1, 2, 3, 4, 5].map((seat) => ({ seat, text: `fib ${seat}` }));
    expect(optionsFor(9, 1, 0, 'truth', fibs)).toEqual(optionsFor(9, 1, 0, 'truth', fibs));
    const positions = new Set([...Array(30).keys()].map((seed) => optionsFor(seed, 0, 0, 'truth', fibs).findIndex((o) => o.truth)));
    expect(positions.size).toBeGreaterThan(3);
  });
});

describe('scoring', () => {
  const options = optionsFor(3, 0, 0, 'A cat', [
    { seat: 1, text: 'A dog' },
    { seat: 2, text: 'A dog' },
    { seat: 3, text: 'A cow' },
  ]);
  it('scores finding the truth, the artist and fooling others', () => {
    const { points, voters } = scoreDrawing(
      options,
      [
        { seat: 1, key: 'truth' },
        { seat: 2, key: 'fib:3' },
        { seat: 3, key: 'fib:1' },
        { seat: 0, key: 'truth' }, // The artist can't vote.
        { seat: 1, key: 'fib:1' }, // Duplicate votes are ignored by the server; here it's an own fib, which never counts.
      ],
      0,
    );
    expect(points[1]).toBe(POINTS.truth + POINTS.fooled);
    expect(points[2]).toBe(POINTS.fooled);
    expect(points[3]).toBe(POINTS.fooled);
    expect(points[0]).toBe(POINTS.artist);
    expect(voters.truth).toEqual([1]);
    expect(revealOrder(options, voters).map((o) => o.key)).toEqual(['fib:1', 'fib:3', 'truth']);
  });
});

describe('flow', () => {
  const ctx = { rounds: 2, drawings: 3, options: 4, pace: 'normal' as const, now: 1000 };
  it('goes draw → fib → vote → reveal for every drawing, then the next round', () => {
    expect(nextPosition({ round: 0, phase: 'draw', step: 0 }, ctx)).toEqual({ round: 0, phase: 'fib', step: 0, endsAt: 1000 + TIMES.normal.fib * 1000 });
    expect(nextPosition({ round: 0, phase: 'fib', step: 1 }, ctx).phase).toBe('vote');
    expect(nextPosition({ round: 0, phase: 'vote', step: 1 }, ctx).phase).toBe('reveal');
    expect(nextPosition({ round: 0, phase: 'reveal', step: 1 }, ctx)).toMatchObject({ phase: 'fib', step: 2 });
    expect(nextPosition({ round: 0, phase: 'reveal', step: 2 }, ctx)).toMatchObject({ round: 1, phase: 'draw', step: 0 });
    expect(nextPosition({ round: 1, phase: 'reveal', step: 2 }, ctx)).toMatchObject({ round: 1, phase: 'over' });
  });
  it('skips a round without drawings', () => {
    expect(nextPosition({ round: 0, phase: 'draw', step: 0 }, { ...ctx, drawings: 0 })).toMatchObject({ round: 1, phase: 'draw' });
  });
});

describe('drawings', () => {
  it('accepts strokes and refuses broken or empty ones', () => {
    expect(checkDrawing({ v: 1, s: [[0, 1, 10, 10, 20, 20]] })).toHaveProperty('drawing');
    expect(checkDrawing({ v: 1, s: [] })).toHaveProperty('problem');
    expect(checkDrawing({ v: 1, s: [[0, 1, 10]] })).toHaveProperty('problem');
    expect(checkDrawing({ v: 1, s: [[0, 1, 10, 2000]] })).toHaveProperty('problem');
    expect(checkDrawing({ v: 1, s: [[99, 1, 10, 10]] })).toHaveProperty('problem');
    expect(checkDrawing('nope')).toHaveProperty('problem');
  });
  it('simplifies close points but keeps the ends', () => {
    expect(simplify([0, 0, 0, 0, 1, 1, 2, 2, 10, 10, 11, 11])).toEqual([0, 0, 0, 0, 10, 10, 11, 11]);
  });
});
