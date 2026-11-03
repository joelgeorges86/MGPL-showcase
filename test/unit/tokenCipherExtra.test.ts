import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  getTokenEncryptionKey,
  isTokenEncryptionConfigured,
} from "../../src/lib/tokenCipher";

const HEX_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const BASE64_KEY = Buffer.from(HEX_KEY, "hex").toString("base64");

describe("tokenCipher extra coverage", () => {
  beforeEach(() => {
    process.env.MGPL_TOKEN_ENC_KEY = HEX_KEY;
  });

  afterEach(() => {
    delete process.env.MGPL_TOKEN_ENC_KEY;
  });

  it("accepts a valid 32-byte base64 key", () => {
    process.env.MGPL_TOKEN_ENC_KEY = BASE64_KEY;
    const key = getTokenEncryptionKey();
    expect(key).not.toBeNull();
    expect(key?.length).toBe(32);
    expect(isTokenEncryptionConfigured()).toBe(true);
  });

  it("rejects invalid key material", () => {
    process.env.MGPL_TOKEN_ENC_KEY = "short";
    expect(getTokenEncryptionKey()).toBeNull();
    expect(isTokenEncryptionConfigured()).toBe(false);
  });

  it("throws on malformed IV payloads during decrypt", () => {
    const { tokenEnc } = encryptToken("opaque-token");
    expect(() => decryptToken(tokenEnc, "abcd")).toThrow("Malformed encrypted token payload.");
  });
});
