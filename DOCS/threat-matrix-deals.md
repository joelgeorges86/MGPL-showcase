# Deals Ingestion Threat Matrix (EPIC-DEAL-001)

This document catalogs the threat mitigations applied to the MGPL Deals
ingestion pipeline (CheapShark, ITAD, and GamerPower feeds) in Sprint 1 of
EPIC-DEAL-001. Each row maps a threat to its enforcement point and the
observable guarantee the mitigation provides.

## 1. Spoofed Storefronts

| Threat | Mitigation | Enforcement |
| --- | --- | --- |
| A malicious or compromised feed emits a deal pointing at a look-alike storefront domain (e.g. `steamcommunity-cdn.example.com`). | Outbound URLs are rejected unless the hostname exactly matches the authoritative whitelist (HTTPS required). Subdomains are not implicitly trusted. | `src/utils/storefrontValidator.ts` — `isWhitelistedUrl()` |

Guarantee: every `storeUrl` served by `/api/deals/*` and `/api/giveaways/*`
resolves to one of the exact whitelisted hostnames; anything else is dropped
before it reaches the response.

## 2. Malicious Price Injection

| Threat | Mitigation | Enforcement |
| --- | --- | --- |
| A feed injects negative, NaN/Infinity, or absurdly large prices to distort arbitrage, trigger false alerts, or poison downstream aggregation. | Every price is coerced to a finite number and bounds-checked to `[0.00, 999.99]`; discount percentage is bounds-checked to `[0, 100]`. Out-of-bounds records are rejected. | `src/utils/dealSchema.ts` — `sanitizePrice()`, `sanitizeDiscount()`, `parseDealRecord()` |

Guarantee: no record with an out-of-bounds or non-finite price survives
ingestion, so downstream `isTriggered` alert logic and price sparklines cannot
be skewed by corrupted numbers.

## 3. Cache Poisoning

| Threat | Mitigation | Enforcement |
| --- | --- | --- |
| A compromised upstream or stale local cache injects unwhitelisted/unauthorized seller URLs or malformed records that persist. | Both live (CheapShark/GamerPower) and file-cached (ITAD/GamerPower) records are routed through the same strict schema parser; rejected records are never written to SQLite or served. Unknown/extraneous payload keys are stripped. | `src/routes/deals.ts`, `src/routes/giveaways.ts`, `src/utils/dealSchema.ts` |

Additional defense: the circuit breaker's stale-while-revalidate snapshot is
also re-validated through the schema before being served, so a poisoned cached
snapshot cannot bypass the same checks applied to live data.

## 4. Giveaway Link Phishing

| Threat | Mitigation | Enforcement |
| --- | --- | --- |
| A giveaway feed links to a phishing or grey-market URL (e.g. `g2a.com`, `kinguin.net`) masquerading as a legitimate claim page. | Giveaway claim URLs are checked for grey-market suffix matches and must be whitelisted HTTPS hosts (GamerPower). Freeform `platforms` display text is never treated as an outbound link. | `src/utils/dealSchema.ts` — `parseGiveawayRecord()`, `src/utils/storefrontValidator.ts` — `isGreyMarketUrl()` |

Guarantee: a giveaway record whose claim URL is grey-market, non-HTTPS, or
non-whitelisted is rejected outright; only verified GamerPower HTTPS links are
surfaced as claimable freebies.

## Grey-Market Rejection List

The following domains are rejected by suffix match across all deal and giveaway
URLs:

- `g2a.com`
- `kinguin.net`
- `eneba.com`
- `cdkeys.com`
- `gamivo.com`

## Authoritative Storefront Whitelist

Only these exact hosts are permitted for outbound deal/giveaway URLs:

- `store.steampowered.com` (Steam)
- `gog.com` / `www.gog.com` (GOG)
- `store.epicgames.com` (Epic Games)
- `fanatical.com` / `www.fanatical.com` (Fanatical)
- `greenmangaming.com` / `www.greenmangaming.com` (Green Man Gaming)
- `humblebundle.com` / `www.humblebundle.com` (Humble Bundle)
- `gamerpower.com` / `www.gamerpower.com` (GamerPower giveaway feeds)