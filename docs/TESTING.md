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
E2E: `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD` (passed to the `e2e` job in `ci.yml`; CI fails if missing — see below); optional seed secrets `E2E_SEED_SUPABASE_URL`, `E2E_SEED_SERVICE_ROLE_KEY`, `E2E_SEED_CONFIRM_PROJECT_REF`; also referenced in code (not wired in CI): `E2E_MEMBER_EMAIL`, `E2E_MEMBER_PASSWORD`. AI regression: `AI_REGRESSION_TEST_USER_JWT`, `AI_REGRESSION_DEFAULT_SUITE_ID`. Edge deploy: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `EDGE_DEPLOY_ENABLED`. Preview: `VERCEL_AUTOMATION_BYPASS_SECRET`.

## Quality gates
- Coverage thresholds are configured in `vite.config.ts` (`coverage` block; comment there says to ratchet upward).
- `lint:design` runs in CI as a **ratchet** (`npm run lint:design:ci`): `npm run lint:design` still lists all existing debt (exit 1), CI fails only when a (rule, file) pair has more violations than `scripts/design/design-baseline.json` (and `radius-baseline.json`) allows. After cleaning up, lower the baseline with `npm run lint:design:ratchet` and commit it. Never raise it by hand.
- Helper-script tests (`npm run test:scripts:ci`, Node's built-in runner) run in CI.
- Known gaps: `E2E_MEMBER_*`, `E2E_STAFF_*`, `E2E_OWNER_*`, `E2E_TECH_*` specs are not wired in CI and still skip there.

## Authenticated E2E in CI
Specs that log in skip themselves when `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` are unset. The `e2e` job therefore:
1. **Preflight** (`scripts/e2e/preflight.mjs`) fails the job if either secret is empty.
2. Optionally **seeds** the account (`scripts/e2e/seed-test-account.mjs`) when the secret `E2E_SEED_SERVICE_ROLE_KEY` exists.
3. Runs Playwright with the JSON reporter, then **`scripts/e2e/assert-no-auth-skips.mjs`** fails the job if any test was skipped because of those credentials.
Fork PRs cannot read secrets, so there (`E2E_REQUIRE_AUTH=0`) both checks only warn.

**One-time setup**
1. Use a dedicated E2E/staging Supabase project — never production.
2. Pick an email starting with `e2e` (e.g. `e2e+ci@yourdomain.com`) and a password of 12+ characters.
3. In GitHub → Settings → Secrets and variables → Actions add: `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`, and (to auto-seed) `E2E_SEED_SUPABASE_URL`, `E2E_SEED_SERVICE_ROLE_KEY`, `E2E_SEED_CONFIRM_PROJECT_REF` (the subdomain of the URL, a guard against seeding the wrong project). The `VITE_SUPABASE_*` secrets must point at the same project.
4. Seed locally or let CI do it: `E2E_SEED_SUPABASE_URL=… E2E_SEED_SERVICE_ROLE_KEY=… E2E_SEED_CONFIRM_PROJECT_REF=… E2E_TEST_EMAIL=… E2E_TEST_PASSWORD=… npm run e2e:seed`. It is idempotent: creates the user (or resets its password), completes onboarding on the profile, and ensures one customer exists.
5. Rotate the password by changing the two secrets; the next seeded run applies it.

## Minimum bar for a PR
`npm run lint && npm run typecheck && npm test`, plus the suite closest to the change (E2E for UI flows, pgTAP for RLS/migrations, `ai-regression` for prompt changes). Tenant-isolation and authorization tests are required for any new table or data-access path.
