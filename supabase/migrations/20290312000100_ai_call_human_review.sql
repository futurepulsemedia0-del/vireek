/*
  # Human review of AI calls (sampling queue, rubric, scores, prompt/eval feedback, monthly QA report)

  Distinct from csr_qa_* (that reviews HUMAN CSR calls). This reviews calls handled by the AI agent
  (calls.vapi_call_id IS NOT NULL).

  ## Flow
  1. Edge function `ai-call-qa-sample` (service role, cron) picks calls: random baseline + risk-weighted
     (emergency, price quotes/mismatch, complaints, human-transfer) -> ai_call_qa_items.
  2. Reviewers call ai_call_qa_claim_next() -> ai_call_qa_submit_review() (server computes score/verdict).
  3. Feedback rows (prompt / eval_case / knowledge / script) are triaged by reviewers.
  4. ai_call_qa_get_monthly_report() builds + caches the owner-visible monthly report.

  ## Security
  - OFF by default (ai_call_qa_settings.enabled=false); enabling requires owner + policy acknowledgement.
  - Tenant = get_account_owner_id(), never a client argument. Reviewers = public.can_edit_call_scripts()
    (account owner, or member with can_edit_business_profile).
  - Tables: RLS on, SELECT only; ALL writes go through SECURITY DEFINER RPCs or the service role.
  - Transcript shown to reviewers has card numbers / SSNs masked (ai_call_qa_redact). Reviewer notes are PII-scrubbed.
  - Rows reference calls ON DELETE CASCADE (DSAR erasure removes items/reviews).

  ## Requires
  profiles, team_members, calls, public.get_account_owner_id(), public.can_edit_call_scripts(), public.scrub_pii()
  (scrub_pii comes from 20290304000000_pilot_scorecard_and_call_feedback_loop.sql).

  ## Rollback
    DROP FUNCTION IF EXISTS public.ai_call_qa_claim_next(), public.ai_call_qa_release(uuid), public.ai_call_qa_skip(uuid),
      public.ai_call_qa_submit_review(uuid, jsonb, boolean, text, jsonb), public.ai_call_qa_set_feedback_status(uuid, text),
      public.ai_call_qa_set_settings(boolean, numeric, integer, jsonb, boolean), public.ai_call_qa_get_monthly_report(date),
      public.ai_call_qa_build_report(uuid, date), public.ai_call_qa_generate_reports(date), public.ai_call_qa_purge_expired(),
      public.ai_call_qa_redact(text), public.ai_call_qa_can_review();
    DROP TABLE IF EXISTS public.ai_call_qa_monthly_reports, public.ai_call_qa_feedback, public.ai_call_qa_reviews,
      public.ai_call_qa_items, public.ai_call_qa_rubrics, public.ai_call_qa_settings;
*/

CREATE OR REPLACE FUNCTION public.ai_call_qa_can_review()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.can_edit_call_scripts();
$$;
REVOKE ALL ON FUNCTION public.ai_call_qa_can_review() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_can_review() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ai_call_qa_redact(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(
           regexp_replace(left(coalesce(p_text, ''), 20000), '\m(?:\d[ -]?){13,19}\M', '[card]', 'g'),
           '\m\d{3}-\d{2}-\d{4}\M', '[ssn]', 'g');
$$;

-- 1. Settings --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_call_qa_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  random_rate numeric(5,4) NOT NULL DEFAULT 0.02 CHECK (random_rate BETWEEN 0 AND 0.5),
  daily_cap integer NOT NULL DEFAULT 25 CHECK (daily_cap BETWEEN 1 AND 500),
  risk_rates jsonb NOT NULL DEFAULT '{"emergency":1,"price_mismatch":1,"complaint":0.5,"price_quote":0.25,"human_transfer":0.25}'::jsonb,
  retention_days integer NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 730),
  policy_ack_at timestamptz,
  policy_ack_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Rubrics (global, versioned) ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_call_qa_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  criteria jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ai_call_qa_rubrics (version, criteria) VALUES (1, '[
  {"key":"accuracy","label":"Accuracy","weight":30,"description":"Facts, prices, availability and policies stated were correct and not invented."},
  {"key":"safety","label":"Emergency & safety handling","weight":25,"description":"Emergencies recognised and escalated; no unsafe advice. Mark N/A if no safety element."},
  {"key":"disclosure","label":"Disclosure & consent","weight":15,"description":"AI/recording disclosure given and caller choices honoured."},
  {"key":"resolution","label":"Resolution","weight":20,"description":"Caller need understood; correct next step (booking, transfer, callback) completed."},
  {"key":"tone","label":"Tone & clarity","weight":10,"description":"Professional, clear, appropriately empathetic."}
]'::jsonb) ON CONFLICT (version) DO NOTHING;

-- 3. Queue -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_call_qa_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES public.calls(id) ON DELETE CASCADE,
  call_at timestamptz NOT NULL,
  stratum text NOT NULL CHECK (stratum IN ('random', 'risk')),
  risk_flags text[] NOT NULL DEFAULT '{}',
  priority smallint NOT NULL DEFAULT 10,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_review', 'reviewed', 'skipped')),
  claimed_by uuid,
  claimed_at timestamptz,
  rubric_id uuid REFERENCES public.ai_call_qa_rubrics(id),
  sampling_version text NOT NULL DEFAULT 'v1',
  sampled_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_call_qa_items_queue ON public.ai_call_qa_items (account_owner_id, status, priority DESC, sampled_at);
CREATE INDEX IF NOT EXISTS idx_ai_call_qa_items_sampled ON public.ai_call_qa_items (account_owner_id, sampled_at);

-- 4. Reviews -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_call_qa_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL UNIQUE REFERENCES public.ai_call_qa_items(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rubric_id uuid NOT NULL REFERENCES public.ai_call_qa_rubrics(id),
  scores jsonb NOT NULL,
  overall smallint NOT NULL CHECK (overall BETWEEN 0 AND 100),
  critical_failure boolean NOT NULL DEFAULT false,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'needs_improvement', 'fail')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  reviewer_id uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_call_qa_reviews_owner ON public.ai_call_qa_reviews (account_owner_id, reviewed_at DESC);

-- 5. Feedback to prompts / evals ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_call_qa_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.ai_call_qa_reviews(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('prompt', 'eval_case', 'knowledge', 'script')),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 60),
  suggestion text NOT NULL CHECK (char_length(suggestion) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'done')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ai_call_qa_feedback_owner ON public.ai_call_qa_feedback (account_owner_id, status, created_at DESC);

-- 6. Monthly reports ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_call_qa_monthly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  metrics jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, month)
);

-- 7. RLS ---------------------------------------------------------------------
ALTER TABLE public.ai_call_qa_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_call_qa_rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_call_qa_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_call_qa_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_call_qa_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_call_qa_monthly_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_call_qa_settings_select ON public.ai_call_qa_settings;
CREATE POLICY ai_call_qa_settings_select ON public.ai_call_qa_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_call_qa_can_review());
DROP POLICY IF EXISTS ai_call_qa_rubrics_select ON public.ai_call_qa_rubrics;
CREATE POLICY ai_call_qa_rubrics_select ON public.ai_call_qa_rubrics FOR SELECT TO authenticated
  USING (public.ai_call_qa_can_review());
DROP POLICY IF EXISTS ai_call_qa_items_select ON public.ai_call_qa_items;
CREATE POLICY ai_call_qa_items_select ON public.ai_call_qa_items FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_call_qa_can_review());
DROP POLICY IF EXISTS ai_call_qa_reviews_select ON public.ai_call_qa_reviews;
CREATE POLICY ai_call_qa_reviews_select ON public.ai_call_qa_reviews FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_call_qa_can_review());
DROP POLICY IF EXISTS ai_call_qa_feedback_select ON public.ai_call_qa_feedback;
CREATE POLICY ai_call_qa_feedback_select ON public.ai_call_qa_feedback FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_call_qa_can_review());
DROP POLICY IF EXISTS ai_call_qa_reports_select ON public.ai_call_qa_monthly_reports;
CREATE POLICY ai_call_qa_reports_select ON public.ai_call_qa_monthly_reports FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_call_qa_can_review());

REVOKE ALL ON public.ai_call_qa_settings, public.ai_call_qa_rubrics, public.ai_call_qa_items, public.ai_call_qa_reviews,
  public.ai_call_qa_feedback, public.ai_call_qa_monthly_reports FROM anon, authenticated;
GRANT SELECT ON public.ai_call_qa_settings, public.ai_call_qa_rubrics, public.ai_call_qa_items, public.ai_call_qa_reviews,
  public.ai_call_qa_feedback, public.ai_call_qa_monthly_reports TO authenticated;

-- 8. Settings RPC (owner only) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_call_qa_set_settings(
  p_enabled boolean, p_random_rate numeric, p_daily_cap integer, p_risk_rates jsonb, p_policy_ack boolean DEFAULT false)
RETURNS public.ai_call_qa_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.ai_call_qa_settings;
  v_key text;
  v_val numeric;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can change AI call QA settings' USING ERRCODE = '42501';
  END IF;
  IF p_random_rate IS NULL OR p_random_rate < 0 OR p_random_rate > 0.5 THEN RAISE EXCEPTION 'random_rate must be between 0 and 0.5'; END IF;
  IF p_daily_cap IS NULL OR p_daily_cap < 1 OR p_daily_cap > 500 THEN RAISE EXCEPTION 'daily_cap must be between 1 and 500'; END IF;
  IF p_risk_rates IS NULL OR jsonb_typeof(p_risk_rates) <> 'object' THEN RAISE EXCEPTION 'risk_rates must be an object'; END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_risk_rates) LOOP
    IF v_key NOT IN ('emergency', 'price_mismatch', 'complaint', 'price_quote', 'human_transfer') THEN
      RAISE EXCEPTION 'Unknown risk flag: %', v_key;
    END IF;
    IF jsonb_typeof(p_risk_rates -> v_key) <> 'number' THEN RAISE EXCEPTION 'Rate for % must be a number', v_key; END IF;
    v_val := (p_risk_rates ->> v_key)::numeric;
    IF v_val < 0 OR v_val > 1 THEN RAISE EXCEPTION 'Rate for % must be between 0 and 1', v_key; END IF;
  END LOOP;
  IF COALESCE(p_enabled, false) AND NOT COALESCE(p_policy_ack, false)
     AND NOT EXISTS (SELECT 1 FROM public.ai_call_qa_settings s WHERE s.account_owner_id = v_owner AND s.policy_ack_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Policy acknowledgement is required to enable AI call review';
  END IF;

  INSERT INTO public.ai_call_qa_settings (account_owner_id, enabled, random_rate, daily_cap, risk_rates, policy_ack_at, policy_ack_by, updated_at)
  VALUES (v_owner, COALESCE(p_enabled, false), p_random_rate, p_daily_cap, p_risk_rates,
          CASE WHEN COALESCE(p_policy_ack, false) THEN now() END, CASE WHEN COALESCE(p_policy_ack, false) THEN auth.uid() END, now())
  ON CONFLICT (account_owner_id) DO UPDATE SET
    enabled = EXCLUDED.enabled, random_rate = EXCLUDED.random_rate, daily_cap = EXCLUDED.daily_cap,
    risk_rates = EXCLUDED.risk_rates,
    policy_ack_at = COALESCE(EXCLUDED.policy_ack_at, public.ai_call_qa_settings.policy_ack_at),
    policy_ack_by = COALESCE(EXCLUDED.policy_ack_by, public.ai_call_qa_settings.policy_ack_by),
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_set_settings(boolean, numeric, integer, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_set_settings(boolean, numeric, integer, jsonb, boolean) TO authenticated;

-- 9. Claim / release / skip ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_call_qa_claim_next()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item public.ai_call_qa_items;
  v_rubric public.ai_call_qa_rubrics;
  v_call record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ai_call_qa_can_review() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT i.* INTO v_item
    FROM public.ai_call_qa_items i
   WHERE i.account_owner_id = v_owner
     AND (i.status = 'queued'
          OR (i.status = 'in_review' AND (i.claimed_by = auth.uid() OR i.claimed_at < now() - interval '30 minutes')))
   ORDER BY (i.status = 'in_review' AND i.claimed_by = auth.uid()) DESC, i.priority DESC, i.sampled_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_rubric FROM public.ai_call_qa_rubrics WHERE active ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active rubric'; END IF;

  UPDATE public.ai_call_qa_items
     SET status = 'in_review', claimed_by = auth.uid(), claimed_at = now(), rubric_id = COALESCE(rubric_id, v_rubric.id)
   WHERE id = v_item.id
   RETURNING * INTO v_item;
  SELECT * INTO v_rubric FROM public.ai_call_qa_rubrics WHERE id = v_item.rubric_id;

  SELECT c.summary, c.transcript, c.duration_seconds, c.is_emergency, c.call_datetime
    INTO v_call
    FROM public.calls c WHERE c.id = v_item.call_id AND c.user_id = v_owner;

  RETURN jsonb_build_object(
    'item_id', v_item.id, 'call_id', v_item.call_id, 'call_at', v_item.call_at,
    'stratum', v_item.stratum, 'risk_flags', to_jsonb(v_item.risk_flags),
    'summary', v_call.summary, 'transcript', public.ai_call_qa_redact(v_call.transcript),
    'duration_seconds', v_call.duration_seconds, 'is_emergency', COALESCE(v_call.is_emergency, false),
    'rubric', jsonb_build_object('id', v_rubric.id, 'version', v_rubric.version, 'criteria', v_rubric.criteria));
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_claim_next() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_claim_next() TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_call_qa_release(p_item uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.ai_call_qa_can_review() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE public.ai_call_qa_items SET status = 'queued', claimed_by = NULL, claimed_at = NULL
   WHERE id = p_item AND account_owner_id = public.get_account_owner_id() AND status = 'in_review' AND claimed_by = auth.uid();
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_release(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_release(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_call_qa_skip(p_item uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.ai_call_qa_can_review() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE public.ai_call_qa_items SET status = 'skipped'
   WHERE id = p_item AND account_owner_id = public.get_account_owner_id() AND status = 'in_review' AND claimed_by = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Item is not claimed by you' USING ERRCODE = '42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_skip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_skip(uuid) TO authenticated;

-- 10. Submit review (server-side scoring) -------------------------------------
CREATE OR REPLACE FUNCTION public.ai_call_qa_submit_review(
  p_item uuid, p_scores jsonb, p_critical boolean, p_notes text, p_feedback jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item public.ai_call_qa_items;
  v_rubric public.ai_call_qa_rubrics;
  v_crit jsonb;
  v_key text;
  v_s numeric;
  v_num numeric := 0;
  v_den numeric := 0;
  v_scored integer := 0;
  v_overall integer;
  v_verdict text;
  v_review_id uuid;
  v_fb jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ai_call_qa_can_review() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_item FROM public.ai_call_qa_items WHERE id = p_item AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = '42501'; END IF;
  IF v_item.status <> 'in_review' OR v_item.claimed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Item is not claimed by you' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_rubric FROM public.ai_call_qa_rubrics WHERE id = v_item.rubric_id;

  IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'object' THEN RAISE EXCEPTION 'scores must be an object'; END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_scores) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rubric.criteria) c WHERE c ->> 'key' = v_key) THEN
      RAISE EXCEPTION 'Unknown criterion: %', v_key;
    END IF;
  END LOOP;
  FOR v_crit IN SELECT * FROM jsonb_array_elements(v_rubric.criteria) LOOP
    v_key := v_crit ->> 'key';
    IF p_scores ? v_key AND jsonb_typeof(p_scores -> v_key) = 'number' THEN
      v_s := (p_scores ->> v_key)::numeric;
      IF v_s <> trunc(v_s) OR v_s < 1 OR v_s > 5 THEN RAISE EXCEPTION 'Score for % must be an integer 1-5', v_key; END IF;
      v_num := v_num + (v_crit ->> 'weight')::numeric * (v_s - 1) / 4.0;
      v_den := v_den + (v_crit ->> 'weight')::numeric;
      v_scored := v_scored + 1;
    ELSIF p_scores ? v_key AND jsonb_typeof(p_scores -> v_key) <> 'null' THEN
      RAISE EXCEPTION 'Score for % must be a number or null', v_key;
    END IF;
  END LOOP;
  IF v_scored < 3 THEN RAISE EXCEPTION 'Score at least 3 criteria'; END IF;
  v_overall := round(100 * v_num / v_den);
  v_verdict := CASE WHEN COALESCE(p_critical, false) THEN 'fail'
                    WHEN v_overall >= 80 THEN 'pass' WHEN v_overall >= 60 THEN 'needs_improvement' ELSE 'fail' END;

  IF p_feedback IS NULL OR jsonb_typeof(p_feedback) <> 'array' OR jsonb_array_length(p_feedback) > 5 THEN
    RAISE EXCEPTION 'feedback must be an array of at most 5 items';
  END IF;

  INSERT INTO public.ai_call_qa_reviews (item_id, account_owner_id, rubric_id, scores, overall, critical_failure, verdict, notes, reviewer_id)
  VALUES (v_item.id, v_owner, v_rubric.id, p_scores, v_overall, COALESCE(p_critical, false), v_verdict,
          public.scrub_pii(p_notes), auth.uid())
  RETURNING id INTO v_review_id;

  FOR v_fb IN SELECT * FROM jsonb_array_elements(p_feedback) LOOP
    IF (v_fb ->> 'target') IS NULL OR (v_fb ->> 'target') NOT IN ('prompt', 'eval_case', 'knowledge', 'script') THEN
      RAISE EXCEPTION 'Invalid feedback target';
    END IF;
    INSERT INTO public.ai_call_qa_feedback (account_owner_id, review_id, target, category, suggestion, created_by)
    VALUES (v_owner, v_review_id, v_fb ->> 'target',
            left(btrim(coalesce(v_fb ->> 'category', '')), 60),
            left(coalesce(public.scrub_pii(v_fb ->> 'suggestion'), ''), 1000), auth.uid());
  END LOOP;

  UPDATE public.ai_call_qa_items SET status = 'reviewed' WHERE id = v_item.id;
  RETURN jsonb_build_object('review_id', v_review_id, 'overall', v_overall, 'verdict', v_verdict);
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_submit_review(uuid, jsonb, boolean, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_submit_review(uuid, jsonb, boolean, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_call_qa_set_feedback_status(p_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.ai_call_qa_can_review() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('open', 'accepted', 'rejected', 'done') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE public.ai_call_qa_feedback
     SET status = p_status,
         resolved_by = CASE WHEN p_status = 'open' THEN NULL ELSE auth.uid() END,
         resolved_at = CASE WHEN p_status = 'open' THEN NULL ELSE now() END
   WHERE id = p_id AND account_owner_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Feedback not found' USING ERRCODE = '42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_set_feedback_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_set_feedback_status(uuid, text) TO authenticated;

-- 11. Monthly report ---------------------------------------------------------------
-- NULL (never 0) when there is nothing to average. low_sample = fewer than 10 reviews in the month.
CREATE OR REPLACE FUNCTION public.ai_call_qa_build_report(p_owner uuid, p_month date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_s timestamptz := (date_trunc('month', p_month)::timestamp AT TIME ZONE 'UTC');
  v_e timestamptz := ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'UTC');
  v_sampled integer; v_reviewed integer; v_pending integer; v_skipped integer;
  v_avg numeric; v_pass integer; v_crit integer;
  v_strata jsonb; v_flags jsonb; v_criteria jsonb; v_fb jsonb;
BEGIN
  SELECT count(*) INTO v_sampled FROM public.ai_call_qa_items WHERE account_owner_id = p_owner AND sampled_at >= v_s AND sampled_at < v_e;
  SELECT count(*) INTO v_skipped FROM public.ai_call_qa_items WHERE account_owner_id = p_owner AND status = 'skipped' AND sampled_at >= v_s AND sampled_at < v_e;
  SELECT count(*) INTO v_pending FROM public.ai_call_qa_items WHERE account_owner_id = p_owner AND status IN ('queued', 'in_review');

  SELECT count(*), round(avg(r.overall), 1), count(*) FILTER (WHERE r.verdict = 'pass'), count(*) FILTER (WHERE r.critical_failure)
    INTO v_reviewed, v_avg, v_pass, v_crit
    FROM public.ai_call_qa_reviews r WHERE r.account_owner_id = p_owner AND r.reviewed_at >= v_s AND r.reviewed_at < v_e;

  SELECT COALESCE(jsonb_agg(q.x ORDER BY q.x ->> 'stratum'), '[]'::jsonb) INTO v_strata FROM (
    SELECT jsonb_build_object('stratum', i.stratum, 'reviewed', count(*), 'avg_overall', round(avg(r.overall), 1),
             'fail_rate', round(100.0 * count(*) FILTER (WHERE r.verdict = 'fail') / count(*), 1)) AS x
      FROM public.ai_call_qa_reviews r JOIN public.ai_call_qa_items i ON i.id = r.item_id
     WHERE r.account_owner_id = p_owner AND r.reviewed_at >= v_s AND r.reviewed_at < v_e GROUP BY i.stratum) q;

  SELECT COALESCE(jsonb_agg(q.x ORDER BY q.x ->> 'flag'), '[]'::jsonb) INTO v_flags FROM (
    SELECT jsonb_build_object('flag', f.flag, 'reviewed', count(*), 'avg_overall', round(avg(r.overall), 1),
             'fail_rate', round(100.0 * count(*) FILTER (WHERE r.verdict = 'fail') / count(*), 1)) AS x
      FROM public.ai_call_qa_reviews r JOIN public.ai_call_qa_items i ON i.id = r.item_id
      CROSS JOIN LATERAL unnest(i.risk_flags) AS f(flag)
     WHERE r.account_owner_id = p_owner AND r.reviewed_at >= v_s AND r.reviewed_at < v_e GROUP BY f.flag) q;

  SELECT COALESCE(jsonb_agg(q.x ORDER BY q.x ->> 'criterion'), '[]'::jsonb) INTO v_criteria FROM (
    SELECT jsonb_build_object('criterion', e.key, 'scored', count(*), 'avg_score', round(avg((e.value)::text::numeric), 2)) AS x
      FROM public.ai_call_qa_reviews r CROSS JOIN LATERAL jsonb_each(r.scores) AS e
     WHERE r.account_owner_id = p_owner AND r.reviewed_at >= v_s AND r.reviewed_at < v_e AND jsonb_typeof(e.value) = 'number'
     GROUP BY e.key) q;

  SELECT COALESCE(jsonb_agg(q.x ORDER BY q.x ->> 'target', q.x ->> 'status'), '[]'::jsonb) INTO v_fb FROM (
    SELECT jsonb_build_object('target', f.target, 'status', f.status, 'count', count(*)) AS x
      FROM public.ai_call_qa_feedback f WHERE f.account_owner_id = p_owner AND f.created_at >= v_s AND f.created_at < v_e
     GROUP BY f.target, f.status) q;

  RETURN jsonb_build_object(
    'month', to_char(v_s, 'YYYY-MM'), 'sampled', v_sampled, 'reviewed', v_reviewed, 'pending_now', v_pending, 'skipped', v_skipped,
    'review_rate', CASE WHEN v_sampled > 0 THEN round(100.0 * v_reviewed / v_sampled, 1) END,
    'avg_overall', v_avg, 'pass_rate', CASE WHEN v_reviewed > 0 THEN round(100.0 * v_pass / v_reviewed, 1) END,
    'critical_failures', v_crit, 'low_sample', v_reviewed < 10,
    'by_stratum', v_strata, 'by_risk_flag', v_flags, 'by_criterion', v_criteria, 'feedback', v_fb);
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_build_report(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_build_report(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_call_qa_get_monthly_report(p_month date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_month date;
  v_metrics jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.ai_call_qa_can_review() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN RAISE EXCEPTION 'month is required'; END IF;
  v_month := date_trunc('month', p_month)::date;
  IF v_month > date_trunc('month', now())::date THEN RAISE EXCEPTION 'month is in the future'; END IF;
  v_metrics := public.ai_call_qa_build_report(v_owner, v_month);
  INSERT INTO public.ai_call_qa_monthly_reports (account_owner_id, month, metrics) VALUES (v_owner, v_month, v_metrics)
  ON CONFLICT (account_owner_id, month) DO UPDATE SET metrics = EXCLUDED.metrics, generated_at = now();
  RETURN v_metrics;
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_get_monthly_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_get_monthly_report(date) TO authenticated;

-- Service role: monthly cron (run on the 1st for the previous month) and retention.
CREATE OR REPLACE FUNCTION public.ai_call_qa_generate_reports(p_month date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer := 0; v_owner uuid; v_month date := date_trunc('month', p_month)::date;
BEGIN
  FOR v_owner IN SELECT account_owner_id FROM public.ai_call_qa_settings WHERE enabled LOOP
    INSERT INTO public.ai_call_qa_monthly_reports (account_owner_id, month, metrics)
    VALUES (v_owner, v_month, public.ai_call_qa_build_report(v_owner, v_month))
    ON CONFLICT (account_owner_id, month) DO UPDATE SET metrics = EXCLUDED.metrics, generated_at = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_generate_reports(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_generate_reports(date) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_call_qa_purge_expired()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.ai_call_qa_items i USING public.ai_call_qa_settings s
   WHERE s.account_owner_id = i.account_owner_id AND i.sampled_at < now() - make_interval(days => s.retention_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.ai_call_qa_purge_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_call_qa_purge_expired() TO service_role;
