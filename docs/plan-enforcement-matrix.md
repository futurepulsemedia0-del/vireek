# Plan enforcement matrix

> GENERATED FILE. Do not edit by hand.
> Regenerate: `UPDATE_PLAN_MATRIX=1 npx vitest run src/lib/planEnforcementMatrix.test.ts` (PowerShell: `$env:UPDATE_PLAN_MATRIX=1; npx vitest run src/lib/planEnforcementMatrix.test.ts`).
> CI fails when this file differs from what the tests compute.

A cell says **yes** only when the enforcement logic behaves correctly at its boundary (executed against the real functions) **and** production code actually reaches it. Correct-but-unwired logic is **no** with its gap id. `n/a` means the plan has no such limit or the limit does not apply by design.

Summary: 28 yes, 83 no (of which 2 conflicts between sources of truth), 33 n/a, 144 cells.

Sources of truth: `src/lib/pricing.ts`, `_shared/billing/planCatalog.ts`, `_shared/fraud/planLimits.ts`, `_shared/entitlements/*`, `src/lib/whiteLabel.ts`. Evidence: executed = real function run in Vitest; static = source/SQL text assertion.

## Plan x limit

| Limit | free | trial | starter | professional | business | enterprise |
| --- | --- | --- | --- | --- | --- | --- |
| Included minutes (catalog value, incl. bonus) | yes | n/a | yes | yes | yes | yes |
| Grandfathered minutes_included kept | n/a | n/a | yes | yes | yes | n/a |
| Minutes hard stop / paid never blocked | yes | yes | yes | yes | yes | yes |
| Overage policy (rate billed) | n/a | n/a | no (GAP-O1) | no (GAP-O1) | no (GAP-O1) | n/a |
| Seats | no (GAP-S1) | n/a | no (GAP-S1) | no (GAP-S1) | no (GAP-S1) | n/a |
| Locations | no (GAP-L1) | n/a | no (GAP-L1) | no (GAP-L1) | no (GAP-L1) | n/a |
| Phone numbers | no (GAP-N1) | no (GAP-N1) | no (GAP-N1) | no (GAP-N1) | no (GAP-N1) | no (GAP-N1) |
| Concurrent calls | no (GAP-C1) | no (GAP-C1) | no (GAP-C1) | no (GAP-C1) | no (GAP-C1) | no (GAP-C1) |
| SMS per month | no (GAP-M1) | no (GAP-M1) | no (GAP-M1) | no (GAP-M1) | no (GAP-M1) | no (GAP-M1) |
| Transcript retention days | no (GAP-R1) | n/a | no (GAP-R1) | no (GAP-R1) | no (GAP-R1) | no (GAP-R1) |
| Max call length | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) |
| Daily outbound calls | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) |
| Daily SMS | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) |
| Daily spend cap | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) |
| Lifetime spend cap | no (GAP-W1) | no (GAP-W1) | n/a | n/a | n/a | n/a |
| Outbound needs verification | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) | no (GAP-W1) |
| Voice clone | yes | yes | no (conflict, GAP-V1) | no (conflict, GAP-V1) | yes | yes |
| Feature: emergency detection & dispatch | no (GAP-F1) | n/a | no (GAP-F1) | n/a | n/a | n/a |
| Feature: CRM integrations | no (GAP-F1) | n/a | no (GAP-F1) | no (GAP-F1) | no (GAP-F1) | n/a |
| Feature: call recording | no (GAP-F1) | n/a | no (GAP-F1) | n/a | n/a | n/a |
| Feature: advanced analytics | no (GAP-F1) | n/a | no (GAP-F1) | no (GAP-F1) | n/a | n/a |
| Feature: API access | no (GAP-F1) | n/a | no (GAP-F1) | no (GAP-F1) | no (GAP-F1) | n/a |
| Feature: white label / custom domain | yes | n/a | yes | yes | yes | yes |
| Feature: SIEM streaming | yes | n/a | yes | yes | yes | yes |

## Expected values and evidence

| Limit | Plan | Expected | Observed | Evidence | Note |
| --- | --- | --- | --- | --- | --- |
| Included minutes (catalog value, incl. bonus) | free | 50 | 50 | static | pricing.ts = planCatalog.ts = planLimits.FREE_MINUTES; written to profiles.minutes_included by stripe-webhook and manage-subscription-plan. No bonus-minutes concept exists in code: included minutes are the catalog value. |
| Included minutes (catalog value, incl. bonus) | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Included minutes (catalog value, incl. bonus) | starter | 400 | 400 | static | pricing.ts = planCatalog.ts = planLimits.FREE_MINUTES; written to profiles.minutes_included by stripe-webhook and manage-subscription-plan. No bonus-minutes concept exists in code: included minutes are the catalog value. |
| Included minutes (catalog value, incl. bonus) | professional | 1500 | 1500 | static | pricing.ts = planCatalog.ts = planLimits.FREE_MINUTES; written to profiles.minutes_included by stripe-webhook and manage-subscription-plan. No bonus-minutes concept exists in code: included minutes are the catalog value. |
| Included minutes (catalog value, incl. bonus) | business | 4000 | 4000 | static | pricing.ts = planCatalog.ts = planLimits.FREE_MINUTES; written to profiles.minutes_included by stripe-webhook and manage-subscription-plan. No bonus-minutes concept exists in code: included minutes are the catalog value. |
| Included minutes (catalog value, incl. bonus) | enterprise | unlimited | unlimited | static | pricing.ts = planCatalog.ts = planLimits.FREE_MINUTES; written to profiles.minutes_included by stripe-webhook and manage-subscription-plan. No bonus-minutes concept exists in code: included minutes are the catalog value. |
| Grandfathered minutes_included kept | free | - | - | none | Free has no stored legacy allowance. |
| Grandfathered minutes_included kept | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Grandfathered minutes_included kept | starter | stored minutes_included survives plan sync | preserved | static | minutesToWriteOnSync() leaves minutes_included untouched unless the plan changes; inbound allowance and usage alerts read the stored value. |
| Grandfathered minutes_included kept | professional | stored minutes_included survives plan sync | preserved | static | minutesToWriteOnSync() leaves minutes_included untouched unless the plan changes; inbound allowance and usage alerts read the stored value. |
| Grandfathered minutes_included kept | business | stored minutes_included survives plan sync | preserved | static | minutesToWriteOnSync() leaves minutes_included untouched unless the plan changes; inbound allowance and usage alerts read the stored value. |
| Grandfathered minutes_included kept | enterprise | - | - | none | Enterprise is unlimited / negotiated. |
| Minutes hard stop / paid never blocked | free | stop at 50 min; forward to owner or play message | enforced | executed | exhaustedResponse() forwards via the emergency lane or plays a message and fails open; the count itself is SQL fraud_inbound_allowance(). |
| Minutes hard stop / paid never blocked | trial | never blocked (has a subscription) | allowed | static | fraud_inbound_allowance treats any account with stripe_subscription_id as paid. |
| Minutes hard stop / paid never blocked | starter | never blocked (overage billed) | allowed | static | Paid accounts are never stopped on inbound minutes; see the overage row. |
| Minutes hard stop / paid never blocked | professional | never blocked (overage billed) | allowed | static | Paid accounts are never stopped on inbound minutes; see the overage row. |
| Minutes hard stop / paid never blocked | business | never blocked (overage billed) | allowed | static | Paid accounts are never stopped on inbound minutes; see the overage row. |
| Minutes hard stop / paid never blocked | enterprise | never blocked (overage billed) | allowed | static | Paid accounts are never stopped on inbound minutes; see the overage row. |
| Overage policy (rate billed) | free | - | - | none | Free is hard-stopped instead of billed. |
| Overage policy (rate billed) | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Overage policy (rate billed) | starter | $0.20/min over 400 | display-only | static | No code in supabase/functions meters or invoices standard-plan overage (results-plan-bill does so for the results plan only). |
| Overage policy (rate billed) | professional | $0.15/min over 1500 | display-only | static | No code in supabase/functions meters or invoices standard-plan overage (results-plan-bill does so for the results plan only). |
| Overage policy (rate billed) | business | $0.12/min over 4000 | display-only | static | No code in supabase/functions meters or invoices standard-plan overage (results-plan-bill does so for the results plan only). |
| Overage policy (rate billed) | enterprise | - | - | none | Enterprise: SLA-backed, no metering. |
| Seats | free | 1 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Seats | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Seats | starter | 2 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Seats | professional | 5 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Seats | business | 15 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Seats | enterprise | unlimited | - | none | Unlimited on this plan. |
| Locations | free | 1 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Locations | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Locations | starter | 1 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Locations | professional | 1 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Locations | business | 3 | not enforced | static | Marketing copy in pricing.ts only; no server-side check found. |
| Locations | enterprise | unlimited | - | none | Unlimited on this plan. |
| Phone numbers | free | 1 | PLAN_LIMITS.maxNumbers is never read | static |  |
| Phone numbers | trial | 1 | PLAN_LIMITS.maxNumbers is never read | static | Stripe trial: guarded as FREE (GAP-T1). |
| Phone numbers | starter | 3 | PLAN_LIMITS.maxNumbers is never read | static |  |
| Phone numbers | professional | 10 | PLAN_LIMITS.maxNumbers is never read | static |  |
| Phone numbers | business | 50 | PLAN_LIMITS.maxNumbers is never read | static |  |
| Phone numbers | enterprise | 200 | PLAN_LIMITS.maxNumbers is never read | static |  |
| Concurrent calls | free | not defined | no limit exists | static | Neither pricing nor code defines a value. |
| Concurrent calls | trial | not defined | no limit exists | static | Neither pricing nor code defines a value. |
| Concurrent calls | starter | not defined | no limit exists | static | Neither pricing nor code defines a value. |
| Concurrent calls | professional | not defined | no limit exists | static | Neither pricing nor code defines a value. |
| Concurrent calls | business | not defined | no limit exists | static | Neither pricing nor code defines a value. |
| Concurrent calls | enterprise | not defined | no limit exists | static | Neither pricing nor code defines a value. |
| SMS per month | free | not defined | no limit exists | static | Only a daily SMS cap exists. |
| SMS per month | trial | not defined | no limit exists | static | Only a daily SMS cap exists. |
| SMS per month | starter | not defined | no limit exists | static | Only a daily SMS cap exists. |
| SMS per month | professional | not defined | no limit exists | static | Only a daily SMS cap exists. |
| SMS per month | business | not defined | no limit exists | static | Only a daily SMS cap exists. |
| SMS per month | enterprise | not defined | no limit exists | static | Only a daily SMS cap exists. |
| Transcript retention days | free | not specified | per-tenant policy rows, not the plan | static | Derived from the plan bullets in pricing.ts (inherited bullets included). |
| Transcript retention days | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Transcript retention days | starter | 7 days | per-tenant policy rows, not the plan | static | Derived from the plan bullets in pricing.ts (inherited bullets included). |
| Transcript retention days | professional | unlimited | per-tenant policy rows, not the plan | static | Derived from the plan bullets in pricing.ts (inherited bullets included). |
| Transcript retention days | business | unlimited | per-tenant policy rows, not the plan | static | Derived from the plan bullets in pricing.ts (inherited bullets included). |
| Transcript retention days | enterprise | unlimited | per-tenant policy rows, not the plan | static | Derived from the plan bullets in pricing.ts (inherited bullets included). |
| Max call length | free | 300 s | guard returns maxCallSeconds 300; guard not called by 13 sender(s) | executed |  |
| Max call length | trial | 300 s | guard returns maxCallSeconds 300; guard not called by 13 sender(s) | executed | Stripe trial: guarded as FREE (GAP-T1). |
| Max call length | starter | 900 s | guard returns maxCallSeconds 900; guard not called by 13 sender(s) | executed |  |
| Max call length | professional | 1200 s | guard returns maxCallSeconds 1200; guard not called by 13 sender(s) | executed |  |
| Max call length | business | 1800 s | guard returns maxCallSeconds 1800; guard not called by 13 sender(s) | executed |  |
| Max call length | enterprise | 3600 s | guard returns maxCallSeconds 3600; guard not called by 13 sender(s) | executed |  |
| Daily outbound calls | free | 10/day | call 10 allowed, 11 refused 429; guard not called by 13 sender(s) | executed |  |
| Daily outbound calls | trial | 10/day | call 10 allowed, 11 refused 429; guard not called by 13 sender(s) | executed | Stripe trial: guarded as FREE (GAP-T1). |
| Daily outbound calls | starter | 100/day | call 100 allowed, 101 refused 429; guard not called by 13 sender(s) | executed |  |
| Daily outbound calls | professional | 400/day | call 400 allowed, 401 refused 429; guard not called by 13 sender(s) | executed |  |
| Daily outbound calls | business | 1500/day | call 1500 allowed, 1501 refused 429; guard not called by 13 sender(s) | executed |  |
| Daily outbound calls | enterprise | 5000/day | call 5000 allowed, 5001 refused 429; guard not called by 13 sender(s) | executed |  |
| Daily SMS | free | 20/day | sms 20 allowed, 21 refused 429; guard not called by 3 sender(s) | executed |  |
| Daily SMS | trial | 20/day | sms 20 allowed, 21 refused 429; guard not called by 3 sender(s) | executed | Stripe trial: guarded as FREE (GAP-T1). |
| Daily SMS | starter | 200/day | sms 200 allowed, 201 refused 429; guard not called by 3 sender(s) | executed |  |
| Daily SMS | professional | 800/day | sms 800 allowed, 801 refused 429; guard not called by 3 sender(s) | executed |  |
| Daily SMS | business | 3000/day | sms 3000 allowed, 3001 refused 429; guard not called by 3 sender(s) | executed |  |
| Daily SMS | enterprise | 10000/day | sms 10000 allowed, 10001 refused 429; guard not called by 3 sender(s) | executed |  |
| Daily spend cap | free | 200 cents/day | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed |  |
| Daily spend cap | trial | 200 cents/day | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed | Stripe trial: guarded as FREE (GAP-T1). |
| Daily spend cap | starter | 1500 cents/day | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed |  |
| Daily spend cap | professional | 5000 cents/day | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed |  |
| Daily spend cap | business | 15000 cents/day | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed |  |
| Daily spend cap | enterprise | 50000 cents/day | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed |  |
| Lifetime spend cap | free | 500 cents lifetime | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed |  |
| Lifetime spend cap | trial | 500 cents lifetime | at cap allowed, 1 cent over refused 429; guard not called by 16 sender(s) | executed | Stripe trial: guarded as FREE (GAP-T1). |
| Lifetime spend cap | starter | none (paid) | never blocked | executed | By design paid plans have no lifetime cap. |
| Lifetime spend cap | professional | none (paid) | never blocked | executed | By design paid plans have no lifetime cap. |
| Lifetime spend cap | business | none (paid) | never blocked | executed | By design paid plans have no lifetime cap. |
| Lifetime spend cap | enterprise | none (paid) | never blocked | executed | By design paid plans have no lifetime cap. |
| Outbound needs verification | free | unverified -> blocked | unverified service + marketing refused 403; guard not called by 16 sender(s) | executed |  |
| Outbound needs verification | trial | unverified -> blocked | unverified service + marketing refused 403; guard not called by 16 sender(s) | executed | Stripe trial: guarded as FREE (GAP-T1). |
| Outbound needs verification | starter | unverified -> blocked | unverified service + marketing refused 403; guard not called by 16 sender(s) | executed |  |
| Outbound needs verification | professional | unverified -> blocked | unverified service + marketing refused 403; guard not called by 16 sender(s) | executed |  |
| Outbound needs verification | business | unverified -> blocked | unverified service + marketing refused 403; guard not called by 16 sender(s) | executed |  |
| Outbound needs verification | enterprise | unverified -> blocked | unverified service + marketing refused 403; guard not called by 16 sender(s) | executed |  |
| Voice clone | free | blocked (PLAN_NOT_ALLOWED) | guard blocks; voice-consent blocks; guard not called by clone-voice | executed | The consent step is the wired plan gate (static). |
| Voice clone | trial | blocked (PLAN_NOT_ALLOWED) | guard blocks; voice-consent blocks; guard not called by clone-voice | executed | The consent step is the wired plan gate (static). Stripe trial: guarded as FREE (GAP-T1). |
| Voice clone | starter | allowed | guard allows; voice-consent blocks; guard not called by clone-voice | executed | planLimits and voice-consent disagree. |
| Voice clone | professional | allowed | guard allows; voice-consent blocks; guard not called by clone-voice | executed | planLimits and voice-consent disagree. |
| Voice clone | business | allowed | guard allows; voice-consent allows; guard not called by clone-voice | executed | The consent step is the wired plan gate (static). |
| Voice clone | enterprise | allowed | guard allows; voice-consent allows; guard not called by clone-voice | executed | The consent step is the wired plan gate (static). |
| Feature: emergency detection & dispatch | free | not included | no server-side plan check | static | The emergency hand-off lane stays open on every plan by design; the gated part needs a product decision. |
| Feature: emergency detection & dispatch | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: emergency detection & dispatch | starter | not included | no server-side plan check | static | The emergency hand-off lane stays open on every plan by design; the gated part needs a product decision. |
| Feature: emergency detection & dispatch | professional | included | - | none | Included at full level; nothing to restrict. |
| Feature: emergency detection & dispatch | business | included | - | none | Included at full level; nothing to restrict. |
| Feature: emergency detection & dispatch | enterprise | included | - | none | Included at full level; nothing to restrict. |
| Feature: CRM integrations | free | not included | no server-side plan check | static |  |
| Feature: CRM integrations | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: CRM integrations | starter | 1 integration | no server-side plan check | static |  |
| Feature: CRM integrations | professional | 3 native | no server-side plan check | static |  |
| Feature: CRM integrations | business | 3 native | no server-side plan check | static |  |
| Feature: CRM integrations | enterprise | Unlimited + API | - | none | Included at full level; nothing to restrict. |
| Feature: call recording | free | not included | no server-side plan check | static |  |
| Feature: call recording | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: call recording | starter | not included | no server-side plan check | static |  |
| Feature: call recording | professional | included | - | none | Included at full level; nothing to restrict. |
| Feature: call recording | business | included | - | none | Included at full level; nothing to restrict. |
| Feature: call recording | enterprise | included | - | none | Included at full level; nothing to restrict. |
| Feature: advanced analytics | free | not included | no server-side plan check | static |  |
| Feature: advanced analytics | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: advanced analytics | starter | not included | no server-side plan check | static |  |
| Feature: advanced analytics | professional | Standard | no server-side plan check | static |  |
| Feature: advanced analytics | business | Advanced | - | none | Included at full level; nothing to restrict. |
| Feature: advanced analytics | enterprise | Advanced | - | none | Included at full level; nothing to restrict. |
| Feature: API access | free | not included | no server-side plan check | static |  |
| Feature: API access | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: API access | starter | not included | no server-side plan check | static |  |
| Feature: API access | professional | not included | no server-side plan check | static |  |
| Feature: API access | business | not included | no server-side plan check | static |  |
| Feature: API access | enterprise | included | - | none | Included at full level; nothing to restrict. |
| Feature: white label / custom domain | free | blocked | brand.ts blocks; verify-custom-domain blocks | executed | Server list = client list (src/lib/whiteLabel.ts) = custom-domain gate. |
| Feature: white label / custom domain | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: white label / custom domain | starter | blocked | brand.ts blocks; verify-custom-domain blocks | executed | Server list = client list (src/lib/whiteLabel.ts) = custom-domain gate. |
| Feature: white label / custom domain | professional | blocked | brand.ts blocks; verify-custom-domain blocks | executed | Server list = client list (src/lib/whiteLabel.ts) = custom-domain gate. |
| Feature: white label / custom domain | business | allowed | brand.ts allows; verify-custom-domain allows | executed | Server list = client list (src/lib/whiteLabel.ts) = custom-domain gate. |
| Feature: white label / custom domain | enterprise | allowed | brand.ts allows; verify-custom-domain allows | executed | Server list = client list (src/lib/whiteLabel.ts) = custom-domain gate. |
| Feature: SIEM streaming | free | blocked | siem-stream blocks | static |  |
| Feature: SIEM streaming | trial | - | - | none | A Stripe trial carries the purchased plan's catalog values; nothing separate to enforce. |
| Feature: SIEM streaming | starter | blocked | siem-stream blocks | static |  |
| Feature: SIEM streaming | professional | blocked | siem-stream blocks | static |  |
| Feature: SIEM streaming | business | allowed | siem-stream allows | static | Pricing lists audit logs under Enterprise only; confirm intent (PLAN-ENF-014). |
| Feature: SIEM streaming | enterprise | allowed | siem-stream allows | static |  |

## Cross-plan controls

| Control | Enforced | Evidence | Gap | Detail |
| --- | --- | --- | --- | --- |
| Emergency hand-off / dispatch (call + SMS, domestic and 911) never blocked, every plan, every scenario | yes | executed | - | 180 guard calls, 0 blocked. Own runaway ceiling 200/day per account; international targets still go through the destination policy. |
| Emergency messages through quiet hours | no (GAP-E4) | executed | GAP-E4 | Bypasses by default, but allowEmergencyOverride=false defers them. |
| Emergency SMS through sendCompliantSms (A2P / DNC / future guard) | no (GAP-E3) | static | GAP-E3 | Emergency paths use the raw deliver.ts sender today, which is why they are not blocked. |
| Shadow mode (enforce = false) on outbound: would-deny is logged, traffic allowed | yes | executed | - | Verified per plan with the daily-call cap exhausted. Reachable only once senders call the guard (GAP-W1). |
| Shadow mode on inbound (free-minute stop): enforce stops, log-only allows, errors fail open | yes | executed | - | evaluateInbound() follows fraud_settings.enforce; an unreadable allowance or context allows the call. |
| Module entitlements default to deny (edge + client) | yes | executed | - | Invalid ids, RPC errors, non-boolean answers, expired trials and missing rows all deny. |
| Plan -> module entitlement sync | no (GAP-E1) | static | GAP-E1 | Entitlements are granted manually by staff; two parallel entitlement systems exist. |

## Open gaps (ticket ids are placeholders: create them in your tracker)

| Gap | Ticket | Status | Effect | Smallest fix |
| --- | --- | --- | --- | --- |
| GAP-W1 guardOutbound() is not called by any customer-driven sender | PLAN-ENF-001 | OPEN | Daily call/SMS caps, spend caps, max call length, outbound verification, kill switches and the voice-clone gate are implemented and unit-correct, but production senders never invoke them. | Call guardOutbound() before each registered sender (purpose "emergency" for hand-offs and dispatch). Wire the shared choke points first: _shared/messaging/sendSms.ts, _shared/notify/deliver.ts, _shared/voice-engine/vapiEngine.ts, _shared/pbx/runtime.ts. |
| GAP-I1 Free-plan inbound minute hard stop is dead code | PLAN-ENF-002 | closed | checkInboundAllowance()/exhaustedResponse() are exported but nothing calls them; the vapi-webhook assistant-request handler does not stop a Free account whose minutes are used. | Call checkInboundAllowance() in the vapi-webhook assistant-request path and return exhaustedResponse() when allowed is false. |
| GAP-S1 Seat limits are display text only | PLAN-ENF-003 | OPEN | pricing.ts says "2 seats", "5 seats", "15 seats"; no invite / profile-creation path checks it. | Add a seat limit to a single plan-limits table and check it in the invite RPC (grandfather accounts already over the limit: block adds, never lock out). |
| GAP-L1 Location limits are display text only | PLAN-ENF-004 | OPEN | pricing.ts says "1 location" / "Up to 3 locations"; nothing enforces it. | Same table and grandfathering rule as seats, checked where a location is created. |
| GAP-N1 PLAN_LIMITS.maxNumbers is never read | PLAN-ENF-005 | OPEN | The per-plan phone-number cap exists as data only (src/lib/dynamicNumbers.ts has an unrelated pool limit). | Check it where numbers are purchased / assigned. |
| GAP-C1 No concurrent-call limit exists for any plan | PLAN-ENF-006 | OPEN | Neither pricing nor code defines one; concurrency is bounded only by the voice provider account. | Decide the per-plan value first (product decision), then enforce it in assistant-request. |
| GAP-M1 No monthly SMS limit exists | PLAN-ENF-007 | OPEN | Only dailySms exists (itself unwired, see GAP-W1). There is no per-month figure. | Decide the per-plan value, add it next to dailySms, enforce in guardOutbound(). |
| GAP-R1 Retention is per-tenant policy, not per plan | PLAN-ENF-008 | OPEN | pricing.ts promises 7-day transcript history on Starter and unlimited on Professional+; data-retention-sweep reads data_retention_policies rows and never looks at the plan. | Seed data_retention_policies from the plan on plan change, or have the sweep clamp to the plan value. |
| GAP-F1 dispatch / CRM / recording / analytics / API have no server-side plan check | PLAN-ENF-009 | OPEN | COMPARE_VALUES marks them plan-gated; no edge function checks the plan for them. Note: the emergency hand-off lane must stay ungated on every plan (guard.ts), so "dispatch" needs a product decision on what exactly is gated. | Express each as an entitlement module (GAP-E1) or a plan check at its entry point. |
| GAP-E1 Module entitlements are not derived from the plan | PLAN-ENF-010 | OPEN | Entitlements are granted manually by staff; the plan-sync job referenced in the migration does not exist. Two parallel systems also exist (account_module_entitlements via requireEntitlement, account_modules via requireModule). | Write source = "plan" rows from the Stripe webhook / plan change (never overwriting source = "override"), and converge on one system. |
| GAP-G1 Grandfathered minutes_included is overwritten by customer.subscription.updated | PLAN-ENF-011 | closed | The handler writes minutes_included = minutesForPlan(planId) on every subscription update, so an old-Starter account loses its stored allowance on the next card update / trial end / metadata change. | Only write minutes_included when profiles.plan actually changes (read the row first), or never write it from this event. |
| GAP-O1 Standard-plan overage is not metered or invoiced by code in this repo | PLAN-ENF-012 | OPEN | The $/min overage text is parsed for UI and cost analytics only; only results-plan-bill reports metered usage. Paid accounts are never blocked, so overage is either billed outside this repo or not billed at all. | Confirm where overage is invoiced; if nowhere, report minutes over minutes_included to a Stripe meter. |
| GAP-V1 Voice-clone eligibility is defined three different ways | PLAN-ENF-013 | OPEN | planLimits.allowVoiceClone: Starter and up. voice-consent CLONE_PLANS: Business and Enterprise. pricing.ts: "Custom-trained voice model" listed under Enterprise. Starter and Professional are blocked in practice, contradicting planLimits. | Pick one rule, put it in one module, and import it in voice-consent, guard.ts and pricing. |
| GAP-P1 SIEM streaming is allowed on Business, pricing says Enterprise | PLAN-ENF-014 | OPEN | SIEM_PLANS = business + enterprise; pricing.ts lists "Audit logs & advanced access controls" under Enterprise only. | Decide the intended plan, then align SIEM_PLANS or pricing.ts. |
| GAP-E3 sendCompliantSms has no emergency lane | PLAN-ENF-015 | OPEN | The A2P approval and DNC checks run before any purpose is examined, so an emergency / dispatch text routed through it can be refused. Emergency paths today use the raw notify/deliver.ts sender, which is why they are not blocked. | When the guard is added to sendCompliantSms, keep purpose "emergency" ahead of the A2P / DNC / plan checks, as guardOutbound() does. |
| GAP-E4 Owner setting can defer emergency messages | PLAN-ENF-016 | OPEN | With quiet hours enabled and allowEmergencyOverride = false, an emergency message inside the quiet window is deferred, not sent. | Ignore allowEmergencyOverride for purpose "emergency", or force it on in the settings validator. |
| GAP-T1 Trialing accounts get Free caps from the fraud guard | PLAN-ENF-017 | OPEN | fraud_guard_context returns the paid plan only for subscription_status active or past_due; "trialing" falls back to free. Pricing advertises a 14-day trial of the paid plan. | Product decision: keep (anti-farming) and say so on the pricing page, or include trialing. |

## Sender coverage (customer-driven outbound)

| File (supabase/functions/) | Channel | Calls the guard | Gap |
| --- | --- | --- | --- |
| _shared/messaging/sendSms.ts | sms | yes | - |
| _shared/notify/deliver.ts | sms | no | GAP-W1 |
| _shared/voice-resilience/adapters.ts | sms | no | GAP-W1 |
| _shared/richMessaging/sinch.ts | sms | no | GAP-W1 |
| _shared/voice-engine/vapiEngine.ts | call | no | GAP-W1 |
| outbound-dialer/index.ts | call | yes | - |
| first-call-start/index.ts | call | no | GAP-W1 |
| workflow-engine-executor/index.ts | call | no | GAP-W1 |
| followup-agent-dispatcher/index.ts | call | no | GAP-W1 |
| _shared/speed-to-lead/runtime.ts | call | no | GAP-W1 |
| csr-call-transfer/index.ts | call | no | GAP-W1 |
| live-call-control/index.ts | call | no | GAP-W1 |
| interpreter/index.ts | call | no | GAP-W1 |
| voice-studio-test-call/index.ts | call | no | GAP-W1 |
| dialer-call/index.ts | call | no | GAP-W1 |
| proxy-call-bridge/index.ts | call | no | GAP-W1 |
| browser-extension/index.ts | call | no | GAP-W1 |
| _shared/pbx/runtime.ts | call | no | GAP-W1 |
| clone-voice/index.ts | clone | no | GAP-W1 |

### Exempt (with reason)

| File | Reason |
| --- | --- |
| _shared/agent-run/twilioLookup.ts | Read-only GET on the Messages list (delivery lookup). Sends nothing. |
| _shared/pci/twilio.ts | Updates or reads an ALREADY ACTIVE call (pause recording, recordings list). Creates no call and no message. |
| _shared/pbx/twilio.ts | Generic Twilio REST helper and TwiML utilities. It sends nothing itself; each twilioApi("Calls.json") caller is registered individually. |
| _shared/audit/script.ts | Pure payload builder for the audit call. The POST lives in _shared/audit/providers.ts. |
| _shared/audit/providers.ts | Missed-call audit funnel: separate product surface with its own phone policy and OTP controls in _shared/audit, not metered against a plan. Needs an owner decision (PLAN-ENF-018) on whether it should ever count against spend caps. |
| _shared/ovb/runtime.ts | Open Voice Benchmark: platform-owned benchmark calls run by cron or staff, not customer-driven. |
| synthetic-probe/index.ts | Platform synthetic monitoring: Vireek dials its own target through the real AI path; probe faults are excluded from SLOs. Not customer-driven. |
