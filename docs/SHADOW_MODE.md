# Shadow Mode — 7-day risk-free trial

Sarah observes real calls and **never speaks or acts**. She produces a *Shadow Card* per call and a Day-7
Proof-of-Value report. All money figures are labelled **"Estimate — not realized revenue"** and never reach ROI dashboards.

## What is implemented
| Area | Files |
|---|---|
| Migration (5 tables, RLS, 11 functions) | `supabase/migrations/20280410000000_shadow_mode.sql` |
| Pure rules (consent, estimate, redaction, pipeline, readiness) | `supabase/functions/_shared/shadow/logic.ts` |
| DB runtime (replay, finalise) | `supabase/functions/_shared/shadow/runtime.ts` |
| Report payload + HTML + PDF | `supabase/functions/_shared/shadow/report.ts` |
| Edge functions | `shadow-replay`, `shadow-report`, `shadow-digest` |
| UI + client | `src/pages/ShadowModePage.tsx`, `src/lib/shadowMode.ts`, `src/lib/shadowEnv.ts`, `src/i18n/shadowModeNamespace.ts` |
| Tests | `_shared/shadow/{logic,report,isolation}.test.ts` |
| Small edits to existing files | `compliance/recordingConsent.ts` (new export appended), `App.tsx` (route), `DashboardNav.tsx` (nav + Eye import) |

**Mode A (Replay) only.** Mode B (live-listen) is **not implemented**: no one-way audio fork exists in the telephony code
(`_shared/pbx/twilio.ts`, `pbx-voice`, `_shared/pbx/runtime.ts` contain no stream/fork). The consent gate for live-listen is
implemented and tested for when it exists; the DB restricts `mode` to `'replay'`.

## Deploy order
1. Rename the migration timestamp if you already have a newer migration, then `supabase db push`.
2. `supabase secrets set SHADOW_CRON_SECRET=<long random>` (RESEND_API_KEY / SITE_URL already exist).
3. `supabase functions deploy shadow-replay shadow-report shadow-digest` (JWT verification stays ON for all three).
4. Schedule (Supabase dashboard → Edge Functions → Schedules), sending `Authorization: Bearer <anon key>` and `x-shadow-cron-secret`:
   - `shadow-replay` every 10 min (replays, finalises expired trials, purges expired data)
   - `shadow-digest` hourly (day 1 / 3 / 7 emails)
5. Deploy the frontend.

## Acceptance criteria → verification
| # | Criterion | Verification |
|---|---|---|
| 1 | Sarah never acts/speaks in shadow | `logic.test.ts` (Proxy ports throw on any non-`analyze` access; all actions `executed:false`), `isolation.test.ts` (no messaging/telephony imports; only `shadow_*` tables written), DB CHECK `shadow_cards_actions_never_executed` |
| 2 | Replay is deterministic / idempotent | determinism test; unique `idempotency_key`; upsert `ignoreDuplicates` |
| 3 | Estimates transparent, capped, labelled | estimate tests (cap, range, null ticket, clamp), report tests |
| 4 | Consent gating | consent tests (attestation, disclosure, staff, fork, all-party/unknown fail-closed); blocked calls store no transcript |
| 5 | PII redaction, 30-day retention, delete-on-request | redaction/retention tests; `purge_after`; `shadow_purge_expired()`; `shadow_delete_data()` |
| 6 | Tenant isolation | RLS select policies on `get_account_owner_id()`; composite FKs; SELECT-only grants (static test) |
| 7 | Owner Approve/Correct, no silent training | `shadow_submit_review` → *pending* proposal → owner `accept` → explicit `apply` to `business_profile.faqs` |
| 8 | Report HTML + PDF, readiness, mistakes | `report.test.ts` |
| 9 | Not in ROI dashboards | `isolation.test.ts` scans ROI sources; shadow tables are separate |
| 10 | Go-live checklist | `shadow_go_live` requires all 4 items; records decision only (changes no telephony) |

## Rollback
```sql
-- Destructive: removes ALL Shadow Mode data.
DROP TABLE public.shadow_events, public.shadow_reports, public.shadow_reviews, public.shadow_cards, public.shadow_trials CASCADE;
DROP FUNCTION public.shadow_assert_editor(), public.shadow_start_trial(text),
  public.shadow_update_settings(uuid, text, boolean, boolean, boolean, integer, integer, numeric),
  public.shadow_set_setup_item(uuid, text, boolean), public.shadow_submit_review(uuid, text, text, text, text, text, text),
  public.shadow_decide_proposal(uuid, boolean), public.shadow_apply_faq(uuid), public.shadow_trial_stats(uuid),
  public.shadow_delete_data(uuid), public.shadow_go_live(uuid), public.shadow_purge_expired();
```
Then remove the three functions, the route and nav entry. Nothing else in the app depends on these objects.

## Assumptions (unverified — please check)
1. `calls`, `pbx_calls`, `pbx_voicemails`, `business_profile` column names were read from migrations in the ZIP; the ZIP may be older than your local repo.
2. `business_profile.avg_job_value` is dollars; used only if the owner sets no override.
3. `get_account_owner_id()`, `can_edit_call_scripts()`, `set_updated_at()` exist as in the ZIP.
4. `askVireekAi({ task: 'general', jsonMode: true, … })` returns `{ text }` (as used by `call-script-simulate`).
5. Calls rows not mirrored from `pbx_calls` are treated as human-handled; `duration_seconds` 0/null ⇒ missed. `pbx_calls.status='ai_handled'` is skipped.
6. No plan/entitlement gate is wired (no verified plan-gating code was found). Gate the nav/route/functions to your trial policy.
7. Time zone is captured from the owner's browser at start (no verified business time-zone column). The live path's `isAfterHoursAt` uses UTC; Shadow Mode uses the business zone.
8. Close rate default 25% (matches Value Scoreboard); capped at 50%. Estimate = captured × close rate × ticket, range ×0.6–1.4 close rate and ×0.8–1.2 ticket.
9. Your ZIP's `ai-core/types.ts` and `DashboardNav.tsx` contain syntax/duplicate-import problems (a `;` inside the `TaskType` union; duplicate `PlugZap` imports). They are not caused by this feature; verify they are fixed in your local copy.

## Needs YOUR legal / telephony decisions
- **Consent law**: all-party-consent states (the area-code heuristic is a default, not a legal opinion), caller disclosure wording, staff-monitoring notices (incl. works-council / employee rules), AI-disclosure statutes, GDPR/CCPA roles (you are processor/service provider?).
- **Who may attest** that recording + AI analysis is lawful (currently any editor-role user; consider owner-only).
- **Names are not redacted** (no NER). Card/phone/email/SSN/street addresses are. Decide whether names in `analysis.crm_entry` are acceptable.
- **Retention**: default 30 days, 1–90 allowed; confirm regulated-industry limits.
- **Subprocessors**: transcripts (redacted) go to the AI provider via `askVireekAi`; update DPA/subprocessor list.
- **Telephony**: whether/when to build a one-way audio fork for live-listen (Twilio Media Streams / Vapi listen URL), and per-jurisdiction consent for it. `counsel_cleared_states` and `telephony_supports_fork` are platform-set only.
- **Plan/entitlement** policy for who gets the trial and whether re-trials are allowed (currently one per account, ever).

## Manual verification checklist
- [ ] Migration applies cleanly; `select shadow_start_trial('America/Chicago')` works as an owner and fails as a non-editor.
- [ ] As a different tenant, `select * from shadow_cards` returns nothing from other accounts.
- [ ] Attempt `update shadow_trials set ends_at = …` as `authenticated` → permission denied.
- [ ] Without attestation, "Refresh" is disabled; with it, cards appear for recent calls/voicemails.
- [ ] Place a missed after-hours test call with a transcript → card shows *would have captured*; no SMS/booking/dial occurred.
- [ ] Review a card as Bad with an FAQ proposal → appears pending → Accept → Add to FAQs → appears in Business Profile FAQs.
- [ ] Report HTML opens, PDF downloads, both show the estimate label; Spanish locale renders.
- [ ] Day-7 tick finalises the trial; digests arrive once each on days 1/3/7.
- [ ] Delete data → cards/reviews/report gone, trial cancelled, audit event remains.
- [ ] ROI dashboards / Money Recovered show no shadow figures.
