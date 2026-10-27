-- Install Closeout — demo seed (safe to run more than once).
-- Run in the Supabase SQL editor. It uses the FIRST owner account and its most recent jobs.
-- All programs are clearly marked DEMO and point at example.org: replace them with the real rules
-- (and real source URLs) your team has verified. Nothing here is real program data.

DO $$
DECLARE
  v_owner uuid;
  v_job uuid;
  v_case uuid;
  v_i integer := 0;
  v_install integer[] := ARRAY[45, 20, 3];   -- days ago: one overdue, one near the deadline, one fresh
BEGIN
  SELECT id INTO v_owner FROM profiles WHERE role = 'owner' ORDER BY id LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE NOTICE 'No owner profile found — nothing seeded.';
    RETURN;
  END IF;

  INSERT INTO closeout_programs (user_id, step_key, name, administrator, anchor, deadline_days, requires_pre_approval,
      required_evidence, enrollment_requirements, estimated_value_cents, auto_attach, source_url, last_verified_on, reverify_days, notes, is_active)
  VALUES
    (v_owner, 'permit', 'DEMO — City mechanical permit', 'Demo building department', 'install_date', 14, false,
      ARRAY['permit_number'], ARRAY['Licensed contractor on file'], NULL, true,
      'https://example.org/demo/permit', current_date, 180, 'DEMO RULE — replace with your verified local rule.', true),
    (v_owner, 'inspection', 'DEMO — Final inspection', 'Demo building department', 'permit_completed', 30, false,
      ARRAY['inspection_report', 'photo'], ARRAY[]::text[], NULL, true,
      'https://example.org/demo/inspection', current_date, 180, 'DEMO RULE.', true),
    (v_owner, 'warranty', 'DEMO — Manufacturer warranty registration', 'Demo manufacturer', 'install_date', 60, false,
      ARRAY['serial_number', 'model_number', 'install_date'], ARRAY['Register within the program window'], 25000, true,
      'https://example.org/demo/warranty', current_date, 180, 'DEMO RULE.', true),
    (v_owner, 'rebate', 'DEMO — Utility rebate (pre-approval)', 'Demo utility', 'install_date', 90, true,
      ARRAY['invoice', 'serial_number', 'model_number', 'photo'], ARRAY['Customer account number', 'Participating contractor'], 150000, true,
      'https://example.org/demo/rebate', current_date, 90, 'DEMO RULE — pre-approval required before install.', true),
    (v_owner, 'customer_docs', 'DEMO — Customer handover package', 'Internal', 'job_complete', 7, false,
      ARRAY['invoice', 'warranty_confirmation'], ARRAY[]::text[], NULL, true,
      'https://example.org/demo/handover', current_date, 365, 'DEMO RULE.', true)
  ON CONFLICT DO NOTHING;

  FOR v_job IN SELECT id FROM jobs WHERE user_id = v_owner ORDER BY created_at DESC LIMIT 3
  LOOP
    v_i := v_i + 1;
    v_case := public.closeout_open_case_internal(v_owner, v_job, current_date - v_install[v_i]);
  END LOOP;

  PERFORM public.closeout_engine_tick();
  RAISE NOTICE 'Install Closeout demo seeded for owner % (% case(s)).', v_owner, v_i;
END $$;
