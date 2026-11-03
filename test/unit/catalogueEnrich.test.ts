// WU-029 (task proposal 029): the catalogue enrichment script. Offline only: the global fetch
// throws for the whole file, the SDK gets a stub fetch and a stub credential, Wikipedia is a stub,
// the run guard works in a temporary records folder with a temporary AGENTS.md that carries a test
// entry, and every file goes to a temporary folder. Invented games only.
// cspell:words aiplatform genai vertexai wikidata oldid Driftwood Lanterns Emberfall Quillon
// cspell:words Zephyrine revid pageid pageprops categoryid quicksave
// cspell:words contentmodel wikitext redir revids
import { createHash } from "crypto";
import { EventEmitter } from "events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = process.cwd();
const NOW = Date.parse("2026-10-20T12:00:00Z");
const ENTRY = "#991";
// A sentence only the stub Wikipedia serves: it must never reach a file or the console.
const LEAD_MARK = "Zephyrine lighthouse keepers trade riddles";

let lib: any;
let en: any;
let GoogleGenAI: any;
const realFetch = globalThis.fetch;
const dirs: string[] = [];

it("check diagnostics retain only fixed hints, never response text or credentials", () => {
  const diagnostic = en.checkRequestDiagnostic({
    status: 429,
    message: "RESOURCE_EXHAUSTED quota capacity: try again later; secret-marker; source-marker",
  });
  expect(diagnostic).toEqual({
    http_status: 429,
    quota_hint: true,
    capacity_hint: true,
    retry_later_hint: true,
    resource_exhausted_hint: true,
  });
  expect(JSON.stringify(diagnostic)).not.toMatch(/secret-marker|source-marker/);
  expect(en.checkRequestDiagnostic({ status: "429", message: {} }).http_status).toBeNull();
});

it("operator waiver cannot select another task or input snapshot", async () => {
  await expect(
    en.main([
      "--task",
      "description",
      "--entry",
      "#207",
      "--operator-waiver",
      lib.WU034_OPERATOR_WAIVER,
    ]),
  ).rejects.toMatchObject({ check: "operator-waiver" });
  await expect(
    en.main([
      "--task",
      "check",
      "--entry",
      "#207",
      "--check-input",
      "other.jsonl",
      "--operator-waiver",
      lib.WU034_OPERATOR_WAIVER,
    ]),
  ).rejects.toThrow(/approved WU-034/);
});

beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("network access in a catalogue enrichment test");
  }) as typeof fetch;
  lib = await import("../../scripts/probes/act08/lib.mjs");
  en = await import("../../scripts/catalogue/enrich-gemini.mjs");
  ({ GoogleGenAI } = await import("@google/genai"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------
// An invented catalogue.

function agreement(qid: string, appid: string, title: string, over: any = {}) {
  return {
    qid,
    steam_appid: appid,
    fields: {
      title: { status: "agree", value: title },
      release_date: { status: "agree", value: { iso: "2015-03-04", precision: "day" } },
      developers: {
        status: "conflict",
        value: null,
        values: { wikidata: ["Conflicting Dev"], steam: ["Other Dev"] },
      },
      publishers: { status: "single", value: ["Quillon Press"] },
      platforms: { status: "agree", value: ["windows"] },
      ...(over.fields ?? {}),
    },
    context: {
      series: { values: [] },
      genres_wikidata: {
        values: over.genres ?? [{ id: "Q9", label: "action role-playing game" }],
        source: { url: `https://www.wikidata.org/w/index.php?title=${qid}&oldid=11` },
      },
      genres_steam: { values: [] },
      wikipedia_title: over.wikipedia_title === undefined ? title : over.wikipedia_title,
    },
  };
}

function steam(appid: string, reviews: number, over: any = {}) {
  return {
    appid,
    success: true,
    type: "game",
    is_free: false,
    steam_deck_compat_category: 3,
    categories: { player: [2], feature: [79, 23], controller: [28] },
    reviews: { review_count: reviews, percent_positive: 90 },
    ...over,
  };
}

/** Five usable games (Q1..Q5, most reviewed first is Q3), and three that are never used. */
function catalogue() {
  const dir = tmp("enrich-cat-");
  const a = [
    agreement("Q1", "101", "Driftwood Lanterns"),
    agreement("Q2", "102", "Emberfall Tactics", {
      genres: [{ id: "Q8", label: "puzzle video game" }],
    }),
    agreement("Q3", "103", "Harbor of Echoes", { genres: [] }),
    agreement("Q4", "104", "Lantern Row", { wikipedia_title: null }),
    agreement("Q5", "105", "Copper Orchard", {
      genres: [{ id: "Q7", label: "action-adventure game" }],
    }),
    // Never used: a conflicting title, a DLC, no Steam record.
    agreement("Q6", "106", "Conflict Title", {
      fields: { title: { status: "conflict", value: null } },
    }),
    agreement("Q7", "107", "Some DLC"),
    agreement("Q8", "999", "No Steam Record"),
  ];
  const s = [
    steam("101", 500),
    steam("102", 400),
    steam("103", 900),
    steam("104", 300, { categories: { player: [], feature: [], controller: [] } }),
    steam("105", 100),
    steam("106", 5000),
    steam("107", 5000, { type: "dlc" }),
  ];
  writeFileSync(
    path.join(dir, "agreement.jsonl"),
    a.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  writeFileSync(path.join(dir, "steam.jsonl"), s.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(
    path.join(dir, "steam-categories.json"),
    JSON.stringify({ categories: [{ categoryid: 2, display_name: "Single-player" }] }),
  );
  return dir;
}

function records() {
  const dir = tmp("enrich-gcp-");
  writeFileSync(
    path.join(dir, "credit-position-1.json"),
    JSON.stringify({ read_at: new Date(NOW - 3_600_000).toISOString(), balance_usd: 298 }),
  );
  return dir;
}

/** AGENTS.md with one more ledger row: a test entry naming this script and the output folder. */
function agentsWithEntry(out: string, cap = "200000", usd = "$160", label = "S3") {
  const text = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const row = `| ${ENTRY} (${label}) | \`scripts/catalogue/enrich-gemini.mjs\`: test entry | \`aiplatform.googleapis.com\`, location \`global\`, \`generateContent\` only | Principal Operator | ${cap} | ${usd} | \`${out}\` | 2026-10-12 | 2026-11-06 |`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("| #117 (P-9)"));
  lines.splice(at + 1, 0, row);
  const file = path.join(tmp("enrich-agents-"), "AGENTS.md");
  writeFileSync(file, lines.join("\n"));
  return file;
}

/** The httpOptions each run asked its client for. */
const clientOptions: any[] = [];
function makeClient(holder: any, httpOptions: any = {}) {
  clientOptions.push(httpOptions);
  return new GoogleGenAI({
    vertexai: true,
    project: "mgpl-508415",
    location: "global",
    googleAuthOptions: {
      authClient: { getRequestHeaders: async () => new Headers({ Authorization: "Bearer test" }) },
    },
    httpOptions: { fetch: holder.fetch },
  });
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** The games a request asks about, read back from its prompt. */
function gamesOf(body: any) {
  const text: string = body.contents[0].parts[0].text;
  return JSON.parse(text.slice(text.indexOf("Games:\n") + 7));
}

const GOOD_DESCRIPTION =
  "A slow coastal exploration game in which the player restores a chain of lanterns, " +
  "charts the tides and trades stories with visiting sailors along a quiet shoreline.";

function answer(task: string, id: string) {
  if (task === "description")
    return { id, description: GOOD_DESCRIPTION, insufficient_information: false, confidence: 0.8 };
  if (task === "friction")
    return {
      id,
      save_system: "save_anywhere",
      time_between_saves: "under_5_min",
      suspend_friendly: "yes",
      session_loop: "15_to_45_min",
      cognitive_load: "low",
      third_party_launcher: "no",
      always_online: "no",
      confidence: 0.6,
    };
  return {
    id,
    ...Object.fromEntries(en.GENRE_FLAGS.map((f: string) => [f, "unknown"])),
    is_story_narrative: "yes",
    primary_genre: "Adventure",
    confidence: 0.5,
  };
}

/** A stub Vertex: answers every game of every request, with the given usage. */
function stubVertex(task: string, usage = { promptTokenCount: 1500, candidatesTokenCount: 400 }) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const games = gamesOf(JSON.parse(String(init.body)));
    return json({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: JSON.stringify({ games: games.map((g: any) => answer(task, g.id)) }) }],
          },
        },
      ],
      usageMetadata: usage,
    });
  });
}

/** A stub Wikipedia: every title has a page whose lead carries LEAD_MARK. */
function stubWikipedia() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const titles = String(u.searchParams.get("titles")).split("|");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("user-agent")).toMatch(/^MGPL-catalogue-ingest\//);
    return json({
      query: {
        pages: titles.map((t, i) => ({
          pageid: i + 1,
          title: t,
          extract: `${t} is an invented game. ${LEAD_MARK} on a windswept coast.`,
          revisions: [{ revid: 5000 + i }],
        })),
      },
    });
  });
}

async function run(
  task: string,
  extra: string[] = [],
  opts: {
    stub?: any;
    wiki?: any;
    out?: string;
    entryOut?: string;
    agents?: string;
    dir?: string;
    now?: () => number;
    sleep?: any;
    onCapture?: (c: any) => void;
  } = {},
) {
  const cat = catalogue();
  const out = opts.out ?? tmp("enrich-out-");
  const dir = opts.dir ?? records();
  const stub = opts.stub ?? stubVertex(task);
  const wiki = opts.wiki ?? stubWikipedia();
  const logs: string[] = [];
  const sleep = opts.sleep ?? vi.fn(async () => {});
  const code = await en.main(
    ["--run", "--entry", ENTRY, "--task", task, "--catalogue", cat, "--out", out, ...extra],
    {
      dir,
      agentsPath: opts.agents ?? agentsWithEntry(opts.entryOut ?? out),
      now: opts.now ?? (() => NOW),
      sleep,
      onCapture: opts.onCapture,
      baseFetch: stub,
      wikiFetch: wiki,
      makeClient,
      log: (s: string) => logs.push(s),
      interrupts: new EventEmitter(),
    },
  );
  return { code, out, dir, logs, stub, wiki, sleep, cat };
}

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const ledger = (dir: string) => lines(path.join(dir, "spend-ledger.jsonl"));
const aggregateOf = (out: string) =>
  JSON.parse(
    readFileSync(
      path.join(out, readdirSync(out).find((f) => f.endsWith("aggregate.json")) as string),
      "utf8",
    ),
  );

// ---------------------------------------------------------------------------

describe("enrichment building blocks", () => {
  it("fetch throws for this whole file", () => {
    expect(() => globalThis.fetch("https://example.invalid/")).toThrow(/network access/);
  });

  it("uses Gemini 3.1 Flash-Lite on the global endpoint, thinking level MINIMAL and no temperature", () => {
    expect(en.MODEL).toBe("gemini-3.1-flash-lite");
    expect(en.LOCATION).toBe("global");
    for (const task of en.LEGACY_TASKS) {
      const params = en.requestParams(task, [{ id: "Q1", title: "x" }]);
      expect(params.config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
      expect(params.config).not.toHaveProperty("temperature");
      expect(params.config.maxOutputTokens).toBe(en.maxOutputFor(task, 1));
    }
  });

  it("builds exactly the body the SDK sends, and the guard bounds it", async () => {
    const rates = await lib.loadRates();
    const seen: string[] = [];
    const client = makeClient({
      fetch: async (_url: string, init: RequestInit) => {
        seen.push(String(init.body));
        return json({ candidates: [], usageMetadata: { promptTokenCount: 1 } });
      },
    });
    for (const task of en.LEGACY_TASKS) {
      const params = en.requestParams(task, [
        {
          id: "Q1",
          title: "\u00dcn\u00efcode \u2122 \u0001",
          reference_text_wikipedia: '"quoted"',
        },
      ]);
      await client.models.generateContent(params);
      expect(JSON.parse(seen.at(-1) as string)).toEqual(JSON.parse(en.vertexBody(params)));
      expect(seen.at(-1)).toBe(en.vertexBody(params));
      const bound = lib.maxRequestCostUsd(rates, en.MODEL, seen.at(-1));
      // MINIMAL is bounded by the model's whole output ceiling, like every level.
      expect(bound.output_ceiling_tokens).toBe(en.maxOutputFor(task, 1) + 65536);
      expect(bound.max_cost_usd).toBeCloseTo(
        (Buffer.byteLength(seen.at(-1) as string) * 0.25 +
          (en.maxOutputFor(task, 1) + 65536) * 1.5) /
          1e6,
        9,
      );
    }
  });

  it("plans a bound no real request of the first batches exceeds", async () => {
    const rates = await lib.loadRates();
    const cat = en.loadCatalogue(catalogue());
    const list = en.buildCandidates(cat, "description").list;
    const batches = [list.slice(0, 3), list.slice(3)];
    const planned = en.planBound(rates, "description", batches, "wikipedia", cat.categoryNames);
    // The costliest real lead: WIKI_CHARS characters that JSON escapes to 6 bytes each.
    for (const text of ["\u0002".repeat(en.WIKI_CHARS), '"\\'.repeat(en.WIKI_CHARS / 2)]) {
      for (const games of batches) {
        const facts = games.map((c: any) => en.factsFor(c, cat.categoryNames, { text }));
        const real = lib.maxRequestCostUsd(
          rates,
          en.MODEL,
          en.vertexBody(en.requestParams("description", facts)),
        ).max_cost_usd;
        expect(real).toBeLessThanOrEqual(planned);
      }
    }
    expect(en.planBound(rates, "description", batches, "none", cat.categoryNames)).toBeLessThan(
      planned,
    );
  });

  it("takes games with a Steam game record and a usable title, most reviewed first", () => {
    const cat = en.loadCatalogue(catalogue());
    const d = en.buildCandidates(cat, "description");
    expect(d.list.map((c: any) => c.a.qid)).toEqual(["Q3", "Q1", "Q2", "Q4", "Q5"]);
    expect(d.eligible).toBe(5);
    expect(en.buildCandidates(cat, "friction", { top: 2 }).list.map((c: any) => c.a.qid)).toEqual([
      "Q3",
      "Q1",
    ]);
    // Q1 and Q4 (action role-playing) and Q5 (action-adventure) are placed by the rules.
    const g = en.buildCandidates(cat, "genre");
    expect(g.list.map((c: any) => c.a.qid)).toEqual(["Q3", "Q2"]);
    expect(g.rule_placed).toBe(3);
  });

  it("maps Wikidata genre labels by rule, without reading action-adventure as a story game", () => {
    expect([...en.ruleGenres(["action role-playing game"])].sort()).toEqual([
      "is_action",
      "is_rpg",
    ]);
    expect([...en.ruleGenres(["action-adventure game"])]).toEqual(["is_action"]);
    expect([...en.ruleGenres(["graphic adventure game"])]).toEqual(["is_story_narrative"]);
    expect([...en.ruleGenres(["turn-based tactics"])].sort()).toEqual([
      "is_strategy_tactics",
      "is_turn_based",
    ]);
    expect(en.ruleGenres(["puzzle video game"]).size).toBe(0);
    expect(en.ruleGenres([]).size).toBe(0);
  });

  it("gives the model agree and single facts only, and Steam's own labels", () => {
    const cat = en.loadCatalogue(catalogue());
    const c = en.buildCandidates(cat, "description").list.find((x: any) => x.a.qid === "Q1");
    const facts = en.factsFor(c, cat.categoryNames, { text: "lead" });
    expect(facts).toEqual({
      id: "Q1",
      title: "Driftwood Lanterns",
      first_released: "2015-03-04",
      publishers: ["Quillon Press"],
      pc_platforms: ["windows"],
      genres: ["action role-playing game"],
      steam: {
        free_to_play: false,
        steam_deck: "verified",
        review_count: 500,
        percent_positive: 90,
        categories: ["Single-player", "Save Anytime", "Steam Cloud", "Full controller support"],
      },
      reference_text_wikipedia: "lead",
    });
    expect(JSON.stringify(facts)).not.toMatch(/Conflicting Dev|Other Dev/);
  });

  it("copies Steam's friction categories as sourced facts: listed is true, unlisted is null", () => {
    expect(en.steamFrictionFacts(steam("101", 1))).toMatchObject({
      save_anytime: true,
      steam_cloud: true,
      playable_without_timed_input: null,
      controller: "full",
      steam_deck: "verified",
      source: "https://store.steampowered.com/app/101/",
    });
    expect(
      en.steamFrictionFacts(
        steam("104", 1, {
          categories: { player: [], feature: [], controller: [18] },
          steam_deck_compat_category: 7,
        }),
      ),
    ).toMatchObject({ save_anytime: null, controller: "partial", steam_deck: null });
  });

  it("finds the longest run of shared words", () => {
    expect(en.longestSharedRun("the quick brown fox", "a quick brown fox jumps")).toBe(3);
    expect(en.longestSharedRun("Alpha, beta; GAMMA delta", "alpha beta gamma")).toBe(3);
    expect(en.longestSharedRun("one two", "three four")).toBe(0);
    expect(en.longestSharedRun("", "x")).toBe(0);
  });

  it("judges each game of a response on its own", () => {
    const games = [{ id: "Q1" }, { id: "Q2" }, { id: "Q3" }, { id: "Q4" }, { id: "Q5" }];
    const copied =
      "Zephyrine lighthouse keepers trade riddles on a windswept coast while the player rebuilds the harbour town.";
    const v = en.judgeBatch(
      "description",
      games,
      {
        games: [
          answer("description", "Q1"),
          { ...answer("description", "Q2"), confidence: 1.5 },
          { ...answer("description", "Q3"), description: copied },
          { id: "Q4", description: "", insufficient_information: true, confidence: 0.1 },
          { ...answer("description", "Q9") },
        ],
      },
      new Map([["Q3", { text: `${LEAD_MARK} on a windswept coast.` }]]),
    );
    expect(v.get("Q1")).toMatchObject({
      status: "ok",
      generated: { description: GOOD_DESCRIPTION },
    });
    expect(v.get("Q2")).toMatchObject({ status: "failed", reason: /confidence/ });
    // A description sharing 8 or more words with the reference text is not kept.
    expect(v.get("Q3")).toMatchObject({ status: "rejected", generated: { description: null } });
    expect(JSON.stringify(v.get("Q3"))).not.toContain("Zephyrine");
    expect(v.get("Q4")).toMatchObject({ status: "insufficient", generated: { description: null } });
    expect(v.get("Q5")).toMatchObject({ status: "failed", reason: "missing from the response" });

    const dup = en.judgeBatch("friction", [{ id: "Q1" }, { id: "Q2" }], {
      games: [
        answer("friction", "Q1"),
        answer("friction", "Q1"),
        { ...answer("friction", "Q2"), save_system: "quicksave" },
      ],
    });
    expect(dup.get("Q1")).toMatchObject({ status: "failed", reason: "answered twice" });
    expect(dup.get("Q2")).toMatchObject({ status: "failed", reason: /save_system/ });
    // A field the schema does not name is refused, whatever it holds.
    const extra = en.judgeBatch("genre", [{ id: "Q1" }], {
      games: [{ ...answer("genre", "Q1"), reference_text_wikipedia: LEAD_MARK }],
    });
    expect(extra.get("Q1")).toMatchObject({
      status: "failed",
      reason: "a field outside the schema",
    });
    expect(JSON.stringify(extra.get("Q1"))).not.toContain("Zephyrine");
    const okGenre = en.judgeBatch("genre", [{ id: "Q1" }], { games: [answer("genre", "Q1")] });
    expect(Object.keys(okGenre.get("Q1").generated).sort()).toEqual(
      [...en.GENRE_FLAGS, "primary_genre"].sort(),
    );
    expect(
      en.judgeBatch("genre", [{ id: "Q1" }], { games: [answer("genre", "Q1")] }).get("Q1"),
    ).toMatchObject({ status: "ok", generated: { primary_genre: "Adventure" } });
    expect(en.judgeBatch("genre", [{ id: "Q1" }], null).get("Q1")).toMatchObject({
      status: "failed",
    });
    const short = en.judgeBatch("description", [{ id: "Q1" }], {
      games: [{ ...answer("description", "Q1"), description: "Too short." }],
    });
    expect(short.get("Q1")).toMatchObject({ status: "failed", reason: /under 15 words/ });
  });

  it("reads Wikipedia leads through normalized titles and redirects, and skips the rest", () => {
    const leads = en.parseLeads(
      {
        query: {
          normalized: [{ from: "harbor of echoes", to: "Harbor of Echoes" }],
          redirects: [{ from: "Harbor of Echoes", to: "Harbor of Echoes (video game)" }],
          pages: [
            {
              title: "Harbor of Echoes (video game)",
              extract: "A ".repeat(1000) + "end.",
              revisions: [{ revid: 42 }],
            },
            { title: "Gone", missing: true },
            {
              title: "Lantern Row",
              extract: "Lantern Row may refer to:",
              pageprops: { disambiguation: "" },
              revisions: [{ revid: 7 }],
            },
            { title: "No Rev", extract: "Text." },
          ],
        },
      },
      ["harbor of echoes", "Gone", "Lantern Row", "No Rev", "Never Asked"],
    );
    expect([...leads.keys()]).toEqual(["harbor of echoes"]);
    const l = leads.get("harbor of echoes");
    expect(l.text.length).toBeLessThanOrEqual(en.WIKI_CHARS);
    expect(l.url).toBe(
      "https://en.wikipedia.org/w/index.php?title=Harbor_of_Echoes_(video_game)&oldid=42",
    );
  });

  it("fetches Wikipedia leads one call at a time, a second apart, 20 titles a call", async () => {
    const wiki = stubWikipedia();
    const sleep = vi.fn(async () => {});
    const leads = en.wikipediaLeads({ fetchImpl: wiki, sleep, now: () => NOW });
    const titles = Array.from({ length: 45 }, (_, i) => `Game ${i}`);
    const [a, b] = await Promise.all([leads(titles.slice(0, 25)), leads(titles.slice(25))]);
    expect(a.size + b.size).toBe(45);
    expect(wiki).toHaveBeenCalledTimes(3);
    for (const [url] of wiki.mock.calls) {
      const u = new URL(url as string);
      expect(u.origin + u.pathname).toBe("https://en.wikipedia.org/w/api.php");
      expect(String(u.searchParams.get("titles")).split("|").length).toBeLessThanOrEqual(20);
    }
    // The second and third calls each waited a full interval.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 1000]);
  });
});

describe("enrichment dry-run", () => {
  it("prints counts and the bound, sends nothing and writes nothing", async () => {
    const cat = catalogue();
    const out = tmp("enrich-out-");
    // A finished game and an interrupted last line: the dry-run reads them and changes nothing.
    const file = path.join(out, "enrich-gemini-description-wikipedia.jsonl");
    const before = JSON.stringify({ qid: "Q3", status: "ok" }) + "\n" + '{"qid":"Q1","sta';
    writeFileSync(file, before);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a.join(" ")));
    await expect(
      en.main([
        "--task",
        "description",
        "--context",
        "wikipedia",
        "--catalogue",
        cat,
        "--out",
        out,
      ]),
    ).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readdirSync(out)).toEqual(["enrich-gemini-description-wikipedia.jsonl"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    const text = logs.join("\n");
    expect(text).toMatch(/games: 5 eligible; 5 for this task; 1 already done; 4 queued/);
    expect(text).toMatch(/guard bound per request: up to \$0\.\d+/);
    expect(text).toContain(
      "https://aiplatform.googleapis.com/v1beta1/projects/mgpl-508415/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent",
    );
  });

  it("refuses an unknown task or context", async () => {
    const cat = catalogue();
    await expect(
      en.main(["--task", "price", "--context", "none", "--catalogue", cat]),
    ).rejects.toThrow(/--task/);
    await expect(
      en.main(["--task", "genre", "--context", "web", "--catalogue", cat]),
    ).rejects.toThrow(/--context/);
  });
});

describe("enrichment --run through the real guard (stubbed Vertex and Wikipedia)", () => {
  it("writes labelled records to --out only, with the revision link and never the reference text", async () => {
    const { code, out, dir, logs, stub, wiki } = await run("description", [
      "--context",
      "wikipedia",
      "--batch",
      "2",
      "--parallel",
      "2",
    ]);
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(3);
    // Q4 has no Wikipedia title; the other four were asked about.
    expect(wiki).toHaveBeenCalledTimes(3);
    const files = readdirSync(out).sort();
    expect(files).toHaveLength(2);
    const recs = lines(path.join(out, "enrich-gemini-description-wikipedia.jsonl"));
    expect(recs.map((r) => r.qid).sort()).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    for (const r of recs) {
      expect(r).toMatchObject({
        schema: "mgpl-enrichment/1",
        status: "ok",
        label: "generated",
        model: "gemini-3.1-flash-lite",
        thinking_level: "MINIMAL",
        prompt_version: "s3-v1",
        generated: { description: GOOD_DESCRIPTION },
      });
      expect(r.attempt_id).toMatch(new RegExp(`^${r.run_id}:[1-3]$`));
      expect(r.batch_size).toBe(r.qid === "Q5" ? 1 : 2);
      expect(r.inputs.wikidata).toMatch(
        /^https:\/\/www\.wikidata\.org\/w\/index\.php\?title=Q\d&oldid=11$/,
      );
      expect(r.inputs.steam).toMatch(/^https:\/\/store\.steampowered\.com\/app\/10\d\/$/);
    }
    expect(recs.find((r) => r.qid === "Q4").inputs.wikipedia).toBeNull();
    expect(recs.find((r) => r.qid === "Q1").inputs.wikipedia).toMatch(
      /^https:\/\/en\.wikipedia\.org\/w\/index\.php\?title=Driftwood_Lanterns&oldid=\d+$/,
    );
    // The reference text went to the model and nowhere else.
    const sentBodies = stub.mock.calls.map((c: any) => String(c[1].body)).join("");
    expect(sentBodies).toContain(LEAD_MARK);
    for (const f of files)
      expect(readFileSync(path.join(out, f), "utf8")).not.toContain("Zephyrine");
    expect(readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")).not.toContain("Zephyrine");
    expect(logs.join("\n")).not.toContain("Zephyrine");
    const agg = aggregateOf(out);
    expect(agg).toMatchObject({
      script: "enrich-gemini",
      ledger_entry: ENTRY,
      end_status: "completed",
      requests_sent: 3,
      games: { eligible: 5, queued: 5, written: 5, ok: 5 },
      wikipedia: { calls: 3, titles: 4, leads: 4 },
    });
    expect(agg.computed_cost_usd).toBeCloseTo(3 * ((1500 * 0.25 + 400 * 1.5) / 1e6), 9);
    const l = ledger(dir);
    expect(l.filter((x) => x.type === "attempt")).toHaveLength(3);
    expect(l.filter((x) => x.type === "result").every((x) => x.outcome === "priced")).toBe(true);
    expect(l.at(-1)).toMatchObject({ type: "end", status: "completed" });
  });

  it("never stores reference text the model echoes in an extra field, and keeps no request bodies", async () => {
    const echo = vi.fn(async (_url: string, init: RequestInit) => {
      const games = gamesOf(JSON.parse(String(init.body)));
      const items = games.map((g: any) => ({
        ...answer("genre", g.id),
        ...(g.reference_text_wikipedia ? { notes: g.reference_text_wikipedia } : {}),
      }));
      return json({
        candidates: [
          { content: { role: "model", parts: [{ text: JSON.stringify({ games: items }) }] } },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      });
    });
    let capture: any = null;
    clientOptions.length = 0;
    const { code, out } = await run("genre", ["--context", "wikipedia"], {
      stub: echo,
      onCapture: (c) => (capture = c),
    });
    expect(code).toBe(0);
    for (const f of readdirSync(out))
      expect(readFileSync(path.join(out, f), "utf8")).not.toContain("Zephyrine");
    const recs = lines(path.join(out, "enrich-gemini-genre-wikipedia.jsonl"));
    expect(recs.map((r) => r.reason)).toEqual([
      "a field outside the schema",
      "a field outside the schema",
    ]);
    // Every settled exchange keeps its metadata and drops both bodies.
    expect(capture.exchanges).toHaveLength(1);
    for (const ex of capture.exchanges) {
      expect(ex.attempt).toBe(1);
      expect(ex.request_body).toBeNull();
      expect(ex.response_body).toBeNull();
    }
    // Each attempt has a finite timeout.
    expect(clientOptions).toEqual([{ timeout: en.REQUEST_TIMEOUT_MS }]);
  });

  it("holds every worker until the latest pause ends, even one already sleeping", async () => {
    let t = NOW;
    const calls: number[] = [];
    const ok = stubVertex("description");
    let n = 0;
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(t);
      const k = ++n;
      // Two requests fail with 429, the second a little later, extending the pause.
      await new Promise((r) => setTimeout(r, k === 1 ? 2 : k === 2 ? 6 : 1));
      return k <= 2 ? json({ error: { code: 429, message: "slow down" } }, 429) : ok(url, init);
    });
    const sleep = vi.fn(async (ms: number) => {
      await new Promise((r) => setTimeout(r, 10));
      t += ms;
    });
    const { code, out } = await run(
      "description",
      ["--context", "none", "--batch", "1", "--parallel", "2"],
      { stub, sleep, now: () => t },
    );
    expect(code).toBe(0);
    // The first failure pauses to +30 s; the second, while the first worker sleeps, to +60 s.
    expect(calls.slice(0, 2)).toEqual([NOW, NOW]);
    for (const at of calls.slice(2)) expect(at).toBeGreaterThanOrEqual(NOW + 60_000);
    expect(aggregateOf(out).games.ok).toBe(5);
  });

  it("reports a Wikipedia failure by its kind only, never with its message", async () => {
    // A malformed body whose parse error quotes the article text.
    const broken = vi.fn(
      async () =>
        new Response(`{"query": ${LEAD_MARK} and more`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const stub = stubVertex("description");
    const { code, out, dir, logs } = await run("description", ["--context", "wikipedia"], {
      stub,
      wiki: broken,
    });
    expect(code).toBe(1);
    expect(stub).not.toHaveBeenCalled();
    const agg = aggregateOf(out);
    expect(agg.stop_reason).toBe("Wikipedia fetch failed (invalid JSON)");
    for (const f of readdirSync(out))
      expect(readFileSync(path.join(out, f), "utf8")).not.toContain("Zephyrine");
    expect(readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8")).not.toContain("Zephyrine");
    expect(logs.join("\n")).not.toContain("Zephyrine");
    // The other kinds.
    const named = (name: string) => Object.assign(new Error(LEAD_MARK), { name });
    expect(en.errorCategory(named("AbortError"))).toBe("timeout");
    expect(en.errorCategory(named("TimeoutError"))).toBe("timeout");
    expect(en.errorCategory(new SyntaxError(LEAD_MARK))).toBe("invalid JSON");
    expect(en.errorCategory(new Error(`HTTP 503 after 4 attempts: ${LEAD_MARK}`))).toBe("HTTP 503");
    expect(
      en.errorCategory(Object.assign(new Error(LEAD_MARK), { cause: { code: "ECONNRESET" } })),
    ).toBe("network (ECONNRESET)");
    expect(en.errorCategory(new Error(LEAD_MARK))).toBe("other");
  });

  it("keeps a Vertex failure's message out of the ledger, the capture, the outputs and the console", async () => {
    const stub = vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed: ${LEAD_MARK}`), {
        cause: { code: "ECONNRESET", message: LEAD_MARK },
      });
    });
    let capture: any = null;
    const { code, out, dir, logs } = await run(
      "description",
      ["--context", "wikipedia", "--batch", "1", "--parallel", "1"],
      { stub, onCapture: (c) => (capture = c) },
    );
    expect(code).toBe(1);
    expect(stub).toHaveBeenCalledTimes(5);
    expect(aggregateOf(out).stop_reason).toBe("5 failed requests in a row");
    const ledgerText = readFileSync(path.join(dir, "spend-ledger.jsonl"), "utf8");
    expect(ledgerText).not.toContain("Zephyrine");
    expect(
      ledger(dir)
        .filter((x) => x.type === "result")
        .map((x) => x.reason),
    ).toEqual(Array(5).fill("TypeError (ECONNRESET)"));
    expect(JSON.stringify(capture.exchanges)).not.toContain("Zephyrine");
    for (const f of readdirSync(out))
      expect(readFileSync(path.join(out, f), "utf8")).not.toContain("Zephyrine");
    expect(logs.join("\n")).not.toContain("Zephyrine");
  });

  it("copies Steam's friction facts as sourced beside the generated draft", async () => {
    const { code, out } = await run("friction", ["--context", "none", "--top", "2"]);
    expect(code).toBe(0);
    const recs = lines(path.join(out, "enrich-gemini-friction-none.jsonl"));
    expect(recs.map((r) => r.qid)).toEqual(["Q3", "Q1"]);
    expect(recs[0]).toMatchObject({
      generated: { save_system: "save_anywhere", always_online: "no" },
      sourced: {
        save_anytime: true,
        steam_cloud: true,
        source: "https://store.steampowered.com/app/103/",
      },
    });
  });

  it("resumes: a finished game is skipped, a failed one is asked again", async () => {
    const out = tmp("enrich-out-");
    const dir = records();
    const agents = agentsWithEntry(out);
    writeFileSync(
      path.join(out, "enrich-gemini-genre-none.jsonl"),
      [
        JSON.stringify({ qid: "Q3", status: "ok" }),
        JSON.stringify({ qid: "Q2", status: "failed" }),
      ].join("\n") + '\n{"qid":"Q9","sta',
    );
    const { code, stub } = await run("genre", ["--context", "none"], { out, dir, agents });
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(gamesOf(JSON.parse(String(stub.mock.calls[0][1].body))).map((g: any) => g.id)).toEqual([
      "Q2",
    ]);
    // The interrupted line was cut off; the earlier lines are kept.
    const recs = lines(path.join(out, "enrich-gemini-genre-none.jsonl"));
    expect(recs.map((r) => `${r.qid}:${r.status}`)).toEqual(["Q3:ok", "Q2:failed", "Q2:ok"]);
    // Nothing left: no run is opened, so no reservation is held.
    await expect(run("genre", ["--context", "none"], { out, dir, agents })).rejects.toThrow(
      /nothing to do/,
    );
    expect(ledger(dir).filter((x) => x.type === "reservation")).toHaveLength(1);
  });

  it("ends cleanly when the reservation cannot hold the next request's bound", async () => {
    // Each answer costs about $0.09; a bound is about $0.1; $0.25 holds two answers, then stops.
    const stub = stubVertex("description", { promptTokenCount: 1000, candidatesTokenCount: 60000 });
    const { code, out, dir } = await run(
      "description",
      ["--context", "none", "--batch", "1", "--parallel", "1", "--reserve", "0.25"],
      { stub },
    );
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(2);
    const agg = aggregateOf(out);
    expect(agg.end_status).toBe("cap_reached");
    expect(agg.stop_reason).toMatch(/^reservation used/);
    expect(agg.games.written).toBe(2);
    // The guard never had to refuse: the script stopped first.
    const l = ledger(dir);
    expect(l.filter((x) => x.type === "attempt")).toHaveLength(2);
    expect(l.at(-1)).toMatchObject({ type: "end", status: "cap_reached" });
  });

  it("never has more bounds in flight than the reservation holds", async () => {
    let inFlight = 0;
    let most = 0;
    const answerAll = stubVertex("description");
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return answerAll(url, init);
    });
    const { code, out } = await run(
      "description",
      ["--context", "none", "--batch", "1", "--parallel", "8", "--reserve", "0.25"],
      { stub },
    );
    expect(code).toBe(0);
    const rates = await lib.loadRates();
    const bound = lib.maxRequestCostUsd(
      rates,
      en.MODEL,
      String(stub.mock.calls[0][1].body),
    ).max_cost_usd;
    expect(most).toBe(Math.floor(0.25 / bound));
    expect(most).toBeLessThan(8);
    expect(aggregateOf(out).games.written).toBe(5);
  });

  it("backs off after a 429 and retries; each retry is a counted attempt", async () => {
    const ok = stubVertex("description");
    let n = 0;
    const stub = vi.fn(async (url: string, init: RequestInit) =>
      ++n === 1 ? json({ error: { code: 429, message: "slow down" } }, 429) : ok(url, init),
    );
    const { code, out, dir, sleep } = await run(
      "description",
      ["--context", "none", "--batch", "5", "--parallel", "1"],
      { stub },
    );
    expect(code).toBe(0);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
    const l = ledger(dir);
    expect(l.filter((x) => x.type === "attempt")).toHaveLength(2);
    expect(l.filter((x) => x.type === "result").map((x) => x.outcome)).toEqual([
      "http_error",
      "priced",
    ]);
    const recs = lines(path.join(out, "enrich-gemini-description-none.jsonl"));
    expect(recs.every((r) => r.status === "ok" && r.attempt_id.endsWith(":2"))).toBe(true);
  });

  it("stops after five failed requests in a row, and writes the asked games as failed", async () => {
    const stub = vi.fn(async () => json({ error: { code: 500, message: "boom" } }, 500));
    const { code, out, dir } = await run(
      "description",
      ["--context", "none", "--batch", "1", "--parallel", "1"],
      { stub },
    );
    expect(code).toBe(1);
    expect(stub).toHaveBeenCalledTimes(5);
    const agg = aggregateOf(out);
    expect(agg.stop_reason).toBe("5 failed requests in a row");
    expect(agg.end_status).toBe("failed");
    const recs = lines(path.join(out, "enrich-gemini-description-none.jsonl"));
    expect(recs.every((r) => r.status === "failed")).toBe(true);
    // The unanswered attempts count at their bound.
    const l = ledger(dir);
    expect(l.filter((x) => x.type === "result").every((x) => x.outcome === "http_error")).toBe(
      true,
    );
    expect(agg.computed_cost_usd).toBeCloseTo(
      l.filter((x) => x.type === "attempt").reduce((s, x) => s + x.max_cost_usd, 0),
      9,
    );
  });

  it("an unusable answer fails its games and is not retried in the same run", async () => {
    const stub = vi.fn(async () =>
      json({
        candidates: [{ content: { role: "model", parts: [{ text: "not json" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
    );
    const { code, out } = await run("genre", ["--context", "none", "--batch", "3"], { stub });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    const recs = lines(path.join(out, "enrich-gemini-genre-none.jsonl"));
    expect(recs.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("refuses an output folder other than the entry's, or inside the repository, before anything", async () => {
    const stub = stubVertex("description");
    await expect(
      run("description", ["--context", "none"], { stub, entryOut: tmp("enrich-other-") }),
    ).rejects.toThrow(/output location entry #991 names/);
    await expect(
      run("description", ["--context", "none"], { stub, out: path.join(ROOT, "DOCS", "x") }),
    ).rejects.toThrow(/outside the repository/);
    expect(stub).not.toHaveBeenCalled();
  });

  it("refuses a reservation larger than the entry has left, or too small for one request", async () => {
    const stub = stubVertex("description");
    const out = tmp("enrich-out-");
    await expect(
      run("description", ["--context", "none", "--reserve", "20"], {
        stub,
        out,
        agents: agentsWithEntry(out, "200000", "$15"),
      }),
    ).rejects.toThrow(/has \$15 left/);
    await expect(
      run("description", ["--context", "none", "--reserve", "0.01"], { stub }),
    ).rejects.toThrow(/cannot hold it/);
    await expect(
      run("description", ["--context", "none", "--reserve", "51"], { stub }),
    ).rejects.toThrow(/at most 50/);
    expect(stub).not.toHaveBeenCalled();
  });
});
describe("WU-030: --fill-from", () => {
  it("takes the games whose latest record in the other context is rejected or insufficient", () => {
    const dir = tmp("enrich-fill-");
    const file = path.join(dir, "enrich-gemini-description-wikipedia.jsonl");
    const before =
      [
        { qid: "Q1", status: "rejected" },
        { qid: "Q2", status: "insufficient" },
        { qid: "Q3", status: "ok" },
        { qid: "Q4", status: "failed" },
        { qid: "Q5", status: "failed" },
        { qid: "Q5", status: "rejected" },
        { qid: "Q6", status: "insufficient" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + '\n{"qid":"Q7","status":"rej';
    writeFileSync(file, before);
    expect([...en.fillIds(file)].sort()).toEqual(["Q1", "Q2", "Q5", "Q6"]);
    // Read only: an incomplete last line is skipped, and the file is not changed.
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(en.fillIds(path.join(dir, "absent.jsonl")).size).toBe(0);
  });

  it("drafts only those games again, without Wikipedia, and marks the records", async () => {
    const out = tmp("enrich-out-");
    const wikiFile = path.join(out, "enrich-gemini-description-wikipedia.jsonl");
    // The other run's file ends in an incomplete line, as if its run were still writing.
    const wikiBefore =
      [
        { qid: "Q1", status: "rejected" },
        { qid: "Q2", status: "insufficient" },
        { qid: "Q3", status: "ok" },
        { qid: "Q4", status: "failed" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + '\n{"qid":"Q5","sta';
    writeFileSync(wikiFile, wikiBefore);
    const { code, stub, wiki } = await run(
      "description",
      ["--context", "none", "--fill-from", "wikipedia"],
      { out },
    );
    expect(code).toBe(0);
    expect(wiki).not.toHaveBeenCalled();
    expect(stub).toHaveBeenCalledTimes(1);
    const asked = gamesOf(JSON.parse(String(stub.mock.calls[0][1].body))).map((g: any) => g.id);
    expect(asked.sort()).toEqual(["Q1", "Q2"]);
    const recs = lines(path.join(out, "enrich-gemini-description-none.jsonl"));
    expect(recs.map((r) => `${r.qid}:${r.status}:${r.filled_from}`).sort()).toEqual([
      "Q1:ok:wikipedia",
      "Q2:ok:wikipedia",
    ]);
    expect(aggregateOf(out).games).toMatchObject({ fill_from: "wikipedia", for_task: 2 });
    // The other context's file is untouched, its incomplete last line included.
    expect(readFileSync(wikiFile, "utf8")).toBe(wikiBefore);
  });

  it("refuses the same context, an unknown one, or no --out", async () => {
    const cat = catalogue();
    const base = ["--task", "description", "--context", "none", "--catalogue", cat];
    await expect(en.main([...base, "--fill-from", "none", "--out", tmp("o-")])).rejects.toThrow(
      /--fill-from must name the other context/,
    );
    await expect(en.main([...base, "--fill-from", "web", "--out", tmp("o-")])).rejects.toThrow(
      /--fill-from must name the other context/,
    );
    await expect(en.main([...base, "--fill-from", "wikipedia"])).rejects.toThrow(
      /--fill-from needs --out/,
    );
  });
});

// Append to test/unit/catalogueEnrich.test.ts using its existing offline SDK helpers.
// Author-owned first-release test; no Search tool or grounding admission change.
it("WU-034 serializes and guards the ungrounded check request exactly", async () => {
  const params = en.requestParams("check", [
    {
      id: "Q1",
      title: "Synthetic Harbor",
      description: "Synthetic draft.",
      source_text: "Synthetic source.",
    },
  ]);
  expect(params.model).toBe("gemini-3.8-flash");
  expect(params.config.thinkingConfig.thinkingLevel).toBe("LOW");
  expect(params.config.tools).toBeUndefined();
  const seen: string[] = [];
  const client = makeClient({
    fetch: async (_url: string, init: RequestInit) => {
      seen.push(String(init.body));
      return json({ candidates: [], usageMetadata: { promptTokenCount: 1 } });
    },
  });
  await client.models.generateContent(params);
  expect(seen).toHaveLength(1);
  expect(en.vertexBody(params)).toBe(seen[0]);
  expect(JSON.parse(seen[0]).tools).toBeUndefined();
  const rates = await lib.loadRates();
  const bound = lib.maxRequestCostUsd(rates, params.model, seen[0]);
  expect(bound.grounding).toBe(false);
  expect(bound.fees_usd).toBe(0);
  expect(params.config.maxOutputTokens).toBe(768);
  const row = rates.models["gemini-3.8-flash"];
  const inputBytes = Buffer.byteLength(seen[0], "utf8");
  const outputCeiling = row.max_output_tokens + params.config.maxOutputTokens;
  const exact = Math.ceil(((inputBytes * 0.75 + outputCeiling * 3.75) / 1_000_000) * 1e9) / 1e9;
  expect(row.max_output_tokens).toBe(65536);
  expect(bound.input_ceiling_tokens).toBe(inputBytes);
  expect(bound.output_ceiling_tokens).toBe(outputCeiling);
  expect(bound.max_cost_usd).toBe(exact);
});

function deferred<T = void>() {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (err?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Codex review regressions for WU-034 G (check mode)", () => {
  it("P1: refuses redirects during pinned Wikipedia retrieval and never reaches destination or billable model", async () => {
    let destHits = 0;
    const destServer = http.createServer((_req, res) => {
      destHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          query: {
            pages: [
              {
                title: "Malicious Page",
                revisions: [
                  {
                    revid: 1001,
                    slots: { main: { contentmodel: "wikitext", content: "Pwned content." } },
                  },
                ],
              },
            ],
          },
        }),
      );
    });

    await new Promise((resolve) => destServer.listen(0, "127.0.0.1", resolve));
    const destPort = (destServer.address() as any).port;

    try {
      // 1. Direct guarded fetch test using real loopback transport via realFetch
      const guardedRedirectFetch = async (_url: string | URL, init: RequestInit = {}) => {
        return realFetch(`http://127.0.0.1:${destPort}/redirect`, {
          ...init,
          redirect: init.redirect,
        });
      };

      // When the server responds with a 302 pointing to destination
      const redirectServer = http.createServer((req, res) => {
        if (req.url === "/redirect") {
          res.writeHead(302, { location: `http://127.0.0.1:${destPort}/destination` });
          res.end();
        } else {
          destHits++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ query: { pages: [] } }));
        }
      });
      await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
      const redirPort = (redirectServer.address() as any).port;

      try {
        const fetcher = en.wikipediaRevisionFetcher({
          fetchImpl: async (_u: any, init: any) => {
            return realFetch(`http://127.0.0.1:${redirPort}/redirect`, {
              ...init,
              redirect: init?.redirect,
            });
          },
          sleep: async () => {},
          now: () => NOW,
        });

        await expect(
          fetcher({ oldid: 1001, canonicalUrl: "https://en.wikipedia.org/w/index.php?oldid=1001" }),
        ).rejects.toThrow(/Wikipedia revision (redirect refused|request left approved origin)/);
        expect(destHits).toBe(0);
      } finally {
        await new Promise((resolve) => redirectServer.close(resolve));
      }

      // 2. Full CLI check run: redirect server causes check run failure, no model call, no source accepted
      const out = tmp("enrich-check-redir-out-");
      const dir = records();
      const agents = agentsWithEntry(out, "200000", "$160", "JDG");
      const checkInputFile = path.join(out, "check-input.jsonl");
      const desc =
        "A slow coastal exploration game in which the player restores a chain of lanterns.";
      const descSha = createHash("sha256").update(desc, "utf8").digest("hex");
      writeFileSync(
        checkInputFile,
        JSON.stringify({
          schema: "mgpl-description-check-input/2",
          qid: "Q1",
          description: desc,
          description_sha256: descSha,
          promoted_at: new Date(NOW).toISOString(),
          sample_summary_sha256: "0".repeat(64),
          source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1001" },
          review_count: 50,
        }) + "\n",
      );

      let modelCalled = 0;
      const fakeClient = {
        models: {
          generateContent: async () => {
            modelCalled++;
            return {
              text: JSON.stringify({
                games: [
                  {
                    id: "Q1",
                    verdict: "consistent",
                    reason: "ok",
                    confidence: 0.9,
                  },
                ],
              }),
            };
          },
        },
      };

      const redirWikiFetch = vi.fn(async () => {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${destPort}/destination` },
        });
      });

      const exitCode = await en.main(
        [
          "--run",
          "--entry",
          ENTRY,
          "--task",
          "check",
          "--check-input",
          checkInputFile,
          "--out",
          out,
          "--reserve",
          "3",
        ],
        {
          dir,
          agentsPath: agents,
          now: () => NOW,
          sleep: async () => {},
          wikiFetch: redirWikiFetch,
          makeClient: () => fakeClient,
          log: () => {},
          interrupts: new EventEmitter(),
        },
      );

      expect(exitCode).toBe(1);
      expect(modelCalled).toBe(0);
      expect(destHits).toBe(0);

      const checkOutFile = path.join(out, "enrich-gemini-check.jsonl");
      expect(existsSync(checkOutFile)).toBe(false);

      const agg = aggregateOf(out);
      expect(agg.end_status).toBe("failed");
      expect(agg.stop_reason).toMatch(/Wikipedia fetch failed/);
      expect(agg.requests_sent).toBe(0);

      const led = ledger(dir);
      const endRec = led.find((r) => r.type === "end");
      expect(endRec).toMatchObject({ status: "failed" });
      expect(led.filter((r) => r.type === "attempt")).toHaveLength(0);
    } finally {
      await new Promise((resolve) => destServer.close(resolve));
    }
  });

  it("P2: claims parallel request and dollar capacity before source retrieval", async () => {
    const out = tmp("enrich-check-p2-out-");
    const dir = records();
    // Entry has request cap = 1
    const agents = agentsWithEntry(out, "1", "$10", "JDG");
    const checkInputFile = path.join(out, "check-input.jsonl");
    const desc = "A slow coastal exploration game in which the player restores lanterns.";
    const descSha = createHash("sha256").update(desc, "utf8").digest("hex");

    const rows = [
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q1",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1001" },
        review_count: 100,
      },
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q2",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1002" },
        review_count: 50,
      },
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q3",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1003" },
        review_count: 25,
      },
    ];
    writeFileSync(checkInputFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    let wikiFetches = 0;
    const wikiFetch = vi.fn(async (url: string) => {
      wikiFetches++;
      const u = new URL(url);
      const revid = Number(u.searchParams.get("revids"));
      return json({
        query: {
          pages: [
            {
              title: "Source",
              revisions: [
                {
                  revid,
                  slots: {
                    main: {
                      contentmodel: "wikitext",
                      content: "Invented source text about coastal lanterns.",
                    },
                  },
                },
              ],
            },
          ],
        },
      });
    });

    let modelCalls = 0;
    const vertexStub = vi.fn(async () => {
      modelCalls++;
      return json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify({
                    games: [
                      {
                        id: "Q1",
                        verdict: "consistent",
                        reason: "Matches source.",
                        confidence: 0.9,
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      });
    });

    // 1 attempt cap, 3 workers, batch size 1
    const exitCode = await en.main(
      [
        "--run",
        "--entry",
        ENTRY,
        "--task",
        "check",
        "--check-input",
        checkInputFile,
        "--out",
        out,
        "--reserve",
        "3",
        "--parallel",
        "3",
        "--batch",
        "1",
      ],
      {
        dir,
        agentsPath: agents,
        now: () => NOW,
        sleep: async () => {},
        wikiFetch,
        baseFetch: vertexStub,
        makeClient,
        log: () => {},
        interrupts: new EventEmitter(),
      },
    );

    // Because only 1 attempt was allowed in the cap, exactly 1 batch's sources should be fetched
    expect(wikiFetches).toBe(1);
    expect(modelCalls).toBe(1);
    expect(exitCode).toBe(0); // cap_reached exit code is 0

    const agg = aggregateOf(out);
    expect(agg.end_status).toBe("cap_reached");
    expect(agg.stop_reason).toMatch(/request cap is reached/);
    expect(agg.requests_sent).toBe(1);

    const led = ledger(dir);
    expect(led.filter((r) => r.type === "attempt")).toHaveLength(1);
    expect(led.find((r) => r.type === "end")).toMatchObject({ status: "cap_reached" });
  });

  it("P2: releases claimed capacity on retrieval failure without leaking headroom", async () => {
    const out = tmp("enrich-check-p2-fail-");
    const dir = records();
    const agents = agentsWithEntry(out, "2", "$10", "JDG");
    const checkInputFile = path.join(out, "check-input.jsonl");
    const desc = "A slow coastal exploration game in which the player restores lanterns.";
    const descSha = createHash("sha256").update(desc, "utf8").digest("hex");

    writeFileSync(
      checkInputFile,
      JSON.stringify({
        schema: "mgpl-description-check-input/2",
        qid: "Q1",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1001" },
        review_count: 100,
      }) + "\n",
    );

    const wikiFetch = vi.fn(async () => {
      throw new Error("network down");
    });

    const modelCalls = vi.fn();

    const exitCode = await en.main(
      [
        "--run",
        "--entry",
        ENTRY,
        "--task",
        "check",
        "--check-input",
        checkInputFile,
        "--out",
        out,
        "--reserve",
        "3",
        "--parallel",
        "2",
        "--batch",
        "1",
      ],
      {
        dir,
        agentsPath: agents,
        now: () => NOW,
        sleep: async () => {},
        wikiFetch,
        baseFetch: modelCalls,
        makeClient,
        log: () => {},
        interrupts: new EventEmitter(),
      },
    );

    expect(exitCode).toBe(1);
    expect(modelCalls).not.toHaveBeenCalled();

    const agg = aggregateOf(out);
    expect(agg.end_status).toBe("failed");
    expect(agg.stop_reason).toMatch(/Wikipedia fetch failed/);
    expect(agg.requests_sent).toBe(0);

    const led = ledger(dir);
    expect(led.filter((r) => r.type === "attempt")).toHaveLength(0);
    expect(led.find((r) => r.type === "end")).toMatchObject({ status: "failed" });

    // Verify headroom in AGENTS.md / ledger shows capacity was not leaked or consumed
    const hr = await en.entryHeadroom({
      entry: ENTRY,
      dir,
      agentsPath: agents,
      mode: "check",
    });
    expect(hr.requests).toBe(2);
    expect(hr.usd).toBe(7);
  });

  it("P2: a retry blocked by another worker's request claim does not cancel that worker", async () => {
    const out = tmp("enrich-check-p2-retry-blocked-");
    const dir = records();
    // 2 attempts cap
    const agents = agentsWithEntry(out, "2", "$10", "JDG");
    const checkInputFile = path.join(out, "check-input.jsonl");
    const desc = "A slow coastal exploration game in which the player restores lanterns.";
    const descSha = createHash("sha256").update(desc, "utf8").digest("hex");

    const rows = [
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q1",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1001" },
        review_count: 100,
      },
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q2",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1002" },
        review_count: 50,
      },
    ];
    writeFileSync(checkInputFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const workerBFetchBarrier = deferred();
    const workerAAttempt1Dispatched = deferred();

    let wikiFetches = 0;
    const wikiFetch = vi.fn(async (url: string) => {
      wikiFetches++;
      const u = new URL(url);
      const revid = Number(u.searchParams.get("revids"));
      if (revid === 1002) {
        // Worker B holds its source retrieval claim until Worker A dispatches and fails
        await workerBFetchBarrier.promise;
      }
      return json({
        query: {
          pages: [
            {
              title: "Source",
              revisions: [
                {
                  revid,
                  slots: {
                    main: {
                      contentmodel: "wikitext",
                      content: "Invented source text about coastal lanterns.",
                    },
                  },
                },
              ],
            },
          ],
        },
      });
    });

    let modelCalls = 0;
    const vertexStub = vi.fn(async (_url: string, init: RequestInit) => {
      modelCalls++;
      const games = gamesOf(JSON.parse(String(init.body)));
      const qid = games[0]?.id;
      if (qid === "Q1") {
        // Worker A attempt 1 fails with HTTP 503
        workerAAttempt1Dispatched.resolve();
        return json({ error: "service unavailable" }, 503);
      }
      // Worker B succeeds
      return json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify({
                    games: [
                      {
                        id: qid,
                        verdict: "consistent",
                        reason: "Matches source.",
                        confidence: 0.9,
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      });
    });

    // When Worker A dispatches attempt 1 (HTTP 503), it enters retry.
    // Worker B still holds the other request claim.
    // Worker A cannot cancel Worker B; once Worker A is in its retry path, release Worker B.
    workerAAttempt1Dispatched.promise.then(() => {
      setImmediate(() => {
        workerBFetchBarrier.resolve();
      });
    });

    const exitCode = await en.main(
      [
        "--run",
        "--entry",
        ENTRY,
        "--task",
        "check",
        "--check-input",
        checkInputFile,
        "--out",
        out,
        "--reserve",
        "3",
        "--parallel",
        "2",
        "--batch",
        "1",
      ],
      {
        dir,
        agentsPath: agents,
        now: () => NOW,
        sleep: async () => {},
        wikiFetch,
        baseFetch: vertexStub,
        makeClient,
        log: () => {},
        interrupts: new EventEmitter(),
      },
    );

    expect(exitCode).toBe(0); // Cap reached exit code is 0
    expect(wikiFetches).toBe(2);
    expect(modelCalls).toBe(2); // 1 for Q1 (503) + 1 for Q2 (ok). Attempt cap of 2 enforced!

    const checkOutFile = path.join(out, "enrich-gemini-check.jsonl");
    const checkLines = lines(checkOutFile);
    expect(checkLines).toHaveLength(2);
    const q1Rec = checkLines.find((r) => r.qid === "Q1");
    const q2Rec = checkLines.find((r) => r.qid === "Q2");
    expect(q1Rec).toMatchObject({ qid: "Q1", status: "failed" });
    expect(q2Rec).toMatchObject({
      qid: "Q2",
      status: "ok",
      generated: { verdict: "consistent" },
    });

    const agg = aggregateOf(out);
    expect(agg.end_status).toBe("cap_reached");
    expect(agg.stop_reason).toMatch(/request cap is reached/);
    expect(agg.requests_sent).toBe(2);

    const led = ledger(dir);
    expect(led.filter((r) => r.type === "attempt")).toHaveLength(2);
    expect(led.find((r) => r.type === "end")).toMatchObject({ status: "cap_reached" });
  });

  it("P2: an unaffordable next batch does not cancel an already-affordable claim", async () => {
    const out = tmp("enrich-check-p2-dollar-unaffordable-");
    const dir = records();
    const agents = agentsWithEntry(out, "10", "$10", "JDG");
    const checkInputFile = path.join(out, "check-input.jsonl");
    const descShort = "A slow coastal exploration game in which the player restores lanterns.";
    const descShortSha = createHash("sha256").update(descShort, "utf8").digest("hex");
    // Long description for Q3 so that its bound b3 is strictly larger than b2
    const descLong =
      descShort + " ".repeat(4000) + "Extra long description details for game three.";
    const descLongSha = createHash("sha256").update(descLong, "utf8").digest("hex");

    const rows = [
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q1",
        description: descShort,
        description_sha256: descShortSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1001" },
        review_count: 100,
      },
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q2",
        description: descShort,
        description_sha256: descShortSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1002" },
        review_count: 50,
      },
      {
        schema: "mgpl-description-check-input/2",
        qid: "Q3",
        description: descLong,
        description_sha256: descLongSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1003" },
        review_count: 25,
      },
    ];
    writeFileSync(checkInputFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const rates = await lib.loadRates();
    const checkRows = en.loadCheckInput(checkInputFile);
    const b1 = en.planBound(rates, "check", [[checkRows[0]]], "none");
    const b2 = en.planBound(rates, "check", [[checkRows[1]]], "none");
    const b3 = en.planBound(rates, "check", [[checkRows[2]]], "none");
    expect(b3).toBeGreaterThan(b2);

    // Reserve is sized to hold b1 + b2 with room, but cannot hold b1 + b3
    const reserve = (b1 + b2 + (b3 - b2) / 2).toFixed(6);

    const workerBFetchBarrier = deferred();
    const workerASettled = deferred();

    let wikiFetches = 0;
    const wikiFetch = vi.fn(async (url: string) => {
      wikiFetches++;
      const u = new URL(url);
      const revid = Number(u.searchParams.get("revids"));
      if (revid === 1002) {
        // Worker B holds its source retrieval claim
        await workerBFetchBarrier.promise;
      }
      return json({
        query: {
          pages: [
            {
              title: "Source",
              revisions: [
                {
                  revid,
                  slots: {
                    main: {
                      contentmodel: "wikitext",
                      content: "\u0001".repeat(en.WIKI_CHARS),
                    },
                  },
                },
              ],
            },
          ],
        },
      });
    });

    let modelCalls = 0;
    const vertexStub = vi.fn(async (_url: string, init: RequestInit) => {
      modelCalls++;
      const games = gamesOf(JSON.parse(String(init.body)));
      const qid = games[0]?.id;
      if (qid === "Q1") {
        // Worker A completes with MISSING usage metadata, committing the full conservative bound b1
        setImmediate(() => workerASettled.resolve());
        return json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      games: [
                        {
                          id: "Q1",
                          verdict: "consistent",
                          reason: "Matches source.",
                          confidence: 0.9,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
          // usageMetadata omitted -> conservative bound b1 committed
        });
      }
      return json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify({
                    games: [
                      {
                        id: qid,
                        verdict: "consistent",
                        reason: "Matches source.",
                        confidence: 0.9,
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      });
    });

    // When Worker A settles, it checks Q3 and finds Q3 unaffordable.
    // It must not cancel Worker B.
    workerASettled.promise.then(() => {
      setImmediate(() => {
        workerBFetchBarrier.resolve();
      });
    });

    const exitCode = await en.main(
      [
        "--run",
        "--entry",
        ENTRY,
        "--task",
        "check",
        "--check-input",
        checkInputFile,
        "--out",
        out,
        "--reserve",
        reserve,
        "--parallel",
        "2",
        "--batch",
        "1",
      ],
      {
        dir,
        agentsPath: agents,
        now: () => NOW,
        sleep: async () => {},
        wikiFetch,
        baseFetch: vertexStub,
        makeClient,
        log: () => {},
        interrupts: new EventEmitter(),
      },
    );

    expect(exitCode).toBe(0);
    // Q1 and Q2 were fetched and dispatched; Q3 was never fetched or dispatched
    expect(wikiFetches).toBe(2);
    expect(modelCalls).toBe(2);

    const checkOutFile = path.join(out, "enrich-gemini-check.jsonl");
    const checkLines = lines(checkOutFile);
    expect(checkLines).toHaveLength(2);
    expect(checkLines.map((r) => r.qid).sort()).toEqual(["Q1", "Q2"]);
    expect(checkLines.every((r) => r.status === "ok")).toBe(true);

    const agg = aggregateOf(out);
    expect(agg.end_status).toBe("cap_reached");
    expect(agg.stop_reason).toMatch(/reservation used: the next request's bound does not fit/);
    expect(agg.requests_sent).toBe(2);
    expect(agg.computed_cost_usd).toBeLessThanOrEqual(Number(reserve));

    const led = ledger(dir);
    expect(led.filter((r) => r.type === "attempt")).toHaveLength(2);
    expect(led.find((r) => r.type === "end")).toMatchObject({ status: "cap_reached" });
  });

  it("P3: reports failed check work as an unsuccessful run and nonzero exit code", async () => {
    const out = tmp("enrich-check-p3-out-");
    const dir = records();
    const agents = agentsWithEntry(out, "200000", "$160", "JDG");
    const checkInputFile = path.join(out, "check-input.jsonl");
    const desc = "A slow coastal exploration game in which the player restores lanterns.";
    const descSha = createHash("sha256").update(desc, "utf8").digest("hex");

    writeFileSync(
      checkInputFile,
      JSON.stringify({
        schema: "mgpl-description-check-input/2",
        qid: "Q1",
        description: desc,
        description_sha256: descSha,
        promoted_at: new Date(NOW).toISOString(),
        sample_summary_sha256: "0".repeat(64),
        source: { url: "https://en.wikipedia.org/w/index.php?title=Source&oldid=1001" },
        review_count: 100,
      }) + "\n",
    );

    const wikiFetch = vi.fn(async () =>
      json({
        query: {
          pages: [
            {
              title: "Source",
              revisions: [
                {
                  revid: 1001,
                  slots: {
                    main: {
                      contentmodel: "wikitext",
                      content: "Invented source text about coastal lanterns.",
                    },
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    // Model returns an invalid verdict string ("approved" instead of consistent/contradicts/doubtful)
    const invalidStub = vi.fn(async () =>
      json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify({
                    games: [
                      {
                        id: "Q1",
                        verdict: "approved",
                        reason: "SECRET_LEAK_STRING Should not be leaked in diagnostics",
                        confidence: 0.9,
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      }),
    );

    const logs: string[] = [];
    const exitCode = await en.main(
      [
        "--run",
        "--entry",
        ENTRY,
        "--task",
        "check",
        "--check-input",
        checkInputFile,
        "--out",
        out,
        "--reserve",
        "3",
      ],
      {
        dir,
        agentsPath: agents,
        now: () => NOW,
        sleep: async () => {},
        wikiFetch,
        baseFetch: invalidStub,
        makeClient,
        log: (s: string) => logs.push(s),
        interrupts: new EventEmitter(),
      },
    );

    // Assert main() returns a nonzero exit code
    expect(exitCode).toBe(1);

    // The requested row is failed in the review queue
    const checkOutFile = path.join(out, "enrich-gemini-check.jsonl");
    const checkLines = lines(checkOutFile);
    expect(checkLines).toHaveLength(1);
    expect(checkLines[0]).toMatchObject({
      qid: "Q1",
      status: "failed",
      reason: "verdict is not one of its options",
      generated: null,
    });

    // Ledger end and aggregate status indicate unsuccessful work
    const agg = aggregateOf(out);
    expect(agg.end_status).toBe("failed");
    expect(agg.games.failed).toBe(1);

    const led = ledger(dir);
    const endRec = led.find((r) => r.type === "end");
    expect(endRec).toMatchObject({ status: "failed" });

    // Invalid response content is not persisted through diagnostics or logs
    const allOutContent = readdirSync(out)
      .map((f) => readFileSync(path.join(out, f), "utf8"))
      .join("\n");
    expect(allOutContent).not.toContain("SECRET_LEAK_STRING");
    expect(logs.join("\n")).not.toContain("SECRET_LEAK_STRING");
  });
});
