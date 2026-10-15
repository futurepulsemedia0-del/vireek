# Runbook — migration version repair (duplicate prefixes)

Applies once, when `supabase/migrations` is renumbered by `scripts/migrations-dedupe.mjs apply`.
Fresh/local databases need nothing (`supabase db reset`). Only databases that already recorded
the OLD versions in `supabase_migrations.schema_migrations` need the repair below.

## 0. Developer (once, in a branch)
1. `node scripts/migrations-dedupe.mjs check`     → lists duplicates / bad names
2. Fix files the CLI ignores by hand (e.g. `*.sq` → `.sql`); diff against any `.sql` twin first.
3. `node scripts/migrations-dedupe.mjs plan`      → review (dry run)
4. `node scripts/migrations-dedupe.mjs apply`     → renames + writes `supabase/migration-renumber-map.json`
5. `supabase db reset` locally → must finish without errors. Commit the renames AND the map file.

## 1. Per already-migrated environment (staging first, then production)
Freeze deploys to that project, then:
1. Back up (Dashboard → Database → Backups, or `pg_dump`).
2. `supabase link --project-ref <ref>` and `supabase migration list` — note which old versions are recorded remotely.
3. Confirm schema parity: `supabase db diff --linked` must show no drift for objects these migrations create.
   If objects are missing, do NOT repair — apply the missing migrations with `supabase db push` instead.
4. Generate and review: `node scripts/migrations-dedupe.mjs repair-script > repair.sh`
5. Run `bash repair.sh`. It (a) removes stale old versions (`--status reverted`) and
   (b) records the renamed files under their new versions (`--status applied`).
6. `supabase migration list` — Local and Remote columns must match row for row.
7. `supabase db push --dry-run` must report "Remote database is up to date."

Never mark a migration `applied` if its SQL did not actually run there. Re-running repair is safe (idempotent).

## 2. Rollback
Restore the backup, or invert: `--status reverted <new versions>` then `--status applied <old versions>`.

## 3. Guardrail
CI job `Migrations / version-check` fails any PR that adds a duplicate or non-canonical version.
Create new migrations only with `supabase migration new <name>` (always unique timestamps).
