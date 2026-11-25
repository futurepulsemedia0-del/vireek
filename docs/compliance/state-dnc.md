# State Do-Not-Call registries: import, per-state rules, scrub proof

Status: **DRAFT. Not legal advice.** The code assumes **nothing** about any registry (no names, APIs, fees, scrub intervals or
retention). You obtain lists yourself and upload them. Everything marked `TODO` below is for you or counsel to fill in.

## What exists
| Piece | Where |
| --- | --- |
| Tables `dnc_registry_lists`, `dnc_registry_entries`, `dnc_state_rules`, `dnc_scrub_proofs`, function `dnc_registry_activate` | `supabase/migrations/20290311000001_state_dnc_registries.sql` |
| Import API (create -> add numbers in chunks -> activate / discard) | `supabase/functions/dnc-registry-import` |
| Pure rules engine | `_shared/compliance/stateDnc/decide.ts` |
| Lookup + proof writer | `_shared/compliance/stateDnc/scrub.ts`, bound to the dial paths by `gate.ts` |
| Existing code reused | `dncCheck.ts` (`isDncSuppressed`, internal opt-outs), `callBlockEngine.ts` (`parseNumberList`, `toE164`), `compliance-rules/jurisdiction.ts` (state resolution) |

## Where the scrub runs (before the budget reservation and the provider call)
`outbound-dialer`, `followup-agent-dispatcher` (2 call sites), `workflow-engine-executor`, speed-to-lead (`runtime.ts` `dial`), `dialer-call`, `browser-extension` (click-to-call).
Not covered: `first-call-start` (dials the owner's own number), SMS/RCS (registries here are call lists; separate decision `TODO(counsel)`).

## Rules (all strictest-by-default; per account via table `dnc_state_rules`)
* Residency confirmed (explicit state or address): national list (`US`) + that state's list. Area code only or unknown: **every** active list is checked.
* `applies_to_purposes` default `marketing, service`; `emergency` exempt unless a rule says otherwise. Unknown purpose = marketing.
* `require_active_list` + `max_age_days`: the call is held when no fresh list exists. Defaults: off / no limit. `TODO(counsel)`: which jurisdictions need them and the interval.
* A stale list is still used for membership. Account opt-outs (`dnc_suppressions`) always suppress.
* Modes: `STATE_DNC_GATE_MODE=shadow` (default: scrub + proof, never hold) or `enforce` (hold on match, on missing/stale required list, on lookup failure, on proof-write failure).

## Proof
One append-only row per scrub in `dnc_scrub_proofs`: salted SHA-256 of the number + last 4 digits (never the number), source, purpose, resolved state and basis,
decision, matched list ids, and for every relevant list its version, effective date, row count and content hash, plus `rules_version`. Retention: `TODO(owner)` / `TODO(counsel)` (not set in code).

## Operating it
1. Apply the migration; deploy `dnc-registry-import`; deploy the changed functions.
2. Import: `create_list` (jurisdiction `US` or `TX`...), `add_numbers` (<= 10 000 per call, same text can be retried), `activate`. A new activation supersedes the previous list of the same jurisdiction atomically.
3. Run in `shadow` for at least one cycle; query `dnc_scrub_proofs where would_block` to see what enforce would hold.
4. Set rules (`dnc_state_rules`) with counsel, then `STATE_DNC_GATE_MODE=enforce`.

## Open decisions
Registry operators and licence terms `TODO(owner)` - scrub frequency per state `TODO(counsel)` - purpose exemptions (existing-relationship, transactional) `TODO(counsel)` -
proof retention `TODO(counsel)` - UI for import and proofs (not built; API only) - whether SMS must also use these lists `TODO(counsel)`.
