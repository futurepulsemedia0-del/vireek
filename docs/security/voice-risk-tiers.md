# Voice agent: risk tiers, step-up and callback

Status: engineering record, **not legal advice**. What may be done by voice at all is a business/legal decision **[COUNSEL]**.

## What already existed (reused, not duplicated)
`supabase/functions/_shared/voice-security/` already provides: a per-tool least-privilege catalog (`toolPolicy.ts`),
step-up = known details + SMS one-time code to the number **on file** (`stepUp.ts`, `verifyTools.ts`), confirm-before-write,
rate limits, kill switch, anomaly lock, output filtering and a hash-chained audit table (`voice_security_audit`).
Address / contact / access changes, refunds and password/MFA resets are `voice_never` (always refused on voice).

## What this change adds (the gaps)
1. **Config-driven action classes** (`riskTiers.ts`): `info`, `intake`, `account_read`, `reschedule`, `address_change`,
   `payment` (+ `safety`, never configurable). Defaults reproduce today's behaviour.
2. **Tighten-only overrides.** `VOICE_RISK_TIERS_JSON` (edge-function env) can raise the required proof, remove step-up
   methods, or disable a class. Any attempt to relax a default is ignored and logged; unknown keys / classes / methods reject
   the whole document and the defaults stay in force.
3. **Callback step-up.** New tool `request_callback`: files a request (`voice_callback_requests`) for a human to call the
   customer back on the number on file. It never unlocks anything in the current call and answers identically whether or not
   an account exists.
4. **Every decision audited.** Every refusal was already audited; allows are now audited for every class
   (`auditAllows`, default `all`), and a fail-closed `security_unavailable` refusal is audited best-effort.
5. **Red-team cases** `tier-*` / `ok-tier-*` in `eval/voice-redteam/scenarios.ts` (11 scenarios).

## Example override
```json
{ "classes": { "payment": { "methods": ["callback"] }, "reschedule": { "disabled": true }, "account_read": { "below": "refuse" } } }
```
`payment` becomes callback-only (refused in-call even after OTP), `reschedule` is switched off, unverified `account_read`
stops returning minimal data.

## Not done / limits
* The callback is a **human task**, not an automated outbound verification call. There is no UI for the queue yet
  (read via SQL / RLS-scoped select; closing uses `voice_callback_mark_done`).
* There is no handler for `update_address`; it stays `voice_never`. Allowing it later needs a handler, a design review and counsel.
* Per-tenant (database) overrides are not implemented; the config is per deployment (env).
* The red-team harness proves the **controls** under a fully manipulated model; it does not test a live LLM, ASR or telephony spoofing.
