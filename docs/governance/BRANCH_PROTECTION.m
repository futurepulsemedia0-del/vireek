# Branch protection and CODEOWNERS (D-7)

Status: **checklist — not yet applied** · Owner: TODO(owner) · Applied on: TODO(owner)
GitHub UI labels below are written from general knowledge of GitHub and can differ by plan or UI version: **[VERIFY]** each one in Settings.

## 0. Prerequisites (in this order)

1. Every owner in `.github/CODEOWNERS` is a real user or team with **write** access. GitHub ignores invalid owners silently.
2. Replace the placeholders with the owners you decided on (no handle is invented by the tooling):
   ```bash
   cp /dev/null owners.json   # fill it: { "PLATFORM": "@org/team", "FRONTEND": "...", "MOBILE": "...", "SECURITY": "...", "COMPLIANCE": "...", "BACKEND": "...", "VOICE": "...", "DATA": "..." }
   node scripts/governance/apply-owners.mjs --map owners.json          # dry run
   node scripts/governance/apply-owners.mjs --map owners.json --write
   node scripts/governance/check-codeowners.mjs --strict               # must exit 0
   ```
3. Update `docs/OWNERS.md` (six areas still `TBD`) and run `npm run debt:report` if `TECH_DEBT.md` shows the old tokens.
4. Merge that PR **before** turning on "Require review from Code Owners", otherwise the PR that fixes the file blocks itself.

## 1. Settings for `main` (Settings → Branches → Add branch protection rule, or an equivalent Ruleset)

- [ ] Require a pull request before merging
  - [ ] Required approvals: **1** (use 2 for `/supabase/migrations/` and `/.github/` once you have a second maintainer)
  - [ ] Dismiss stale pull request approvals when new commits are pushed
  - [ ] **Require review from Code Owners**
  - [ ] Require approval of the most recent reviewable push **[VERIFY label]**
- [ ] Require status checks to pass before merging
  - [ ] Require branches to be up to date before merging
  - [ ] Required checks: see §2
- [ ] Require conversation resolution before merging
- [ ] Require linear history (optional; the team decides)
- [ ] Require signed commits (optional; the team decides)
- [ ] Do not allow bypassing the above settings (includes administrators) **[VERIFY label]**
- [ ] Restrict force pushes: **off** (no force pushes)
- [ ] Allow deletions: **off**

Known GitHub behaviour: the author of a PR cannot approve it. With **one** maintainer, "Require review from Code Owners" blocks every PR you open. Until a second owner exists, either add a bypass actor on purpose or leave that single box off, and write the decision here: TODO(owner).

## 2. Required status checks

The name GitHub expects is the **job name**. A check only appears in the picker after it has run recently **[VERIFY]**, so open a PR first.

Required (workflows without a `paths:` filter on `pull_request`, verified in `.github/workflows`):

| Workflow | Job name |
|---|---|
| CI | `Lint, Typecheck, Unit Tests, Build` |
| CI | `E2E (Playwright)` — **[VERIFY]** this job has an `if:`; a skipped job should still count as passing |
| Quality Gates | `Migration lint` |
| Quality Gates | `OpenAPI drift (api-v1 routes vs published spec)` |
| Quality Gates | `Asset budget (images, fonts, SVG)` |
| Quality Gates | `Bundle-size budget` |
| Package script references | `Every package.json script target exists` |

Optional (slower or heavier, the team decides): `Docs code samples (executed, not just rendered)`, `Lighthouse CI (public pages)`, `Interpreter eval gate`, `Vertical AI eval gate`.

**Do not** mark these as required. They filter on `paths:` for `pull_request`, so a PR that touches other files never gets the check and stays "Expected" forever: `Security Gates`, `Migrations` (`Unique migration versions`, `supabase db reset`), `Database tests (pgTAP)`, `Edge Functions`, `License Compliance`. Their paths are covered by CODEOWNERS review instead. A single always-running "gate" job that aggregates them would fix this properly; it is not built yet.

## 3. Verify after applying

- [ ] Open a throwaway PR that edits `supabase/migrations/…`: GitHub lists the `@OWNER_DATA` replacement as a requested reviewer.
- [ ] A direct push to `main` is rejected.
- [ ] `node scripts/governance/check-codeowners.mjs --strict` exits 0 on `main`.
- [ ] GitHub's CODEOWNERS view (file page in `.github/`) shows no errors **[VERIFY]**.
