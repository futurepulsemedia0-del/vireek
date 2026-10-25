-- scripts/seed-closeout-demo.sql
-- Demo data for Install Closeout Autopilot. Safe to run more than once.
-- 1) Put YOUR login email below.  2) Run it in the Supabase SQL editor.
-- It never raises an error: if something is missing it prints a NOTICE and stops.
--
-- The rules created here are clearly marked "DEMO" and carry a placeholder source URL
-- and NO verified date. Replace them (Closeout > Rules) with real, verified sources.

DO $seed$
DECLARE
  v_email text := 'YOUR_LOGIN_EMAIL@example.com';
  v_owner uuid;
  v_job uuid;
  v_closeout uuid;
BEGIN
  SELECT id INTO v_owner FROM auth.users WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE NOTICE 'No user with email %. Edit v_email at the top of this script.', v_email;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.closeout_rules WHERE user_id = v_owner AND name LIKE 'DEMO %') THEN
    INSERT INTO public.closeout_rules
      (user_id, step_kind, name, deadline_days, required_evidence, requires_pre_approval,
       default_owner_role, estimated_value_cents, source_url, last_verified_at, notes)
    VALUES
      (v_owner, 'permit', 'DEMO permit rule', 30,
        ARRAY['permit_number','install_date'], false, 'office', 0,
        'https://example.com/replace-with-your-permit-office', NULL, 'Placeholder - replace with your AHJ rule.'),
      (v_owner, 'inspection', 'DEMO final inspection rule', 45,
        ARRAY['inspection_pass','photos'], false, 'technician', 0,
        'https://example.com/replace-with-your-permit-office', NULL, 'Placeholder.'),
      (v_owner, 'warranty', 'DEMO manufacturer warranty registration', 60,
        ARRAY['serial_number','model_number','install_date','proof_of_purchase'], false, 'technician', 45000,
        'https://example.com/replace-with-manufacturer-terms', NULL, 'Placeholder - value is an estimate.'),
      (v_owner, 'rebate', 'DEMO utility rebate (pre-approval)', 90,
        ARRAY['serial_number','model_number','ahri_certificate','invoice','photos'], true, 'office', 120000,
        'https://example.com/replace-with-program-page', NULL, 'Placeholder - requires pre-approval.'),
      (v_owner, 'documents', 'DEMO customer handover pack', 14,
        ARRAY['invoice','customer_signature'], false, 'office', 0,
        'https://example.com/internal-policy', NULL, 'Placeholder.');
  END IF;

  -- Attach a closeout to your most recent COMPLETED job that has none yet
  -- (completed jobs are never blocked by the pre-approval start gate).
  SELECT j.id INTO v_job
  FROM public.jobs j
  WHERE j.user_id = v_owner AND j.job_status::text = 'completed'
    AND NOT EXISTS (SELECT 1 FROM public.closeout_jobs c WHERE c.job_id = j.id)
  ORDER BY j.created_at DESC LIMIT 1;

  IF v_job IS NULL THEN
    RAISE NOTICE 'Rules seeded. No completed job without a closeout was found - start one from a job page.';
    RETURN;
  END IF;

  v_closeout := public.closeout_create_internal(v_owner, v_job, current_date - 20, NULL, NULL, NULL, v_owner);
  RAISE NOTICE 'Seeded closeout % for job %.', v_closeout, v_job;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Seed skipped: %', SQLERRM;
END
$seed$;
