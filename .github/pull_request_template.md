## Summary

<!-- What changes and why. Link the issue / ADR. -->

## Risk checklist (tick or write "n/a — reason")
- [ ] **Security:** no secrets in code/tests; new/changed edge function declared in `docs/security/function-policy.json`; auth + tenant check present; `npm run security:check` passes
- [ ] **Privacy:** no new personal-data field/flow, or `docs/compliance/data-map.md` and `src/lib/subprocessors.ts` / `docs/registers/subprocessors.json` updated; new third party? → add to the sub-processor tracker
- [ ] **Migrations:** forward-only, named `<14-digit>_name.sql`, sorts after the latest version; RLS on every new table; rollback/recovery noted below; `npm run lint:migrations` passes
- [ ] **i18n:** user-visible strings via `useTranslation()`; keys added to all locales (`npm run i18n:keys`); RTL (ar, fa) looked at
- [ ] **Accessibility:** keyboard + focus order, labels, contrast in light/dark, `prefers-reduced-motion`; axe check if UI changed
- [ ] **Dependencies:** none added, or `package.json` **and** `package-lock.json` both updated; `node scripts/dependency-doctor.mjs --check` and the license check pass
- [ ] **Architecture:** `node scripts/governance/check-layers.mjs --check` passes; ADR added/updated for a new decision (`docs/adr/`)
- [ ] **Changelog:** line added under `[Unreleased]` in `CHANGELOG.md`, or label `no-changelog`
- [ ] **Claims:** no new public claim without evidence (`npm run claims:check`)

**Rollback / recovery plan (required for migrations and edge-function changes):**

**What I did NOT verify:**

## Product surface checklist (skip if no new page/route/nav item)
- [ ] Label follows `docs/naming-guide.md` (plain words, outcome-based, no metaphors, max 3 words)
- [ ] Added to exactly one pillar rule in `src/lib/surface/surface.manifest.json` (or to `labs` if unverified)
- [ ] Checked `docs/surface-inventory.csv` for an existing page that overlaps
- [ ] If renamed: `old` name + `synonyms` added to `renames` and the URL is unchanged
- [ ] `node scripts/gen-surface-inventory.mjs --check` passes (no unclassified or unrouted nav links)
- [ ] Plan/permission gating unchanged or explained
