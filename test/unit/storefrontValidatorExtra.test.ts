import { describe, expect, it } from "vitest";
import {
  canonicalDomainForStore,
  canonicalStoreName,
  hostnameOf,
  isGreyMarketUrl,
  isHttps,
  isWhitelistedStoreName,
  isWhitelistedUrl,
  storeUrlForWhitelistedStore,
} from "../../src/utils/storefrontValidator";

describe("storefrontValidator extra coverage", () => {
  it("extracts hostnames from missing-scheme and malformed inputs defensively", () => {
    expect(hostnameOf("store.steampowered.com/app/10")).toBe("store.steampowered.com");
    expect(hostnameOf("not a url")).toBeNull();
    expect(hostnameOf("")).toBeNull();
  });

  it("normalizes alternate display names before whitelist checks", () => {
    expect(canonicalStoreName("fanatical.com")).toBe("Fanatical");
    expect(isWhitelistedStoreName("Epic Games")).toBe(true);
    expect(isWhitelistedStoreName("Epic Games Store")).toBe(true);
  });

  it("rejects non-https and unknown hosts even when syntactically valid", () => {
    expect(isHttps("HTTPS://store.steampowered.com/app/10")).toBe(true);
    expect(isWhitelistedUrl("https://store.steampowered.com.evil.example/app/10")).toBe(false);
    expect(isWhitelistedUrl("ftp://store.steampowered.com/app/10")).toBe(false);
  });

  it("matches grey-market subdomains and locale variants by suffix", () => {
    expect(isGreyMarketUrl("https://de.gamivo.com/item")).toBe(true);
    expect(isGreyMarketUrl("https://store.epicgames.com/en-US/p/game")).toBe(false);
  });

  it("builds canonical URLs for all supported named stores", () => {
    expect(canonicalDomainForStore("Humble Bundle")).toBe("www.humblebundle.com");
    expect(storeUrlForWhitelistedStore("GamerPower", "ignored")).toBe(
      "https://www.gamerpower.com/",
    );
    expect(storeUrlForWhitelistedStore("Gamesplanet", "Elden Ring")).toContain("gamesplanet.com");
  });
});
