# Decision pack — D-1 … D-12

- **Source list:** `docs/governance/DECISIONS_NEEDED.md`
- **Status:** every decision is **`approvedBy: PENDING`**. Nothing here is approved; nothing that needs approval has been implemented.
- **Evidence base:** the uploaded snapshot `vireek-main__7_.zip` (static read; no network, no install, no git history). Several files named in `DECISIONS_NEEDED.md` are **absent from that snapshot** (marked *not in snapshot*), so the live repo is newer **[VERIFY]**. Re-check each "snapshot" fact before acting.
- **Effort figures** are rough engineering estimates, not quotes. Legal and vendor-cost figures are deliberately omitted **[COUNSEL][VERIFY]**.
- **Owner:** `OWNER_<role>` placeholders only; assign real people.

## Overview

| ID | Recommended option | Ready-to-execute? | Needs counsel |
|---|---|---|---|
| D-1 | A — repair lockfile, then re-baseline | **Yes** (technical, reversible; needs network + a real install) | No |
| D-2 | A — approve policy, keep override with expiry | No (approval) | Yes |
| D-3 | B — internal targets now, publish after measured baseline | No (approval) | Yes |
| D-4 | A — self-host fonts; licence/image provenance stays human | **Partly** (self-hosting yes; licences/provenance no) | Yes (licences) |
| D-5 | A — declare native plugins in `package.json` | No (depends on ADR-0008 + D-1) | No |
| D-6 | Blocked on owner answers | No | Yes |
| D-7 | A — real owners + branch protection | No (GitHub settings, people) | No |
| D-8 | A — list all, per-vendor evidence | No | **Yes** |
| D-9 | B — keep drafts, fix the list | **Partly** (filename fix only) | Review |
| D-10 | A — owner supplies signed terms | No | Yes |
| D-11 | A — monotonic rule + CI lint | No (policy); lint is ready after approval | No |
| D-12 | A — delete clutter after apply-check | **Yes**, with precondition | No |

Order of dependence: D-6 → D-8 (one customer notice); D-1 → D-5; D-1 → D-2 (licence scan needs a trustworthy lockfile); D-7 anytime.

---

## D-1 — Dependency drift (lockfile, undeclared imports)

- **Snapshot facts:** `package.json` declares `@supabase/supabase-js ^2.105.0`, `read-excel-file ^5.8.5`, `@axe-core/playwright ^4.10.1`; `package-lock.json` contains all three (2.112.4 / 5.8.8 / 4.14.0), so the drift in `DECISIONS_NEEDED.md` **does not reproduce in this snapshot** **[VERIFY in live repo]**. `cf-build.sh` installs ~35 packages `--no-save` outside the lockfile, which is real, visible non-reproducibility. `scripts/dependency-doctor.mjs` and its baseline are *not in snapshot*.
- **Options:** **A** declare every imported package + regenerate lockfile + `npm ci` + re-baseline. **B** only add the missing three. **C** leave and accept `npm install` builds.
- **Recommended: A.** B leaves the 35 unlocked installs; C keeps builds non-reproducible and the SBOM incomplete.
- **Cost:** M (about 0.5–1 day, mostly peer-dependency resolution). **Risk:** low–medium — version bumps can change behaviour; mitigate with typecheck + test run before merge.
- **Owner:** `OWNER_PLATFORM`. **approvedBy:** PENDING.
- **After approval, change:** `package.json`, `package-lock.json`, `cf-build.sh` (remove the `--no-save` block), `scripts/governance/baselines/dependency-doctor.json` (**[VERIFY] path**).
- **READY-TO-EXECUTE** (purely technical, reversible by git revert). Execute on the live repo with network: `npm install` → `npm ci` → typecheck → tests → `node scripts/dependency-doctor.mjs --write-baseline`.

## D-2 — Licence policy and `caniuse-lite` override

- **Snapshot facts:** `docs/governance/license-policy.json` *not in snapshot*; `THIRD_PARTY_NOTICES.md` exists at the root.
- **Options:** **A** approve the policy; keep the CC-BY-4.0 dev-only override with an **expiry date** and attribution in `THIRD_PARTY_NOTICES.md`. **B** approve without override (CI fails until `caniuse-lite` is replaced or pinned elsewhere). **C** change the policy.
- **Recommended: A.** The package is a build-time browser-data dependency; the claim that it is not shipped in the bundle needs a check **[VERIFY]**. An expiry forces re-review.
- **Cost:** S. **Risk:** low if the dev-only claim holds; if it ships, CC-BY attribution becomes a compliance duty **[COUNSEL]**.
- **Owner:** `OWNER_LEGAL` + `OWNER_PLATFORM`. **approvedBy:** PENDING (the policy file must keep `approvedBy: PENDING` until you sign).
- **After approval, change:** `docs/governance/license-policy.json`.

## D-3 — Vulnerability SLA numbers

- **Snapshot facts:** `SUPPLY_CHAIN.md` *not in snapshot*; `docs/compliance/policies/vulnerability-management.md` exists as a draft.
- **Options:** **A** publish SLA numbers now. **B** adopt **internal targets** now, mark as targets, publish only after two quarters of measured performance. **C** no numbers.
- **Recommended: B.** A number put into a security questionnaire becomes a commitment **[COUNSEL]**; you currently have no measured baseline.
- **Cost:** S. **Risk:** A — breach of a self-set promise; C — enterprise questionnaires stall.
- **Owner:** `OWNER_SECURITY`. **approvedBy:** PENDING.
- **After approval, change:** `SUPPLY_CHAIN.md` (**[VERIFY] path**); align `docs/compliance/policies/vulnerability-management.md`.

## D-4 — Fonts and image provenance

- **Snapshot facts:** `vercel.json` CSP references font hosts; `src/lib/fonts.test.ts` exists; `ASSET_LICENSES.csv` *not in snapshot*. The 19 unknown-origin images are a human fact-finding task.
- **Options:** **A** self-host the three fonts (privacy: no third-party request); verify each font's licence permits self-hosting and record it. **B** keep runtime loading. 
- **Recommended: A** for fonts. Self-hosting removes a runtime third-party and needs the CSP `font-src`/`style-src` entries reviewed afterwards. Image provenance: owner must trace each image or replace it.
- **Cost:** fonts S–M (about half a day); images unknown. **Risk:** font metric shifts (layout); missing-licence images remain a legal exposure **[COUNSEL]**.
- **Owner:** `OWNER_FRONTEND` (fonts), `OWNER_BRAND` (images). **approvedBy:** PENDING.
- **After approval, change:** `ASSET_LICENSES.csv`, font files + CSS, `vercel.json` CSP, `src/lib/fonts.test.ts`.
- **READY-TO-EXECUTE (part):** font self-hosting only, once each licence is confirmed. **NOT ready:** licence verification and image provenance.

## D-5 — Native plugins (ADR-0008)

- **Snapshot facts:** `docs/MOBILE_RELEASE.md` exists; `package.json` has 16 `@capacitor*` entries; `cf-build.sh` additionally installs ~22 native plugins `--no-save`. ADR-0008 *not in snapshot*.
- **Options:** **A** declare all native plugins in `package.json`. **B** script their install at release time only.
- **Recommended: A,** after D-1. Declared plugins are in the lockfile and the SBOM; B keeps them invisible to audits.
- **Cost:** M. **Risk:** web build gains native-only packages (bundle size; mitigate with dynamic imports) and `npx cap sync` must be re-run.
- **Owner:** `OWNER_MOBILE`. **approvedBy:** PENDING.
- **After approval, change:** `package.json`, `package-lock.json`, `docs/MOBILE_RELEASE.md`.

## D-6 — Production host

- **Status:** **blocked.** Evidence is insufficient; see `docs/adr/production-hosting.md` (10 questions).
- **Recommended:** none yet. **Do not** pick a host from file presence: `worker/index.ts` imports `vercel.json`.
- **Owner:** `OWNER_PLATFORM`. **approvedBy:** PENDING.
- **After the answer, change:** `ARCHITECTURE.md`, `src/lib/subprocessors.ts`, `src/lib/trustPack/subprocessorResidency.ts` (+ its test), DPA/transfer drafts **[COUNSEL]** — prepared edits are in the ADR §6.

## D-7 — Branch protection and CODEOWNERS

- **Snapshot facts:** `.github/CODEOWNERS` contains `@OWNER_*` placeholders (confirmed). `BRANCH_PROTECTION.md` *not in snapshot*.
- **Options:** **A** real handles/teams + protection (required status checks, no force push, PR required). **B** protection without review requirement while one maintainer exists.
- **Recommended: A** with the review count set to what your team can satisfy: with a single maintainer, "require review" blocks your own merges, so require status checks first and add review when a second maintainer exists. GitHub ignores invalid CODEOWNERS entries, so today it protects nothing.
- **Cost:** S. **Risk:** low; possible merge friction.
- **Owner:** `OWNER_PLATFORM`. **approvedBy:** PENDING.
- **After approval, change:** `.github/CODEOWNERS` and GitHub repo settings (dashboard).

## D-8 — Sub-processors missing from the public list

- **Snapshot facts:** public list (`src/lib/subprocessors.ts`) has 15 entries; Anthropic, Cohere, Plaid, ElevenLabs, Twilio, Maps, FCM, Xero, HubSpot, Jobber, Meta appear in code/docs (`ARCHITECTURE.md` §1, `docs/compliance/data-map.md`). `docs/registers/subprocessors.json` *not in snapshot*. What data each vendor receives must be confirmed per vendor **[VERIFY]**.
- **Options:** **A** list every vendor that receives customer personal data; place customer-connected ones under "Customer-Optional Integrations" (`required: false`). **B** document, per vendor, why it is not listed (only with evidence that no personal data reaches it). **C** leave as is.
- **Recommended: A,** with B only where evidence supports it. The page claims completeness; C leaves a public claim you know is incomplete **[COUNSEL]**.
- **Cost:** M (code review per vendor + counsel). **Risk:** high if left — misstatement; adding vendors can trigger the DPA §5 advance-notice process for customers on signed DPAs. **Bundle with D-6** into one notice.
- **Owner:** `OWNER_LEGAL`. **approvedBy:** PENDING.
- **After approval, change:** `docs/registers/subprocessors.json`, `src/lib/subprocessors.ts`, `src/lib/trustPack/subprocessorResidency.ts` (+ test), regenerate `docs/compliance/data-map.md`.

## D-9 — Policy set

- **Snapshot facts:** the policy folder has 16 policy files; `README.md` lists 16, but **5 names differ** from actual files (e.g. README `backup-and-disaster-recovery.md` vs file `backup-disaster-recovery.md`; also data-classification, logging, secrets, onboarding). `DECISIONS_NEEDED.md` says none exist — contradicts the snapshot **[VERIFY live repo]**. Policies are drafts; the README itself says none is evidence of compliance. `docs/registers/policy-calendar.json` *not in snapshot*.
- **Options:** **A** adopt all 16 as written. **B** keep as drafts, fix the list, adopt a policy only when you actually operate it. **C** delete unused ones.
- **Recommended: B.** Auditors treat an adopted-but-unpracticed policy as a gap, worse than a draft.
- **Cost:** S for list fixes; M–L to operationalise. **Risk:** low.
- **Owner:** `OWNER_SECURITY`. **approvedBy:** PENDING.
- **After approval, change:** `docs/compliance/policies/README.md`, `docs/registers/policy-calendar.json`.
- **READY-TO-EXECUTE (part):** aligning README filenames with the actual files (mechanical), if the live repo matches the snapshot.

## D-10 — Customer commitments register

- **Snapshot facts:** `docs/registers/commitments.json` *not in snapshot*. Cannot be inferred from code.
- **Options:** **A** owner transcribes SLA/DPA/residency/renewal terms from signed documents. **B** keep empty and state so.
- **Recommended: A** — an empty register cannot protect you from an unmet commitment.
- **Cost:** M (depends on contract count). **Risk:** transcription errors; keep a link to each source document. Legal interpretation **[COUNSEL]**.
- **Owner:** `OWNER_FOUNDER`. **approvedBy:** PENDING.
- **After approval, change:** `docs/registers/commitments.json`.

## D-11 — Migration version rule

- **Snapshot facts:** 801 entries in `supabase/migrations`; by year prefix: 2026 → 247, 2027 → 346, 2028 → 141, 2029 → 65. Irregular names: `20260915_phone_numbers.sql`, `20260916_job_cost_entries.sql` (8-digit), `<timestamp>_daily_briefing.sql`, and a `split` entry. Supabase applies by version order, so a correctly dated new file sorts **before** the future-dated ones.
- **Options:** **A** keep a monotonic rule: new version = current maximum + 1 (matches current practice); never rename applied versions; add a CI lint for format. **B** rename to real dates (breaks the applied-migration history table unless repaired). **C** squash/baseline.
- **Recommended: A.** B/C carry data-loss/desync risk for little gain.
- **Cost:** S (rule + lint). **Risk:** low; future dates stay odd but safe.
- **Owner:** `OWNER_PLATFORM`. **approvedBy:** PENDING.
- **After approval, change:** `CONTRIBUTING.md` (rule), a CI lint script/workflow (**[VERIFY] where**), and decide the fate of the 3 irregular names separately.

## D-12 — Root clutter and duplicates

- **Snapshot facts:** root holds 22 `*.patch`/`*.diff` files, 3 `INSTALL*.md`, `*.txt` edit notes, an odd file named `chmod +x scripts`, and both `README-fa.md` and `README.fa.md`. `src/pages/hangelogPage.tsx` exists beside `ChangelogPage.tsx` but is **not byte-identical** in this snapshot **[VERIFY live]**; check imports before deleting.
- **Options:** **A** delete after confirming each patch is already applied. **B** move to `docs/archive/`. **C** keep.
- **Recommended: A** for patches proven applied (git history is the archive); B for anything you cannot prove.
- **Cost:** S. **Risk:** low with the precondition; deleting an unapplied patch loses work.
- **Owner:** `OWNER_PLATFORM`. **approvedBy:** PENDING.
- **After approval, change:** delete the files; update `TECH_DEBT.md` (DEBT-ROOT, DEBT-DUP); check `APPLY.md`/`INSTALL*.md` references first.
- **READY-TO-EXECUTE** with the precondition: for each patch run `git apply --check --reverse <file>`; delete only those that apply in reverse (already present). For duplicates, `grep -rn "hangelogPage"` and `cmp` before removal.

---

## Approval register

| ID | approvedBy | Date |
|---|---|---|
| D-1 | PENDING | — |
| D-2 | PENDING | — |
| D-3 | PENDING | — |
| D-4 | PENDING | — |
| D-5 | PENDING | — |
| D-6 | PENDING | — |
| D-7 | PENDING | — |
| D-8 | PENDING | — |
| D-9 | PENDING | — |
| D-10 | PENDING | — |
| D-11 | PENDING | — |
| D-12 | PENDING | — |
