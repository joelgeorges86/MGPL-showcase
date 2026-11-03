import { describe, expect, it } from "vitest";
import { safeCoerce, safeIngest, validateIngest } from "../../src/utils/ingest";

describe("ingest helpers", () => {
  it("coerces strings, numbers, integers, booleans, arrays, and objects safely", () => {
    expect(safeCoerce.str("hello", "fallback")).toBe("hello");
    expect(safeCoerce.str(123, "fallback")).toBe("fallback");
    expect(safeCoerce.num("42.5", 0)).toBe(42.5);
    expect(safeCoerce.num("", 7)).toBe(7);
    expect(safeCoerce.int(12, 0)).toBe(12);
    expect(safeCoerce.int("12.3", 9)).toBe(9);
    expect(safeCoerce.bool(true, false)).toBe(true);
    expect(safeCoerce.bool("true", false)).toBe(false);
    expect(safeCoerce.arr([1, 2, 3])).toEqual([1, 2, 3]);
    expect(safeCoerce.arr("oops")).toEqual([]);
    expect(safeCoerce.obj({ ok: true })).toEqual({ ok: true });
    expect(safeCoerce.obj([1, 2])).toEqual({});
    expect(safeCoerce.nullableStr("value")).toBe("value");
    expect(safeCoerce.nullableStr("")).toBeNull();
  });

  it("hydrates raw payloads without inventing missing keys", () => {
    expect(safeIngest({ a: 1 }, { a: 0, b: 2 })).toEqual({ a: 1 });
    expect(safeIngest(null, { a: 0 })).toEqual({ a: 0 });
  });

  it("returns structured validation results for good and bad payloads", () => {
    const valid = validateIngest({ score: 5 }, (body) => {
      const score = safeCoerce.num(body.score, -1);
      return score >= 0 ? { score } : null;
    });
    const invalid = validateIngest(null, () => null);

    expect(valid).toEqual({ ok: true, value: { score: 5 }, error: null });
    expect(invalid).toEqual({
      ok: false,
      value: null,
      error: "Malformed ingestion payload rejected.",
    });
  });
});
