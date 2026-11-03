# Catalogue promotion: from the files into the database

_Added by WU-033b (#158, task proposal 033). `SOURCES.md` describes where the catalogue's data comes from; this file describes how it enters the database the app uses._

The catalogue's files (`data/catalogue/` and the drafts folder) are never read by the app. A reviewed command copies them into three tables that `src/db.ts` creates. They are separate from the app's own `AppGames` rows and from all user state. Nothing links a catalogue game to an `AppGames` row yet, and no screen shows catalogue data.

## The tables

| Table             | Key            | Holds                                                                                                                                                                                                                                                         |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CatalogueGames`  | `qid`          | every Wikidata item: its label, the Steam app the agreement step compared, and the Wikidata revision link                                                                                                                                                     |
| `CatalogueFacts`  | `qid`, `field` | the fields Wikidata and Steam `agree` on, with the basis of the agreement and both source links. Nothing else: `partial`, `conflict`, `distinct`, `single` and `none` fields stay out                                                                         |
| `CatalogueDrafts` | `qid`, `kind`  | one model draft per game and kind (`description`, `friction`, `genre`), labelled `generated`, with its source links, model, prompt version, run and attempt, the hash of the text a reviewer would check, and the accepted sample check it was promoted under |

The database refuses a draft row whose label is not `generated`, an unknown kind, a malformed QID, and any row whose game is not in `CatalogueGames`.

## The command

`scripts/catalogue/promote-catalogue.ts`, run with `npx tsx`. It works on `DB_PATH` (or `mpgl_app.db`), never creates a table, and prints counts only.

1. **`facts --wikidata <wikidata.jsonl> --agreement <agreement.jsonl> --review-confirmed true`** loads the games, then replaces each compared game's facts. Games and facts that are not in the files are left as they are.
2. **`drafts --kind <kind> --in <drafts> [--in <more drafts>] --summary <sample-....summary.json> --review-confirmed true`** loads each game's latest `ok` draft. It refuses unless:
   - the sample-check summary is for this kind, is complete, has 100 rows and at most 3 `wrong`, and carries the operator's `accepted_by` and `accepted_at`;
   - the sheet and meta file beside it are the ones scored, by SHA-256;
   - the meta file holds exactly 100 distinct drawn rows, the sheet holds those rows with the drawn games and drafts, and the verdicts counted from the sheet equal the summary's counts (so editing the summary's counts alone does not change the outcome);
   - the `--in` files are exactly the files the sample was drawn from, in the same order, by name and SHA-256;
   - every sampled draft is still its game's latest `ok` draft, with the text that was checked;
   - every drafted game is already in `CatalogueGames` (run `facts` first).

   A game whose latest record is `rejected`, `insufficient` or `failed` gets no draft, and a draft of that kind promoted earlier is withdrawn.

Every input is read and checked before the first write, and each step is one transaction, so a refusal changes nothing. Every stored link must be `https` on the host for its source: `www.wikidata.org`, `store.steampowered.com` or `en.wikipedia.org`.

**Steam's facts win.** A friction draft's `save_system` becomes `save_anywhere` where Steam lists "Save Anytime" (category 79). The drafted value is kept beside it in `overrides`, and the row's text hash stays that of the draft as checked. Steam not listing a category changes nothing. A "Save Anytime" fact without its Steam link is refused.

## Who runs it

The sample-check files are a record of the operator's review, and an operator can write them. The checks tie a promotion to that record; they are not a control by themselves, as the note on the AI-014 marker in `src/services/enrichmentPromotion.ts` already says of its own marker.

Agents run the command only against a dev database and fixtures. Against production it is a production database write, reserved to the Principal Operator (AGENTS.md section 3.3).
