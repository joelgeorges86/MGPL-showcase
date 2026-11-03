import { describe, it, expect } from 'vitest';
import {
  normalizeGenre,
  statusBucket,
  valueRating,
  round,
} from '../../src/utils/analyticsMath';

describe('analyticsMath: normalizeGenre', () => {
  it('trims and preserves non-empty labels', () => {
    expect(normalizeGenre('RPG')).toBe('RPG');
    expect(normalizeGenre('  Action RPG  ')).toBe('Action RPG');
  });

  it('maps empty / nullish input to Uncategorized', () => {
    expect(normalizeGenre('')).toBe('Uncategorized');
    expect(normalizeGenre('   ')).toBe('Uncategorized');
    expect(normalizeGenre(null)).toBe('Uncategorized');
    expect(normalizeGenre(undefined)).toBe('Uncategorized');
  });

  it('coerces non-string input defensively', () => {
    expect(normalizeGenre(42)).toBe('42');
  });
});

describe('analyticsMath: statusBucket', () => {
  it('classifies completed variants', () => {
    for (const s of ['Completed', 'finished', '100%', 'BEATEN', 'Cleared']) {
      expect(statusBucket(s)).toBe('completed');
    }
  });

  it('classifies in-progress variants (including substring matches)', () => {
    for (const s of ['in progress', 'Playing', 'Started', 'Replaying', 'Not Started']) {
      expect(statusBucket(s)).toBe('inProgress');
    }
  });

  it('defaults unknown / nullish statuses to unplayed', () => {
    for (const s of ['Backlog', 'Wishlist', 'Owned', '', null, undefined]) {
      expect(statusBucket(s)).toBe('unplayed');
    }
  });
});

describe('analyticsMath: valueRating', () => {
  it('marks unpriced games as Free/Unpriced', () => {
    expect(valueRating(null)).toBe('Free/Unpriced');
  });

  it('applies the correct thresholds at and below boundaries', () => {
    expect(valueRating(0)).toBe('Excellent');
    expect(valueRating(0.49)).toBe('Excellent');
    expect(valueRating(0.5)).toBe('Good');
    expect(valueRating(0.99)).toBe('Good');
    expect(valueRating(1.0)).toBe('Fair');
    expect(valueRating(2.49)).toBe('Fair');
    expect(valueRating(2.5)).toBe('Poor');
    expect(valueRating(50)).toBe('Poor');
  });
});

describe('analyticsMath: round', () => {
  it('rounds to the requested number of decimals', () => {
    expect(round(16.496, 2)).toBe(16.5);
    expect(round(16.496, 1)).toBe(16.5);
    expect(round(10.555, 2)).toBe(10.56);
    expect(round(7, 2)).toBe(7);
  });

  it('guards against NaN / nullish input', () => {
    expect(round(Number.NaN)).toBe(0);
    expect(round(Number.POSITIVE_INFINITY)).toBe(Infinity); // preserved (not NaN)
    expect(round(null as unknown as number)).toBe(0);
    expect(round(undefined as unknown as number)).toBe(0);
  });
});
