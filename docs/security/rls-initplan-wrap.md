# RLS performance without behaviour change — initPlan wrap + policy-column indexes

Source of truth: `docs/security/rls-audit.md` (2274 policies call `auth.*()` unwrapped; 327 policy columns without a leading index) and the
live catalog. The audit counts `auth.*()` only; the dominant predicate in this repo is `col = public.get_account_owner_id()`
(`docs/audit/evidence-ledger.md` E-026), so the generator wraps it as well (only if the catalog proves it STABLE/IMMUTABLE).

## What already existed (reused, not duplicated)
`20280402000000_db_perf_foundations.sql` ships `get_account_owner_id() STABLE`, `perf.wrap_auth_calls()` and
`perf.rewrite_rls_initplan(apply, limit, table)` (in-database, alphabetical batches). It is compatible with this work: the same final
expression results, and whichever runs first makes the other a no-op for that policy. **The gap this fills:** targeting the 20
largest/hottest tables, a per-policy drift guard, rollback artefacts, string-literal-safe rewriting, a proof of equivalence on sample roles,
and the missing policy-column indexes (the existing `perf.missing_fk_indexes` view covers foreign keys, not policy columns).

## Files
| File | Role |
|---|---|
| `scripts/security/rls-catalog-export.sql` | read-only export of policies, columns, leading indexes, stats, helper volatility → one JSON |
| `scripts/security/rls-perf-lib.mjs` | pure wrap/unwrap/target/index planning |
| `scripts/security/rls-wrap-generator.mjs` | writes migration + generated pgTAP + rollback |
| `scripts/security/rls-index-generator.mjs` | writes small-table migration + `CONCURRENTLY` ops script |
| `scripts/security/rls-wrap-equivalence.sql` | before/after row-fingerprint proof on the real tables |
| `supabase/tests/database/rls_initplan_equivalence.test.sql` | pgTAP behaviour proof on sample roles (fixtures) |
| `scripts/security/rls-perf.test.mjs` | unit tests (`npm run test:scripts:rls-perf`) |

## Procedure (staging or a restored copy first)
```bash
psql "$DATABASE_URL" -X -At -f scripts/security/rls-catalog-export.sql > rls-catalog.json
V=$(node scripts/migrations/check-migration-versioning.mjs next)        # see docs/runbooks/migration-versioning.md
node scripts/security/rls-wrap-generator.mjs --catalog rls-catalog.json --top 20 \
  --out-migration supabase/migrations/${V}_rls_initplan_wrap_batch1.sql \
  --out-test supabase/tests/database/rls_initplan_wrap_batch1.test.sql \
  --out-rollback supabase/ops/rls_initplan_wrap_batch1.rollback.sql
TABLES=<the tables printed by the generator, comma separated>
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v phase=before -v tables=$TABLES -f scripts/security/rls-wrap-equivalence.sql
supabase db push                                                         # applies the migration
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v phase=after  -v tables=$TABLES -f scripts/security/rls-wrap-equivalence.sql   # fails on ANY difference
supabase test db                                                         # generated + hand-written pgTAP
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v phase=cleanup -f scripts/security/rls-wrap-equivalence.sql
# indexes
node scripts/security/rls-index-generator.mjs --catalog rls-catalog.json --concurrent-above 100000 \
  --out-migration supabase/migrations/<next version>_rls_policy_column_indexes.sql --out-ops supabase/ops/rls_indexes_concurrently.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/ops/rls_indexes_concurrently.sql    # outside any transaction
```
Then regenerate the audit: `node scripts/security/rls-audit.mjs --write` and update `rls-baseline.json` per its own rules.

## Safety properties
* **Equivalence.** Only the evaluation strategy changes. Proven three ways: (1) generated pgTAP checks each policy's expression, modulo
  wrapping, hashes identical to the capture, cmd/permissive/roles unchanged; (2) hand-written pgTAP compares visible rows and
  INSERT/UPDATE/DELETE outcomes (DML is always rolled back) for owner, member, stranger, unknown uid, no-`sub`, anon, and a claim switch
  inside one transaction; (3) `rls-wrap-equivalence.sql` fingerprints every visible row per principal before and after.
* **Guarded + idempotent.** A policy is altered only if it exists, is unchanged since capture (md5) and still has bare calls; otherwise it
  is skipped with a NOTICE (regenerate). Re-running changes nothing.
* **Locks.** `ALTER POLICY` took an `AccessExclusiveLock` on the table in PostgreSQL 16 (observed). The migration sets `lock_timeout = 10s`
  and fails fast; apply off-peak and re-run.
* **Rollback.** `supabase/ops/rls_initplan_wrap_batch1.rollback.sql` restores the *captured* text (it overwrites later edits to those policies).
* **Indexes.** `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so large/unknown-size tables are in an ops script run by hand;
  a failed concurrent build leaves an INVALID index that `IF NOT EXISTS` will skip — the script ends with the check query. Every added
  index costs write amplification and storage; the rule is the same heuristic as `rls-audit.mjs` (`user_id`/`account_owner_id`/`owner_id`
  referenced by a policy and not the leading key of a valid non-partial index) and can flag a column used only inside a sub-select — review the list.

## Measurements
**Not measured on Vireek's database** (none was available). On a synthetic PostgreSQL 16.15 scratch database (300k-row `jobs`, 200k-row
`projects`, stub `auth.*` functions, `EXPLAIN (ANALYZE)` as `authenticated`, best of 3, count(*) with the same policy shapes):

| Query | Before | After |
|---|---:|---:|
| `projects` (`col = public.get_account_owner_id()`, SECURITY DEFINER STABLE) | ≈ 6 570 ms | ≈ 7 ms |
| `jobs` (auth.uid() + EXISTS member sub-select) | ≈ 296 ms | ≈ 118 ms |

Plans changed from per-row evaluation to `InitPlan`. Real gains depend on table size, plan shape and the helper's cost; re-measure with
`EXPLAIN (ANALYZE, BUFFERS)` on staging. **[VERIFY]** Supabase production runs a Postgres version where `ALTER POLICY` locking and `pg_policies` deparse match.
