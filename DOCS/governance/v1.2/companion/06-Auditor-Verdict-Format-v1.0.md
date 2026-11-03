# MGPL Auditor Verdict Format v1.0

**Version:** 1.0 (extracted from Manual v1.1 — unchanged)
**Date:** October 1, 2026
**Owner:** MGPL Governance Office (operator)

## 1. The Three Verdicts

| Verdict            | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| PASS               | No findings. Document is verified.                                |
| PASS-WITH-FINDINGS | Non-blocking findings. Document is usable with noted corrections. |
| FAIL               | Blocking findings. Document must be revised before adoption.      |

## 2. Verdict Format

```
AUDITOR VERDICT
---------------
Document: <path or title>
Auditor: <Agent name and version>
Date: <ISO 8601>
Verdict: PASS | PASS-WITH-FINDINGS | FAIL

SUMMARY
-------
<One paragraph summarizing what was reviewed and the overall verdict.>

FINDINGS
--------
<Numbered list. Omit this section if no findings.>

Finding 1:
  Location: <section, line, or quoted text>
  Severity: Critical | High | Medium | Low
  Disposition: Verified | Sourced | Inferred | Unknown
  Description: <what the finding is>
  Recommended correction: <what the correct text should say>

VERIFIED ITEMS
--------------
<Items that were checked and found correct.>

UNVERIFIED ITEMS
----------------
<Items that could not be verified, with what would verify them.>

SCOPE
-----
<What was in scope for this audit.>

NEXT ACTION
-----------
<PASS: operator review; PASS-WITH-FINDINGS: operator review with noted corrections; FAIL: return to Document Writer>
```

## 3. Severity Definitions

| Severity | Meaning                                        |
| -------- | ---------------------------------------------- |
| Critical | Factual error that would cause harm if adopted |
| High     | Omits required content or material inaccuracy  |
| Medium   | Minor inaccuracy or unclear phrasing           |
| Low      | Stylistic or cosmetic                          |

## 4. Disposition Definitions

| Disposition | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| Verified    | Checked against a primary source                                  |
| Sourced     | Named external source makes the claim; not independently verified |
| Inferred    | Logical conclusion from verified facts; assumptions stated        |
| Unknown     | Cannot be verified with available access                          |

## 5. What a PASS Verdict Authorizes

Every claim checked against a primary source, no fabricated content, no misrepresentation, complete for its stated purpose.

## 6. Auditor Boundaries

The Auditor must not:

- Rewrite the document
- Fix adjacent issues
- Approve its own work
- Originate content
- Change the document's scope
- Audit an artifact it authored
- Audit an artifact whose author shares its vendor or model family, without an explicit operator-recorded exception

## 7. Triage Rule

When claims in a document conflict with tier assignments or role definitions, the Auditor applies the most restrictive applicable rule. Read-only activity can still disclose restricted information.

**End of Auditor Verdict Format v1.0.**
