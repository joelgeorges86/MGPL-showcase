import { describe, it, expect, vi, afterEach } from "vitest";
import * as https from "node:https";
import { BlockList } from "node:net";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  createGuardedFetcher,
  createGuardedLookup,
  isBlockedAddress,
  checkGuardPlatform,
  checkTargetUrl,
  parseRetryAfter,
  GUARD_LIMITS,
  MAX_NOT_BEFORE,
} from "../../src/utils/guardedFetch";
import type { GuardDeps, NotBefore } from "../../src/utils/guardedFetch";
import { guardPolicy, transportHarness, FIXTURE_NOW } from "../helpers/evidenceFixtures";
import type { Reply } from "../helpers/evidenceFixtures";
vi.mock("node:https", () => ({ request: vi.fn() }));
const url = "https://api.fixture.test/lookup";
const now = FIXTURE_NOW.getTime();
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function one(
  reply: Reply,
  policy = guardPolicy(),
  addresses?: Array<{ address: string; family: 4 | 6 }>,
) {
  const h = transportHarness([reply], addresses);
  const f = createGuardedFetcher(policy, h.deps);
  const result = await f.getJson(url);
  return { h, f, result };
}
describe("guard platform, policy and address checks", () => {
  it("CX-17f construction pins Node 22 and platform facts", () => {
    expect(checkGuardPlatform()).toBe(true);
    for (const v of ["21.9.0", "23.0.0"]) expect(checkGuardPlatform(v)).toBe(false);
    for (const v of ["22.22.0", "22.23.2"]) expect(checkGuardPlatform(v)).toBe(true);
    const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { value: "23.0.0", configurable: true });
    try {
      expect(() => createGuardedFetcher(guardPolicy())).toThrow("platform_unverified");
    } finally {
      Object.defineProperty(process.versions, "node", original);
    }
  });
  it("rejects invalid policies and malformed persisted cooldown seeds", () => {
    const cases = [
      null,
      {},
      guardPolicy({ hosts: [] }),
      guardPolicy({ paths: [] }),
      guardPolicy({ paths: ["bad"] }),
      guardPolicy({ acceptedMediaTypes: [] }),
      guardPolicy({ acceptedMediaTypes: ["Application/JSON"] }),
      guardPolicy({ minIntervalMs: -1 }),
      guardPolicy({ userAgent: "bad\n" }),
      guardPolicy({ limits: { timeoutMs: 16000 } }),
      guardPolicy({ limits: { maxAttempts: 0 } }),
      guardPolicy({ limits: { bogus: 1 } as any }),
      guardPolicy({ limits: JSON.parse('{"constructor":1}') }),
      guardPolicy({ limits: JSON.parse('{"__proto__":1}') }),
    ];
    for (const p of cases) expect(() => createGuardedFetcher(p as any)).toThrow("invalid_policy");
    for (const hosts of [
      ["*.fixture.test"],
      ["UPPER.fixture.test"],
      ["api.fixture.test."],
      ["127.0.0.1"],
      ["localhost"],
      ["-api.fixture.test"],
    ])
      expect(() => createGuardedFetcher({ ...guardPolicy(), hosts })).toThrow("invalid_policy");
    for (const notBefore of [
      "soon",
      { kind: "until", at: "soon" },
      { kind: "until", at: "10000-01-01T00:00:00Z" },
      { kind: "until", at: "2026-02-30T00:00:00Z" },
      { kind: "forever" },
      { kind: "indefinite", at: "x" },
      "indefinite",
      42,
    ])
      expect(() => createGuardedFetcher(guardPolicy(), { notBefore } as any)).toThrow(
        "invalid_policy",
      );
  });
  it("CX-17g registry snapshot table tests first/middle/last of every special-purpose entry", () => {
    // IANA registry snapshot, 2026-10-22: CIDR, expected blocked; mapped/translation blocks use embedded IPv4 policy.
    const v4: Array<[string, number, boolean]> = [
      ["0.0.0.0", 8, true],
      ["0.0.0.0", 32, true],
      ["10.0.0.0", 8, true],
      ["100.64.0.0", 10, true],
      ["127.0.0.0", 8, true],
      ["169.254.0.0", 16, true],
      ["172.16.0.0", 12, true],
      ["192.0.0.0", 24, true],
      ["192.0.0.0", 29, true],
      ["192.0.0.8", 32, true],
      ["192.0.0.9", 32, true],
      ["192.0.0.10", 32, true],
      ["192.0.0.170", 32, true],
      ["192.0.0.171", 32, true],
      ["192.0.2.0", 24, true],
      ["192.31.196.0", 24, false],
      ["192.52.193.0", 24, false],
      ["192.88.99.0", 24, true],
      ["192.88.99.2", 32, true],
      ["192.168.0.0", 16, true],
      ["192.175.48.0", 24, false],
      ["198.18.0.0", 15, true],
      ["198.51.100.0", 24, true],
      ["203.0.113.0", 24, true],
      ["240.0.0.0", 4, true],
      ["255.255.255.255", 32, true],
    ];
    const v6: Array<[string, number, boolean]> = [
      ["::", 128, true],
      ["::1", 128, true],
      ["64:ff9b:1::", 48, true],
      ["100::", 64, true],
      ["100:0:0:1::", 64, true],
      ["2001::", 23, true],
      ["2001::", 32, true],
      ["2001:1::1", 128, true],
      ["2001:1::2", 128, true],
      ["2001:1::3", 128, true],
      ["2001:2::", 48, true],
      ["2001:3::", 32, true],
      ["2001:4:112::", 48, true],
      ["2001:10::", 28, true],
      ["2001:20::", 28, true],
      ["2001:30::", 28, true],
      ["2001:db8::", 32, true],
      ["2002::", 16, true],
      ["2620:4f:8000::", 48, false],
      ["3fff::", 20, true],
      ["5f00::", 16, true],
      ["fc00::", 7, true],
      ["fe80::", 10, true],
    ];
    const number4 = (a: string) => a.split(".").reduce((n, p) => (n << 8n) + BigInt(p), 0n);
    const number6 = (a: string) => {
      const [l, r] = a.split("::");
      const left = l ? l.split(":") : [],
        right = r ? r.split(":") : [];
      return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].reduce(
        (n, p) => (n << 16n) + BigInt("0x" + p),
        0n,
      );
    };
    for (const [table, bits] of [
      [v4, 32],
      [v6, 128],
    ] as const)
      for (const [a, prefix, blocked] of table) {
        const start = bits === 32 ? number4(a) : number6(a),
          size = 1n << BigInt(bits - prefix);
        for (const n of [start, start + (size - 1n) / 2n, start + size - 1n]) {
          const address =
            bits === 32
              ? [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n)).join(".")
              : Array.from({ length: 8 }, (_, i) =>
                  ((n >> BigInt((7 - i) * 16)) & 65535n).toString(16),
                ).join(":");
          expect(isBlockedAddress(address), a + "/" + prefix + " " + address).toBe(blocked);
        }
      }
    for (const a of [
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "0:0:0:0:0:ffff:0808:0808",
      "64:ff9b::808:808",
      "2001:4860:4860::8888",
      "2a00:1450:4001::1",
      "2620:4f:8000::1",
      "2001:200::1",
      "192.31.196.1",
    ])
      expect(isBlockedAddress(a), a).toBe(false);
    for (const a of [
      "::ffff:10.0.0.1",
      "::FFFF:169.254.169.254",
      "64:ff9b::a00:1",
      "64:ff9b:1::808:808",
      "ff02::1",
      "fec0::1",
      "::2",
      "4000::1",
      "",
      "not-an-ip",
      "fe80::1%eth0",
      "224.0.0.1",
    ])
      expect(isBlockedAddress(a), a).toBe(true);
    // Whole mapped/translation ranges are intentionally conditional, not uniformly blocked.
    for (const prefix of ["::ffff:", "64:ff9b::"])
      for (const tail of ["0:0", "7fff:ffff", "ffff:ffff"])
        expect(isBlockedAddress(prefix + tail)).toBe(true);
  });
  it("real BlockList malformed input and mapped-prefix hazards are pinned", () => {
    const b = new BlockList();
    b.addSubnet("::ffff:0:0", 96, "ipv6");
    expect(b.check("8.8.8.8", "ipv4")).toBe(true);
    expect(b.check("not-an-ip", "ipv4")).toBe(false);
  });
  it("CX-17 target preflight has zero requests, lookups, connects and bytes", async () => {
    const cases: Array<[string, string]> = [
      ["bad", "url_rejected"],
      ["http://api.fixture.test/lookup", "url_rejected"],
      ["https://u:p@api.fixture.test/lookup", "url_rejected"],
      ["https://api.fixture.test:8443/lookup", "url_rejected"],
      [url + "#x", "url_rejected"],
      ["https://2130706433/", "url_rejected"],
      ["https://[::1]/", "url_rejected"],
      ["https://api.fixture.test./lookup", "host_not_permitted"],
      ["https://api.fixture.test.evil.test/lookup", "host_not_permitted"],
      ["https://api.fixture.test/other", "path_not_permitted"],
      [url + "?" + "x".repeat(2048), "url_rejected"],
    ];
    for (const [raw, code] of cases) {
      const h = transportHarness();
      const f = createGuardedFetcher(guardPolicy(), h.deps);
      expect(await f.getJson(raw)).toEqual({
        ok: false,
        code,
        retryable: false,
        attempts: 0,
        status: null,
        host: null,
        notBefore: null,
      });
      expect(h.counters).toMatchObject({
        requests: 0,
        lookups: 0,
        resolves: 0,
        connects: 0,
        bytes: 0,
      });
    }
    expect(checkTargetUrl("https://api.fixture.test:443/lookup", guardPolicy()).ok).toBe(true);
    expect(checkTargetUrl("https://api.fixture.test/a/../lookup", guardPolicy()).ok).toBe(true);
  });
});
describe("connection binding and rejection layers", () => {
  it("CX-17a blocked/mixed answers never connect, DNS failures retry with exact layer counters", async () => {
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.1",
      "100.100.100.200",
      "fd00:ec2::254",
      "::ffff:127.0.0.1",
      "fe80::1%eth0",
      "not-an-ip",
    ]) {
      const { h, f, result } = await one({}, guardPolicy(), [
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      expect(result).toMatchObject({ ok: false, code: "address_blocked", attempts: 1 });
      expect(f.stopped).toBe(true);
      expect(h.counters).toMatchObject({
        requests: 1,
        lookups: 1,
        resolves: 1,
        connects: 0,
        bytes: 0,
      });
    }
    const mixed = await one({}, guardPolicy(), [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    expect(mixed.result).toMatchObject({ code: "address_blocked" });
    expect(mixed.h.counters.connects).toBe(0);
    for (const answer of [[], new Error("fixture")]) {
      const h = transportHarness();
      h.answers.splice(0, 1, answer);
      expect(await createGuardedFetcher(guardPolicy(), h.deps).getJson(url)).toMatchObject({
        code: "dns_failed",
        attempts: 3,
        retryable: true,
      });
      expect(h.counters).toMatchObject({
        requests: 3,
        lookups: 3,
        resolves: 3,
        connects: 0,
        bytes: 0,
      });
    }
    for (const addresses of [
      [{ address: "8.8.8.8", family: 4 as const }],
      [{ address: "2606:4700::1", family: 6 as const }],
      [
        { address: "8.8.8.8", family: 4 as const },
        { address: "2606:4700::1", family: 6 as const },
      ],
    ])
      expect((await one({}, guardPolicy(), addresses)).result.ok).toBe(true);
  });
  it("guarded lookup honors all:false and rejects wrong family", async () => {
    const validated: string[][] = [];
    const fn = createGuardedLookup(
      async () => [{ address: "8.8.8.8", family: 4 }],
      (a) => validated.push([...a]),
    );
    expect(await new Promise((r) => fn("api.fixture.test", {}, (...args) => r(args)))).toEqual([
      null,
      "8.8.8.8",
      4,
    ]);
    expect(validated).toEqual([["8.8.8.8"]]);
    const wrong = createGuardedLookup(
      async () => [{ address: "8.8.8.8", family: 6 }],
      () => {},
    );
    expect(
      await new Promise((r) => wrong("api.fixture.test", { all: true }, (e) => r(e.code))),
    ).toBe("address_blocked");
  });
  it("CX-17b rebinding validates once on every attempt", async () => {
    const h = transportHarness([{ status: 503 }]);
    h.answers.splice(
      0,
      1,
      [{ address: "8.8.8.8", family: 4 }],
      [{ address: "10.0.0.1", family: 4 }],
      [{ address: "1.1.1.1", family: 4 }],
    );
    const f = createGuardedFetcher(guardPolicy(), h.deps);
    expect(await f.getJson(url)).toMatchObject({ code: "address_blocked", attempts: 2 });
    expect(h.counters).toMatchObject({
      requests: 2,
      resolves: 2,
      lookups: 2,
      connects: 1,
      bytes: 1,
    });
    expect(f.stopped).toBe(true);
  });
  it("CX-17c peer mismatch stops at connect before HTTP bytes", async () => {
    for (const reply of [{ peer: "1.1.1.1" }, { port: 8443 }, { peer: null }]) {
      const { h, f, result } = await one(reply);
      expect(result).toMatchObject({ code: "destination_unverified", attempts: 1 });
      expect(h.counters).toMatchObject({
        requests: 1,
        resolves: 1,
        lookups: 1,
        connects: 1,
        bytes: 0,
        reads: 0,
      });
      expect(f.stopped).toBe(true);
    }
    expect((await one({ peer: "::ffff:8.8.8.8" })).result.ok).toBe(true);
    expect(
      (
        await one({ peer: "2606:4700:0:0:0:0:0:1" }, guardPolicy(), [
          { address: "2606:4700::1", family: 6 },
        ])
      ).result.ok,
    ).toBe(true);
  });
  it("CX-17d response bypass never accepts or reads body; double lookup fails before connect", async () => {
    for (const reply of [
      { skipLookup: true },
      { skipConnect: true },
      { responsePeer: "1.1.1.1" },
    ]) {
      const { h, f, result } = await one(reply);
      expect(result).toMatchObject({ code: "destination_unverified", attempts: 1 });
      expect(h.counters.reads).toBe(0);
      expect(h.counters.requests).toBe(1);
      expect(f.stopped).toBe(true);
    }
    const { h, result } = await one({ doubleLookup: true });
    expect(result).toMatchObject({ code: "destination_unverified" });
    expect(h.counters).toMatchObject({
      requests: 1,
      resolves: 1,
      lookups: 2,
      connects: 0,
      bytes: 0,
    });
  });
  it("CX-17e default transport exact options forbid proxy/TLS bypass and credentials", async () => {
    const h = transportHarness();
    const spy = vi.mocked(https.request).mockImplementation(h.deps.request!);
    const { request: _, ...deps } = h.deps;
    const f = createGuardedFetcher(guardPolicy(), deps);
    expect((await f.getJson(url + "?fixture=1")).ok).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(h.counters.options[0]).toEqual({
      method: "GET",
      host: "api.fixture.test",
      port: 443,
      path: "/lookup?fixture=1",
      lookup: expect.any(Function),
      agent: false,
      rejectUnauthorized: true,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": "MGPL fixture",
      },
    });
  });
  it("CX-18 rejects every redirect without inspecting Location or reading the body", async () => {
    for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399])
      for (const location of [url, "http://169.254.169.254/"]) {
        const { h, result } = await one({ status, headers: { location } });
        expect(result).toMatchObject({
          code: "redirect_rejected",
          attempts: 1,
          status,
          retryable: false,
        });
        expect(h.counters).toMatchObject({ requests: 1, resolves: 1, connects: 1, reads: 0 });
      }
  });
});
describe("status, queue, cooldown and circuit state", () => {
  it("CX-19 status matrix, resets and stopped precedence", async () => {
    for (const [status, code] of [
      [400, "bad_request"],
      [401, "access_denied"],
      [403, "access_denied"],
      [404, "not_found"],
      [410, "not_found"],
      [201, "unexpected_status"],
      [418, "unexpected_status"],
      [501, "unexpected_status"],
    ] as const) {
      const { f, result } = await one({ status });
      expect(result).toMatchObject({ code, attempts: 1, status, retryable: false });
      if (code === "access_denied")
        expect(await f.getJson(url)).toMatchObject({ code: "stopped", attempts: 0 });
    }
    for (const status of [429, 500, 502, 503, 504]) {
      const { result } = await one({ status });
      expect(result).toMatchObject({
        code: status === 429 ? "throttled" : "upstream_unavailable",
        attempts: 3,
        notBefore: null,
        retryable: true,
      });
    }
    const h = transportHarness([{ status: 503 }]);
    const f = createGuardedFetcher(guardPolicy(), h.deps);
    for (let i = 0; i < 3; i++)
      expect(await f.getJson(url)).toMatchObject({ code: "upstream_unavailable", attempts: 3 });
    expect(f.stopped).toBe(true);
    expect(await f.getJson(url)).toMatchObject({ code: "stopped", attempts: 0 });
    const resets = transportHarness([
      { status: 503 },
      { status: 404 },
      { status: 503 },
      { status: 200 },
      { status: 503 },
    ]);
    const r = createGuardedFetcher(
      guardPolicy({ limits: { maxAttempts: 1, maxConsecutiveTransientFailures: 2 } }),
      resets.deps,
    );
    for (let i = 0; i < 5; i++) await r.getJson(url);
    expect(r.stopped).toBe(false);
  });
  it("CX-19a in-call Retry-After and CX-21 serialization enforce request spacing", async () => {
    const h = transportHarness([{ status: 429, headers: { "retry-after": "2" } }, {}]);
    const f = createGuardedFetcher(guardPolicy({ minIntervalMs: 1000 }), h.deps);
    const [first, second] = await Promise.all([f.getJson(url), f.getJson(url)]);
    expect(first).toMatchObject({ ok: true, attempts: 2 });
    expect(second.ok).toBe(true);
    expect(h.counters.starts).toEqual([now, now + 2000, now + 3000]);
    expect(f.notBefore).toEqual({ kind: "until", at: "2026-10-22T12:00:02Z" });
  });
  it("CX-19b long hint survives queued calls and later resumes", async () => {
    const h = transportHarness([{ status: 429, headers: { "retry-after": "3600" } }, {}]);
    const f = createGuardedFetcher(guardPolicy(), h.deps);
    const [first, second] = await Promise.all([f.getJson(url), f.getJson(url)]);
    const notBefore = { kind: "until", at: "2026-10-22T13:00:00Z" };
    expect(first).toEqual({
      ok: false,
      code: "throttled",
      attempts: 1,
      status: 429,
      retryable: true,
      host: "api.fixture.test",
      notBefore,
    });
    expect(second).toEqual({
      ok: false,
      code: "cooling_down",
      attempts: 0,
      status: null,
      retryable: true,
      host: "api.fixture.test",
      notBefore,
    });
    expect(h.counters.requests).toBe(1);
    h.advance(3600000);
    expect((await f.getJson(url)).ok).toBe(true);
    expect(h.counters.starts[1]).toBe(now + 3600000);
  });
  it("CX-19c/d final-attempt hints constrain the next queued call", async () => {
    for (const seconds of [30, 61]) {
      const h = transportHarness([
        { status: 503 },
        { status: 503 },
        { status: 503, headers: { "retry-after": String(seconds) } },
        {},
      ]);
      const f = createGuardedFetcher(guardPolicy({ minIntervalMs: 3000 }), h.deps);
      const [first, second] = await Promise.all([f.getJson(url), f.getJson(url)]);
      expect(first).toMatchObject({
        code: "upstream_unavailable",
        attempts: 3,
        notBefore: {
          kind: "until",
          at: new Date(h.counters.starts[2] + seconds * 1000).toISOString().replace(".000Z", "Z"),
        },
      });
      if (seconds === 30) {
        expect(second.ok).toBe(true);
        expect(h.counters.starts[3] - h.counters.starts[2]).toBe(30000);
      } else {
        expect(second).toMatchObject({ code: "cooling_down", attempts: 0 });
        expect(h.counters.requests).toBe(3);
      }
    }
  });
  it("CX-19e valid HTTP dates, ignored hints and backoff", async () => {
    for (const header of [
      "Thu, 22 Oct 2026 12:00:02 GMT",
      "Thursday, 22-Oct-26 12:00:02 GMT",
      "Thu Oct 22 12:00:02 2026",
    ]) {
      const h = transportHarness([{ status: 503, headers: { "retry-after": header } }, {}]);
      const f = createGuardedFetcher(guardPolicy(), h.deps);
      expect((await f.getJson(url)).ok).toBe(true);
      expect(h.counters.starts).toEqual([now, now + 2000]);
    }
    for (const header of ["soon", "-5", "1.5", ""]) {
      const h = transportHarness([{ status: 503, headers: { "retry-after": header } }, {}]);
      await createGuardedFetcher(guardPolicy(), h.deps).getJson(url);
      expect(h.counters.starts).toEqual([now, now + 1000]);
    }
    for (const status of [200, 404]) {
      const { f } = await one({ status, headers: { "retry-after": "3600" } });
      expect(f.notBefore).toBeNull();
    }
    const h = transportHarness([
      { status: 503, headers: { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" } },
      {},
    ]);
    const f = createGuardedFetcher(guardPolicy(), h.deps);
    await f.getJson(url);
    expect(f.notBefore).toBeNull();
    expect(h.counters.starts).toEqual([now, now]);
  });
  it("CX-19f cooldown results neither count nor reset transient failures, persisted seed honored", async () => {
    const h = transportHarness([{ status: 503, headers: { "retry-after": "3600" } }]);
    const f = createGuardedFetcher(guardPolicy({ limits: { maxAttempts: 1 } }), h.deps);
    await f.getJson(url);
    for (let i = 0; i < 2; i++)
      expect(await f.getJson(url)).toMatchObject({ code: "cooling_down" });
    expect(f.stopped).toBe(false);
    const restart = transportHarness();
    const g = createGuardedFetcher(guardPolicy(), {
      ...restart.deps,
      notBefore: JSON.parse(JSON.stringify(f.notBefore)),
    });
    expect(await g.getJson(url)).toMatchObject({ code: "cooling_down", attempts: 0 });
    expect(restart.counters.requests).toBe(0);
    h.advance(3600000);
    await f.getJson(url);
    h.advance(3600000);
    await f.getJson(url);
    expect(f.stopped).toBe(true);
    expect(await f.getJson(url)).toMatchObject({ code: "stopped", notBefore: { kind: "until" } });
  });
  it("CX-19g/h maximum, indefinite and finite 11-digit hints never throw or shorten", async () => {
    expect(parseRetryAfter("99999999999", now)).toEqual({ kind: "delay", ms: 99999999999000 });
    expect(parseRetryAfter("0001234567890123", now)).toEqual({ kind: "indefinite" });
    for (const header of [
      "99999999999",
      "1234567890123",
      "Fri, 31 Dec 9999 23:59:59 GMT",
      "Fri, 31 Dec 9999 23:59:60 GMT",
    ]) {
      const h = transportHarness([{ status: 503, headers: { "retry-after": header } }]);
      const f = createGuardedFetcher(guardPolicy({ limits: { maxAttempts: 1 } }), h.deps);
      const r = await f.getJson(url);
      expect(r).toMatchObject({ code: "upstream_unavailable", attempts: 1 });
      const saved = f.notBefore!;
      expect(saved.kind).toBe(
        header === "1234567890123" || header.includes(":60") ? "indefinite" : "until",
      );
      if (header === "99999999999") expect((saved as any).at).toMatch(/^5195-/);
      expect(await f.getJson(url)).toMatchObject({ code: "cooling_down", notBefore: saved });
      const g = transportHarness();
      const restart = createGuardedFetcher(guardPolicy(), {
        ...g.deps,
        notBefore: JSON.parse(JSON.stringify(saved)),
      });
      expect(await restart.getJson(url)).toMatchObject({ code: "cooling_down", attempts: 0 });
      expect(g.counters.requests).toBe(0);
      if (saved.kind === "indefinite") {
        h.advance(100 * 366 * 86400000);
        expect(await f.getJson(url)).toMatchObject({ code: "cooling_down" });
      }
    }
    const fractional = now + 250,
      max = Date.parse(MAX_NOT_BEFORE);
    const delay = Math.floor((max - fractional) / 1000);
    for (const delta of [0, 1]) {
      const h = transportHarness([
        { status: 503, headers: { "retry-after": String(delay + delta) } },
      ]);
      h.advance(250);
      const f = createGuardedFetcher(guardPolicy({ limits: { maxAttempts: 1 } }), h.deps);
      await f.getJson(url);
      expect(f.notBefore).toEqual(
        delta ? { kind: "indefinite" } : { kind: "until", at: MAX_NOT_BEFORE },
      );
    }
    const h = transportHarness([
      { status: 503, headers: { "retry-after": "1" } },
      { status: 503, headers: { "retry-after": "1234567890123" } },
    ]);
    const f = createGuardedFetcher(guardPolicy(), h.deps);
    expect(await f.getJson(url)).toMatchObject({
      code: "upstream_unavailable",
      notBefore: { kind: "indefinite" },
    });
  });
  it("CX-19j seeded 1000 runs maintain typed state and never send before accepted/seeded deadline", async () => {
    let seed = 94;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const hints = [
      "2",
      "3600",
      "1234567890123",
      "99999999999",
      "soon",
      "0",
      "Thu, 22 Oct 2026 12:00:30 GMT",
    ];
    for (let i = 0; i < 1000; i++) {
      const hint = hints[Math.floor(random() * hints.length)],
        status = [200, 404, 429, 500, 502, 503, 504][Math.floor(random() * 7)];
      const h = transportHarness([{ status, headers: { "retry-after": hint } }, { status: 200 }]);
      h.advance(Math.floor(random() * 1000));
      const start = h.clock;
      const f = createGuardedFetcher(guardPolicy({ limits: { maxAttempts: 1 } }), h.deps);
      const [a, b] = await Promise.all([f.getJson(url), f.getJson(url)]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const deadline = f.notBefore;
      if (deadline) {
        expect(
          deadline.kind === "indefinite" ? Object.keys(deadline) : Object.keys(deadline).sort(),
        ).toEqual(deadline.kind === "indefinite" ? ["kind"] : ["at", "kind"]);
        if (h.counters.starts.length > 1)
          expect(h.counters.starts[1]).toBeGreaterThanOrEqual(
            deadline.kind === "until" ? Date.parse(deadline.at) : Infinity,
          );
      }
      expect(h.counters.starts[0]).toBe(start);
    }
  });
});
describe("Retry-After calendar and RFC 850 full timestamp", () => {
  const cases: Array<[string, string, string | null]> = [
    ["2026-10-22T12:00:00Z", "Thursday, 22-Oct-76 12:00:00 GMT", "2076-10-22T12:00:00Z"],
    ["2026-10-22T12:00:00Z", "Thursday, 22-Oct-76 12:00:01 GMT", null],
    ["2026-10-22T12:00:00Z", "Friday, 23-Oct-76 00:00:00 GMT", null],
    ["2026-10-22T12:00:00Z", "Saturday, 23-Oct-76 00:00:00 GMT", "1976-10-23T00:00:00Z"],
    ["2026-10-22T12:00:00Z", "Friday, 22-Oct-76 12:00:01 GMT", "1976-10-22T12:00:01Z"],
    ["2026-10-22T12:00:00Z", "Wednesday, 21-Oct-76 23:59:59 GMT", "2076-10-21T23:59:59Z"],
    ["2026-10-22T12:00:00Z", "Saturday, 29-Feb-76 00:00:00 GMT", "2076-02-29T00:00:00Z"],
    ["2026-10-22T12:00:00Z", "Sunday, 29-Feb-76 00:00:00 GMT", null],
    ["2026-10-22T12:00:00.999Z", "Thursday, 22-Oct-76 12:00:00 GMT", "2076-10-22T12:00:00Z"],
    ["2026-10-22T12:00:00.999Z", "Thursday, 22-Oct-76 12:00:01 GMT", null],
    ["2028-02-29T12:00:00Z", "Monday, 28-Feb-78 23:59:59 GMT", "2078-02-28T23:59:59Z"],
    ["2028-02-29T12:00:00Z", "Wednesday, 01-Mar-78 00:00:00 GMT", "1978-03-01T00:00:00Z"],
    ["2028-02-29T12:00:00Z", "Tuesday, 01-Mar-78 00:00:00 GMT", null],
    ["2028-02-29T12:00:00Z", "Wednesday, 29-Feb-78 12:00:00 GMT", null],
    ["2028-02-29T12:00:00Z", "Tuesday, 29-Feb-78 12:00:01 GMT", null],
    ["2027-12-31T23:59:59Z", "Friday, 31-Dec-77 23:59:59 GMT", "2077-12-31T23:59:59Z"],
    ["2027-12-31T23:59:59Z", "Saturday, 31-Dec-77 23:59:60 GMT", "1978-01-01T00:00:00Z"],
    ["2027-12-31T23:59:59Z", "Friday, 31-Dec-77 23:59:60 GMT", null],
    ["2027-12-31T23:59:59Z", "Sunday, 01-Jan-78 00:00:00 GMT", "1978-01-01T00:00:00Z"],
    ["2027-12-31T23:59:59Z", "Saturday, 01-Jan-78 00:00:00 GMT", null],
    ["2026-10-31T23:00:00Z", "Saturday, 31-Oct-76 22:59:59 GMT", "2076-10-31T22:59:59Z"],
    ["2026-10-31T23:00:00Z", "Sunday, 31-Oct-76 23:00:01 GMT", "1976-10-31T23:00:01Z"],
    ["2026-10-31T23:00:00Z", "Monday, 01-Nov-76 00:00:00 GMT", "1976-11-01T00:00:00Z"],
    ["2026-10-31T23:00:00Z", "Sunday, 01-Nov-76 00:00:00 GMT", null],
  ];
  for (const [clock, value, expected] of cases)
    it("CX-19k " + clock + " " + value, async () => {
      const ms = Date.parse(clock);
      expect(parseRetryAfter(value, ms)).toEqual(
        expected ? { kind: "deadline", ms: Date.parse(expected) } : null,
      );
      const h = transportHarness([{ status: 503, headers: { "retry-after": value } }, {}]);
      h.advance(ms - now);
      const f = createGuardedFetcher(guardPolicy(), h.deps);
      const [a, b] = await Promise.all([f.getJson(url), f.getJson(url)]);
      const future = expected && Date.parse(expected) > ms;
      if (future) {
        expect(a).toMatchObject({
          code: "upstream_unavailable",
          attempts: 1,
          notBefore: { kind: "until", at: expected },
        });
        expect(b).toMatchObject({ code: "cooling_down", attempts: 0 });
        expect(h.counters.requests).toBe(1);
      } else {
        expect(a).toMatchObject({ ok: true, attempts: 2 });
        expect(b.ok).toBe(true);
        expect(f.notBefore).toBeNull();
      }
      const restart = transportHarness();
      restart.advance(ms - now);
      const saved = JSON.parse(JSON.stringify(f.notBefore));
      const g = createGuardedFetcher(guardPolicy(), {
        ...restart.deps,
        ...(saved ? { notBefore: saved } : {}),
      });
      expect(await g.getJson(url)).toMatchObject(
        future ? { code: "cooling_down", attempts: 0 } : { ok: true, attempts: 1 },
      );
      expect(restart.counters.requests).toBe(future ? 0 : 1);
    });
  it("CX-19i calendar validity and all three HTTP date forms", () => {
    for (const value of [
      "Sun, 06 Nov 1994 08:49:37 GMT",
      "Sunday, 06-Nov-94 08:49:37 GMT",
      "Sun Nov  6 08:49:37 1994",
      "Sun Nov 06 08:49:37 1994",
    ])
      expect(parseRetryAfter(value, now)).toEqual({
        kind: "deadline",
        ms: Date.parse("1994-11-06T08:49:37Z"),
      });
    expect(parseRetryAfter("Tue, 29 Feb 2028 00:00:00 GMT", now)).toEqual({
      kind: "deadline",
      ms: Date.parse("2028-02-29T00:00:00Z"),
    });
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:60 GMT", now)).toEqual({
      kind: "deadline",
      ms: Date.parse("2026-01-01T00:00:00Z"),
    });
    for (const value of [
      "Fri, 31 Feb 2027 00:00:00 GMT",
      "Mon, 29 Feb 2027 00:00:00 GMT",
      "Fri, 31 Apr 2027 00:00:00 GMT",
      "Sun, 06 Nov 1994 24:00:00 GMT",
      "Sun, 06 Nov 1994 23:60:00 GMT",
      "Sun, 06 Nov 1994 23:59:61 GMT",
      "Sat, 06 Nov 1994 08:49:37 GMT",
      "Saturday, 06-Nov-94 08:49:37 GMT",
      "Sat Nov  6 08:49:37 1994",
      "Friday, 22-Oct-76 00:00:00 GMT",
      "Sun, 6 Nov 1994 08:49:37 GMT",
      "sun, 06 Nov 1994 08:49:37 GMT",
      "Sun, 06 Nov 1994 08:49:37 UTC",
      "Sun Nov 6 08:49:37 1994",
      "Sun, 00 Nov 1994 08:49:37 GMT",
      "",
      " 120",
      "120 ",
      "-5",
      "1.5",
      "+3",
      "1e3",
      "soon",
    ])
      expect(parseRetryAfter(value, now), value).toBeNull();
    expect(parseRetryAfter("1", NaN)).toBeNull();
  });
  it("CX-19k receipt clock and existing cooldown govern century resolution", async () => {
    const h = transportHarness([
      { status: 503, headers: { "retry-after": "Thursday, 22-Oct-76 12:00:31 GMT" } },
      { status: 503, headers: { "retry-after": "Saturday, 23-Oct-76 00:00:00 GMT" } },
      {},
    ]);
    const f = createGuardedFetcher(guardPolicy(), {
      ...h.deps,
      notBefore: { kind: "until", at: "2026-10-22T12:00:30Z" },
    });
    expect(await f.getJson(url)).toMatchObject({ ok: true, attempts: 3 });
    expect(h.counters.starts[0]).toBe(now + 30000);
    expect(f.notBefore).toEqual({ kind: "until", at: "2026-10-22T12:00:30Z" });
    const receipt = transportHarness([
      {
        status: 503,
        headers: { "retry-after": "Thursday, 22-Oct-76 12:00:01 GMT" },
        receiptDelay: 30000,
      },
    ]);
    const g = createGuardedFetcher(guardPolicy(), receipt.deps);
    expect(await g.getJson(url)).toMatchObject({
      code: "upstream_unavailable",
      notBefore: { kind: "until", at: "2076-10-22T12:00:01Z" },
    });
  });
  it("CX-19k independent string-label oracle over 1000 seeded boundary values", async () => {
    let seed = 1976;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ],
      weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const label = (a: number[]) => a.map((n, i) => pad(n, i === 0 ? 4 : 2)).join("-");
    for (let i = 0; i < 1000; i++) {
      const clock = new Date(
        i % 3 === 0
          ? "2028-02-29T12:00:00Z"
          : i % 3 === 1
            ? "2027-12-31T23:59:59Z"
            : "2026-10-22T12:00:00Z",
      );
      const ref = [
        clock.getUTCFullYear() + 50,
        clock.getUTCMonth() + 1,
        clock.getUTCDate(),
        clock.getUTCHours(),
        clock.getUTCMinutes(),
        clock.getUTCSeconds(),
      ];
      const candidate = [...ref];
      const index = Math.floor(rand() * 6);
      candidate[index] += Math.floor(rand() * 3) - 1;
      candidate[1] = Math.max(1, Math.min(12, candidate[1]));
      candidate[2] = Math.max(1, Math.min(31, candidate[2]));
      candidate[3] = Math.max(0, Math.min(23, candidate[3]));
      candidate[4] = Math.max(0, Math.min(59, candidate[4]));
      candidate[5] = Math.max(0, Math.min(60, candidate[5]));
      const y1 = Math.floor(clock.getUTCFullYear() / 100) * 100 + (candidate[0] % 100);
      const resolved = label([y1, ...candidate.slice(1)]) > label(ref) ? y1 - 100 : y1;
      const date = new Date(
        `${pad(resolved, 4)}-${pad(candidate[1])}-${pad(candidate[2])}T${pad(candidate[3])}:${pad(candidate[4])}:00Z`,
      );
      const valid =
        date.getUTCFullYear() === resolved &&
        date.getUTCMonth() + 1 === candidate[1] &&
        date.getUTCDate() === candidate[2];
      const weekday = rand() < 0.8 && valid ? date.getUTCDay() : Math.floor(rand() * 7);
      const expected =
        valid && date.getUTCDay() === weekday ? date.getTime() + candidate[5] * 1000 : null;
      const header = `${weekdays[weekday]}, ${pad(candidate[2])}-${months[candidate[1] - 1]}-${pad(candidate[0] % 100)} ${pad(candidate[3])}:${pad(candidate[4])}:${pad(candidate[5])} GMT`;
      expect(parseRetryAfter(header, clock.getTime()), header).toEqual(
        expected === null ? null : { kind: "deadline", ms: expected },
      );
      if (i < 100) {
        const h = transportHarness([{ status: 503, headers: { "retry-after": header } }, {}]);
        h.advance(clock.getTime() - now);
        const f = createGuardedFetcher(guardPolicy(), h.deps);
        await f.getJson(url);
        expect(f.notBefore !== null).toBe(expected !== null && expected > clock.getTime());
      }
    }
  });
});
describe("bounded body and no raw-data failure leakage", () => {
  it("200 returns digest, decoded JSON, byte count, media type and time", async () => {
    for (const gzip of [false, true]) {
      const { result, h } = await one({
        body: '{"fixture":true}',
        gzip,
        headers: {
          "content-type": "Application/JSON; charset=UTF-8",
          "set-cookie": "fixture=discard",
        },
      });
      expect(result).toEqual({
        ok: true,
        status: 200,
        json: { fixture: true },
        bytes: 16,
        sha256: createHash("sha256").update('{"fixture":true}').digest("hex"),
        mediaType: "application/json",
        attempts: 1,
        fetchedAt: "2026-10-22T12:00:00Z",
      });
      expect(h.counters).toMatchObject({
        requests: 1,
        lookups: 1,
        resolves: 1,
        connects: 1,
        bytes: 1,
      });
    }
  });
  it("CX-20 rejects content length, streamed size and gzip bomb", async () => {
    for (const reply of [
      { headers: { "content-length": "2097152" } },
      { body: Buffer.alloc(1048577, 32) },
      { body: Buffer.alloc(4 * 1048576, 32), gzip: true },
    ]) {
      const { result } = await one(reply);
      expect(result).toMatchObject({
        code: "response_too_large",
        attempts: 1,
        retryable: false,
        status: 200,
      });
    }
  });
  it("CX-20 exact media, encoding, UTF-8, JSON and depth failure codes", async () => {
    const cases: Array<[Reply, string]> = [
      [{ headers: { "content-encoding": "br" } }, "unsupported_encoding"],
      [{ headers: { "content-type": "text/html" } }, "unsupported_media_type"],
      [
        { headers: { "content-type": "application/json; charset=iso-8859-1" } },
        "unsupported_media_type",
      ],
      [{ headers: { "content-type": "application/json; charset=" } }, "unsupported_media_type"],
      [{ body: Buffer.from([255]) }, "invalid_utf8"],
      [{ body: "{" }, "malformed_json"],
      [{ body: "[".repeat(33) + "0" + "]".repeat(33) }, "json_too_deep"],
    ];
    for (const [reply, code] of cases)
      expect((await one(reply)).result).toMatchObject({
        code,
        attempts: 1,
        retryable: false,
        status: 200,
      });
    expect((await one({ body: '"\\ud800"' })).result).toMatchObject({ ok: true, json: "\ud800" });
    expect((await one({ body: "[".repeat(32) + "0" + "]".repeat(32) })).result.ok).toBe(true);
    expect(
      (await one({ body: "bad gzip", headers: { "content-encoding": "gzip" } })).result,
    ).toMatchObject({ code: "network_error", attempts: 3 });
  });
  it("CX-20 timeout includes a hung body and network errors are typed", async () => {
    vi.useFakeTimers();
    const h = transportHarness([{ hang: true }]);
    const f = createGuardedFetcher(
      guardPolicy({ limits: { timeoutMs: 10, maxAttempts: 1 } }),
      h.deps,
    );
    const pending = f.getJson(url);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ code: "timeout", attempts: 1, retryable: true });
    vi.useRealTimers();
    expect((await one({ error: "ECONNRESET" })).result).toMatchObject({
      code: "network_error",
      attempts: 3,
    });
    const h2 = transportHarness();
    const g = createGuardedFetcher(guardPolicy(), {
      ...h2.deps,
      request: (() => {
        throw Error("fixture");
      }) as any,
    });
    expect(await g.getJson(url)).toMatchObject({ code: "network_error", attempts: 3 });
  });
  it("query markers and exception details never appear in serialized failures", async () => {
    const h = transportHarness([{ status: 403 }]);
    const f = createGuardedFetcher(guardPolicy(), h.deps);
    const result = await f.getJson(url + "?secret=FIXTURE-QUERY-MARKER");
    expect(JSON.stringify(result)).not.toContain("FIXTURE-QUERY-MARKER");
    expect(Object.keys(result).sort()).toEqual(
      ["ok", "code", "retryable", "attempts", "status", "host", "notBefore"].sort(),
    );
  });
});
describe("CX-27 bounded read-only static hygiene", () => {
  it("has no runtime caller, environment read or DNS literal; policies are reserved and helper-created", () => {
    const root = path.resolve(__dirname, "../..");
    const reads: string[] = [];
    const read = (relative: string) => {
      const file = path.resolve(root, relative);
      expect(
        file.startsWith(path.join(root, "src") + path.sep) ||
          file.startsWith(path.join(root, "test") + path.sep),
      ).toBe(true);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      reads.push(file);
      return readFileSync(file, "utf8");
    };
    const files: string[] = [];
    const walk = (relative: string) => {
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(name);
        else if (entry.name.endsWith(".ts")) files.push(name);
      }
    };
    walk("src");
    const importsGuard = (source: string) => {
      const tree = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
      let found = false;
      function visit(node: ts.Node) {
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression &&
          ts.isStringLiteralLike(node.moduleReference.expression) &&
          /guardedFetch(?:\.ts)?$/.test(node.moduleReference.expression.text)
        )
          found = true;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier) &&
          /guardedFetch(?:\.ts)?$/.test(node.moduleSpecifier.text)
        )
          found = true;
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          /guardedFetch(?:\.ts)?$/.test(node.arguments[0].text)
        )
          found = true;
        ts.forEachChild(node, visit);
      }
      visit(tree);
      return found;
    };
    for (const file of files)
      if (file !== path.join("src", "utils", "guardedFetch.ts"))
        expect(importsGuard(read(file)), file).toBe(false);
    const guard = read("src/utils/guardedFetch.ts");
    const dnsLiteral = (text: string) => {
      const tree = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
      const names: string[] = [];
      function visit(node: ts.Node) {
        if (
          ts.isStringLiteralLike(node) &&
          /\b(?:[a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*\b/i.test(node.text)
        )
          names.push(node.text);
        ts.forEachChild(node, visit);
      }
      visit(tree);
      return names;
    };
    expect(guard).not.toContain("process.env");
    expect(dnsLiteral(guard)).toEqual([]);
    expect(dnsLiteral('const x="live.fixture.test"')).toEqual(["live.fixture.test"]);
    expect(dnsLiteral('const x="https://live.fixture.test/path"')).toEqual([
      "https://live.fixture.test/path",
    ]);
    expect(importsGuard('import x from "./guardedFetch"')).toBe(true);
    expect(importsGuard('import "./guardedFetch"')).toBe(true);
    expect(importsGuard('import guard = require("./guardedFetch")')).toBe(true);
    expect(importsGuard('const guard = import("./guardedFetch")')).toBe(true);
    const testFiles = [
      "test/helpers/evidenceFixtures.ts",
      "test/unit/evidenceContract.test.ts",
      "test/unit/sourceAccess.test.ts",
      "test/unit/guardedFetch.test.ts",
    ];
    for (const file of testFiles) {
      const source = read(file);
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(tree) === "hosts" &&
          ts.isArrayLiteralExpression(node.initializer)
        ) {
          for (const element of node.initializer.elements)
            if (ts.isStringLiteralLike(element))
              expect(element.text).toMatch(/\.(test|example|invalid)$/);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      if (file !== testFiles[0]) expect(source).not.toMatch(/const\s+\w+\s*:\s*GuardPolicy\s*=/);
    }
    const invalidHosts = ["non-reserved"];
    expect(() => guardPolicy({ hosts: invalidHosts })).toThrow("non-reserved fixture host");
    expect(reads.every((file) => file.startsWith(root + path.sep))).toBe(true);
    expect(guard).not.toMatch(/node:fs|writeFile|readFile|child_process/);
  });
});
