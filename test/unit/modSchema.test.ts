import { describe, it, expect } from 'vitest';
import {
  sanitizeModDescription,
  maskModAuthorHandle,
  sanitizeVersionTag,
  validateModMetadata,
} from '../../src/utils/modSchema';

describe('modSchema: sanitizeModDescription', () => {
  it('strips HTML tags and event handlers', () => {
    // Tags are replaced with spaces; inline text between open/close tags
    // remains as inert plain text (never executable).
    expect(sanitizeModDescription('<script>alert(1)</script>Hello <b>World</b>')).toBe('alert(1) Hello World');
    expect(sanitizeModDescription('x<img src=x onerror=alert(1)>y')).toBe('x y');
  });

  it('neutralizes dangerous URI schemes', () => {
    expect(sanitizeModDescription('click javascript:alert(1) here')).toBe('click alert(1) here');
  });

  it('returns null for empty input', () => {
    expect(sanitizeModDescription('   ')).toBeNull();
    expect(sanitizeModDescription(null)).toBeNull();
    expect(sanitizeModDescription(undefined)).toBeNull();
  });
});

describe('modSchema: maskModAuthorHandle', () => {
  it('masks handles with first/last char convention', () => {
    expect(maskModAuthorHandle('yamashi')).toBe('y••••i');
    // '@' prefix stripped; 10-char handle masks to 4 bullets (max cap).
    expect(maskModAuthorHandle('@skyui_team')).toBe('s••••m');
  });

  it('fully masks short handles', () => {
    expect(maskModAuthorHandle('ab')).toBe('••••');
  });

  it('returns null for empty/missing values', () => {
    expect(maskModAuthorHandle(null)).toBeNull();
    expect(maskModAuthorHandle('')).toBeNull();
  });
});

describe('modSchema: sanitizeVersionTag', () => {
  it('accepts safe slug versions', () => {
    expect(sanitizeVersionTag('1.2.3-beta')).toBe('1.2.3-beta');
    expect(sanitizeVersionTag('v2.0.1_SE')).toBe('v2.0.1_SE');
  });

  it('rejects unsafe charsets', () => {
    expect(sanitizeVersionTag('<script>')).toBeNull();
    expect(sanitizeVersionTag('1.0 "quote"')).toBeNull();
  });
});

describe('modSchema: validateModMetadata', () => {
  it('coerces negatives to zero and masks handles', () => {
    const meta = validateModMetadata({
      download_count: -5,
      active_installs: '3',
      rating_count: 100,
      version_tag: 'v1',
      author_handle: '@yamashi',
      description: '<b>cool</b> mod',
    });
    expect(meta.downloadCount).toBe(0);
    expect(meta.activeInstalls).toBe(3);
    expect(meta.ratingCount).toBe(100);
    expect(meta.versionTag).toBe('v1');
    expect(meta.authorHandle).toBe('y••••i');
    expect(meta.description).toBe('cool mod');
  });

  it('never throws on malformed input', () => {
    const meta = validateModMetadata(null);
    expect(meta.downloadCount).toBe(0);
    expect(meta.authorHandle).toBeNull();
    expect(meta.description).toBeNull();
  });
});
