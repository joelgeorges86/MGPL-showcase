# ACT-08 Phase 1: operator runbook

**Who runs this: the Principal Operator.** The scripts under `scripts/probes/act08/` were written by an agent. No agent executes them. That keeps the billable calls outside agent authority, where `AGENTS.md` §3 puts them.

**Governed by:** the evidence contract in `DOCS/specs/ACT-08-google-cloud-capability-exploration.md`. Every run record here is **Operator-executed**.

---

## Prerequisites

1. **Repository.** Run from a clean checkout of this branch, with `npm ci` done. The scripts use `@google/genai` 2.23.0, which is already a dependency; nothing is installed.

2. **Credential: ADC impersonating `mgpl-agent`**, the scoped identity from the 2026-09-18 Phase 0 inventory:

   ```powershell
   gcloud auth application-default login --impersonate-service-account=mgpl-agent@mgpl-508415.iam.gserviceaccount.com
   ```

   Confirm the target without printing any credential. This reads one field only:

   ```powershell
   (Get-Content "$env:APPDATA\gcloud\application_default_credentials.json" -Raw | ConvertFrom-Json).service_account_impersonation_url
   ```

   The printed URL must name `mgpl-agent@mgpl-508415.iam.gserviceaccount.com`. **If it does not, stop.** ADC resolving to the owner account would run every probe with `roles/owner`.

   On this machine `gcloud` also needs `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` pointed at the Norton certificate (Phase 0 refresh §0.2). Node already trusts it through `NODE_EXTRA_CA_CERTS`.

3. **Project and region.** `mgpl-508415`, `us-central1`, both fixed in `lib.mjs`.

4. **APIs.** Only `aiplatform.googleapis.com` is needed, and it is enabled (Phase 0 refresh, block 3.1). **No script enables anything.** A `403 SERVICE_DISABLED` or `PERMISSION_DENIED` is a result: record it and stop. Do not enable the API or grant a role to get past it.

5. **Secrets injector.** Per the spec, run under Doppler: `doppler run -- node …`. The scripts read no Doppler secret; credentials come from ADC.

---

## How every script behaves

- **Dry-run is the default.** `node scripts/probes/act08/<script>` prints the exact request, model, expected endpoint and an estimated token count (heuristic, chars/4), and sends nothing. In dry-run the global `fetch` is replaced with one that throws. **Read the dry-run before every `--run`.**
- **`--run` spends.** It writes one file, `DOCS/research/act08-runs/<probe>-<UTC stamp>.json`, containing:
  - the verbatim request and response bodies for every HTTP attempt. Request headers are allowlisted, so no `Authorization` header is ever written;
  - model, actual URL, latency and `usageMetadata`;
  - `computed_cost_usd`, with the formula and the rate row used (`rates.json`, `read_at` 2026-09-24T22:24:45Z);
  - git HEAD, Node and SDK versions, and exit status.
- **stdout** is one summary line ending in the record path. P-8 also prints one line per request.
- **Exit codes:**

  | Code | Meaning                                                           |
  | ---- | ----------------------------------------------------------------- |
  | `0`  | Completed                                                         |
  | `1`  | Failed; the real error is in the record                           |
  | `2`  | Usage error or refusal; nothing sent                              |
  | `3`  | Finding; the probe cannot be run faithfully, stated in the record |

- **`computed_cost_usd` is computed, not charged.** Nothing in these scripts reads billing.

---

## Order and commands

Run in this order: cheapest and most informative first, sustained load last.

| #   | Probe                     | Dry-run, then run                                                                                                               | Dry-run estimate (heuristic)                   | Stops or finds when                                                                           |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | **P-7** Gemini CLI        | Manual: `p7-gemini-cli-procedure.md`                                                                                            | a few hundred tokens                           | It asks for an API key or browser sign-in (record, then stop)                                 |
| 2   | **P-1** Structured output | `doppler run -- node scripts/probes/act08/p1-structured-output.mjs [--run]`                                                     | 3 requests, ~608 input tokens, ≈ $0.001        | —                                                                                             |
| 3   | **P-4** Embeddings        | `doppler run -- node scripts/probes/act08/p4-embeddings.mjs [--run]`                                                            | 25 requests, 1,896 characters, ≈ $0.00005      | The reference blob `8108e75b…` is missing, or fixture vectors differ from 2026-09-17 (exit 3) |
| 4   | **P-5** Code execution    | `doppler run -- node scripts/probes/act08/p5-code-execution.mjs [--run] [--prompt-file <file>]`                                 | 0 without `--prompt-file`                      | No original prompt (exit 3, nothing sent)                                                     |
| 5   | **P-2** Context cache     | `doppler run -- node scripts/probes/act08/p2-context-cache.mjs [--run] [--corpus-manifest <file>]`                              | 2 requests, ~32,500 input tokens each, ≈ $0.02 | A manifest path is missing (exit 2)                                                           |
| 6   | **P-8** Rate and quota    | `doppler run -- node scripts/probes/act08/p8-rate-quota.mjs --max-requests <N> [--concurrency <n>] [--sdk-retries <n>] [--run]` | ≈ $0.0000124 per request, so N = 500 ≈ $0.0062 | First 429 or other failure, or the cap                                                        |

**Notes per probe:**

- **P-4** re-uses the 2026-09-17 reference vectors from local commit `07b460b`, which is reachable only through a Cline checkpoint ref. If Cline prunes that ref, the blob can be garbage-collected and P-4 then exits 3. Run P-4 before any `git gc`.
- **P-5:** the 2026-09-17 prompt and its ten values were never recorded. Without the original prompt it exits 3 and sends nothing. Supply the prompt with `--prompt-file` only if it can be recovered verbatim.
- **P-2** uses implicit caching only. Explicit caching creates a `cachedContents` resource and is not attempted. Its record carries the 09-17 and 09-22 prior results **unreconciled**.
- **P-8:**
  - `--max-requests` is mandatory, and the script refuses without it.
  - The cap counts every HTTP attempt, SDK retries included.
  - The SDK's default is **no retry**. `--sdk-retries <n>` turns SDK retries on to observe them, and the cap still applies.
  - Reaching the cap without throttling is a valid result: "ceiling not reached at N requests". **Do not raise the cap and rerun.**
  - Ctrl+C still writes the record.

**Not scripted:**

- **P-3 (batch inference) is deferred.** It needs a new bucket or dataset plus an IAM grant, which is a resource and permission change requiring its own approval.
- **P-6 (drift audit) is unscoreable as specified.** See `DOCS/research/ACT-08-phase1-results-2026-09-24.md` §5.

## What a failure looks like

A non-zero exit and a one-line summary starting `<probe>: FAILED` or `FINDING`. The record's `error` field holds the SDK error name, HTTP status and message, and `exchanges[]` holds the verbatim response body.

**A failed probe is a result.** Record it. Do not retry more than once. Two failed attempts at the same probe is a diagnostic handoff (spec stop conditions).

---

## Session ledger and the $25 checkpoint

After each run, add its `computed_cost_usd` to a running total in the session notes.

**If the running computed total passes $25, stop and report.** Do not continue.

This is a checkpoint, not a budget. The dry-run estimates above total well under $1, so $25 in one evening means something is not behaving as expected.

## End-of-session reconciliation (one BigQuery read)

Export rows lag, so run this once, after the session: a later day is fine. **It is a billable query.** Run `--dry_run` first to see the bytes it would scan. Replace the two timestamps with the session window in UTC.

```powershell
$env:CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE = 'C:\ProgramData\Norton\Antivirus\wscert.pem'
$sql = @'
SELECT ServiceName, SkuId, ChargeDescription, ConsumedUnit,
  SUM(ConsumedQuantity) AS consumed,
  SUM(ListCost) AS list_cost,
  SUM(BilledCost) AS billed_cost,
  SUM(EffectiveCost) AS effective_cost,
  SUM((SELECT IFNULL(SUM(c.Amount), 0) FROM UNNEST(x_Credits) AS c)) AS credits
FROM `mgpl-508415.gcp_billing_immutable_01F946_FEE88E_6171D8_us.gcp_billing_export_focus_01F946_FEE88E_6171D8`
WHERE x_Project.Id = 'mgpl-508415'
  AND ChargePeriodStart >= TIMESTAMP('2026-09-24T00:00:00Z')
  AND ChargePeriodStart <  TIMESTAMP('2026-09-26T00:00:00Z')
GROUP BY 1, 2, 3, 4
ORDER BY billed_cost DESC
'@
bq.cmd query --use_legacy_sql=false --dry_run $sql
bq.cmd query --use_legacy_sql=false $sql
```

Record both figures side by side: the session's summed `computed_cost_usd`, and the export's `list_cost`, `billed_cost` and `credits` for the Vertex SKUs. **If they disagree, record both and the difference. Adjust neither.**

---

## Committing run records

Commit the `*.json` records and the P-7 record to a feature branch and open a PR to `develop`. Prettier runs on staged JSON and re-indents the wrapper. The verbatim request and response bodies are stored as JSON strings, so their content is unchanged by that.
