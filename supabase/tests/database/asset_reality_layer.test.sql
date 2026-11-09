-- supabase/tests/database/asset_reality_layer.test.sql
-- Plain-SQL assertions (psql -v ON_ERROR_STOP=1). Requires the migration + equipment, auth.users, get_account_owner_id().
BEGIN;
DO $$
DECLARE
  a uuid := '00000000-0000-0000-0000-00000000000a'; b uuid := '00000000-0000-0000-0000-00000000000b';
  ea uuid; eb uuid; m1 uuid; m2 uuid; n int; failed boolean;
  row jsonb;
BEGIN
  INSERT INTO auth.users(id) VALUES (a), (b) ON CONFLICT DO NOTHING;
  INSERT INTO equipment(id, user_id) VALUES (gen_random_uuid(), a) RETURNING id INTO ea;
  INSERT INTO equipment(id, user_id) VALUES (gen_random_uuid(), b) RETURNING id INTO eb;
  row := jsonb_build_object('equipment_id', ea, 'kind', 'superheat', 'value', 8, 'unit', 'K', 'input_value', 14.4, 'input_unit', 'dF',
          'measured_at', now(), 'method', 'instrument', 'quality', jsonb_build_array('ok'), 'idempotency_key', 'k-12345678');

  -- idempotency: replay returns the same id, one row
  m1 := asset_measurement_record(a, row); m2 := asset_measurement_record(a, row);
  ASSERT m1 = m2, 'replay must be idempotent';
  SELECT count(*) INTO n FROM asset_measurements WHERE user_id = a; ASSERT n = 1, 'exactly one row after replay';

  -- tenant isolation on write: tenant B cannot write to tenant A's equipment
  failed := false;
  BEGIN PERFORM asset_measurement_record(b, row || jsonb_build_object('idempotency_key', 'k-87654321'));
  EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  ASSERT failed, 'cross-tenant write must be rejected';

  -- append-only
  failed := false; BEGIN UPDATE asset_measurements SET value = 99 WHERE id = m1; EXCEPTION WHEN raise_exception THEN failed := true; END;
  ASSERT failed, 'UPDATE must be blocked';
  failed := false; BEGIN DELETE FROM asset_measurements WHERE id = m1; EXCEPTION WHEN raise_exception THEN failed := true; END;
  ASSERT failed, 'DELETE must be blocked';

  -- value checks
  failed := false; BEGIN PERFORM asset_measurement_record(a, row || jsonb_build_object('idempotency_key','k-bad00001','evidence_digest','zz')); EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'bad digest rejected';
  failed := false; BEGIN PERFORM asset_measurement_record(a, row || jsonb_build_object('idempotency_key','k-bad00002','method','derived')); EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'derived without inputs rejected';

  -- state upsert + unknown-has-no-value + tenant guard
  PERFORM asset_state_upsert(a, ea, jsonb_build_object('attribute','superheat','status','ok','value',8,'confidence',0.9));
  PERFORM asset_state_upsert(a, ea, jsonb_build_object('attribute','superheat','status','conflict','value',8,'confidence',0.5));
  SELECT count(*) INTO n FROM asset_state WHERE equipment_id = ea; ASSERT n = 1, 'upsert keeps one row per attribute';
  failed := false; BEGIN PERFORM asset_state_upsert(a, ea, jsonb_build_object('attribute','delta_t','status','unknown','value',5)); EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'unknown state may not carry a value';
  failed := false; BEGIN PERFORM asset_state_upsert(b, ea, jsonb_build_object('attribute','superheat','status','ok','value',1)); EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  ASSERT failed, 'cross-tenant state write rejected';

  -- flags: cannot enforce while shadow
  failed := false; BEGIN INSERT INTO asset_reality_flags(user_id, shadow, enforce) VALUES (a, true, true); EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'enforce requires shadow=false';

  -- RLS: authenticated user B sees none of A's rows; A sees own
  PERFORM set_config('test.uid', b::text, true); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM asset_measurements; ASSERT n = 0, 'B sees no A measurements';
  SELECT count(*) INTO n FROM asset_state; ASSERT n = 0, 'B sees no A state';
  failed := false; BEGIN INSERT INTO asset_state(user_id, equipment_id, attribute, status) VALUES (b, eb, 'x_y', 'ok'); EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  ASSERT failed, 'authenticated cannot write state directly';
  failed := false; BEGIN PERFORM asset_measurement_record(b, row); EXCEPTION WHEN insufficient_privilege THEN failed := true; END;
  ASSERT failed, 'authenticated cannot call record function';
  RESET ROLE; PERFORM set_config('test.uid', a::text, true); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM asset_measurements; ASSERT n = 1, 'A sees own measurement';
  RESET ROLE;
END $$;
ROLLBACK;
