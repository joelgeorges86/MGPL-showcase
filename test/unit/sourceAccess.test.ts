import { describe, it, expect } from "vitest";
import { FIELD_REGISTRY } from "../../src/lib/evidenceContract";
import {
  SOURCE_REGISTER,
  ORIGIN_RULES,
  PENDING_DECISIONS,
  SOURCE_REGISTER_VERSION,
  sourceEntry,
  fieldAccess,
  routePermitted,
  classifyCitation,
  effectivePublish,
} from "../../src/lib/sourceAccess";
import { FIXTURE_NOW, TEST_REGISTER } from "../helpers/evidenceFixtures";
describe("source access", () => {
  it("pins v1 deny-by-default tripwires and every field grant", () => {
    expect(SOURCE_REGISTER_VERSION).toBe(1);
    expect(ORIGIN_RULES).toEqual([]);
    expect(SOURCE_REGISTER.filter((s) => s.routes.bounded_get === "approved")).toEqual([]);
    expect(new Set(SOURCE_REGISTER.map((s) => s.id)).size).toBe(SOURCE_REGISTER.length);
    for (const s of SOURCE_REGISTER) {
      expect(JSON.stringify(s)).not.toMatch(/https?:|hosts/);
      for (const d of s.decisions) expect(PENDING_DECISIONS[d]).toBeTypeOf("string");
      for (const [field, access] of Object.entries(s.fields)) {
        expect(FIELD_REGISTRY).toHaveProperty(field);
        expect(access.store).toBe("normalized_fact");
        if (access.publish_decision !== "decided")
          expect(access.publish_if_origin_verified).toBe("withheld");
        expect(effectivePublish(s.id, field, "https://publisher.example/fixture-quest")).toBe(
          "withheld",
        );
      }
      if (s.kind === "web_page" || s.id === "apple-search")
        expect(s.attribution).toBe("link to the cited page per fact; no text, image or asset");
    }
    expect(sourceEntry("apple-search")).toMatchObject({
      retention: "purge_values_on_withdrawal",
      rate: { max_in_flight: 1, min_interval_ms: 3000 },
    });
    expect(sourceEntry("wikidata")).toMatchObject({
      rate: { max_in_flight: 1, min_interval_ms: 1000 },
      attribution: "link to the item revision per fact",
    });
    expect(fieldAccess("manufacturer-pages", "ram_gb")).toBeDefined();
    expect(fieldAccess("windows", "os_lifecycle_status")).toBeUndefined();
    expect(sourceEntry("missing")).toBeUndefined();
    expect(fieldAccess("missing", "edition_title")).toBeUndefined();
    expect(fieldAccess("publisher-pages", "toString")).toBeUndefined();
  });
  it("checks routes and withdrawal at the requested instant", () => {
    expect(routePermitted("missing", "manual_read", FIXTURE_NOW)).toBe(false);
    expect(routePermitted("apple-search", "bounded_get", FIXTURE_NOW)).toBe(false);
    expect(routePermitted("apple-search", "bounded_get", FIXTURE_NOW, TEST_REGISTER)).toBe(true);
    const register = {
      ...TEST_REGISTER,
      entries: TEST_REGISTER.entries.map((s) =>
        s.id === "publisher-pages" ? { ...s, withdrawn_at: FIXTURE_NOW.toISOString() } : s,
      ),
    };
    expect(
      routePermitted(
        "publisher-pages",
        "manual_read",
        new Date(FIXTURE_NOW.getTime() - 1),
        register,
      ),
    ).toBe(true);
    expect(routePermitted("publisher-pages", "manual_read", FIXTURE_NOW, register)).toBe(false);
  });
  it("CX-28 binds publication to origin, exact host and path, without stateful regex", () => {
    const register = {
      ...TEST_REGISTER,
      originRules: [
        {
          source_id: "wikidata",
          hosts: ["wikidata.fixture.test"],
          path: /^\/wiki\/Q[1-9][0-9]*$/g,
        },
      ],
    };
    expect(
      classifyCitation("publisher-pages", "https://publisher.example/fixture-quest", register),
    ).toBe("attested_only");
    for (let i = 0; i < 2; i++)
      expect(classifyCitation("wikidata", "https://wikidata.fixture.test/wiki/Q42", register)).toBe(
        "origin_verified",
      );
    for (const url of [
      "bad",
      "https://publisher.example/fixture-quest",
      "https://wikidata.fixture.test.evil.test/wiki/Q42",
      "https://wikidata.fixture.test/no/Q42",
    ])
      expect(classifyCitation("wikidata", url, register)).toBe("origin_mismatch");
    expect(
      effectivePublish(
        "wikidata",
        "edition_title",
        "https://wikidata.fixture.test/wiki/Q42",
        register,
      ),
    ).toBe("fact_with_attribution");
    expect(
      effectivePublish("wikidata", "ram_gb", "https://wikidata.fixture.test/wiki/Q42", register),
    ).toBe("withheld");
    expect(
      effectivePublish(
        "wikidata",
        "edition_title",
        "https://publisher.example/fixture-quest",
        register,
      ),
    ).toBe("withheld");
  });
});
