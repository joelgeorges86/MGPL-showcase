import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import type { GuardDeps, GuardPolicy } from "../../src/utils/guardedFetch";
import { EVIDENCE_CONTRACT } from "../../src/lib/evidenceContract";
import type { EvidenceObservation, SubjectRef } from "../../src/lib/evidenceContract";
import { SOURCE_REGISTER } from "../../src/lib/sourceAccess";
import type { SourceRegisterView } from "../../src/lib/sourceAccess";

export const FIXTURE_NOW = new Date("2026-10-22T12:00:00Z");
export const fixtureBuild: SubjectRef = {
  kind: "game_build",
  edition_key: "mgpl:fixture-quest/pc",
  platform: "android",
  version: null,
};
export const fixturePair: SubjectRef = {
  kind: "pairing",
  game: { kind: "game_edition", edition_key: "mgpl:fixture-quest/console" },
  device: {
    kind: "hardware_reference",
    hardware_class: "console",
    reference_key: "fixturecorp:console-one:cn-100-us",
  },
};
export function obs(overrides: Partial<EvidenceObservation> = {}): EvidenceObservation {
  return {
    contract: EVIDENCE_CONTRACT,
    subject: fixtureBuild,
    field: "requires_ram_gb",
    value_state: "stated",
    value: 4,
    unit: "GB",
    unknown_reason: null,
    basis: "documented",
    list_exhaustive: null,
    country: "US",
    source: {
      source_id: "publisher-pages",
      url: "https://publisher.example/fixture-quest/specs",
      source_version: null,
    },
    collection: "manual_read",
    observed_at: "2026-10-21",
    source_updated_at: null,
    reviewed_on: "2026-10-22",
    ...overrides,
  };
}
export const TEST_REGISTER: SourceRegisterView = {
  entries: SOURCE_REGISTER.map((s) =>
    s.id === "apple-search" ? { ...s, routes: { ...s.routes, bounded_get: "approved" } } : s,
  ),
  originRules: [],
};
export const listing = {
  kind: "store_listing",
  store: "apple_app_store",
  store_app_id: "999999999001",
  country: "US",
} as const;
const appleSource = {
  source_id: "apple-app-store-page",
  url: "https://store.example/fixture-quest",
  source_version: null,
};
export const CONTRACT_EXAMPLES: Array<{
  id: string;
  input: EvidenceObservation;
  valid: boolean;
  reasons?: string[];
  assessment?: string;
  observations?: EvidenceObservation[];
  register?: SourceRegisterView;
}> = [
  {
    id: "EX-CONSOLE",
    input: obs({ subject: fixturePair, field: "native_edition_support", value: true, unit: null }),
    valid: true,
    assessment: "current",
  },
  {
    id: "EX-HANDHELD",
    input: obs({
      subject: {
        kind: "pairing",
        game: {
          kind: "game_build",
          edition_key: "mgpl:fixture-quest/pc",
          platform: "steamos",
          version: null,
        },
        device: {
          kind: "hardware_reference",
          hardware_class: "handheld",
          reference_key: "fixturecorp:handheld-x:hx-1-us",
        },
      },
      field: "publisher_lists_device",
      value_state: "unknown",
      value: null,
      unit: null,
      basis: null,
      unknown_reason: "not_listed",
      list_exhaustive: false,
    }),
    valid: true,
    assessment: "unknown",
  },
  {
    id: "EX-IPHONE",
    input: obs({
      subject: listing,
      field: "listing_minimum_os_version",
      value: "17.0",
      unit: null,
      source: appleSource,
    }),
    valid: true,
    assessment: "current",
  },
  {
    id: "EX-IPAD",
    input: obs({
      subject: {
        kind: "pairing",
        game: listing,
        device: { kind: "mobile_reference", reference_key: "apple:ipad-fixture:fixture-wifi" },
      },
      field: "publisher_lists_device",
      value: true,
      unit: null,
      list_exhaustive: false,
    }),
    valid: true,
    assessment: "current",
  },
  ...(
    [
      ["requires_os_min_release", "8.0", null],
      ["supported_cpu_abis", ["arm64-v8a"], null],
      ["requires_ram_gb", 4, "GB"],
    ] as const
  ).map(([field, value, unit]) => ({
    id: "EX-ANDROID-PHONE-" + field,
    input: obs({
      subject: { ...fixtureBuild, edition_key: "mgpl:fixture-quest/mobile" } as SubjectRef,
      field,
      value: Array.isArray(value) ? [...value] : (value as string | number),
      unit,
      list_exhaustive: field === "supported_cpu_abis" ? true : null,
    }),
    valid: true,
    assessment: "current",
  })),
  {
    id: "EX-ANDROID-TABLET",
    input: obs({
      subject: {
        kind: "pairing",
        game: fixtureBuild as any,
        device: { kind: "mobile_reference", reference_key: "google:fixture-tab:fixture-us-wifi" },
      },
      field: "native_edition_support",
      value_state: "unknown",
      value: null,
      unit: null,
      basis: null,
      unknown_reason: "not_published",
    }),
    valid: true,
    assessment: "unknown",
  },
  ...["standard", "remastered-2026"].map((slug) => ({
    id: "EX-EDITIONS-" + slug,
    input: obs({
      subject: { kind: "game_edition", edition_key: "mgpl:fixture-quest/" + slug },
      field: "edition_title",
      value: "Fixture Quest",
      unit: null,
    }),
    valid: true,
    assessment: "current",
  })),
  {
    id: "EX-STALE",
    input: obs({
      subject: listing,
      field: "listing_version",
      value: "1.0",
      unit: null,
      source: appleSource,
      observed_at: "2026-10-14",
    }),
    valid: true,
    assessment: "stale",
  },
];
const fixturePage = (name: string) => ({
  source_id: "publisher-pages",
  url: "https://publisher.example/fixture-quest/" + name,
  source_version: null,
});
const unavailable = obs({
  value_state: "unknown",
  value: null,
  basis: null,
  unknown_reason: "source_unavailable",
  observed_at: "2026-10-20",
});
const retired = obs({
  value_state: "unknown",
  value: null,
  basis: null,
  unknown_reason: "not_published",
});
const retained = [
  obs({ observed_at: "2026-10-15" }),
  unavailable,
  obs({ value: 6, source: fixturePage("launch"), observed_at: "2026-10-18" }),
];
const globalReadings = [
  obs({ field: "requires_os_min_release", value: "10", unit: null, country: "GLOBAL" }),
  obs({
    field: "requires_os_min_release",
    value: "11",
    unit: null,
    country: "ZA",
    source: fixturePage("za"),
  }),
];
const withdrawnRegister: SourceRegisterView = {
  ...TEST_REGISTER,
  entries: TEST_REGISTER.entries.map((s) =>
    s.id === "publisher-pages" ? { ...s, withdrawn_at: "2026-10-20" } : s,
  ),
};
CONTRACT_EXAMPLES.push(
  {
    id: "EX-CONFLICT",
    input: obs(),
    valid: true,
    observations: [obs(), obs({ value: 6, source: fixturePage("launch") })],
    assessment: "conflicting",
  },
  {
    id: "EX-WITHDRAWN",
    input: obs(),
    valid: false,
    reasons: ["collection_not_permitted"],
    register: withdrawnRegister,
    observations: [obs()],
    assessment: "withdrawn",
  },
  {
    id: "EX-RETAINED",
    input: retained[0],
    valid: true,
    observations: retained,
    assessment: "conflicting",
  },
  {
    id: "EX-GLOBAL-CONTRA",
    input: globalReadings[0],
    valid: true,
    observations: globalReadings,
    assessment: "conflicting",
  },
  {
    id: "EX-DISJOINT",
    input: obs(),
    valid: true,
    observations: [obs(), obs({ value: 6, country: "ID", source: fixturePage("id") })],
    assessment: "current",
  },
  {
    id: "EX-SCOPE",
    input: obs({
      subject: fixturePair,
      field: "native_edition_support",
      value_state: "unknown",
      value: null,
      basis: null,
      unknown_reason: "subject_ambiguous",
      unit: null,
    }),
    valid: true,
    assessment: "unknown",
  },
  {
    id: "EX-CLASS",
    input: obs({
      subject: { kind: "game_edition", edition_key: "mgpl:fixture-quest/standard" },
      field: "edition_title",
      value: "Fixture Quest",
      unit: null,
    }),
    valid: true,
    assessment: "current",
  },
  {
    id: "EX-SOLE",
    input: retired,
    valid: true,
    observations: [obs({ observed_at: "2026-10-15" }), retired],
    assessment: "unknown",
  },
  {
    id: "EX-ASOF",
    input: obs(),
    valid: true,
    observations: [
      obs({ observed_at: "2026-10-20", source: fixturePage("one") }),
      obs({ source: fixturePage("two") }),
      obs({ observed_at: "2026-10-21T08:15:00Z", source: fixturePage("three") }),
    ],
    assessment: "current",
  },
);
// This is the sole test-policy constructor. Every host must be a reserved test name.
export function guardPolicy(overrides: Partial<GuardPolicy> = {}): GuardPolicy {
  const p = {
    hosts: ["api.fixture.test"],
    paths: ["/lookup"],
    acceptedMediaTypes: ["application/json"],
    minIntervalMs: 0,
    userAgent: "MGPL fixture",
    ...overrides,
  };
  if (p.hosts.some((h) => !/(\.(test|example|invalid))$/.test(h)))
    throw new Error("non-reserved fixture host");
  return p;
}
export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
  gzip?: boolean;
  chunks?: Buffer[];
  skipLookup?: boolean;
  skipConnect?: boolean;
  doubleLookup?: boolean;
  peer?: string | null;
  port?: number;
  responsePeer?: string;
  error?: string;
  hang?: boolean;
  receiptDelay?: number;
}
export function transportHarness(
  replies: Reply[] = [{}],
  addresses: Array<{ address: string; family: 4 | 6 }> = [{ address: "8.8.8.8", family: 4 }],
) {
  let clock = FIXTURE_NOW.getTime();
  let resolverIndex = 0;
  const counters = {
    requests: 0,
    lookups: 0,
    resolves: 0,
    connects: 0,
    bytes: 0,
    reads: 0,
    starts: [] as number[],
    options: [] as any[],
  };
  const answers: Array<Array<{ address: string; family: 4 | 6 }> | Error> = [addresses];
  const request = ((options: any, onResponse: (res: any) => void) => {
    const index = counters.requests++;
    counters.starts.push(clock);
    counters.options.push(options);
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    const req = new EventEmitter() as any;
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
      return req;
    };
    req.end = () => {
      queueMicrotask(() => {
        const socket = new EventEmitter() as any;
        socket.remoteAddress =
          reply.peer === null ? undefined : (reply.peer ?? addresses[0]?.address);
        socket.remotePort = reply.port ?? 443;
        socket.destroy = () => {
          req.destroyed = true;
        };
        req.emit("socket", socket);
        const proceed = (error?: Error | null) => {
          if (error) {
            req.emit("error", error);
            return;
          }
          if (req.destroyed) return;
          if (!reply.skipConnect) {
            counters.connects++;
            socket.emit("connect");
          }
          if (req.destroyed) return;
          counters.bytes += 1;
          if (reply.error) {
            req.emit("error", Object.assign(new Error("fixture"), { code: reply.error }));
            return;
          }
          if (reply.hang) return;
          clock += reply.receiptDelay ?? 0;
          const res = new PassThrough() as any;
          res.statusCode = reply.status ?? 200;
          res.headers = { "content-type": "application/json", ...reply.headers };
          res.socket = reply.responsePeer
            ? { remoteAddress: reply.responsePeer, remotePort: 443 }
            : socket;
          if (reply.gzip) res.headers["content-encoding"] = "gzip";
          res.on("newListener", (event: string) => {
            if (event === "data") counters.reads++;
          });
          onResponse(res);
          if (res.destroyed) return;
          const raw = Buffer.isBuffer(reply.body)
            ? reply.body
            : Buffer.from(reply.body ?? '{"fixture":true}');
          const chunks = reply.chunks ?? [reply.gzip ? gzipSync(raw) : raw];
          for (const chunk of chunks) {
            if (!res.destroyed) res.write(chunk);
          }
          if (!res.destroyed) res.end();
        };
        if (reply.skipLookup) {
          proceed();
          return;
        }
        counters.lookups++;
        options.lookup(options.host, { all: true }, (error: Error | null) => {
          if (error) {
            proceed(error);
            return;
          }
          if (reply.doubleLookup) {
            counters.lookups++;
            options.lookup(options.host, { all: true }, proceed);
          } else proceed();
        });
      });
    };
    return req;
  }) as GuardDeps["request"];
  const deps: GuardDeps = {
    request,
    resolve: async () => {
      counters.resolves++;
      const answer = answers[Math.min(resolverIndex++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => 1,
  };
  return {
    deps,
    counters,
    answers,
    advance: (ms: number) => {
      clock += ms;
    },
    get clock() {
      return clock;
    },
  };
}
