/*
  # Churn-save offers (extends the cancellation flow)

  ## What this adds
  Admin-configurable "save offers" shown inside /dashboard/billing/cancel:
    - pause      pause billing for N months (1-3)
    - downgrade  move to a cheaper plan at the END of the paid period
    - discount   percent-off for N months (hard ceiling: 50% / 6 months)
  Each offer has caps (per account, cooldown, total per rolling window), optional
  targeting by cancel reason and by the existing staff health band
  (computeHealth in _shared/staff/accountExplorer.ts), and an optional date window.

  ## Tables
  - churn_save_settings      singleton: master kill switch + global per-account cooldown
  - churn_save_offers        the configurable offers (never deleted, only disabled)
  - churn_save_redemptions   one row per accepted offer: claimed -> applied | failed
  - churn_save_events        append-only funnel: presented / declined / accepted
  - churn_save_audit         append-only log of every admin change (before/after)

  ## Security model
  - Staff change config ONLY through SECURITY DEFINER RPCs that check is_vireek_staff()
    and write churn_save_audit in the same transaction. No client INSERT/UPDATE/DELETE.
  - Customers never read these tables. The edge function (service_role) is the only
    caller of the churn_save_* functions.
  - Caps are enforced HERE, atomically: the claim function takes a per-account advisory
    lock and a row lock on the offer, so concurrent clicks cannot exceed a cap.
  - Stripe is changed only AFTER a successful claim; a failed Stripe call releases the
    claim (status = failed), so a failure never burns the customer's allowance.

  ## Notes
  - churn_save_events / churn_save_audit have no FK to profiles on purpose: they are
    append-only, and a cascading account deletion must not be blocked by the trigger.
    They hold opaque ids only (no email, no free text). [COUNSEL] confirm retention.
  - Retention in the staff view is an approximation: profiles.status = 'active' now.
    Stripe stays the source of truth for the live subscription.

  Requires: profiles, calls, team_members, phone_numbers, subscription_cancellations,
  is_vireek_staff(uuid), auth.users. Idempotent: safe to run twice.
*/

-- ---------------------------------------------------------------------------
-- 0. Ledger: allow the downgrade outcome + link a ledger row to its offer
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_cancellations DROP CONSTRAINT IF EXISTS subscription_cancellations_action_check;
ALTER TABLE subscription_cancellations
  ADD CONSTRAINT subscription_cancellations_action_check
  CHECK (action IN ('cancel_scheduled', 'paused', 'offer_accepted', 'resumed', 'downgrade_scheduled'));
ALTER TABLE subscription_cancellations ADD COLUMN IF NOT EXISTS save_offer_id uuid;
ALTER TABLE subscription_cancellations ADD COLUMN IF NOT EXISTS downgrade_plan text;

-- ---------------------------------------------------------------------------
-- 1. Settings (singleton)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS churn_save_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  global_cooldown_days integer NOT NULL DEFAULT 90 CHECK (global_cooldown_days BETWEEN 0 AND 730),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO churn_save_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Offers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS churn_save_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('pause', 'downgrade', 'discount')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 80),
  enabled boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  -- targeting (empty array = everyone)
  target_reasons text[] NOT NULL DEFAULT '{}'
    CHECK (target_reasons <@ ARRAY['too_expensive','missing_features','not_using','switching','closing_business','technical_issues','other']::text[]),
  target_bands text[] NOT NULL DEFAULT '{}'
    CHECK (target_bands <@ ARRAY['healthy','watch','at_risk','critical','new']::text[]),
  -- terms (exactly the fields of the chosen kind)
  pause_months smallint CHECK (pause_months IS NULL OR pause_months BETWEEN 1 AND 3),
  downgrade_plan text CHECK (downgrade_plan IS NULL OR downgrade_plan IN ('starter', 'professional')),
  discount_percent numeric(5, 2) CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 50)),
  discount_months smallint CHECK (discount_months IS NULL OR discount_months BETWEEN 1 AND 6),
  -- caps
  max_per_account smallint NOT NULL DEFAULT 1 CHECK (max_per_account BETWEEN 1 AND 3),
  cooldown_days integer NOT NULL DEFAULT 180 CHECK (cooldown_days BETWEEN 0 AND 730),
  cap_total integer CHECK (cap_total IS NULL OR cap_total > 0),
  cap_window_days integer NOT NULL DEFAULT 30 CHECK (cap_window_days BETWEEN 1 AND 365),
  -- optional window
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT churn_save_offers_window_ck CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT churn_save_offers_terms_ck CHECK (
    (kind = 'pause' AND pause_months IS NOT NULL AND downgrade_plan IS NULL AND discount_percent IS NULL AND discount_months IS NULL)
    OR (kind = 'downgrade' AND downgrade_plan IS NOT NULL AND pause_months IS NULL AND discount_percent IS NULL AND discount_months IS NULL)
    OR (kind = 'discount' AND discount_percent IS NOT NULL AND discount_months IS NOT NULL AND pause_months IS NULL AND downgrade_plan IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_churn_save_offers_active ON churn_save_offers (priority, created_at) WHERE enabled;

-- ---------------------------------------------------------------------------
-- 3. Redemptions (cap ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS churn_save_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES churn_save_offers(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pause', 'downgrade', 'discount')),
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'applied', 'failed')),
  reason text,
  risk_band text,
  risk_score smallint,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_subscription_id text,
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_churn_save_red_offer ON churn_save_redemptions (offer_id, created_at DESC) WHERE status IN ('claimed', 'applied');
CREATE INDEX IF NOT EXISTS idx_churn_save_red_user ON churn_save_redemptions (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Events + admin audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS churn_save_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  offer_id uuid NOT NULL REFERENCES churn_save_offers(id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event IN ('presented', 'declined', 'accepted')),
  reason text,
  risk_band text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_churn_save_events_offer ON churn_save_events (offer_id, event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_churn_save_events_user ON churn_save_events (user_id, offer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS churn_save_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text NOT NULL CHECK (action IN ('offer_created', 'offer_updated', 'offer_enabled', 'offer_disabled', 'settings_updated')),
  offer_id uuid,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_churn_save_audit_created ON churn_save_audit (created_at DESC);

CREATE OR REPLACE FUNCTION public.churn_save_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_churn_save_events_append_only ON churn_save_events;
CREATE TRIGGER trg_churn_save_events_append_only
  BEFORE UPDATE OR DELETE ON churn_save_events
  FOR EACH ROW EXECUTE FUNCTION public.churn_save_append_only();

DROP TRIGGER IF EXISTS trg_churn_save_audit_append_only ON churn_save_audit;
CREATE TRIGGER trg_churn_save_audit_append_only
  BEFORE UPDATE OR DELETE ON churn_save_audit
  FOR EACH ROW EXECUTE FUNCTION public.churn_save_append_only();

-- ---------------------------------------------------------------------------
-- 5. RLS: staff may read; nobody writes directly
-- ---------------------------------------------------------------------------
ALTER TABLE churn_save_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE churn_save_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE churn_save_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE churn_save_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE churn_save_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_churn_save_settings" ON churn_save_settings;
CREATE POLICY "staff_select_churn_save_settings" ON churn_save_settings FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_churn_save_offers" ON churn_save_offers;
CREATE POLICY "staff_select_churn_save_offers" ON churn_save_offers FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_churn_save_redemptions" ON churn_save_redemptions;
CREATE POLICY "staff_select_churn_save_redemptions" ON churn_save_redemptions FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_churn_save_events" ON churn_save_events;
CREATE POLICY "staff_select_churn_save_events" ON churn_save_events FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_churn_save_audit" ON churn_save_audit;
CREATE POLICY "staff_select_churn_save_audit" ON churn_save_audit FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON churn_save_settings, churn_save_offers, churn_save_redemptions, churn_save_events, churn_save_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON churn_save_settings, churn_save_offers, churn_save_redemptions, churn_save_events, churn_save_audit FROM authenticated;

-- ---------------------------------------------------------------------------
-- 6. Cap + targeting check: the SINGLE source of truth (NULL = claimable)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.churn_save_check(p_offer churn_save_offers, p_user uuid, p_reason text, p_band text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_settings churn_save_settings;
  v_n integer;
BEGIN
  SELECT * INTO v_settings FROM churn_save_settings WHERE id;
  IF NOT FOUND OR NOT v_settings.enabled OR NOT p_offer.enabled THEN RETURN 'disabled'; END IF;
  IF p_offer.starts_at IS NOT NULL AND now() < p_offer.starts_at THEN RETURN 'not_started'; END IF;
  IF p_offer.ends_at IS NOT NULL AND now() >= p_offer.ends_at THEN RETURN 'ended'; END IF;

  IF cardinality(p_offer.target_reasons) > 0 AND (p_reason IS NULL OR NOT (p_reason = ANY (p_offer.target_reasons))) THEN
    RETURN 'not_targeted';
  END IF;
  IF cardinality(p_offer.target_bands) > 0 AND (p_band IS NULL OR NOT (p_band = ANY (p_offer.target_bands))) THEN
    RETURN 'not_targeted';
  END IF;

  -- Per-account cap on this offer. A 'claimed' row only counts while fresh (a crashed
  -- request must not lock the customer out forever; Stripe-state guards cover the gap).
  SELECT count(*) INTO v_n FROM churn_save_redemptions r
   WHERE r.user_id = p_user AND r.offer_id = p_offer.id
     AND (r.status = 'applied' OR (r.status = 'claimed' AND r.created_at > now() - interval '15 minutes'));
  IF v_n >= p_offer.max_per_account THEN RETURN 'account_cap'; END IF;

  -- Cooldown on this offer
  IF p_offer.cooldown_days > 0 AND EXISTS (
    SELECT 1 FROM churn_save_redemptions r
     WHERE r.user_id = p_user AND r.offer_id = p_offer.id
       AND (r.status = 'applied' OR (r.status = 'claimed' AND r.created_at > now() - interval '15 minutes'))
       AND r.created_at > now() - make_interval(days => p_offer.cooldown_days)
  ) THEN RETURN 'cooldown'; END IF;

  -- Global cooldown across ALL offers (one save per account per window)
  IF v_settings.global_cooldown_days > 0 AND EXISTS (
    SELECT 1 FROM churn_save_redemptions r
     WHERE r.user_id = p_user
       AND (r.status = 'applied' OR (r.status = 'claimed' AND r.created_at > now() - interval '15 minutes'))
       AND r.created_at > now() - make_interval(days => v_settings.global_cooldown_days)
  ) THEN RETURN 'cooldown'; END IF;

  -- Total cap across all accounts in a rolling window
  IF p_offer.cap_total IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM churn_save_redemptions r
     WHERE r.offer_id = p_offer.id
       AND (r.status = 'applied' OR (r.status = 'claimed' AND r.created_at > now() - interval '15 minutes'))
       AND r.created_at > now() - make_interval(days => p_offer.cap_window_days);
    IF v_n >= p_offer.cap_total THEN RETURN 'total_cap'; END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- Is the save-offer system live at all? (kill switch ON and >=1 enabled offer in its window)
CREATE OR REPLACE FUNCTION public.churn_save_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((SELECT enabled FROM churn_save_settings WHERE id), false)
     AND EXISTS (
       SELECT 1 FROM churn_save_offers o
        WHERE o.enabled
          AND (o.starts_at IS NULL OR now() >= o.starts_at)
          AND (o.ends_at IS NULL OR now() < o.ends_at)
     );
$$;

CREATE OR REPLACE FUNCTION public.churn_save_eligible_offers(p_user uuid, p_reason text, p_band text)
RETURNS SETOF churn_save_offers
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT o.* FROM churn_save_offers o
   WHERE public.churn_save_check(o, p_user, p_reason, p_band) IS NULL
   ORDER BY o.priority, o.created_at;
$$;

-- Atomic claim: per-account advisory lock + offer row lock => caps cannot be exceeded.
CREATE OR REPLACE FUNCTION public.churn_save_claim(
  p_user uuid, p_offer uuid, p_reason text, p_band text, p_score integer, p_subscription text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer churn_save_offers;
  v_code text;
  v_id uuid;
  v_terms jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('churn_save_user:' || p_user::text, 0));
  SELECT * INTO v_offer FROM churn_save_offers WHERE id = p_offer FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;

  v_code := public.churn_save_check(v_offer, p_user, p_reason, p_band);
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;

  v_terms := jsonb_strip_nulls(jsonb_build_object(
    'pause_months', v_offer.pause_months,
    'downgrade_plan', v_offer.downgrade_plan,
    'discount_percent', v_offer.discount_percent,
    'discount_months', v_offer.discount_months
  ));
  INSERT INTO churn_save_redemptions (offer_id, user_id, kind, reason, risk_band, risk_score, terms, stripe_subscription_id)
  VALUES (v_offer.id, p_user, v_offer.kind, p_reason, p_band, p_score, v_terms, p_subscription)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'code', 'claimed', 'redemption_id', v_id, 'kind', v_offer.kind, 'terms', v_terms, 'offer_name', v_offer.name);
END;
$$;

-- Finish a claim: applied (Stripe changed) or failed (releases the allowance).
CREATE OR REPLACE FUNCTION public.churn_save_finalize(p_redemption uuid, p_ok boolean, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row churn_save_redemptions;
BEGIN
  UPDATE churn_save_redemptions
     SET status = CASE WHEN p_ok THEN 'applied' ELSE 'failed' END,
         error = CASE WHEN p_ok THEN NULL ELSE left(coalesce(p_error, 'unknown'), 300) END,
         updated_at = now()
   WHERE id = p_redemption AND status = 'claimed'
   RETURNING * INTO v_row;
  IF FOUND AND p_ok THEN
    INSERT INTO churn_save_events (user_id, offer_id, event, reason, risk_band)
    VALUES (v_row.user_id, v_row.offer_id, 'accepted', v_row.reason, v_row.risk_band);
  END IF;
END;
$$;

-- Funnel events. 'presented' is de-duplicated (same user+offer within 30 minutes).
CREATE OR REPLACE FUNCTION public.churn_save_log_presented(p_user uuid, p_offers uuid[], p_reason text, p_band text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO churn_save_events (user_id, offer_id, event, reason, risk_band)
  SELECT p_user, o.id, 'presented', p_reason, p_band
    FROM churn_save_offers o
   WHERE o.id = ANY (p_offers)
     AND NOT EXISTS (
       SELECT 1 FROM churn_save_events e
        WHERE e.user_id = p_user AND e.offer_id = o.id AND e.event = 'presented'
          AND e.created_at > now() - interval '30 minutes'
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Customer went on to cancel: every offer shown in the last 24h that got no answer = declined.
CREATE OR REPLACE FUNCTION public.churn_save_mark_declined(p_user uuid, p_reason text, p_band text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO churn_save_events (user_id, offer_id, event, reason, risk_band)
  SELECT p_user, s.offer_id, 'declined', p_reason, p_band
    FROM (
      SELECT e.offer_id, max(e.created_at) AS last_presented
        FROM churn_save_events e
       WHERE e.user_id = p_user AND e.event = 'presented' AND e.created_at > now() - interval '24 hours'
       GROUP BY e.offer_id
    ) s
   WHERE NOT EXISTS (
     SELECT 1 FROM churn_save_events x
      WHERE x.user_id = p_user AND x.offer_id = s.offer_id
        AND x.event IN ('accepted', 'declined') AND x.created_at >= s.last_presented
   );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Same signals as staff_account_overview, for ONE account (feeds computeHealth in the edge function).
CREATE OR REPLACE FUNCTION public.churn_save_account_signals(p_user uuid)
RETURNS TABLE (
  id uuid, status text, subscription_status text, dunning_stage integer, onboarding_completed boolean,
  minutes_used numeric, minutes_included numeric, created_at timestamptz, last_sign_in_at timestamptz,
  last_call_at timestamptz, calls_30d bigint, calls_prev_30d bigint, bookings_30d bigint,
  team_count bigint, numbers_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.status::text,
    p.subscription_status::text,
    coalesce(p.dunning_stage, 0)::integer,
    coalesce(p.onboarding_completed, false),
    coalesce(p.minutes_used_this_month, 0)::numeric,
    coalesce(p.minutes_included, 0)::numeric,
    p.created_at,
    au.last_sign_in_at,
    (SELECT max(cl.call_datetime) FROM calls cl WHERE cl.user_id = p.id AND cl.call_datetime >= now() - interval '365 days'),
    (SELECT count(*) FROM calls cl WHERE cl.user_id = p.id AND cl.call_datetime >= now() - interval '30 days'),
    (SELECT count(*) FROM calls cl WHERE cl.user_id = p.id AND cl.call_datetime >= now() - interval '60 days' AND cl.call_datetime < now() - interval '30 days'),
    (SELECT count(*) FROM calls cl WHERE cl.user_id = p.id AND cl.call_datetime >= now() - interval '30 days' AND cl.status = 'booked'),
    (SELECT count(*) FROM team_members tm WHERE tm.account_owner_id = p.id),
    (SELECT count(*) FROM phone_numbers pn WHERE pn.account_id = p.id)
  FROM profiles p
  LEFT JOIN auth.users au ON au.id = p.id
  WHERE p.id = p_user AND p.role = 'owner';
$$;

-- ---------------------------------------------------------------------------
-- 7. Staff RPCs (audited, staff-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.churn_save_require_staff()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  RETURN coalesce(v_email, '');
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_churn_save_upsert_offer(p_offer jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := public.churn_save_require_staff();
  v_id uuid;
  v_before churn_save_offers;
  v_after churn_save_offers;
  v_kind text;
  v_reasons text[];
  v_bands text[];
BEGIN
  IF p_offer IS NULL OR jsonb_typeof(p_offer) <> 'object' THEN
    RAISE EXCEPTION 'invalid_offer' USING ERRCODE = '22023';
  END IF;
  v_id := nullif(p_offer ->> 'id', '')::uuid;
  v_kind := p_offer ->> 'kind';
  v_reasons := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_offer -> 'target_reasons', '[]'::jsonb)));
  v_bands := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_offer -> 'target_bands', '[]'::jsonb)));

  IF v_id IS NULL THEN
    INSERT INTO churn_save_offers (
      kind, name, enabled, priority, target_reasons, target_bands,
      pause_months, downgrade_plan, discount_percent, discount_months,
      max_per_account, cooldown_days, cap_total, cap_window_days, starts_at, ends_at, created_by, updated_by
    ) VALUES (
      v_kind,
      btrim(p_offer ->> 'name'),
      coalesce((p_offer ->> 'enabled')::boolean, false),
      coalesce((p_offer ->> 'priority')::integer, 100),
      v_reasons, v_bands,
      (p_offer ->> 'pause_months')::smallint,
      nullif(p_offer ->> 'downgrade_plan', ''),
      (p_offer ->> 'discount_percent')::numeric,
      (p_offer ->> 'discount_months')::smallint,
      coalesce((p_offer ->> 'max_per_account')::smallint, 1),
      coalesce((p_offer ->> 'cooldown_days')::integer, 180),
      (p_offer ->> 'cap_total')::integer,
      coalesce((p_offer ->> 'cap_window_days')::integer, 30),
      (p_offer ->> 'starts_at')::timestamptz,
      (p_offer ->> 'ends_at')::timestamptz,
      auth.uid(), auth.uid()
    ) RETURNING * INTO v_after;
    INSERT INTO churn_save_audit (actor_id, actor_email, action, offer_id, before_state, after_state)
    VALUES (auth.uid(), v_email, 'offer_created', v_after.id, NULL, to_jsonb(v_after));
    RETURN to_jsonb(v_after);
  END IF;

  SELECT * INTO v_before FROM churn_save_offers WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_before.kind <> v_kind THEN RAISE EXCEPTION 'kind_immutable' USING ERRCODE = '22023'; END IF;

  UPDATE churn_save_offers SET
    name = btrim(p_offer ->> 'name'),
    enabled = coalesce((p_offer ->> 'enabled')::boolean, false),
    priority = coalesce((p_offer ->> 'priority')::integer, 100),
    target_reasons = v_reasons,
    target_bands = v_bands,
    pause_months = (p_offer ->> 'pause_months')::smallint,
    downgrade_plan = nullif(p_offer ->> 'downgrade_plan', ''),
    discount_percent = (p_offer ->> 'discount_percent')::numeric,
    discount_months = (p_offer ->> 'discount_months')::smallint,
    max_per_account = coalesce((p_offer ->> 'max_per_account')::smallint, 1),
    cooldown_days = coalesce((p_offer ->> 'cooldown_days')::integer, 180),
    cap_total = (p_offer ->> 'cap_total')::integer,
    cap_window_days = coalesce((p_offer ->> 'cap_window_days')::integer, 30),
    starts_at = (p_offer ->> 'starts_at')::timestamptz,
    ends_at = (p_offer ->> 'ends_at')::timestamptz,
    updated_by = auth.uid(),
    updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_after;

  INSERT INTO churn_save_audit (actor_id, actor_email, action, offer_id, before_state, after_state)
  VALUES (
    auth.uid(), v_email,
    CASE
      WHEN v_before.enabled = false AND v_after.enabled = true THEN 'offer_enabled'
      WHEN v_before.enabled = true AND v_after.enabled = false THEN 'offer_disabled'
      ELSE 'offer_updated'
    END,
    v_id, to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN to_jsonb(v_after);
EXCEPTION
  WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow OR not_null_violation THEN
    RAISE EXCEPTION 'invalid_offer' USING ERRCODE = '22023', DETAIL = SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_churn_save_set_settings(p_enabled boolean, p_global_cooldown_days integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := public.churn_save_require_staff();
  v_before churn_save_settings;
  v_after churn_save_settings;
BEGIN
  IF p_enabled IS NULL OR p_global_cooldown_days IS NULL OR p_global_cooldown_days NOT BETWEEN 0 AND 730 THEN
    RAISE EXCEPTION 'invalid_settings' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_before FROM churn_save_settings WHERE id FOR UPDATE;
  UPDATE churn_save_settings
     SET enabled = p_enabled, global_cooldown_days = p_global_cooldown_days, updated_by = auth.uid(), updated_at = now()
   WHERE id RETURNING * INTO v_after;
  INSERT INTO churn_save_audit (actor_id, actor_email, action, offer_id, before_state, after_state)
  VALUES (auth.uid(), v_email, 'settings_updated', NULL, to_jsonb(v_before), to_jsonb(v_after));
  RETURN to_jsonb(v_after);
END;
$$;

-- One call for the whole staff page: settings, offers + funnel, reasons, recent redemptions, audit.
CREATE OR REPLACE FUNCTION public.staff_churn_save_overview(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 365);
  v_since timestamptz;
  v_result jsonb;
BEGIN
  PERFORM public.churn_save_require_staff();
  v_since := now() - make_interval(days => v_days);

  SELECT jsonb_build_object(
    'days', v_days,
    'settings', (SELECT to_jsonb(s) - 'updated_by' FROM churn_save_settings s WHERE s.id),
    'offers', coalesce((
      SELECT jsonb_agg(
        to_jsonb(o) - 'created_by' - 'updated_by' || jsonb_build_object(
          'presented', (SELECT count(DISTINCT e.user_id) FROM churn_save_events e WHERE e.offer_id = o.id AND e.event = 'presented' AND e.created_at >= v_since),
          'declined', (SELECT count(DISTINCT e.user_id) FROM churn_save_events e WHERE e.offer_id = o.id AND e.event = 'declined' AND e.created_at >= v_since),
          'accepted', (SELECT count(*) FROM churn_save_redemptions r WHERE r.offer_id = o.id AND r.status = 'applied' AND r.created_at >= v_since),
          'failed', (SELECT count(*) FROM churn_save_redemptions r WHERE r.offer_id = o.id AND r.status = 'failed' AND r.created_at >= v_since),
          'in_cap_window', (SELECT count(*) FROM churn_save_redemptions r WHERE r.offer_id = o.id AND r.status IN ('applied', 'claimed') AND r.created_at > now() - make_interval(days => o.cap_window_days)),
          'retention_cohort_30d', (SELECT count(*) FROM churn_save_redemptions r WHERE r.offer_id = o.id AND r.status = 'applied' AND r.created_at >= v_since AND r.created_at <= now() - interval '30 days'),
          'retained_30d', (SELECT count(*) FROM churn_save_redemptions r JOIN profiles p ON p.id = r.user_id
                            WHERE r.offer_id = o.id AND r.status = 'applied' AND r.created_at >= v_since AND r.created_at <= now() - interval '30 days' AND p.status = 'active')
        ) ORDER BY o.priority, o.created_at)
      FROM churn_save_offers o), '[]'::jsonb),
    'reasons', coalesce((
      SELECT jsonb_agg(jsonb_build_object('reason', x.reason, 'presented', x.presented, 'accepted', x.accepted, 'declined', x.declined) ORDER BY x.presented DESC)
      FROM (
        SELECT coalesce(e.reason, 'unknown') AS reason,
               count(*) FILTER (WHERE e.event = 'presented') AS presented,
               count(*) FILTER (WHERE e.event = 'accepted') AS accepted,
               count(*) FILTER (WHERE e.event = 'declined') AS declined
          FROM churn_save_events e WHERE e.created_at >= v_since GROUP BY 1
      ) x), '[]'::jsonb),
    'bands', coalesce((
      SELECT jsonb_agg(jsonb_build_object('band', x.band, 'presented', x.presented, 'accepted', x.accepted) ORDER BY x.presented DESC)
      FROM (
        SELECT coalesce(e.risk_band, 'unknown') AS band,
               count(*) FILTER (WHERE e.event = 'presented') AS presented,
               count(*) FILTER (WHERE e.event = 'accepted') AS accepted
          FROM churn_save_events e WHERE e.created_at >= v_since GROUP BY 1
      ) x), '[]'::jsonb),
    'recent', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'offer_id', t.offer_id, 'offer_name', t.offer_name, 'kind', t.kind, 'status', t.status, 'reason', t.reason,
        'risk_band', t.risk_band, 'account', t.company, 'created_at', t.created_at) ORDER BY t.created_at DESC)
      FROM (
        SELECT r.id, r.offer_id, o.name AS offer_name, r.kind, r.status, r.reason, r.risk_band, coalesce(p.company_name, '')::text AS company, r.created_at
          FROM churn_save_redemptions r
          JOIN churn_save_offers o ON o.id = r.offer_id
          LEFT JOIN profiles p ON p.id = r.user_id
         WHERE r.status IN ('applied', 'failed') AND r.created_at >= v_since
         ORDER BY r.created_at DESC LIMIT 50
      ) t), '[]'::jsonb),
    'audit', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'action', a.action, 'offer_id', a.offer_id, 'actor_email', a.actor_email, 'created_at', a.created_at,
        'before', a.before_state, 'after', a.after_state) ORDER BY a.created_at DESC)
      FROM (SELECT * FROM churn_save_audit ORDER BY created_at DESC LIMIT 50) a), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.churn_save_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_check(churn_save_offers, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_is_active() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_eligible_offers(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_claim(uuid, uuid, text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_finalize(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_log_presented(uuid, uuid[], text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_mark_declined(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_account_signals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.churn_save_require_staff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_churn_save_upsert_offer(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_churn_save_set_settings(boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_churn_save_overview(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.churn_save_is_active() TO service_role;
GRANT EXECUTE ON FUNCTION public.churn_save_eligible_offers(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.churn_save_claim(uuid, uuid, text, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.churn_save_finalize(uuid, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.churn_save_log_presented(uuid, uuid[], text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.churn_save_mark_declined(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.churn_save_account_signals(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_churn_save_upsert_offer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_churn_save_set_settings(boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_churn_save_overview(integer) TO authenticated;
