# Final convergence audit — 2026-11-12

**Scope:** static + offline audit of the uploaded `vireek-main` snapshot.
**Environment limits (read first):**
- No `node_modules`, no network (`npm ci` impossible), no Docker/Supabase CLI, no browsers, no `.git` directory.
- Therefore **NOT RUN / BLOCKED**: `tsc`, `vitest`, `eslint`, `supabase test db`, full Playwright, `npm audit`, `lint:design` (needs `typescript`).
- Everything below marked PASSED/FAILED was **actually executed** offline in a scratch copy. Nothing was deployed, no migration applied, no secret printed.
- This snapshot is not a git checkout, so "already applied" can only be judged by file-content probes, not by history.

## 1. Check results (exact)

| Check | Result | Evidence |
|---|---|---|
| `tsc` (typecheck) | **BLOCKED** | no node_modules |
| `vitest` | **BLOCKED** | no node_modules. Static count: 860 `*.test.ts(x)` under `src`, 276 under `supabase/functions` (file counts, not results) |
| `eslint` | **BLOCKED** | no node_modules |
| `supabase test db` | **BLOCKED** | 80 pgTAP files exist under `supabase/tests/database`; none run |
| Playwright | **BLOCKED** | 47 entries in `e2e/`; none run |
| `lint:design` | **FAILED → fixed, then BLOCKED** | real syntax error at `scripts/check-design-system.mjs` ~L125 (see §3-B); after fix it needs `typescript` |
| `i18n:keys` | **FAILED** | 34 call sites with no default text (users would see raw keys) |
| `docs:inventory` | **PASSED** | wrote `docs/generated/{TABLES,EDGE_FUNCTIONS,ENV_USAGE}.md` |
| `docs:surface:check` | **FAILED (script does not exist)** | no such npm script; `docs:surface` also absent; real generator `scripts/gen-product-surface.mjs` is missing from the tree (§2) |
| `surface:check` | **FAILED → fixed → FAILED** | manifest JSON corrupt (fixed, §3-A); then 21 nav routes unclassified |
| `migrations:check` | **FAILED** | non-canonical names, e.g. `20260915_phone_numbers.sql`, `20260916_job_cost_entries.sql` |
| `lint:migrations` | PASSED with warnings | 768 migrations; literal file `<timestamp>_daily_briefing.sql`; stray file `split`; **129 legacy duplicate versions** (`supabase db push` rejects duplicate versions) |
| `lint:flags` | **FAILED** | `analytics_layer`, `home_passport_pilot` used in code but not in `config/flags.registry.json` |
| `verify-jwt:check` | **FAILED** | 133 problems: 130 functions declared `--no-verify-jwt` but missing in `config.toml`; 3 duplicate `[functions.*]` tables (`bi-export-run`, `bi-gateway`, `bi-sftp-upload`) = invalid TOML |
| `check:direct-llm` | **FAILED** | 27 functions call an LLM directly |
| `check:agent-governance` | **FAILED** | 8 ungoverned side-effect functions (sms/payment) |
| `security:check` | **FAILED** | 288 violations (no-tests 86, config-drift 48, webhook-no-replay 30, service-role-unscoped 29, plain-secret-compare 22, gateway-jwt-only 21, wildcard-cors-non-browser 21, fail-open-secret 12, no-auth 8, public-no-rate-limit 6, webhook-no-signature 3, public-no-validation 2) + 480 lines "function has no entry in function-policy.json" |
| `claims:check` | **FAILED** | `SecurityPrivacy.tsx:29` markets "End-to-End Encryption"; the claims register says `not_held` |
| `lint:settings` | **FAILED** | 3 routes not in settings registry |
| `lint:tells` | **FAILED** | 12 migrated files with large-radius violations |
| `openapi:check` | **FAILED** | `public/openapi.json` out of date |
| `docs:links` | **FAILED** | 39 broken doc links |
| `licenses:check`, `registers:check`, `owners:check` | **FAILED (scripts missing)** | `scripts/supply-chain/`, `scripts/registers/`, `scripts/governance/` do not exist |

Conclusion: the DONE condition "all checks green" is **NOT met**. I did not fix items I could not verify without running the suite.

## 2. Product surface — the freeze is documentation-only

- `docs/product-surface.md` says Unverified pages are hidden for new tenants via `experimental_surface` / `full_navigation`, and that edge functions return `403 feature_not_enabled`.
- **Verified false in this tree:** `product-surface-freeze.patch` touches 32 files; **13 are missing** (`src/lib/productSurface.ts`, `productSurface.manifest.json`, `ExperimentalSurfaceGuard.tsx`, `supabase/functions/_shared/surfaceGate.ts`, both `2027123113/1400` migrations, pgTAP tests, e2e spec, `scripts/gen-product-surface.mjs`, …). The doc describes code that is not here.
- The generator that exists (`scripts/gen-surface-inventory.mjs`) is a different tool (writes `docs/surface-inventory.csv`, manifest at `src/lib/surface/surface.manifest.json`).
- I therefore **did not regenerate `docs/product-surface.md`** — regenerating would either fail or fabricate. Required first: decide whether to apply the freeze patch (it is NOT obsolete — do not archive it).
- Static numbers from the existing doc (not re-verified): 635 page modules, 599 routed, 363 in nav, 46 page tests, 5 e2e specs.
- **Retire candidates (proposal only, nothing deleted):** the 21 unclassified routes are the first review list: `/dashboard/win-cards, review-shield, mass-incidents, interpreter, shadow-mode, voice-brand, voice-resilience, chief-of-staff, mobile-alerts, site-safety, landscaping, commercial, workflow-health, capacity-guard, revenue-radar, playbook-library, agent-actions, agent-readiness, consumer-agent, fair-sale, webhook-deliveries`. A route is a retire/freeze candidate unless it has (a) a page test, (b) real backend objects, (c) an e2e or pgTAP test. Run the generator after the freeze is applied to produce the exact list.

## 3. Changes made (scratch copy only — apply manually)

### A. Corrupt manifest JSON — `src/lib/surface/surface.manifest.json`
Search (Ctrl+F): `/dashboard/trade-packs"," "/dashboard/pest-ops",/dashboard/payroll-"`
Replace that fragment with: `/dashboard/trade-packs","/dashboard/pest-ops","/dashboard/payroll-"`
Result verified: `JSON.parse` succeeds and `npm run surface:check` now runs.

### B. Broken condition — `scripts/check-design-system.mjs`
Search: `file.endsWith(join('ui', 'Button.tsx'))`
Replace the whole `if (...) { ... return; }` block (about 5 lines) with:
```js
  if (
    file.endsWith(join('ui', 'Button.tsx')) ||
    file.endsWith(join('ui', 'Card.tsx')) ||
    file.endsWith(join('ui', 'Input.tsx')) ||
    file.endsWith(join('components', 'Skeleton.tsx'))
  ) {
    return;
  }
```
Result verified: the SyntaxError is gone; script now stops only on missing `typescript` (needs `npm ci`).

## 3b. Round 2 — additional fixes (verified by re-running the real scripts in the scratch copy)

| # | File | Change | Evidence |
|---|---|---|---|
| C | `src/lib/settings/registry.ts` | add 3 entries after the `audit-log` entry: `access-history` (owner), `job-statuses` (owner), `settings-center` (any) | `lint:settings` FAILED → **PASSED** (35 entries); `validateRegistry()` returns `[]`; the 39 search-ranking cases from `settings.test.ts` replayed with Node (not vitest): 0 mismatches before and after |
| D | `config/flags.registry.json` | register `analytics_layer`, `home_passport_pilot` | `lint:flags` FAILED → **PASSED** (9 flags, 0 errors) |
| E | `src/components/sections/SecurityPrivacy.tsx` L29 | title `End-to-End Encryption` → `Encryption in Transit and at Rest` (body text already said transit + at rest) | `claims:check` FAILED → **PASSED** (11 claims) |
| F | `src/App.tsx` | remove the duplicate one-line `<Route path="/dashboard/settings/statuses" …>` (identical element is registered again a few lines below) | route count 2 → 1; `lint:settings` still PASSED |

Decisions needing your confirmation: flag owner `platform-oncall` and expiry `2027-05-01` for the two new flags are my choices (copied from the existing convention), and owner-only permission for `access-history` / `job-statuses` was taken from the pages' own `isOwner` checks.
I did **not** move the 21 unclassified routes into `labs`: that changes who sees them in the nav and is a product decision.

Re-run tally after round 2 (offline scripts only): PASSED = `docs:inventory`, `lint:flags`, `lint:migrations` (warnings), `claims:check`, `lint:settings`. Still FAILED = `surface:check`, `migrations:check`, `i18n:keys`, `lint:design` (needs `typescript`), `verify-jwt:check`, `check:direct-llm`, `check:agent-governance`, `docs:links`, `lint:tells`, `openapi:check`, `security:check`, and the three missing-script checks. vitest, tsc, eslint, pgTAP, Playwright remain **BLOCKED**.

## 4. Root cleanup (nothing moved — judgment needed)

Dry-run `patch -p1` forward and reverse for all patches: **none applies cleanly in either direction** (partially applied or drifted), so "already applied" is **unproven**. Without `.git` I cannot prove it. Do this in your real repo: `git apply --check -R <patch>` (applied ⇒ passes) and `git log -S` on a distinctive added line.

Likely safe to archive after that check: `existing-files-changes.patch`, `existing-files.commercial.patch`, `existing-files.patch`, `existing-files.diff`, `modified-files.patch`, `integration.patch`, `vapi-webhook-index.optional.patch`, `provider-credentials.optional.patch`, `homepage-redesign.patch`, `landscaping-pack.patch`, `pricing-overhaul.patch`, `vireek-logo.patch`, `vireek-governance.patch`, `vireek-color-tokens.patch` (3.1 MB), `engine.ts.diff.txt`, `EDIT_edge-function_exit-dataroom-public_replace-tail.ts.txt`, `patches/*`.
**Do NOT archive:** `product-surface-freeze.patch` (unapplied, §2).
Other stray items: `chmod +x scripts/` (accidental dir), `ocs/` (typo of docs?), `rc/`, `check.cjs`, `rule-analysis.ts`, `event-registry.ts`, `pre-existing-syntax-errors.txt`, `CookiePolicyContent_replacement_sections_4-10.txt`, `vireek-a11y/`, `vireek-docs-phase1/`, `README-fa.md` + `README.fa.md` (duplicate), `APPLY.md`, `INSTALL*.md`, `CHANGES.md`, `IMPLEMENTATION_NOTES.md`, and `.env` (present in the ZIP; gitignored but make sure it is not in git history and was not shared — contains an anon key and a Sentry DSN, which are low-sensitivity but should be confirmed).

Move script (run yourself, after the checks above):
```bash
mkdir -p archive/patches
git mv existing-files*.patch existing-files.diff modified-files.patch integration.patch \
  vapi-webhook-index.optional.patch provider-credentials.optional.patch homepage-redesign.patch \
  landscaping-pack.patch pricing-overhaul.patch vireek-logo.patch vireek-governance.patch \
  vireek-color-tokens.patch engine.ts.diff.txt EDIT_edge-function_exit-dataroom-public_replace-tail.ts.txt \
  archive/patches/
git mv patches archive/patches/legacy-patches
echo "Archived $(date -u +%F): historical patches; applied state not proven. See docs/_audit/final-convergence-audit.md" > archive/README.md
```

## 5. Supply chain (static)

- Lockfile: v3, 779 packages, 0 missing `integrity`, 0 non-registry `resolved` URLs — **PASSED (static)**.
- `npm audit`: **BLOCKED** (no network). Run it yourself.
- Pinning: 1 of 64 direct deps pinned exactly; 63 use ranges (lockfile compensates; `npm ci` is deterministic). Policy decision, not a bug.
- Dependabot: present for npm + github-actions — PASSED.
- **GitHub Actions: 0 of 102 `uses:` are pinned by SHA** (all tag refs, e.g. `actions/checkout@v4`) — **FAILED**.
- Token least privilege: 9 of 21 workflows have **no top-level `permissions:`** (`ai-regression, ci, kill-switch-drill, knowledge-embed, migration-rehearsal, migrations, mobile, release-guard, voice-redteam`; job-level blocks were not checked) — default token may be write. `security.yml` has write permissions (verify scope is justified).
- License check, SBOM, CODEOWNERS validation: scripts referenced in `package.json` are missing; `.github/CODEOWNERS` contains 41 `@OWNER_*` placeholders, so **code-owner protection is currently inert**.

## 6. Not done and why
- Fixing the 288 security violations, 133 JWT config issues, 27 direct-LLM calls etc.: each needs the test suite running to be safe; mass edits without it would risk regressions.
- No code deleted, nothing deployed, no secrets touched.

## 7. Residual risks (highest first)
1. Product-freeze claim in `docs/product-surface.md` is unsupported by code.
2. 129 duplicate migration versions + malformed filenames → `supabase db push` failure risk.
3. 8 ungoverned SMS/payment functions; 3 webhooks without signature checks; 30 without replay protection; 12 fail-open secret checks.
4. Marketing claim "End-to-End Encryption" contradicts the claims register.
5. Actions not SHA-pinned; CODEOWNERS inert.

## 8. Manual steps for you
See `docs/NEEDS_HUMAN.md`. First three: (1) `npm ci` then rerun `tsc`, `vitest`, `lint`, `supabase test db`, Playwright; (2) apply fixes A and B; (3) decide on the freeze patch.
