// cspell:words nowiki wikitext
import { describe, expect, it } from "vitest";
// @ts-expect-error The catalogue runner is an ESM operator script.
import {
  checkSourceText,
  CHECK_SOURCE_PROFILE,
  doneCheckKeys,
} from "../../scripts/catalogue/enrich-gemini.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("literal Wikipedia regions", () => {
  it("does not treat literal braces inside a removed template as templates", () => {
    expect(checkSourceText("{{Box|note=<nowiki>{{</nowiki>}} Invented game prose.")).toBe(
      "Invented game prose.",
    );
  });

  it("preserves literal markup outside removed templates", () => {
    expect(
      checkSourceText(
        "Play <NoWiki>{{ [[literal]] <ref>x</ref> ''plain'' <!--literal--> &amp;</NOWIKI> today.",
      ),
    ).toBe("Play {{ [[literal]] <ref>x</ref> ''plain'' <!--literal--> & today.");
  });

  it("handles multiple regions and self-closing tags without inserting whitespace", () => {
    expect(checkSourceText("a<nowiki/>b <nowiki>}}</nowiki> <nowiki>{{</nowiki>")).toBe("ab }} {{");
  });

  it("does not process literal tags hidden inside comments", () => {
    expect(checkSourceText("<!-- <nowiki> --> Invented prose.")).toBe("Invented prose.");
  });

  it("does not allow input to impersonate the internal literal marker", () => {
    expect(checkSourceText("\uE000nowiki:0\uE001 <nowiki>{{</nowiki>")).toBe(
      "\uE000nowiki:0\uE001 {{",
    );
  });

  it.each([
    "Invented prose <nowiki>{{",
    "{{broken <nowiki>}}</nowiki> Invented prose",
    "{{broken}} {{still broken",
  ])("refuses unclosed markup: %s", (raw) => {
    expect(() => checkSourceText(raw)).toThrow();
  });

  it("retains whitespace normalization, entity decoding and the scalar limit", () => {
    expect(checkSourceText("<nowiki> a\n b &amp;lt; </nowiki>")).toBe("a b &lt;");
    expect(Array.from(checkSourceText("<nowiki>" + "😀".repeat(1501) + "</nowiki>"))).toHaveLength(
      1500,
    );
  });

  it("keeps the previous profile's completed identities distinct", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "mgpl-literal-test-"));
    try {
      const file = path.join(folder, "checks.jsonl");
      const record = {
        qid: "Q1",
        description_sha256: "a".repeat(64),
        source_url: "https://en.wikipedia.org/w/index.php?title=Invented&oldid=1",
        source_profile: "wikipedia-lead-prose-v2",
        model: "gemini-3.8-flash",
        prompt_version: "s3-check-v1",
        status: "ok",
      };
      writeFileSync(file, JSON.stringify(record) + "\n");
      const done = doneCheckKeys(file);
      expect(CHECK_SOURCE_PROFILE).toBe("wikipedia-lead-prose-v3");
      expect(
        done.has(
          JSON.stringify([
            record.qid,
            record.description_sha256,
            record.source_url,
            record.source_profile,
            record.model,
            record.prompt_version,
          ]),
        ),
      ).toBe(true);
      expect(
        done.has(
          JSON.stringify([
            record.qid,
            record.description_sha256,
            record.source_url,
            CHECK_SOURCE_PROFILE,
            record.model,
            record.prompt_version,
          ]),
        ),
      ).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
