-- scripts/security/rls-catalog-export.sql
-- Read-only. Exports the live catalog facts the RLS generators need as ONE JSON document.
-- Usage:  psql "$DATABASE_URL" -X -At -f scripts/security/rls-catalog-export.sql > rls-catalog.json
select jsonb_pretty(jsonb_build_object(
  'policies', coalesce((select jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname)
                          from pg_policies p where p.schemaname = 'public'), '[]'::jsonb),
  'columns', coalesce((select jsonb_agg(jsonb_build_object('table', c.relname, 'column', a.attname) order by c.relname, a.attnum)
                         from pg_attribute a join pg_class c on c.oid = a.attrelid
                         join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped), '[]'::jsonb),
  -- columns that are the LEADING key of a valid, non-partial, non-expression index (PK/unique included)
  'leadingIndexed', coalesce((select jsonb_agg(distinct jsonb_build_object('table', c.relname, 'column', a.attname))
                                from pg_index i join pg_class c on c.oid = i.indrelid
                                join pg_namespace n on n.oid = c.relnamespace
                                join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                               where n.nspname = 'public' and i.indisvalid and i.indpred is null and i.indkey[0] <> 0), '[]'::jsonb),
  -- volatility of the zero-arg helper policies call per row: 's' stable, 'i' immutable, 'v' VOLATILE (must NOT be wrapped)
  'functions', coalesce((select jsonb_object_agg(p.proname, p.provolatile::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'get_account_owner_id' and p.pronargs = 0), '{}'::jsonb),
  'indexNames', coalesce((select jsonb_agg(ic.relname order by ic.relname)
                            from pg_index i join pg_class ic on ic.oid = i.indexrelid
                            join pg_namespace n on n.oid = ic.relnamespace where n.nspname = 'public'), '[]'::jsonb),
  -- reltuples = -1 means "never analyzed" (unknown size); scans = seq_scan + idx_scan since the last stats reset
  'stats', coalesce((select jsonb_agg(jsonb_build_object('table', c.relname, 'reltuples', c.reltuples::bigint,
                                                          'scans', coalesce(s.seq_scan, 0) + coalesce(s.idx_scan, 0),
                                                          'relkind', c.relkind) order by c.relname)
                       from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       left join pg_stat_user_tables s on s.relid = c.oid
                      where n.nspname = 'public' and c.relkind in ('r','p')), '[]'::jsonb)
));
