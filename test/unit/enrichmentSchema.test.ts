import { describe, expect, it } from "vitest";
import {
  CANONICAL_ENRICHMENT_RESPONSE_SCHEMA,
  ENRICHMENT_PERSISTENCE_MAPPING,
  isCanonicalEnrichmentResponse,
} from "../../src/services/enrichmentSchema";

describe("G-2 canonical enrichment schema", () => {
  it("requires only title and confidenceScore", () => {
    expect(CANONICAL_ENRICHMENT_RESPONSE_SCHEMA.required).toEqual(["title", "confidenceScore"]);
    for (const field of [
      "publisher",
      "releaseDate",
      "steamAppId",
      "studio",
      "tags",
      "sourceCitation",
    ]) {
      expect(CANONICAL_ENRICHMENT_RESPONSE_SCHEMA.properties[field].nullable).toBe(true);
    }
  });

  it("maps only authorized destinations", () => {
    expect(ENRICHMENT_PERSISTENCE_MAPPING.publisher.appGames).toBe("publisher");
    expect(ENRICHMENT_PERSISTENCE_MAPPING.releaseDate.appGames).toBe("originalGameReleaseDate");
    expect(ENRICHMENT_PERSISTENCE_MAPPING.steamAppId.appGames).toBeNull();
    expect(ENRICHMENT_PERSISTENCE_MAPPING.studio.appGames).toBeNull();
  });

  it("rejects missing, out-of-range, and non-numeric confidence", () => {
    expect(isCanonicalEnrichmentResponse({ title: "x" })).toBe(false);
    expect(isCanonicalEnrichmentResponse({ title: "x", confidenceScore: 1.1 })).toBe(false);
    expect(isCanonicalEnrichmentResponse({ title: "x", confidenceScore: "high" })).toBe(false);
  });

  it("accepts a genuine enrichment value", () => {
    expect(
      isCanonicalEnrichmentResponse({
        title: "Genuine Enriched Game",
        confidenceScore: 0.94,
        publisher: "Verified Publisher",
        releaseDate: "2020-01-01",
        steamAppId: null,
        studio: null,
        tags: ["action"],
        sourceCitation: ["trusted-source"],
      }),
    ).toBe(true);
  });
});
