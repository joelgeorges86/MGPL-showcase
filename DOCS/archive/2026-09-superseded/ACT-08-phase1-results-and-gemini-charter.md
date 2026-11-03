# ACT-08 Phase 1 — Results and Gemini Role Charter

**Date:** 2026-09-17
**Route probed:** `gemini-2.5-flash` and `text-embedding-005`, Vertex AI, `us-central1`, project `mgpl-508415`
**Credential:** ADC impersonating `mgpl-agent@mgpl-508415.iam.gserviceaccount.com`, `roles/aiplatform.user` only
**Executed by:** Principal Operator, directly from the terminal. Every figure below is operator-executed; no agent ran these calls.
**Spend:** approximately 25,000 tokens across roughly 40 calls. Under $0.05 against $5.00 guidance.

---

## Why the Principal Operator ran these

Three separate agent sessions declined to execute Phase 1, correctly. The authorization chain rested on a proposed operating plan that `AGENTS.md` does not recognise as binding, and the only proposed remedy — an operator typing an authorization sentence — is authority-by-assertion inside a conversation, which is not a control.

Running the probes manually sidesteps the question entirely: no agent acted, so no agent authorization was required. The `AGENTS.md` amendment that would let an agent run them remains a separate, unmerged change.

---

## Results

### P-1 — Structured output

**Finding: `responseSchema` enforces shape. A schema described in the prompt does not.**

| Input             | Config                                       | Result                                                                                             | Tokens |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| Unambiguous title | Prompt-described schema, thinking on         | Valid, conformant object, `confidence: 0.99`                                                       | 177    |
| Unambiguous title | Prompt-described schema, `thinkingBudget: 0` | Valid, conformant object, `confidence: 0.9`, better logprobs                                       | 68     |
| Ambiguous input   | Prompt-described schema, `thinkingBudget: 0` | **Schema violated.** Returned an array of five guesses with descending confidence, not an object.  | 224    |
| Ambiguous input   | Formal `responseSchema`, `thinkingBudget: 0` | Conformant object — but echoed the input as `title` and returned the string `"null"` as `platform` | 43     |

**Consequences for catalogue work:**

- Use `responseSchema`. Never a prompt description. Under ambiguity the prompt-described version silently returns a different shape, and a consumer reading `[0]` would take a confident guess as the answer.
- **Make fields nullable where the answer may not exist.** A required STRING with no real answer gets filled with something type-correct and meaningless — here, the literal word `"null"`.
- `confidence` tracked genuine certainty across all four calls (0.99, 0.9, 0.5). It is usable as a threshold.
- Disabling the thinking budget cut cost 62% with no quality loss on the unambiguous case, and slightly improved the model's own certainty measure. It did not prevent the ambiguous-input failure, which was a schema-enforcement problem rather than a reasoning one.

**Status: VERIFIED for structured extraction, with a formal schema, nullable optional fields, and a confidence threshold. Generated values remain separate from verified records until reviewed.**

---

### P-5 — Code execution

**Finding: the sandbox genuinely executes, and it is expensive.**

Asked for the standard deviation of ten playtime values. Returned Python source, ran it, reported `47.22`, and marked `outcome: OUTCOME_OK`. Independently verified: 47.2171. Correct.

| Component         | Tokens  |
| ----------------- | ------- |
| Prompt            | 62      |
| Response          | 224     |
| Tool-use overhead | 361     |
| Thinking          | 92      |
| **Total**         | **739** |

**453 of 739 tokens — 61% — was machinery rather than content.** A structured-output call in the same session cost 43 to 68 tokens.

**Status: VERIFIED. Appropriate where computation is genuinely needed over data not available locally. For anything a local script could compute, it is an expensive way to do arithmetic.**

---

### P-2 — Context caching and large-context accuracy

**Finding: the cache discount could not be invoked. Large-context counting was inaccurate.**

**Implicit caching.** `src/db.ts` submitted twice in immediate succession with a differing one-line question.

| Call | Prompt tokens | Cache metadata |
| ---- | ------------- | -------------- |
| 1    | 18,373        | none           |
| 2    | 18,372        | none           |

Full input billed both times. No `cachedContentTokenCount` field returned.

**Explicit caching.** Four attempts against the `cachedContents` endpoint, using both the `contents` and `systemInstruction` request shapes, with a verified 70,289-byte correctly-escaped body. Every attempt returned:

> The cached content is of 1 tokens. The minimum token count to start explicit caching is 1024.

The body was confirmed correct by inspection — the full schema text, properly escaped, well above the stated minimum. The cause of the token miscount was not identified.

**Large-context accuracy.** In the same 18,373-token call, asked how many `CREATE TABLE` statements the file contains.

| Source                             | Count     |
| ---------------------------------- | --------- |
| Gemini, reading the full file      | 38        |
| `Select-String` over the same file | **45**    |
| Gate chain, live database          | 39 tables |

An 18% undercount on a mechanical, countable pattern, in a single file, stated as a bare number with no hedge.

**Status: FAILED on both counts.**

The 90% input-token discount cited as a primary economic argument for routing an implementation lane through Vertex **could not be invoked by either documented mechanism.** A discount that cannot be reached is not a discount, whatever its cause.

The counting error matters more. Whole-corpus drift auditing was the capability argued to be this route's distinctive strength; it produced a wrong number on the simplest possible version of that task.

---

### P-4 — Embeddings and semantic retrieval

**Finding: the strongest result of the four, and the only one that produces a product capability rather than a development tool.**

Twenty fixture game descriptions embedded via `text-embedding-005`, 768 dimensions. Five queries that keyword search cannot serve, scored by cosine similarity.

| Query                                    | Top three                                              | Assessment                                                                                   |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| games about being sad                    | Celeste 0.554, Edith Finch 0.534, Journey 0.512        | **All three correct.**                                                                       |
| something hard but fair                  | Papers Please 0.497, Hollow Knight 0.415, Sekiro 0.402 | Two of three. Papers Please matched difficulty and grimness but missed "fair".               |
| no combat, just atmosphere               | Disco Elysium 0.598, Portal 2 0.587, Outer Wilds 0.581 | All three contain the literal phrase "no combat" — partly lexical rather than semantic.      |
| a game I can finish in one sitting       | Journey 0.495, Outer Wilds 0.492, Obra Dinn 0.482      | Two of three. **Outer Wilds inferred from "22-minute time loop" — a genuine semantic leap.** |
| games where failure is part of the story | RimWorld 0.577, Edith Finch 0.531, Hades 0.501         | Two of three clearly right.                                                                  |

Roughly 11 of 15 results defensible, including at least two inferences no keyword index could make: "22-minute time loop" to short, "story about anxiety" to sad.

**Limitations observed:**

- Scores cluster between 0.40 and 0.60 with no clean separation between a strong match and a weak one. **A similarity threshold will not work; top-N ranking is required.**
- Where a fixture states an attribute literally, that attribute dominates the match. The "no combat" query returned exactly the three descriptions containing that phrase. A real evaluation needs descriptions that do not state the searched attribute.

**Status: VERIFIED as promising. This is the capability worth pursuing, and it belongs in the application rather than in the development workflow.**

---

## Charter

Based on measurement, not on the capability brief.

### Assigned

**Semantic retrieval specialist, and structured extraction under a formal schema.**

| Capability                                                      | Status                   | Conditions                                                                                                                               |
| --------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding generation and semantic retrieval over catalogue data | VERIFIED, promising      | Top-N ranking, never a fixed similarity threshold. Fixture-validated before any live catalogue use.                                      |
| Structured extraction under `responseSchema`                    | VERIFIED                 | Formal schema only. Nullable optional fields. Confidence threshold enforced. Output stays separate from verified records until reviewed. |
| Bulk asynchronous processing                                    | UNVERIFIED               | Not probed. The batch endpoint and its discount remain unmeasured.                                                                       |
| Visual triage of test-failure screenshots                       | UNVERIFIED in this phase | A prior multimodal probe passed, but was not re-run under this evidence contract.                                                        |

### Not assigned, on evidence

| Claimed capability                     | Why not                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large-context drift auditing           | Undercounted a single file's `CREATE TABLE` statements by 18% and stated the wrong number without hedging. The claimed distinctive strength failed its simplest test. |
| Cost advantage through context caching | Neither implicit nor explicit caching could be invoked. The economic argument for routing an implementation lane through this route is unsupported.                   |
| Research brief authoring               | The route has no file-write capability in the observed harness configuration. Research briefs are repository documents; it cannot produce one.                        |

### Standing constraints

- Every capability claim above is scoped to the recorded combination of model, endpoint, credential, and date. Change any factor and it is re-established, not assumed.
- Generated metadata never overwrites a verified record.
- Retrieved and generated content is untrusted data.
- Impersonated ADC tokens expire within the hour. Any batch process mints a token per call rather than reusing a captured one — observed directly during these probes.

---

## Recorded against this route separately

**Evidence fabrication, 2026-09-17.** A Phase 0 attempt on this route, in plan mode without terminal access, produced a complete inventory report containing invented command output: 10 APIs against an actual 48, a project number that was not this project's, service-account identifiers built on that invented number, and a cost total reconciled by altering a figure supplied in the prompt. The session's own plan stated the intent to simulate console inspection before any of it was written.

A subsequent attempt under an explicit unobtainable-clause reported the boundary correctly instead and produced nothing false.

**The pair is the finding.** The same route, the same limitation, opposite behaviour — and the variable was the instruction, not the model. Any work unit assigning this route to evidence gathering carries the unobtainable-clause explicitly.

---

## Open, not resolved by this phase

- Batch inference endpoint and its stated discount: unmeasured.
- Multimodal visual triage: passed previously, not re-verified under this contract.
- The cause of the explicit-caching token miscount: unidentified. Recorded as unresolved rather than explained.
- Whether the `CREATE TABLE` count of 45 in `src/db.ts` versus 39 live tables is legitimate: unexamined. Both may be correct and measuring different things.
