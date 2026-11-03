# Catalogue export: the promoted inputs as kind-specific snapshots

_Added by WU-034. `PROMOTION.md` describes how the catalogue enters the database; this file describes how the operator exports the promoted state back out as the two kind-specific inputs the downstream check and embedding modes consume._

The exporter does not dump the `Catalogue*` tables. It produces one snapshot per kind, in the exact schema the downstream scripts already validate:

- **friction / genre** → `snapshot.jsonl` rows of schema `mgpl-promoted-embedding-input/2`, the input `scripts/catalogue/embed-descriptions.mjs --promoted-input` reads.
- **description** → `snapshot.jsonl` rows of schema `mgpl-description-check-input/2`, the input `scripts/catalogue/enrich-gemini.mjs --task check --check-input` reads.

`manifest.json` sits beside the snapshot and carries the exporter's provenance (script hash and git commit, plus a dirty flag), the verified summary and draft hashes, the accepted input order, the snapshot hash, and reconciling counts.

## The command

```powershell
node scripts/catalogue/export-promoted-inputs.mjs `
  --kind <description|friction|genre> `
  --db <file> --out <bundle folder> `
  [--summary <accepted summary> --drafts <drafts folder>]  # friction/genre only
  [--qid <QID> ...] [--validate-only]
```

- `--kind` selects one of `description`, `friction` or `genre`.
- `--db` is the promoted database (default `$env:DB_PATH`, then `mpgl_app.db`). It is opened read-only and read in one transaction.
- `--out` is the bundle folder (outside the repository).
- `--summary` and `--drafts` are required for friction/genre and not read for description.
- `--qid` (repeatable) narrows the export to exactly the named QIDs; the whole request refuses if any named QID is not in the selected cohort.
- `--validate-only` runs every check and re-validation but publishes nothing.

## Where the snapshot data comes from

The two kinds read from different sources:

**E (friction / genre) — the accepted draft bytes.** The exporter reads the accepted summary, its sheet and meta evidence, and the exact named draft bytes (each hash verified), then:

1. takes each game's latest `ok` draft, with timestamp ties resolved in the summary's inputs order;
2. selects only rows whose `sample_summary_sha256` equals the supplied summary's hash — every other cohort is reported as rows and distinct hashes, not exported;
3. derives `text_sha256` from `embeddingText(kind, { [kind]: generated })` (the strict generated shape and enums), and refuses if that digest does not equal the promoted row's `text_sha256`;
4. records `draft_file` from the winning draft file. Reviewed text is never reconstructed from `CatalogueDrafts.value`, `sourced` or `overrides`.

**G (description) — the promoted database row.** No summary or drafts are read. For each promoted description row the exporter reads `value.description` exactly (no trimming), verifies its SHA-256 against the row's `text_sha256`, and uses the row's `links.wikipedia` (the pinned source), `promoted_at` and `sample_summary_sha256`. A row whose pinned source is missing or nonconforming is excluded and counted; Wikipedia source text is never fetched or written. A description whose digest does not match its promoted row is refused.

A selected row without an accepted winning draft record (E) is fatal, and an empty selection is refused.

## Publication, no-overwrite, crash recovery and locking

The two files are written into a temporary bundle folder and then renamed into the destination with **one directory rename**, so a bundle appears only once it is complete. The destination is never overwritten: the command refuses when it already exists. A destination lock folder (`<out>.lock`) is acquired first and released on completion, so cooperating invocations on the same destination do not corrupt each other; a second invocation refuses while the lock is held.

The limits, stated plainly:

- **Crash recovery.** A kill between the temporary write and the rename leaves only a temp folder (never a half-written destination), because the publish is a single rename. A temp folder left by a killed run is not self-healing; remove it and re-run.
- **Cooperative locking.** The lock is advisory and best-effort; it is not a hard guarantee against a non-cooperating writer. Run each export to its own destination.

Only resources this invocation created (its temp folder and its lock) are removed on failure.

## Manifest revision provenance

`manifest.exporter.commit` is the HEAD commit of the repository containing the exporter, resolved with `git rev-parse HEAD`; the exporter refuses when it cannot be resolved. `manifest.exporter.dirty` is true when the exporter or an imported validator has uncommitted changes, so a `dirty: false` manifest is the only one whose commit identifies those bytes.

## Who runs it

This is a read-only export of promoted catalogue state. Agents run it only against fixtures and synthetic databases. The operator runs it against the real database, and only the operator accepts samples or runs the downstream check/embedding modes.

## Running it (PowerShell)

The placeholders below are **not** commands to paste. Replace each `<...>` with a real path before running.

```powershell
# 1. The promoted database. Not yet final.
$db = "<path-to-the-promoted-database>"

# 2. Where the bundle goes (outside the repository). Not yet final.
$out = "<path-to-the-bundle-folder>"

# 3. Description: read from the database only.
node scripts/catalogue/export-promoted-inputs.mjs --kind description --db $db --out $out --validate-only

# 4. Friction/genre: the accepted summary and its draft files (not yet final).
$summary = "<path-to-sample-friction-<seed>.summary.json>"
$drafts = "<path-to-the-enrich-output-folder>"
node scripts/catalogue/export-promoted-inputs.mjs --kind friction --summary $summary --drafts $drafts --db $db --out $out --validate-only

# 5. Export (friction example). Nothing is overwritten; remove an old bundle from $out first.
node scripts/catalogue/export-promoted-inputs.mjs --kind friction --summary $summary --drafts $drafts --db $db --out $out

# 6. Verify the bundle before you trust it.
Get-Content "$out\manifest.json" | ConvertFrom-Json | ForEach-Object { $_.snapshot.sha256 }
(Get-FileHash "$out\snapshot.jsonl" -Algorithm SHA256).Hash.ToLowerInvariant()
```

The two hashes must be equal. A mismatch means the snapshot does not match its manifest; do not use it.
