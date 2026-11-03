import path from "path";
import { describe, expect, it } from "vitest";
import { assertIsolatedRestoreTarget } from "../../src/utils/recoveryValidation";

describe("recovery restore target isolation", () => {
  it("accepts a database inside the recovery-drills directory", () => {
    const target = path.join("data", "recovery-drills", "r2-2026-09-04.db");
    expect(assertIsolatedRestoreTarget(target)).toBe(path.resolve(target));
  });
  it.each(["mgpl-staging.db", "mpgl_app.db", "test_mgpl.db"])(
    "rejects protected target %s",
    (name) => {
      expect(() => assertIsolatedRestoreTarget(path.join("data", "recovery-drills", name))).toThrow(
        "Refusing protected database target",
      );
    },
  );
  it("rejects paths outside the recovery-drills directory", () => {
    expect(() => assertIsolatedRestoreTarget(path.join("data", "candidate.db"))).toThrow(
      "Restore target must be inside a recovery-drills directory",
    );
  });
});
