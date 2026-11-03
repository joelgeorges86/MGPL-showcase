import { describe, it, expect } from "vitest";
import {
  validateObservation,
  assessField,
  subjectKey,
  FIELD_REGISTRY,
  MOBILE_OWNED_FIELDS,
  DERIVATION_RULES,
  FIELD_CLASSES,
  MAINTAINED_OS_PRODUCTS,
  INITIAL_REGIONS,
} from "../../src/lib/evidenceContract";
import type {
  EvidenceObservation,
  SubjectRef,
  InputUnknownReason,
} from "../../src/lib/evidenceContract";
import { SOURCE_REGISTER } from "../../src/lib/sourceAccess";
import { MOBILE_OBSERVATION_FIELDS } from "../../src/services/mobileCatalogueImport";
import {
  obs,
  FIXTURE_NOW,
  CONTRACT_EXAMPLES,
  fixtureBuild,
  fixturePair,
  listing,
  TEST_REGISTER,
} from "../helpers/evidenceFixtures";
const ctx = { now: FIXTURE_NOW };
function validated(input = obs(), register?: typeof TEST_REGISTER) {
  const result = validateObservation(input, { ...ctx, register });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw Error(JSON.stringify(result));
  return result;
}
function reject(input: unknown, reasons: string[], extra: Record<string, unknown> = {}) {
  expect(validateObservation(input, { ...ctx, ...extra })).toEqual({
    ok: false,
    reasons: [...reasons].sort(),
  });
}
function assess(
  inputs: EvidenceObservation[],
  country = "US",
  now = FIXTURE_NOW,
  register?: typeof TEST_REGISTER,
) {
  return assessField(
    {
      subject: inputs[0]?.subject ?? fixtureBuild,
      field: inputs[0]?.field ?? "requires_ram_gb",
      country,
    },
    inputs.map((input) => validated(input)),
    { now, register },
  );
}
const page = (suffix: string) => ({
  source_id: "publisher-pages",
  url: "https://publisher.example/fixture-quest/" + suffix,
  source_version: null,
});
const unknown = (reason: InputUnknownReason, date = "2026-10-21") =>
  obs({
    value_state: "unknown",
    value: null,
    basis: null,
    unknown_reason: reason,
    list_exhaustive: reason === "not_listed" ? false : null,
    observed_at: date,
  });
let seed = 941;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
function shuffled<T>(rows: T[]) {
  return [...rows].sort(() => random() - 0.5);
}
describe("evidence contract validation", () => {
  it("pins scope, mobile ownership and compatible overlapping registry fields", () => {
    expect(INITIAL_REGIONS).toEqual(["US"]);
    expect(MAINTAINED_OS_PRODUCTS).toEqual([
      "windows",
      "macos",
      "ios",
      "ipados",
      "android",
      "steamos",
    ]);
    expect(DERIVATION_RULES).toEqual({});
    expect([...MOBILE_OWNED_FIELDS].sort()).toEqual(Object.keys(MOBILE_OBSERVATION_FIELDS).sort());
    for (const field of MOBILE_OWNED_FIELDS)
      if (field in FIELD_REGISTRY) {
        expect(FIELD_REGISTRY[field as keyof typeof FIELD_REGISTRY].unit).toBe(
          MOBILE_OBSERVATION_FIELDS[field].unit,
        );
        expect(FIELD_REGISTRY[field as keyof typeof FIELD_REGISTRY].value).toBe(
          MOBILE_OBSERVATION_FIELDS[field].value,
        );
      }
    for (const field of Object.keys(FIELD_REGISTRY))
      expect(field).not.toMatch(/(^|_)(fps|benchmark|price|msrp|cost|tier)(_|$)/);
    expect(FIELD_CLASSES.measurement.ttlDays).toBeNull();
  });
  for (const example of CONTRACT_EXAMPLES)
    it(example.id + " synthetic contract example", () => {
      if (!example.valid) reject(example.input, example.reasons!, { register: example.register });
      const result = validated(example.input);
      if (example.input.subject.kind !== "store_listing")
        expect(JSON.stringify(example.input.subject)).toContain("fixture");
      expect(new URL(example.input.source.url).hostname).toMatch(/\.example$/);
      if (example.input.subject.kind === "store_listing")
        expect(example.input.subject.store_app_id).toMatch(/^9999999990[0-9]{2}$/);
      expect(
        assessField(
          { subject: example.input.subject, field: example.input.field, country: "US" },
          example.observations?.map((input) => validated(input)) ?? [result],
          { ...ctx, register: example.register },
        ).status,
      ).toBe(example.assessment);
    });
  it("R1/R2 rejects nonobjects, missing and unexpected properties", () => {
    reject(null, ["not_an_object"]);
    reject([], ["not_an_object"]);
    reject({ ...obs(), contract: "bad" }, ["contract_mismatch"]);
    const { observed_at: _, ...without } = obs();
    reject(without, ["missing_property", "invalid_date", "review_date_invalid"]);
    reject({ ...obs(), extra: true }, ["unexpected_property"]);
    reject(obs({ source: { ...page("specs"), extra: true } as any }), ["unexpected_property"]);
    reject(obs({ source: { source_id: "publisher-pages", url: page("specs").url } as any }), [
      "missing_property",
      "source_version_invalid",
    ]);
  });
  it("CX-1/CX-4/CX-7/CX-12 exact identities do not merge", () => {
    const first = CONTRACT_EXAMPLES.find((e) => e.id === "EX-EDITIONS-standard")!.input;
    const second = {
      ...first,
      subject: {
        kind: "game_edition",
        edition_key: "mgpl:fixture-quest/remastered-2026",
      } as SubjectRef,
    };
    expect(validated(first).key).not.toBe(validated(second).key);
    expect(
      assessField(
        { subject: first.subject, field: first.field, country: "US" },
        [validated(second)],
        ctx,
      ),
    ).toEqual({ status: "unknown", reason: "no_observation", supporting: [] });
    reject({ ...first, subject: { kind: "game_edition", edition_key: "mgpl:fixture-quest" } }, [
      "invalid_key",
    ]);
    expect(subjectKey({ ...fixtureBuild, version: "1.10" } as SubjectRef)).not.toBe(
      subjectKey({ ...fixtureBuild, version: "1.1" } as SubjectRef),
    );
    const iphone = CONTRACT_EXAMPLES.find((e) => e.id === "EX-IPHONE")!.input;
    expect(
      assessField(
        { subject: { ...listing, country: "CA" }, field: iphone.field, country: "CA" },
        [validated(iphone)],
        ctx,
      ),
    ).toEqual({ status: "unknown", reason: "no_observation", supporting: [] });
    const ipad = CONTRACT_EXAMPLES.find((e) => e.id === "EX-IPAD")!.input;
    const cellular = {
      ...ipad.subject,
      device: {
        kind: "mobile_reference",
        reference_key: "apple:ipad-fixture:fixture-wifi-cellular",
      },
    } as SubjectRef;
    expect(
      assessField({ subject: cellular, field: ipad.field, country: "US" }, [validated(ipad)], ctx)
        .status,
    ).toBe("unknown");
    reject(
      {
        ...ipad,
        subject: {
          ...ipad.subject,
          device: { kind: "mobile_family", family_key: "apple:ipad-fixture" },
        },
      },
      ["invalid_subject"],
    );
  });
  it("validates every subject grammar, preserving exact strings", () => {
    const subjects: SubjectRef[] = [
      { kind: "mobile_family", family_key: "fixture:phone" },
      { kind: "mobile_reference", reference_key: "fixture:phone:us" },
      { kind: "mobile_variant", variant_key: "fixture:phone:us#ram=4#st=x#sku=x" },
      {
        kind: "hardware_port",
        hardware_class: "display",
        reference_key: "fixture:display:us",
        port_id: "port-1",
      },
      { kind: "game_work", work_key: "wd:Q42" },
      { kind: "os_release", os_product: "ios", release: "18.1" },
      {
        kind: "store_listing",
        store: "google_play",
        store_app_id: "com.example.fixture.quest",
        country: "US",
      },
      { kind: "store_listing", store: "steam", store_app_id: "9999999990", country: "US" },
      {
        kind: "store_listing",
        store: "playstation_store",
        store_app_id: "Fixture_Quest",
        country: "US",
      },
    ];
    for (const subject of subjects) {
      const result = validateObservation(obs({ subject }), ctx);
      expect(result.ok ? [] : result.reasons).not.toContain("invalid_subject");
      expect(result.ok ? [] : result.reasons).not.toContain("invalid_key");
    }
    const invalid: unknown[] = [
      null,
      { kind: "bad" },
      { kind: "game_build", edition_key: "mgpl:fixture-quest/pc", platform: "bad", version: " 1" },
      { kind: "mobile_family", family_key: "Fixture:phone" },
      { kind: "mobile_reference", reference_key: "fixture:phone" },
      { kind: "mobile_variant", variant_key: "fixture:phone:us#ram=x#st=x#sku=x" },
      { kind: "mobile_variant", variant_key: "fixture:phone:us#ram=65#st=8193#sku=x" },
      { kind: "os_release", os_product: "bad", release: " 18" },
      { kind: "store_listing", store: "bad", store_app_id: "?", country: "usa" },
      {
        kind: "hardware_port",
        hardware_class: "bad",
        reference_key: "fixture:port:us",
        port_id: "?",
      },
      { kind: "game_work", work_key: "wd:Q0" },
    ];
    for (const subject of invalid) {
      const result = validateObservation({ ...obs(), subject }, ctx);
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.reasons).toEqual(
        expect.arrayContaining([expect.stringMatching(/^invalid_(subject|key)$/)]),
      );
    }
    reject(
      obs({
        subject: {
          kind: "hardware_reference",
          hardware_class: "phone",
          reference_key: "fixture:phone:us",
        } as any,
        field: "ram_gb",
        source: { ...page("specs"), source_id: "manufacturer-pages" },
      }),
      ["use_mobile_subject"],
    );
  });
  it("CX-2/CX-3/CX-5 source permission and absent values stay distinct", () => {
    const iphone = CONTRACT_EXAMPLES.find((e) => e.id === "EX-IPHONE")!.input;
    reject(
      {
        ...iphone,
        collection: "bounded_get",
        reviewed_on: null,
        source: { ...iphone.source, source_id: "apple-search" },
      },
      ["collection_not_permitted"],
    );
    expect(assess([iphone]).status).toBe("current");
    const absent = {
      ...iphone,
      field: "listing_available",
      value_state: "unknown",
      value: null,
      basis: null,
      unknown_reason: "not_listed",
      list_exhaustive: false,
      collection: "bounded_get",
      reviewed_on: null,
      source: { ...iphone.source, source_id: "apple-search" },
    } as EvidenceObservation;
    const r = validated(absent, TEST_REGISTER);
    expect(
      assessField({ subject: absent.subject, field: absent.field, country: "US" }, [r], {
        ...ctx,
        register: TEST_REGISTER,
      }),
    ).toEqual({ status: "unknown", reason: "not_listed", supporting: [r.key] });
    const os = obs({
      subject: { kind: "os_release", os_product: "ios", release: "18" },
      field: "os_lifecycle_status",
      value: "supported",
      unit: null,
      source: { ...page("specs"), source_id: "windows" },
    });
    reject(os, ["field_not_permitted_for_source"]);
    const oldRegister = {
      ...TEST_REGISTER,
      entries: SOURCE_REGISTER.map((s) =>
        s.id === "windows"
          ? {
              ...s,
              fields: {
                os_lifecycle_status: {
                  store: "normalized_fact",
                  publish_if_origin_verified: "withheld",
                  publish_decision: "U-3",
                },
              },
            }
          : s,
      ),
    } as typeof TEST_REGISTER;
    const old = validated(os, oldRegister);
    expect(
      assessField({ subject: os.subject, field: os.field, country: "US" }, [old], ctx),
    ).toEqual({ status: "unknown", reason: "no_permitted_source", supporting: [old.key] });
    reject(obs({ source: { ...page("specs"), source_id: "missing" } }), ["source_not_registered"]);
  });
  it("CX-6/CX-11/CX-14 state, exhaustive, ownership and forbidden values", () => {
    reject(
      obs({
        subject: fixturePair,
        field: "publisher_lists_device",
        value: false,
        unit: null,
        list_exhaustive: false,
      }),
      ["negative_requires_exhaustive_list"],
    );
    reject({ ...unknown("not_listed"), list_exhaustive: true }, ["list_exhaustive_invalid"]);
    reject({ ...obs(), basis: "estimated" }, ["basis_not_in_contract"]);
    reject(obs({ basis: "derived" }), ["basis_not_allowed_for_field", "derivation_rule_unknown"]);
    reject(obs({ basis: "measured" }), ["basis_not_allowed_for_field"]);
    for (const field of ["measured_fps", "gpu_tier", "price_usd", "virtual_ram_gb", "tdp_watts"])
      reject({ ...obs(), field }, ["field_forbidden", "field_not_permitted_for_source"]);
    reject(
      obs({
        subject: { kind: "mobile_reference", reference_key: "fixture:phone:us" },
        field: "ram_gb",
        source: { ...page("specs"), source_id: "manufacturer-pages" },
      }),
      ["field_owned_by_mobile_staging", "subject_kind_not_allowed_for_field"],
    );
    reject({ ...obs(), field: "missing" }, [
      "field_not_in_contract",
      "field_not_permitted_for_source",
    ]);
    reject(obs({ unit: "GiB" }), ["unit_mismatch"]);
    reject(obs({ value: null }), ["value_state_invalid", "value_type_mismatch"]);
    reject({ ...unknown("not_published"), unknown_reason: "bad" }, ["unknown_reason_invalid"]);
    reject({ ...obs(), value_state: "bad" }, ["value_state_invalid"]);
  });
  it("R6/CX-15 rejects invalid type/range/list/text and source metadata", () => {
    for (const value of ["4", NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      reject({ ...obs(), value }, ["value_type_mismatch"]);
    for (const value of [0, 65]) reject(obs({ value }), ["value_out_of_range"]);
    for (const value of ["\ud800", "a\u0000b", "e\u0301", " Fixture ", "\udfff", "a\u0080b"]) {
      const r = validateObservation(
        obs({
          subject: { kind: "game_edition", edition_key: "mgpl:fixture-quest/standard" },
          field: "edition_title",
          value,
          unit: null,
        }),
        ctx,
      );
      expect(r).toEqual({ ok: false, reasons: ["text_invalid"] });
    }
    const list = obs({
      field: "supported_cpu_abis",
      value: ["arm64-v8a"],
      unit: null,
      list_exhaustive: true,
    });
    reject({ ...list, value: [] }, ["empty_list_use_unknown"]);
    reject({ ...list, value: ["x86", "x86"] }, ["duplicate_list_item"]);
    reject({ ...list, value: ["bad"] }, ["value_not_in_vocabulary"]);
    reject({ ...list, value: [1] }, ["value_type_mismatch"]);
    reject({ ...list, value: "x86" }, ["value_type_mismatch"]);
    reject(obs({ subject: fixturePair, field: "native_edition_support", value: 1, unit: null }), [
      "value_type_mismatch",
    ]);
    reject(obs({ source: { ...page("specs"), source_version: "" } }), ["source_version_invalid"]);
    for (const url of [
      "bad",
      "http://publisher.example/fixture",
      "https://x:y@publisher.example/fixture",
      "https://publisher.example:8443/fixture",
      "https://publisher.example/fixture#x",
      "https://[::1]/",
      "https://127.0.0.1/",
      "https://publisher.example/" + "a".repeat(500),
    ])
      reject(obs({ source: { ...page("specs"), url } }), ["invalid_url"]);
    const i = CONTRACT_EXAMPLES.find((e) => e.id === "EX-IPHONE")!.input;
    reject({ ...i, country: "CA" }, ["country_scope_mismatch"]);
    reject({ ...obs(), country: "us" }, ["invalid_country"]);
    reject(
      {
        ...i,
        field: "listing_bundle_id",
        subject: { ...listing, store: "google_play", store_app_id: "com.example.fixture.quest" },
        value: "fixture.quest",
      },
      ["field_not_permitted_for_source", "store_not_allowed_for_field"],
    );
    reject({ ...i, field: "listing_store_url", value: "http://store.example/fixture" }, [
      "invalid_url",
    ]);
    reject({ ...i, field: "listing_version", value: "bad version" }, ["value_out_of_range"]);
  });
  it("CX-13 R14/R15 use exact calendar dates and review windows", () => {
    reject(obs({ observed_at: "2026-02-30" }), ["invalid_date", "review_date_invalid"]);
    reject(obs({ observed_at: "2026-10-23" }), ["observed_in_future", "review_date_invalid"]);
    reject(obs({ observed_at: "2026-10-22T12:00:01Z" }), ["observed_in_future"]);
    reject(obs({ source_updated_at: "2026-10-22" }), ["source_updated_after_observed"]);
    reject(obs({ source_updated_at: "bad" }), ["invalid_date"]);
    for (const reviewed_on of [null, "2026-02-30", "2026-10-20", "2026-10-23"])
      reject(obs({ reviewed_on }), ["review_date_invalid"]);
    reject({ ...obs(), collection: "bad" }, ["collection_not_permitted", "review_date_invalid"]);
    expect(validateObservation(obs({ observed_at: "2026-10-22" }), ctx).ok).toBe(true);
  });
  it("CX-16 normalizes list order and observation keys omit review metadata", () => {
    const base = obs({
      field: "supported_cpu_abis",
      value: ["x86", "arm64-v8a"],
      unit: null,
      list_exhaustive: true,
    });
    const first = validated(base);
    expect(first.observation.value).toEqual(["arm64-v8a", "x86"]);
    expect(validated({ ...base, value: ["arm64-v8a", "x86"], reviewed_on: "2026-10-21" }).key).toBe(
      first.key,
    );
    expect(validated({ ...base, source: page("different") }).key).not.toBe(first.key);
    const reversed = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as EvidenceObservation;
    expect(validated(reversed).key).toBe(first.key);
  });
});
describe("deterministic field assessment", () => {
  it("rejects invalid queries", () => {
    for (const query of [
      { subject: fixtureBuild, field: "bad", country: "US" },
      { subject: { kind: "bad" }, field: "ram_gb", country: "US" },
      { subject: fixtureBuild, field: "requires_ram_gb", country: "GLOBAL" },
      { subject: fixtureBuild, field: "ram_gb", country: "US" },
    ])
      expect(() => assessField(query as any, [], ctx)).toThrow("invalid_query");
  });
  it("CX-8/CX-9 preserves conflicts and stale history with exact ordered groups", () => {
    const rows = [
      obs({ value: 6, source: page("launch"), observed_at: "2026-10-18" }),
      obs({ value: 4, observed_at: "2026-10-15" }),
    ];
    const keys = rows.map((r) => validated(r));
    expect(assess(rows)).toEqual({
      status: "conflicting",
      values: [
        { value: 4, keys: [keys[1].key], as_of: "2026-10-15T00:00:00Z" },
        { value: 6, keys: [keys[0].key], as_of: "2026-10-18T00:00:00Z" },
      ],
      unit: "GB",
      publish: "withheld",
      supporting: keys.map((r) => r.key).sort(),
    });
    for (let i = 0; i < 50; i++) expect(assess(shuffled(rows))).toEqual(assess(rows));
    const stale = assess(rows, "US", new Date("2026-12-01T00:00:00Z"));
    expect(stale).toMatchObject({
      status: "stale",
      as_of: "2026-10-18T00:00:00Z",
      values: [{ value: 6 }, { value: 4 }],
    });
    expect(
      assess(
        rows.map((r) => ({ ...r, observed_at: "2026-10-15" })),
        "US",
        new Date("2026-12-01T00:00:00Z"),
      ),
    ).toMatchObject({ status: "stale", values: [{ value: 4 }, { value: 6 }] });
  });
  it("CX-10 withdrawal applies to new and stored evidence", () => {
    const r = validated();
    const register = {
      ...TEST_REGISTER,
      entries: SOURCE_REGISTER.map((s) =>
        s.id === "publisher-pages" ? { ...s, withdrawn_at: "2026-10-20" } : s,
      ),
    };
    reject(obs(), ["collection_not_permitted"], { register });
    expect(
      assessField({ subject: fixtureBuild, field: "requires_ram_gb", country: "US" }, [r], {
        ...ctx,
        register,
      }),
    ).toEqual({ status: "withdrawn", supporting: [r.key] });
    const route = {
      ...register,
      entries: SOURCE_REGISTER.map((s) =>
        s.id === "publisher-pages"
          ? { ...s, routes: { ...s.routes, manual_read: "withdrawn" as const } }
          : s,
      ),
    };
    expect(
      assessField({ subject: fixtureBuild, field: "requires_ram_gb", country: "US" }, [r], {
        ...ctx,
        register: route,
      }).status,
    ).toBe("withdrawn");
  });
  it("CX-22/CX-28 same-page aliases cannot raise publication", () => {
    const first = obs({
      subject: { kind: "game_edition", edition_key: "mgpl:fixture-quest/standard" },
      field: "edition_title",
      value: "Fixture Quest",
      unit: null,
      source: page("title"),
    });
    const second = { ...first, source: { ...first.source, source_id: "wikidata" } };
    expect(validated(first)).toMatchObject({
      classification: "attested_only",
      effective_publish: "withheld",
    });
    expect(validated(second)).toMatchObject({
      classification: "attested_only",
      effective_publish: "withheld",
    });
    expect(assess([first, second])).toMatchObject({
      status: "current",
      value: "Fixture Quest",
      publish: "withheld",
    });
    expect(assess([first, { ...second, value: "Fixture Quest Remastered" }]).status).toBe(
      "conflicting",
    );
    const register = {
      ...TEST_REGISTER,
      originRules: [
        { source_id: "wikidata", hosts: ["wikidata.fixture.test"], path: /^\/wiki\/Q[1-9][0-9]*$/ },
      ],
    };
    reject(second, ["source_origin_mismatch"], { register });
    const verified = {
      ...second,
      source: { ...second.source, url: "https://wikidata.fixture.test/wiki/Q42" },
    };
    const a = validated(verified, register),
      b = validated(
        { ...verified, source: { ...verified.source, source_id: "publisher-pages" } },
        register,
      );
    expect(a).toMatchObject({
      classification: "origin_verified",
      effective_publish: "fact_with_attribution",
    });
    expect(
      assessField({ subject: first.subject, field: first.field, country: "US" }, [a, b], {
        ...ctx,
        register,
      }),
    ).toMatchObject({ status: "current", publish: "withheld" });
  });
  it("CX-23/EX-RETAINED failed rereads retain original freshness", () => {
    const rows = [
      obs({ observed_at: "2026-10-15" }),
      unknown("source_unavailable", "2026-10-20"),
      obs({ value: 6, source: page("launch"), observed_at: "2026-10-18" }),
    ];
    expect(assess(rows)).toMatchObject({
      status: "conflicting",
      values: [{ value: 4 }, { value: 6 }],
    });
    expect(assess([rows[0], unknown("not_published", "2026-10-20"), rows[2]])).toMatchObject({
      status: "current",
      value: 6,
    });
    expect(assess(rows, "US", new Date("2026-11-15T12:00:00Z"))).toMatchObject({
      status: "current",
      value: 6,
      supporting: rows.map((r) => validated(r).key).sort(),
    });
  });
  it("CX-24/EX-GLOBAL-CONTRA and CX-25/EX-DISJOINT", () => {
    const global = obs({
      field: "requires_os_min_release",
      value: "10",
      unit: null,
      country: "GLOBAL",
    });
    const za = { ...global, value: "11", country: "ZA", source: page("za") };
    for (const country of ["US", "ZA"])
      expect(assess([global, za], country)).toMatchObject({
        status: "conflicting",
        values: [{ value: "10" }, { value: "11" }],
      });
    expect(assess([global], "US")).toMatchObject({ status: "current", value: "10" });
    expect(
      assess([global, za, { ...global, country: "US", source: page("us") }], "US"),
    ).toMatchObject({ status: "current", value: "10" });
    const disjoint = [obs(), obs({ value: 6, country: "ID", source: page("id") })];
    expect(assess(disjoint, "US")).toMatchObject({ status: "current", value: 4 });
    expect(assess(disjoint, "ID")).toMatchObject({ status: "current", value: 6 });
    expect(assess(disjoint, "CA")).toEqual({
      status: "unknown",
      reason: "no_observation",
      supporting: [],
    });
    expect(assess([obs({ country: "UNSPECIFIED" })])).toEqual({
      status: "unknown",
      reason: "no_observation",
      supporting: [],
    });
  });
  it("CX-26/EX-SCOPE sibling editions never lend support", () => {
    const enterprise = obs({
      subject: {
        ...fixturePair,
        game: { kind: "game_edition", edition_key: "mgpl:fixture-quest/enterprise" },
      } as SubjectRef,
      field: "native_edition_support",
      value: true,
      unit: null,
    });
    const standard = {
      ...unknown("subject_ambiguous"),
      subject: fixturePair,
      field: "native_edition_support",
      unit: null,
    } as EvidenceObservation;
    expect(assess([enterprise])).toMatchObject({ status: "current", value: true });
    expect(
      assessField(
        { subject: standard.subject, field: standard.field, country: "US" },
        [validated(enterprise), validated(standard)],
        ctx,
      ),
    ).toMatchObject({ status: "unknown", reason: "subject_ambiguous" });
  });
  it("CX-29/EX-ASOF latest contributors, full timestamps and 50 shuffles", () => {
    const rows = [
      obs({ observed_at: "2026-10-20", source: page("one") }),
      obs({ observed_at: "2026-10-21", source: page("two") }),
      obs({ observed_at: "2026-10-21T08:15:00Z", source: page("three") }),
    ];
    const expected = {
      status: "current",
      value: 4,
      unit: "GB",
      bases: ["documented"],
      as_of: "2026-10-21T08:15:00Z",
      contributors: rows.map((r) => validated(r).key).sort(),
      publish: "withheld",
      supporting: rows.map((r) => validated(r).key).sort(),
    };
    expect(assess(rows)).toEqual(expected);
    for (let i = 0; i < 50; i++) expect(assess(shuffled([...rows, rows[0]]))).toEqual(expected);
  });
  it("CX-30/EX-SOLE named latest sets handle every sole-source transition", () => {
    const first = obs({ observed_at: "2026-10-15" });
    for (const reason of [
      "not_published",
      "not_listed",
      "subject_ambiguous",
      "source_unavailable",
    ] as const) {
      const later = unknown(reason);
      const rows = [first, later];
      const supporting = rows.map((r) => validated(r).key).sort();
      const expected =
        reason === "source_unavailable"
          ? {
              status: "current",
              value: 4,
              unit: "GB",
              bases: ["documented"],
              as_of: "2026-10-15T00:00:00Z",
              contributors: [validated(first).key],
              publish: "withheld",
              supporting,
            }
          : { status: "unknown", reason, supporting };
      expect(assess(rows)).toEqual(expected);
      for (let i = 0; i < 50; i++) expect(assess(shuffled(rows))).toEqual(expected);
      if (reason === "source_unavailable")
        expect(assess(rows, "US", new Date("2026-11-20T00:00:00Z"))).toEqual({
          status: "stale",
          values: [{ value: 4, keys: [validated(first).key], as_of: "2026-10-15T00:00:00Z" }],
          unit: "GB",
          as_of: "2026-10-15T00:00:00Z",
          publish: "withheld",
          supporting,
        });
    }
    expect(assess([unknown("source_unavailable")])).toMatchObject({
      status: "unknown",
      reason: "source_unavailable",
    });
    expect(
      assess([
        first,
        unknown("not_published"),
        obs({ value: 6, source: page("other"), observed_at: "2026-09-01" }),
      ]),
    ).toMatchObject({ status: "stale", values: [{ value: 6 }] });
    expect(
      assess([first, unknown("not_published", "2026-10-20"), obs({ value: 6 })]),
    ).toMatchObject({ status: "current", value: 6 });
    expect(assess([first, unknown("not_published", "2026-10-15")])).toMatchObject({
      status: "current",
      value: 4,
    });
    const unknowns = [
      unknown("not_published"),
      { ...unknown("not_listed"), source: page("two") },
      { ...unknown("source_unavailable"), source: page("three") },
      { ...unknown("subject_ambiguous"), source: page("four") },
    ];
    expect(assess(unknowns)).toMatchObject({ status: "unknown", reason: "subject_ambiguous" });
  });
  it("CX-30 seeded 1000-set property: well-formed results and no superseded contributors", () => {
    for (let i = 0; i < 1000; i++) {
      const rows: Array<EvidenceObservation> = [];
      for (let j = 0; j < 1 + Math.floor(random() * 8); j++) {
        const reason = ["not_published", "not_listed", "subject_ambiguous", "source_unavailable"][
          Math.floor(random() * 4)
        ] as InputUnknownReason;
        rows.push({
          ...(random() < 0.5 ? obs({ value: random() < 0.5 ? 4 : 6 }) : unknown(reason)),
          source: page("page-" + Math.floor(random() * 3)),
          observed_at: "2026-10-" + (10 + Math.floor(random() * 12)),
        });
      }
      const result = assess(rows);
      expect(assess(shuffled(rows))).toEqual(result);
      if (result.status === "stale" || result.status === "conflicting")
        expect(result.values.length).toBeGreaterThanOrEqual(
          result.status === "conflicting" ? 2 : 1,
        );
      expect("as_of" in result).toBe(["current", "stale"].includes(result.status));
      const contributors =
        result.status === "current"
          ? result.contributors
          : "values" in result
            ? result.values.flatMap((g) => g.keys)
            : [];
      for (const key of contributors) {
        const r = rows.find((row) => validated(row).key === key)!;
        expect(
          rows.some(
            (other) =>
              other.source.url === r.source.url &&
              other.observed_at > r.observed_at &&
              !(other.value_state === "unknown" && other.unknown_reason === "source_unavailable"),
          ),
        ).toBe(false);
      }
    }
  });
});
