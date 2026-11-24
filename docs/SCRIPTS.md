# npm scripts reference

Run from the repo root. "CI" = run by a workflow in `.github/workflows` (verify in the workflow file; this table is maintained by hand).

| Script | What it does | When to run |
|---|---|---|
| `dev` | Vite dev server | daily development |
| `build` | RSS + Vite build + SEO build + prerender | release / CI |
| `build:app` | Vite build only (no RSS/SEO) | quick build check |
| `preview` | Serve the built app | after `build` |
| `test` | Vitest unit tests | before every commit; CI |
| `test:watch` | Vitest watch mode | while coding |
| `storybook` | Component catalogue dev server (port 6006); see `docs/design/STORYBOOK.md` | when building or reviewing UI primitives |
| `build-storybook` | Static Storybook build into `storybook-static/` | before publishing the catalogue |
| `typecheck:storybook` | `tsc` over `.storybook` (stories + config) | after editing stories |
| `mutation:money` | Stryker mutation run on `regionConfig/money.ts` (pilot, no gate) | manual; see `docs/testing/mutation.md` |
| `mutation:compliance` | Stryker mutation run on the compliance-rules engine (pilot, no gate) | manual |
| `mutation:scoring` | Stryker mutation run on `fragilityScore.ts` (pilot, no gate) | manual |
| `mutation:summary` | Print a score table from a Stryker `mutation.json` | after a mutation run |
| `test:scripts:mutation` | Unit tests for the mutation summary script | when editing it |
| `test:built` | Tests against the built output (`vitest.built.config.ts`) | after `build` |
| `test:live` | Live/integration tests (`vitest.live.config.ts`) — needs real endpoints/secrets | manual, staging only |
| `test:e2e` | Playwright suites in `e2e/` | before release; CI (authenticated specs need `E2E_*` secrets) |
| `test:e2e:home` | Playwright `e2e/homepage.spec.ts` only | homepage changes |
| `lint` | ESLint | before every commit; CI |
| `typecheck` | `tsc --noEmit -p tsconfig.app.json` | before every commit; CI |
| `format` / `format:check` | Prettier write / check | before commit |
| `lint:design` | Design-system checks | UI changes |
| `lint:colors` | Colour-token checks | UI changes |
| `tokens:build` | Rebuild colour tokens | after editing token sources |
| `codemod:colors` | One-off colour codemod | rarely; review diff |
| `lint:locale` | Detect raw (untranslated) strings | i18n changes |
| `lint:voice` | Brand voice checks | copy changes |
| `i18n:keys` | Report missing i18n keys across locales (`ar consent de en es fa fr hi ja trust zh`) | adding strings |
| `lint:migrations` | Migration lint (additive-only, destructive SQL) | every new migration; CI |
| `migrations:check` | Unique-version check | every new migration; CI |
| `migrations:plan` | Plan for resolving duplicate versions | when repairing history (see `docs/runbooks/migration-version-repair.md`) |
| `report:board-pack` | Monthly board pack (markdown) from existing SQL views; missing data shown as "not available". Needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; `--dry-run` needs none. See `docs/finance/board-pack-template.md` | monthly, after month end |
| `test:scripts:board-pack` | Tests for the board pack generator (no database) | changes to the generator |
| `finance:resilience` | Runway scenarios + revenue concentration (customer, processor) from a JSON file you fill in; offline, one currency per file. See `docs/finance/resilience.md` | monthly, with the board pack |
| `test:scripts:resilience` | Tests for the resilience model (no database) | changes to the model |
| `test:scripts:fx-exposure` | Static checks of the currency-exposure migration and its pgTAP plan (no database; behaviour is covered by `supabase test db`) | changes to `20290307000000_currency_exposure_views.sql` |
| `report:market-entry` | Market-entry readiness per regional pack from `config/global/market-entry.json` + code facts. No network. `--strict` exits 3 while not ready. See `docs/global/market-entry.md` | before a regional launch |
| `lint:market-entry` | Validates the market-entry checklist (evidence, COUNSEL/VERIFY rules) | changes to the checklist |
| `test:scripts:market-entry` | Tests for the market-entry report | changes to the report |
| `payments-einvoicing:check` | Validates `config/global/payments-einvoicing.json` and that `docs/global/payments-einvoicing.md` is in sync (exit 2 invalid, 4 drift) | CI, changes to the matrix |
| `payments-einvoicing:report` | Which regions/rows are complete and what is missing; `--strict` exits 3 while a gated pack is incomplete | before clearing a region for billing |
| `payments-einvoicing:write` | Regenerates the table in the doc from the JSON | after editing the matrix |
| `payments-einvoicing:hash` | sha256 of a pack's rows, required by `staff_set_billing_region_clearance` | when clearing a pack |
| `test:scripts:payments-einvoicing` | Tests for the matrix, the gate semantics and the migration wiring | changes to the matrix tooling |
| `product:trace` | Strategy-to-roadmap trace: flags shipped routes/functions with no linked goal and goals with no shipped work (`docs/product/okrs.json`). `--check` = fail on structural errors, `--strict` = also fail on orphans/placeholders. See `docs/product/okrs.md` | after editing okrs.json; optional CI |
| `test:scripts:product` | Tests for the trace script (no database, no network) | changes to the script |
| `db:audit` | DB hygiene check vs `scripts/db-audit.baseline.json` | after migrations; CI (`db-perf.yml`) |
| `openapi:generate` / `openapi:check` | Regenerate / verify `public/openapi.json` | API changes |
| `check:bundle` | Bundle-size budget | before release |
| `check:assets` | Asset budget (`scripts/perf-budgets.json`) | before release |
| `check:pwa` | PWA manifest/icons check | brand/PWA changes |
| `docs:inventory` | Generate docs inventory | docs maintenance |
| `sitemap:locations` / `sitemap:help` | Generate sitemaps | content changes |
| `brand:assets` / `brand:screenshots` / `brand:gallery` | Brand asset pipeline | brand changes |
| `native:assets` | Generate native icons/splash | mobile asset changes |
| `mobile:preflight` | Pre-release mobile checks | before a `mobile-v*` tag |
| `mobile:privacy` | Verify store privacy map matches code | before store submission |
| `cap:sync` / `cap:ios` / `cap:android` | Build + `cap sync` / open Xcode / Android Studio | native work |
| `build:home` / `cap:home` | Build / sync the "Vireek Home" app variant | Home app work |
| `cli:build` / `cli:typecheck` | Build / typecheck `packages/cli` | CLI changes |
| `ai-governance:inventory` / `ai-governance:check` | Regenerate / verify `docs/ai-governance/ai-system-register.md` (every AI call site must be registered; policy: `docs/ai-governance/ai-policy.md`) | after adding or removing any AI use; check runs in CI |

Scripts under `scripts/` not exposed through npm (run with `node scripts/<file>`): see `scripts/README.md`.
