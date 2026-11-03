// Task proposal 021: matching titles read from a library page to the catalogue, offline.
// Invented catalogue records; no personal data and no network.
// cspell:words Sturmjager Sturmjäger Ronin Rōnin wikidata xids Clancy
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let m: any;
const tmp: string[] = [];
beforeAll(async () => {
  m = await import("../../scripts/catalogue/match-titles.mjs");
});
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true });
});

const PS4 = "Q5014725";
const PS5 = "Q63184502";
const rec = (qid: string, label: string, year: number, platforms: string[] = []) => ({
  qid,
  label,
  release_dates: [{ iso: `${year}-01-01`, precision: "day" }],
  platforms: platforms.map((id) => ({ id, label: null })),
});
const catalogue = [
  rec("Q1", "Wolverine", 2026, [PS5]),
  rec("Q2", "Sturmjager", 2027, [PS5]),
  rec("Q3", "Metal Gear Solid Delta: Snake Eater", 2025, [PS5]),
  rec("Q4", "Red Dead Redemption", 2010, [PS4, PS5]),
  rec("Q5", "Until Dawn", 2015, [PS4]),
  rec("Q6", "Until Dawn", 2024, [PS5]),
  rec("Q7", "Rise of the Rōnin", 2024, [PS5]),
  rec("Q8", "Rise of the Argonauts", 2008, []),
  rec("Q9", "Alien: Rogue Incursion", 2024, [PS5]),
  rec("Q10", "Marathon", 1994, []),
  rec("Q11", "Marathon", 1995, []),
  rec("Q12", "Hollow Knight", 2017, [PS4, PS5]),
  rec("Q13", "Tomb Raider I–III Remastered", 2024, [PS4, PS5]),
  rec("Q14", "Spider-Man: Miles Morales", 2020, [PS4, PS5]),
];
const xids = [{ qid: "Q13", aliases: ["Tomb Raider I-III Remastered Starring Lara Croft"] }];

describe("proposal 021: matching a library page to the catalogue", () => {
  const index = () => m.buildIndex(catalogue, xids);
  const one = (title: string, platforms: string[] = ["PS5"]) =>
    m.matchTitle(index(), { title, platforms });

  it("confirms an exact title, and a title with a store edition label removed", () => {
    expect(one("Hollow Knight", ["PS4"])).toMatchObject({
      status: "confirmed",
      method: "exact",
      chosen: "Q12",
    });
    for (const t of ["Red Dead Redemption (PS4 & PS5)", "Red Dead Redemption Standard Edition"])
      expect(one(t)).toMatchObject({ status: "confirmed", method: "edition", chosen: "Q4" });
  });

  it("only suggests a brand-prefix, symbol, accent, alias or VR match: the user confirms", () => {
    expect(one("Marvel's Wolverine")).toMatchObject({ status: "suggested", method: "prefix" });
    expect(one("Marvel's Spider-Man: Miles Morales")).toMatchObject({
      status: "suggested",
      method: "prefix",
      chosen: "Q14",
    });
    expect(one("Metal Gear Solid Δ: Snake Eater")).toMatchObject({
      status: "suggested",
      method: "symbol",
      chosen: "Q3",
    });
    expect(one("Sturmjäger")).toMatchObject({
      status: "suggested",
      method: "accent",
      chosen: "Q2",
    });
    expect(one("Rise of the Ronin")).toMatchObject({
      status: "suggested",
      method: "accent",
      chosen: "Q7",
    });
    expect(one("Tomb Raider I-III Remastered Starring Lara Croft")).toMatchObject({
      status: "suggested",
      method: "alias",
      chosen: "Q13",
    });
    expect(one("Alien: Rogue Incursion VR")).toMatchObject({
      status: "suggested",
      method: "vr",
      chosen: "Q9",
    });
    for (const s of m.SUGGESTED_METHODS) expect(m.CONFIRMED_METHODS).not.toContain(s);
  });

  it("narrows several candidates by the PlayStation badge, and never guesses otherwise", () => {
    expect(one("Until Dawn", ["PS5"])).toMatchObject({
      status: "confirmed",
      chosen: "Q6",
      narrowed_by_platform: true,
    });
    expect(one("Until Dawn", ["PS4"])).toMatchObject({ chosen: "Q5" });
    const both = one("Until Dawn", []);
    expect(both).toMatchObject({ status: "ambiguous", chosen: null });
    expect(both.candidates.map((c: any) => c.qid)).toEqual(["Q5", "Q6"]);
    // Neither Marathon is on a PlayStation: the badge keeps none, so both stay and nothing is chosen.
    expect(one("Marathon", ["PS5"])).toMatchObject({ status: "ambiguous", chosen: null });
  });

  it("never matches on shared words", () => {
    expect(one("Rise of the Argonauts II")).toMatchObject({ status: "not_found", chosen: null });
    expect(one("Wolverine Origins")).toMatchObject({ status: "not_found" });
    expect(one("")).toMatchObject({ status: "not_found" });
  });

  it("removes only the listed edition labels, and never the whole title", () => {
    expect(m.stripEdition("game ps4 and ps5")).toBe("game");
    expect(m.stripEdition("game standard edition ps5")).toBe("game");
    expect(m.stripEdition("game deluxe edition")).toBeNull();
    expect(m.stripEdition("ps5")).toBeNull();
    expect(m.stripPrefix("marvel s wolverine")).toBe("wolverine");
    expect(m.stripPrefix("marvelous wolverine")).toBeNull();
  });

  it("groups a game's PS4 and PS5 rows, and maps the PS Plus badge to Subscription Access", () => {
    const cat = [
      rec("Q21", "Game Two", 2020, [PS4, PS5]),
      rec("Q22", "Game Three", 2021, [PS5]),
      rec("Q23", "Game Four", 2022, [PS4, PS5]),
    ];
    const games = m.matchLibrary(m.buildIndex(cat), [
      { title: "Game Two", platforms: ["PS4"], ps_plus: true },
      { title: "Game Two", platforms: ["PS5"], ps_plus: true },
      { title: "Game Three", platforms: ["PS5"], ps_plus: false },
      { title: "Game Three", platforms: ["PS5"], ps_plus: true },
      { title: "Game Four (PS4 & PS5)", platforms: ["PS4", "PS5"] },
      { title: "Game Five", platforms: ["Xbox"] },
      { title: "Game Five PS5", platforms: ["PS5"] },
    ]);
    expect(
      games.map((g: any) => [g.title, g.chosen, g.status, g.platforms, g.access, g.rows]),
    ).toEqual([
      [
        "Game Two",
        "Q21",
        "confirmed",
        ["PS4", "PS5"],
        { PS4: "Subscription Access", PS5: "Subscription Access" },
        2,
      ],
      ["Game Three", "Q22", "confirmed", ["PS5"], { PS5: "Owned License" }, 2],
      [
        "Game Four (PS4 & PS5)",
        "Q23",
        "confirmed",
        ["PS4", "PS5"],
        { PS4: "Owned License", PS5: "Owned License" },
        1,
      ],
      // Not found: grouped by title without edition labels.
      ["Game Five", null, "not_found", ["PS5"], { PS5: "Owned License" }, 2],
    ]);
  });

  it("matches each row before grouping, so two exact matches are never merged into one", () => {
    // Codex pre-dispatch review of WU-021, finding 4: "Synthetic Quest PS5" is its own item.
    const cat = [
      rec("Q31", "Synthetic Quest", 2020, [PS4]),
      rec("Q32", "Synthetic Quest PS5", 2021, [PS5]),
    ];
    for (const order of [1, -1]) {
      const rows = [
        { title: "Synthetic Quest", platforms: ["PS4"] },
        { title: "Synthetic Quest PS5", platforms: ["PS5"] },
      ];
      if (order < 0) rows.reverse();
      const games = m.matchLibrary(m.buildIndex(cat), rows);
      expect(games.map((g: any) => [g.chosen, g.status, g.platforms]).sort()).toEqual([
        ["Q31", "confirmed", ["PS4"]],
        ["Q32", "confirmed", ["PS5"]],
      ]);
    }
    // One item reached by a confirmed row and a suggested row is only suggested.
    const mixed = m.matchLibrary(index(), [
      { title: "Wolverine", platforms: ["PS5"] },
      { title: "Marvel's Wolverine", platforms: ["PS5"] },
    ]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatchObject({
      chosen: "Q1",
      status: "suggested",
      methods: ["exact", "prefix"],
    });
  });

  it("refuses an --out inside the repository, including a name that only begins with two dots and a link into it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "repo-"));
    tmp.push(root);
    expect(m.isInside(path.join(root, "..private"), root)).toBe(true);
    expect(m.isInside(path.join(root, "sub", "out.json"), root)).toBe(true);
    expect(m.isInside(path.join(root, "..", "elsewhere"), root)).toBe(false);
    const outside = mkdtempSync(path.join(os.tmpdir(), "link-"));
    tmp.push(outside);
    symlinkSync(root, path.join(outside, "into-repo"), "junction");
    expect(m.isInside(path.join(outside, "into-repo", "new", "out.json"), root)).toBe(true);
    expect(() =>
      m.main(
        ["--data-dir", root, "--titles", "t.json", "--out", path.join(root, "..private", "o.json")],
        {
          root,
          log: () => {},
        },
      ),
    ).toThrow(/outside the repository/);
  });

  it("shows an error it did not write by its type only, and never an argument's value", () => {
    const fsError = Object.assign(
      new Error("EACCES: permission denied, open 'C:/in/Sky Harbor.png'"),
      { code: "EACCES" },
    );
    expect(m.privateCliMessage(fsError)).toBe(
      "stopped (Error EACCES); the details are not shown, because they may name a personal file",
    );
    expect(
      m.privateCliMessage(new SyntaxError('Unexpected token, "Sky Harbor" is not valid JSON')),
    ).not.toMatch(/Sky/);
    for (const argv of [
      ["C:\\in\\My Hidden Library Sky.png"],
      ["--Synthetic-Private-Title"],
      ["--data-dir"],
    ]) {
      let err: any;
      try {
        m.main(argv, { log: () => {} });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(m.MatchUsageError);
      expect(err.message).not.toMatch(/Hidden|Library|Sky|Synthetic|Private/);
    }
  });

  it("writes results only to --out and prints counts with no title", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "match-"));
    tmp.push(d);
    writeFileSync(
      path.join(d, "wikidata.jsonl"),
      catalogue.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    writeFileSync(
      path.join(d, "titles.json"),
      JSON.stringify([
        { title: "Hollow Knight", platforms: ["PS4"] },
        { title: "Marvel's Wolverine", platforms: ["PS5"] },
        { title: "Nothing Like It", platforms: ["PS5"] },
      ]),
    );
    const logs: string[] = [];
    const s = m.main(
      ["--data-dir", d, "--titles", path.join(d, "titles.json"), "--out", path.join(d, "out.json")],
      { log: (x: string) => logs.push(x), root: mkdtempSync(path.join(os.tmpdir(), "repo-")) },
    );
    expect(s.by_status).toEqual({ confirmed: 1, suggested: 1, not_found: 1 });
    expect(logs.join("\n")).not.toMatch(/Hollow|Wolverine|Nothing Like/);
    const out = JSON.parse(readFileSync(path.join(d, "out.json"), "utf8"));
    expect(out.map((r: any) => r.status)).toEqual(["confirmed", "suggested", "not_found"]);
    expect(() => m.main(["--data-dir", d], { log: () => {} })).toThrow(/usage/);
  });
});
