// WU-009a (#158): the catalogue ingest, offline. The global fetch throws for the whole file; every
// network call goes through an injected stub, and every file is written to a temporary folder.
// cspell:words nohome notmp categoryid xids igdb TESTKEY eadditionallanguage steamos elanguage categoryids wikidata appdetails oldid jsonl wikibase enwiki sers normalisation SPARQL licence Voidheart GOTY Aspyr Lucasfilm LucasArts Fulqrum Firaxis skos precomposed normalises stanbul kala
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const dir = "../../scripts/catalogue";
let lib: any;
let wd: any;
let steam: any;
let agree: any;
const realFetch = globalThis.fetch;
const tmp: string[] = [];

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("network access in a catalogue unit test");
  }) as typeof fetch;
  lib = await import(`${dir}/lib.mjs`);
  wd = await import(`${dir}/wikidata-ingest.mjs`);
  steam = await import(`${dir}/steam-ingest.mjs`);
  agree = await import(`${dir}/agreement.mjs`);
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true });
});

function dataDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), "catalogue-"));
  tmp.push(d);
  return d;
}
const lines = (f: string) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const E = "http://www.wikidata.org/entity/";
const lit = (value: string) => ({ type: "literal", value });
const uri = (value: string) => ({ type: "uri", value });

function hollowKnightBinding(sep: string) {
  return {
    item: uri(`${E}Q22955270`),
    rev: lit("2234567890"),
    label: lit("Hollow Knight"),
    enwiki: uri("https://en.wikipedia.org/wiki/Hollow_Knight"),
    steams: lit("367520"),
    dates: lit(
      ["2017-02-24T00:00:00Z/11", "2017-02-24T00:00:00Z/11", "2018-06-12T00:00:00Z/11"].join(sep),
    ),
    plats: lit([`Q1406=Microsoft Windows`, `Q14116=macOS`, `Q19610114=Nintendo Switch`].join(sep)),
    devs: lit(`Q24259474=Team Cherry`),
    pubs: lit(`Q24259474=Team Cherry`),
    sers: lit(""),
    gens: lit(`Q1342372=Metroidvania`),
  };
}

// A Steam Web API GetItems store item, shaped like the operator's probe of 2026-10-09 (WU-009a3).
// It carries fields MGPL must not keep (description, price) so the tests can check they are dropped.
const hollowItem = {
  item_type: 0,
  id: 367520,
  success: 1,
  visible: true,
  name: "Hollow Knight",
  store_url_path: "app/367520/Hollow_Knight",
  appid: 367520,
  type: 0,
  basic_info: {
    short_description: "Forge your own path...",
    developers: [{ name: "Team Cherry", creator_clan_account_id: 1 }],
    publishers: [{ name: "Team Cherry", creator_clan_account_id: 1 }],
    franchises: [{ name: "Hollow Knight" }],
  },
  release: { steam_release_date: 1487923200 },
  platforms: { windows: true, mac: true, steamos_linux: true, steam_deck_compat_category: 3 },
  categories: {
    supported_player_categoryids: [2],
    feature_categoryids: [22, 23, 79],
    controller_categoryids: [28],
  },
  supported_languages: [
    { elanguage: 0, eadditionallanguage: -1, supported: true, full_audio: false, subtitles: true },
    {
      elanguage: 1,
      eadditionallanguage: -1,
      supported: false,
      full_audio: false,
      subtitles: false,
    },
  ],
  reviews: {
    summary_filtered: {
      review_count: 400000,
      percent_positive: 97,
      review_score: 9,
      review_score_label: "Overwhelmingly Positive",
    },
  },
  best_purchase_option: { formatted_final_price: "$14.99", final_price_in_cents: "1499" },
};

describe("source links", () => {
  it("points each source at the exact version read", () => {
    expect(lib.wikidataRevisionUrl("Q22955270", 2234567890)).toBe(
      "https://www.wikidata.org/w/index.php?title=Q22955270&oldid=2234567890",
    );
    expect(lib.steamAppUrl("367520")).toBe("https://store.steampowered.com/app/367520/");
    expect(lib.wikipediaRevisionUrl("Hollow Knight", 123)).toBe(
      "https://en.wikipedia.org/w/index.php?title=Hollow_Knight&oldid=123",
    );
  });
  it("refuses identifiers that would build a different link", () => {
    expect(() => lib.wikidataItemUrl("Q0")).toThrow();
    expect(() => lib.wikidataRevisionUrl("Q1", "12a")).toThrow();
    expect(() => lib.steamAppUrl("367520/../x")).toThrow();
    expect(() => wd.detailsQuery(["Q1", "Q2 } DELETE {"])).toThrow();
  });
});

describe("normalisation and dates", () => {
  it("compares titles and companies loosely, keeping stored spelling unchanged", () => {
    expect(lib.normTitle("Hollow Knight™")).toBe(lib.normTitle("hollow knight"));
    expect(lib.normTitle("Ratchet & Clank")).toBe("ratchet and clank");
    expect(lib.normCompany("Team Cherry Pty Ltd")).toBe("team cherry");
    expect(lib.normCompany("Inc")).toBe("inc");
  });
  it("parses Steam's date shapes and rejects impossible dates", () => {
    expect(lib.parseSteamDate("24 Feb, 2017")).toEqual({ iso: "2017-02-24", precision: "day" });
    expect(lib.parseSteamDate("Feb 24, 2017")).toEqual({ iso: "2017-02-24", precision: "day" });
    expect(lib.parseSteamDate("February 2017")).toEqual({ iso: "2017-02", precision: "month" });
    expect(lib.parseSteamDate("2017")).toEqual({ iso: "2017", precision: "year" });
    expect(lib.parseSteamDate("31 Feb, 2017")).toBeNull();
    expect(lib.parseSteamDate("Coming soon")).toBeNull();
  });
  it("reads Wikidata precision and compares at the coarser precision", () => {
    expect(lib.parseWikidataDate("+2017-02-24T00:00:00Z", 11)).toEqual({
      iso: "2017-02-24",
      precision: "day",
    });
    expect(lib.parseWikidataDate("2017-00-00T00:00:00Z", 9)).toEqual({
      iso: "2017",
      precision: "year",
    });
    expect(lib.parseWikidataDate("2017-02-24T00:00:00Z", 8)).toBeNull();
    expect(
      lib.datesAgree({ iso: "2017", precision: "year" }, { iso: "2017-02-24", precision: "day" }),
    ).toBe(true);
    expect(lib.datesAgree({ iso: "2017-02-23" }, { iso: "2017-02-24" })).toBe(false);
  });
});

describe("politeFetcher", () => {
  function clock() {
    let t = 0;
    const waits: number[] = [];
    return { now: () => t, sleep: async (ms: number) => void (waits.push(ms), (t += ms)), waits };
  }
  const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(headers),
      json: async () => body,
    }) as any;

  it("spaces requests, identifies itself, and retries 429 after Retry-After", async () => {
    const c = clock();
    const seen: any[] = [];
    const replies = [
      json(429, {}, { "retry-after": "7" }),
      json(200, { a: 1 }),
      json(200, { b: 2 }),
    ];
    const f = lib.politeFetcher({
      fetchImpl: async (url: string, init: any) => (seen.push({ url, init }), replies.shift()),
      minIntervalMs: 1600,
      sleep: c.sleep,
      now: c.now,
      env: { CATALOGUE_CONTACT: "ops@example.invalid" },
    });
    expect(await f("https://x.invalid/1")).toEqual({ a: 1 });
    expect(await f("https://x.invalid/2")).toEqual({ b: 2 });
    expect(c.waits).toEqual([7000, 1600]);
    expect(seen[0].init.headers["User-Agent"]).toBe(
      "MGPL-catalogue-ingest/1.0 (ops@example.invalid)",
    );
  });
  it("reads an HTTP-date Retry-After against its own clock, and backs off on a bad one", async () => {
    const start = Date.parse("2026-10-08T12:00:00Z");
    let t = start;
    const waits: number[] = [];
    const replies = [
      json(429, {}, { "retry-after": "Thu, 08 Oct 2026 12:02:00 GMT" }),
      json(503, {}, { "retry-after": "soon" }),
      json(200, { ok: true }),
    ];
    const f = lib.politeFetcher({
      fetchImpl: async () => replies.shift(),
      minIntervalMs: 0,
      baseBackoffMs: 30_000,
      sleep: async (ms: number) => void (waits.push(ms), (t += ms)),
      now: () => t,
    });
    expect(await f("https://x.invalid/")).toEqual({ ok: true });
    expect(waits).toEqual([120_000, 60_000]);
    expect(lib.retryAfterMs("Thu, 08 Oct 2026 11:00:00 GMT", start)).toBe(0);
    expect(lib.retryAfterMs("120", start)).toBe(120_000);
    expect(lib.retryAfterMs("", start)).toBeNull();
    expect(lib.retryAfterMs("-5", start)).toBeNull();
    expect(lib.retryAfterMs(null, start)).toBeNull();
  });
  it("gives up after its retries, and does not retry a 404", async () => {
    const c = clock();
    const f = lib.politeFetcher({
      fetchImpl: async () => json(503),
      minIntervalMs: 0,
      maxRetries: 2,
      baseBackoffMs: 10,
      sleep: c.sleep,
      now: c.now,
    });
    await expect(f("https://x.invalid/")).rejects.toThrow(/HTTP 503 after 3 attempts/);
    let calls = 0;
    const g = lib.politeFetcher({
      fetchImpl: async () => (calls++, json(404)),
      minIntervalMs: 0,
      sleep: c.sleep,
      now: c.now,
    });
    await expect(g("https://x.invalid/")).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });
  it("refuses a second request while one is in flight", async () => {
    let release: () => void = () => {};
    const f = lib.politeFetcher({
      fetchImpl: () => new Promise((r) => (release = () => r(json(200)))),
      minIntervalMs: 0,
    });
    const first = f("https://x.invalid/1");
    await expect(f("https://x.invalid/2")).rejects.toThrow(/one request at a time/);
    release();
    await first;
  });
});

describe("Wikidata ingest", () => {
  it("turns a SPARQL row into a record with its revision link", () => {
    const rec = wd.toRecord(hollowKnightBinding(wd.SEP), "2026-10-08T00:00:00.000Z");
    expect(rec.qid).toBe("Q22955270");
    expect(rec.release_dates).toEqual([
      { iso: "2017-02-24", precision: "day" },
      { iso: "2018-06-12", precision: "day" },
    ]);
    expect(rec.platforms.map((p: any) => p.id)).toEqual(["Q1406", "Q14116", "Q19610114"]);
    expect(rec.steam_app_ids).toEqual(["367520"]);
    expect(rec.enwiki).toBe("Hollow Knight");
    expect(rec.source).toMatchObject({
      licence: "CC0-1.0",
      revision_url: "https://www.wikidata.org/w/index.php?title=Q22955270&oldid=2234567890",
    });
  });
  it("lists items, then fetches details in batches by POST, and resumes where it stopped", async () => {
    const d = dataDir();
    const calls: any[] = [];
    const fetchJson = async (url: string, init: any) => {
      calls.push({ url, init });
      const q = new URLSearchParams(init.body).get("query") as string;
      if (q === wd.LIST_QUERY)
        return {
          results: {
            bindings: ["Q3", "Q1", "Q2", "Q1"].map((id, i) => ({
              item: uri(`${E}${id}`),
              rev: lit(String(100 + i)),
            })),
          },
        };
      const ids = [...q.matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
      return {
        results: {
          bindings: ids.map((id) => ({
            item: uri(`${E}${id}`),
            rev: lit("5"),
            label: lit(`Game ${id}`),
          })),
        },
      };
    };
    expect(await wd.list({ dataDir: d, fetchJson })).toEqual({ items: 3 });
    expect(lines(path.join(d, "wikidata-ids.jsonl")).map((r) => r.qid)).toEqual(["Q1", "Q2", "Q3"]);
    expect(calls[0]).toMatchObject({
      url: "https://query.wikidata.org/sparql",
      init: { method: "POST" },
    });

    expect(await wd.details({ dataDir: d, fetchJson, limit: 2, batch: 1 })).toMatchObject({
      requested: 2,
      written: 2,
      remaining: 1,
    });
    // One list query, then two queries per batch (details and release events).
    expect(calls.length).toBe(5);
    expect(await wd.details({ dataDir: d, fetchJson })).toMatchObject({
      requested: 1,
      written: 1,
      remaining: 0,
    });
    expect(lines(path.join(d, "wikidata.jsonl")).map((r) => r.qid)).toEqual(["Q1", "Q2", "Q3"]);
  });
  it("refuses a batch size below 1 before making any request", async () => {
    const d = dataDir();
    writeFileSync(path.join(d, "wikidata-ids.jsonl"), JSON.stringify({ qid: "Q1" }) + "\n");
    let calls = 0;
    const fetchJson = async () => (calls++, { results: { bindings: [] } });
    for (const batch of [Number.NaN, 0, -1, 1.5])
      await expect(wd.details({ dataDir: d, fetchJson, batch })).rejects.toThrow(/--batch must be/);
    await expect(
      wd.main(["details", "--data-dir", d, "--batch", "0"], { fetchJson }),
    ).rejects.toThrow(/--batch must be/);
    expect(calls).toBe(0);
  });
  it("resumes after an interrupted write, and stops on an earlier bad record", async () => {
    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata-ids.jsonl"),
      ["Q1", "Q2", "Q3"].map((qid) => JSON.stringify({ qid })).join("\n") + "\n",
    );
    const out = path.join(d, "wikidata.jsonl");
    writeFileSync(out, JSON.stringify({ qid: "Q1" }) + "\n" + '{"qid":"Q2","lab');
    const asked: string[][] = [];
    const logs: string[] = [];
    const fetchJson = async (_url: string, init: any) => {
      const ids = [
        ...(new URLSearchParams(init.body).get("query") as string).matchAll(/wd:(Q\d+)/g),
      ].map((m) => m[1]);
      asked.push(ids);
      return {
        results: { bindings: ids.map((id) => ({ item: uri(`${E}${id}`), rev: lit("5") })) },
      };
    };
    expect(
      await wd.details({ dataDir: d, fetchJson, log: (x: string) => logs.push(x) }),
    ).toMatchObject({
      requested: 2,
      written: 2,
      remaining: 0,
    });
    expect(asked).toEqual([
      ["Q2", "Q3"],
      ["Q2", "Q3"],
    ]);
    expect(logs[0]).toMatch(/dropped an incomplete last record/);
    expect(lines(out).map((r) => r.qid)).toEqual(["Q1", "Q2", "Q3"]);

    // A complete last record without its newline is kept, and the newline added.
    const kept = path.join(d, "kept.jsonl");
    writeFileSync(kept, '{"a":1}\n{"a":2}');
    expect(lib.resumeJsonl(kept)).toEqual({ records: [{ a: 1 }, { a: 2 }], dropped: null });
    expect(readFileSync(kept, "utf8")).toBe('{"a":1}\n{"a":2}\n');

    // A bad record before the last one is an error, and the file is left as it was.
    const bad = path.join(d, "bad.jsonl");
    const badText = '{"a":1}\nnot json\n{"a":3}\n{"a":';
    writeFileSync(bad, badText);
    expect(() => lib.resumeJsonl(bad)).toThrow(/line 2 is not JSON/);
    expect(readFileSync(bad, "utf8")).toBe(badText);
    const badComplete = path.join(d, "bad-complete.jsonl");
    const badCompleteText = '{"a":1}\nnot json\n{"a":3}';
    writeFileSync(badComplete, badCompleteText);
    expect(() => lib.resumeJsonl(badComplete)).toThrow(/line 2 is not JSON/);
    expect(readFileSync(badComplete, "utf8")).toBe(badCompleteText);
  });
  it("refuses to fetch details before the list exists", async () => {
    await expect(wd.details({ dataDir: dataDir(), fetchJson: async () => ({}) })).rejects.toThrow(
      /run the list step first/,
    );
  });
});

describe("Steam ingest", () => {
  it("keeps facts only, with the store link", () => {
    const rec = steam.toRecord(hollowItem, "2026-10-08T00:00:00.000Z");
    expect(rec).toMatchObject({
      appid: "367520",
      success: true,
      type: "game",
      name: "Hollow Knight",
      release_date: { parsed: { iso: "2017-02-24", precision: "day" }, coming_soon: false },
      original_release_date: null,
      developers: ["Team Cherry"],
      publishers: ["Team Cherry"],
      franchises: ["Hollow Knight"],
      platforms: ["windows", "mac", "linux"],
      steam_deck_compat_category: 3,
      categories: { player: [2], feature: [22, 23, 79], controller: [28] },
      languages: [{ elanguage: 0, full_audio: false, subtitles: true }],
      reviews: { review_count: 400000, percent_positive: 97 },
      source: {
        name: "steam",
        route: "Steam Web API IStoreBrowseService/GetItems/v1",
        url: "https://store.steampowered.com/app/367520/",
      },
    });
    expect(JSON.stringify(rec)).not.toMatch(/Forge your own path|14\.99|1499|purchase/);
    expect(steam.toRecord({ id: 90, success: 15, appid: 0 }, "t")).toMatchObject({
      appid: "90",
      success: false,
      steam_status: 15,
    });
  });
});

describe("agreement", () => {
  const w = (over: any = {}) => ({
    qid: "Q22955270",
    label: "Hollow Knight",
    release_dates: [{ iso: "2017-02-24", precision: "day" }],
    platforms: [
      { id: "Q1406", label: "Microsoft Windows" },
      { id: "Q14116", label: "macOS" },
      { id: "Q388", label: "Linux" },
    ],
    developers: [{ id: "Q24259474", label: "Team Cherry" }],
    publishers: [{ id: "Q24259474", label: "Team Cherry" }],
    steam_app_ids: ["367520"],
    source: {
      name: "wikidata",
      url: "u",
      revision_url: "https://www.wikidata.org/w/index.php?title=Q22955270&oldid=1",
      fetched_at: "t",
    },
    ...over,
  });
  const s = (over: any = {}) => ({ ...steam.toRecord(hollowItem, "t"), ...over });

  it("agrees when both sources match, and links both", () => {
    const r = agree.compare(w(), s());
    for (const f of agree.FIELDS) expect(r.fields[f].status).toBe("agree");
    expect(r.fields.platforms.value).toEqual(["linux", "mac", "windows"]);
    expect(r.fields.release_date.single_source).toBeUndefined();
    expect(r.fields.title.sources.map((x: any) => x.url)).toEqual([
      "https://www.wikidata.org/w/index.php?title=Q22955270&oldid=1",
      "https://store.steampowered.com/app/367520/",
    ]);
  });
  it("sends disagreement to the review queue and never picks a winner", () => {
    const r = agree.compare(
      // Steam's store date (2017-02-24) is before every Wikidata release event: a real disagreement.
      w({ release_dates: [{ iso: "2018-06-12", precision: "day" }] }),
      s({ developers: ["Someone Else"], name: "Hollow Knight: Voidheart Edition" }),
    );
    expect(r.fields.release_date).toMatchObject({ status: "conflict", value: null });
    expect(r.fields.developers).toMatchObject({ status: "conflict", value: null });
    expect(r.fields.title).toMatchObject({ status: "conflict", value: null });
  });
  it("agrees on a date only at the precision both sources give", () => {
    const cases: [any, any, any, string][] = [
      [
        { iso: "2017", precision: "year" },
        { iso: "2017-02-24", precision: "day" },
        { iso: "2017", precision: "year" },
        "steam",
      ],
      [
        { iso: "2017-02-24", precision: "day" },
        { iso: "2017", precision: "year" },
        { iso: "2017", precision: "year" },
        "wikidata",
      ],
      [
        { iso: "2017-02", precision: "month" },
        { iso: "2017-02-24", precision: "day" },
        { iso: "2017-02", precision: "month" },
        "steam",
      ],
      [
        { iso: "2017-02-24", precision: "day" },
        { iso: "2017-02", precision: "month" },
        { iso: "2017-02", precision: "month" },
        "wikidata",
      ],
    ];
    for (const [wDate, sDate, common, finer] of cases) {
      const r = agree.compare(
        w({ release_dates: [wDate] }),
        s({ release_date: { raw: "x", coming_soon: false, parsed: sDate } }),
      ).fields.release_date;
      expect(r.status).toBe("agree");
      expect(r.value).toEqual(common);
      expect(r.single_source).toMatchObject({
        source: finer,
        value: wDate.iso.length > sDate.iso.length ? wDate : sDate,
      });
      expect(r.single_source.link.url).toBe(
        finer === "steam"
          ? "https://store.steampowered.com/app/367520/"
          : "https://www.wikidata.org/w/index.php?title=Q22955270&oldid=1",
      );
    }
  });
  it("sends a partial overlap of lists to review, keeping the shared values apart", () => {
    const r = agree.compare(
      w({
        developers: [
          { id: "Q1", label: "Alpha" },
          { id: "Q2", label: "Beta" },
        ],
        platforms: [
          { id: "Q1406", label: "Microsoft Windows" },
          { id: "Q388", label: "Linux" },
        ],
      }),
      s({ developers: ["Alpha", "Gamma"], platforms: ["windows", "mac"] }),
    );
    expect(r.fields.developers).toMatchObject({
      status: "partial",
      value: ["Alpha"],
      unmatched: { wikidata: ["Beta"], steam: ["Gamma"] },
    });
    expect(r.fields.platforms).toMatchObject({
      status: "partial",
      value: ["windows"],
      unmatched: { wikidata: ["linux"], steam: ["mac"] },
    });

    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      JSON.stringify(
        w({
          developers: [
            { id: "Q1", label: "Alpha" },
            { id: "Q2", label: "Beta" },
          ],
        }),
      ) + "\n",
    );
    writeFileSync(
      path.join(d, "steam.jsonl"),
      JSON.stringify(s({ developers: ["Alpha", "Gamma"] })) + "\n",
    );
    const summary = agree.run({ dataDir: d });
    expect(summary.conflicts).toBe(1);
    expect(summary.fields.developers).toEqual({
      agree: 0,
      partial: 1,
      conflict: 0,
      distinct: 0,
      single: 0,
      none: 0,
    });
    expect(lines(path.join(d, "conflicts.jsonl"))).toEqual([
      expect.objectContaining({
        field: "developers",
        kind: "partial",
        agreed: ["Alpha"],
        unmatched: { wikidata: ["Beta"], steam: ["Gamma"] },
      }),
    ]);
  });
  it("marks one-source and empty fields, and skips non-game Steam records", () => {
    const r = agree.compare(w({ publishers: [] }), null);
    expect(r.fields.title.status).toBe("single");
    expect(r.fields.publishers.status).toBe("none");
    const dlc = new Map([["367520", s({ type: "dlc" })]]);
    expect(agree.pickSteam(w(), dlc)).toBeNull();
  });
  it("writes the agreement, the review queue and the counts", () => {
    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      [w(), w({ qid: "Q2", label: "Other", steam_app_ids: [] })]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    writeFileSync(path.join(d, "steam.jsonl"), JSON.stringify(s({ developers: ["Nope"] })) + "\n");
    const summary = agree.run({ dataDir: d });
    expect(summary).toMatchObject({
      items: 2,
      with_steam_id: 1,
      with_steam_record: 1,
      conflicts: 1,
    });
    expect(summary.fields.developers).toEqual({
      agree: 0,
      partial: 0,
      conflict: 1,
      distinct: 0,
      single: 1,
      none: 0,
    });
    expect(lines(path.join(d, "conflicts.jsonl"))).toEqual([
      expect.objectContaining({
        qid: "Q22955270",
        field: "developers",
        kind: "conflict",
        values: { wikidata: ["Team Cherry"], steam: ["Nope"] },
      }),
    ]);
  });
});

describe("WU-009a2: compare only what describes the same thing", () => {
  const src = (url: string) => ({ name: "wikidata", url, revision_url: url, fetched_at: "t" });
  const base = (over: any = {}) => ({
    qid: "Q1",
    label: "Game",
    release_events: [],
    platforms: [],
    developers: [],
    publishers: [],
    steam_app_ids: ["10"],
    source: src("https://www.wikidata.org/w/index.php?title=Q1&oldid=1"),
    ...over,
  });
  const st = (over: any = {}) => ({
    appid: "10",
    success: true,
    type: "game",
    name: "Game",
    release_date: { raw: "x", coming_soon: false, parsed: null },
    developers: [],
    publishers: [],
    platforms: [],
    genres: [],
    source: { name: "steam", url: "https://store.steampowered.com/app/10/", fetched_at: "t" },
    ...over,
  });
  const day = (iso: string) => ({ iso, precision: "day" });
  const ev = (iso: string, platforms: string[] = [], places: string[] = []) => ({
    iso,
    precision: "day",
    platforms,
    places,
  });

  it("removes only Steam's edition labels before comparing titles", () => {
    expect(
      lib.stripSteamEdition("The Elder Scrolls IV: Oblivion® Game of the Year Edition (2009)"),
    ).toEqual({
      title: "The Elder Scrolls IV: Oblivion®",
      removed: ["Game of the Year Edition", "(2009)"],
    });
    expect(lib.stripSteamEdition("STAR WARS™ Battlefront II (Classic, 2005)").title).toBe(
      "STAR WARS™ Battlefront II",
    );
    expect(lib.stripSteamEdition("Age of Empires II: Definitive Edition").removed).toEqual([]);
    expect(lib.stripSteamEdition("(2009)").removed).toEqual([]);
    const t = (w: string, s: string) =>
      agree.compare(base({ label: w }), st({ name: s })).fields.title;
    expect(
      t("Call of Duty 4: Modern Warfare", "Call of Duty® 4: Modern Warfare® (2007)"),
    ).toMatchObject({
      status: "agree",
      basis: expect.stringMatching(/edition label/),
    });
    expect(t("Star Wars: Battlefront II", "STAR WARS™ Battlefront II (Classic, 2005)").status).toBe(
      "agree",
    );
    expect(t("Age of Empires II", "Age of Empires II: Definitive Edition").status).toBe("conflict");
    expect(t("Freedom Force vs the 3rd Reich", "Freedom Force vs. the Third Reich").status).toBe(
      "conflict",
    );
  });

  it("compares a Steam date only with a Windows or unqualified release event", () => {
    const d = (events: any[], steamIso: string) =>
      agree.compare(
        base({ release_events: events }),
        st({ release_date: { raw: "x", coming_soon: false, parsed: day(steamIso) } }),
      ).fields.release_date;
    // A Windows event matches, even when it is not the earliest.
    expect(
      d([ev("2005-10-31", ["Q10683"]), ev("2005-11-01", ["Q1406"])], "2005-11-01"),
    ).toMatchObject({
      status: "agree",
      value: day("2005-11-01"),
      basis: expect.stringMatching(/for Windows; not the earliest/),
    });
    // An event for another platform with the same date is not evidence: here it is a conflict.
    expect(
      d([ev("2005-11-01", ["Q10683"]), ev("2006-01-01", ["Q1406"])], "2005-11-01").status,
    ).toBe("conflict");
    // Later than every event: a different release, kept apart and not queued.
    expect(d([ev("1992-05-05"), ev("1994-02-10", ["Q1406"])], "2007-08-03")).toMatchObject({
      status: "distinct",
      value: null,
      single_source: { source: "wikidata", value: day("1992-05-05") },
    });
    // Before any event: a real disagreement.
    expect(d([ev("2009-01-01")], "2008-03-12").status).toBe("conflict");
    // No Wikidata event: Steam's store date says nothing about the original release.
    expect(d([], "2008-03-12").status).toBe("none");
  });

  it("keeps Steam's store facts apart, scoped to the app and the fetch time", () => {
    const r = agree.compare(
      base({ release_events: [ev("1992-05-05")] }),
      st({
        publishers: ["Bethesda Softworks"],
        release_date: { raw: "3 Aug, 2007", coming_soon: false, parsed: day("2007-08-03") },
      }),
    );
    expect(r.store).toEqual({
      scope: "Steam app 10, as listed at the fetch time",
      steam_store_release_date: {
        value: day("2007-08-03"),
        raw: "3 Aug, 2007",
        coming_soon: false,
      },
      steam_store_publishers: ["Bethesda Softworks"],
      steam_original_release_date: null,
      source: { name: "steam", url: "https://store.steampowered.com/app/10/", fetched_at: "t" },
    });
    expect(agree.compare(base(), null).store).toBeNull();
  });

  it("matches renamed companies through their Wikidata names, and says so", () => {
    const names = agree.companyNames([
      { qid: "Q5", names: ["Lucasfilm Games", "LucasArts", "LucasArts Entertainment Company LLC"] },
    ]);
    const lucas = [{ id: "Q5", label: "Lucasfilm Games" }];
    const pubs = (steamPubs: string[]) =>
      agree.compare(base({ publishers: lucas }), st({ publishers: steamPubs }), names).fields
        .publishers;
    expect(pubs(["LucasArts"])).toMatchObject({
      status: "agree",
      value: ["Lucasfilm Games"],
      basis: expect.stringMatching(/"LucasArts" = a Wikidata name of Q5/),
    });
    // Steam names a company Wikidata does not: review.
    expect(pubs(["LucasArts", "Disney"])).toMatchObject({
      status: "partial",
      unmatched: { wikidata: [], steam: ["Disney"] },
    });
    // Without the names file, the rename is not matched.
    expect(
      agree.compare(base({ publishers: lucas }), st({ publishers: ["LucasArts"] })).fields
        .publishers.status,
    ).toBe("conflict");
    // Steam's "(Mac)" and "(Linux)" notes; Wikidata's extra port studio stays single-source.
    const devs = agree.compare(
      base({
        developers: [
          { id: "Q7", label: "Firaxis Games" },
          { id: "Q8", label: "Aspyr" },
          { id: "Q9", label: "MacSoft Games" },
        ],
      }),
      st({ developers: ["Firaxis Games", "Aspyr (Mac)", "Aspyr (Linux)"] }),
      names,
    ).fields.developers;
    expect(devs).toMatchObject({
      status: "agree",
      value: ["Firaxis Games", "Aspyr"],
      single_source: { source: "wikidata", values: ["MacSoft Games"] },
    });
  });

  it("agrees on platforms Steam sells that Wikidata also gives, and queues ones it does not", () => {
    const p = (w: string[], s: string[]) =>
      agree.compare(base({ platforms: w.map((id) => ({ id })) }), st({ platforms: s })).fields
        .platforms;
    expect(p(["Q1406", "Q14116", "Q388"], ["windows"])).toMatchObject({
      status: "agree",
      value: ["windows"],
      single_source: { values: ["linux", "mac"] },
    });
    expect(p(["Q1406"], ["windows", "mac"])).toMatchObject({
      status: "partial",
      unmatched: { steam: ["mac"] },
    });
  });

  it("reads companies.jsonl in a run, and queues only what is still unresolved", () => {
    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      JSON.stringify(
        base({
          release_events: [ev("2002-03-26")],
          publishers: [{ id: "Q5", label: "Lucasfilm Games" }],
          developers: [{ id: "Q6", label: "Irrational Games" }],
        }),
      ) + "\n",
    );
    writeFileSync(
      path.join(d, "steam.jsonl"),
      JSON.stringify(
        st({
          publishers: ["LucasArts", "Disney"],
          developers: ["2K Boston"],
          release_date: { raw: "x", coming_soon: false, parsed: day("2009-09-16") },
        }),
      ) + "\n",
    );
    writeFileSync(
      path.join(d, "companies.jsonl"),
      [
        { qid: "Q5", names: ["Lucasfilm Games", "LucasArts"] },
        { qid: "Q6", names: ["Irrational Games", "2K Boston"] },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const logs: string[] = [];
    const summary = agree.main(["--data-dir", d], { log: (x: string) => logs.push(x) });
    expect(logs[0]).toBe("agreement: 1 items, 1 compared with Steam, 1 queued for review");
    expect(summary.companies_with_names).toBe(2);
    expect(summary.fields.release_date.distinct).toBe(1);
    expect(summary.fields.developers.agree).toBe(1);
    expect(lines(path.join(d, "conflicts.jsonl"))).toEqual([
      expect.objectContaining({
        field: "publishers",
        kind: "partial",
        agreed: ["Lucasfilm Games"],
      }),
    ]);
  });
});

describe("WU-009a2 r2: no different product or company becomes an agreement", () => {
  const src = (url: string) => ({ name: "wikidata", url, revision_url: url, fetched_at: "t" });
  const w = (over: any = {}) => ({
    qid: "Q1",
    label: "Game",
    release_events: [],
    platforms: [],
    developers: [],
    publishers: [],
    steam_app_ids: ["10"],
    source: src("https://www.wikidata.org/w/index.php?title=Q1&oldid=1"),
    ...over,
  });
  const s = (over: any = {}) => ({
    appid: "10",
    success: true,
    type: "game",
    name: "Game",
    release_date: { raw: null, coming_soon: false, parsed: null },
    developers: [],
    publishers: [],
    platforms: [],
    genres: [],
    source: { name: "steam", url: "https://store.steampowered.com/app/10/", fetched_at: "t" },
    ...over,
  });
  const company = (qid: string, names: string[], rev = "7") => ({
    qid,
    names,
    source: {
      name: "wikidata",
      url: `https://www.wikidata.org/wiki/${qid}`,
      revision_url: `https://www.wikidata.org/w/index.php?title=${qid}&oldid=${rev}`,
      fetched_at: "2026-10-09T00:00:00.000Z",
    },
  });

  it("removes only the exact edition forms, and never the whole title", () => {
    const r = (x: string) => lib.stripSteamEdition(x).removed;
    expect(r("Game (Remastered 2020)")).toEqual([]);
    expect(r("Game (Definitive Edition 2020)")).toEqual([]);
    expect(r("Game GOTY")).toEqual([]);
    expect(r("Game (Classic)")).toEqual(["(Classic)"]);
    expect(r("Game GOTY Edition")).toEqual(["GOTY Edition"]);
    expect(r("(2009)")).toEqual([]);
    expect(r("GOTY Edition")).toEqual([]);
    const t = agree.compare(w(), s({ name: "Game (Remastered 2020)" })).fields.title;
    expect(t.status).toBe("conflict");
  });

  it("keeps a company's own bracketed text, and drops only Steam's platform notes", () => {
    expect(lib.stripPlatformNote("Aspyr (Mac)")).toBe("Aspyr");
    expect(lib.stripPlatformNote("Aspyr (Linux)")).toBe("Aspyr");
    expect(lib.stripPlatformNote("Studio (UK)")).toBe("Studio (UK)");
    expect(lib.stripPlatformNote("(Mac)")).toBe("(Mac)");
    const pubs = agree.compare(
      w({ publishers: [{ id: "Q2", label: "Studio (UK)" }] }),
      s({ publishers: ["Studio (Japan)"] }),
    ).fields.publishers;
    expect(pubs.status).toBe("conflict");
  });

  it("does not match a name that more than one Wikidata company carries", () => {
    const names = agree.companyNames([
      company("Q2", ["Alpha", "Shared"]),
      company("Q3", ["Beta", "Shared"]),
    ]);
    const two = [
      { id: "Q2", label: "Alpha" },
      { id: "Q3", label: "Beta" },
    ];
    for (const order of [two, [...two].reverse()]) {
      const r = agree.compare(w({ developers: order }), s({ developers: ["Shared"] }), names).fields
        .developers;
      expect(r).toMatchObject({ status: "conflict", value: null });
      expect(r.ambiguous).toEqual([{ steam_name: "Shared", candidates: order.map((e) => e.id) }]);
    }
    // A label on one company and an alias on another is also ambiguous.
    const names2 = agree.companyNames([company("Q3", ["Beta", "Alpha"])]);
    const r2 = agree.compare(w({ developers: two }), s({ developers: ["Alpha", "Beta"] }), names2)
      .fields.developers;
    expect(r2).toMatchObject({ status: "partial", value: ["Beta"] });
    expect(r2.ambiguous).toEqual([{ steam_name: "Alpha", candidates: ["Q2", "Q3"] }]);
    // The same company listed twice is one candidate.
    const r3 = agree.compare(
      w({
        developers: [
          { id: "Q2", label: "Alpha" },
          { id: "Q2", label: "Alpha" },
        ],
      }),
      s({ developers: ["Alpha"] }),
    ).fields.developers;
    expect(r3).toMatchObject({ status: "agree", value: ["Alpha"] });
    expect(r3.single_source).toBeUndefined();
  });

  it("keeps the company revision behind every alias match, into agreement and the review queue", () => {
    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      JSON.stringify(w({ publishers: [{ id: "Q5", label: "Lucasfilm Games" }] })) + "\n",
    );
    writeFileSync(
      path.join(d, "steam.jsonl"),
      JSON.stringify(s({ publishers: ["LucasArts", "Disney"] })) + "\n",
    );
    writeFileSync(
      path.join(d, "companies.jsonl"),
      JSON.stringify(company("Q5", ["Lucasfilm Games", "LucasArts"], "42")) + "\n",
    );
    agree.run({ dataDir: d });
    const rev = "https://www.wikidata.org/w/index.php?title=Q5&oldid=42";
    const rec = lines(path.join(d, "agreement.jsonl"))[0].fields.publishers;
    expect(rec.matches).toEqual([
      {
        steam_name: "LucasArts",
        qid: "Q5",
        method: "alias",
        company_source: { name: "wikidata", url: rev, fetched_at: "2026-10-09T00:00:00.000Z" },
      },
    ]);
    expect(rec.sources.map((x: any) => x.url)).toContain(rev);
    expect(lines(path.join(d, "conflicts.jsonl"))[0]).toMatchObject({
      field: "publishers",
      kind: "partial",
      matches: [
        expect.objectContaining({
          qid: "Q5",
          company_source: expect.objectContaining({ url: rev }),
        }),
      ],
    });
  });

  it("keeps a bracketed legal word and compatibility characters as part of the name", () => {
    expect(lib.normCompany("Studio (AG)")).toBe("studio ag");
    expect(lib.normCompany("Studio, Inc.")).toBe("studio");
    const devs = agree.compare(
      w({ developers: [{ id: "Q2", label: "Studio (AG)" }] }),
      s({ developers: ["Studio"] }),
    ).fields.developers;
    expect(devs.status).toBe("conflict");
    expect(
      agree.compare(w({ label: "Game \u00b2" }), s({ name: "Game 2" })).fields.title.status,
    ).toBe("conflict");
    expect(
      agree.compare(w({ label: "\uff27\uff41\uff4d\uff45" }), s({ name: "Game" })).fields.title
        .status,
    ).toBe("conflict");
    expect(agree.compare(w({ label: "Game+" }), s({ name: "Game" })).fields.title.status).toBe(
      "conflict",
    );
    expect(
      agree.compare(w({ label: "Game: Part 2" }), s({ name: "Game - Part 2" })).fields.title.status,
    ).toBe("agree");
    // Canonical equivalents still agree: a precomposed and a decomposed "e" with an accent.
    expect(
      agree.compare(w({ label: "Pok\u00e9mon" }), s({ name: "Poke\u0301mon" })).fields.title.status,
    ).toBe("agree");
  });

  it("keeps combining marks, and never agrees on a name that normalises to nothing", () => {
    const title = (x: string, y: string) =>
      agree.compare(w({ label: x }), s({ name: y })).fields.title.status;
    expect(title("\u0915\u0932\u093e", "\u0915\u0932")).toBe("conflict");
    expect(title("\u0130stanbul Racer", "Istanbul Racer")).toBe("conflict");
    expect(title("Caf\u00e9 Story", "Cafe Story")).toBe("conflict");
    expect(title("!!!", "???")).toBe("conflict");
    expect(title("!!!", "!!!")).toBe("conflict");
    const devs = agree.compare(
      w({ developers: [{ id: "Q2", label: "Alpha" }] }),
      s({ developers: ["Alpha", "???"] }),
    ).fields.developers;
    expect(devs).toMatchObject({ status: "partial", unmatched: { steam: ["???"] } });
    const kala = agree.compare(
      w({ developers: [{ id: "Q3", label: "\u0915\u0932\u093e Studio" }] }),
      s({ developers: ["\u0915\u0932 Studio"] }),
    ).fields.developers;
    expect(kala.status).toBe("conflict");
  });

  it("keeps symbols: only whitespace, punctuation other than # and the trademark signs are ignored", () => {
    const title = (x: string, y: string) =>
      agree.compare(w({ label: x }), s({ name: y })).fields.title.status;
    for (const sym of ["$", "\u221e", "\u2665", "\u20ac", "+", "#", "\u00b0"])
      expect(title(`Game ${sym}`, "Game")).toBe("conflict");
    expect(title("Game\u2122: The Sequel!", "game - the sequel")).toBe("agree");
    const pubs = agree.compare(
      w({ publishers: [{ id: "Q5", label: "Studio $" }] }),
      s({ publishers: ["Studio"] }),
    ).fields.publishers;
    expect(pubs.status).toBe("conflict");
  });

  it("ignores no character outside the documented categories, across all of Unicode", () => {
    // Every code point: appending it to a title changes the comparison key, unless it is one of
    // the documented ignored characters ("&" is read as "and", so it does change the key).
    // Surrogate halves cannot stand alone and are skipped.
    const ignored = new Set(["\u2122", "\u00ae", "\u00a9"]);
    const documented = (c: string) =>
      ignored.has(c) || (/^[\p{P}\p{Z}\s]$/u.test(c) && c !== "#" && c !== "&");
    const base = lib.normTitle("game");
    const leaks: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const changed = lib.normTitle(`game ${c}`) !== base;
      if (changed === documented(c)) leaks.push(cp.toString(16));
      if (leaks.length > 5) break;
    }
    expect(leaks).toEqual([]);
  });

  it("strips only unambiguous legal designations", () => {
    expect(lib.normCompany("North Company")).toBe("north company");
    expect(lib.normCompany("North Co")).toBe("north co");
    expect(lib.normCompany("North, Inc.")).toBe("north");
    const pubs = agree.compare(
      w({ publishers: [{ id: "Q4", label: "North Company" }] }),
      s({ publishers: ["North"] }),
    ).fields.publishers;
    expect(pubs.status).toBe("conflict");
  });

  it("masks folder paths in any letter case and with either slash", () => {
    const opts = { home: "C:\\Users\\Someone", tmp: "C:\\Users\\Someone\\AppData\\Local\\Temp" };
    for (const p of [
      "C:\\Users\\Someone\\AppData\\Local\\Temp\\x",
      "C:/Users/Someone/AppData/Local/Temp/x",
      "c:\\users\\SOMEONE/appdata\\local/TEMP\\x",
    ]) {
      const out = lib.safeMessage(new Error(`open ${p}`), opts);
      expect(out).toMatch(/^open %TEMP%[\\/]x$/);
      expect(out).not.toMatch(/someone/i);
    }
    expect(lib.safeMessage(new Error("open C:/Users/Someone/doc.txt"), opts)).toBe(
      "open ~/doc.txt",
    );
    expect(lib.safeMessage(new Error("open D:\\Users\\other\\a"), opts)).toBe("open ~\\a");
    expect(lib.safeMessage(new Error("open /home/other/a"), { home: "/root", tmp: "/tmp" })).toBe(
      "open ~/a",
    );
  });

  it("prints no home or temporary folder path in errors", () => {
    const home = path.join(path.sep, "Users", "someone");
    const tmp = path.join(home, "AppData", "Local", "Temp");
    const msg = lib.safeMessage(
      new Error(`ENOENT: no such file, open '${path.join(tmp, "x", "a.jsonl")}' in ${home}`),
      {
        home,
        tmp,
      },
    );
    expect(msg).not.toMatch(/someone/);
    expect(msg).toMatch(/%TEMP%/);
    const d = dataDir();
    const f = path.join(d, "bad.jsonl");
    writeFileSync(f, "not json\n");
    expect(() => lib.readJsonl(f)).toThrow(/^bad\.jsonl: line 1 is not JSON$/);
  });
});

describe("WU-009a2: Wikidata release events, labels and company names", () => {
  it("asks for every non-deprecated release statement with its qualifiers, and English or mul labels", () => {
    const q = wd.releaseEventsQuery(["Q1", "Q2"]);
    expect(q).toMatch(/\?item p:P577 \?st/);
    expect(q).toMatch(/pq:P400/);
    expect(q).toMatch(/pq:P291/);
    expect(q).toMatch(/DeprecatedRank/);
    expect(() => wd.releaseEventsQuery(["Q1 } DELETE"])).toThrow(/not a Wikidata item ID/);
    expect(wd.detailsQuery(["Q1"])).toMatch(/COALESCE\(\?labelEn, \?labelMul\)/);
    expect(wd.companiesQuery(["Q5"])).toMatch(/skos:altLabel/);
    expect(() => wd.companiesQuery(["5"])).toThrow(/not a Wikidata item ID/);
  });
  it("groups release rows by statement, keeping each statement's platforms and places", () => {
    const row = (item: string, st: string, t: string, plat?: string, place?: string) => ({
      item: uri(`${E}${item}`),
      st: uri(`http://www.wikidata.org/entity/statement/${st}`),
      t: lit(t),
      tp: lit("11"),
      ...(plat ? { plat: uri(`${E}${plat}`) } : {}),
      ...(place ? { place: uri(`${E}${place}`) } : {}),
    });
    const m = wd.toReleaseEvents([
      row("Q1", "a", "2007-11-05T00:00:00Z", "Q1406", "Q30"),
      row("Q1", "a", "2007-11-05T00:00:00Z", "Q8093", "Q30"),
      row("Q1", "b", "2007-11-09T00:00:00Z", undefined, "Q46"),
      row("Q2", "c", "bad"),
    ]);
    expect(m.get("Q1")).toEqual([
      { iso: "2007-11-05", precision: "day", platforms: ["Q1406", "Q8093"], places: ["Q30"] },
      { iso: "2007-11-09", precision: "day", platforms: [], places: ["Q46"] },
    ]);
    expect(m.has("Q2")).toBe(false);
  });
  it("stores release events with each record", async () => {
    const d = dataDir();
    writeFileSync(path.join(d, "wikidata-ids.jsonl"), JSON.stringify({ qid: "Q1" }) + "\n");
    const fetchJson = async (_u: string, init: any) => {
      const q = new URLSearchParams(init.body).get("query") as string;
      if (q.includes("p:P577 ?st"))
        return {
          results: {
            bindings: [
              {
                item: uri(`${E}Q1`),
                st: uri("s1"),
                t: lit("2017-02-24T00:00:00Z"),
                tp: lit("11"),
                plat: uri(`${E}Q1406`),
              },
            ],
          },
        };
      return {
        results: { bindings: [{ item: uri(`${E}Q1`), rev: lit("5"), label: lit("Game") }] },
      };
    };
    await wd.details({ dataDir: d, fetchJson });
    expect(lines(path.join(d, "wikidata.jsonl"))[0].release_events).toEqual([
      { iso: "2017-02-24", precision: "day", platforms: ["Q1406"], places: [] },
    ]);
  });
  it("fetches each company's names once, writes one Wikidata returns nothing for, and resumes", async () => {
    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      [
        { qid: "Q1", developers: [{ id: "Q6" }], publishers: [{ id: "Q5" }] },
        { qid: "Q2", developers: [{ id: "Q5" }, { id: "Q7" }], publishers: [] },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const asked: string[][] = [];
    const fetchJson = async (_u: string, init: any) => {
      const q = new URLSearchParams(init.body).get("query") as string;
      const ids = [...q.matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);
      asked.push(ids);
      return {
        results: {
          bindings: ids.flatMap((id) =>
            // Q7 returns no row at all, as for a deleted or redirected item.
            id === "Q7"
              ? []
              : [
                  { c: uri(`${E}${id}`), rev: lit("3"), name: lit(`Name ${id}`) },
                  { c: uri(`${E}${id}`), rev: lit("3"), name: lit(`Alias ${id}`) },
                ],
          ),
        },
      };
    };
    expect(await wd.companies({ dataDir: d, fetchJson, limit: 2, batch: 2 })).toMatchObject({
      requested: 2,
      written: 2,
      remaining: 1,
    });
    expect(await wd.companies({ dataDir: d, fetchJson })).toMatchObject({
      requested: 1,
      written: 1,
      remaining: 0,
    });
    expect(asked).toEqual([["Q5", "Q6"], ["Q7"]]);
    const out = lines(path.join(d, "companies.jsonl"));
    expect(out.map((r) => [r.qid, r.names])).toEqual([
      ["Q5", ["Alias Q5", "Name Q5"]],
      ["Q6", ["Alias Q6", "Name Q6"]],
      ["Q7", []],
    ]);
    expect(out[0].source.revision_url).toBe(
      "https://www.wikidata.org/w/index.php?title=Q5&oldid=3",
    );
    await expect(wd.companies({ dataDir: d, fetchJson, batch: 0 })).rejects.toThrow(
      /--batch must be/,
    );
  });
  it("never prints the data directory's path", async () => {
    const d = dataDir();
    const logs: string[] = [];
    await wd.main(["list", "--data-dir", d], {
      fetchJson: async () => ({ results: { bindings: [] } }),
      log: (x: string) => logs.push(x),
    });
    expect(logs).toEqual(["list: 0 video game items -> wikidata-ids.jsonl"]);
  });
});

describe("WU-009a3: the Steam Web API client", () => {
  const KEY = "TESTKEY0123456789ABCDEF";
  const res = (status: number, body: any = {}, json = true) => ({
    status,
    ok: status === 200,
    json: async () => {
      if (!json) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  });
  function clock() {
    let t = 1_000_000;
    const waits: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
      waits,
    };
  }

  it("refuses to start without a key, or faster than one call a second", () => {
    expect(() => lib.steamWebApi({ key: "", minIntervalMs: 1500 })).toThrow(/STEAM_API_KEY/);
    expect(() => lib.steamWebApi({ key: undefined, minIntervalMs: 1500 })).toThrow(/doppler run/);
    expect(() => lib.steamWebApi({ key: KEY, minIntervalMs: 999 })).toThrow(/1000 ms/);
  });

  it("sends the key only as the key parameter, and paces calls", async () => {
    const c = clock();
    const urls: string[] = [];
    const call = lib.steamWebApi({
      key: KEY,
      minIntervalMs: 1500,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: async (url: string) => (urls.push(url), res(200, { response: {} })),
    });
    await call("IStoreBrowseService/GetItems/v1", { input_json: "{}" });
    await call("IStoreBrowseService/GetItems/v1", { input_json: "{}" });
    expect(
      urls[0].startsWith("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?"),
    ).toBe(true);
    expect(new URL(urls[0]).searchParams.get("key")).toBe(KEY);
    expect(c.waits).toEqual([1500]);
    expect(call.count()).toBe(2);
    await expect(call("../../evil", {})).rejects.toThrow(/not a Steam Web API method/);
  });

  it("stops at the first non-200, network error or non-JSON body, without the key or the URL", async () => {
    for (const [impl, pattern] of [
      [async () => res(429), /HTTP 429; stopped, no retry/],
      [async () => res(500), /HTTP 500; stopped, no retry/],
      [async () => res(403), /HTTP 403; stopped, no retry/],
      [async () => res(200, null, false), /not JSON; stopped/],
      [
        async (url: string) => {
          throw Object.assign(new Error(`fetch failed for ${url}`), {
            cause: { code: "ECONNRESET" },
          });
        },
        /network error \(ECONNRESET\); stopped, no retry/,
      ],
    ] as const) {
      let calls = 0;
      const call = lib.steamWebApi({
        key: KEY,
        minIntervalMs: 1000,
        sleep: async () => {},
        fetchImpl: async (url: string) => (calls++, (impl as any)(url)),
      });
      const err = await call("IStoreService/GetAppList/v1", {}).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(pattern);
      expect(err?.message).not.toContain(KEY);
      expect(err?.message).not.toMatch(/https?:|key=/);
      expect(calls).toBe(1);
    }
  });

  it("masks the key in any message, as given, URL-encoded, or as a key= parameter", () => {
    const k = "abc/DEF+123";
    const m = lib.safeMessage(
      new Error(`a ${k} b ${encodeURIComponent(k)} c ?key=zzz&x=1 d &KEY=yyy`),
      { home: "/nohome", tmp: "/notmp", secrets: [k] },
    );
    expect(m).toBe("a *** b *** c ?key=***&x=1 d &KEY=***");
    expect(lib.safeMessage(new Error("plain"), { home: "/nohome", tmp: "/notmp" })).toBe("plain");
  });

  it("reads a Steam release time as a day, and 0 as not recorded", () => {
    expect(lib.unixDay(1487923200)).toEqual({ iso: "2017-02-24", precision: "day" });
    expect(lib.unixDay(1191999600)).toEqual({ iso: "2007-10-10", precision: "day" });
    for (const v of [0, -5, 1.5, "1487923200", null, undefined]) expect(lib.unixDay(v)).toBeNull();
  });
});

describe("WU-009a3: Steam GetItems, DLC and categories", () => {
  const ok = (id: number, over: any = {}) => ({ ...hollowItem, id, appid: id, ...over });
  const notListed = (id: number) => ({ item_type: 0, id, success: 15, appid: 0, name: "" });
  /** A stub of the client: answers GetItems for whatever IDs it is asked for. */
  function stubCall(opts: { failAt?: number; extra?: boolean; drop?: boolean } = {}) {
    const asked: any[] = [];
    const call: any = async (method: string, params: any) => {
      asked.push({ method, params });
      if (opts.failAt && asked.length === opts.failAt)
        throw new Error(`Steam Web API ${method}: HTTP 503; stopped, no retry`);
      const ids = JSON.parse(params.input_json).ids.map((x: any) => x.appid);
      const items = ids.map((id: number) => (id % 7 === 0 ? notListed(id) : ok(id)));
      if (opts.extra) items.push(ok(999999));
      if (opts.drop) items.pop();
      return { response: { store_items: items } };
    };
    return { call, asked };
  }
  const wikidataWith = (d: string, ids: string[]) =>
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      ids.map((id, i) => JSON.stringify({ qid: `Q${i + 1}`, steam_app_ids: [id] })).join("\n") +
        "\n",
    );

  it("asks for facts only, 1 to 100 numeric IDs at a time", () => {
    const input = JSON.parse(steam.getItemsInput(["10", "20"]));
    expect(input.ids).toEqual([{ appid: 10 }, { appid: 20 }]);
    expect(input.data_request).toMatchObject({
      include_full_description: false,
      include_assets: false,
      include_screenshots: false,
      include_all_purchase_options: false,
    });
    expect(() => steam.getItemsInput([])).toThrow(/1 to 100/);
    expect(() => steam.getItemsInput(Array.from({ length: 101 }, (_, i) => String(i + 1)))).toThrow(
      /1 to 100/,
    );
    expect(() => steam.getItemsInput(["10", "1;x"])).toThrow(/not a Steam app ID/);
  });

  it("refuses a response that does not answer exactly the IDs asked for", async () => {
    for (const opts of [{ extra: true }, { drop: true }]) {
      const { call } = stubCall(opts);
      await expect(steam.getItems(call, ["10", "20"], "t")).rejects.toThrow(/stopped/);
    }
    // An item not asked for in place of one that was, and an item given twice.
    for (const items of [
      [ok(10), ok(999)],
      [ok(10), ok(10)],
    ]) {
      await expect(
        steam.getItems(async () => ({ response: { store_items: items } }), ["10", "20"], "t"),
      ).rejects.toThrow(/not asked for, or came twice; stopped/);
    }
    await expect(steam.getItems(async () => ({ response: {} }), ["10"], "t")).rejects.toThrow(
      /no store_items/,
    );
  });

  it("records DLC with its base game, and the original release date when Steam has one", () => {
    const dlcRec = steam.toRecord(
      ok(378648, { type: 4, related_items: { parent_appid: 292030 } }),
      "2026-10-12T00:00:00Z",
    );
    expect(dlcRec).toMatchObject({ type: "dlc", type_id: 4, parent_appid: "292030" });
    const tf2 = steam.toRecord(
      ok(440, { release: { steam_release_date: 1191999600, original_release_date: 1191999600 } }),
      "2026-10-12T00:00:00Z",
    );
    expect(tf2.original_release_date).toEqual({
      unix: 1191999600,
      parsed: { iso: "2007-10-10", precision: "day" },
    });
    const zero = steam.toRecord(
      ok(292030, { release: { steam_release_date: 1431937260, original_release_date: 0 } }),
      "2026-10-12T00:00:00Z",
    );
    expect(zero.original_release_date).toBeNull();
    expect(steam.toRecord(ok(1, { type: 6 }), "t").type).toBe("type_6");
  });

  it("treats a release date still in the future, or marked coming soon, as not released", () => {
    const future = steam.toRecord(
      ok(5, { release: { steam_release_date: 1893456000 } }),
      "2026-10-12T00:00:00Z",
    );
    expect(future.release_date).toMatchObject({ coming_soon: true, parsed: null });
    const flagged = steam.toRecord(
      ok(6, { release: { steam_release_date: 1487923200, is_coming_soon: true } }),
      "2026-10-12T00:00:00Z",
    );
    expect(flagged.release_date).toMatchObject({ coming_soon: true, parsed: null });
  });

  it("fetches 100 IDs per call, resumes, and fetches an older appdetails record again", async () => {
    const d = dataDir();
    const ids = Array.from({ length: 250 }, (_, i) => String(1000 + i));
    wikidataWith(d, ids);
    writeFileSync(
      path.join(d, "steam.jsonl"),
      JSON.stringify({ appid: "1000", success: true, source: { name: "steam" } }) + "\n",
    );
    const { call, asked } = stubCall();
    expect(await steam.ingest({ dataDir: d, call, limit: 120 })).toMatchObject({
      requested: 120,
      remaining: 130,
    });
    expect(asked.map((a) => JSON.parse(a.params.input_json).ids.length)).toEqual([100, 20]);
    expect(JSON.parse(asked[0].params.input_json).ids[0]).toEqual({ appid: 1000 });
    expect(await steam.ingest({ dataDir: d, call })).toMatchObject({
      requested: 130,
      remaining: 0,
    });
    expect(asked.map((a) => JSON.parse(a.params.input_json).ids.length)).toEqual([
      100, 20, 100, 30,
    ]);
    const recs = lines(path.join(d, "steam.jsonl")).filter((r) => r.source.route);
    expect(new Set(recs.map((r) => r.appid)).size).toBe(250);
    expect(recs.filter((r) => !r.success).every((r) => Number(r.appid) % 7 === 0)).toBe(true);
    expect(await steam.ingest({ dataDir: d, call })).toMatchObject({ requested: 0 });
  });

  it("stops at the first failure and keeps what was already written", async () => {
    const d = dataDir();
    wikidataWith(
      d,
      Array.from({ length: 300 }, (_, i) => String(2000 + i)),
    );
    const { call, asked } = stubCall({ failAt: 2 });
    await expect(steam.ingest({ dataDir: d, call })).rejects.toThrow(/HTTP 503/);
    expect(asked).toHaveLength(2);
    expect(lines(path.join(d, "steam.jsonl"))).toHaveLength(100);
  });

  it("lists every DLC page by page, resumes an interrupted listing, then fetches each DLC", async () => {
    const d = dataDir();
    const pages = [
      { apps: [{ appid: 660 }, { appid: 1256 }], have_more_results: true, last_appid: 1256 },
      { apps: [{ appid: 4780 }], have_more_results: true, last_appid: 4780 },
      { apps: [{ appid: 378648 }], have_more_results: false },
    ];
    const asked: any[] = [];
    const call: any = async (method: string, params: any) => {
      asked.push({ method, params });
      if (method === "IStoreService/GetAppList/v1") {
        const after = Number(params.last_appid ?? 0);
        const page = pages.find((p) => p.apps[0].appid > after);
        return { response: page };
      }
      const ids = JSON.parse(params.input_json).ids.map((x: any) => x.appid);
      return {
        response: {
          store_items: ids.map((id: number) => ({
            ...hollowItem,
            id,
            appid: id,
            type: 4,
            related_items: { parent_appid: 292030 },
          })),
        },
      };
    };
    const first = await steam.dlc({ dataDir: d, call, maxPages: 1 });
    expect(first).toMatchObject({ dlc_ids: 2, listing_complete: false, requested: 2 });
    expect(asked[0].params).toMatchObject({ include_dlc: "true", include_games: "false" });
    expect(asked[0].params.last_appid).toBeUndefined();
    const second = await steam.dlc({ dataDir: d, call });
    expect(second).toMatchObject({ dlc_ids: 4, listing_complete: true, requested: 2 });
    const listCalls = asked.filter((a) => a.method === "IStoreService/GetAppList/v1");
    expect(listCalls.map((a) => a.params.last_appid)).toEqual([undefined, "1256", "4780"]);
    const recs = lines(path.join(d, "steam-dlc.jsonl"));
    expect(recs.map((r) => r.appid).sort()).toEqual(["1256", "378648", "4780", "660"]);
    expect(recs.every((r) => r.parent_appid === "292030" && r.type === "dlc")).toBe(true);
    // A finished listing is not asked for again.
    const before = asked.length;
    await steam.dlc({ dataDir: d, call });
    expect(asked.length).toBe(before);
  });

  it("stops a listing that says there is more but gives no way to continue", async () => {
    const d = dataDir();
    const call: any = async () => ({
      response: { apps: [{ appid: 5 }], have_more_results: true },
    });
    await expect(steam.listDlc({ dataDir: d, call })).rejects.toThrow(/no last_appid/);
    // A listing that keeps answering with the same page never ends: the run stops instead.
    let calls = 0;
    const repeat: any = async () => {
      if (++calls > 5) throw new Error("the stub was called too often");
      return { response: { apps: [{ appid: 5 }], have_more_results: true, last_appid: 5 } };
    };
    await expect(steam.listDlc({ dataDir: dataDir(), call: repeat })).rejects.toThrow(
      /a page with no new DLC IDs; stopped/,
    );
    expect(calls).toBe(2);
  });

  it("writes the store's category names, sorted, from one call", async () => {
    const d = dataDir();
    const call: any = async (method: string, params: any) => {
      expect(method).toBe("IStoreBrowseService/GetStoreCategories/v1");
      expect(JSON.parse(params.input_json)).toEqual({ language: "english" });
      return {
        response: {
          categories: [
            {
              categoryid: 79,
              type: 2,
              internal_name: "Save Anytime",
              display_name: "Save Anytime",
              image_url: "x",
            },
            {
              categoryid: 2,
              type: 1,
              internal_name: "Single-player",
              display_name: "Single-player",
            },
          ],
        },
      };
    };
    expect(await steam.categories({ dataDir: d, call })).toEqual({ categories: 2 });
    const f = JSON.parse(readFileSync(path.join(d, "steam-categories.json"), "utf8"));
    expect(f.categories.map((c: any) => c.categoryid)).toEqual([2, 79]);
    expect(JSON.stringify(f)).not.toContain("image_url");
    await expect(
      steam.categories({ dataDir: d, call: async () => ({ response: { categories: [] } }) }),
    ).rejects.toThrow(/no categories/);
  });

  it("writes nothing, and keeps the existing snapshot, when any category entry is malformed", async () => {
    const d = dataDir();
    const good: any = async () => ({
      response: { categories: [{ categoryid: 2, type: 1, display_name: "Single-player" }] },
    });
    expect(await steam.categories({ dataDir: d, call: good })).toEqual({ categories: 1 });
    const file = path.join(d, "steam-categories.json");
    const before = readFileSync(file, "utf8");
    const allBad: any = async () => ({ response: { categories: [{ categoryid: "79" }] } });
    await expect(steam.categories({ dataDir: d, call: allBad })).rejects.toThrow(
      /1 of 1 categories have no integer categoryid; nothing was written/,
    );
    expect(readFileSync(file, "utf8")).toBe(before);
    const mixed: any = async () => ({
      response: {
        categories: [{ categoryid: 79, display_name: "Save Anytime" }, null, { type: 1 }],
      },
    });
    await expect(steam.categories({ dataDir: d, call: mixed })).rejects.toThrow(
      /2 of 3 categories have no integer categoryid; nothing was written/,
    );
    expect(readFileSync(file, "utf8")).toBe(before);
    const fresh = path.join(d, "not-created");
    await expect(steam.categories({ dataDir: fresh, call: allBad })).rejects.toThrow(
      /nothing was written/,
    );
    expect(existsSync(fresh)).toBe(false);
  });

  it("refuses a fast interval, an unknown step, and --max-pages outside the dlc step", async () => {
    const d = dataDir();
    const call = async () => ({});
    await expect(steam.main(["--data-dir", d, "--interval-ms", "500"], { call })).rejects.toThrow(
      /below 1000/,
    );
    await expect(steam.main(["prices", "--data-dir", d], { call })).rejects.toThrow(/usage/);
    await expect(
      steam.main(["games", "--data-dir", d, "--max-pages", "1"], { call }),
    ).rejects.toThrow(/only to the dlc step/);
    await expect(steam.main(["categories", "--data-dir", d], { env: {} })).rejects.toThrow(
      /STEAM_API_KEY is not set/,
    );
  });
});

describe("WU-009a3: Wikidata cross-catalogue IDs and aliases", () => {
  const WDT = "http://www.wikidata.org/prop/direct/";
  const ALT = "http://www.w3.org/2004/02/skos/core#altLabel";
  const row = (qid: string, rev: string, prop?: string, v?: string) => {
    const r: any = { item: uri(`${E}${qid}`), rev: lit(rev) };
    if (prop) r.prop = uri(prop);
    if (v !== undefined) r.v = lit(v);
    return r;
  };

  it("asks for all 14 identifier properties and English or mul aliases", () => {
    const q = wd.xidsQuery(["Q1", "Q2"]);
    expect(Object.keys(wd.XID_PROPS)).toHaveLength(14);
    for (const p of Object.values(wd.XID_PROPS)) expect(q).toContain(`wdt:${p}`);
    expect(q).toContain("skos:altLabel");
    expect(q).toContain('LANG(?v) IN ("en", "mul")');
    expect(() => wd.xidsQuery(["Q1", "P31"])).toThrow(/not a Wikidata item ID/);
  });

  it("groups the IDs and aliases of each item, and ignores anything else", () => {
    const m = wd.toXids([
      row("Q1", "5", `${WDT}P5794`, "hollow-knight"),
      row("Q1", "5", `${WDT}P8084`, "70010000003208"),
      row("Q1", "5", `${WDT}P8084`, "70010000003208"),
      row("Q1", "5", `${WDT}P2725`, "1450000000"),
      row("Q1", "5", ALT, "HK"),
      row("Q1", "5", `${WDT}P31`, "Q7889"),
      row("Q2", "9"),
      { item: uri("http://example.invalid/Q3"), rev: lit("1") },
    ]);
    expect(m.get("Q1")).toEqual({
      rev: "5",
      ids: { igdb: ["hollow-knight"], eshop: ["70010000003208"], gog: ["1450000000"] },
      aliases: ["HK"],
    });
    expect(Object.keys(m.get("Q1").ids)).toEqual(["igdb", "eshop", "gog"]);
    expect(m.get("Q2")).toEqual({ rev: "9", ids: {}, aliases: [] });
    expect(m.has("Q3")).toBe(false);
  });

  it("writes every returned item once, with its revision link, and resumes", async () => {
    const d = dataDir();
    writeFileSync(
      path.join(d, "wikidata-ids.jsonl"),
      ["Q1", "Q2", "Q3"].map((qid) => JSON.stringify({ qid, revision: 1 })).join("\n") + "\n",
    );
    const queries: string[] = [];
    const fetchJson = async (_url: string, init: any) => {
      const q = new URLSearchParams(init.body).get("query") as string;
      queries.push(q);
      const rows = [];
      if (q.includes("wd:Q1")) rows.push(row("Q1", "5", `${WDT}P5794`, "hollow-knight"));
      if (q.includes("wd:Q2")) rows.push(row("Q2", "9"));
      // Q3 is not returned (deleted since the list): it is not recorded as having no IDs.
      return { results: { bindings: rows } };
    };
    expect(await wd.xids({ dataDir: d, fetchJson, batch: 2 })).toMatchObject({
      requested: 3,
      written: 2,
      with_ids: 1,
      remaining: 1,
    });
    expect(queries).toHaveLength(2);
    const recs = lines(path.join(d, "wikidata-xids.jsonl"));
    expect(recs.map((r) => r.qid)).toEqual(["Q1", "Q2"]);
    expect(recs[0]).toMatchObject({
      revision: 5,
      ids: { igdb: ["hollow-knight"] },
      source: {
        name: "wikidata",
        revision_url: "https://www.wikidata.org/w/index.php?title=Q1&oldid=5",
      },
    });
    expect(await wd.xids({ dataDir: d, fetchJson })).toMatchObject({ requested: 1, written: 0 });
    expect(queries[2]).toContain("wd:Q3");
    expect(queries[2]).not.toContain("wd:Q1 ");
  });
});

describe("WU-009a3: Steam's original release date in the agreement", () => {
  const src = (url: string) => ({ name: "wikidata", url, fetched_at: "t" });
  const w = (events: any[]) => ({
    qid: "Q1",
    label: "Game",
    release_events: events,
    platforms: [],
    developers: [],
    publishers: [],
    steam_app_ids: ["10"],
    source: src("https://www.wikidata.org/w/index.php?title=Q1&oldid=1"),
  });
  const day = (iso: string) => ({ iso, precision: "day" });
  const ev = (iso: string, platforms: string[] = []) => ({ ...day(iso), platforms, places: [] });
  const s = (store: string, original: string | null) => ({
    appid: "10",
    success: true,
    type: "game",
    name: "Game",
    release_date: { raw: null, coming_soon: false, parsed: day(store) },
    original_release_date: original ? { unix: 1, parsed: day(original) } : null,
    developers: [],
    publishers: [],
    platforms: [],
    source: { name: "steam", url: "https://store.steampowered.com/app/10/", fetched_at: "t" },
  });

  it("compares Steam's original date with any Wikidata event, and says which", () => {
    const r = agree.compare(
      w([ev("2004-03-01", ["Q8079"]), ev("2015-06-01", ["Q1406"])]),
      s("2015-06-01", "2004-03-01"),
    ).fields.release_date;
    expect(r).toMatchObject({ status: "agree", value: day("2004-03-01") });
    expect(r.basis).toMatch(/original release date matches a Wikidata release event for Q8079/);
    expect(r.basis).toMatch(/the earliest Wikidata event/);
    expect(r.values.steam_basis).toBe("original_release_date");
  });

  it("keeps a later original date distinct, and a mismatch in between a conflict", () => {
    const later = agree.compare(w([ev("2004-03-01")]), s("2015-06-01", "2010-01-01")).fields
      .release_date;
    expect(later.status).toBe("distinct");
    expect(later.basis).toMatch(/original release date is later than every/);
    const between = agree.compare(
      w([ev("2004-03-01"), ev("2012-01-01")]),
      s("2015-06-01", "2008-05-05"),
    ).fields.release_date;
    expect(between.status).toBe("conflict");
  });

  it("falls back to the store-date rule when Steam has no original date", () => {
    const r = agree.compare(w([ev("2004-03-01", ["Q8079"])]), s("2004-03-01", null)).fields
      .release_date;
    // The store date is compared only with Windows or unqualified events: this one is neither.
    expect(r.status).toBe("conflict");
    expect(r.values.steam_basis).toBeUndefined();
    const store = agree.compare(w([ev("2004-03-01")]), s("2015-06-01", "2004-03-01")).store;
    expect(store.steam_original_release_date).toEqual(day("2004-03-01"));
  });
});

describe("WU-009a3 r2: Codex pre-dispatch review findings", () => {
  const KEY = "TESTKEY0123456789ABCDEF";
  const ok = (id: number, over: any = {}) => ({ ...hollowItem, id, appid: id, ...over });

  it("names only a known network error code, never the exception's own text", async () => {
    const url = `https://api.steampowered.com/x/?key=${KEY}`;
    for (const err of [
      Object.assign(new Error("boom"), { cause: { code: KEY } }),
      Object.assign(new Error("boom"), { code: url }),
      Object.assign(new Error("boom"), { name: `${KEY}Error` }),
      Object.assign(new Error(url), { cause: { name: KEY } }),
    ]) {
      const call = lib.steamWebApi({
        key: KEY,
        minIntervalMs: 1000,
        sleep: async () => {},
        fetchImpl: async () => {
          throw err;
        },
      });
      const e = await call("IStoreService/GetAppList/v1", {}).then(
        () => null,
        (x: Error) => x,
      );
      expect(e?.message).toBe(
        "Steam Web API IStoreService/GetAppList/v1: network error (unknown); stopped, no retry",
      );
    }
    expect(lib.networkErrorCode({ cause: { code: "ETIMEDOUT" } })).toBe("ETIMEDOUT");
    expect(lib.networkErrorCode({ name: "AbortError" })).toBe("AbortError");
  });

  it("checks a DLC page whole before writing anything from it", async () => {
    const listing = (response: any) => async () => ({ response });
    for (const [response, pattern] of [
      [{}, /the first page lists no DLC/],
      [{ apps: "many" }, /apps is not a list/],
      [{ apps: [{ appid: 5 }], have_more_results: "yes" }, /not true or false/],
      [{ apps: [{ appid: 5 }, { appid: "x" }], have_more_results: false }, /without a valid appid/],
      [{ apps: [{ appid: 5 }, { appid: -3 }], have_more_results: false }, /without a valid appid/],
    ] as const) {
      const d = dataDir();
      await expect(steam.listDlc({ dataDir: d, call: listing(response) })).rejects.toThrow(pattern);
      expect(existsSync(path.join(d, "steam-dlc-ids.done.json"))).toBe(false);
      expect(existsSync(path.join(d, "steam-dlc-ids.jsonl"))).toBe(false);
    }
  });

  it("writes a page's IDs in ascending order, and accepts an empty last page", async () => {
    const d = dataDir();
    const pages = [
      {
        apps: [{ appid: 30 }, { appid: 10 }, { appid: 20 }],
        have_more_results: true,
        last_appid: 30,
      },
      {},
    ];
    let n = 0;
    const r = await steam.listDlc({ dataDir: d, call: async () => ({ response: pages[n++] }) });
    expect(r).toMatchObject({ complete: true, pages: 2 });
    expect(lines(path.join(d, "steam-dlc-ids.jsonl")).map((x) => x.appid)).toEqual([
      "10",
      "20",
      "30",
    ]);
    expect(existsSync(path.join(d, "steam-dlc-ids.done.json"))).toBe(true);
  });

  it("keeps a listed item with no integer type as not usable, and never compares it as a game", () => {
    for (const type of [undefined, "0", null, 1.5]) {
      expect(steam.toRecord(ok(7, { type }), "t")).toMatchObject({
        appid: "7",
        success: false,
        steam_status: "missing_type",
      });
    }
    const w = { qid: "Q1", steam_app_ids: ["7"] };
    const viaApi = { appid: "7", success: true, type: null, source: { route: steam.ROUTE } };
    const legacy = { appid: "7", success: true, type: null, source: { name: "steam" } };
    expect(agree.pickSteam(w, new Map([["7", viaApi]]))).toBeNull();
    expect(agree.pickSteam(w, new Map([["7", legacy]]))).toBe(legacy);
    expect(agree.pickSteam(w, new Map([["7", { ...viaApi, type: "game" }]]))).not.toBeNull();
  });
});
