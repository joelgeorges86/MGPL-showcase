import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as tokenCipher from '../../src/lib/tokenCipher';

const TEST_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('tokenCipher: AES-256-GCM at-rest token vault', () => {
  beforeAll(() => {
    process.env.MGPL_TOKEN_ENC_KEY = TEST_KEY;
  });

  afterAll(() => {
    delete process.env.MGPL_TOKEN_ENC_KEY;
  });

  it('reports encryption configured when the key is present', () => {
    expect(tokenCipher.isTokenEncryptionConfigured()).toBe(true);
  });

  it('round-trips a token through encrypt/decrypt', () => {
    const { tokenEnc, tokenIv } = tokenCipher.encryptToken('psn-np-token-value');
    expect(tokenEnc).toBeTruthy();
    expect(tokenIv).toBeTruthy();
    expect(tokenCipher.decryptToken(tokenEnc, tokenIv)).toBe('psn-np-token-value');
  });

  it('produces unique ciphertext per call (random IV)', () => {
    const a = tokenCipher.encryptToken('same-value');
    const b = tokenCipher.encryptToken('same-value');
    expect(a.tokenEnc).not.toBe(b.tokenEnc);
  });

  it('throws on tampered ciphertext (GCM auth tag check)', () => {
    const { tokenEnc, tokenIv } = tokenCipher.encryptToken('secret');
    const tampered = tokenEnc.slice(0, -4) + 'AAAA';
    expect(() => tokenCipher.decryptToken(tampered, tokenIv)).toThrow();
  });

  it('throws on malformed payloads', () => {
    expect(() => tokenCipher.decryptToken('', '')).toThrow();
    expect(() => tokenCipher.encryptToken('')).toThrow();
  });

  it('fails closed when the encryption key is missing', () => {
    const previous = process.env.MGPL_TOKEN_ENC_KEY;
    delete process.env.MGPL_TOKEN_ENC_KEY;
    expect(tokenCipher.isTokenEncryptionConfigured()).toBe(false);
    expect(() => tokenCipher.encryptToken('plaintext')).toThrow(/MGPL_TOKEN_ENC_KEY/);
    process.env.MGPL_TOKEN_ENC_KEY = previous;
  });
});
