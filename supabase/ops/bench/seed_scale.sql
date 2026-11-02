-- Synthetic data for hot-path benchmarks. Run on a COPY / staging, never on production.
--   psql "$DATABASE_URL" -v uid=<existing account-owner uuid> -v vehicles=20 -v pos_per_vehicle=50000 \
--        -v notifs=200000 -v audits=500000 -f supabase/ops/bench/seed_scale.sql
-- 1x ~ pos_per_vehicle=5000 notifs=20000 audits=50000 ; 10x / 100x = multiply. The uid must have a profile row
-- (get_account_owner_id() resolves through it). Rows are labelled bench-* / 'bench' so they can be removed.
\set ON_ERROR_STOP on

INSERT INTO vehicles (user_id, label)
SELECT :'uid'::uuid, 'bench-' || g FROM generate_series(1, :vehicles) g
WHERE NOT EXISTS (SELECT 1 FROM vehicles WHERE user_id = :'uid'::uuid AND label = 'bench-' || g);

INSERT INTO vehicle_position_log (user_id, vehicle_id, recorded_at, latitude, longitude, speed_mph)
SELECT v.user_id, v.id, now() - (g * interval '10 seconds'), 30 + random(), -97 + random(), (random() * 70)::numeric
FROM vehicles v CROSS JOIN generate_series(1, :pos_per_vehicle) g
WHERE v.user_id = :'uid'::uuid AND v.label LIKE 'bench-%'
ON CONFLICT DO NOTHING;

INSERT INTO notifications (user_id, type, title, message, is_read, created_at)
SELECT :'uid'::uuid, 'bench', 'bench ' || g, 'bench message', (g % 3 <> 0), now() - (g * interval '1 minute')
FROM generate_series(1, :notifs) g;

INSERT INTO audit_log (user_id, action, target_table, target_id, created_at)
SELECT :'uid'::uuid, 'bench', 'jobs', g::text, now() - (g * interval '30 seconds')
FROM generate_series(1, :audits) g;

ANALYZE vehicle_position_log; ANALYZE notifications; ANALYZE audit_log;
-- cleanup:
--   delete from vehicle_position_log where vehicle_id in (select id from vehicles where label like 'bench-%');
--   delete from vehicles where label like 'bench-%'; delete from notifications where type='bench'; delete from audit_log where action='bench';
