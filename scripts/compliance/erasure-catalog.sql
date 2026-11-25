-- scripts/compliance/erasure-catalog.sql
--
-- Real-database alternative to parsing migrations (sees dynamic SQL, ALTER-added FKs, everything).
-- NOT EXECUTED in authoring (no database was available). Run it read-only on a staging copy:
--
--   psql "$STAGING_DATABASE_URL" -X -A -t -f scripts/compliance/erasure-catalog.sql > /tmp/erasure-catalog.json
--   node scripts/compliance/check-erasure-coverage.mjs --catalog-json /tmp/erasure-catalog.json
--
-- Output: one JSON array of { table, column, type, cascades } for public base tables with an owner column.
-- `cascades` = the column has an FK to auth.users or public.profiles with ON DELETE CASCADE.
SELECT coalesce(json_agg(row_to_json(x) ORDER BY x."table", x."column"), '[]'::json)
FROM (
  SELECT c.relname::text AS "table",
         a.attname::text AS "column",
         format_type(a.atttypid, a.atttypmod) AS "type",
         EXISTS (
           SELECT 1
             FROM pg_constraint k
            WHERE k.conrelid = c.oid
              AND k.contype = 'f'
              AND k.confdeltype = 'c'
              AND a.attnum = ANY (k.conkey)
              AND k.confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)
         ) AS "cascades"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relkind IN ('r', 'p')
     AND a.attname IN ('user_id', 'owner_id', 'account_owner_id')
) x;
