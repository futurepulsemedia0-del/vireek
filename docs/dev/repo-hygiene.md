# Repo hygiene: stray root files (inventory only)

Status: **LIST ONLY. Nothing has been moved, renamed or deleted.** Every row below needs an explicit
owner decision (see "Confirmation needed"). Generated from the uploaded `vireek-main` snapshot; the working repo
may differ, so re-run the commands in the last section before acting.

Legend for *Evidence*: **verified** = checked by comparing files / grepping the snapshot; **unverified** = a guess.

## 1. Patch and diff files at the repo root

These look like change-sets handed over for manual application. Whether each one has already been applied to the
code is **unverified** (no git history in the snapshot to check against). `docs/dev/patch-ledger.md` is where the
answer should be recorded, one row per patch.

| File | Size (bytes) | Evidence / note |
|---|---:|---|
| `existing-files-changes.patch` | 6,480 | unverified whether applied |
| `existing-files.commercial.patch` | 5,114 | unverified |
| `existing-files.diff` | 10,133 | unverified |
| `existing-files.patch` | 17,009 | unverified |
| `homepage-redesign.patch` | 140,169 | unverified |
| `integration.patch` | 10,663 | unverified |
| `integrations-safety.patch` | 110,632 | unverified |
| `landscaping-pack.patch` | 359,858 | unverified (docs/LANDSCAPING_PACK.md exists) |
| `legal-update.patch` | 70,841 | unverified; legal content, owner = counsel review **[COUNSEL]** |
| `modified-files.patch` | 39,536 | unverified |
| `plan-enforcement-production.patch` | 11,066 | unverified |
| `pricing-overhaul.patch` | 85,163 | unverified |
| `pricing-update.patch` | 111,892 | unverified; overlaps in name with `pricing-overhaul.patch` and `vireek-pricing-update.patch` |
| `product-surface-freeze.patch` | 252,315 | unverified |
| `provider-credentials.optional.patch` | 15,587 | unverified; "optional" |
| `sidebar-ux.patch` | 11,352 | unverified |
| `support-help-center.patch` | 43,676 | unverified |
| `vapi-webhook-index.optional.patch` | 13,578 | unverified; "optional"; touches a file that is under active change (`vapi-webhook/index.ts`) |
| `vireek-color-tokens.patch` | 3,161,793 | unverified; 3 MB, the largest file in the root |
| `vireek-governance.patch` | 73,508 | unverified |
| `vireek-logo.patch` | 136,369 | unverified |
| `vireek-pricing-update.patch` | 126,011 | unverified |
| `engine.ts.diff.txt` | 5,946 | unverified (a `.diff` saved as `.txt`) |
| `patches/App.tsx.patch` | 1,393 | in the `patches/` folder, not the root; unverified |

## 2. Loose instruction / scratch text files at the root

| File | Evidence / note |
|---|---|
| `CookiePolicyContent_replacement_sections_4-10.txt` | replacement text for a legal page; unverified whether applied **[COUNSEL]** |
| `EDIT_edge-function_exit-dataroom-public_replace-tail.ts.txt` | hand-edit instruction for one edge function; unverified |
| `pre-existing-syntax-errors.txt` | report from the TypeScript parser: **62 syntax errors in the uploaded snapshot**, e.g. `src/components/ErrorBoundary.tsx:70`. This is a *defect list*, not clutter. Keep it until the errors are fixed (see "Finding" below). |
| `INSTALL.md`, `INSTALL-PHASE2.md`, `INSTALL-PULSE.md`, `APPLY.md`, `CHANGES.md`, `IMPLEMENTATION_NOTES.md` | hand-over notes for earlier deliveries; probably historical; unverified |

## 3. Loose source files at the root

Config files that belong at the root are **not** listed (`vite.config.ts`, `vitest.*.config.ts`,
`playwright.config.ts`, `capacitor.config.ts`, `eslint.config.js`, `tailwind.config.js`, `postcss.config.js`).

| File | Evidence / note |
|---|---|
| `event-registry.ts` | **verified**: header says it is `supabase/functions/_shared/workflow-compiler/event-registry.ts`; the root copy **differs** from that file, so it is an older or newer variant, not a duplicate. Referenced only by the workflow-compiler tests and `docs/_audit/final-convergence-audit.md`. |
| `rule-analysis.ts` | **verified**: same situation as above for `workflow-compiler/rule-analysis.ts` (differs). |
| `check.cjs` | already listed in `.gitignore` (line 44), so it should not be tracked; referenced in `docs/_audit/final-convergence-audit.md`. |

## 4. Duplicate-looking README files

**Not duplicates (verified).** `README-fa.md` (21 lines) is a "how to apply the governance patch" note;
`README.fa.md` (66 lines) is a "Chief of Staff deployment and verification guide". Different content, different
purpose. Do not merge or delete one on the assumption that it copies the other. Suggested follow-up (a decision,
not an action): rename them by content so the names stop colliding.

## 5. Mis-named folders

| Path | Evidence / note |
|---|---|
| `ocs/` | **verified**: contains only `ocs/security/THREAT_MODEL.md`, which is **byte-identical** to `docs/security/THREAT_MODEL.md`. Looks like `docs/` truncated by a bad extraction. |
| `rc/` | **verified**: contains only `rc/lib/canvassing.test.ts`. `src/lib/canvassing.ts` exists but `src/lib/canvassing.test.ts` does **not**, so this is probably a test that belongs in `src/lib/` and is currently **not run** by the test suite. Moving it may surface failures. |
| `chmod +x scripts/` | **verified**: a *directory* (typo of the shell command `chmod +x scripts`) that contains `load/webhook-fanout.sh`. A real `load/` folder also exists at the root. |

## 6. Secrets hygiene

* `.env` is present in the snapshot. It is covered by `.gitignore` (lines 16, 32), so it is *probably* not tracked,
  but the snapshot has no git metadata to prove it. Values were **not** inspected beyond key names. If it was ever
  committed or shared in a zip, treat every non-public key in it as exposed and rotate **[VERIFY]**.
* The new pre-commit hook blocks staging any `.env*` (except `.env.example`) and common key files.

## Finding that affects this cleanup

The snapshot contains **62 TypeScript syntax errors**, including in `outbound-dialer/index.ts`,
`followup-agent-dispatcher/index.ts` and `vapi-webhook/index.ts`. Until they are fixed the new pre-commit
`typecheck` step cannot pass on a clean checkout of this snapshot. See `docs/dev/patch-ledger.md`.

## Confirmation needed before anything is moved (answer per row or per section)

1. Patches in section 1: archive to `docs/dev/archive/patches/` after each is recorded in the patch ledger as
   *applied* or *abandoned*? (Never delete before that.)
2. `ocs/`: delete (identical copy) or keep? `rc/lib/canvassing.test.ts`: move to `src/lib/` and run it?
3. `chmod +x scripts/`: merge `load/webhook-fanout.sh` into the real `load/` folder and remove the typo directory?
4. Root `event-registry.ts` / `rule-analysis.ts`: which variant is current?
5. README files: rename by content?
6. `.env`: confirm it was never committed or shared; rotate if unsure.

## Commands to re-verify (read-only)

```bash
git ls-files | grep -E '\.(patch|diff)(\.txt)?$'            # tracked patch/diff files
git ls-files --error-unmatch .env 2>&1 | head -1             # is .env tracked? (error = not tracked)
cmp ocs/security/THREAT_MODEL.md docs/security/THREAT_MODEL.md
ls src/lib/canvassing*.ts rc/lib/
```
