# Patch ledger

Purpose: one place that answers "has this patch been applied?". A patch file sitting in the repo root proves
nothing; the ledger row does. Update the ledger in the **same commit** that applies, adapts or abandons a patch.

Rules
1. Every `*.patch` / `*.diff` that enters the repo gets a row before it is applied.
2. Status is one of: `received`, `applied`, `applied-with-changes`, `partially-applied`, `abandoned`, `superseded`.
3. `applied` needs the **commit SHA** that applied it and a **verification** line (command + result, or "not run").
4. Never claim `applied` from memory: run `git apply --check -R <patch>` (a patch that reverse-applies cleanly is
   already applied) or compare against the commit, and write down what you saw.
5. Once a patch is final (`applied`, `abandoned`, `superseded`) move the file to `docs/dev/archive/patches/`
   in that same commit. Keep the row.
6. Legal / compliance content: mark the row **[COUNSEL]** and name who reviewed it. No row may say a legal text
   is "approved" without a name and date.

## Ledger

| # | Patch file | Received | Owner | Scope (files / area) | Status | Applied in (SHA) | Verification | Notes / deviations |
|--:|---|---|---|---|---|---|---|---|
| 1 | _example:_ `sidebar-ux.patch` | YYYY-MM-DD | name | `src/components/DashboardNav.tsx` | received | - | not run | _delete this example row_ |
|   |   |   |   |   |   |   |   |   |

## Row template (copy)

```
| N | <file>.patch | YYYY-MM-DD | <owner> | <area> | received | - | not run | |
```

## Procedure

```bash
# 1. is it already applied?
git apply --check -R path/to/x.patch && echo "already applied" || echo "not (fully) applied"
# 2. can it apply now?
git apply --check path/to/x.patch
# 3. apply on a branch, run the gates
git switch -c apply/<name> && git apply path/to/x.patch
npm run typecheck && npm run lint && npm test
# 4. record the result in this ledger, then archive the patch file
```

## Open question (for the owner)

`docs/dev/repo-hygiene.md` lists 24 patch/diff files whose status is unknown. Backfill one ledger row each
(status `received` is honest until verified). Do not mark any `applied` without running step 1 above.
