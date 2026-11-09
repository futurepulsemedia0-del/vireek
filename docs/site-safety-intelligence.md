# Site Safety Intelligence

Native lone-worker safety for technicians, driven by facts from calls and job history.

## What it is — and is not
- It alerts **your own team** (dispatcher, the technician's emergency contact, a company-defined next step).
- It does **not** contact emergency services and never replaces calling them. Every escalation text, the
  technician app and the manager console say so. Do not market it as an emergency-services integration.

## Components
| Piece | Where |
|---|---|
| Decision logic (tier, timers, SMS parsing, fairness screen, region limits) | `src/lib/safety/core.ts` (pure, shared by browser + Deno, unit tested) |
| Tables, RLS, RPCs, triggers, storage policies | `supabase/migrations/20281201000000_site_safety_intelligence.sql` |
| Brief, add fact, ack | `supabase/functions/safety-api` |
| Timers, escalation, all-clear, decline notices, purge, weekly fairness screen | `supabase/functions/safety-tick` + `_shared/safety/*` |
| Facts from calls | `_shared/safety/callFacts.ts`, called from `vapi-webhook` |
| SMS fallback | `safety_checkin_by_sms`, called from `sms-webhook` |
| Technician UI | `SiteSafetyBriefCard`, `LoneWorkerPanel`, `DuressButton`, `DeclineSheet`, `IncidentReportForm`, `/tech/safety` |
| Manager UI | `/dashboard/site-safety` |

## Fairness rules (enforced in code, not just policy)
1. Facts attach to an **exact address key** only. No neighborhood, area, crime or demographic data exists in the schema.
2. Facts are event-, behavior- or self-reported, each with **source, date and expiry**.
3. Fact text is linted for protected-attribute and area-profiling language in TypeScript **and** by a database trigger.
4. Machine-read facts start as `pending_review` and **never** lift a job to the highest tier until a person confirms them.
5. Customer-facing notes need: confirmed + legal review approved + appeal contact + review date (CHECK constraint).
6. Weekly screen (`runFairnessAudit`): area flag-rate ratio, flag concentration, human overturn rate of machine facts.
   It uses no demographic data, so it **cannot prove** absence of bias. Findings go to a human review queue; consider an
   independent audit that joins demographic data under your counsel's guidance.
7. Declining/rescheduling unsafe work has **no penalty**; a test blocks any scoring/retention/commission code from reading it.

## Privacy and labor
- Region profiles (`standard`, `strict_eu`, `custom`) set maximum location retention and visibility. They are **configurable
  defaults, not legal advice**; confirm local labor, works-council and privacy requirements with counsel.
- Location is stored only while a session runs, only with monitoring consent **and** the technician's own opt-in **and** the
  existing `location_tracking_gate`. Withdrawing consent deletes stored points. Points expire after the retention period.
- Material changes (turning location on, longer retention, wider visibility, region change) bump the notice version and
  require every technician to agree again.

## Deploy order
1. Apply the migration. 2. Deploy `safety-api` and `safety-tick`, and re-deploy `vapi-webhook` and `sms-webhook`.
3. Set `CRON_SECRET` (and the existing Twilio secrets). 4. Schedule the two cron jobs (SQL at the bottom of the migration).
5. In the console: pick a region profile, set the dispatcher phone, review precautions, turn it on.

## Needs physical-device testing (not verifiable in CI)
- Long-press duress button with gloves/wet screen; keyboard + TalkBack/VoiceOver confirm path.
- Voice check-in (`SpeechRecognition`) per OS/browser/language; background behavior when the app is suspended.
- Battery impact of the 60 s heartbeat + location fix; Android battery-optimization / iOS background limits.
- Location permission flows (denied, approximate-only, revoked mid-job); airplane mode; low-signal `sms:` fallback link.
- Real Twilio delivery of escalation SMS, replies to `OK <code>` / `HELP`, carrier filtering, A2P status.
- Push-style prompts are **not** implemented (prompts are in-app and SMS).

## Known limits
- Call-fact extraction is deterministic and **English only**; other languages produce no facts (never wrong facts).
- Equipment-derived hazards are not wired (no structured hazard field exists in equipment data).
- No public customer appeal page yet; the appeal contact is shown to managers for use in customer communications.
- The inbound SMS webhook has no Twilio signature check today; the per-session one-time code limits spoofed "OK"s,
  a spoofed "HELP" can only cause a false alarm.
- Drill and false-alarm management: drills notify only the dispatcher; false alarms are counted; no automatic tuning.
