import type { Collection, EvidenceField } from "./evidenceContract";

export const SOURCE_REGISTER_VERSION = 1;
export type RouteStatus =
  "approved" | "pending_decision" | "not_assessed" | "rejected" | "withdrawn";
export type Publish = "fact_with_attribution" | "link_only" | "withheld";
export type DecisionId = "U-1" | "U-2" | "U-3" | "U-7";
export interface FieldAccess {
  store: "normalized_fact";
  publish_if_origin_verified: Publish;
  publish_decision: "decided" | DecisionId;
}
export interface OriginRule {
  source_id: string;
  hosts: readonly string[];
  path: RegExp;
}
export interface SourceRegisterView {
  entries: readonly SourceEntry[];
  originRules: readonly OriginRule[];
}
export interface SourceEntry {
  id: string;
  kind: "api" | "web_page" | "identity" | "reference_guidance";
  routes: { manual_read: RouteStatus; bounded_get: RouteStatus };
  fields: Readonly<Partial<Record<EvidenceField, FieldAccess>>>;
  retention: "retain_values" | "purge_values_on_withdrawal";
  attribution: string;
  rate: { max_in_flight: 1; min_interval_ms: number } | null;
  decisions: readonly DecisionId[];
  withdrawn_at: string | null;
}
export const ORIGIN_RULES: readonly OriginRule[] = Object.freeze([]);
export const PENDING_DECISIONS: Readonly<Record<DecisionId, string>> = Object.freeze({
  "U-1": "Apple collection, storage and promotional-use terms",
  "U-2": "Operator placement of collection and display hosts",
  "U-3": "Publication of manually read facts and reviewed citation classification",
  "U-7": "Origin verification for the Wikidata class",
});
const listing: EvidenceField[] = [
  "listing_available",
  "listing_version",
  "listing_minimum_os_version",
  "listing_store_url",
];
function entry(
  id: string,
  kind: SourceEntry["kind"],
  manual_read: RouteStatus,
  bounded_get: RouteStatus,
  fields: readonly EvidenceField[] = [],
  decisions: readonly DecisionId[] = [],
  interval?: number,
): SourceEntry {
  return Object.freeze({
    id,
    kind,
    routes: Object.freeze({ manual_read, bounded_get }),
    fields: Object.freeze(
      Object.fromEntries(
        fields.map((field) => [
          field,
          Object.freeze({
            store: "normalized_fact" as const,
            publish_if_origin_verified:
              id === "wikidata" ? ("fact_with_attribution" as const) : ("withheld" as const),
            publish_decision:
              id === "wikidata"
                ? ("decided" as const)
                : id === "apple-search"
                  ? ("U-1" as const)
                  : ("U-3" as const),
          }),
        ]),
      ),
    ),
    retention:
      id === "apple-search" ? ("purge_values_on_withdrawal" as const) : ("retain_values" as const),
    attribution:
      id === "wikidata"
        ? "link to the item revision per fact"
        : kind === "web_page" || id === "apple-search"
          ? "link to the cited page per fact; no text, image or asset"
          : "no fact grant",
    rate:
      interval === undefined
        ? null
        : Object.freeze({ max_in_flight: 1 as const, min_interval_ms: interval }),
    decisions: Object.freeze([...decisions]),
    withdrawn_at: null,
  });
}
export const SOURCE_REGISTER: readonly SourceEntry[] = Object.freeze([
  entry("apple-app-store-page", "web_page", "approved", "rejected", listing, ["U-3"]),
  entry(
    "apple-search",
    "api",
    "rejected",
    "pending_decision",
    [...listing, "listing_bundle_id", "listing_supported_device_tokens"],
    ["U-1", "U-2"],
    3000,
  ),
  entry("google-play-page", "web_page", "approved", "rejected", listing, ["U-3"]),
  entry(
    "publisher-pages",
    "web_page",
    "approved",
    "not_assessed",
    [
      "edition_title",
      "requires_os_min_release",
      "requires_ram_gb",
      "supported_cpu_abis",
      "publisher_lists_device",
      "native_edition_support",
    ],
    ["U-3"],
  ),
  entry(
    "manufacturer-pages",
    "web_page",
    "approved",
    "not_assessed",
    ["soc_name", "ram_gb"],
    ["U-3"],
  ),
  entry(
    "wikidata",
    "identity",
    "approved",
    "pending_decision",
    ["edition_title"],
    ["U-2", "U-7"],
    1000,
  ),
  ...["google-publisher", "apple-connect", "apple-api-overview"].map((id) =>
    entry(id, "api", "rejected", "rejected"),
  ),
  entry("google-links", "reference_guidance", "approved", "rejected"),
  entry("steam-api", "api", "not_assessed", "not_assessed"),
  entry("deck", "web_page", "not_assessed", "not_assessed"),
  ...[
    "windows",
    "cpu-support",
    "hdmi",
    "usb",
    "dp",
    "openxr",
    "xag",
    "wcag",
    "cloud",
    "controller",
  ].map((id) => entry(id, "reference_guidance", "approved", "not_assessed")),
  ...["pixel-hardware", "iphone-identity"].map((id) =>
    entry(id, "web_page", "approved", "rejected"),
  ),
]);
export function sourceEntry(id: string, register?: SourceRegisterView): SourceEntry | undefined {
  return (register?.entries ?? SOURCE_REGISTER).find((source) => source.id === id);
}
export function fieldAccess(
  id: string,
  field: string,
  register?: SourceRegisterView,
): FieldAccess | undefined {
  const fields = sourceEntry(id, register)?.fields;
  return fields && Object.prototype.hasOwnProperty.call(fields, field)
    ? fields[field as EvidenceField]
    : undefined;
}
export function routePermitted(
  id: string,
  route: Collection,
  now: Date,
  register?: SourceRegisterView,
): boolean {
  const source = sourceEntry(id, register);
  return (
    !!source &&
    source.routes[route] === "approved" &&
    (source.withdrawn_at === null || Date.parse(source.withdrawn_at) > now.getTime())
  );
}
export function classifyCitation(
  id: string,
  url: string,
  register?: SourceRegisterView,
): "origin_verified" | "attested_only" | "origin_mismatch" {
  const rules = (register?.originRules ?? ORIGIN_RULES).filter((rule) => rule.source_id === id);
  if (!rules.length) return "attested_only";
  try {
    const parsed = new URL(url);
    return rules.some(
      (rule) =>
        rule.hosts.includes(parsed.hostname) &&
        new RegExp(rule.path.source, rule.path.flags.replace(/[gy]/g, "")).test(parsed.pathname),
    )
      ? "origin_verified"
      : "origin_mismatch";
  } catch {
    return "origin_mismatch";
  }
}
export function effectivePublish(
  id: string,
  field: string,
  url: string,
  register?: SourceRegisterView,
): Publish {
  return classifyCitation(id, url, register) === "origin_verified"
    ? (fieldAccess(id, field, register)?.publish_if_origin_verified ?? "withheld")
    : "withheld";
}
