# Per-state contact rules (calling hours, frequency caps, recording consent)

Status: **DRAFT, engineering record for counsel review. Not legal advice.** Closes gap 3 of
`speed-to-lead-assumptions.md`. Every value below is **[COUNSEL][VERIFY]**: it comes from this repo's own
unverified starter material (`compliance-rules/seedRules.ts`, `compliance/recordingProfiles.ts`, assumption A6),
not from a reviewed reading of any statute.

## Where things live

| What | File |
|------|------|
| The table (all values tagged `[COUNSEL][VERIFY]`, with a `basis`) | `supabase/functions/_shared/contact-rules/table.ts` |
| Residency resolver (defaults to strictest) | `.../contact-rules/resolve.ts` |
| Pure decision logic (hours, 24 h cap, recording) | `.../contact-rules/evaluate.ts` |
| DB side: residency/timezone lookup, atomic cap reservation, audit | `.../contact-rules/gate.ts` |
| Storage + atomic reserve function | `supabase/migrations/20290307000000_state_contact_rules.sql` |
| Tests | `.../contact-rules/contactRules.test.ts`, `.../speed-to-lead/core.test.ts` |

To change a value: edit `table.ts`, bump `CONTACT_RULES_VERSION`, and have counsel review the diff. Nothing is
"approved" in code; the tests fail if a value loses its tags or claims approval.

## How a decision is made

1. **Residency** (`resolveResidency`). A state is *confirmed* only from an explicit state field or the state in an
   address, and only if no other signal disagrees. An area code is a presumption, never a confirmation (numbers port,
   people move). Address vs. area code, or explicit vs. address, that disagree = *conflict*. Nothing / phone only /
   conflict resolves to the **nationwide strictest profile**.
2. **Effective rules.** A confirmed state uses its own row; a field with no reviewed value (`null`) inherits the
   strictest value. The strictest profile is *derived from the table* (day-by-day intersection of the federal bound and
   every state window; minimum cap; all-party recording), so an edit propagates automatically.
3. **Hours** are checked in the recipient's local timezone. A dial may not *start* in the last 5 minutes of a window
   (assumption A7 is still open; `CALL_END_MARGIN_MIN`).
4. **24 h cap** counts reservations of all automated calls to one number across `outbound-dialer`,
   `followup-agent-dispatcher` and `speed-to-lead`, via `contact_rules_reserve_call()` (advisory lock = no race between
   workers). This is stricter than A6, which counted only speed-to-lead calls.
5. **Recording consent.** All-party states and every low-confidence residency get the consent script in the assistant's
   `recording_consent_context` variable. Confirmed one-party states get an empty string.
6. **Purposes.** Hours and the cap apply to `marketing` (and any unknown purpose). `service` and `emergency` skip them
   but keep the recording rule. [COUNSEL: confirm that appointment reminders are not solicitation.]

The state rules are **additive**: they run after the account quiet-hours gate and alongside the speed-to-lead window and
never relax either.

## Enforcement points (fail closed)

| Place | What happens |
|-------|--------------|
| `speed-to-lead-intake` (`recordIntake`) | Residency is resolved from the form (`state`, `region`, `province`, `state_code`, `address`) and stored on the request (`contact_state` only when confirmed). If the lead arrives outside state hours it is queued for the window opening instead of being dialed. |
| `speed-to-lead` dial path | `decideDial` defers on `STATE_HOURS`, `STATE_CAP_24H` or `STATE_RULES_UNAVAILABLE` (missing verdict = defer). Right before the provider call, `gateContactDial` re-checks hours and reserves atomically. |
| `outbound-dialer` | Same gate after the fraud guard and immediately before `startCall`. A hold re-schedules the row without using an attempt. |
| `followup-agent-dispatcher` | Hours pre-check (no reservation) before the coordination claim; full gate + reservation inside `runCallStep` and `placeVapiCall`. |

Any lookup failure (customer, timezone, ledger, RPC, malformed result) is a 2-minute defer with reason
`STATE_RULES_UNAVAILABLE`, never an allow. A reservation is released only when the provider *definitively* refused the
call; on a timeout or unknown outcome it is kept (the safe direction).

## Known gaps / questions for counsel

* Only CA, FL, OK, MD and TX carry hours; only FL, OK, MD carry a cap (A6). **WA hours are deliberately `null`**
  because A6 mentions WA without stating them. Every other state uses the strictest profile for hours and cap.
* Recording mode for non-listed states is `one_party` only as the *complement* of the starter all-party list: an
  inference, not a finding. Counsel should confirm or flip each state.
* The area-code table covers 16 states (`compliance-rules/jurisdiction.ts`). Outside it a number is simply "unknown",
  which resolves to strictest. Canadian (+1) numbers are not modeled (A11).
* When the recipient timezone is only the business timezone fallback, the window is evaluated in that timezone. A
  recipient in an earlier timezone could be called slightly early. [COUNSEL]
* Holidays and Sunday restrictions of individual states are not modeled.
* The `contact_rule_events` retention period is undecided; rows are small and hashed, but counsel should set one.
* Calls placed outside these three dialers (e.g. other voice flows) are not counted by the ledger. [VERIFY]
* A resolved state cannot loosen the account quiet hours or the speed-to-lead window, by design.
