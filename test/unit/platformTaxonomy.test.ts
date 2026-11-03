import { describe, it, expect } from 'vitest';
import { CANONICAL_PLATFORMS, normalizePlatform, isCanonicalPlatform } from '../../src/lib/platformTaxonomy';

describe('platformTaxonomy: normalizePlatform', () => {
  it('resolves storefront labels to canonical PC', () => {
    expect(normalizePlatform('steam')).toBe('PC');
    expect(normalizePlatform('GOG')).toBe('PC');
    expect(normalizePlatform('epic games')).toBe('PC');
    expect(normalizePlatform('itch.io')).toBe('PC');
    expect(normalizePlatform('battlenet')).toBe('PC');
  });

  it('resolves console families (en-dash taxonomy preserved)', () => {
    expect(normalizePlatform('ps5')).toBe('Console – PlayStation');
    expect(normalizePlatform('playstation 4')).toBe('Console – PlayStation');
    expect(normalizePlatform('xbox one x')).toBe('Console – Xbox');
    expect(normalizePlatform('switch')).toBe('Console – Nintendo');
  });

  it('resolves mobile and cloud families', () => {
    expect(normalizePlatform('ios')).toBe('Mobile – iOS');
    expect(normalizePlatform('android')).toBe('Mobile – Android');
    expect(normalizePlatform('geforce now')).toBe('Cloud');
    expect(normalizePlatform('xbox cloud gaming')).toBe('Cloud');
  });

  it('returns null for unclassifiable input and never throws', () => {
    expect(normalizePlatform(null)).toBeNull();
    expect(normalizePlatform(undefined)).toBeNull();
    expect(normalizePlatform('')).toBeNull();
    expect(normalizePlatform('random gizmo')).toBeNull();
  });

  it('returns canonical casing for exact case-insensitive matches', () => {
    expect(normalizePlatform('PC')).toBe('PC');
    expect(normalizePlatform('pc')).toBe('PC');
  });

  it('exposes the canonical platform list', () => {
    expect(CANONICAL_PLATFORMS).toHaveLength(7);
    expect(isCanonicalPlatform('PC')).toBe(true);
    expect(isCanonicalPlatform('pc')).toBe(false); // exact casing required
    expect(isCanonicalPlatform('nonsense')).toBe(false);
  });
});
