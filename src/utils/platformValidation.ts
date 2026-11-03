import type { Database } from "better-sqlite3";
import { CANONICAL_PLATFORMS, normalizePlatform } from "../lib/platformTaxonomy";

export interface PlatformValidationResult {
  ok: boolean;
  canonical: string | null;
  input: string;
  error?: string;
}

/**
 * PI-GTM-2026-001 (EPIC-04): ingest schema validation against the canonical
 * platform taxonomy. Rejects any platform string that cannot be resolved to a
 * canonical label so the catalog never accepts unclassified or malformed
 * platform values. Returns a structured result; callers either reject the
 * catalog row (WUD requirement) or record the mismatch via
 * `logPlatformMismatch`.
 */
export function validatePlatform(raw: unknown): PlatformValidationResult {
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      canonical: null,
      input: "",
      error: "Platform is required; cannot be null or undefined.",
    };
  }
  const input = String(raw).trim();
  if (!input) {
    return {
      ok: false,
      canonical: null,
      input: String(raw),
      error: "Platform is required; cannot be empty.",
    };
  }
  const canonical = normalizePlatform(input);
  if (!canonical) {
    return {
      ok: false,
      canonical: null,
      input,
      error: `Unclassified platform '${input}' does not match canonical taxonomy [${CANONICAL_PLATFORMS.join(", ")}].`,
    };
  }
  return { ok: true, canonical, input };
}

/**
 * Structured rejection / mismatch log entry. Written to the immutable
 * `platform_audit_logs` table so ingestion rejections and label mismatches are
 * auditable by the data team. `canonical` is `null` for rejected rows.
 */
export function logPlatformMismatch(
  db: Database,
  entry: {
    tableName: string;
    rowId: string;
    input: string;
    canonical: string | null;
    reason: string;
    operator?: string;
  },
): void {
  db.prepare(
    `INSERT INTO "platform_audit_logs"
       ("tableName", "rowId", "field", "oldValue", "newValue", "reason", "operator")
     VALUES (@tableName, @rowId, 'platformCanonical', @input, @canonical, @reason, @operator)`,
  ).run({
    tableName: entry.tableName,
    rowId: entry.rowId,
    input: entry.input,
    canonical: entry.canonical,
    reason: entry.reason,
    operator: entry.operator || "ingest-pipeline",
  });
}
