# AI-0NN / G-2 implementation notes

## Staging isolation

`AppGames_Staging` is append-only and keyed by `run_id`. A re-enrichment creates
a new run; rows are never updated in place. Promotion selects exactly one named
run and is never part of an enrichment run. The table has no foreign key into
`AppGames`, is not registered in `src/routes/state.ts`, and is excluded from
user backup/restore because it contains unreviewed operational model output.

## Promotion mapping

`title`, `publisher`, `releaseDate`, and `confidenceScore` map to the existing
`AppGames` destinations. `steamAppId`, `studio`, `tags`, and `sourceCitation`
remain in staging for safety observation and are dropped on promotion because
this work unit does not add `AppGames` columns.

## PROVISIONAL AI-014 guard

The promotion command expects `reports/ai-014-count-regeneration/<run_id>.json`
with the documented `runId`, `source`, `status`, timestamp, and numeric counts.
This shape is **PROVISIONAL**, pending the real AI-014 run. A JSON file that an
operator or promotion path can write is an **advisory guard, not a control**;
the marker must be produced by the AI-014 run. This implementation does not
write the marker and cannot establish that provenance itself.

## UNLANDED FIELDS

| Generated field  | AppGames destination       | What adding one would require                                                                                                                                              |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steamAppId`     | None; dropped on promotion | A separately authorized `AppGames` column, schema migration, destination validation, backup/export decision, and reviewed promotion mapping.                               |
| `studio`         | None; dropped on promotion | A separately authorized destination column and the same migration, validation, backup/export, and promotion decisions. It must not be silently conflated with `publisher`. |
| `tags`           | None; dropped on promotion | A separately authorized structured tag destination, including JSON/relational shape, ownership semantics, uniqueness, migration, and promotion rules.                      |
| `sourceCitation` | None; dropped on promotion | A separately authorized provenance destination, including retention, display/privacy, migration, and promotion rules.                                                      |

## Probe status

The probe consumes only local fixture output and writes an observation report.
It makes no Vertex or network calls and does not decide the G-2 gate. Tranche A
is the load-bearing fabrication test. Tranche B uses explicit provenance states;
the included no-network fixture is `assumed_absent`, not `verified_external_source`.
