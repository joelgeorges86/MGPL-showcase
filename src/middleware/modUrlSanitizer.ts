import { Request, Response, NextFunction } from "express";
import { sanitizeErrorMessage } from "../utils/errorSanitizer";

/**
 * Sprint 5 (EPIC-06): HTTPS + exact-match domain whitelist sanitization for the
 * Mods Ecosystem ingestion pipeline.
 *
 * Only the canonical mod-hosting domains below may ever be persisted as a mod
 * `sourceUrl`. The scheme MUST be `https:` — plain http, javascript:, data:,
 * vbscript: and non-URL input are all rejected.
 *
 * "Exact-match" semantics: after lowercasing and stripping a leading `www.`
 * prefix, the hostname must be EXACTLY one of the whitelist entries. Arbitrary
 * subdomains (e.g. api.nexusmods.com, files.nexusmods.com) are intentionally
 * rejected because the registrable-domain prefix approach is weaker than an
 * explicit allow-list. GitHub is additionally restricted to release asset
 * paths: /<owner>/<repo>/releases/...
 */
export const MOD_SOURCE_DOMAINS: readonly string[] = [
  "nexusmods.com",
  "moddb.com",
  "curseforge.com",
  "github.com",
  "modrinth.com",
] as const;

/** Normalize a hostname: lowercase, trim, strip a leading www. prefix. */
export function normalizeModHost(host: string): string {
  let h = String(host || "").trim().toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

export interface SanitizedModUrl {
  valid: true;
  url: string;
  domain: string;
}

export interface RejectedModUrl {
  valid: false;
  error: string;
}

export type ModUrlSanitizeResult = SanitizedModUrl | RejectedModUrl;

/** Validate an incoming mod source URL against the whitelist + HTTPS rules. */
export function sanitizeModUrl(raw: unknown): ModUrlSanitizeResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { valid: false, error: "sourceUrl is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { valid: false, error: "sourceUrl must be a valid absolute URL." };
  }

  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      error: "sourceUrl must use the https: scheme (http and non-http schemes are rejected).",
    };
  }

  // Sprint 1B (EPICSEC02): reject embedded credentials (userinfo). A URL like
  // `https://nexusmods.com@evil.com/mods/x` parses with hostname `evil.com`,
  // which the whitelist already rejects — but `https://nexusmods.com@nexusmods.com.evil.com`
  // style obfuscation must fail fast and unambiguously regardless of hostname.
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: "sourceUrl must not include embedded credentials (user:pass@host).",
    };
  }

  const domain = normalizeModHost(parsed.hostname);
  if (!domain) {
    return { valid: false, error: "sourceUrl must include a hostname." };
  }
  // Sprint 1B (EPICSEC02): reject trailing-dot hostnames (e.g. `nexusmods.com.`),
  // which are DNS-equivalent to the whitelisted domain but never match the
  // exact-match allow-list. Failing closed is safer than normalizing silently.
  if (domain.endsWith(".")) {
    return {
      valid: false,
      error: "sourceUrl hostname must not include a trailing dot.",
    };
  }
  if (!MOD_SOURCE_DOMAINS.includes(domain)) {
    return {
      valid: false,
      error: `sourceUrl domain "${domain}" is not on the exact-match whitelist (nexusmods.com, moddb.com, curseforge.com, github.com, modrinth.com).`,
    };
  }

  // GitHub is trusted only for release asset links, never general repository
  // pages or arbitrary githubusercontent blobs. Accepts the bare releases page
  // (/owner/repo/releases) as well as nested paths (/owner/repo/releases/tag/x,
  // /owner/repo/releases/download/...) — the trailing slash is optional.
  if (domain === "github.com") {
    if (!/^\/[^/]+\/[^/]+\/releases(\/|$)/.test(parsed.pathname)) {
      return {
        valid: false,
        error: "github.com URLs must point to a /<owner>/<repo>/releases/ path.",
      };
    }
  }

  return { valid: true, url: parsed.toString(), domain };
}

/**
 * Express middleware for mod ingestion routes. Validates `req.body.sourceUrl`,
 * verifies an optional `req.body.sourceDomain` matches the sanitized URL, and
 * attaches `res.locals.sanitizedModUrl` / `res.locals.sanitizedModDomain` for
 * the route handler. Responds 400 with a structured error on any violation.
 */
export function sanitizeModSourceUrl(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body || {};
  const result = sanitizeModUrl(body.sourceUrl);
  if (!result.valid) {
    console.warn(`[mods] Rejected sourceUrl: ${result.error}`);
    // Sprint 1A (EPICSEC04): the rejection message echoes caller-supplied
    // input, so it must pass through the shared sanitizer before it is sent.
    res.status(400).json({ error: sanitizeErrorMessage(result.error) });
    return;
  }

  // When the caller also supplies a domain label it MUST agree with the
  // sanitized URL so a mismatched (or spoofed) sourceDomain never persists.
  if (body.sourceDomain != null && String(body.sourceDomain).trim() !== "") {
    const supplied = normalizeModHost(String(body.sourceDomain));
    if (supplied !== result.domain) {
      // Sprint 1A (EPICSEC04): sourceDomain is caller-supplied, so the echoed
      // error message must be sanitized (paths/secrets redacted) before it
      // reaches the client.
      res.status(400).json({
        error: sanitizeErrorMessage(
          `sourceDomain "${body.sourceDomain}" does not match the sanitized URL domain "${result.domain}".`,
        ),
      });
      return;
    }
  }

  res.locals.sanitizedModUrl = result.url;
  res.locals.sanitizedModDomain = result.domain;
  next();
}
