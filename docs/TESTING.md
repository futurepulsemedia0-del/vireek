# Test strategy

| Layer | Tool / location | Run locally | CI workflow |
|---|---|---|---|
| Unit / component | Vitest, `src/**/*.test.ts(x)` | `npm test` | `ci.yml` |
| Built-output tests | `vitest.built.config.ts` | `npm run build && npm run test:built` | `ci.yml` (verify) |
| Live tests | `vitest.live.config.ts` | `npm run test:live` (needs real services) | manual |
| E2E / a11y / visual / perf | Playwright, `e2e/` (see `e2e/README.md`) | `npm run test:e2e` | `ci.yml` |
| Edge function checks | Deno typecheck/tests | see `RUNBOOK.md` §2.3 | `edge-functions.yml` |
| Database (pgTAP) | `supabase/tests/` (see its README) | `supabase test db` | `database-tests.yml` |
| DB performance & hygiene | `scripts/db-audit.mjs`, `supabase/ops/` | `npm run db:audit` | `db-perf.yml` |
| Migrations | `scripts/lint-migrations.mjs`, `migrations-dedupe.mjs` | `npm run lint:migrations && npm run migrations:check` | `migrations.yml` |
| Load / soak | k6, `load/k6/` | see `load/README.md` | `k6-load.yml` (manual dispatch) |
| AI regression | `eval/*.json`, edge `ai-eval-run` | see workflow | `ai-regression.yml` (daily 06:00 UTC + manual) |
| Brand audit | `scripts/brand-audit` | — | `brand-audit.yml` (PR, daily 03:00 UTC, release) |
| Security | gitleaks (`.gitleaks.toml`), dependency checks | — | `security.yml`, `dependabot.yml` |
| Quality gates | bundle/asset/design budgets | `npm run check:bundle` etc. | `quality-gates.yml` |
| Preview smoke | deployed preview | — | `vercel-preview-smoke.yml` |
| Mobile | build/sign | `docs/MOBILE_RELEASE.md` | `mobile.yml`, `play-rollout.yml` |

## Required secrets (names only)
E2E: `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD` (not passed in `ci.yml` today → authenticated specs are skipped, RUNBOOK §8 #4); also referenced in code: `E2E_MEMBER_EMAIL`, `E2E_MEMBER_PASSWORD`. AI regression: `AI_REGRESSION_TEST_USER_JWT`, `AI_REGRESSION_DEFAULT_SUITE_ID`. Edge deploy: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `EDGE_DEPLOY_ENABLED`. Preview: `VERCEL_AUTOMATION_BYPASS_SECRET`.

## Quality gates
- Coverage thresholds are configured in `vite.config.ts` (`coverage` block; comment there says to ratchet upward).
- Known gaps: authenticated E2E skipped in CI; `lint:design` documented as a CI check but not in `ci.yml` (RUNBOOK §8 #9).

## Minimum bar for a PR
`npm run lint && npm run typecheck && npm test`, plus the suite closest to the change (E2E for UI flows, pgTAP for RLS/migrations, `ai-regression` for prompt changes). Tenant-isolation and authorization tests are required for any new table or data-access path.
