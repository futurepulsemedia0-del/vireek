# Developer guide

## Setup from zero
1. Node 20 (`.nvmrc`), npm; Supabase CLI; optionally Deno (edge typecheck).
2. `npm ci`; copy `.env.example` → `.env` and fill **dev** values only (never production).
3. Local DB: `supabase start`; seed per `docs/LOCAL_SEED.md` (dev only).
4. `npm run dev`. Before a PR: `npm run lint && npm run typecheck && npm test`.
Troubleshooting: missing env → see `docs/generated/ENV_USAGE.md`; migration order errors → `docs/runbooks/migration-version-repair.md`; `esbuild` not found when running generate-rss/ingest scripts → `npm i -D esbuild` (known gap).

## Conventions
Branches: `feat/…`, `fix/…`, `docs/…`. Commits: imperative, one logical change. PRs use `.github/pull_request_template.md`. Code style: ESLint + Prettier (`npm run format`). Add a `CHANGELOG.md` line per PR.

## How to add…
- **A page:** create `src/pages/XPage.tsx`; register the lazy import and `<Route>` in `src/App.tsx`; pick the guard (`ProtectedRoute` for `/dashboard/*`, `StaffRoute` for `/staff/*`, …); add nav entry if needed; add a test; regenerate `docs/ROUTES.md` with `python3 scripts/docs/gen-routes.py`.
- **An edge function:** `supabase/functions/<name>/index.ts` with a header comment (purpose, auth model, inputs/outputs, deploy command); decide `verify_jwt` and record it in `supabase/config.toml` if `false`; public endpoints must verify a signature/secret and be idempotent; add env vars to `ENVIRONMENT.md`; deploy per RUNBOOK §2.3.
- **A migration:** `supabase/migrations/<14-digit UTC timestamp>_snake_case.sql`, additive, unique version; run `npm run lint:migrations && npm run migrations:check`.
- **A table with RLS:** `create table`, `alter table … enable row level security`, policies using `user_id = public.get_account_owner_id()` (or a narrower rule), `comment on table`, indexes on policy columns, and a pgTAP test in `supabase/tests/database/` covering own-tenant success and cross-tenant denial.
- **An i18n string:** add the key to every locale in `src/locales/<lang>/` (`ar consent de en es fa fr hi ja trust zh` dirs/files); `npm run i18n:keys`, `npm run lint:locale`.
- **An integration:** doc in `docs/integrations/<provider>.md` (keys, scopes, webhooks, sandbox vs prod); secrets in Supabase secrets; webhook entry in `docs/generated/WEBHOOKS.md`; sub-processor list update (Vendor policy).
- **A feature flag:** see `docs/ENVIRONMENTS_AND_RELEASES.md`.

## Regenerating catalogs
`docs/generated/*` and `docs/ROUTES.md` were produced by static scans of the repo; re-run whenever functions, migrations, routes or env vars change. Run `python3 scripts/docs/gen-catalogs.py` and `python3 scripts/docs/gen-routes.py` from the repo root (Python 3, no dependencies).
