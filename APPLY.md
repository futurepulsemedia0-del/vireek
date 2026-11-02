# Applying the brand-audit changes (run from your repo root, on a clean branch)

1. Copy the files in this folder into the repo, keeping their paths (all are NEW files; nothing is overwritten):
   `BRAND_GOVERNANCE.md`, `docs/claims-register.json`, `.github/workflows/brand-audit.yml`,
   `scripts/add-missing-dashboard-keys.mjs`, `scripts/brand-audit/**`
2. Apply the edits to existing files (7 small hunks): `git apply existing-files-changes.patch`
   (or `patch -p1 < existing-files-changes.patch`). Verified to apply cleanly to the ZIP you uploaded.
   If your live `vercel.json` is already valid JSON, drop that hunk (and the vercelHeaders.test.ts hunk) and compare by hand.
3. Fix the red localization gates:
   `node scripts/add-format-keys.mjs`            # existing script, never run: adds the `format.*` block (9 raw keys)
   `node scripts/add-missing-dashboard-keys.mjs` # 13 missing keys x 8 locales (machine-drafted: native review needed)
   `node scripts/check-raw-locale.mjs --write-baseline`
4. Regenerate the baselines against YOUR tree (they were generated from the uploaded snapshot):
   `node scripts/brand-audit/lint-tokens.mjs --write-baseline --force`
   `node scripts/brand-audit/run.mjs --static-only --write-baseline-scores`
5. Verify: `npm ci && npm run lint && npm run typecheck && npm test && npm run lint:tokens && npm run i18n:keys && npm run lint:voice && npm run lint:locale && npm run brand:audit:static`
   then `npx playwright install chromium && npm run brand:audit:selftest`
6. Add CI secrets for the authenticated crawl (sandbox tenant only): E2E_TEST_EMAIL, E2E_TEST_PASSWORD (optional BRAND_AUDIT_STAFF_EMAIL/PASSWORD).
