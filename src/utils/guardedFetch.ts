import * as https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import type { IncomingMessage, ClientRequest } from "node:http";
import type { Socket } from "node:net";

export const GUARD_LIMITS = {
  timeoutMs: 15000,
  maxBodyBytes: 1048576,
  maxAttempts: 3,
  maxRetryAfterMs: 60000,
  maxConsecutiveTransientFailures: 3,
  maxJsonDepth: 32,
  maxUrlLength: 2048,
  backoffBaseMs: 1000,
  backoffCapMs: 8000,
} as const;
export const GUARD_NODE_MAJOR = 22 as const;
export interface GuardPolicy {
  hosts: readonly string[];
  paths: readonly string[];
  acceptedMediaTypes: readonly string[];
  minIntervalMs: number;
  userAgent: string;
  limits?: Partial<{ [K in keyof typeof GUARD_LIMITS]: number }>;
}
export type GuardFailureCode =
  | "url_rejected"
  | "host_not_permitted"
  | "path_not_permitted"
  | "address_blocked"
  | "dns_failed"
  | "destination_unverified"
  | "redirect_rejected"
  | "timeout"
  | "network_error"
  | "not_found"
  | "access_denied"
  | "bad_request"
  | "throttled"
  | "upstream_unavailable"
  | "unexpected_status"
  | "unsupported_media_type"
  | "unsupported_encoding"
  | "response_too_large"
  | "invalid_utf8"
  | "malformed_json"
  | "json_too_deep"
  | "cooling_down"
  | "stopped";
export type NotBefore = { kind: "until"; at: string } | { kind: "indefinite" };
export const MAX_NOT_BEFORE = "9999-12-31T23:59:59Z" as const;
export type RetryAfterHint =
  { kind: "delay"; ms: number } | { kind: "deadline"; ms: number } | { kind: "indefinite" };
export type GuardResult =
  | {
      ok: true;
      status: 200;
      json: unknown;
      bytes: number;
      sha256: string;
      mediaType: string;
      attempts: number;
      fetchedAt: string;
    }
  | {
      ok: false;
      code: GuardFailureCode;
      retryable: boolean;
      attempts: number;
      status: number | null;
      host: string | null;
      notBefore: NotBefore | null;
    };
export interface GuardDeps {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  request?: typeof https.request;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  notBefore?: NotBefore;
}
export class GuardPolicyError extends Error {
  constructor(readonly code: "invalid_policy" | "platform_unverified") {
    super(code);
    this.name = "GuardPolicyError";
  }
}
const ipv4 = new BlockList();
// IANA special-purpose registry snapshot retrieved 2026-10-22; conservative parent overblocks.
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  ipv4.addSubnet(address, prefix, "ipv4");
const embedded = new BlockList();
embedded.addSubnet("::ffff:0:0", 96, "ipv6");
embedded.addSubnet("64:ff9b::", 96, "ipv6");
const global = new BlockList();
global.addSubnet("2000::", 3, "ipv6");
const special = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  special.addSubnet(address, prefix, "ipv6");
function ipv6Words(address: string): number[] {
  let a = address.toLowerCase();
  if (a.includes(".")) {
    const at = a.lastIndexOf(":");
    const bytes = a
      .slice(at + 1)
      .split(".")
      .map(Number);
    a =
      a.slice(0, at + 1) +
      ((bytes[0] << 8) | bytes[1]).toString(16) +
      ":" +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const [left, right] = a.split("::");
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  return (right === undefined ? l : [...l, ...Array(8 - l.length - r.length).fill("0"), ...r]).map(
    (x) => parseInt(x, 16),
  );
}
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || address.includes("%")) return true;
  if (family === 4) return ipv4.check(address, "ipv4");
  if (embedded.check(address, "ipv6")) {
    const words = ipv6Words(address);
    const bytes = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255];
    return ipv4.check(bytes.join("."), "ipv4");
  }
  return !global.check(address, "ipv6") || special.check(address, "ipv6");
}
export function checkGuardPlatform(nodeVersion = process.versions.node): boolean {
  return (
    Number(nodeVersion.split(".")[0]) === GUARD_NODE_MAJOR &&
    [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "169.254.169.254",
      "fd00::1",
      "100:0:0:1::1",
      "3fff::1",
      "5f00::1",
      "fe80::1%eth0",
      "not-an-ip",
    ].every(isBlockedAddress) &&
    ["8.8.8.8", "::ffff:8.8.8.8", "64:ff9b::808:808", "2606:4700::1"].every(
      (a) => !isBlockedAddress(a),
    )
  );
}
export function checkTargetUrl(
  raw: string,
  policy: GuardPolicy,
):
  | { ok: true; url: URL }
  | { ok: false; code: "url_rejected" | "host_not_permitted" | "path_not_permitted" } {
  try {
    if (
      typeof raw !== "string" ||
      raw.length > (policy.limits?.maxUrlLength ?? GUARD_LIMITS.maxUrlLength)
    )
      return { ok: false, code: "url_rejected" };
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      isIP(url.hostname.replace(/^\[|\]$/g, ""))
    )
      return { ok: false, code: "url_rejected" };
    if (!policy.hosts.includes(url.hostname)) return { ok: false, code: "host_not_permitted" };
    if (!policy.paths.includes(url.pathname)) return { ok: false, code: "path_not_permitted" };
    return { ok: true, url };
  } catch {
    return { ok: false, code: "url_rejected" };
  }
}
function internalError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
export function createGuardedLookup(
  resolve: NonNullable<GuardDeps["resolve"]>,
  onValidated: (addresses: readonly string[]) => void,
): (hostname: string, options: object, cb: (...args: any[]) => void) => void {
  return (hostname, options, cb) => {
    Promise.resolve()
      .then(() => resolve(hostname))
      .then(
        (addresses) => {
          if (!addresses.length) {
            cb(internalError("dns_failed"));
            return;
          }
          if (
            addresses.some((a) => !a || isBlockedAddress(a.address) || isIP(a.address) !== a.family)
          ) {
            cb(internalError("address_blocked"));
            return;
          }
          onValidated(addresses.map((a) => a.address));
          if ((options as { all?: boolean }).all) cb(null, addresses);
          else cb(null, addresses[0].address, addresses[0].family);
        },
        () => cb(internalError("dns_failed")),
      );
  };
}
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}
export function parseRetryAfter(value: string, nowMs: number): RetryAfterHint | null {
  if (typeof value !== "string" || !Number.isFinite(nowMs)) return null;
  if (/^[0-9]+$/.test(value)) {
    const significant = value.replace(/^0+/, "");
    return significant.length > 12
      ? { kind: "indefinite" }
      : { kind: "delay", ms: Number(value) * 1000 };
  }
  let m: RegExpExecArray | null;
  let year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    weekday: number;
  if (
    (m =
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
        value,
      ))
  ) {
    weekday = days.indexOf(m[1]);
    day = +m[2];
    month = months.indexOf(m[3]) + 1;
    year = +m[4];
    hour = +m[5];
    minute = +m[6];
    second = +m[7];
  } else if (
    (m =
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
        value,
      ))
  ) {
    weekday = longDays.indexOf(m[1]);
    day = +m[2];
    month = months.indexOf(m[3]) + 1;
    hour = +m[5];
    minute = +m[6];
    second = +m[7];
    const now = new Date(nowMs);
    year = 100 * Math.floor(now.getUTCFullYear() / 100) + Number(m[4]);
    const candidate = [year, month, day, hour, minute, second];
    const reference = [
      now.getUTCFullYear() + 50,
      now.getUTCMonth() + 1,
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    ];
    for (let i = 0; i < 6; i++) {
      if (candidate[i] !== reference[i]) {
        if (candidate[i] > reference[i]) year -= 100;
        break;
      }
    }
  } else if (
    (m =
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{2}| [0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
        value,
      ))
  ) {
    weekday = days.indexOf(m[1]);
    month = months.indexOf(m[2]) + 1;
    day = +m[3];
    hour = +m[4];
    minute = +m[5];
    second = +m[6];
    year = +m[7];
  } else return null;
  if (hour > 23 || minute > 59 || second > 60 || day < 1) return null;
  const date = utc(year, month, day, hour, minute, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== weekday
  )
    return null;
  return { kind: "deadline", ms: date.getTime() + second * 1000 };
}
const maxDeadline = Date.parse(MAX_NOT_BEFORE);
function validSeed(seed: unknown): seed is NotBefore {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) return false;
  const s = seed as Record<string, unknown>;
  if (s.kind === "indefinite") return Object.keys(s).length === 1;
  if (
    s.kind !== "until" ||
    Object.keys(s).length !== 2 ||
    typeof s.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s.at)
  )
    return false;
  const ms = Date.parse(s.at);
  return (
    Number.isFinite(ms) &&
    ms <= maxDeadline &&
    new Date(ms).toISOString().replace(".000Z", "Z") === s.at
  );
}
function validatePolicy(policy: GuardPolicy): void {
  const record = policy as unknown as Record<string, unknown>;
  if (
    !policy ||
    typeof policy !== "object" ||
    Object.keys(record).some(
      (k) =>
        !["hosts", "paths", "acceptedMediaTypes", "minIntervalMs", "userAgent", "limits"].includes(
          k,
        ),
    ) ||
    !Array.isArray(policy.hosts) ||
    !policy.hosts.length ||
    policy.hosts.some(
      (h) =>
        typeof h !== "string" ||
        h.length > 253 ||
        isIP(h) ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          h,
        ),
    ) ||
    !Array.isArray(policy.paths) ||
    !policy.paths.length ||
    policy.paths.some(
      (p) =>
        typeof p !== "string" ||
        !p.startsWith("/") ||
        Array.from(p).some(
          (character) => character.charCodeAt(0) <= 32 || character === "?" || character === "#",
        ),
    ) ||
    !Array.isArray(policy.acceptedMediaTypes) ||
    !policy.acceptedMediaTypes.length ||
    policy.acceptedMediaTypes.some(
      (t) => typeof t !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(t),
    ) ||
    !Number.isSafeInteger(policy.minIntervalMs) ||
    policy.minIntervalMs < 0 ||
    typeof policy.userAgent !== "string" ||
    !/^[\x20-\x7e]{1,200}$/.test(policy.userAgent)
  )
    throw new GuardPolicyError("invalid_policy");
  if (policy.limits !== undefined) {
    if (!policy.limits || typeof policy.limits !== "object" || Array.isArray(policy.limits))
      throw new GuardPolicyError("invalid_policy");
    for (const [k, v] of Object.entries(policy.limits))
      if (
        !Object.prototype.hasOwnProperty.call(GUARD_LIMITS, k) ||
        !Number.isSafeInteger(v) ||
        v <= 0 ||
        v > GUARD_LIMITS[k as keyof typeof GUARD_LIMITS]
      )
        throw new GuardPolicyError("invalid_policy");
  }
}
type Attempt =
  | { ok: true; json: unknown; bytes: number; sha256: string; mediaType: string; fetchedAt: string }
  | {
      ok: false;
      code: GuardFailureCode;
      status: number | null;
      retryable: boolean;
      hint: RetryAfterHint | null;
    };
export function createGuardedFetcher(
  policy: GuardPolicy,
  deps: GuardDeps = {},
): {
  getJson(url: string): Promise<GuardResult>;
  readonly stopped: boolean;
  readonly notBefore: NotBefore | null;
} {
  validatePolicy(policy);
  if (!checkGuardPlatform()) throw new GuardPolicyError("platform_unverified");
  if (deps.notBefore !== undefined && !validSeed(deps.notBefore))
    throw new GuardPolicyError("invalid_policy");
  // Copy caller-owned policy and state so later mutations cannot widen a running guard.
  policy = {
    ...policy,
    hosts: [...policy.hosts],
    paths: [...policy.paths],
    acceptedMediaTypes: [...policy.acceptedMediaTypes],
    limits: { ...policy.limits },
  };
  const limits = { ...GUARD_LIMITS, ...policy.limits };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const resolve =
    deps.resolve ??
    (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })) as Array<{
        address: string;
        family: 4 | 6;
      }>);
  let cooldown: NotBefore | null = deps.notBefore ? { ...deps.notBefore } : null;
  let stopped = false,
    failures = 0,
    lastStart = -Infinity;
  let queue: Promise<unknown> = Promise.resolve();
  const copyCooldown = () => (cooldown ? { ...cooldown } : null);
  function mergeHint(hint: RetryAfterHint | null): boolean {
    if (!hint) return false;
    let next: NotBefore;
    if (hint.kind === "indefinite") next = { kind: "indefinite" };
    else {
      const at = hint.kind === "delay" ? now() + hint.ms : hint.ms;
      if (at <= now()) return true;
      const rounded = Math.ceil(at / 1000) * 1000;
      next =
        rounded > maxDeadline
          ? { kind: "indefinite" }
          : { kind: "until", at: new Date(rounded).toISOString().replace(".000Z", "Z") };
    }
    if (
      cooldown?.kind !== "indefinite" &&
      (next.kind === "indefinite" || !cooldown || next.at > cooldown.at)
    )
      cooldown = next;
    return true;
  }
  function attempt(url: URL): Promise<Attempt> {
    return new Promise((resolveAttempt) => {
      let done = false,
        request: ClientRequest | undefined,
        response: IncomingMessage | undefined;
      let validated: readonly string[] = [];
      let lookupCalls = 0,
        connected = false;
      let connectedPeer: string | undefined;
      const peers = new BlockList();
      const failure = (
        code: GuardFailureCode,
        status: number | null = null,
        hint: RetryAfterHint | null = null,
      ): Attempt => ({
        ok: false,
        code,
        status,
        hint,
        retryable: [
          "dns_failed",
          "network_error",
          "timeout",
          "throttled",
          "upstream_unavailable",
        ].includes(code),
      });
      const finish = (result: Attempt) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolveAttempt(result);
        response?.destroy();
        request?.destroy();
      };
      const timer = setTimeout(() => finish(failure("timeout")), limits.timeoutMs);
      const peerOkay = (socket: Socket) =>
        !!socket?.remoteAddress &&
        socket.remotePort === 443 &&
        !isBlockedAddress(socket.remoteAddress) &&
        peers.check(socket.remoteAddress, isIP(socket.remoteAddress) === 4 ? "ipv4" : "ipv6");
      const guarded = createGuardedLookup(resolve, (addresses) => {
        validated = addresses;
        for (const a of addresses) peers.addAddress(a, isIP(a) === 4 ? "ipv4" : "ipv6");
      });
      const guardedOnce = (host: string, options: object, cb: (...args: any[]) => void) => {
        if (++lookupCalls > 1) {
          cb(internalError("destination_unverified"));
          finish(failure("destination_unverified"));
          return;
        }
        guarded(host, options, cb);
      };
      try {
        request = (deps.request ?? https.request)(
          {
            method: "GET",
            host: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            lookup: guardedOnce,
            agent: false,
            rejectUnauthorized: true,
            headers: {
              Accept: policy.acceptedMediaTypes.join(", "),
              "Accept-Encoding": "gzip",
              "User-Agent": policy.userAgent,
            },
          },
          (res) => {
            response = res;
            if (done) {
              res.destroy();
              return;
            }
            if (
              !validated.length ||
              !connected ||
              !peerOkay(res.socket) ||
              !connectedPeer ||
              !sameAddress(connectedPeer, res.socket.remoteAddress!)
            ) {
              finish(failure("destination_unverified"));
              return;
            }
            const status = res.statusCode ?? 0;
            if (status !== 200) {
              const code: GuardFailureCode =
                status >= 300 && status <= 399
                  ? "redirect_rejected"
                  : status === 400
                    ? "bad_request"
                    : [401, 403].includes(status)
                      ? "access_denied"
                      : [404, 410].includes(status)
                        ? "not_found"
                        : status === 429
                          ? "throttled"
                          : [500, 502, 503, 504].includes(status)
                            ? "upstream_unavailable"
                            : "unexpected_status";
              const raw = res.headers["retry-after"];
              const receivedAt = now();
              const parsedHint =
                [429, 500, 502, 503, 504].includes(status) && typeof raw === "string"
                  ? parseRetryAfter(raw, receivedAt)
                  : null;
              const hint =
                parsedHint?.kind === "delay"
                  ? { kind: "deadline" as const, ms: receivedAt + parsedHint.ms }
                  : parsedHint;
              finish(failure(code, status, hint));
              return;
            }
            const contentLength = res.headers["content-length"];
            if (contentLength !== undefined && Number(contentLength) > limits.maxBodyBytes) {
              finish(failure("response_too_large", status));
              return;
            }
            const encoding = res.headers["content-encoding"];
            if (encoding !== undefined && encoding !== "identity" && encoding !== "gzip") {
              finish(failure("unsupported_encoding", status));
              return;
            }
            const contentType = res.headers["content-type"] ?? "";
            const parts = contentType.split(";");
            const mediaType = parts[0].trim().toLowerCase();
            if (
              !policy.acceptedMediaTypes.includes(mediaType) ||
              parts.slice(1).some((part) => {
                const m = /^\s*charset\s*=\s*"?([^"\s]+)"?\s*$/i.exec(part);
                return /^\s*charset\s*=/i.test(part) && (!m || m[1].toLowerCase() !== "utf-8");
              })
            ) {
              finish(failure("unsupported_media_type", status));
              return;
            }
            const stream = encoding === "gzip" ? res.pipe(createGunzip()) : res;
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("error", () => finish(failure("network_error", status)));
            res.on("aborted", () => finish(failure("network_error", status)));
            stream.on("error", () => finish(failure("network_error", status)));
            stream.on("data", (chunk: Buffer) => {
              if (done) return;
              bytes += chunk.length;
              if (bytes > limits.maxBodyBytes) {
                stream.destroy();
                finish(failure("response_too_large", status));
              } else chunks.push(Buffer.from(chunk));
            });
            stream.on("end", () => {
              if (done) return;
              const body = Buffer.concat(chunks);
              let text: string, json: unknown;
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(body);
              } catch {
                finish(failure("invalid_utf8", status));
                return;
              }
              try {
                json = JSON.parse(text);
              } catch {
                finish(failure("malformed_json", status));
                return;
              }
              const stack: Array<[unknown, number]> = [[json, 0]];
              while (stack.length) {
                const [value, depth] = stack.pop()!;
                if (value !== null && typeof value === "object") {
                  if (depth + 1 > limits.maxJsonDepth) {
                    finish(failure("json_too_deep", status));
                    return;
                  }
                  for (const child of Object.values(value)) stack.push([child, depth + 1]);
                }
              }
              finish({
                ok: true,
                json,
                bytes,
                sha256: createHash("sha256").update(body).digest("hex"),
                mediaType,
                fetchedAt: new Date(now()).toISOString().replace(".000Z", "Z"),
              });
            });
          },
        );
        request.on("socket", (socket) =>
          socket.once("connect", () => {
            if (done) return;
            if (!validated.length || !peerOkay(socket)) {
              socket.destroy();
              finish(failure("destination_unverified"));
              return;
            }
            connected = true;
            connectedPeer = socket.remoteAddress;
          }),
        );
        request.on("error", (error) => {
          const code = (error as NodeJS.ErrnoException).code;
          finish(
            failure(
              code === "address_blocked" ||
                code === "dns_failed" ||
                code === "destination_unverified"
                ? code
                : "network_error",
            ),
          );
        });
        request.end();
      } catch {
        finish(failure("network_error"));
      }
    });
  }
  function sameAddress(a: string, b: string): boolean {
    const list = new BlockList();
    list.addAddress(a, isIP(a) === 4 ? "ipv4" : "ipv6");
    return list.check(b, isIP(b) === 4 ? "ipv4" : "ipv6");
  }
  async function run(raw: string): Promise<GuardResult> {
    let host: string | null = null,
      attempts = 0;
    let last: Extract<Attempt, { ok: false }> | null = null;
    let backoff = 0;
    const fail = (
      code: GuardFailureCode,
      retryable = false,
      status: number | null = null,
    ): GuardResult => ({
      ok: false,
      code,
      retryable,
      attempts,
      status,
      host,
      notBefore: copyCooldown(),
    });
    try {
      if (stopped) return fail("stopped");
      const target = checkTargetUrl(raw, policy);
      if (!target.ok) return fail(target.code);
      host = target.url.hostname;
      while (attempts < limits.maxAttempts) {
        const clock = now();
        const cool =
          cooldown?.kind === "indefinite"
            ? Infinity
            : cooldown?.kind === "until"
              ? Date.parse(cooldown.at)
              : 0;
        if (cool - clock > limits.maxRetryAfterMs) {
          if (!last) return fail("cooling_down", true);
          break;
        }
        const wait = Math.max(lastStart + policy.minIntervalMs, cool, backoff) - clock;
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        lastStart = now();
        attempts++;
        const result = await attempt(target.url);
        if (result.ok) {
          failures = 0;
          return { ...result, status: 200, attempts };
        }
        last = result;
        const hinted = mergeHint(result.hint);
        if (["access_denied", "address_blocked", "destination_unverified"].includes(result.code))
          stopped = true;
        if (result.code === "not_found") failures = 0;
        if (!result.retryable) break;
        if (!hinted)
          backoff =
            now() +
            Math.min(limits.backoffCapMs, limits.backoffBaseMs * 2 ** (attempts - 1)) *
              Math.max(0, Math.min(1, random()));
        else backoff = 0;
      }
      if (last?.retryable && ++failures >= limits.maxConsecutiveTransientFailures) stopped = true;
      return fail(last!.code, last!.retryable, last!.status);
    } catch {
      return fail("network_error", true);
    }
  }
  return {
    getJson(raw) {
      const result = queue.then(() => run(raw));
      queue = result.catch(() => undefined);
      return result;
    },
    get stopped() {
      return stopped;
    },
    get notBefore() {
      return copyCooldown();
    },
  };
}
