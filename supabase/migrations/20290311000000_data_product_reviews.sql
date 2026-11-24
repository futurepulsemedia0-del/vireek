/*
  # Data product reviews (approval gate for external data endpoints)

  ## Why
  Vireek already releases aggregate data outside the tenant boundary (insights-api, evidence-marketplace-api,
  state-of-calls-public). Each has its own privacy gates (k-anonymity, noise, immutable releases), but nothing records
  WHO decided the product may be released, to WHOM, for WHAT purpose, after WHICH privacy review. This migration adds
  that record and a fail-closed lookup the edge functions call.

  ## What this adds
  1. data_product_reviews         one row per review of a data product (product, purpose, recipients, privacy review,
                                  approver, decision). Content is frozen once a decision is made: a material change
                                  is a NEW review.
  2. data_product_review_events   append-only history (written by trigger only).
  3. Staff RPCs                   data_product_request_review / _record_privacy_review / _decide / _revoke
                                  (is_vireek_staff() inside; approver comes from auth.uid(), never from an argument).
  4. data_product_gate(key, endpoint)  fail-closed lookup, service_role only. Used by _shared/data-products/guard.ts.
  5. Three PENDING seed reviews (insights, evidence marketplace, state of calls). Seeds are never approved here.

  ## Rules enforced in the database (trigger), not only in the UI
  * approver != requester, and privacy reviewer != requester (no solo exception: releasing data externally by one
    person alone is the risk this control exists for);
  * approval needs: a completed privacy review, re-identification risk below 'high', every criterion in
    data_product_required_criteria() attested true, at least one covered endpoint, an expiry <= 366 days out,
    and a counsel_reference when the product contains personal data [COUNSEL];
  * external recipients without personal data need min_cohort_size >= 5 (the lowest k used by any existing flow);
  * a decided review cannot be edited, deleted, or un-decided; approved -> revoked is the only transition after a decision.

  ## Behaviour change (read before deploying)
  Nothing changes at runtime until DATA_PRODUCT_GATE_MODE=enforce is set on the edge functions. The default is
  'shadow' (log only), the same pattern as FABRIC_SIG_MODE. Approve the three seeded reviews first, then flip the mode.

  ## Safety
  Idempotent. No DROP, no DELETE, no existing policy touched. Client roles get SELECT only (staff policy); every write
  goes through the SECURITY DEFINER RPCs above.

  ## Rollback
    DROP FUNCTION IF EXISTS public.data_product_gate(text, text);
    DROP FUNCTION IF EXISTS public.data_product_revoke(uuid, text);
    DROP FUNCTION IF EXISTS public.data_product_decide(uuid, text, text, integer);
    DROP FUNCTION IF EXISTS public.data_product_record_privacy_review(uuid, text, integer, text, jsonb, text);
    DROP FUNCTION IF EXISTS public.data_product_request_review(text, text, text, text[], text[], jsonb, boolean);
    DROP TABLE IF EXISTS public.data_product_review_events;
    DROP TABLE IF EXISTS public.data_product_reviews;
  (drop only after setting DATA_PRODUCT_GATE_MODE back to shadow, otherwise enforce-mode endpoints fail closed.)
*/

-- =============================================================
-- A. Constants as functions (kept in sync with docs/data/monetization-ethics.md by a CI test)
-- =============================================================
CREATE OR REPLACE FUNCTION public.data_product_required_criteria()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY['E1','E2','E3','E4','E5','E6','E7','E8']::text[] $$;

CREATE OR REPLACE FUNCTION public.data_product_recipients_valid(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  el jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 20 THEN
    RETURN false;
  END IF;
  FOR el IN SELECT value FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(el) <> 'object'
       OR (el ->> 'class') IS NULL OR (el ->> 'class') NOT IN ('internal', 'subscriber', 'partner', 'public')
       OR (el ->> 'name') IS NULL OR char_length(btrim(el ->> 'name')) NOT BETWEEN 1 AND 120 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- =============================================================
-- B. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS public.data_product_reviews (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key            text NOT NULL CHECK (product_key ~ '^[a-z0-9_]{2,48}$'),
  product_name           text NOT NULL CHECK (char_length(btrim(product_name)) BETWEEN 1 AND 120),
  purpose                text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 20 AND 2000),
  endpoints              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(endpoints) <= 20),
  source_flows           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_flows) <= 20),
  recipients             jsonb NOT NULL CHECK (public.data_product_recipients_valid(recipients)),
  contains_personal_data boolean NOT NULL DEFAULT false,
  -- privacy review
  reidentification_risk  text CHECK (reidentification_risk IS NULL OR reidentification_risk IN ('low', 'medium', 'high')),
  min_cohort_size        integer CHECK (min_cohort_size IS NULL OR min_cohort_size >= 1),
  privacy_summary        text CHECK (privacy_summary IS NULL OR char_length(btrim(privacy_summary)) BETWEEN 40 AND 4000),
  criteria_version       text,
  criteria_checklist     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(criteria_checklist) = 'object'),
  counsel_reference      text CHECK (counsel_reference IS NULL OR char_length(btrim(counsel_reference)) BETWEEN 3 AND 500),
  privacy_reviewed_by    uuid,  -- no FK on purpose: the audit record must survive staff offboarding
  privacy_reviewed_at    timestamptz,
  -- decision
  decision               text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected', 'revoked')),
  decision_reason        text CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 3 AND 2000),
  decided_by             uuid,  -- approver; no FK, same reason
  decided_at             timestamptz,
  valid_until            timestamptz,
  requested_by           uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dpr_decided_has_actor CHECK (decision = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT dpr_pending_has_no_decision CHECK (decision <> 'pending' OR (decided_by IS NULL AND decided_at IS NULL AND valid_until IS NULL)),
  CONSTRAINT dpr_negative_needs_reason CHECK (decision NOT IN ('rejected', 'revoked') OR decision_reason IS NOT NULL),
  CONSTRAINT dpr_approved_has_expiry CHECK (decision <> 'approved' OR valid_until IS NOT NULL)
);

-- At most one open (pending) review per product; a decided review never blocks a new request.
CREATE UNIQUE INDEX IF NOT EXISTS data_product_reviews_one_pending
  ON public.data_product_reviews (product_key) WHERE decision = 'pending';
CREATE INDEX IF NOT EXISTS data_product_reviews_gate_idx
  ON public.data_product_reviews (product_key, decision, valid_until);

CREATE TABLE IF NOT EXISTS public.data_product_review_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id  uuid NOT NULL REFERENCES public.data_product_reviews(id) ON DELETE RESTRICT,
  event      text NOT NULL CHECK (event IN ('requested', 'privacy_reviewed', 'approved', 'rejected', 'revoked')),
  actor      uuid,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_product_review_events_review_idx
  ON public.data_product_review_events (review_id, id);

ALTER TABLE public.data_product_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_product_review_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.data_product_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.data_product_review_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.data_product_reviews TO authenticated;
GRANT SELECT ON public.data_product_review_events TO authenticated;
GRANT ALL ON public.data_product_reviews TO service_role;
GRANT ALL ON public.data_product_review_events TO service_role;

DROP POLICY IF EXISTS "staff_select_data_product_reviews" ON public.data_product_reviews;
CREATE POLICY "staff_select_data_product_reviews" ON public.data_product_reviews
  FOR SELECT TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));

DROP POLICY IF EXISTS "staff_select_data_product_review_events" ON public.data_product_review_events;
CREATE POLICY "staff_select_data_product_review_events" ON public.data_product_review_events
  FOR SELECT TO authenticated
  USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))));
-- No INSERT / UPDATE / DELETE policy: clients never write. Writes = SECURITY DEFINER RPCs (below) or service_role.

COMMENT ON TABLE public.data_product_reviews IS
  'Approval record for releasing a data product outside the tenant boundary. Content frozen after a decision. See docs/data/monetization-ethics.md.';

-- =============================================================
-- C. State machine + invariants (BEFORE INSERT/UPDATE/DELETE)
-- =============================================================
CREATE OR REPLACE FUNCTION public.data_product_reviews_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_missing text[];
  v_external boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DPR_IMMUTABLE: data product reviews are evidence and cannot be deleted' USING ERRCODE = '42501';
  END IF;

  v_external := EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.recipients) r WHERE (r.value ->> 'class') <> 'internal'
  );

  IF TG_OP = 'INSERT' THEN
    IF NEW.decision <> 'pending' THEN
      RAISE EXCEPTION 'DPR_STATE: a review is created as pending' USING ERRCODE = '22023';
    END IF;
    NEW.requested_by := COALESCE(v_uid, NEW.requested_by);
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- ---- UPDATE ----
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.product_key IS DISTINCT FROM OLD.product_key
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DPR_IMMUTABLE: id, product_key, requested_by and created_at never change' USING ERRCODE = '42501';
  END IF;

  IF OLD.decision <> 'pending' THEN
    -- Decided: only approved -> revoked is allowed, and nothing but the decision fields may move.
    IF NOT (OLD.decision = 'approved' AND NEW.decision = 'revoked') THEN
      RAISE EXCEPTION 'DPR_STATE: a % review cannot change (only approved -> revoked)', OLD.decision USING ERRCODE = '22023';
    END IF;
    IF (NEW.product_name, NEW.purpose, NEW.endpoints, NEW.source_flows, NEW.recipients, NEW.contains_personal_data,
        NEW.reidentification_risk, NEW.min_cohort_size, NEW.privacy_summary, NEW.criteria_version, NEW.criteria_checklist,
        NEW.counsel_reference, NEW.privacy_reviewed_by, NEW.privacy_reviewed_at, NEW.valid_until)
       IS DISTINCT FROM
       (OLD.product_name, OLD.purpose, OLD.endpoints, OLD.source_flows, OLD.recipients, OLD.contains_personal_data,
        OLD.reidentification_risk, OLD.min_cohort_size, OLD.privacy_summary, OLD.criteria_version, OLD.criteria_checklist,
        OLD.counsel_reference, OLD.privacy_reviewed_by, OLD.privacy_reviewed_at, OLD.valid_until) THEN
      RAISE EXCEPTION 'DPR_IMMUTABLE: a decided review is frozen; a material change is a new review' USING ERRCODE = '42501';
    END IF;
    IF v_uid IS NOT NULL THEN NEW.decided_by := v_uid; END IF;
    IF NEW.decided_by IS NULL OR NOT public.is_vireek_staff(NEW.decided_by) THEN
      RAISE EXCEPTION 'DPR_AUTH: only Vireek staff can revoke' USING ERRCODE = '42501';
    END IF;
    NEW.decided_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Pending: content may change while it is a draft. Privacy-review stamp is bound to the caller.
  IF (NEW.reidentification_risk, NEW.min_cohort_size, NEW.privacy_summary, NEW.criteria_checklist, NEW.counsel_reference)
     IS DISTINCT FROM
     (OLD.reidentification_risk, OLD.min_cohort_size, OLD.privacy_summary, OLD.criteria_checklist, OLD.counsel_reference) THEN
    IF v_uid IS NOT NULL THEN NEW.privacy_reviewed_by := v_uid; END IF;
    NEW.privacy_reviewed_at := now();
    NEW.criteria_version := COALESCE(NEW.criteria_version, 'monetization-ethics/v1');
  END IF;
  IF NEW.privacy_reviewed_by IS NOT NULL AND OLD.requested_by IS NOT NULL AND NEW.privacy_reviewed_by = OLD.requested_by THEN
    RAISE EXCEPTION 'DPR_SEPARATION: the privacy reviewer cannot be the requester' USING ERRCODE = '42501';
  END IF;

  IF NEW.decision = 'pending' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.decision = 'revoked' THEN
    RAISE EXCEPTION 'DPR_STATE: only an approved review can be revoked' USING ERRCODE = '22023';
  END IF;

  -- pending -> approved | rejected: the decider is the caller and must be staff.
  IF v_uid IS NOT NULL THEN NEW.decided_by := v_uid; END IF;
  IF NEW.decided_by IS NULL OR NOT public.is_vireek_staff(NEW.decided_by) THEN
    RAISE EXCEPTION 'DPR_AUTH: only Vireek staff can decide a review' USING ERRCODE = '42501';
  END IF;
  NEW.decided_at := now();
  NEW.updated_at := now();

  IF NEW.decision = 'rejected' THEN
    NEW.valid_until := NULL;
    RETURN NEW;
  END IF;

  -- ---- approval gates ----
  IF OLD.requested_by IS NOT NULL AND NEW.decided_by = OLD.requested_by THEN
    RAISE EXCEPTION 'DPR_SEPARATION: the approver cannot be the requester' USING ERRCODE = '42501';
  END IF;
  IF NEW.privacy_reviewed_by IS NULL OR NEW.privacy_reviewed_at IS NULL OR NEW.privacy_summary IS NULL
     OR NEW.reidentification_risk IS NULL OR NEW.min_cohort_size IS NULL THEN
    RAISE EXCEPTION 'DPR_PRIVACY_REVIEW: the privacy review is incomplete (reviewer, summary, risk and cohort size are required)' USING ERRCODE = '22023';
  END IF;
  IF NEW.reidentification_risk = 'high' THEN
    RAISE EXCEPTION 'DPR_PRIVACY_REVIEW: a high re-identification risk cannot be approved; mitigate and re-review' USING ERRCODE = '22023';
  END IF;
  IF v_external AND NOT NEW.contains_personal_data AND NEW.min_cohort_size < 5 THEN
    RAISE EXCEPTION 'DPR_PRIVACY_REVIEW: external release needs min_cohort_size >= 5 (got %)', NEW.min_cohort_size USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(c ORDER BY c) INTO v_missing
  FROM unnest(public.data_product_required_criteria()) AS c
  WHERE COALESCE(NEW.criteria_checklist -> c, 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'DPR_CRITERIA: criteria not attested true: %', array_to_string(v_missing, ', ') USING ERRCODE = '22023';
  END IF;
  IF cardinality(NEW.endpoints) = 0 THEN
    RAISE EXCEPTION 'DPR_ENDPOINTS: an approval must name at least one covered endpoint' USING ERRCODE = '22023';
  END IF;
  IF NEW.contains_personal_data AND NEW.counsel_reference IS NULL THEN
    RAISE EXCEPTION 'DPR_COUNSEL: a product with personal data needs a counsel_reference [COUNSEL]' USING ERRCODE = '22023';
  END IF;
  IF NEW.valid_until IS NULL OR NEW.valid_until <= now() OR NEW.valid_until > now() + interval '366 days' THEN
    RAISE EXCEPTION 'DPR_EXPIRY: valid_until must be in the future and at most 366 days out' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_data_product_reviews_guard ON public.data_product_reviews;
CREATE TRIGGER trg_data_product_reviews_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.data_product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.data_product_reviews_guard();

-- History: written by trigger only; never updated or deleted.
CREATE OR REPLACE FUNCTION public.data_product_reviews_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'requested';
  ELSIF NEW.decision <> OLD.decision THEN
    v_event := NEW.decision;
  ELSIF (NEW.reidentification_risk, NEW.min_cohort_size, NEW.privacy_summary, NEW.criteria_checklist, NEW.counsel_reference)
        IS DISTINCT FROM
        (OLD.reidentification_risk, OLD.min_cohort_size, OLD.privacy_summary, OLD.criteria_checklist, OLD.counsel_reference) THEN
    v_event := 'privacy_reviewed';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO public.data_product_review_events (review_id, event, actor, detail)
  VALUES (
    NEW.id, v_event,
    CASE v_event WHEN 'requested' THEN NEW.requested_by WHEN 'privacy_reviewed' THEN NEW.privacy_reviewed_by ELSE NEW.decided_by END,
    jsonb_build_object('product_key', NEW.product_key, 'decision', NEW.decision, 'reason', NEW.decision_reason, 'valid_until', NEW.valid_until)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_data_product_reviews_log ON public.data_product_reviews;
CREATE TRIGGER trg_data_product_reviews_log
  AFTER INSERT OR UPDATE ON public.data_product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.data_product_reviews_log();

CREATE OR REPLACE FUNCTION public.data_product_review_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'DPR_IMMUTABLE: review history is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_data_product_review_events_immutable ON public.data_product_review_events;
CREATE TRIGGER trg_data_product_review_events_immutable
  BEFORE UPDATE OR DELETE ON public.data_product_review_events
  FOR EACH ROW EXECUTE FUNCTION public.data_product_review_events_immutable();

-- =============================================================
-- D. Staff RPCs (approver = auth.uid(); service_role has no uid and cannot decide)
-- =============================================================
CREATE OR REPLACE FUNCTION public.data_product_request_review(
  p_product_key text,
  p_product_name text,
  p_purpose text,
  p_endpoints text[],
  p_source_flows text[],
  p_recipients jsonb,
  p_contains_personal_data boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_bad text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'DPR_AUTH: staff only' USING ERRCODE = '42501';
  END IF;
  SELECT f INTO v_bad FROM unnest(COALESCE(p_source_flows, '{}')) f
  WHERE NOT EXISTS (SELECT 1 FROM public.cross_tenant_flows c WHERE c.flow_key = f) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'DPR_FLOW: % is not registered in cross_tenant_flows', v_bad USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.data_product_reviews (product_key, product_name, purpose, endpoints, source_flows, recipients, contains_personal_data)
  VALUES (p_product_key, p_product_name, p_purpose, COALESCE(p_endpoints, '{}'), COALESCE(p_source_flows, '{}'), p_recipients, COALESCE(p_contains_personal_data, false))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.data_product_record_privacy_review(
  p_review_id uuid,
  p_reidentification_risk text,
  p_min_cohort_size integer,
  p_summary text,
  p_criteria jsonb,
  p_counsel_reference text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'DPR_AUTH: staff only' USING ERRCODE = '42501';
  END IF;
  IF p_criteria IS NULL OR jsonb_typeof(p_criteria) <> 'object' THEN
    RAISE EXCEPTION 'DPR_CRITERIA: criteria must be a JSON object' USING ERRCODE = '22023';
  END IF;
  UPDATE public.data_product_reviews
  SET reidentification_risk = p_reidentification_risk,
      min_cohort_size = p_min_cohort_size,
      privacy_summary = p_summary,
      criteria_checklist = p_criteria,
      counsel_reference = p_counsel_reference,
      criteria_version = 'monetization-ethics/v1'
  WHERE id = p_review_id AND decision = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'DPR_STATE: review not found or not pending' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.data_product_decide(
  p_review_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL,
  p_valid_days integer DEFAULT 365
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'DPR_AUTH: staff only' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'DPR_STATE: decision must be approved or rejected' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'approved' AND (p_valid_days IS NULL OR p_valid_days NOT BETWEEN 1 AND 366) THEN
    RAISE EXCEPTION 'DPR_EXPIRY: valid_days must be between 1 and 366' USING ERRCODE = '22023';
  END IF;
  UPDATE public.data_product_reviews
  SET decision = p_decision,
      decision_reason = p_reason,
      valid_until = CASE WHEN p_decision = 'approved' THEN now() + make_interval(days => p_valid_days) END
  WHERE id = p_review_id AND decision = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'DPR_STATE: review not found or not pending' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.data_product_revoke(p_review_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'DPR_AUTH: staff only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.data_product_reviews
  SET decision = 'revoked', decision_reason = p_reason
  WHERE id = p_review_id AND decision = 'approved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'DPR_STATE: review not found or not approved' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.data_product_request_review(text, text, text, text[], text[], jsonb, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.data_product_record_privacy_review(uuid, text, integer, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.data_product_decide(uuid, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.data_product_revoke(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.data_product_request_review(text, text, text, text[], text[], jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.data_product_record_privacy_review(uuid, text, integer, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.data_product_decide(uuid, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.data_product_revoke(uuid, text) TO authenticated;
-- Each RPC checks is_vireek_staff(auth.uid()) itself; non-staff authenticated users get 42501.

-- =============================================================
-- E. The gate (service_role only; fail closed)
-- =============================================================
CREATE OR REPLACE FUNCTION public.data_product_gate(p_product_key text, p_endpoint text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r public.data_product_reviews;
  v_reason text;
BEGIN
  IF p_product_key IS NULL OR p_endpoint IS NULL OR p_product_key !~ '^[a-z0-9_]{2,48}$' OR btrim(p_endpoint) = '' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_arguments');
  END IF;

  SELECT * INTO r FROM public.data_product_reviews
  WHERE product_key = p_product_key AND decision = 'approved' AND valid_until > now() AND p_endpoint = ANY (endpoints)
  ORDER BY decided_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'approved', 'review_id', r.id, 'valid_until', r.valid_until);
  END IF;

  v_reason := CASE
    WHEN EXISTS (SELECT 1 FROM public.data_product_reviews WHERE product_key = p_product_key AND decision = 'approved' AND valid_until > now()) THEN 'endpoint_not_covered'
    WHEN EXISTS (SELECT 1 FROM public.data_product_reviews WHERE product_key = p_product_key AND decision = 'approved') THEN 'expired'
    WHEN EXISTS (SELECT 1 FROM public.data_product_reviews WHERE product_key = p_product_key AND decision = 'revoked') THEN 'revoked'
    WHEN EXISTS (SELECT 1 FROM public.data_product_reviews WHERE product_key = p_product_key AND decision = 'pending') THEN 'pending'
    WHEN EXISTS (SELECT 1 FROM public.data_product_reviews WHERE product_key = p_product_key AND decision = 'rejected') THEN 'rejected'
    ELSE 'no_review'
  END;
  RETURN jsonb_build_object('allowed', false, 'reason', v_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.data_product_gate(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_product_gate(text, text) TO service_role;

-- =============================================================
-- F. Seed: three PENDING reviews for products that already exist (descriptions taken from the code headers)
--    Never approved here. Skipped when the product already has any review, so re-runs are no-ops.
-- =============================================================
INSERT INTO public.data_product_reviews (product_key, product_name, purpose, endpoints, source_flows, recipients, contains_personal_data)
SELECT v.product_key, v.product_name, v.purpose, v.endpoints, v.source_flows, v.recipients::jsonb, false
FROM (VALUES
  ('vireek_insights', 'Vireek Insights',
   'Quarterly k-anonymous industry percentile indexes (p25/p50/p75) built from businesses that opted in, sold to API subscribers.',
   ARRAY['insights-api']::text[], ARRAY[]::text[],
   '[{"class":"subscriber","name":"Vireek Insights API subscribers"}]'),
  ('evidence_marketplace', 'Evidence Marketplace',
   'Immutable releases of anonymized, k-anonymous aggregate failure and reliability patterns for approved partners (OEMs, suppliers, insurers, contractors, training providers).',
   ARRAY['evidence-marketplace-api']::text[], ARRAY[]::text[],
   '[{"class":"partner","name":"Approved evidence partners"}]'),
  ('state_of_calls', 'State of Calls report',
   'Published, frozen report editions of aggregate call statistics served publicly as JSON, CSV and embeddable charts.',
   ARRAY['state-of-calls-public']::text[], ARRAY[]::text[],
   '[{"class":"public","name":"Public readers"}]')
) AS v(product_key, product_name, purpose, endpoints, source_flows, recipients)
WHERE NOT EXISTS (SELECT 1 FROM public.data_product_reviews d WHERE d.product_key = v.product_key);
