# ADR 0010 — Migration version naming and ordering

- **Status:** Proposed — needs owner approval (DECISIONS_NEEDED D-11). Approver / date: TODO(owner)
- **Scope:** names and versions of files in `supabase/migrations`. Nothing already applied is renamed by this ADR.
- **Evidence base:** an uploaded copy of the repo (may differ from `main`), measured with `node scripts/migrations/check-migration-versioning.mjs report` on 2026-11-23.

## 1. Context

Supabase records one row per migration (the version prefix is the key) and applies files in filename order.

Measured state of the snapshot:

| Item | Value |
|---|---|
| Entries | 850 |
| Newest version | 20290311000000 |
| Future-dated (after 2026-11-23) | 691 |
| Versions shared by several files | 688 files in 139 groups |
| Irregular names | 4 (3 files + directory `split/`) |

A migration created today with `supabase migration new` gets a real-time stamp, so it sorts before the future-dated files and `db push` rejects it as out of order.

## 2. Decision (option A from decision-pack D-11)

| # | Rule | Enforced by |
|---|---|---|
| R1 | Name is `YYYYMMDDHHMMSS_snake_case.sql`; the prefix is a real UTC date-time | `scripts/lint-migrations.mjs` |
| R2 | Monotonic: a new version is greater than every version already on the base branch | `scripts/lint-migrations.mjs` (existing check) |
| R3 | Not future-dated. Normal mode: version <= now + 10 min. Frontier mode (while legacy future-dated files exist): version <= newest existing + 1 day | `scripts/lib/migrationVersionRule.mjs` |
| R4 | Versions are unique | `scripts/lint-migrations.mjs` |
| R5 | Applied migrations are never renamed, edited or deleted; fix forward | `scripts/migrations/check-migration-versioning.mjs` |

Frontier mode exists because R2 and R3 cannot both hold in the calendar sense while 691 files are future-dated. R2 (ordering safety) wins. Frontier mode switches itself off when the newest existing version is no later than now, after the repair plan in `docs/runbooks/migration-versioning.md` (Phase 3) has run.

New versions come from `node scripts/migrations/check-migration-versioning.mjs next`. Do not use `supabase migration new` until the repair has run.

## 3. Exception list (frozen)

Machine-readable list: `scripts/migrations/legacy-exceptions.json`. These entries break R1 and are **not** renamed (R5):

| Entry | Problem | Open question |
|---|---|---|
| `20260915_phone_numbers.sql` | 8-digit prefix | TODO(owner): recorded remotely? |
| `20260916_job_cost_entries.sql` | 8-digit prefix | TODO(owner): recorded remotely? |
| `<timestamp>_daily_briefing.sql` | placeholder prefix; only file creating `daily_briefings` | TODO(owner): does the table exist in each environment? |
| `split/` | directory, not a migration | TODO(owner): superseded by `20271011000000_arrival_windows.sql`? |

The linter fails when an exception disappears (rename or delete) unless the same PR updates the list. A reviewed `migration-repair` PR (runbook Phase 1) is the only way to remove an entry.

## 4. Consequences

- New migrations can no longer carry impossible dates or jump more than a day ahead of the sequence.
- The 139 duplicate-version groups and the 691 future-dated files stay as legacy debt until the runbook repair is approved and run. This ADR does not run it.
- [VERIFY] exact CLI behaviour for 8-digit prefixes, placeholder names and sub-directories in the CLI version you run.

## 5. Rollback

Remove the `checkVersionWindow` call and the exceptions block from `scripts/lint-migrations.mjs`. No database state is involved.
