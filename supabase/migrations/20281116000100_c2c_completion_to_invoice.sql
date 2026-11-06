/*
  # Call-to-cash slice 2: completed job -> DRAFT invoice (idempotent, flag-gated)

  Requires 20281116000000_c2c_state_machine_foundation.sql.

  Scope (deliberately narrow, nothing invented):
    - Source of price = the job's linked ACCEPTED quote (jobs.quote_id). line_items and tax_percent are
      copied as-is, so existing totals/tax logic keep producing identical cents.
    - No linked accepted quote -> no invoice is invented; the job stays visible in c2c_workflow_health()
      as 'completed_without_invoice' for a human.
    - The invoice is created as 'draft'. Sending / payment collection stay on the existing paths.
    - Parts/labor not in the quote are NOT added here (no verified price source) -> reported as a gap.

  Idempotency: unique index on invoices(job_id) WHERE c2c_auto, plus "any live invoice already exists" check.
  Crash recovery: c2c_sweep_completed_jobs() is safe to run repeatedly.

  Rollback: UPDATE feature_flags SET enabled=false WHERE key='c2c_orchestration';
*/

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS c2c_auto boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_c2c_auto_job
  ON invoices (job_id) WHERE c2c_auto AND job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.c2c_draft_invoice_for_job(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job   jobs;
  v_quote quotes;
  v_inv   uuid;
BEGIN
  -- Row lock serialises concurrent sweeps for the same job.
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'job_not_found'); END IF;
  IF NOT public.c2c_orchestration_enabled(v_job.user_id) THEN RETURN jsonb_build_object('result', 'flag_off'); END IF;
  IF v_job.job_status <> 'completed' THEN RETURN jsonb_build_object('result', 'not_completed'); END IF;
  IF public.job_is_automation_locked(v_job.id) THEN RETURN jsonb_build_object('result', 'operator_locked'); END IF;

  SELECT id INTO v_inv FROM invoices WHERE job_id = v_job.id AND status <> 'void' ORDER BY created_at LIMIT 1;
  IF v_inv IS NOT NULL THEN RETURN jsonb_build_object('result', 'already_invoiced', 'invoice_id', v_inv); END IF;

  IF v_job.quote_id IS NULL THEN RETURN jsonb_build_object('result', 'no_quote'); END IF;
  SELECT * INTO v_quote FROM quotes WHERE id = v_job.quote_id AND user_id = v_job.user_id AND status = 'accepted';
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'quote_not_accepted'); END IF;

  INSERT INTO invoices (user_id, job_id, quote_id, customer_name, customer_email, customer_phone,
                        line_items, tax_percent, status, due_date, c2c_auto)
  VALUES (v_job.user_id, v_job.id, v_quote.id, v_quote.customer_name, v_quote.customer_email, v_quote.customer_phone,
          v_quote.line_items, v_quote.tax_percent, 'draft', current_date + 14, true)
  ON CONFLICT (job_id) WHERE c2c_auto AND job_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_inv;

  IF v_inv IS NULL THEN
    SELECT id INTO v_inv FROM invoices WHERE job_id = v_job.id AND c2c_auto;
    RETURN jsonb_build_object('result', 'already_invoiced', 'invoice_id', v_inv);
  END IF;

  PERFORM public.append_activity_event(
    p_aggregate_type := 'job', p_aggregate_id := v_job.id, p_event_type := 'invoice.drafted',
    p_event_data := jsonb_build_object('job_id', v_job.id, 'invoice_id', v_inv, 'quote_id', v_quote.id),
    p_actor_type := 'system',
    p_correlation_id := public.c2c_current_trace_id(COALESCE(v_job.call_id, v_job.id)),
    p_user_id := v_job.user_id);

  RETURN jsonb_build_object('result', 'drafted', 'invoice_id', v_inv);
END;
$$;

REVOKE ALL ON FUNCTION public.c2c_draft_invoice_for_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c2c_draft_invoice_for_job(uuid) TO service_role;

-- Retry-safe sweep: bounded batch, oldest first, per-job failure isolation.
CREATE OR REPLACE FUNCTION public.c2c_sweep_completed_jobs(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid; v_res jsonb; v_drafted int := 0; v_skipped int := 0; v_failed int := 0;
BEGIN
  FOR v_id IN
    SELECT j.id FROM jobs j
    WHERE j.job_status = 'completed' AND j.quote_id IS NOT NULL
      AND j.completed_at IS NOT NULL AND j.completed_at > now() - interval '30 days'
      AND public.c2c_orchestration_enabled(j.user_id)
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status <> 'void')
    ORDER BY j.completed_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  LOOP
    BEGIN
      v_res := public.c2c_draft_invoice_for_job(v_id);
      IF v_res->>'result' = 'drafted' THEN v_drafted := v_drafted + 1; ELSE v_skipped := v_skipped + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'c2c_sweep_completed_jobs: job % failed: %', v_id, SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object('drafted', v_drafted, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;

REVOKE ALL ON FUNCTION public.c2c_sweep_completed_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c2c_sweep_completed_jobs(integer) TO service_role;
