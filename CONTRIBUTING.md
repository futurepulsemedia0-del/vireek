# Contributing to Vireek

How to set up, change and ship code safely. Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [ENVIRONMENT.md](ENVIRONMENT.md) · [RUNBOOK.md](RUNBOOK.md) · [docs/LOCAL_SEED.md](docs/LOCAL_SEED.md)

Vireek is a production system with paying customers. **Preserve existing behaviour; make the smallest correct change.**
The binding rules live in [`.github/copilot-instructions.md`](.github/copilot-instructions.md) (written for AI assistants, equally valid for humans) — the essentials are below.

## 1. Setup

Requirements: Node 20 (CI uses 20), npm, a Supabase project (dev/staging — **never production**), optionally Deno (edge-function typecheck) and the Supabase CLI.

```bash
npm ci                      # exact lockfile install (CI does the same)
cp .env.example .env        # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (see ENVIRONMENT.md)
npm run dev                 # Vite dev server
```

Seed realistic demo data: [docs/LOCAL_SEED.md](docs/LOCAL_SEED.md). Secrets/vars for edge functions: [ENVIRONMENT.md](ENVIRONMENT.md).

## 2. Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `preview` | Dev server / production build / serve the build (port 4173 used by E2E & Lighthouse) |
| `npm run lint` | ESLint (typescript-eslint + react-hooks) |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` (covers `src/`) |
| `npm run test` | Vitest, jsdom, once (setup: `src/test/setup.ts`); `test:watch` for watch mode |
| `npm run test -- --coverage` | Coverage with thresholds from `vite.config.ts` (CI runs this) |
| `npm run test:e2e` | Playwright (builds + previews automatically). Authenticated specs need `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` for a **staging** account, otherwise they skip |
| `npm run test:live` | `*.live.test.ts` against real services (excluded from the default run) |
| `npm run lint:design` | Design-system checks (see §5) |
| `npm run format` / `format:check` | Prettier |
| `npm run lint:migrations` | Migration lint (§6) |
| `npm run check:bundle` | Bundle budget (run after `build`) |
| `npm run docs:inventory` | Regenerate `docs/generated/*` (tables, functions, env usage) |

**Before every PR run, at minimum:** `npm run lint && npm run typecheck && npm run test && npm run build`
(+ `npm run lint:design` if you touched UI, + `deno check supabase/functions/<name>/index.ts` if you touched a function).
Never claim a check passed if you did not run it — say what could not be verified.

## 3. Code conventions

- **Formatting:** Prettier — single quotes, semicolons, trailing commas `all`, print width 100, 2 spaces, LF (`.prettierrc.json`). `supabase/functions/**/*.ts` is excluded from Prettier (`.prettierignore`).
- **TypeScript + React 18**, function components, path alias `@/` → `src/`.
- **Where code goes** (details in ARCHITECTURE §2):
  - route → `src/pages/<Name>Page.tsx` + a **lazy** `<Route>` in `src/App.tsx` (wrapped in the right guard: `ProtectedRoute`, `StaffRoute`, `TechnicianRoute`, `PartnerRoute`);
  - shared UI → `src/components/` (primitives in `components/ui/`);
  - domain logic → `src/lib/<domain>.ts` (types + pure functions, with `<domain>.test.ts`), I/O → `src/lib/<domain>Api.ts`.
- **Tenancy:** use the *account owner id* (`isOwner ? profile?.id : teamMember?.account_owner_id`), never `user.id`, for `user_id` filters and realtime.
- **Supabase:** one client (`@/lib/supabase`); never import `@supabase/supabase-js` elsewhere in the frontend; never ship a service-role key to the browser.
- **Realtime:** use `useRealtimeSubscription` with a unique `channelName` and an owner-id filter (ARCHITECTURE §5).
- **i18n:** user-visible strings in marketing/shared components go through `useTranslation()`; locale files live in `src/locales/<lng>/common.json` (9 languages).
- **Errors:** handled errors worth tracking → `captureError` (`@/lib/sentry`); no `console.log`, `@ts-ignore`, `dangerouslySetInnerHTML`, `window.alert/confirm` (use `ConfirmDialog`).
- **Secrets:** never in code, migrations, tests or screenshots. Public values only in `VITE_*`.
- **Dependencies:** don't add or upgrade packages unless required for the change; Dependabot handles routine bumps weekly (grouped).

## 4. Tests

- Unit tests are colocated (`*.test.ts[x]`), Vitest + Testing Library (jsdom). Put pure logic in `lib/` so it can be tested without React.
- E2E specs in `e2e/` (Playwright, Chromium). Keep them independent of production data.
- Bug fix → add a failing test first when practical.
- Coverage thresholds are a **ratchet** (`COV_*` env, defaults in `vite.config.ts`): raise them when coverage improves; never lower them to make a PR pass.
- Edge-function shared code with tests (e.g. `_shared/ai-core/guardrails.test.ts`) is picked up by Vitest too; keep such tests free of Deno-only APIs.

## 5. Design system

`npm run lint:design` (`scripts/check-design-system.mjs`) enforces five rules over `src/`:
1. no local `inputClass` — use `<Input>/<Textarea>` from `@/components/ui/Input`;
2. no hand-copied card classes — use `<Card>` (`@/components/ui/Card`);
3. no hand-copied primary-button classes — use `<Button variant="primary">` (`@/components/ui/Button`);
4. full-view loading states use the `Skeleton` family (`@/components/Skeleton`), not a bare `Loader2`;
5. "No X found/yet" copy goes inside `<EmptyState>` (`@/components/EmptyState`).

Use semantic colour tokens (`bg-bg-*`, `text-*`, `border`, `accent`, …) so dark mode works; don't hard-code colours. Do not change visuals, copy, routes or workflows as a side effect of a fix.

## 6. Database & edge functions

- **Migrations:** additive and idempotent; unique 14-digit timestamp; RLS on every tenant table with `user_id = public.get_account_owner_id()`; no secrets; destructive SQL needs
  `-- lint:allow-destructive <reason>` and a reviewer's explicit OK. Full rules: [RUNBOOK §3](RUNBOOK.md). Never edit or rename an already-applied migration.
- **Edge functions:** `supabase/functions/<name>/index.ts`; put a header comment with purpose, auth model, required secrets and the **exact deploy command** (incl. `--no-verify-jwt` when needed). Shared code in `_shared/`.
  Validate input, authenticate the caller from the JWT (never trust ids from the body), keep CORS consistent with neighbouring functions, never log secrets or PII.
  New secrets → add them to [ENVIRONMENT.md](ENVIRONMENT.md) in the same PR.
- **Public/unauthenticated endpoints** need rate limiting (pattern: `demo_chat_rate_limit`, `site_assistant_rate_limit`).

## 7. Branches, commits, pull requests

- Work on a dedicated branch off `main`; **no force-push, no history rewriting**, no unrelated changes in the PR.
- Commit messages: short imperative summary (Dependabot uses `chore(deps)` / `chore(ci)` prefixes — match that style for chores).
- PR description must state (from `copilot-instructions.md` §25): confirmed problem · root cause · files changed · exact fix · tests executed and results · regression risks · anything not verified.
- CI must be green. Required checks: *Lint, Typecheck, Unit Tests, Build*; *E2E (Playwright)*; *npm audit*; *CodeQL*; *Secret scanning*; *Migration lint*; *Bundle-size budget*; *Lighthouse CI*; *Typecheck (deno check)* when functions change.
- Touching auth, RLS, billing, webhooks, secrets or migrations → request a second reviewer.
- If a fix seems to require deleting/renaming/moving files, changing routes, or changing DB structure: **stop and ask** first.

## 8. Documentation

Update the relevant doc in the same PR: new env var/secret → `ENVIRONMENT.md`; new function/table domain/realtime table → `ARCHITECTURE.md` (and `npm run docs:inventory`);
new operational step or failure mode → `RUNBOOK.md`.
