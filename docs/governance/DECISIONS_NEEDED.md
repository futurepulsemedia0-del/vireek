# Decisions that need a human

| ID | Decision | Why it matters | Where |
|---|---|---|---|
| D-1 | Repair dependency drift: declare/lock 35 undeclared app imports (23 are native plugins), add `read-excel-file` and `@axe-core/playwright` to the lockfile, align `@supabase/supabase-js` (`^2.105.0` vs lock `^2.57.4`). Then run `node scripts/dependency-doctor.mjs --write-baseline`. | `npm ci` very likely fails; builds not reproducible; SBOM incomplete. Needs network + a real install, which the audit could not do. | `scripts/governance/baselines/dependency-doctor.json` |
| D-2 | Approve or change the licence policy and the `caniuse-lite` (CC-BY-4.0, dev-only) override (`approvedBy: PENDING`). | Binding rule for CI failures. | `docs/governance/license-policy.json` |
| D-3 | Approve the vulnerability SLA numbers. | Becomes a commitment if put in security answers. | `SUPPLY_CHAIN.md` |
| D-4 | Self-host the three Google fonts or keep runtime loading; verify font licences; identify the origin of 19 images. | Privacy + licence exposure. | `ASSET_LICENSES.csv` |
| D-5 | Declare native plugins in `package.json` or script their release-time install. | ADR-0008. | `docs/MOBILE_RELEASE.md` |
| D-6 | Which host serves production: Vercel or the Cloudflare Worker? Then fix `ARCHITECTURE.md`, `src/lib/subprocessors.ts`, DPA text. | ADR-0011; public sub-processor claims. | |
| D-7 | Branch protection (apply `BRANCH_PROTECTION.md`) and replace `@OWNER_*` in `.github/CODEOWNERS`; then use `--strict`. | Without real owners CODEOWNERS protects nothing. | |
| D-8 | Sub-processors found in code but missing on the public list (Anthropic, OpenAI, ElevenLabs, Cohere, Plaid, Twilio, Google Maps/Places, Firebase Cloud Messaging, Xero, HubSpot, Jobber, Meta). Decide per vendor: list, or document why not. DPA status for all 27 is `unknown`. | The public page says it lists every third party touching customer data. Counsel. | `docs/registers/subprocessors.json` |
| D-9 | `docs/compliance/policies/README.md` lists 15 policies; none of the files exist. Write, or remove from the list. Assign owners/cadences in the calendar. | Auditors treat missing policies as gaps. | `docs/registers/policy-calendar.json` |
| D-10 | Provide real customer commitments (SLA, DPA clauses, residency, renewals) from signed documents. The register is empty on purpose. | Cannot be inferred from code. | `docs/registers/commitments.json` |
| D-11 | Migration versions dated up to 2028 and 3 irregular file names; decide a rule for new versions. | Ordering risk (ADR-0010). | |
| D-12 | Delete root clutter (`*.patch`, `INSTALL*.md`, …) and the byte-identical duplicates (e.g. `src/pages/hangelogPage.tsx`). | Debt register DEBT-ROOT/DEBT-DUP. | `TECH_DEBT.md` |
