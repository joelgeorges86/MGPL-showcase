import { describe, it, expect } from 'vitest';
import {
  sanitizePrice,
  sanitizeDiscount,
  parseDealRecord,
  parseGiveawayRecord,
  parseDealFeed,
} from '../../src/utils/dealSchema';

const STEAM_URL = 'https://store.steampowered.com/search/?term=Cyberpunk';

describe('dealSchema: price & discount sanitizers', () => {
  it('accepts finite in-bounds prices and rounds to cents', () => {
    expect(sanitizePrice(16.49)).toBe(16.49);
    expect(sanitizePrice('9.99')).toBe(9.99);
    expect(sanitizePrice(0)).toBe(0);
    expect(sanitizePrice(16.496)).toBe(16.5);
  });

  it('rejects negative, overflowing, and non-finite prices', () => {
    expect(sanitizePrice(-5)).toBeNull();
    expect(sanitizePrice(1500)).toBeNull();
    expect(sanitizePrice(Number.NaN)).toBeNull();
    expect(sanitizePrice(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizePrice('')).toBeNull();
  });

  it('bounds discounts to [0, 100]', () => {
    expect(sanitizeDiscount('75.02')).toBe(75);
    expect(sanitizeDiscount(100)).toBe(100);
    expect(sanitizeDiscount(-1)).toBeNull();
    expect(sanitizeDiscount(101)).toBeNull();
  });
});

describe('dealSchema: parseDealRecord', () => {
  it('accepts a well-formed whitelisted deal and strips extraneous keys', () => {
    const deal = parseDealRecord({
      title: 'Cyberpunk 2077',
      store: 'Steam',
      currentPrice: 16.49,
      regularPrice: 59.99,
      discountCut: 72,
      storeUrl: STEAM_URL,
      gameID: '1091500',
      evilInjectedKey: 'drop-me',
    });
    expect(deal).not.toBeNull();
    expect(deal!.store).toBe('Steam');
    expect(deal!.currentPrice).toBe(16.49);
    expect(deal!.storeUrl).toBe(STEAM_URL);
    expect((deal as any).evilInjectedKey).toBeUndefined();
  });

  it('rejects a grey-market store name', () => {
    expect(
      parseDealRecord({ title: 'X', store: 'G2A', currentPrice: 5, storeUrl: STEAM_URL }),
    ).toBeNull();
  });

  it('rejects a grey-market storeUrl even with a valid store name', () => {
    expect(
      parseDealRecord({
        title: 'X',
        store: 'Steam',
        currentPrice: 5,
        storeUrl: 'https://www.g2a.com/phishing-link',
      }),
    ).toBeNull();
  });

  it('rejects a non-whitelisted / non-HTTPS storeUrl', () => {
    expect(
      parseDealRecord({
        title: 'X',
        store: 'Steam',
        currentPrice: 5,
        storeUrl: 'http://store.steampowered.com/app/1',
      }),
    ).toBeNull();
  });

  it('rejects missing required fields and out-of-bounds prices', () => {
    expect(parseDealRecord({})).toBeNull();
    expect(parseDealRecord({ title: 'X', store: 'Steam', currentPrice: -1, storeUrl: STEAM_URL })).toBeNull();
    expect(parseDealRecord(null)).toBeNull();
  });

  it('falls back regularPrice to currentPrice when absent', () => {
    const deal = parseDealRecord({ title: 'X', store: 'Steam', currentPrice: 9.99, storeUrl: STEAM_URL });
    expect(deal!.regularPrice).toBe(9.99);
  });
});

describe('dealSchema: parseGiveawayRecord', () => {
  const GAMERPOWER_URL = 'https://www.gamerpower.com/';

  it('accepts a free whitelisted giveaway', () => {
    const g = parseGiveawayRecord({
      title: 'Free Game',
      storeUrl: GAMERPOWER_URL,
      worth: '$59.99',
      platforms: 'PC, Epic Games Store',
    });
    expect(g).not.toBeNull();
    expect(g!.currentPrice).toBe(0);
    expect(g!.discountCut).toBe(100);
    expect(g!.storeUrl).toBe(GAMERPOWER_URL);
  });

  it('rejects grey-market and non-whitelisted claim URLs', () => {
    expect(parseGiveawayRecord({ title: 'X', storeUrl: 'https://eneba.com/free' })).toBeNull();
    expect(parseGiveawayRecord({ title: 'X', storeUrl: 'https://random-site.example/free' })).toBeNull();
    expect(parseGiveawayRecord({ title: 'X', storeUrl: 'http://www.gamerpower.com/' })).toBeNull();
  });
});

describe('dealSchema: parseDealFeed', () => {
  it('drops rejected records without blocking the feed', () => {
    const feed = parseDealFeed(
      [
        { title: 'Good', store: 'Steam', currentPrice: 10, storeUrl: STEAM_URL },
        { title: 'Bad', store: 'Gamivo', currentPrice: 5, storeUrl: 'https://www.gamivo.com/x' },
        'garbage',
      ],
      parseDealRecord,
    );
    expect(feed.length).toBe(1);
    expect(feed[0].title).toBe('Good');
  });
});
