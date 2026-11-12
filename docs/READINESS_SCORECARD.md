# Readiness scorecard — 2026-11-12

> **Assumption to confirm:** the "8 criteria" are not defined anywhere in the repo or in the audit request, so these eight are my choice. If you have a canonical list, tell me and I will re-map the evidence.
> **Method:** scores 0–10 from what was executed offline or read statically on this snapshot. Test suites (tsc, vitest, pgTAP, Playwright) were **NOT RUN**, so no criterion that depends on them can score above 6. Scores are deliberately conservative. "external" = needs proof outside the code.

| # | Criterion | Score | Basis |
|---|---|---:|---|
| 1 | Security (authn/z, secrets, webhooks) | 4 | Large, deliberate security tooling exists, but it currently reports failures |
| 2 | Data integrity & migrations | 4 | 768 migrations, but duplicates and malformed names |
| 3 | Product completeness & surface control | 3 | Wide surface, freeze not in code |
| 4 | Verification (tests/CI) | 5 (unverified) | Many tests exist; none run in this audit |
| 5 | Supply chain & CI hardening | 4 | Lockfile good; Actions unpinned; owners inert |
| 6 | Governance & AI safety | 4 | Governance scripts exist and flag 8 + 27 gaps |
| 7 | Compliance & honest claims | 3 | One marketing claim contradicts the register; certifications external |
| 8 | Operational readiness | 3 (external) | Runbooks exist; no evidence of drills, pilots, on-call |

## 1. Security — 4/10
**Evidence:** `npm run security:check` → 288 violations (webhook-no-replay 30, service-role-unscoped 29, plain-secret-compare 22, fail-open-secret 12, no-auth 8, webhook-no-signature 3) + 480 functions without a `function-policy.json` entry; `verify-jwt:check` → 133 problems; `check:agent-governance` → 8 ✗. Positive: `scripts/check-fail-open-secrets.mjs`, `docs/security/THREAT_MODEL.md`, `docs/security/function-matrix.md` exist.
**Remains:** fix the 12 fail-open and 3 no-signature functions first; add replay protection; declare policies; sync `config.toml` verify_jwt; pen test (external).

## 2. Data integrity & migrations — 4/10
**Evidence:** `lint:migrations` → 129 duplicate versions, literal file `supabase/migrations/<timestamp>_daily_briefing.sql`, stray file `split`; `migrations:check` → non-canonical names (`20260915_phone_numbers.sql`, `20260916_job_cost_entries.sql`). 80 pgTAP files exist (not run).
**Remains:** resolve duplicates with `scripts/migrations-dedupe.mjs plan` on a **non-production** rehearsal (`migration-rehearsal.yml`); run `supabase test db`.

## 3. Product completeness & surface control — 3/10
**Evidence:** `docs/product-surface.md` claims a flag-based freeze, but 13 of 32 files of `product-surface-freeze.patch` are absent (`src/lib/productSurface.ts`, `supabase/functions/_shared/surfaceGate.ts`, freeze migrations …). 635 page modules, 599 routed; only 46 page tests (doc, unverified). `surface:check` → 21 nav routes unclassified.
**Remains:** apply or drop the freeze; classify the 21 routes; regenerate the doc from a working generator.

## 4. Verification — 5/10 (unverified)
**Evidence:** static counts only: 860 + 276 test files, 80 pgTAP, 47 e2e entries. `lint:design` script had a syntax error (so it could not have been green in CI); `docs:surface:check` does not exist although the doc says CI runs it — **CI wiring is doubtful**. 
**Remains:** `npm ci` then run everything; report exact counts.

## 5. Supply chain & CI hardening — 4/10
**Evidence:** `package-lock.json` v3, 779 pkgs, all with integrity, none off-registry (good); `.github/dependabot.yml` covers npm + Actions (good); **0/102 Actions pinned by SHA**; 9/21 workflows lack top-level `permissions:`; `licenses:check`, `owners:check`, `registers:check` point at missing scripts; `.github/CODEOWNERS` has 41 `@OWNER_*` placeholders; `npm audit` not run.
**Remains:** pin by SHA (Dependabot can then bump them), add `permissions: contents: read` at top of each workflow, restore or remove the missing scripts, set real owners and enable required code-owner review.

## 6. Governance & AI safety — 4/10
**Evidence:** `check:direct-llm` → 27 functions bypass the router; `check:agent-governance` → 8 ungoverned sms/payment functions (e.g. `lifecycle-touch-tick`, `results-plan-enroll`). Positive: `eval/`, `vitest.redteam.config.ts`, `kill-switch-drill.yml`, `ai-regression.yml` exist (results not verified).
**Remains:** route the 27 through the shared AI core; add `authorizeAgentAction` or documented exemptions to the 8; run the red-team suite.

## 7. Compliance & honest claims — 3/10
**Evidence:** `claims:check` fails: `src/components/sections/SecurityPrivacy.tsx:29` says "End-to-End Encryption" while `src/lib/trust/claims.ts` (`security.e2e-encryption`) records `not_held`. 39 broken doc links. No SOC 2 / ISO evidence in the repo — **external**.
**Remains:** change the copy; fix the links; SOC 2 audit, pen test report, DPAs and legal review are **external**.

## 8. Operational readiness — 3/10 (external)
**Evidence:** `RUNBOOK.md`, `VOICE_RUNBOOK.md`, `docs/security/voice-incident-response.md`, k6 and DB-perf workflows exist. Nothing proves they were exercised.
**Remains:** real drills, monitoring/alert ownership, pilot customers, on-call assignment — **external**.

**Overall: not release-ready.** Do not describe any item as production-ready until `NEEDS_HUMAN.md` steps 1–3 are done and the suites are green.
