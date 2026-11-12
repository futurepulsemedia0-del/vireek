# Proof-of-value machinery — audit report (phase 1+2)

## Verified (ZIP only; the live repo may differ)
- Shadow mode exists (migration 20280410000000_shadow_mode.sql, _shared/shadow/*, 3 edge functions, ShadowModePage). Replay only; live-listen not implemented.
- Eval gate exists: scripts/vertical-eval.mjs, job `vertical-ai-eval` in quality-gates.yml (push + PR). Executed here: exit 0.
- `npm run claims:check` FAILED in the ZIP (SecurityPrivacy.tsx:29 "End-to-End Encryption" vs claim `security.e2e-encryption` = not_held).
- calls.answer_ms is never populated -> answer speed is "No data".

## Changed
- eval/vertical-ai/cases.scenario.json (31 gated scenarios), eval/vertical-ai/known-gaps/gaps.json (7, not gated)
- supabase/functions/_shared/vertical-ai/emergencyRules.ts (accent folding, Spanish + roofing emergency rules)
- supabase/migrations/20290304000000_pilot_scorecard_and_call_feedback_loop.sql
- src/lib/pilotScorecard.ts (+ .test.ts), src/lib/pilotScorecardApi.ts
- src/pages/WeeklyScorecardPage.tsx, src/components/WrongCallButton.tsx
- scripts/eval/export-feedback-cases.mjs, supabase/tests/database/pilot_scorecard.test.sql

## Results
- vertical-eval.mjs: PASSED (263 cases, recall 1.0, handoff 1.0). Node assertions mirroring pilotScorecard.test.ts: PASSED.
- NOT RUN: tsc, vitest, eslint, playwright, pgTAP, the migration, any SQL.

## Not done
- Self-serve shadow-mode onboarding + e2e; scorecard e2e; scheduled weekly generation/email; server-side PDF (page uses browser print).
- Errors metric (no verified signal). Per-tenant "previously missed" baseline (does not exist in the DB).
- Roofing ontology/prices; Spanish routine intents (see gaps.json). Arrival-time promise guard not verified.
- claims-register.json is empty and is a second registry next to src/lib/trust/claims.ts; a full marketing-copy sweep was not done.

## Needs human
Apply migration (you run db push), review Spanish rules with a native speaker, decide consent/retention wording with counsel, label feedback drafts, decide on gaps.json items.
