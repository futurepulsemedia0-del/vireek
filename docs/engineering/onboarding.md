# Engineering onboarding: the first week

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. It describes how the repository works today. It makes no compliance claim and sets no policy; access and training rules belong to `docs/compliance/policies/onboarding-offboarding.md` and `docs/compliance/policies/security-training.md` (both drafts). Tags: **[VERIFY]** not confirmed on a clean machine · **[COUNSEL]** legal or contractual question.

Every `npm run` script, `node` file and repository path in this page was checked against `package.json` and the file tree by script on 2026-11-20. That proves the command exists. It does **not** prove it passes on your machine; the exit codes below say what to do when it does not.

**Who this is for:** an engineer who has just joined and has a buddy (someone who has been here a while and answers questions in the first two weeks). The buddy is named by the manager before day 1.

**The three rules that matter most.** They are repeated in [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md):

1. Vireek is a production system with paying customers. Make the smallest correct change and keep existing behaviour.
2. Use a dev or staging Supabase project. Never point your `.env` at production.
3. Never say a check passed if you did not run it. Say what you could not verify.

---

## Before day 1 (manager and buddy)

- [ ] Accounts and access requested. The list of systems is in the draft onboarding policy (GitHub, Vercel, Supabase, Stripe, Twilio, Vapi, Firebase, shared secrets). Give the new person only what week 1 needs: GitHub, a **dev** Supabase project, and the password manager. Production dashboards come later, with a reason.
- [ ] A dev Supabase project exists for them (or they will run the local stack on day 3).
- [ ] Buddy named, and a first small task chosen (see day 5).
- [ ] Nobody sends secrets in chat or e-mail. Secrets go through the password manager; the names of the secrets are in [`ENVIRONMENT.md`](../../ENVIRONMENT.md).

---

## Day 1 — Get it running and read the map

**Setup**

```bash
node --version                 # CI runs Node 20 (.github/workflows/ci.yml)
npm ci                         # exact lockfile install, as CI does
cp .env.example .env           # then fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY with DEV values
npm run dev                    # Vite dev server
```

- `.nvmrc` says `22` while CI and `CONTRIBUTING.md` say `20`. Use 20 until the team settles it. **[VERIFY]**
- `npm ci` is expected to fail until decision D-1 in [`docs/governance/DECISIONS_NEEDED.md`](../governance/DECISIONS_NEEDED.md) is resolved (the lockfile is out of sync with `package.json`). If it fails, tell your buddy and write down the error. Do **not** run `npm install` to "fix" it and do not commit `package-lock.json` changes during onboarding.
- Copy `.env.example`, never `.env` from someone else's machine. Only `VITE_*` values may be public; everything else is a secret and never goes into code, migrations, tests or screenshots.

**Read (about two hours, in this order)**

1. [`CONTRIBUTING.md`](../../CONTRIBUTING.md): setup, commands, conventions, tests, migrations.
2. [`ARCHITECTURE.md`](../../ARCHITECTURE.md) sections 1–3: system overview, frontend layers, tenancy and RLS. Section 2.2 says imports go downward only.
3. [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md): the bug-fix and production-safety rules. They are written for AI assistants and apply to people equally.
4. [`RUNBOOK.md`](../../RUNBOOK.md) sections 0, 1 and 8: where systems live, the release checklist, and the known issues.
5. [`docs/GLOSSARY.md`](../GLOSSARY.md) when a term is new.

**End of day:** the app loads in the browser, or you have written down exactly where setup stopped.

---

## Day 2 — Establish your baseline

Run the four checks CONTRIBUTING asks for before every PR, **before you change anything**:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Add `npm run format:check` if you want the Prettier view too.

- Write down what is red on a clean checkout. That list is your baseline; a red check you did not cause is not yours to fix in your first PR. Tell your buddy instead.
- `npm run test` runs Vitest once (jsdom). `npm run test:watch` is the watch mode. `npm run test -- --coverage` adds the coverage thresholds that CI enforces; they only go up, never down.
- `npm run test:e2e` runs Playwright. Authenticated specs need `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` for a **staging** account and are skipped otherwise (`docs/TESTING.md`). CI does not pass them today, so those specs are skipped there too.
- `npm run storybook` starts Storybook on port 6006.

**Read:** [`docs/TESTING.md`](../TESTING.md), and open `vite.config.ts` to see the test and coverage settings.

---

## Day 3 — Data, tenancy and migrations

Vireek is multi-tenant. Almost every bug that matters here is a tenant-isolation bug, so spend today on it.

**Read:** `ARCHITECTURE.md` section 3.1 (tenancy and RLS), then `CONTRIBUTING.md` section 3 ("Tenancy"):

- Filter by the **account owner id** (`isOwner ? profile?.id : teamMember?.account_owner_id`), never by `user.id`, for `user_id` filters and realtime channels.
- In SQL, policies use `public.get_account_owner_id()` or a narrower rule, and every new table has RLS enabled.
- Edge functions never trust an account id sent by the client.

**Local database (optional if you were given a dev project).** These use the Supabase CLI, which is an external tool and is not installed by `npm ci`:

```bash
supabase start -x studio,imgproxy,inbucket,edge-runtime,logflare,vector   # same flags as CI
supabase test db                                                          # pgTAP: every file in supabase/tests/database/
supabase stop --no-backup
```

`supabase start` may abort on a clean checkout because the migration baseline does not replay from scratch yet; `.github/workflows/database-tests.yml` explains why and keeps that job non-blocking. If it aborts for you, that is the known state, not your mistake. **[VERIFY]**

Seed data for a dev project is described in [`docs/LOCAL_SEED.md`](../LOCAL_SEED.md). Read its warning first: one seed is a migration that creates a known-password demo user, so it must never reach production.

**Migrations** (read-only exercise today; do not push anything):

```bash
npm run lint:migrations        # naming, destructive statements, RLS on new tables, rollback note
npm run migrations:check       # duplicate / irregular versions
```

Open one recent migration with a table in it, for example `supabase/migrations/20290305000100_legal_requests.sql`, and one pgTAP test, `supabase/tests/database/legal_requests.test.sql`. Notice how the migration states what it adds, who can read it, and how to roll it back, and how the test proves own-tenant success and cross-tenant denial.

---

## Day 4 — The guardrails and when each one applies

The repository has many checks. You do not run all of them every time; run the ones that match what you touched.

| You changed | Run | What it guards |
|---|---|---|
| Any TypeScript or React | `npm run lint`, `npm run typecheck`, `npm run test` | Basic correctness |
| UI (pages, components, styles) | `npm run lint:design`, `npm run lint:colors`, `npm run lint:motion` | Design-system, colour-token and motion rules |
| User-visible text | `npm run i18n:keys`, `npm run lint:locale` | Every string has a key in every locale; RTL (`ar`, `fa`) still reads correctly |
| A route, nav item or page label | `npm run surface:check` | Product-surface manifest and naming |
| Public marketing or trust copy | `npm run claims:check` | No public claim without evidence |
| A migration | `npm run lint:migrations`, `npm run migrations:check`, `supabase test db` | Safe, forward-only schema changes with tenant tests |
| An edge function | `npm run security:check`, `npm run check:direct-llm`, `deno check supabase/functions/<name>/index.ts` | Declared auth and tenant checks, no direct model calls, types (Deno is external) |
| Any AI or model use | `npm run ai-governance:check`, `npm run check:agent-governance` | Registered models and guarded agent actions |
| Docs | `npm run docs:links` | Broken links |
| Generated catalogs (functions, routes, env) | `npm run docs:catalogs` | Rebuilds `docs/generated/*`; `-- --check` fails if stale |
| A new third-party provider | `npm run vendor-exit:check`, `npm run vendor-review:check` | An exit page and a vendor-review register row exist for it |

Some of these may already be red on a clean checkout. Compare with your day-2 baseline before you assume you broke something.

**Also read today**

- [`.github/pull_request_template.md`](../../.github/pull_request_template.md): the risk checklist you will fill in on every PR (security, privacy, migrations, i18n, accessibility, dependencies, architecture, changelog, claims, AI).
- [`docs/security/function-policy.json`](../security/function-policy.json) and `docs/security/function-matrix.md`: how every edge function declares its auth model.
- `src/lib/subprocessors.ts`: the single source of truth for the public sub-processor list. Adding a vendor is not only a code change; see `docs/compliance/policies/vendor-management.md`.

---

## Day 5 — Your first pull request

Pick something small that your buddy confirms is safe: a failing-test fix, a docs correction, a missing test for an existing pure function in `src/lib/`. No schema changes, no auth changes, no dependency changes in the first PR.

1. Branch: `feat/…`, `fix/…` or `docs/…`.
2. Make the change. If it is a bug fix, write the failing test first when you can.
3. Run the four checks from day 2 plus the row in the day-4 table that matches your change. Say in the PR which ones you ran and which you could not.
4. Add a line under `[Unreleased]` in [`CHANGELOG.md`](../../CHANGELOG.md), or use the `no-changelog` label.
5. Open the PR with the template. Fill **What I did NOT verify** honestly; an empty box is worse than a short one.
6. A teammate reviews. Read their comments as the main learning of the week.

---

## By the end of week 1 you should be able to

- [ ] Run the app against a dev backend and say where each part of a request goes (browser → Supabase → edge function).
- [ ] Explain the account owner id and why `user.id` is the wrong filter.
- [ ] Say which checks apply to a UI change, a migration and an edge function.
- [ ] Find the pgTAP tests for a table and read one.
- [ ] Open the runbook and find the incident triage steps (`RUNBOOK.md` section 6) and the incident runbook (`docs/runbooks/incident-response.md`).
- [ ] Describe your day-2 baseline: what was red before you touched anything.

## Weeks 2–4 (pointers, not a plan)

- Pair with someone on a bug that crosses frontend and an edge function.
- Read `RUNBOOK.md` sections 2–5 (deploy, migrations, rollback, backups) and the runbooks in `docs/runbooks/` for the area you will work in.
- Read the compliance drafts in `docs/compliance/policies/` that touch engineering (change management, vulnerability management, secrets and key rotation). They are drafts; what they say is not yet company policy.
- Learn your area's owner. Ownership is in [`docs/OWNERS.md`](../OWNERS.md); today most owners there are still `TBD`.
- Expectations for each level are in [`competencies.md`](competencies.md).

## Known gaps in this snapshot (2026-11-20) — [VERIFY] against the live repository

- `CONTRIBUTING.md` lists `npm run doctor`, `check:layers`, `owners:check` and `registers:check`, and `package.json` defines them, but the script files they call (`scripts/dependency-doctor.mjs`, `scripts/governance/check-layers.mjs`, `scripts/governance/check-codeowners.mjs`, `scripts/registers/check-registers.mjs`) were not in the snapshot this page was verified against. They are left out of the checklist for that reason. The same applies to `debt:report`, `sbom` and `assets:check`.
- `docs/governance/README.md`, `docs/governance/BRANCH_PROTECTION.md` and `docs/registers/` are referenced from other docs but were not in the snapshot.
- `.github/CODEOWNERS` still has placeholder `@OWNER_*` tokens, so code-owner review protects nothing until they are replaced (decision D-7).
- No on-call roster, paging tool or SLA targets are defined in the repository (`RUNBOOK.md` section 8, item 11). Do not assume you are on call; ask your manager what is expected.

If you fix any of these while onboarding, update this page in the same PR.
