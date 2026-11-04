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

Scripts under `scripts/` not exposed through npm (run with `node scripts/<file>`): see `scripts/README.md`.
