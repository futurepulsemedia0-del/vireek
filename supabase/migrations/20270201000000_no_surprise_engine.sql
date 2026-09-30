/*
  # Vireek «No-Surprise» Engine

  Product principle: NO UNEXPECTED COST FOR THE CUSTOMER.
  Before a technician enters a step that is likely to raise the price, the customer is told:
  why, how much (range), the options, necessary vs optional, and what happens if they do nothing.
  The customer decides. The decision is sealed into the Job Evidence Chain.

  ## What this adds
  - no_surprise_requests : one disclosure per "additional work may be required" event.
      * Server-authoritative: status, cost range, expiry, author, decision fields are set/validated by triggers.
      * Append-only in spirit: content is frozen at insert; only pending -> approved/declined/expired/withdrawn
        is possible (customer decisions go through get/respond RPCs, staff can only withdraw).
  - Evidence Chain integration (uses existing record_job_evidence_system, nothing existing is modified):
      * disclosure  -> stage 'recommendation'   (actor 'system', staff identity preserved)
      * approved    -> stage 'customer_approval' (actor 'customer', refs -> disclosure)
      * declined    -> stage 'recommendation'   (actor 'customer'; never counted as an approval)
      * expired / withdrawn -> stage 'recommendation' (actor 'system')
  - get_no_surprise_room(token)      : public, token-gated (jobs.reschedule_token), what the customer sees.
  - respond_no_surprise_request(...) : public, token-gated, the customer's signed decision.
  - no_surprise_job_status(job)      : server-side «Certified No-Surprise Service» evaluation.
  - no_surprise_expire_job(job)      : lets the dashboard flush expired requests.
  - In-app notification (type 'job_update') when the customer decides or a request expires.

  Requires: 20261231000000_job_evidence_chain.sql, quotes, notifications. Safe to run on top of the current schema.
*/

-- =============================================================
-- 1. OPTIONS VALIDATOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.ns_options_valid(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  o jsonb;
  ids text[] := '{}';
  performs integer := 0;
  v_oid text;
  lo numeric;
  hi numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 4 THEN
    RETURN false;
  END IF;

  FOR o IN SELECT value FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' THEN RETURN false; END IF;

    v_oid := o->>'id';
    IF v_oid IS NULL OR v_oid !~ '^[a-z0-9_-]{1,20}$' OR v_oid = ANY (ids) THEN RETURN false; END IF;
    ids := ids || v_oid;

    IF coalesce(char_length(btrim(o->>'label')), 0) NOT BETWEEN 1 AND 120 THEN RETURN false; END IF;
    IF char_length(coalesce(o->>'description', '')) > 500 THEN RETURN false; END IF;
    IF coalesce(o->>'kind', '') NOT IN ('perform', 'defer') THEN RETURN false; END IF;

    IF jsonb_typeof(o->'cost_low_cents') IS DISTINCT FROM 'number'
       OR jsonb_typeof(o->'cost_high_cents') IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;

    lo := (o->>'cost_low_cents')::numeric;
    hi := (o->>'cost_high_cents')::numeric;
    IF lo <> trunc(lo) OR hi <> trunc(hi) OR lo < 0 OR hi < lo OR hi > 100000000 THEN RETURN false; END IF;

    IF o->>'kind' = 'perform' THEN
      performs := performs + 1;
    ELSIF hi <> 0 THEN
      RETURN false; -- deferring never costs anything
    END IF;
  END LOOP;

  RETURN performs >= 1;
END;
$$;

-- =============================================================
-- 2. TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.no_surprise_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'withdrawn')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  trigger_note text CHECK (trigger_note IS NULL OR char_length(trigger_note) <= 2000),
  why text NOT NULL CHECK (char_length(btrim(why)) BETWEEN 10 AND 2000),
  necessity text NOT NULL CHECK (necessity IN ('required', 'recommended', 'optional')),
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  consequence text NOT NULL CHECK (char_length(btrim(consequence)) BETWEEN 10 AND 1500),
  options jsonb NOT NULL CHECK (public.ns_options_valid(options)),
  cost_low_cents integer NOT NULL DEFAULT 0 CHECK (cost_low_cents >= 0),
  cost_high_cents integer NOT NULL DEFAULT 0 CHECK (cost_high_cents >= cost_low_cents),
  work_paused boolean NOT NULL DEFAULT true,
  ai_assisted boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  disclosure_entry_id uuid,
  decision_entry_id uuid,
  decided_at timestamptz,
  decided_option_id text,
  approved_cost_high_cents integer CHECK (approved_cost_high_cents IS NULL OR approved_cost_high_cents >= 0),
  signed_name text CHECK (signed_name IS NULL OR char_length(btrim(signed_name)) BETWEEN 2 AND 120),
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  risk_acknowledged boolean NOT NULL DEFAULT false,
  decision_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(decision_context) = 'object'),
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR char_length(withdrawn_reason) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_ns_requests_job ON public.no_surprise_requests (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ns_requests_user_pending ON public.no_surprise_requests (user_id) WHERE status = 'pending';

COMMENT ON TABLE public.no_surprise_requests IS
  'Vireek No-Surprise Engine: cost disclosures raised before a step that may increase the price. Customer decision is sealed in the Job Evidence Chain.';

-- =============================================================
-- 3. TRIGGERS: prepare / guard
-- =============================================================

-- Internal transitions (customer decision, expiry, evidence back-links) are flagged by a transaction-local setting.
CREATE OR REPLACE FUNCTION public.ns_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_job_status text;
  v_pending integer;
  v_tm uuid;
  v_name text;
  v_low integer;
  v_high integer;
BEGIN
  SELECT j.user_id, j.job_status INTO v_owner, v_job_status FROM public.jobs j WHERE j.id = NEW.job_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'NO_SURPRISE_INVALID: unknown job' USING ERRCODE = 'P0001';
  END IF;
  IF v_job_status IN ('completed', 'cancelled', 'no_show') THEN
    RAISE EXCEPTION 'NO_SURPRISE_JOB_CLOSED: this job is already closed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.ns_options_valid(NEW.options) THEN
    RAISE EXCEPTION 'NO_SURPRISE_INVALID: options are not valid' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:no-surprise:' || NEW.job_id::text, 0));
  PERFORM public.ns_expire_due(NEW.job_id);

  SELECT count(*) INTO v_pending FROM public.no_surprise_requests r WHERE r.job_id = NEW.job_id AND r.status = 'pending';
  IF v_pending >= 3 THEN
    RAISE EXCEPTION 'NO_SURPRISE_LIMIT: resolve the open requests on this job first' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT tm.id, tm.member_name INTO v_tm, v_name FROM public.team_members tm WHERE tm.user_id = auth.uid() LIMIT 1;
    IF v_name IS NULL THEN
      SELECT u.email INTO v_name FROM auth.users u WHERE u.id = auth.uid();
    END IF;
  END IF;

  SELECT min((o->>'cost_low_cents')::integer), max((o->>'cost_high_cents')::integer)
  INTO v_low, v_high
  FROM jsonb_array_elements(NEW.options) o
  WHERE o->>'kind' = 'perform';

  NEW.user_id := v_owner;
  NEW.title := btrim(NEW.title);
  NEW.why := btrim(NEW.why);
  NEW.consequence := btrim(NEW.consequence);
  NEW.cost_low_cents := coalesce(v_low, 0);
  NEW.cost_high_cents := coalesce(v_high, 0);
  NEW.expires_at := least(greatest(coalesce(NEW.expires_at, now() + interval '48 hours'), now() + interval '30 minutes'), now() + interval '7 days');
  NEW.created_by := auth.uid();
  NEW.created_by_name := v_name;
  NEW.created_at := now();

  NEW.status := 'pending';
  NEW.decided_at := NULL;
  NEW.decided_option_id := NULL;
  NEW.approved_cost_high_cents := NULL;
  NEW.signed_name := NULL;
  NEW.decision_note := NULL;
  NEW.risk_acknowledged := false;
  NEW.decision_context := '{}'::jsonb;
  NEW.withdrawn_reason := NULL;
  NEW.disclosure_entry_id := NULL;
  NEW.decision_entry_id := NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ns_before_insert ON public.no_surprise_requests;
CREATE TRIGGER trg_ns_before_insert
  BEFORE INSERT ON public.no_surprise_requests
  FOR EACH ROW EXECUTE FUNCTION public.ns_before_insert();

CREATE OR REPLACE FUNCTION public.ns_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_internal boolean := coalesce(current_setting('vireek.ns_internal', true), 'off') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'NO_SURPRISE_IMMUTABLE: requests cannot be deleted' USING ERRCODE = 'P0001';
  END IF;

  -- Frozen content
  IF (OLD.job_id, OLD.user_id, OLD.title, OLD.trigger_note, OLD.why, OLD.necessity, OLD.risk_level, OLD.consequence,
      OLD.options, OLD.cost_low_cents, OLD.cost_high_cents, OLD.work_paused, OLD.ai_assisted, OLD.expires_at,
      OLD.created_by, OLD.created_by_name, OLD.created_at)
     IS DISTINCT FROM
     (NEW.job_id, NEW.user_id, NEW.title, NEW.trigger_note, NEW.why, NEW.necessity, NEW.risk_level, NEW.consequence,
      NEW.options, NEW.cost_low_cents, NEW.cost_high_cents, NEW.work_paused, NEW.ai_assisted, NEW.expires_at,
      NEW.created_by, NEW.created_by_name, NEW.created_at) THEN
    RAISE EXCEPTION 'NO_SURPRISE_IMMUTABLE: request content cannot be edited' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'NO_SURPRISE_IMMUTABLE: request is already resolved' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_internal THEN
      IF NEW.status <> 'withdrawn' THEN
        RAISE EXCEPTION 'NO_SURPRISE_FORBIDDEN: staff can only withdraw a request' USING ERRCODE = 'P0001';
      END IF;
      IF (NEW.decided_option_id, NEW.approved_cost_high_cents, NEW.signed_name, NEW.decision_note,
          NEW.risk_acknowledged, NEW.decision_context, NEW.disclosure_entry_id, NEW.decision_entry_id)
         IS DISTINCT FROM
         (OLD.decided_option_id, OLD.approved_cost_high_cents, OLD.signed_name, OLD.decision_note,
          OLD.risk_acknowledged, OLD.decision_context, OLD.disclosure_entry_id, OLD.decision_entry_id) THEN
        RAISE EXCEPTION 'NO_SURPRISE_FORBIDDEN: staff cannot set a customer decision' USING ERRCODE = 'P0001';
      END IF;
      NEW.decided_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- Status unchanged: only internal back-links (NULL -> entry id) are allowed.
  IF NOT v_internal THEN
    RAISE EXCEPTION 'NO_SURPRISE_IMMUTABLE: request cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.status, NEW.decided_at, NEW.decided_option_id, NEW.approved_cost_high_cents, NEW.signed_name,
      NEW.decision_note, NEW.risk_acknowledged, NEW.decision_context, NEW.withdrawn_reason)
     IS DISTINCT FROM
     (OLD.status, OLD.decided_at, OLD.decided_option_id, OLD.approved_cost_high_cents, OLD.signed_name,
      OLD.decision_note, OLD.risk_acknowledged, OLD.decision_context, OLD.withdrawn_reason)
     OR (OLD.disclosure_entry_id IS NOT NULL AND NEW.disclosure_entry_id IS DISTINCT FROM OLD.disclosure_entry_id)
     OR (OLD.decision_entry_id IS NOT NULL AND NEW.decision_entry_id IS DISTINCT FROM OLD.decision_entry_id) THEN
    RAISE EXCEPTION 'NO_SURPRISE_IMMUTABLE: request cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ns_guard ON public.no_surprise_requests;
CREATE TRIGGER trg_ns_guard
  BEFORE UPDATE OR DELETE ON public.no_surprise_requests
  FOR EACH ROW EXECUTE FUNCTION public.ns_guard();

CREATE OR REPLACE FUNCTION public.ns_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NO_SURPRISE_IMMUTABLE: cannot truncate' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_ns_block_truncate ON public.no_surprise_requests;
CREATE TRIGGER trg_ns_block_truncate
  BEFORE TRUNCATE ON public.no_surprise_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.ns_block_truncate();

-- =============================================================
-- 4. RLS (same tenant model as the evidence chain)
-- =============================================================

ALTER TABLE public.no_surprise_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ns_requests_select" ON public.no_surprise_requests;
CREATE POLICY "ns_requests_select" ON public.no_surprise_requests FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = no_surprise_requests.job_id)
  );

DROP POLICY IF EXISTS "ns_requests_insert" ON public.no_surprise_requests;
CREATE POLICY "ns_requests_insert" ON public.no_surprise_requests FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = no_surprise_requests.job_id)
  );

-- Staff may only move a PENDING request to 'withdrawn' (enforced again by ns_guard).
DROP POLICY IF EXISTS "ns_requests_withdraw" ON public.no_surprise_requests;
CREATE POLICY "ns_requests_withdraw" ON public.no_surprise_requests FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND status = 'pending'
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = no_surprise_requests.job_id)
  )
  WITH CHECK (user_id = public.get_account_owner_id() AND status = 'withdrawn');

-- =============================================================
-- 5. EXPIRY
-- =============================================================

CREATE OR REPLACE FUNCTION public.ns_expire_due(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text := coalesce(current_setting('vireek.ns_internal', true), 'off');
BEGIN
  PERFORM set_config('vireek.ns_internal', 'on', true);
  UPDATE public.no_surprise_requests
  SET status = 'expired', decided_at = now()
  WHERE job_id = p_job_id AND status = 'pending' AND expires_at < now();
  PERFORM set_config('vireek.ns_internal', v_prev, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.ns_internal', v_prev, true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.no_surprise_expire_job(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = public.get_account_owner_id()) THEN
    PERFORM public.ns_expire_due(p_job_id);
  END IF;
END;
$$;

-- =============================================================
-- 6. EVIDENCE CHAIN INTEGRATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.ns_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_prev text := coalesce(current_setting('vireek.ns_internal', true), 'off');
BEGIN
  v_id := public.record_job_evidence_system(
    NEW.job_id,
    'recommendation',
    'system',
    'Additional work may be required: ' || left(NEW.title, 150),
    left(NEW.why, 3900),
    jsonb_build_object(
      'no_surprise', true,
      'phase', 'disclosure',
      'request_id', NEW.id,
      'necessity', NEW.necessity,
      'risk_level', NEW.risk_level,
      'cost_low_cents', NEW.cost_low_cents,
      'cost_high_cents', NEW.cost_high_cents,
      'options', NEW.options,
      'consequence_if_declined', NEW.consequence,
      'work_paused', NEW.work_paused,
      'ai_assisted', NEW.ai_assisted,
      'expires_at', NEW.expires_at
    ),
    'system',
    'ns-disclosure:' || NEW.id::text,
    '{}'::uuid[]
  );

  IF v_id IS NOT NULL THEN
    PERFORM set_config('vireek.ns_internal', 'on', true);
    UPDATE public.no_surprise_requests SET disclosure_entry_id = v_id WHERE id = NEW.id;
    PERFORM set_config('vireek.ns_internal', v_prev, true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ns_after_insert ON public.no_surprise_requests;
CREATE TRIGGER trg_ns_after_insert
  AFTER INSERT ON public.no_surprise_requests
  FOR EACH ROW EXECUTE FUNCTION public.ns_after_insert();

CREATE OR REPLACE FUNCTION public.ns_usd(p_cents integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '$' || to_char(coalesce(p_cents, 0) / 100.0, 'FM999,999,990.00');
$$;

CREATE OR REPLACE FUNCTION public.ns_after_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_label text;
  v_refs uuid[] := CASE WHEN NEW.disclosure_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.disclosure_entry_id] END;
  v_prev text := coalesce(current_setting('vireek.ns_internal', true), 'off');
  v_customer text;
  v_notify boolean;
BEGIN
  SELECT o->>'label' INTO v_label
  FROM jsonb_array_elements(NEW.options) o
  WHERE o->>'id' = NEW.decided_option_id
  LIMIT 1;

  IF NEW.status = 'approved' THEN
    v_id := public.record_job_evidence_system(
      NEW.job_id, 'customer_approval', 'approval',
      'Customer approved additional work: ' || left(NEW.title, 140),
      'Approved "' || coalesce(v_label, 'selected option') || '" - not to exceed ' || public.ns_usd(NEW.approved_cost_high_cents)
        || '. Signed by ' || coalesce(NEW.signed_name, 'customer') || '.',
      jsonb_strip_nulls(jsonb_build_object(
        'no_surprise', true,
        'phase', 'additional_work',
        'decision', 'approved',
        'request_id', NEW.id,
        'option_id', NEW.decided_option_id,
        'option_label', v_label,
        'approved_cost_high_cents', NEW.approved_cost_high_cents,
        'signed_name', NEW.signed_name,
        'note', NEW.decision_note,
        'method', 'online_no_surprise',
        'context', NEW.decision_context
      )),
      'customer', 'ns-decision:' || NEW.id::text, v_refs
    );

  ELSIF NEW.status = 'declined' THEN
    v_id := public.record_job_evidence_system(
      NEW.job_id, 'recommendation', 'statement',
      CASE WHEN NEW.decided_option_id IS NULL
        THEN 'Customer declined additional work: ' || left(NEW.title, 140)
        ELSE 'Customer deferred additional work: ' || left(NEW.title, 140) END,
      CASE WHEN NEW.risk_acknowledged
        THEN 'Customer acknowledged the consequence: ' || left(NEW.consequence, 1500)
        ELSE 'No additional cost was authorised.' END,
      jsonb_strip_nulls(jsonb_build_object(
        'no_surprise', true,
        'phase', 'additional_work_decision',
        'decision', CASE WHEN NEW.decided_option_id IS NULL THEN 'declined' ELSE 'deferred' END,
        'request_id', NEW.id,
        'option_id', NEW.decided_option_id,
        'option_label', v_label,
        'risk_acknowledged', NEW.risk_acknowledged,
        'signed_name', NEW.signed_name,
        'note', NEW.decision_note,
        'method', 'online_no_surprise',
        'context', NEW.decision_context
      )),
      'customer', 'ns-decision:' || NEW.id::text, v_refs
    );

  ELSIF NEW.status = 'expired' THEN
    v_id := public.record_job_evidence_system(
      NEW.job_id, 'recommendation', 'system',
      'Additional-work request expired without a customer decision: ' || left(NEW.title, 110),
      'No additional cost was authorised.',
      jsonb_build_object('no_surprise', true, 'phase', 'additional_work_decision', 'decision', 'expired', 'request_id', NEW.id),
      'system', 'ns-decision:' || NEW.id::text, v_refs
    );

  ELSIF NEW.status = 'withdrawn' THEN
    v_id := public.record_job_evidence_system(
      NEW.job_id, 'recommendation', 'system',
      'Additional-work request withdrawn by staff: ' || left(NEW.title, 110),
      left(coalesce(NEW.withdrawn_reason, 'Withdrawn before the customer decided.'), 500),
      jsonb_build_object('no_surprise', true, 'phase', 'additional_work_decision', 'decision', 'withdrawn', 'request_id', NEW.id),
      'system', 'ns-decision:' || NEW.id::text, v_refs
    );
  END IF;

  IF v_id IS NOT NULL THEN
    PERFORM set_config('vireek.ns_internal', 'on', true);
    UPDATE public.no_surprise_requests SET decision_entry_id = v_id WHERE id = NEW.id;
    PERFORM set_config('vireek.ns_internal', v_prev, true);
  END IF;

  -- In-app notification (best effort, never blocks the decision)
  IF NEW.status IN ('approved', 'declined', 'expired') THEN
    BEGIN
      SELECT coalesce(p.notify_job_update, true) INTO v_notify FROM public.profiles p WHERE p.id = NEW.user_id;
      IF coalesce(v_notify, true) THEN
        SELECT j.customer_name INTO v_customer FROM public.jobs j WHERE j.id = NEW.job_id;
        INSERT INTO public.notifications (user_id, type, title, message, action_url)
        VALUES (
          NEW.user_id, 'job_update',
          CASE NEW.status
            WHEN 'approved' THEN 'Customer approved additional work'
            WHEN 'declined' THEN 'Customer did not approve additional work'
            ELSE 'Additional-work request expired' END,
          coalesce(v_customer, 'Customer') || ': ' || left(NEW.title, 120),
          '/dashboard/jobs'
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ns_after_status_change ON public.no_surprise_requests;
CREATE TRIGGER trg_ns_after_status_change
  AFTER UPDATE OF status ON public.no_surprise_requests
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.ns_after_status_change();

-- =============================================================
-- 7. CERTIFICATION («Vireek Certified No-Surprise Service»)
-- =============================================================
-- SECURITY INVOKER on purpose: called by the dashboard it obeys RLS; called from the
-- token-gated SECURITY DEFINER room function it runs as owner for a job that was
-- already authorised by its secret token.
--
-- level:
--   certified          job completed, agreed price, every extra cost disclosed + approved, invoice within ceiling,
--                      evidence chain intact, no work-before-approval
--   awaiting_customer  an open request needs the customer
--   protected          job in progress, nothing wrong so far
--   unverified         completed but no accepted quote to verify against
--   violated           invoice above approved ceiling / chain broken / work before approval
--   not_applicable     cancelled / no-show

CREATE OR REPLACE FUNCTION public.no_surprise_job_status(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_baseline bigint;
  v_extra bigint := 0;
  v_invoice bigint;
  v_ceiling bigint;
  v_total integer := 0;
  v_pending integer := 0;
  v_approved integer := 0;
  v_declined integer := 0;
  v_expired integer := 0;
  v_report jsonb;
  v_reasons jsonb := '[]'::jsonb;
  v_level text;
  v_integrity_ok boolean;
  v_wba boolean;
BEGIN
  SELECT * INTO v_job FROM public.jobs j WHERE j.id = p_job_id;
  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT q.accepted_total_cents INTO v_baseline
  FROM public.quotes q
  WHERE q.id = v_job.quote_id AND q.status = 'accepted';

  SELECT
    count(*) FILTER (WHERE r.status <> 'withdrawn'),
    count(*) FILTER (WHERE r.status = 'pending'),
    count(*) FILTER (WHERE r.status = 'approved'),
    count(*) FILTER (WHERE r.status = 'declined'),
    count(*) FILTER (WHERE r.status = 'expired'),
    coalesce(sum(r.approved_cost_high_cents) FILTER (WHERE r.status = 'approved'), 0)
  INTO v_total, v_pending, v_approved, v_declined, v_expired, v_extra
  FROM public.no_surprise_requests r
  WHERE r.job_id = p_job_id;

  v_invoice := CASE WHEN v_job.invoice_amount IS NOT NULL THEN round(v_job.invoice_amount * 100)::bigint END;
  v_ceiling := CASE WHEN v_baseline IS NOT NULL THEN v_baseline + v_extra END;

  v_report := public.job_evidence_chain_report(p_job_id);
  v_integrity_ok := coalesce((v_report->'integrity'->>'valid')::boolean, false);
  v_wba := coalesce(v_report->'blocking_gaps' ? 'work_before_approval', false);

  IF v_pending > 0 THEN v_reasons := v_reasons || to_jsonb('open_request'::text); END IF;
  IF v_baseline IS NULL THEN v_reasons := v_reasons || to_jsonb('no_agreed_price'::text); END IF;
  IF v_invoice IS NOT NULL AND v_ceiling IS NOT NULL AND v_invoice > v_ceiling + 100 THEN
    v_reasons := v_reasons || to_jsonb('invoice_exceeds_approved'::text);
  END IF;
  IF v_report IS NULL OR NOT v_integrity_ok THEN v_reasons := v_reasons || to_jsonb('chain_integrity'::text); END IF;
  IF v_wba THEN v_reasons := v_reasons || to_jsonb('work_before_approval'::text); END IF;

  IF v_job.job_status IN ('cancelled', 'no_show') THEN
    v_level := 'not_applicable';
  ELSIF v_reasons ? 'invoice_exceeds_approved' OR v_reasons ? 'chain_integrity' OR v_reasons ? 'work_before_approval' THEN
    v_level := 'violated';
  ELSIF v_pending > 0 THEN
    v_level := 'awaiting_customer';
  ELSIF v_job.job_status <> 'completed' THEN
    v_level := 'protected';
  ELSIF v_baseline IS NULL THEN
    v_level := 'unverified';
  ELSE
    v_level := 'certified';
  END IF;

  RETURN jsonb_build_object(
    'level', v_level,
    'certified', v_level = 'certified',
    'job_status', v_job.job_status,
    'baseline_cents', v_baseline,
    'approved_extra_cents', v_extra,
    'ceiling_cents', v_ceiling,
    'invoice_cents', v_invoice,
    'requests', jsonb_build_object(
      'total', v_total, 'pending', v_pending, 'approved', v_approved, 'declined', v_declined, 'expired', v_expired
    ),
    'reasons', v_reasons,
    'evidence_head_hash', v_report->'integrity'->>'head_hash',
    'evaluated_at', now()
  );
END;
$$;

-- =============================================================
-- 8. PUBLIC (TOKEN-GATED) CUSTOMER API
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_no_surprise_room(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_biz text;
  v_tech text;
  v_reqs jsonb;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_job FROM public.jobs j WHERE j.reschedule_token = p_token;
  IF v_job.id IS NULL THEN RETURN NULL; END IF;

  PERFORM public.ns_expire_due(v_job.id);

  SELECT p.company_name INTO v_biz FROM public.profiles p WHERE p.id = v_job.user_id;
  SELECT tm.member_name INTO v_tech FROM public.team_members tm WHERE tm.id = v_job.assigned_technician_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'status', r.status,
      'title', r.title,
      'why', r.why,
      'necessity', r.necessity,
      'risk_level', r.risk_level,
      'consequence', r.consequence,
      'options', r.options,
      'cost_low_cents', r.cost_low_cents,
      'cost_high_cents', r.cost_high_cents,
      'work_paused', r.work_paused,
      'ai_assisted', r.ai_assisted,
      'requested_by', r.created_by_name,
      'created_at', r.created_at,
      'expires_at', r.expires_at,
      'decided_at', r.decided_at,
      'decided_option_id', r.decided_option_id,
      'approved_cost_high_cents', r.approved_cost_high_cents,
      'signed_name', r.signed_name
    ) ORDER BY r.created_at DESC), '[]'::jsonb)
  INTO v_reqs
  FROM public.no_surprise_requests r
  WHERE r.job_id = v_job.id AND r.status <> 'withdrawn';

  RETURN jsonb_build_object(
    'business_name', v_biz,
    'customer_name', v_job.customer_name,
    'service_type', v_job.service_type,
    'job_status', v_job.job_status,
    'technician_name', v_tech,
    'requests', v_reqs,
    'certification', public.no_surprise_job_status(v_job.id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_no_surprise_request(
  p_token uuid,
  p_request_id uuid,
  p_decision text,
  p_option_id text DEFAULT NULL,
  p_signed_name text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_acknowledged boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.no_surprise_requests%ROWTYPE;
  v_opt jsonb;
  v_name text := nullif(btrim(coalesce(p_signed_name, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_hdr jsonb;
  v_ip text;
  v_ctx jsonb := '{}'::jsonb;
  v_prev text := coalesce(current_setting('vireek.ns_internal', true), 'off');
  v_new_status text;
  v_needs_ack boolean;
BEGIN
  IF p_token IS NULL OR p_request_id IS NULL OR p_decision NOT IN ('approve', 'decline') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;

  SELECT r.* INTO v_req
  FROM public.no_surprise_requests r
  JOIN public.jobs j ON j.id = r.job_id
  WHERE r.id = p_request_id AND j.reschedule_token = p_token
  FOR UPDATE OF r;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_req.status = 'pending' AND v_req.expires_at < now() THEN
    PERFORM public.ns_expire_due(v_req.job_id);
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_resolved', 'status', v_req.status);
  END IF;

  IF v_name IS NOT NULL AND char_length(v_name) NOT BETWEEN 2 AND 120 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_name');
  END IF;
  IF v_note IS NOT NULL THEN v_note := left(v_note, 1000); END IF;

  IF p_option_id IS NOT NULL THEN
    SELECT o INTO v_opt FROM jsonb_array_elements(v_req.options) o WHERE o->>'id' = p_option_id LIMIT 1;
    IF v_opt IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
    END IF;
  END IF;

  IF p_decision = 'approve' THEN
    IF v_opt IS NULL OR v_opt->>'kind' <> 'perform' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
    END IF;
    IF v_name IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'signature_required');
    END IF;
    v_new_status := 'approved';
  ELSE
    IF v_opt IS NOT NULL AND v_opt->>'kind' <> 'defer' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_option');
    END IF;
    v_needs_ack := v_req.necessity = 'required' OR v_req.risk_level IN ('high', 'critical');
    IF v_needs_ack AND NOT coalesce(p_acknowledged, false) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'acknowledgement_required');
    END IF;
    v_new_status := 'declined';
  END IF;

  BEGIN
    v_hdr := nullif(current_setting('request.headers', true), '')::jsonb;
    v_ip := btrim(split_part(coalesce(v_hdr->>'x-forwarded-for', v_hdr->>'cf-connecting-ip', ''), ',', 1));
    v_ctx := jsonb_strip_nulls(jsonb_build_object(
      'ip_sha256', CASE WHEN v_ip <> '' THEN encode(sha256(convert_to(v_ip || ':' || p_request_id::text, 'UTF8')), 'hex') END,
      'user_agent', left(v_hdr->>'user-agent', 200)
    ));
  EXCEPTION WHEN OTHERS THEN
    v_ctx := '{}'::jsonb;
  END;

  PERFORM set_config('vireek.ns_internal', 'on', true);
  UPDATE public.no_surprise_requests
  SET status = v_new_status,
      decided_at = now(),
      decided_option_id = CASE WHEN v_opt IS NULL THEN NULL ELSE v_opt->>'id' END,
      approved_cost_high_cents = CASE WHEN v_new_status = 'approved' THEN (v_opt->>'cost_high_cents')::integer END,
      signed_name = v_name,
      decision_note = v_note,
      risk_acknowledged = CASE WHEN v_new_status = 'declined' THEN coalesce(p_acknowledged, false) ELSE false END,
      decision_context = v_ctx
  WHERE id = v_req.id;
  PERFORM set_config('vireek.ns_internal', v_prev, true);

  RETURN jsonb_build_object('ok', true, 'status', v_new_status);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.ns_internal', v_prev, true);
  RAISE;
END;
$$;

-- =============================================================
-- 9. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.ns_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_after_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_after_status_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ns_expire_due(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.no_surprise_expire_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.no_surprise_expire_job(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.no_surprise_job_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.no_surprise_job_status(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_no_surprise_room(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_no_surprise_room(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.respond_no_surprise_request(uuid, uuid, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_no_surprise_request(uuid, uuid, text, text, text, text, boolean) TO anon, authenticated;

-- =============================================================
-- 10. REALTIME (dashboard sees the customer's decision instantly)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'no_surprise_requests'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.no_surprise_requests;
  END IF;
END;
$$;
