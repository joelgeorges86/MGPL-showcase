import { describe, it, expect } from 'vitest';
import {
  canonicalStoreName,
  isWhitelistedStoreName,
  isGreyMarketUrl,
  isHttps,
  isWhitelistedUrl,
  canonicalDomainForStore,
  storeUrlForWhitelistedStore,
} from '../../src/utils/storefrontValidator';

describe('storefrontValidator: store name normalization', () => {
  it('maps aliases to canonical display names', () => {
    expect(canonicalStoreName('green man gaming')).toBe('Green Man Gaming');
    expect(canonicalStoreName('greenmangaming')).toBe('Green Man Gaming');
    expect(canonicalStoreName('epic games store')).toBe('Epic Games');
    expect(canonicalStoreName('humble bundle')).toBe('Humble Store');
    expect(canonicalStoreName('GOG')).toBe('GOG');
    expect(canonicalStoreName('Steam')).toBe('Steam');
  });

  it('validates store names against the allowlist', () => {
    expect(isWhitelistedStoreName('Steam')).toBe(true);
    expect(isWhitelistedStoreName('Fanatical')).toBe(true);
    expect(isWhitelistedStoreName('Gamivo')).toBe(false);
    expect(isWhitelistedStoreName('')).toBe(false);
  });
});

describe('storefrontValidator: URL gating', () => {
  it('rejects grey-market domains by suffix', () => {
    expect(isGreyMarketUrl('https://www.g2a.com/deal')).toBe(true);
    expect(isGreyMarketUrl('https://kinguin.net/x')).toBe(true);
    expect(isGreyMarketUrl('https://store.steampowered.com/app/1')).toBe(false);
  });

  it('requires HTTPS', () => {
    expect(isHttps('https://store.steampowered.com/app/1')).toBe(true);
    expect(isHttps('http://store.steampowered.com/app/1')).toBe(false);
  });

  it('enforces exact hostname whitelist for whitelisted URLs', () => {
    expect(isWhitelistedUrl('https://store.steampowered.com/app/1091500')).toBe(true);
    expect(isWhitelistedUrl('https://www.fanatical.com/en/search?search=x')).toBe(true);
    // Exact-match: arbitrary subdomain of an allowed registrable domain is NOT allowed
    expect(isWhitelistedUrl('https://evil.steampowered.com/phish')).toBe(false);
    // Grey-market always rejected even when HTTPS
    expect(isWhitelistedUrl('https://www.g2a.com/phishing')).toBe(false);
  });

  it('maps canonical stores to their canonical domain', () => {
    expect(canonicalDomainForStore('Steam')).toBe('store.steampowered.com');
    expect(canonicalDomainForStore('Green Man Gaming')).toBe('www.greenmangaming.com');
    expect(canonicalDomainForStore('Unknown Store')).toBeNull();
  });

  it('builds direct storefront search URLs (no third-party redirects)', () => {
    expect(storeUrlForWhitelistedStore('Steam', 'Cyberpunk 2077')).toBe(
      'https://store.steampowered.com/search/?term=Cyberpunk%202077',
    );
    expect(storeUrlForWhitelistedStore('GOG', 'Witcher 3')).toContain('www.gog.com');
    expect(storeUrlForWhitelistedStore('Unknown', 'X')).toBe('https://store.steampowered.com/search/');
  });
});
