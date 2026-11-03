# WU-034 description-check operator waiver

The Principal Operator recorded a task-specific spending instruction on
[issue #207, October 21, 2026](https://github.com/joelgeorges86/MGPL/issues/207#issuecomment-6316449436).
The runner applies it only when the caller explicitly supplies that exact URL:

```powershell
node scripts/catalogue/enrich-gemini.mjs --run --entry '#207' --task check `
  --check-input 'C:\dev\_staging\wu-034-inputs\g-description-check-01\snapshot.jsonl' `
  --out 'C:\dev\_staging\enrichment-output' --limit 5 --batch 5 --parallel 1 --reserve 3 `
  --operator-waiver 'https://github.com/joelgeorges86/MGPL/issues/207#issuecomment-6316449436'
```

This flag skips credit-record reads (including freshness and credit stop-line
checks), the entry dollar ceiling, the shared-window dollar ceiling, and the
requirement to reconcile earlier reservations before allocating more dollars.
The existing accounting is not rewritten or treated as billed evidence.

The flag is rejected for any other reference, entry, script, or mode. The CLI
also requires the approved snapshot path and its SHA-256:
`50526dafbe01b56a16b33f9b0fae7a530749a49e21a30adc1a99fc8471cab8a9`.
The waived run permits only the existing global `gemini-3.8-flash`
`generateContent` request. The entry-defined output path is still checked.

Locks, open-run detection, request ceilings, entry/window expiry, malformed-ledger
refusal, unexplained-difference and recorded-card-charge stops, endpoint checks,
authentication, input validation, source protections, per-run reservation bounds,
and bounded retries remain active. `--reserve` still bounds each run; it is not
an estimate of the eventual billed cost. The waiver does not change Google quotas
or guarantee model capacity.

Every waived reservation records `operator_waiver`, `credit_check_waived: true`,
and `credit_record: null`. The aggregate records the reference too. No credit
position or reconciliation record is fabricated. Omitting the flag retains the
normal controls, even if earlier ledger lines mention a waiver.

The reference is an explicit invocation choice, not an online authorization or
revocation lookup. If the operator revokes it, interrupt an active run and do not
use the flag again. The CLI does not poll GitHub for edits or later comments.

Check-run aggregates include `request_error_diagnostics`: numeric HTTP status,
fixed boolean hints for quota/capacity/retry/resource-exhaustion wording, and
counts. Hints describe wording, not a proven root cause. No raw exception message,
response body, prompt, credential, or source text is persisted in diagnostics.
