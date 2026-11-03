/** AI-0NN / G-2 canonical enrichment response contract. */
export type EnrichmentResponse = {
  title: string;
  confidenceScore: number;
  publisher: string | null;
  releaseDate: string | null;
  steamAppId: string | null;
  studio: string | null;
  tags: string[] | null;
  sourceCitation: string[] | null;
};

export const CANONICAL_ENRICHMENT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING", nullable: false },
    confidenceScore: { type: "NUMBER", nullable: false },
    publisher: { type: "STRING", nullable: true },
    releaseDate: { type: "STRING", nullable: true },
    steamAppId: { type: "STRING", nullable: true },
    studio: { type: "STRING", nullable: true },
    tags: { type: "ARRAY", nullable: true, items: { type: "STRING" } },
    sourceCitation: { type: "ARRAY", nullable: true, items: { type: "STRING" } },
  },
  required: ["title", "confidenceScore"],
} as const;

export const ENRICHMENT_PERSISTENCE_MAPPING = {
  title: { staging: "title", appGames: "Game Title" },
  publisher: { staging: "publisher", appGames: "publisher" },
  releaseDate: { staging: "original_game_release_date", appGames: "originalGameReleaseDate" },
  confidenceScore: { staging: "confidence_score", appGames: "enrichmentConfidence" },
  steamAppId: { staging: "steam_app_id", appGames: null },
  studio: { staging: "studio", appGames: null },
  tags: { staging: "tags", appGames: null },
  sourceCitation: { staging: "source_citation", appGames: null },
} as const;

export function isCanonicalEnrichmentResponse(value: unknown): value is EnrichmentResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EnrichmentResponse>;
  return (
    typeof candidate.title === "string" &&
    candidate.title.length > 0 &&
    typeof candidate.confidenceScore === "number" &&
    Number.isFinite(candidate.confidenceScore) &&
    candidate.confidenceScore >= 0 &&
    candidate.confidenceScore <= 1
  );
}
