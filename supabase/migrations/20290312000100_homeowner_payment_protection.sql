/*
  # Homeowner payment protection (hold -> release on verified completion -> dispute with job-timeline evidence)

  ## Why
  Design doc: docs/payments/homeowner-payment-protection.md. Read it first, especially section 2 (what Stripe does and does not offer).
  Stripe does not provide escrow accounts. The ONLY mechanism implemented here is a card AUTHORIZATION HOLD
  (PaymentIntent capture_method = manual, direct charge on the contractor's own connected account):
    * funds are never in Vireek's or the contractor's balance while held; they stay reserved on the homeowner's card,
    * the hold lasts only as long as the card network allows (Stripe records it in capture_before; typically 7 days online),
    * after that the hold simply drops and nobody is charged.
  Holding captured funds on the platform balance (separate charges and transfers) is NOT built; hold_mode is constrained to 'auth_hold'.

  ## Fail-closed gate (item 100: licensing)
  payment_protection_controls is a single row: enabled = false by default. enabled can only become true when a licensing /
  counsel confirmation reference, a maximum amount and an auto-release window are all set (CHECK). The client feature flag
  'homeowner_payment_protection' (default OFF) only hides UI; every server path checks pp_is_enabled() itself.
  Disabling or killing the feature never strands a live hold: expiry, void and staff resolution keep working.

  ## What this adds
  Tables : payment_protection_controls (+audit), payment_protection_transitions (data-driven state machine),
           payment_protection_holds, payment_protection_events (append-only), payment_protection_disputes (+notes).
  RPCs   : pp_create_hold, pp_issue_token, pp_claim_completion, pp_contractor_void, pp_contractor_respond, pp_get_hold_detail,
           pp_apply_transition (service_role), pp_hold_by_token, pp_open_dispute, pp_build_evidence, pp_due_work,
           staff_pp_update_controls, staff_pp_kill, staff_pp_resolve_dispute, staff_pp_list_disputes.

  ## Safety
  Idempotent. No DROP, no destructive change, no existing policy touched. Money fields are bigint cents. Holds are tenant-scoped with
  get_account_owner_id() + has_account_permission('can_view_billing'). The homeowner is identified only by a random token whose SHA-256
  is stored (never the token). Dispute evidence is an immutable, hashed snapshot. This migration was NOT executed by its author.

  ## Rollback
  Safe only while there are no live holds:
    DROP TABLE IF EXISTS public.payment_protection_dispute_notes, public.payment_protection_disputes,
      public.payment_protection_events, public.payment_protection_holds, public.payment_protection_transitions,
      public.payment_protection_control_audit, public.payment_protection_controls CASCADE;
  and drop the pp_* / staff_pp_* functions. Leave the feature flag row; it is harmless.
*/

-- =============================================================
-- 1. Controls (single row, fail-closed)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.payment_protection_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  -- TODO(owner)/TODO(counsel): reference to the written confirmation that this product may be offered (item 100).
  licensing_confirmed_ref text CHECK (licensing_confirmed_ref IS NULL OR char_length(btrim(licensing_confirmed_ref)) BETWEEN 3 AND 200),
  licensing_confirmed_by uuid,
  licensing_confirmed_at timestamptz,
  -- TODO(owner): all three stay NULL/0 until you decide them. The feature cannot be enabled without them.
  max_amount_cents bigint NOT NULL DEFAULT 0 CHECK (max_amount_cents >= 0),
  auto_release_hours integer CHECK (auto_release_hours IS NULL OR auto_release_hours BETWEEN 1 AND 168),
  -- Engineering defaults (confirm): evidence needed to claim completion; headroom kept before the card hold lapses.
  min_completion_evidence integer NOT NULL DEFAULT 1 CHECK (min_completion_evidence >= 0),
  expiry_margin_hours integer NOT NULL DEFAULT 24 CHECK (expiry_margin_hours BETWEEN 1 AND 96),
  killed_at timestamptz,
  kill_reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pp_enable_requires_prereqs CHECK (
    NOT enabled OR (
      licensing_confirmed_ref IS NOT NULL AND licensing_confirmed_at IS NOT NULL AND licensing_confirmed_by IS NOT NULL
      AND max_amount_cents > 0 AND auto_release_hours IS NOT NULL
    )
  )
);
INSERT INTO public.payment_protection_controls (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.payment_protection_control_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_row jsonb,
  new_row jsonb,
  actor_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.pp_controls_audit_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.payment_protection_control_audit (old_row, new_row, actor_id, reason)
  VALUES (to_jsonb(OLD), to_jsonb(NEW), auth.uid(), nullif(current_setting('vireek.pp_reason', true), ''));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pp_controls_audit ON public.payment_protection_controls;
CREATE TRIGGER trg_pp_controls_audit AFTER UPDATE ON public.payment_protection_controls
  FOR EACH ROW EXECUTE FUNCTION public.pp_controls_audit_trg();

ALTER TABLE public.payment_protection_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_protection_control_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_protection_controls, public.payment_protection_control_audit FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pp_is_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT enabled AND killed_at IS NULL FROM public.payment_protection_controls WHERE id), false);
$$;

-- =============================================================
-- 2. State machine (data-driven; mirrored by src/lib/paymentProtection.ts and checked by a test)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.payment_protection_transitions (
  from_state text NOT NULL,
  event text NOT NULL,
  to_state text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('contractor', 'homeowner', 'system', 'staff')),
  PRIMARY KEY (from_state, event, actor_kind)
);
ALTER TABLE public.payment_protection_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_protection_transitions FROM PUBLIC, anon, authenticated;

INSERT INTO public.payment_protection_transitions (from_state, event, to_state, actor_kind) VALUES
  ('draft', 'send_request', 'awaiting_authorization', 'contractor'),
  ('draft', 'cancel', 'voided', 'contractor'),
  ('awaiting_authorization', 'authorized', 'held', 'homeowner'),
  ('awaiting_authorization', 'authorized', 'held', 'system'),
  ('awaiting_authorization', 'authorization_failed', 'failed', 'system'),
  ('awaiting_authorization', 'cancel', 'voided', 'contractor'),
  ('awaiting_authorization', 'expire', 'expired', 'system'),
  ('held', 'claim_completion', 'completion_claimed', 'contractor'),
  ('held', 'request_void', 'voiding', 'contractor'),
  ('held', 'open_dispute', 'disputed', 'homeowner'),
  ('held', 'expire', 'expired', 'system'),
  ('completion_claimed', 'homeowner_confirm', 'capturing', 'homeowner'),
  ('completion_claimed', 'auto_release', 'capturing', 'system'),
  ('completion_claimed', 'open_dispute', 'disputed', 'homeowner'),
  ('completion_claimed', 'request_void', 'voiding', 'contractor'),
  ('completion_claimed', 'expire', 'expired', 'system'),
  ('disputed', 'resolve_release', 'capturing', 'staff'),
  ('disputed', 'resolve_void', 'voiding', 'staff'),
  ('disputed', 'expire', 'expired', 'system'),
  ('capturing', 'capture_succeeded', 'released', 'system'),
  ('capturing', 'capture_failed', 'needs_review', 'system'),
  ('voiding', 'void_succeeded', 'voided', 'system'),
  ('voiding', 'void_failed', 'needs_review', 'system'),
  ('needs_review', 'resolve_capture', 'capturing', 'staff'),
  ('needs_review', 'resolve_void', 'voiding', 'staff'),
  ('needs_review', 'resolve_expired', 'expired', 'staff')
ON CONFLICT (from_state, event, actor_kind) DO NOTHING;

-- =============================================================
-- 3. Holds, events, disputes
-- =============================================================
CREATE TABLE IF NOT EXISTS public.payment_protection_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  hold_mode text NOT NULL DEFAULT 'auth_hold' CHECK (hold_mode = 'auth_hold'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft', 'awaiting_authorization', 'held', 'completion_claimed', 'disputed', 'capturing', 'voiding',
    'released', 'voided', 'expired', 'failed', 'needs_review')),
  stripe_account_id text NOT NULL,
  checkout_session_id text,
  payment_intent_id text,
  charge_id text,
  capture_before timestamptz,
  capture_amount_cents bigint CHECK (capture_amount_cents IS NULL OR capture_amount_cents > 0),
  amount_captured_cents bigint NOT NULL DEFAULT 0 CHECK (amount_captured_cents >= 0),
  claimed_at timestamptz,
  release_due_at timestamptz,
  homeowner_token_hash text UNIQUE CHECK (homeowner_token_hash IS NULL OR homeowner_token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pp_capture_le_amount CHECK (capture_amount_cents IS NULL OR capture_amount_cents <= amount_cents),
  CONSTRAINT pp_captured_le_amount CHECK (amount_captured_cents <= amount_cents)
);
-- At most one live (non-terminal) hold per job: no double-charging by accident.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_one_live_hold_per_job ON public.payment_protection_holds (job_id)
  WHERE state NOT IN ('released', 'voided', 'expired', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_payment_intent ON public.payment_protection_holds (payment_intent_id) WHERE payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_holds_owner_state ON public.payment_protection_holds (user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pp_holds_due ON public.payment_protection_holds (state, release_due_at, capture_before);

CREATE OR REPLACE FUNCTION public.pp_holds_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('released', 'voided', 'expired', 'failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'pp_terminal_state' USING ERRCODE = '42501';
  END IF;
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'pp_immutable_field' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pp_holds_guard ON public.payment_protection_holds;
CREATE TRIGGER trg_pp_holds_guard BEFORE UPDATE ON public.payment_protection_holds
  FOR EACH ROW EXECUTE FUNCTION public.pp_holds_guard();

CREATE TABLE IF NOT EXISTS public.payment_protection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id uuid NOT NULL REFERENCES public.payment_protection_holds(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  event text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('contractor', 'homeowner', 'system', 'staff')),
  actor_id uuid,
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 3 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_events_idem ON public.payment_protection_events (hold_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_events_hold ON public.payment_protection_events (hold_id, created_at);

CREATE TABLE IF NOT EXISTS public.payment_protection_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id uuid NOT NULL REFERENCES public.payment_protection_holds(id) ON DELETE CASCADE,
  reason_code text NOT NULL CHECK (reason_code IN ('work_not_done', 'work_incomplete', 'quality', 'no_show', 'price_mismatch', 'other')),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  evidence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  resolution text CHECK (resolution IS NULL OR resolution IN ('release_full', 'release_partial', 'void')),
  resolved_amount_cents bigint CHECK (resolved_amount_cents IS NULL OR resolved_amount_cents > 0),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 10 AND 2000),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pp_dispute_resolved_consistent CHECK ((status = 'open') = (resolution IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_one_open_dispute ON public.payment_protection_disputes (hold_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.payment_protection_dispute_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES public.payment_protection_disputes(id) ON DELETE CASCADE,
  author_kind text NOT NULL CHECK (author_kind IN ('contractor', 'homeowner', 'staff')),
  author_id uuid,
  body text NOT NULL CHECK (char_length(body) BETWEEN 3 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.pp_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_protection_disputes' THEN
    IF NEW.evidence_snapshot IS DISTINCT FROM OLD.evidence_snapshot OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
       OR NEW.hold_id IS DISTINCT FROM OLD.hold_id OR NEW.statement IS DISTINCT FROM OLD.statement
       OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR (OLD.status = 'resolved') THEN
      RAISE EXCEPTION 'pp_immutable_evidence' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_pp_events_immutable ON public.payment_protection_events;
CREATE TRIGGER trg_pp_events_immutable BEFORE UPDATE ON public.payment_protection_events
  FOR EACH ROW EXECUTE FUNCTION public.pp_immutable_guard();
DROP TRIGGER IF EXISTS trg_pp_notes_immutable ON public.payment_protection_dispute_notes;
CREATE TRIGGER trg_pp_notes_immutable BEFORE UPDATE ON public.payment_protection_dispute_notes
  FOR EACH ROW EXECUTE FUNCTION public.pp_immutable_guard();
DROP TRIGGER IF EXISTS trg_pp_disputes_immutable ON public.payment_protection_disputes;
CREATE TRIGGER trg_pp_disputes_immutable BEFORE UPDATE ON public.payment_protection_disputes
  FOR EACH ROW EXECUTE FUNCTION public.pp_immutable_guard();

-- RLS: clients may only LIST their own holds (never the token hash); everything else goes through RPCs.
ALTER TABLE public.payment_protection_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_protection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_protection_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_protection_dispute_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_protection_holds, public.payment_protection_events,
  public.payment_protection_disputes, public.payment_protection_dispute_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, user_id, job_id, customer_id, amount_cents, currency, hold_mode, state, capture_before, capture_amount_cents,
              amount_captured_cents, claimed_at, release_due_at, token_expires_at, version, created_at, updated_at)
  ON public.payment_protection_holds TO authenticated;
DROP POLICY IF EXISTS "select_own_pp_holds" ON public.payment_protection_holds;
CREATE POLICY "select_own_pp_holds" ON public.payment_protection_holds
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.has_account_permission('can_view_billing'));

-- =============================================================
-- 4. Core transition (service_role only; every state change goes through here)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pp_apply_transition(
  p_hold uuid, p_event text, p_actor_kind text, p_actor uuid DEFAULT NULL,
  p_idem text DEFAULT NULL, p_patch jsonb DEFAULT '{}'::jsonb, p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.payment_protection_holds;
  t public.payment_protection_transitions;
BEGIN
  SELECT * INTO h FROM public.payment_protection_holds WHERE id = p_hold FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_hold_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_idem IS NOT NULL AND EXISTS (SELECT 1 FROM public.payment_protection_events WHERE hold_id = p_hold AND idempotency_key = p_idem) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'state', h.state);
  END IF;

  SELECT * INTO t FROM public.payment_protection_transitions
   WHERE from_state = h.state AND event = p_event AND actor_kind = p_actor_kind;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_invalid_transition: % --%--> by %', h.state, p_event, p_actor_kind USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.payment_protection_holds SET
    state = t.to_state,
    checkout_session_id = COALESCE(p_patch ->> 'checkout_session_id', checkout_session_id),
    payment_intent_id = COALESCE(p_patch ->> 'payment_intent_id', payment_intent_id),
    charge_id = COALESCE(p_patch ->> 'charge_id', charge_id),
    capture_before = COALESCE((p_patch ->> 'capture_before')::timestamptz, capture_before),
    claimed_at = COALESCE((p_patch ->> 'claimed_at')::timestamptz, claimed_at),
    release_due_at = COALESCE((p_patch ->> 'release_due_at')::timestamptz, release_due_at),
    capture_amount_cents = CASE
      WHEN p_patch ? 'capture_amount_cents' THEN (p_patch ->> 'capture_amount_cents')::bigint
      WHEN t.to_state = 'capturing' THEN COALESCE(capture_amount_cents, amount_cents)
      ELSE capture_amount_cents END,
    amount_captured_cents = COALESCE((p_patch ->> 'amount_captured_cents')::bigint, amount_captured_cents),
    version = version + 1,
    updated_at = now()
  WHERE id = p_hold;

  INSERT INTO public.payment_protection_events (hold_id, from_state, to_state, event, actor_kind, actor_id, idempotency_key, detail)
  VALUES (p_hold, h.state, t.to_state, p_event, p_actor_kind, p_actor, p_idem, COALESCE(p_detail, '{}'::jsonb));

  RETURN jsonb_build_object('status', 'applied', 'from', h.state, 'state', t.to_state);
END;
$$;

-- =============================================================
-- 5. Evidence snapshot from the job timeline
-- =============================================================
-- Locations (latitude/longitude on status events) are deliberately NOT copied: TODO(counsel) before sharing precise location.
CREATE OR REPLACE FUNCTION public.pp_build_evidence(p_hold uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.payment_protection_holds;
BEGIN
  SELECT * INTO h FROM public.payment_protection_holds WHERE id = p_hold;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_hold_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'generated_at', now(),
    'hold', jsonb_build_object('id', h.id, 'amount_cents', h.amount_cents, 'currency', h.currency, 'state', h.state,
                               'claimed_at', h.claimed_at, 'capture_before', h.capture_before),
    'job', (SELECT jsonb_build_object('id', j.id, 'service_type', j.service_type, 'scheduled_datetime', j.scheduled_datetime,
                                      'completed_at', j.completed_at, 'job_status', j.job_status)
            FROM public.jobs j WHERE j.id = h.job_id AND j.user_id = h.user_id),
    'status_events', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', e.created_at, 'from', e.from_status, 'to', e.to_status, 'note', e.note)
                                                ORDER BY e.created_at)
                               FROM public.job_status_events e WHERE e.job_id = h.job_id), '[]'::jsonb),
    'photos', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'taken_at', p.taken_at, 'caption', p.caption,
                                                            'file_name', p.file_name, 'size_bytes', p.size_bytes) ORDER BY p.taken_at)
                        FROM public.job_photos p WHERE p.job_id = h.job_id AND p.user_id = h.user_id), '[]'::jsonb),
    'checklist_completions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'item_id', c.template_item_id, 'completed_at', c.completed_at)
                                                        ORDER BY c.completed_at)
                                       FROM public.job_checklist_completions c WHERE c.job_id = h.job_id), '[]'::jsonb),
    'work_evidence_signals', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', s.created_at, 'score', s.score, 'verified', s.verified, 'source', s.source)
                                                        ORDER BY s.created_at)
                                       FROM public.job_trust_events s WHERE s.job_id = h.job_id AND s.signal = 'work_evidence'), '[]'::jsonb),
    'protection_events', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', pe.created_at, 'event', pe.event, 'actor', pe.actor_kind)
                                                    ORDER BY pe.created_at)
                                   FROM public.payment_protection_events pe WHERE pe.hold_id = h.id), '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- 6. Contractor-facing RPCs (authenticated; owner or can_view_billing)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pp_assert_manager()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_account_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Missing billing permission' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.pp_create_hold(p_job_id uuid, p_amount_cents bigint, p_currency text DEFAULT 'usd')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pp_assert_manager();
  v_max bigint;
  v_job public.jobs;
  v_acct text;
  v_id uuid;
BEGIN
  IF NOT public.pp_is_enabled() THEN
    RAISE EXCEPTION 'pp_feature_disabled' USING ERRCODE = 'P0001';
  END IF;
  SELECT max_amount_cents INTO v_max FROM public.payment_protection_controls WHERE id;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > v_max THEN
    RAISE EXCEPTION 'pp_amount_out_of_range' USING ERRCODE = '22023';
  END IF;
  IF p_currency IS NULL OR lower(p_currency) !~ '^[a-z]{3}$' THEN
    RAISE EXCEPTION 'pp_bad_currency' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_job_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT stripe_account_id INTO v_acct FROM public.stripe_connect_accounts
   WHERE user_id = v_owner AND charges_enabled AND stripe_account_id IS NOT NULL;
  IF v_acct IS NULL THEN
    RAISE EXCEPTION 'pp_connect_not_ready' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.payment_protection_holds (user_id, job_id, customer_id, amount_cents, currency, stripe_account_id)
    VALUES (v_owner, v_job.id, v_job.customer_id, p_amount_cents, lower(p_currency), v_acct)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'pp_hold_exists' USING ERRCODE = '23505';
  END;
  INSERT INTO public.payment_protection_events (hold_id, from_state, to_state, event, actor_kind, actor_id)
  VALUES (v_id, NULL, 'draft', 'created', 'contractor', auth.uid());
  RETURN v_id;
END;
$$;

-- Stores the SHA-256 of a freshly generated homeowner token (generated by the edge function; the token itself is never stored).
CREATE OR REPLACE FUNCTION public.pp_issue_token(p_hold uuid, p_token_hash text, p_expires timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pp_assert_manager();
  h public.payment_protection_holds;
BEGIN
  IF NOT public.pp_is_enabled() THEN
    RAISE EXCEPTION 'pp_feature_disabled' USING ERRCODE = 'P0001';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires IS NULL OR p_expires <= now() THEN
    RAISE EXCEPTION 'pp_bad_token' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM public.payment_protection_holds WHERE id = p_hold AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_hold_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF h.state NOT IN ('draft', 'awaiting_authorization') THEN
    RAISE EXCEPTION 'pp_invalid_transition: % cannot receive a new link', h.state USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.payment_protection_holds SET homeowner_token_hash = p_token_hash, token_expires_at = p_expires WHERE id = p_hold;
  IF h.state = 'draft' THEN
    PERFORM public.pp_apply_transition(p_hold, 'send_request', 'contractor', auth.uid(), 'send_request');
  END IF;
  RETURN jsonb_build_object('state', 'awaiting_authorization');
END;
$$;

CREATE OR REPLACE FUNCTION public.pp_claim_completion(p_hold uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pp_assert_manager();
  h public.payment_protection_holds;
  c public.payment_protection_controls;
  v_job public.jobs;
  v_evidence integer;
  v_due timestamptz;
BEGIN
  SELECT * INTO c FROM public.payment_protection_controls WHERE id;
  IF c.auto_release_hours IS NULL THEN
    RAISE EXCEPTION 'pp_feature_disabled' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO h FROM public.payment_protection_holds WHERE id = p_hold AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_hold_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF h.state <> 'held' THEN
    RAISE EXCEPTION 'pp_invalid_transition: % --claim_completion--> by contractor', h.state USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id = h.job_id AND user_id = v_owner;
  IF NOT FOUND OR v_job.completed_at IS NULL THEN
    RAISE EXCEPTION 'pp_job_not_completed' USING ERRCODE = 'P0001';
  END IF;
  SELECT (SELECT count(*) FROM public.job_photos p WHERE p.job_id = h.job_id AND p.user_id = v_owner AND p.kind = 'after')
       + (SELECT count(*) FROM public.job_checklist_completions k WHERE k.job_id = h.job_id)
    INTO v_evidence;
  IF v_evidence < c.min_completion_evidence THEN
    RAISE EXCEPTION 'pp_insufficient_evidence' USING ERRCODE = 'P0001';
  END IF;

  -- Release is never later than the card hold allows, minus the safety margin.
  v_due := LEAST(now() + make_interval(hours => c.auto_release_hours),
                 COALESCE(h.capture_before, now() + interval '100 years') - make_interval(hours => c.expiry_margin_hours));
  IF v_due <= now() + interval '1 hour' THEN
    RAISE EXCEPTION 'pp_window_too_short' USING ERRCODE = 'P0001';
  END IF;
  RETURN public.pp_apply_transition(p_hold, 'claim_completion', 'contractor', auth.uid(), 'claim_completion',
    jsonb_build_object('claimed_at', now(), 'release_due_at', v_due),
    jsonb_build_object('evidence_items', v_evidence));
END;
$$;

CREATE OR REPLACE FUNCTION public.pp_contractor_void(p_hold uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pp_assert_manager();
  v_state text;
BEGIN
  SELECT state INTO v_state FROM public.payment_protection_holds WHERE id = p_hold AND user_id = v_owner;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'pp_hold_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_state IN ('draft', 'awaiting_authorization') THEN
    RETURN public.pp_apply_transition(p_hold, 'cancel', 'contractor', auth.uid(), 'cancel');
  END IF;
  RETURN public.pp_apply_transition(p_hold, 'request_void', 'contractor', auth.uid(), 'request_void');
END;
$$;

CREATE OR REPLACE FUNCTION public.pp_contractor_respond(p_hold uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pp_assert_manager();
  v_dispute uuid;
  v_id uuid;
BEGIN
  SELECT d.id INTO v_dispute FROM public.payment_protection_disputes d
    JOIN public.payment_protection_holds h ON h.id = d.hold_id
   WHERE d.hold_id = p_hold AND h.user_id = v_owner AND d.status = 'open';
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'pp_no_open_dispute' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.payment_protection_dispute_notes (dispute_id, author_kind, author_id, body)
  VALUES (v_dispute, 'contractor', auth.uid(), p_body) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Full detail for one hold (contractor of that hold, or staff).
CREATE OR REPLACE FUNCTION public.pp_get_hold_detail(p_hold uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.payment_protection_holds;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO h FROM public.payment_protection_holds WHERE id = p_hold;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT (public.is_vireek_staff(auth.uid())
          OR (h.user_id = public.get_account_owner_id() AND public.has_account_permission('can_view_billing'))) THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'hold', jsonb_build_object('id', h.id, 'job_id', h.job_id, 'amount_cents', h.amount_cents, 'currency', h.currency, 'state', h.state,
                               'capture_before', h.capture_before, 'capture_amount_cents', h.capture_amount_cents,
                               'amount_captured_cents', h.amount_captured_cents, 'claimed_at', h.claimed_at,
                               'release_due_at', h.release_due_at, 'created_at', h.created_at),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', e.created_at, 'event', e.event, 'from', e.from_state, 'to', e.to_state,
                                                           'actor', e.actor_kind) ORDER BY e.created_at)
                        FROM public.payment_protection_events e WHERE e.hold_id = h.id), '[]'::jsonb),
    'dispute', (SELECT jsonb_build_object(
                  'id', d.id, 'reason_code', d.reason_code, 'statement', d.statement, 'status', d.status,
                  'resolution', d.resolution, 'resolved_amount_cents', d.resolved_amount_cents, 'resolution_note', d.resolution_note,
                  'created_at', d.created_at, 'evidence_sha256', d.evidence_sha256, 'evidence', d.evidence_snapshot,
                  'notes', COALESCE((SELECT jsonb_agg(jsonb_build_object('author', n.author_kind, 'body', n.body, 'at', n.created_at)
                                                      ORDER BY n.created_at)
                                     FROM public.payment_protection_dispute_notes n WHERE n.dispute_id = d.id), '[]'::jsonb))
                FROM public.payment_protection_disputes d WHERE d.hold_id = h.id ORDER BY d.created_at DESC LIMIT 1)
  );
END;
$$;

-- =============================================================
-- 7. Homeowner-token and system RPCs (service_role only; the edge function verifies the token)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pp_hold_by_token(p_token_hash text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', h.id, 'state', h.state, 'amount_cents', h.amount_cents, 'currency', h.currency,
    'capture_before', h.capture_before, 'release_due_at', h.release_due_at, 'claimed_at', h.claimed_at,
    'stripe_account_id', h.stripe_account_id, 'checkout_session_id', h.checkout_session_id,
    'payment_intent_id', h.payment_intent_id, 'token_expires_at', h.token_expires_at,
    'business_name', COALESCE((SELECT nullif(btrim(pr.company_name), '') FROM public.profiles pr WHERE pr.id = h.user_id), 'Your contractor'),
    'service_type', (SELECT j.service_type FROM public.jobs j WHERE j.id = h.job_id),
    'dispute_open', EXISTS (SELECT 1 FROM public.payment_protection_disputes d WHERE d.hold_id = h.id AND d.status = 'open'))
  FROM public.payment_protection_holds h
  WHERE h.homeowner_token_hash = p_token_hash AND h.token_expires_at > now();
$$;

CREATE OR REPLACE FUNCTION public.pp_open_dispute(p_hold uuid, p_reason text, p_statement text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snap jsonb;
  v_id uuid;
  v_res jsonb;
BEGIN
  v_res := public.pp_apply_transition(p_hold, 'open_dispute', 'homeowner', NULL, 'open_dispute');
  IF v_res ->> 'status' = 'duplicate' THEN
    RETURN v_res;
  END IF;
  v_snap := public.pp_build_evidence(p_hold);
  INSERT INTO public.payment_protection_disputes (hold_id, reason_code, statement, evidence_snapshot, evidence_sha256)
  VALUES (p_hold, p_reason, p_statement, v_snap, encode(sha256(convert_to(v_snap::text, 'UTF8')), 'hex'))
  RETURNING id INTO v_id;
  RETURN v_res || jsonb_build_object('dispute_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.pp_due_work()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'auto_release', CASE WHEN public.pp_is_enabled() THEN COALESCE((SELECT jsonb_agg(h.id) FROM public.payment_protection_holds h
        WHERE h.state = 'completion_claimed' AND h.release_due_at <= now()
          AND NOT EXISTS (SELECT 1 FROM public.payment_protection_disputes d WHERE d.hold_id = h.id AND d.status = 'open')), '[]'::jsonb)
      ELSE '[]'::jsonb END,
    'expire', COALESCE((SELECT jsonb_agg(h.id) FROM public.payment_protection_holds h
        WHERE (h.state IN ('held', 'completion_claimed', 'disputed') AND h.capture_before <= now())
           OR (h.state = 'awaiting_authorization' AND h.token_expires_at <= now())), '[]'::jsonb),
    'drive_capturing', COALESCE((SELECT jsonb_agg(h.id) FROM public.payment_protection_holds h
        WHERE h.state = 'capturing' AND h.updated_at <= now() - interval '2 minutes'), '[]'::jsonb),
    'drive_voiding', COALESCE((SELECT jsonb_agg(h.id) FROM public.payment_protection_holds h
        WHERE h.state = 'voiding' AND h.updated_at <= now() - interval '2 minutes'), '[]'::jsonb),
    'reconcile_authorization', COALESCE((SELECT jsonb_agg(h.id) FROM public.payment_protection_holds h
        WHERE h.state = 'awaiting_authorization' AND h.checkout_session_id IS NOT NULL
          AND h.updated_at <= now() - interval '5 minutes'), '[]'::jsonb),
    'expiring_soon', COALESCE((SELECT jsonb_agg(h.id) FROM public.payment_protection_holds h, public.payment_protection_controls c
        WHERE c.id AND h.state IN ('held', 'completion_claimed', 'disputed')
          AND h.capture_before > now() AND h.capture_before <= now() + make_interval(hours => c.expiry_margin_hours)), '[]'::jsonb)
  );
$$;

-- =============================================================
-- 8. Staff RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_pp_update_controls(p_patch jsonb, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.payment_protection_controls;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.pp_reason', left(p_reason, 300), true);
  UPDATE public.payment_protection_controls SET
    licensing_confirmed_ref = CASE WHEN p_patch ? 'licensing_confirmed_ref' THEN nullif(btrim(p_patch ->> 'licensing_confirmed_ref'), '') ELSE licensing_confirmed_ref END,
    licensing_confirmed_by = CASE WHEN p_patch ? 'licensing_confirmed_ref' AND nullif(btrim(p_patch ->> 'licensing_confirmed_ref'), '') IS NOT NULL THEN auth.uid()
                                  WHEN p_patch ? 'licensing_confirmed_ref' THEN NULL ELSE licensing_confirmed_by END,
    licensing_confirmed_at = CASE WHEN p_patch ? 'licensing_confirmed_ref' AND nullif(btrim(p_patch ->> 'licensing_confirmed_ref'), '') IS NOT NULL THEN now()
                                  WHEN p_patch ? 'licensing_confirmed_ref' THEN NULL ELSE licensing_confirmed_at END,
    max_amount_cents = COALESCE((p_patch ->> 'max_amount_cents')::bigint, max_amount_cents),
    auto_release_hours = CASE WHEN p_patch ? 'auto_release_hours' THEN (p_patch ->> 'auto_release_hours')::integer ELSE auto_release_hours END,
    min_completion_evidence = COALESCE((p_patch ->> 'min_completion_evidence')::integer, min_completion_evidence),
    expiry_margin_hours = COALESCE((p_patch ->> 'expiry_margin_hours')::integer, expiry_margin_hours),
    enabled = COALESCE((p_patch ->> 'enabled')::boolean, enabled),
    updated_by = auth.uid(), updated_at = now()
  WHERE id RETURNING * INTO c;
  RETURN to_jsonb(c) - 'updated_by';
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pp_kill(p_reason text, p_release boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.pp_reason', left(p_reason, 300), true);
  UPDATE public.payment_protection_controls
     SET killed_at = CASE WHEN p_release THEN NULL ELSE now() END,
         kill_reason = CASE WHEN p_release THEN NULL ELSE left(p_reason, 300) END,
         updated_by = auth.uid(), updated_at = now()
   WHERE id;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pp_list_disputes(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY x.created_at) FROM (
    SELECT d.id AS dispute_id, d.hold_id, d.reason_code, d.created_at, h.amount_cents, h.currency, h.capture_before, h.state
    FROM public.payment_protection_disputes d JOIN public.payment_protection_holds h ON h.id = d.hold_id
    WHERE d.status = 'open' ORDER BY d.created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))) x), '[]'::jsonb);
END;
$$;

-- Records the decision and moves the hold to capturing / voiding. The edge function then performs the Stripe call.
CREATE OR REPLACE FUNCTION public.staff_pp_resolve_dispute(p_hold uuid, p_resolution text, p_amount_cents bigint, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.payment_protection_holds;
  v_event text;
  v_patch jsonb := '{}'::jsonb;
  v_amount bigint;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_resolution NOT IN ('release_full', 'release_partial', 'void') THEN
    RAISE EXCEPTION 'pp_bad_resolution' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) < 10 THEN
    RAISE EXCEPTION 'A note of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO h FROM public.payment_protection_holds WHERE id = p_hold FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pp_hold_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_amount := CASE p_resolution WHEN 'release_full' THEN h.amount_cents WHEN 'release_partial' THEN p_amount_cents ELSE NULL END;
  IF p_resolution = 'release_partial' AND (p_amount_cents IS NULL OR p_amount_cents < 1 OR p_amount_cents >= h.amount_cents) THEN
    RAISE EXCEPTION 'pp_partial_amount_invalid' USING ERRCODE = '22023';
  END IF;
  v_event := CASE p_resolution WHEN 'void' THEN 'resolve_void' ELSE 'resolve_release' END;
  IF v_amount IS NOT NULL THEN
    v_patch := jsonb_build_object('capture_amount_cents', v_amount);
  END IF;

  PERFORM public.pp_apply_transition(p_hold, v_event, 'staff', auth.uid(), 'resolve:' || p_resolution, v_patch,
    jsonb_build_object('resolution', p_resolution));
  UPDATE public.payment_protection_disputes
     SET status = 'resolved', resolution = p_resolution, resolved_amount_cents = v_amount,
         resolution_note = p_note, resolved_by = auth.uid(), resolved_at = now()
   WHERE hold_id = p_hold AND status = 'open';
  RETURN jsonb_build_object('state', CASE WHEN p_resolution = 'void' THEN 'voiding' ELSE 'capturing' END);
END;
$$;

-- =============================================================
-- 9. Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.pp_is_enabled(), public.pp_assert_manager(), public.pp_apply_transition(uuid, text, text, uuid, text, jsonb, jsonb),
  public.pp_build_evidence(uuid), public.pp_hold_by_token(text), public.pp_open_dispute(uuid, text, text), public.pp_due_work(),
  public.pp_create_hold(uuid, bigint, text), public.pp_issue_token(uuid, text, timestamptz), public.pp_claim_completion(uuid),
  public.pp_contractor_void(uuid), public.pp_contractor_respond(uuid, text), public.pp_get_hold_detail(uuid),
  public.staff_pp_update_controls(jsonb, text), public.staff_pp_kill(text, boolean), public.staff_pp_list_disputes(integer),
  public.staff_pp_resolve_dispute(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pp_is_enabled(), public.pp_apply_transition(uuid, text, text, uuid, text, jsonb, jsonb),
  public.pp_build_evidence(uuid), public.pp_hold_by_token(text), public.pp_open_dispute(uuid, text, text), public.pp_due_work() TO service_role;
GRANT EXECUTE ON FUNCTION public.pp_is_enabled(), public.pp_create_hold(uuid, bigint, text), public.pp_issue_token(uuid, text, timestamptz),
  public.pp_claim_completion(uuid), public.pp_contractor_void(uuid), public.pp_contractor_respond(uuid, text), public.pp_get_hold_detail(uuid),
  public.staff_pp_update_controls(jsonb, text), public.staff_pp_kill(text, boolean), public.staff_pp_list_disputes(integer),
  public.staff_pp_resolve_dispute(uuid, text, bigint, text) TO authenticated;

-- =============================================================
-- 10. Client feature flag (default OFF; UI only — the server gate above is what actually protects)
-- =============================================================
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES (
  'homeowner_payment_protection',
  'Homeowner payment protection',
  'When OFF (default) the payment-protection UI is hidden and the server refuses new holds. Do not enable before licensing is confirmed (see docs/payments/homeowner-payment-protection.md). Owner: payments. Permanent ops switch.',
  false, 0
)
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 11. Staff read of the controls row (the table itself has no client access)
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_pp_get_controls()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT to_jsonb(c) - 'updated_by' - 'licensing_confirmed_by' FROM public.payment_protection_controls c WHERE c.id);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_pp_get_controls() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_pp_get_controls() TO authenticated;
