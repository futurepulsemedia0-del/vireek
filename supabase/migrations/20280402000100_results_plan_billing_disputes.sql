/*
  # Results Plan — Phase 2: job milestones, pricing terms, charges, disputes, flags, staff admin

  Requires 20280402000000_results_plan_proof_ledger.sql, jobs, calls, profiles, get_account_owner_id(), is_vireek_staff(auth.uid()).

  ## Safety
  - No price exists until staff approve a terms row (rp_staff_approve_terms). Billing code only reads status='approved'.
  - Charges are written ONLY by the service role. Owners can read their own and open a dispute through rp_open_dispute().
  - Every state change (qualified, charge_posted, voided, credited, dispute_resolved) is also appended to proof_ledger.
  - Owner-made "spam / wrong number / test" flags are ADVISORY: they do not stop billing until staff accept them
    (an owner must not be able to erase a charge by labelling a real job as spam).

  ## Rollback (before any data exists)
    DROP FUNCTION IF EXISTS rp_staff_overview(text), rp_staff_set_status(uuid,text,text), rp_staff_resolve_dispute(uuid,boolean,text),
      rp_staff_resolve_job_flag(uuid,boolean), rp_staff_approve_terms(uuid), rp_staff_publish_rules(text), rp_open_dispute(uuid,text);
    DROP TABLE IF EXISTS results_plan_flags, results_plan_disputes, results_plan_charges, results_plan_job_flags, results_plan_pricing_terms;
    ALTER TABLE jobs DROP COLUMN IF EXISTS confirmed_at, DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS paid_at, DROP COLUMN IF EXISTS job_source;
    DROP TRIGGER IF EXISTS trg_rp_job_milestones ON jobs; DROP FUNCTION IF EXISTS rp_job_milestones();

  ## Cron (run ONCE in the SQL editor; replace <project-ref> and <CRON_SECRET> = RESULTS_PLAN_CRON_SECRET)
    select cron.schedule('results-plan-ingest', '*/20 * * * *', $$ select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/results-plan-ingest',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'), body := '{}'::jsonb); $$);
    select cron.schedule('results-plan-bill', '5,35 * * * *', $$ select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/results-plan-bill',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'), body := '{}'::jsonb); $$);
*/

-- =============================================================
-- 1. Job milestone columns (jobs.completed_at already exists)
-- =============================================================
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS job_source text CHECK (job_source IS NULL OR job_source IN ('sarah', 'owner', 'crm_import', 'test'));

CREATE OR REPLACE FUNCTION public.rp_job_milestones()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.job_status IN ('en_route', 'in_progress', 'completed') AND NEW.confirmed_at IS NULL THEN NEW.confirmed_at := now(); END IF;
    IF NEW.job_status = 'cancelled' AND NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
    IF NEW.invoice_status = 'paid' AND NEW.paid_at IS NULL THEN NEW.paid_at := now(); END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: first-time milestones only; reopening a job never rewrites history (the ledger keeps the original event).
  IF NEW.job_status IN ('en_route', 'in_progress', 'completed') AND NEW.confirmed_at IS NULL THEN NEW.confirmed_at := now(); END IF;
  IF NEW.job_status = 'cancelled' AND OLD.job_status IS DISTINCT FROM 'cancelled' THEN NEW.cancelled_at := now(); END IF;
  IF NEW.job_status <> 'cancelled' AND OLD.job_status = 'cancelled' THEN NEW.cancelled_at := NULL; END IF;
  IF NEW.invoice_status = 'paid' AND OLD.invoice_status IS DISTINCT FROM 'paid' THEN NEW.paid_at := now(); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rp_job_milestones ON jobs;
CREATE TRIGGER trg_rp_job_milestones BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.rp_job_milestones();

CREATE INDEX IF NOT EXISTS idx_jobs_rp_user_created ON jobs(user_id, created_at DESC);

-- =============================================================
-- 2. Pricing terms (NO rows are seeded: no price exists until approved)
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_pricing_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  model text NOT NULL CHECK (model IN ('hybrid', 'per_job')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  base_fee_cents integer NOT NULL DEFAULT 0 CHECK (base_fee_cents BETWEEN 0 AND 100000000),
  per_job_cents integer NOT NULL CHECK (per_job_cents BETWEEN 1 AND 100000000),
  tier_price_cents jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tier_price_cents) = 'object'),
  monthly_floor_cents integer NOT NULL DEFAULT 0 CHECK (monthly_floor_cents BETWEEN 0 AND 100000000),
  monthly_cap_cents integer CHECK (monthly_cap_cents IS NULL OR monthly_cap_cents BETWEEN 1 AND 100000000),
  guarantee_days integer NOT NULL DEFAULT 0 CHECK (guarantee_days BETWEEN 0 AND 90),
  guarantee_cap_cents integer CHECK (guarantee_cap_cents IS NULL OR guarantee_cap_cents BETWEEN 1 AND 100000000),
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  rule_version text NOT NULL DEFAULT 'rp-rules-v1' REFERENCES results_plan_rule_versions(version),
  is_public boolean NOT NULL DEFAULT false,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rp_terms_model_fee CHECK ((model = 'per_job' AND base_fee_cents = 0) OR (model = 'hybrid' AND monthly_floor_cents = 0)),
  CONSTRAINT rp_terms_floor_cap CHECK (monthly_cap_cents IS NULL OR monthly_floor_cents <= monthly_cap_cents),
  CONSTRAINT rp_terms_approved_stamp CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

ALTER TABLE results_plan_pricing_terms ENABLE ROW LEVEL SECURITY;
-- Approved terms flagged is_public may be shown on the public pricing page.
DROP POLICY IF EXISTS "public_read_terms" ON results_plan_pricing_terms;
CREATE POLICY "public_read_terms" ON results_plan_pricing_terms FOR SELECT TO anon, authenticated USING (status = 'approved' AND is_public);
-- Owners see only terms attached to their own account (and only approved ones).
DROP POLICY IF EXISTS "staff_all_terms_select" ON results_plan_pricing_terms;
CREATE POLICY "staff_all_terms_select" ON results_plan_pricing_terms FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_pricing_terms FROM anon, authenticated;

-- Approved terms are immutable (retire + create a new row instead).
CREATE OR REPLACE FUNCTION public.rp_terms_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'approved' THEN RAISE EXCEPTION 'approved terms cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NOT (NEW.status = 'retired' AND ROW(NEW.name, NEW.model, NEW.currency, NEW.base_fee_cents, NEW.per_job_cents, NEW.tier_price_cents, NEW.monthly_floor_cents, NEW.monthly_cap_cents, NEW.guarantee_days, NEW.guarantee_cap_cents, NEW.trial_days, NEW.rule_version)
      IS NOT DISTINCT FROM ROW(OLD.name, OLD.model, OLD.currency, OLD.base_fee_cents, OLD.per_job_cents, OLD.tier_price_cents, OLD.monthly_floor_cents, OLD.monthly_cap_cents, OLD.guarantee_days, OLD.guarantee_cap_cents, OLD.trial_days, OLD.rule_version)) THEN
    RAISE EXCEPTION 'approved terms are immutable (retire them and create a new row)';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS trg_rp_terms_immutable ON results_plan_pricing_terms;
CREATE TRIGGER trg_rp_terms_immutable BEFORE UPDATE OR DELETE ON results_plan_pricing_terms
  FOR EACH ROW EXECUTE FUNCTION public.rp_terms_immutable();

-- Account additions
ALTER TABLE results_plan_accounts
  ADD COLUMN IF NOT EXISTS terms_id uuid REFERENCES results_plan_pricing_terms(id),
  ADD COLUMN IF NOT EXISTS never_exceed_flat boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS flat_plan_cents integer CHECK (flat_plan_cents IS NULL OR flat_plan_cents BETWEEN 1 AND 100000000),
  ADD COLUMN IF NOT EXISTS prior_plan text,
  ADD COLUMN IF NOT EXISTS last_cap_alert_month text,
  ADD COLUMN IF NOT EXISTS last_cap_alert_pct smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_ingest_at timestamptz;

-- Owner-visible terms for the attached row only
DROP POLICY IF EXISTS "owner_select_attached_terms" ON results_plan_pricing_terms;
CREATE POLICY "owner_select_attached_terms" ON results_plan_pricing_terms FOR SELECT TO authenticated
  USING (status IN ('approved', 'retired') AND EXISTS (SELECT 1 FROM results_plan_accounts a WHERE a.terms_id = results_plan_pricing_terms.id AND a.user_id = public.get_account_owner_id()));

-- =============================================================
-- 3. Charges (one per verified job; state changes are mirrored into proof_ledger)
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed', 'voided', 'credited')),
  job_type text,
  verified_at timestamptz NOT NULL,
  month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  terms_id uuid REFERENCES results_plan_pricing_terms(id),
  list_price_cents integer CHECK (list_price_cents IS NULL OR list_price_cents >= 0),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  bound_by text CHECK (bound_by IS NULL OR bound_by IN ('none', 'monthly_cap', 'flat_plan_cap', 'guarantee_cap')),
  stripe_meter_identifier text,
  stripe_balance_txn_id text,
  failure_reason text,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rp_charge_unique_job UNIQUE (user_id, job_id),
  CONSTRAINT rp_charge_posted_has_amount CHECK (status NOT IN ('posted', 'credited') OR amount_cents IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_rp_charges_user_month ON results_plan_charges(user_id, month, verified_at);
CREATE INDEX IF NOT EXISTS idx_rp_charges_pending ON results_plan_charges(status) WHERE status IN ('pending', 'failed');

ALTER TABLE results_plan_charges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_rp_charges" ON results_plan_charges;
CREATE POLICY "select_own_rp_charges" ON results_plan_charges FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_rp_charges" ON results_plan_charges;
CREATE POLICY "staff_select_rp_charges" ON results_plan_charges FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_charges FROM anon, authenticated;

-- =============================================================
-- 4. Job flags (owner flags are advisory until staff accept)
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_job_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  flag text NOT NULL CHECK (flag IN ('spam', 'wrong_number', 'test')),
  source text NOT NULL CHECK (source IN ('owner', 'staff', 'system')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  accepted_at timestamptz,
  rejected_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rp_job_flag_unique UNIQUE (user_id, job_id, flag)
);
ALTER TABLE results_plan_job_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_rp_job_flags" ON results_plan_job_flags;
CREATE POLICY "select_own_rp_job_flags" ON results_plan_job_flags FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_rp_job_flags" ON results_plan_job_flags;
CREATE POLICY "insert_own_rp_job_flags" ON results_plan_job_flags FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND source = 'owner' AND accepted_at IS NULL AND rejected_at IS NULL
              AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS "staff_select_rp_job_flags" ON results_plan_job_flags;
CREATE POLICY "staff_select_rp_job_flags" ON results_plan_job_flags FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE UPDATE, DELETE, TRUNCATE ON results_plan_job_flags FROM anon, authenticated;
REVOKE INSERT ON results_plan_job_flags FROM anon;

-- =============================================================
-- 5. Disputes
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  charge_id uuid NOT NULL UNIQUE REFERENCES results_plan_charges(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'auto_credited', 'upheld', 'credited_by_review')),
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  opened_by uuid DEFAULT auth.uid(),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);
CREATE INDEX IF NOT EXISTS idx_rp_disputes_open ON results_plan_disputes(status, opened_at) WHERE status = 'open';
ALTER TABLE results_plan_disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_rp_disputes" ON results_plan_disputes;
CREATE POLICY "select_own_rp_disputes" ON results_plan_disputes FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_rp_disputes" ON results_plan_disputes;
CREATE POLICY "staff_select_rp_disputes" ON results_plan_disputes FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_disputes FROM anon, authenticated;

-- Owner opens a dispute. Mirrors _shared/results-plan/dispute.ts (keep both in sync; tests cover the TS side).
CREATE OR REPLACE FUNCTION public.rp_open_dispute(p_charge uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  c results_plan_charges%ROWTYPE; a results_plan_accounts%ROWTYPE; j jobs%ROWTYPE;
  v_owner uuid := public.get_account_owner_id();
  v_dispute uuid; v_has_call boolean; v_q jsonb; v_reasons text[]; v_completion boolean; v_confirmation boolean;
  v_reason text := btrim(COALESCE(p_reason, '')); v_auto boolean := false; v_why text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN RAISE EXCEPTION 'REASON_LENGTH'; END IF;
  SELECT * INTO c FROM results_plan_charges WHERE id = p_charge AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF c.status NOT IN ('pending', 'posted') THEN RAISE EXCEPTION 'CHARGE_NOT_DISPUTABLE'; END IF;
  IF now() - COALESCE(c.posted_at, c.created_at) > interval '14 days' THEN RAISE EXCEPTION 'DISPUTE_WINDOW_CLOSED'; END IF;
  IF EXISTS (SELECT 1 FROM results_plan_disputes WHERE charge_id = c.id) THEN RAISE EXCEPTION 'ALREADY_DISPUTED'; END IF;
  SELECT * INTO a FROM results_plan_accounts WHERE user_id = v_owner;

  INSERT INTO results_plan_disputes (user_id, charge_id, reason) VALUES (v_owner, c.id, v_reason) RETURNING id INTO v_dispute;
  PERFORM public.proof_ledger_append(v_owner, c.job_id, 'disputed', 'dispute-open:' || v_dispute::text, a.rule_version,
    jsonb_build_object('dispute_id', v_dispute, 'charge_id', c.id));

  SELECT * INTO j FROM jobs WHERE id = c.job_id AND user_id = v_owner;
  v_has_call := FOUND AND j.call_id IS NOT NULL AND EXISTS (SELECT 1 FROM calls WHERE id = j.call_id AND user_id = v_owner);
  SELECT evidence INTO v_q FROM proof_ledger WHERE user_id = v_owner AND job_id = c.job_id AND event_type = 'qualified' ORDER BY seq DESC LIMIT 1;
  v_reasons := COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_q -> 'reasons', '[]'::jsonb))), '{}');
  v_completion := EXISTS (SELECT 1 FROM proof_ledger WHERE user_id = v_owner AND job_id = c.job_id AND event_type = 'completed');
  v_confirmation := EXISTS (SELECT 1 FROM proof_ledger WHERE user_id = v_owner AND job_id = c.job_id AND event_type IN ('confirmed', 'completed'));

  IF NOT v_has_call THEN v_auto := true; v_why := 'No call/text/chat record supports first contact by Sarah.';
  ELSIF j.id IS NULL THEN v_auto := true; v_why := 'No booking record exists for this job.';
  ELSIF v_q IS NULL OR cardinality(v_reasons) > 0 THEN v_auto := true; v_why := 'Rule check failed or was never recorded.';
  ELSIF a.billing_level IN ('completed', 'paid') AND NOT v_completion THEN v_auto := true; v_why := 'Billing level requires completion and no completion event exists.';
  ELSIF a.billing_level = 'confirmed' AND NOT v_confirmation THEN v_auto := true; v_why := 'Billing level requires confirmation and none exists.';
  END IF;

  IF v_auto THEN
    UPDATE results_plan_disputes SET status = 'auto_credited', decision_note = v_why, resolved_at = now() WHERE id = v_dispute;
    UPDATE results_plan_charges SET status = CASE WHEN c.status = 'posted' THEN 'credited' ELSE 'voided' END, updated_at = now() WHERE id = c.id;
    PERFORM public.proof_ledger_append(v_owner, c.job_id, 'credited', 'credit:' || c.id::text, a.rule_version,
      jsonb_build_object('charge_id', c.id, 'amount_cents', c.amount_cents, 'auto', true, 'why', v_why));
    PERFORM public.proof_ledger_append(v_owner, c.job_id, 'dispute_resolved', 'dispute-resolved:' || v_dispute::text, a.rule_version,
      jsonb_build_object('dispute_id', v_dispute, 'outcome', 'auto_credited', 'why', v_why));
    RETURN jsonb_build_object('dispute_id', v_dispute, 'outcome', 'auto_credited', 'why', v_why);
  END IF;
  RETURN jsonb_build_object('dispute_id', v_dispute, 'outcome', 'in_review');
END $$;
REVOKE ALL ON FUNCTION public.rp_open_dispute(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rp_open_dispute(uuid, text) TO authenticated;

-- =============================================================
-- 6. Anomaly flags
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code IN ('completion_marking_drop', 'relabel_after_charge', 'qualification_spike')),
  severity text NOT NULL CHECK (severity IN ('info', 'warn', 'high')),
  detail text NOT NULL CHECK (char_length(detail) <= 500),
  week_start date NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rp_flags_unique UNIQUE (user_id, code, week_start)
);
ALTER TABLE results_plan_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_select_rp_flags" ON results_plan_flags;
CREATE POLICY "staff_select_rp_flags" ON results_plan_flags FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_flags FROM anon, authenticated;

-- =============================================================
-- 7. Staff admin RPCs (all gated by is_vireek_staff(auth.uid()))
-- =============================================================
CREATE OR REPLACE FUNCTION public.rp_staff_guard() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; END $$;
REVOKE ALL ON FUNCTION public.rp_staff_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rp_staff_guard() TO authenticated;

CREATE OR REPLACE FUNCTION public.rp_staff_approve_terms(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.rp_staff_guard();
  UPDATE results_plan_pricing_terms SET status = 'approved', approved_at = now(), approved_by = auth.uid() WHERE id = p_id AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_A_DRAFT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rp_staff_publish_rules(p_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.rp_staff_guard();
  UPDATE results_plan_rule_versions SET published_at = COALESCE(published_at, now()) WHERE version = p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rp_staff_set_status(p_user uuid, p_status text, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.rp_staff_guard();
  IF p_status NOT IN ('paused', 'active') THEN RAISE EXCEPTION 'BAD_STATUS'; END IF;
  UPDATE results_plan_accounts SET status = p_status, paused_reason = CASE WHEN p_status = 'paused' THEN left(p_reason, 300) ELSE NULL END, updated_at = now()
   WHERE user_id = p_user AND (p_status = 'paused' OR opted_in_at IS NOT NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rp_staff_resolve_dispute(p_id uuid, p_uphold boolean, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE d results_plan_disputes%ROWTYPE; c results_plan_charges%ROWTYPE; v_rule text;
BEGIN
  PERFORM public.rp_staff_guard();
  SELECT * INTO d FROM results_plan_disputes WHERE id = p_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_OPEN'; END IF;
  SELECT * INTO c FROM results_plan_charges WHERE id = d.charge_id FOR UPDATE;
  SELECT rule_version INTO v_rule FROM results_plan_accounts WHERE user_id = d.user_id;
  IF p_uphold THEN
    UPDATE results_plan_disputes SET status = 'upheld', decision_note = left(p_note, 1000), resolved_at = now(), resolved_by = auth.uid() WHERE id = d.id;
  ELSE
    UPDATE results_plan_disputes SET status = 'credited_by_review', decision_note = left(p_note, 1000), resolved_at = now(), resolved_by = auth.uid() WHERE id = d.id;
    UPDATE results_plan_charges SET status = CASE WHEN c.status = 'posted' THEN 'credited' ELSE 'voided' END, updated_at = now() WHERE id = c.id;
    PERFORM public.proof_ledger_append(d.user_id, c.job_id, 'credited', 'credit:' || c.id::text, v_rule,
      jsonb_build_object('charge_id', c.id, 'amount_cents', c.amount_cents, 'auto', false));
  END IF;
  PERFORM public.proof_ledger_append(d.user_id, c.job_id, 'dispute_resolved', 'dispute-resolved:' || d.id::text, v_rule,
    jsonb_build_object('dispute_id', d.id, 'outcome', CASE WHEN p_uphold THEN 'upheld' ELSE 'credited_by_review' END));
END $$;

CREATE OR REPLACE FUNCTION public.rp_staff_resolve_job_flag(p_id uuid, p_accept boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.rp_staff_guard();
  UPDATE results_plan_job_flags SET accepted_at = CASE WHEN p_accept THEN now() END, rejected_at = CASE WHEN p_accept THEN NULL ELSE now() END
   WHERE id = p_id AND accepted_at IS NULL AND rejected_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_PENDING'; END IF;
END $$;

-- Per-account month overview for the margin dashboard. Costs are computed client-side from unitEconomics.ts.
CREATE OR REPLACE FUNCTION public.rp_staff_overview(p_month text)
RETURNS TABLE (user_id uuid, company_name text, status text, verified_jobs bigint, billed_cents bigint, credited_cents bigint,
               base_fee_cents integer, open_disputes bigint, high_flags bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.rp_staff_guard();
  IF p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'BAD_MONTH'; END IF;
  RETURN QUERY
  SELECT a.user_id, p.company_name, a.status,
         COUNT(c.*) FILTER (WHERE c.status IN ('pending', 'posted')),
         COALESCE(SUM(c.amount_cents) FILTER (WHERE c.status = 'posted'), 0)::bigint,
         COALESCE(SUM(c.amount_cents) FILTER (WHERE c.status = 'credited'), 0)::bigint,
         COALESCE(t.base_fee_cents, 0),
         (SELECT COUNT(*) FROM results_plan_disputes d WHERE d.user_id = a.user_id AND d.status = 'open'),
         (SELECT COUNT(*) FROM results_plan_flags f WHERE f.user_id = a.user_id AND f.severity = 'high' AND f.resolved_at IS NULL)
    FROM results_plan_accounts a
    JOIN profiles p ON p.id = a.user_id
    LEFT JOIN results_plan_pricing_terms t ON t.id = a.terms_id
    LEFT JOIN results_plan_charges c ON c.user_id = a.user_id AND c.month = p_month
   GROUP BY a.user_id, p.company_name, a.status, t.base_fee_cents
   ORDER BY a.user_id;
END $$;

REVOKE ALL ON FUNCTION public.rp_staff_approve_terms(uuid), public.rp_staff_publish_rules(text), public.rp_staff_set_status(uuid, text, text),
  public.rp_staff_resolve_dispute(uuid, boolean, text), public.rp_staff_resolve_job_flag(uuid, boolean), public.rp_staff_overview(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rp_staff_approve_terms(uuid), public.rp_staff_publish_rules(text), public.rp_staff_set_status(uuid, text, text),
  public.rp_staff_resolve_dispute(uuid, boolean, text), public.rp_staff_resolve_job_flag(uuid, boolean), public.rp_staff_overview(text) TO authenticated;
