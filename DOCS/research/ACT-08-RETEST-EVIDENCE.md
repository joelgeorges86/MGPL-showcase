# ACT-08 Full-Spectrum Retest Evidence

- Date: 2026-09-22T05:12:21.685Z
- Project: `mgpl-508415` | Region: `us-central1` | Model: `gemini-2.5-flash`

> **Annotation, 2026-10-08 (WU-006; #122, #125).** The record below is unchanged.
>
> - **Models billed on 2026-09-22 (#122):** the billing export shows Gemini 2.5 Flash text input and output, Flash thinking output, Flash image input, Flash input text caching, embeddings for text, and **Flash input text caching storage from 05:00 to 10:00**. No Gemini 2.5 Pro line appears on that day. P2's detail below records `"cacheCreated":true`, an explicit cache, which matches the storage line; the `scripts/probes/act08/` scripts did not exist yet.
> - **P2 is unresolved: cached > prompt; unpriceable (#125).** It reports 9 prompt tokens and 46,562 cached tokens. The billable input formula (prompt − cached + tool use) would be negative, so no cost is computed from this row. The P-2 contradiction with 2026-09-17 stays unreconciled.
> - **P6 used grounding with Google Search.** The export does carry it: `LLM Grounding with Google Search tool - Predictions`, quantity 4 on 2026-09-22 (and 1 each for Flash and Pro on 2026-09-17), billed $0, inside the free daily allowance the pricing page states. #122's SKU list did not include this line. (Read-only BigQuery query of the FOCUS export, 2026-10-08, by the Prompt Author.)

## Raw Telemetry Table

| Probe                                 |   Status | Latency (ms) | Prompt Tokens | Candidate Tokens | Cached Tokens |                            Cost | Pass/Fail |
| ------------------------------------- | -------: | -----------: | ------------: | ---------------: | ------------: | ------------------------------: | --------- |
| P1 Controlled Generation              | EXECUTED |         3480 |            39 |              120 |             0 | UNVERIFIED (Promotional Credit) | PASS      |
| P2 Context Caching at Qualified Scale | EXECUTED |         4044 |             9 |               75 |         46562 | UNVERIFIED (Promotional Credit) | PASS      |
| P3 Semantic Drift Audit               | EXECUTED |         2888 |            75 |               78 |             0 | UNVERIFIED (Promotional Credit) | PASS      |
| P4 Semantic Embeddings                | EXECUTED |         1240 |           N/A |              N/A |             0 | UNVERIFIED (Promotional Credit) | PASS      |
| P5 Multimodal Visual QA               | EXECUTED |         1611 |           276 |               10 |             0 | UNVERIFIED (Promotional Credit) | PASS      |
| P6 Live Search Grounding              | EXECUTED |         1676 |            12 |               36 |             0 | UNVERIFIED (Promotional Credit) | PASS      |
| P7 Code Execution Sandbox             | EXECUTED |         1690 |            30 |              108 |             0 | UNVERIFIED (Promotional Credit) | PASS      |
| P8 GCS XML API Reachability           | EXECUTED |          200 |           N/A |              N/A |             0 |                             N/A | PASS      |

## Raw Probe Details

### P1 Controlled Generation

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
{
  "title": "Hollow Knight",
  "developer": "Team Cherry",
  "releaseYear": 2017,
  "tags": [
    "Metroidvania",
    "Souls-like",
    "Platformer",
    "Indie",
    "Exploration",
    "Adventure",
    "Action",
    "Atmospheric",
    "Hand-drawn",
    "2D"
  ],
  "steamAppId": "367520"
}
```

### P2 Context Caching at Qualified Scale

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
{"cacheCreated":true,"cacheName":"projects/327364075881/locations/us-central1/cachedContents/5529919394605432832","explicitCacheErr":null,"promptTokens":9,"cachedTokens":46562,"response":"MGPL uses a Node.js 22/Express/TypeScript backend with `better-sqlite3` as the sole data store (sche"}
```

### P3 Semantic Drift Audit

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
{
  "contradictionDetected": true,
  "conflictSummary": "Clause A states that embedded SQLite is the 'sole persistence authority' and 'remote cloud databases are strictly forbidden'. Clause B explicitly provisions a 'Cloud SQL PostgreSQL instance' for 'user account state', which is a remote cloud database and implies it handles persistence, directly contradicting both stipulations of Clause A."
}
```

### P4 Semantic Embeddings

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
[{"title":"Outer Wilds","score":0.737912890060668},{"title":"Celeste","score":0.4270014442019859},{"title":"Doom Eternal","score":0.40774131144014025},{"title":"Stardew Valley","score":0.39222061145024284}]
```

### P5 Multimodal Visual QA

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
{
  "defectFound": false
}
```

### P6 Live Search Grounding

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
{"queries":["Outer Wilds Steam store URL","Outer Wilds Steam"],"chunks":1}
```

### P7 Code Execution Sandbox

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
The standard deviation of the list `[10, 20, 30, 40, 50]` is approximately `15.811`.
```

### P8 GCS XML API Reachability

- Status: EXECUTED ert{} Pass/Fail:PASS

```text
{"endpoint":"https://storage.googleapis.com","reachable":true}
```
