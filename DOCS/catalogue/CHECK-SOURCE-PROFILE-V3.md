# Check source profile v3

The description check runner uses `wikipedia-lead-prose-v3`. This corrects
template parsing when a pinned Wikipedia lead contains literal braces inside
a complete `nowiki` region. Such braces must not open or close a template.

Literal regions are protected before comment, template, reference, link and
formatting processing. A region inside a removed template disappears with that
template. A region in retained prose preserves its literal contents. Allowed
entities are still decoded once, whitespace is normalized, and the result is
clipped to 1,500 Unicode scalar values. Self-closing literal tags contain no
text. An unclosed literal region or an unclosed actual template still refuses.
Source text remains in memory only; the change adds no source storage or logs.

## Existing results and resumption

The projection changes the reference text given to the model, so it has a new
profile identity. Existing v2 results remain intact. They do not count as
completed v3 checks: the resume key includes the source profile. The same input
snapshot remains valid, but all its rows are eligible under v3 until checked
under that profile. Do not relabel, delete or rewrite existing result records.
In the operator's reported 5,927-row snapshot, the 750 saved v2 checks are
historical results; they are not automatically reusable v3 checks.

After required validation, independent review and operator merge, first run an
unbilled source validation of the specific failing QID using a separately
selected input, or the existing operator diagnostic pointed at the reviewed
runner. Confirm the original source check passes without the diagnostic's
experimental omission. Then inspect a dry-run's profile, pending counts and
reservation before an operator invokes a billed run. Existing ledger caps,
reservations, permissions, source restrictions and expiry checks still apply.
No real source validation, billed run or readiness claim accompanies this fix.
