/*
  # Service-protection offers + partner commission ledger  (extends module: financing_partners)

  Additive on top of 20290301000000_financing_partners.sql. Nothing existing is dropped or renamed.

  - New product `service_protection` behind its OWN flag (`service_protection`, default OFF) and its own
    per-account module entitlement (module_key `service_protection`), plus the SAME counsel-attested
    region rule table (financing_region_rules) = the licensing gate (item 100). Default: closed.
  - Offer lifecycle (eligibility -> quote -> accept -> fulfil):
      requested -> quoted -> accepted -> active   (+ declined / expired / canceled / failed)
    Price, term, plan name and the DISCLOSURE TEXT are stored exactly as the provider supplied them.
    Vireek authors none of it. The customer must acknowledge the SHA-256 of that exact text to accept.
  - partner_commission_entries: append-only ledger (accrual / reversal / settlement) for consumer_financing,
    service_protection and insurance_referral. Amounts come ONLY from provider-reported events. Idempotent per
    (partner_key, source_event_id). Sandbox partners can never create ledger rows.

  REQUIRES COUNSEL / OWNER BEFORE ANY REGION IS ENABLED:
    - TODO(counsel): whether service protection is regulated insurance, a service contract or a warranty in each region;
      producer/licensing requirements; wording, placement and timing of the provider disclosure.
    - TODO(owner): provider agreement, who receives commission (this ledger records the platform side only),
      commission accounting policy, refund/cancellation clawback terms.

  Rollback (dev/staging only — drops ledger evidence): DROP TABLE partner_commission_entries,
    protection_webhook_events, service_protection_offers CASCADE; drop every fin_*protection* / fin_record_commission /
    fin_is_sandbox_partner / fin_quote_total_cents / *_service_protection* / staff_*protection* / staff_commission_summary function;
    DELETE FROM feature_flags WHERE key='service_protection'; re-run the fin_gate definition from 20290301000000.
    Production rollback = leave the flag OFF (zero behaviour change).
*/

-- =============================================================
-- 0. Widen existing CHECKs (idempotent) so the gate/rules/audit accept the new product
-- =============================================================
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass::text AS tbl, con.conname
      FROM pg_constraint con
     WHERE con.contype = 'c'
       AND con.conrelid IN ('public.financing_region_rules'::regclass, 'public.financing_audit_events'::regclass)
       AND pg_get_constraintdef(con.oid) LIKE '%insurance_referral%'
       AND pg_get_constraintdef(con.oid) NOT LIKE '%service_protection%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_region_product_chk' AND conrelid = 'public.financing_region_rules'::regclass) THEN
    ALTER TABLE public.financing_region_rules ADD CONSTRAINT fin_region_product_chk
      CHECK (product IN ('consumer_financing', 'working_capital', 'insurance_referral', 'service_protection'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fin_audit_entity_chk' AND conrelid = 'public.financing_audit_events'::regclass) THEN
    ALTER TABLE public.financing_audit_events ADD CONSTRAINT fin_audit_entity_chk
      CHECK (entity_type IN ('quote_offer', 'working_capital_share', 'insurance_referral', 'consent', 'module',
                             'service_protection_offer', 'commission'));
  END IF;
END $$;

-- =============================================================
-- 1. Flag (default OFF) + gate (CREATE OR REPLACE: existing products behave exactly as before)
-- =============================================================
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('service_protection', 'Service protection offers',
        'Provider-hosted service-protection offers on quotes (eligibility, quote, accept, fulfil) and partner commission ledger. Default OFF.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fin_gate(p_owner uuid, p_product text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flag boolean; v_ent boolean; v_country text; v_region text; v_rule boolean; v_key text;
BEGIN
  IF p_owner IS NULL OR p_product NOT IN ('consumer_financing', 'working_capital', 'insurance_referral', 'service_protection') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid');
  END IF;
  v_key := CASE WHEN p_product = 'service_protection' THEN 'service_protection' ELSE 'financing_partners' END;

  SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_owner, f.key) INTO v_flag
    FROM public.feature_flags f
    LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_owner
   WHERE f.key = v_key;
  IF NOT COALESCE(v_flag, false) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'flag_off');
  END IF;

  SELECT enabled INTO v_ent FROM public.account_module_entitlements
   WHERE user_id = p_owner AND module_key = v_key;
  IF NOT COALESCE(v_ent, false) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_entitled');
  END IF;

  SELECT country INTO v_country FROM public.business_regional_settings WHERE user_id = p_owner;
  IF v_country IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'region_unknown');
  END IF;
  SELECT region_code INTO v_region FROM public.financing_account_settings WHERE user_id = p_owner;

  SELECT EXISTS (
    SELECT 1 FROM public.financing_region_rules r
     WHERE r.product = p_product AND r.country = v_country AND r.enabled
       AND r.counsel_reviewed_at IS NOT NULL
       AND (r.region = '*' OR r.region = COALESCE(v_region, ''))
  ) INTO v_rule;
  IF NOT v_rule THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'region_blocked');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason', NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_gate(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_gate(uuid, text) TO service_role;

-- =============================================================
-- 2. Offers
-- =============================================================
CREATE TABLE IF NOT EXISTS public.service_protection_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  partner_key text NOT NULL CHECK (partner_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  partner_name text NOT NULL CHECK (char_length(btrim(partner_name)) BETWEEN 1 AND 80),
  is_sandbox boolean NOT NULL DEFAULT false,
  partner_reference text CHECK (partner_reference IS NULL OR char_length(partner_reference) <= 128),
  covered_amount_cents integer NOT NULL CHECK (covered_amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Provider-supplied, stored verbatim. NULL until the provider quotes.
  plan_label text CHECK (plan_label IS NULL OR char_length(plan_label) BETWEEN 1 AND 120),
  price_cents integer CHECK (price_cents IS NULL OR price_cents > 0),
  term_months integer CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 600),
  provider_disclosure text CHECK (provider_disclosure IS NULL OR char_length(provider_disclosure) BETWEEN 40 AND 8000),
  provider_disclosure_sha256 text CHECK (provider_disclosure_sha256 IS NULL OR provider_disclosure_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'quoted', 'accepted', 'active', 'declined', 'expired', 'canceled', 'failed')),
  public_token uuid NOT NULL DEFAULT gen_random_uuid(),
  needs_review boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  quoted_at timestamptz,
  accepted_at timestamptz,
  acknowledged_sha256 text CHECK (acknowledged_sha256 IS NULL OR acknowledged_sha256 ~ '^[0-9a-f]{64}$'),
  active_at timestamptz,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spo_quoted_has_provider_data CHECK (
    status IN ('requested', 'declined', 'expired', 'canceled', 'failed')
    OR (price_cents IS NOT NULL AND term_months IS NOT NULL AND plan_label IS NOT NULL
        AND provider_disclosure IS NOT NULL AND provider_disclosure_sha256 IS NOT NULL)
  ),
  CONSTRAINT spo_accepted_has_ack CHECK (status NOT IN ('accepted', 'active') OR acknowledged_sha256 IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_spo_public_token ON public.service_protection_offers (public_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_spo_partner_ref ON public.service_protection_offers (partner_key, partner_reference) WHERE partner_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_spo_live_per_quote ON public.service_protection_offers (quote_id, partner_key)
  WHERE status IN ('requested', 'quoted', 'accepted', 'active');
CREATE INDEX IF NOT EXISTS idx_spo_user_created ON public.service_protection_offers (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spo_quote ON public.service_protection_offers (quote_id);
CREATE INDEX IF NOT EXISTS idx_spo_expiry ON public.service_protection_offers (expires_at) WHERE status IN ('requested', 'quoted');

ALTER TABLE public.service_protection_offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "spo_select_manager" ON public.service_protection_offers;
CREATE POLICY "spo_select_manager" ON public.service_protection_offers
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fin_can_manage(auth.uid()));
REVOKE ALL ON public.service_protection_offers FROM anon, authenticated;
-- public_token and the raw disclosure body are deliberately not selectable by the account (customer-facing RPCs only).
GRANT SELECT (id, user_id, quote_id, partner_key, partner_name, is_sandbox, partner_reference, covered_amount_cents, currency,
              plan_label, price_cents, term_months, status, needs_review, expires_at, quoted_at, accepted_at, active_at,
              closed_at, created_by, created_at, updated_at)
  ON public.service_protection_offers TO authenticated;
DROP TRIGGER IF EXISTS trg_spo_updated_at ON public.service_protection_offers;
CREATE TRIGGER trg_spo_updated_at BEFORE UPDATE ON public.service_protection_offers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS public.protection_webhook_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_key text NOT NULL,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  partner_reference text NOT NULL,
  reported_status text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL DEFAULT 'processing',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_key, event_id)
);
ALTER TABLE public.protection_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.protection_webhook_events FROM anon, authenticated;

-- =============================================================
-- 3. Commission ledger (append-only, provider-reported amounts only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.partner_commission_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,   -- originating account (no FK: ledger must outlive account erasure; same as financing_audit_events)
  product text NOT NULL CHECK (product IN ('consumer_financing', 'service_protection', 'insurance_referral')),
  entity_id uuid NOT NULL,
  partner_key text NOT NULL CHECK (partner_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  partner_reference text NOT NULL CHECK (char_length(partner_reference) BETWEEN 1 AND 128),
  entry_kind text NOT NULL CHECK (entry_kind IN ('accrual', 'reversal', 'settlement')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_event_id text NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_key, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_pce_entity ON public.partner_commission_entries (product, entity_id);
CREATE INDEX IF NOT EXISTS idx_pce_time ON public.partner_commission_entries (created_at DESC);
ALTER TABLE public.partner_commission_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_commission_entries FROM anon, authenticated;   -- staff-only via RPC; no tenant policy
DROP TRIGGER IF EXISTS trg_pce_append_only ON public.partner_commission_entries;
CREATE TRIGGER trg_pce_append_only BEFORE UPDATE OR DELETE ON public.partner_commission_entries
  FOR EACH ROW EXECUTE FUNCTION public.fin_block_mutation();
DROP TRIGGER IF EXISTS trg_pce_no_truncate ON public.partner_commission_entries;
CREATE TRIGGER trg_pce_no_truncate BEFORE TRUNCATE ON public.partner_commission_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.fin_block_mutation();

-- =============================================================
-- 4. Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.fin_protection_rank(p text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'requested' THEN 0 WHEN 'quoted' THEN 1 WHEN 'accepted' THEN 2 WHEN 'active' THEN 3 END;
$$;
-- Mirror of protectionTransition() in _shared/financing-partners/protection.ts
CREATE OR REPLACE FUNCTION public.fin_protection_transition(p_from text, p_to text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN 'noop'
    WHEN p_from IN ('active', 'declined', 'expired', 'canceled', 'failed') THEN 'reject'
    WHEN p_to = 'failed' THEN CASE WHEN p_from = 'requested' THEN 'apply' ELSE 'reject' END
    WHEN p_to IN ('declined', 'canceled') THEN 'apply'
    WHEN p_to = 'expired' THEN CASE WHEN p_from IN ('requested', 'quoted') THEN 'apply' ELSE 'reject' END
    WHEN public.fin_protection_rank(p_from) IS NULL OR public.fin_protection_rank(p_to) IS NULL THEN 'reject'
    WHEN public.fin_protection_rank(p_to) = public.fin_protection_rank(p_from) + 1 THEN 'apply'
    ELSE 'reject'
  END;
$$;

CREATE OR REPLACE FUNCTION public.fin_is_sandbox_partner(p_key text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_key IN ('mock', 'protection_stub');
$$;

-- Same arithmetic as fin_create_quote_offer, in one place for the new module. Returns NULL when unusable.
CREATE OR REPLACE FUNCTION public.fin_quote_total_cents(p_quote uuid, p_owner uuid)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE q public.quotes%ROWTYPE; v_sub numeric; v_total numeric;
BEGIN
  SELECT * INTO q FROM public.quotes WHERE id = p_quote AND user_id = p_owner AND status IN ('sent', 'accepted');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(
           CASE WHEN (li ->> 'quantity') ~ '^[0-9]+(\.[0-9]+)?$' AND (li ->> 'unit_price_cents') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (li ->> 'quantity')::numeric * (li ->> 'unit_price_cents')::numeric ELSE 0 END), 0)
    INTO v_sub
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.line_items) = 'array' THEN q.line_items ELSE '[]'::jsonb END) li;
  v_total := v_sub + round(v_sub * COALESCE(q.tax_percent, 0) / 100);
  IF v_total <= 0 OR v_total > 2147483647 THEN RETURN NULL; END IF;
  RETURN v_total::integer;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_quote_total_cents(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_quote_total_cents(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_protection_set_status(p_offer uuid, p_to text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.service_protection_offers SET
    status = p_to,
    quoted_at   = CASE WHEN p_to IN ('quoted', 'accepted', 'active') THEN COALESCE(quoted_at, now()) ELSE quoted_at END,
    accepted_at = CASE WHEN p_to IN ('accepted', 'active') THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
    active_at   = CASE WHEN p_to = 'active' THEN COALESCE(active_at, now()) ELSE active_at END,
    closed_at   = CASE WHEN p_to IN ('active', 'declined', 'expired', 'canceled', 'failed') THEN COALESCE(closed_at, now()) ELSE closed_at END
  WHERE id = p_offer;
$$;
REVOKE ALL ON FUNCTION public.fin_protection_set_status(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_protection_set_status(uuid, text) TO service_role;

-- =============================================================
-- 5. Create (eligibility) -> quote -> accept -> fulfil
-- =============================================================
CREATE OR REPLACE FUNCTION public.fin_create_protection_offer(
  p_owner uuid, p_actor uuid, p_quote uuid, p_partner_key text, p_partner_name text, p_sandbox boolean,
  p_currencies text[], p_min_cents integer, p_max_cents integer, p_ttl_days integer DEFAULT 14
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g jsonb; q public.quotes%ROWTYPE; v_amount integer; v_currency text; v_id uuid; v_existing public.service_protection_offers%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR p_actor IS NULL OR public.fin_owner_of(p_actor) IS DISTINCT FROM p_owner OR NOT public.fin_can_manage(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  g := public.fin_gate(p_owner, 'service_protection');
  IF NOT (g ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason');
  END IF;

  SELECT * INTO q FROM public.quotes WHERE id = p_quote AND user_id = p_owner AND status IN ('sent', 'accepted');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'quote_not_found'); END IF;
  v_amount := public.fin_quote_total_cents(p_quote, p_owner);
  IF v_amount IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_unavailable'); END IF;
  IF p_min_cents IS NOT NULL AND v_amount < p_min_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'below_minimum', 'min_cents', p_min_cents); END IF;
  IF p_max_cents IS NOT NULL AND v_amount > p_max_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'above_maximum', 'max_cents', p_max_cents); END IF;

  v_currency := upper(COALESCE(to_jsonb(q) ->> 'currency', 'USD'));
  IF v_currency !~ '^[A-Z]{3}$' THEN v_currency := 'USD'; END IF;
  IF p_currencies IS NOT NULL AND NOT (v_currency = ANY (SELECT upper(c) FROM unnest(p_currencies) c)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'currency_unsupported');
  END IF;

  SELECT * INTO v_existing FROM public.service_protection_offers
   WHERE quote_id = p_quote AND partner_key = p_partner_key AND status IN ('requested', 'quoted', 'accepted', 'active') LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'existing', true, 'offer_id', v_existing.id, 'status', v_existing.status, 'covered_amount_cents', v_existing.covered_amount_cents);
  END IF;

  BEGIN
    INSERT INTO public.service_protection_offers (user_id, quote_id, partner_key, partner_name, is_sandbox, covered_amount_cents, currency, expires_at, created_by)
    VALUES (p_owner, p_quote, p_partner_key, p_partner_name, COALESCE(p_sandbox, false), v_amount, v_currency,
            now() + make_interval(days => GREATEST(1, LEAST(COALESCE(p_ttl_days, 14), 60))), p_actor)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.service_protection_offers
     WHERE quote_id = p_quote AND partner_key = p_partner_key AND status IN ('requested', 'quoted', 'accepted', 'active') LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'existing', true, 'offer_id', v_existing.id, 'status', v_existing.status, 'covered_amount_cents', v_existing.covered_amount_cents);
  END;

  PERFORM public.fin_audit(p_owner, p_actor, 'account_user', 'protection.requested', 'service_protection_offer', v_id, NULL, 'requested',
                           jsonb_build_object('partner', p_partner_key));
  RETURN jsonb_build_object('ok', true, 'existing', false, 'offer_id', v_id, 'status', 'requested',
                            'covered_amount_cents', v_amount, 'currency', v_currency);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_create_protection_offer(uuid, uuid, uuid, text, text, boolean, text[], integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_create_protection_offer(uuid, uuid, uuid, text, text, boolean, text[], integer, integer, integer) TO service_role;

-- Stores the provider's quote verbatim. Used by the synchronous quote call AND the async 'quoted' webhook.
CREATE OR REPLACE FUNCTION public.fin_apply_protection_quote(
  p_offer uuid, p_reference text, p_price_cents integer, p_currency text, p_term_months integer, p_plan_label text, p_disclosure text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.service_protection_offers%ROWTYPE; v_sha text;
BEGIN
  SELECT * INTO o FROM public.service_protection_offers WHERE id = p_offer FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 1 AND 128
     OR p_price_cents IS NULL OR p_price_cents <= 0
     OR p_term_months IS NULL OR p_term_months NOT BETWEEN 1 AND 600
     OR p_plan_label IS NULL OR char_length(btrim(p_plan_label)) NOT BETWEEN 1 AND 120
     OR p_disclosure IS NULL OR char_length(btrim(p_disclosure)) < 40 OR char_length(p_disclosure) > 8000
     OR upper(COALESCE(p_currency, '')) !~ '^[A-Z]{3}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_quote');
  END IF;
  IF upper(p_currency) <> o.currency THEN RETURN jsonb_build_object('ok', false, 'error', 'currency_mismatch'); END IF;
  v_sha := encode(sha256(convert_to(p_disclosure, 'UTF8')), 'hex');

  IF o.status = 'quoted' AND o.partner_reference = p_reference AND o.provider_disclosure_sha256 = v_sha AND o.price_cents = p_price_cents THEN
    RETURN jsonb_build_object('ok', true, 'existing', true, 'disclosure_sha256', v_sha);   -- idempotent re-delivery
  END IF;
  IF o.status <> 'requested' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_open'); END IF;
  IF o.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'error', 'expired'); END IF;

  UPDATE public.service_protection_offers SET
    partner_reference = p_reference, price_cents = p_price_cents, term_months = p_term_months,
    plan_label = btrim(p_plan_label), provider_disclosure = p_disclosure, provider_disclosure_sha256 = v_sha
   WHERE id = p_offer;
  PERFORM public.fin_protection_set_status(p_offer, 'quoted');
  PERFORM public.fin_audit(o.user_id, NULL, 'partner', 'protection.quoted', 'service_protection_offer', p_offer, 'requested', 'quoted',
                           jsonb_build_object('partner', o.partner_key, 'disclosure_sha256', v_sha));
  RETURN jsonb_build_object('ok', true, 'existing', false, 'disclosure_sha256', v_sha);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_apply_protection_quote(uuid, text, integer, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_apply_protection_quote(uuid, text, integer, text, integer, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_fail_protection_offer(p_offer uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.service_protection_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.service_protection_offers WHERE id = p_offer FOR UPDATE;
  IF NOT FOUND OR public.fin_protection_transition(o.status, 'failed') <> 'apply' THEN RETURN; END IF;
  PERFORM public.fin_protection_set_status(p_offer, 'failed');
  PERFORM public.fin_audit(o.user_id, NULL, 'system', 'protection.partner_failed', 'service_protection_offer', p_offer, o.status, 'failed',
                           jsonb_build_object('code', left(COALESCE(p_reason, 'unknown'), 40)));
END;
$$;
REVOKE ALL ON FUNCTION public.fin_fail_protection_offer(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_fail_protection_offer(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_protection_set_review(p_offer uuid, p_value boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.service_protection_offers SET needs_review = COALESCE(p_value, false) WHERE id = p_offer;
$$;
REVOKE ALL ON FUNCTION public.fin_protection_set_review(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_protection_set_review(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_service_protection_offer(p_offer uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.service_protection_offers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.fin_can_manage(auth.uid()) THEN RETURN false; END IF;
  SELECT * INTO o FROM public.service_protection_offers
   WHERE id = p_offer AND user_id = public.fin_owner_of(auth.uid()) FOR UPDATE;
  IF NOT FOUND OR public.fin_protection_transition(o.status, 'canceled') <> 'apply' THEN RETURN false; END IF;
  PERFORM public.fin_protection_set_status(p_offer, 'canceled');
  PERFORM public.fin_audit(o.user_id, auth.uid(), 'account_user', 'protection.canceled', 'service_protection_offer', p_offer, o.status, 'canceled', '{}'::jsonb);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_service_protection_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_service_protection_offer(uuid) TO authenticated;

-- Public (customer) read by QUOTE token, same pattern as get_public_quote_financing.
CREATE OR REPLACE FUNCTION public.get_public_service_protection(p_quote_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE q public.quotes%ROWTYPE; o public.service_protection_offers%ROWTYPE; v_status text;
BEGIN
  IF p_quote_token IS NULL THEN RETURN jsonb_build_object('available', false); END IF;
  SELECT * INTO q FROM public.quotes WHERE quote_token = p_quote_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false); END IF;
  IF NOT (public.fin_gate(q.user_id, 'service_protection') ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('available', false);
  END IF;
  SELECT * INTO o FROM public.service_protection_offers
   WHERE quote_id = q.id AND status IN ('quoted', 'accepted', 'active') AND is_sandbox = false
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false); END IF;
  v_status := CASE WHEN o.status = 'quoted' AND o.expires_at <= now() THEN 'expired' ELSE o.status END;
  RETURN jsonb_build_object(
    'available', true, 'offer_token', o.public_token, 'status', v_status,
    'partner_name', o.partner_name, 'plan_label', o.plan_label, 'price_cents', o.price_cents, 'currency', o.currency,
    'term_months', o.term_months, 'disclosure_text', o.provider_disclosure, 'disclosure_sha256', o.provider_disclosure_sha256,
    'expires_at', o.expires_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_service_protection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_service_protection(uuid) TO anon, authenticated;

-- Customer accepts: must acknowledge the SHA-256 of the exact provider text they were shown. Idempotent.
CREATE OR REPLACE FUNCTION public.customer_accept_service_protection(p_offer_token uuid, p_disclosure_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.service_protection_offers%ROWTYPE;
BEGIN
  IF p_offer_token IS NULL OR p_disclosure_sha256 IS NULL OR p_disclosure_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'acknowledgement_required');
  END IF;
  SELECT * INTO o FROM public.service_protection_offers WHERE public_token = p_offer_token AND is_sandbox = false FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT (public.fin_gate(o.user_id, 'service_protection') ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unavailable');
  END IF;
  IF o.provider_disclosure_sha256 IS NULL OR o.provider_disclosure_sha256 <> p_disclosure_sha256 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'disclosure_mismatch');
  END IF;
  IF o.status IN ('accepted', 'active') THEN
    RETURN jsonb_build_object('ok', true, 'existing', true, 'offer_id', o.id, 'status', o.status, 'needs_review', o.needs_review,
                              'partner_key', o.partner_key, 'partner_reference', o.partner_reference);
  END IF;
  IF o.status <> 'quoted' OR o.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'error', 'not_open'); END IF;

  UPDATE public.service_protection_offers SET acknowledged_sha256 = p_disclosure_sha256 WHERE id = o.id;
  PERFORM public.fin_protection_set_status(o.id, 'accepted');
  PERFORM public.fin_audit(o.user_id, NULL, 'customer', 'protection.accepted', 'service_protection_offer', o.id, 'quoted', 'accepted',
                           jsonb_build_object('disclosure_sha256', p_disclosure_sha256));
  RETURN jsonb_build_object('ok', true, 'existing', false, 'offer_id', o.id, 'status', 'accepted', 'needs_review', false,
                            'partner_key', o.partner_key, 'partner_reference', o.partner_reference);
END;
$$;
REVOKE ALL ON FUNCTION public.customer_accept_service_protection(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_accept_service_protection(uuid, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_expire_stale_protection_offers()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer := 0; r record;
BEGIN
  FOR r IN SELECT id, user_id, status FROM public.service_protection_offers
            WHERE status IN ('requested', 'quoted') AND expires_at <= now() FOR UPDATE SKIP LOCKED LOOP
    PERFORM public.fin_protection_set_status(r.id, 'expired');
    PERFORM public.fin_audit(r.user_id, NULL, 'system', 'protection.expired', 'service_protection_offer', r.id, r.status, 'expired', '{}'::jsonb);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_expire_stale_protection_offers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_expire_stale_protection_offers() TO service_role;

-- =============================================================
-- 6. Commission recording (service role only; amounts are provider-reported)
-- =============================================================
CREATE OR REPLACE FUNCTION public.fin_record_commission(
  p_partner_key text, p_source_event_id text, p_product text, p_partner_reference text,
  p_kind text, p_amount_cents bigint, p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid; v_entity uuid; v_status text; v_sandbox boolean := false; v_currency text := upper(COALESCE(p_currency, ''));
  v_accrued bigint; v_reversed bigint; v_settled bigint; v_other_cur integer; v_inserted bigint;
BEGIN
  IF p_product NOT IN ('consumer_financing', 'service_protection', 'insurance_referral')
     OR p_kind NOT IN ('accrual', 'reversal', 'settlement')
     OR p_amount_cents IS NULL OR p_amount_cents <= 0 OR v_currency !~ '^[A-Z]{3}$'
     OR p_source_event_id IS NULL OR char_length(p_source_event_id) NOT BETWEEN 1 AND 128
     OR p_partner_reference IS NULL OR char_length(p_partner_reference) NOT BETWEEN 1 AND 128 THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;

  IF EXISTS (SELECT 1 FROM public.partner_commission_entries WHERE partner_key = p_partner_key AND source_event_id = p_source_event_id) THEN
    RETURN jsonb_build_object('outcome', 'duplicate');
  END IF;
  IF public.fin_is_sandbox_partner(p_partner_key) THEN RETURN jsonb_build_object('outcome', 'sandbox_partner'); END IF;

  IF p_product = 'consumer_financing' THEN
    SELECT id, user_id, status INTO v_entity, v_owner, v_status FROM public.quote_financing_offers
     WHERE partner_key = p_partner_key AND partner_reference = p_partner_reference;
    IF FOUND AND v_status <> 'funded' AND p_kind = 'accrual' THEN RETURN jsonb_build_object('outcome', 'not_eligible_status'); END IF;
  ELSIF p_product = 'service_protection' THEN
    SELECT id, user_id, status, is_sandbox INTO v_entity, v_owner, v_status, v_sandbox FROM public.service_protection_offers
     WHERE partner_key = p_partner_key AND partner_reference = p_partner_reference;
    IF FOUND AND v_sandbox THEN RETURN jsonb_build_object('outcome', 'sandbox_partner'); END IF;
    IF FOUND AND v_status <> 'active' AND p_kind = 'accrual' THEN RETURN jsonb_build_object('outcome', 'not_eligible_status'); END IF;
  ELSE
    SELECT id, user_id, status INTO v_entity, v_owner, v_status FROM public.insurance_referrals
     WHERE partner_key = p_partner_key AND partner_reference = p_partner_reference;
    IF FOUND AND v_status <> 'bound' AND p_kind = 'accrual' THEN RETURN jsonb_build_object('outcome', 'not_eligible_status'); END IF;
  END IF;
  IF v_entity IS NULL THEN RETURN jsonb_build_object('outcome', 'unknown_reference'); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fin_commission:' || v_entity::text));

  SELECT count(*) INTO v_other_cur FROM public.partner_commission_entries
   WHERE product = p_product AND entity_id = v_entity AND currency <> v_currency;
  IF v_other_cur > 0 THEN RETURN jsonb_build_object('outcome', 'currency_mismatch'); END IF;

  SELECT COALESCE(SUM(amount_cents) FILTER (WHERE entry_kind = 'accrual'), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE entry_kind = 'reversal'), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE entry_kind = 'settlement'), 0)
    INTO v_accrued, v_reversed, v_settled
    FROM public.partner_commission_entries WHERE product = p_product AND entity_id = v_entity;

  IF p_kind = 'reversal' AND p_amount_cents > (v_accrued - v_reversed) THEN RETURN jsonb_build_object('outcome', 'exceeds_balance'); END IF;
  IF p_kind = 'settlement' AND p_amount_cents > (v_accrued - v_reversed - v_settled) THEN RETURN jsonb_build_object('outcome', 'exceeds_balance'); END IF;

  INSERT INTO public.partner_commission_entries (user_id, product, entity_id, partner_key, partner_reference, entry_kind, amount_cents, currency, source_event_id)
  VALUES (v_owner, p_product, v_entity, p_partner_key, p_partner_reference, p_kind, p_amount_cents, v_currency, p_source_event_id)
  ON CONFLICT (partner_key, source_event_id) DO NOTHING
  RETURNING id INTO v_inserted;
  IF v_inserted IS NULL THEN RETURN jsonb_build_object('outcome', 'duplicate'); END IF;

  PERFORM public.fin_audit(v_owner, NULL, 'partner', 'commission.' || p_kind, 'commission', v_entity, NULL, NULL,
                           jsonb_build_object('product', p_product, 'partner', p_partner_key, 'amount_cents', p_amount_cents, 'currency', v_currency));
  RETURN jsonb_build_object('outcome', 'applied');
END;
$$;
REVOKE ALL ON FUNCTION public.fin_record_commission(text, text, text, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_record_commission(text, text, text, text, text, bigint, text) TO service_role;

-- =============================================================
-- 7. Provider webhook (idempotent, forward-only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.fin_apply_protection_event(
  p_partner_key text, p_event_id text, p_partner_reference text, p_status text, p_payload_sha256 text,
  p_quote jsonb DEFAULT NULL, p_commission jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inserted bigint; v_outcome text; v_verdict text; o public.service_protection_offers%ROWTYPE; v_res jsonb;
BEGIN
  IF p_status NOT IN ('quoted', 'active', 'declined', 'expired', 'canceled') THEN RETURN jsonb_build_object('outcome', 'invalid_status'); END IF;

  INSERT INTO public.protection_webhook_events (partner_key, event_id, partner_reference, reported_status, payload_sha256, outcome)
  VALUES (p_partner_key, p_event_id, p_partner_reference, p_status, p_payload_sha256, 'processing')
  ON CONFLICT (partner_key, event_id) DO NOTHING RETURNING id INTO v_inserted;
  IF v_inserted IS NULL THEN RETURN jsonb_build_object('outcome', 'duplicate'); END IF;

  SELECT * INTO o FROM public.service_protection_offers WHERE partner_key = p_partner_key AND partner_reference = p_partner_reference FOR UPDATE;
  IF NOT FOUND THEN
    v_outcome := 'unknown_reference';
  ELSIF p_status = 'quoted' THEN
    -- Async quote delivery: only valid while the offer is still 'requested' (handled by fin_apply_protection_quote).
    IF p_quote IS NULL THEN
      v_outcome := 'invalid_quote';
    ELSE
      v_res := public.fin_apply_protection_quote(o.id, p_partner_reference, (p_quote ->> 'priceCents')::integer, p_quote ->> 'currency',
                                                 (p_quote ->> 'termMonths')::integer, p_quote ->> 'planLabel', p_quote ->> 'disclosureText');
      v_outcome := CASE WHEN (v_res ->> 'ok')::boolean THEN 'applied' ELSE COALESCE(v_res ->> 'error', 'rejected') END;
    END IF;
  ELSE
    v_verdict := public.fin_protection_transition(o.status, p_status);
    IF v_verdict = 'apply' THEN
      PERFORM public.fin_protection_set_status(o.id, p_status);
      PERFORM public.fin_audit(o.user_id, NULL, 'partner', 'protection.status_changed', 'service_protection_offer', o.id, o.status, p_status,
                               jsonb_build_object('partner', p_partner_key));
      v_outcome := 'applied';
    ELSIF v_verdict = 'noop' THEN
      v_outcome := 'noop';
    ELSE
      v_outcome := 'rejected_transition';
      IF p_status = 'active' THEN UPDATE public.service_protection_offers SET needs_review = true WHERE id = o.id; END IF;
      PERFORM public.fin_audit(o.user_id, NULL, 'partner', 'protection.transition_rejected', 'service_protection_offer', o.id, o.status, p_status,
                               jsonb_build_object('partner', p_partner_key));
    END IF;
  END IF;

  -- Provider-reported commission rides on the same event; booked only if the offer exists (the ledger enforces the rest).
  IF p_commission IS NOT NULL AND o.id IS NOT NULL THEN
    v_res := public.fin_record_commission(p_partner_key, p_event_id, 'service_protection', p_partner_reference,
                                          p_commission ->> 'kind', (p_commission ->> 'amountCents')::bigint, p_commission ->> 'currency');
    v_outcome := v_outcome || '+commission:' || COALESCE(v_res ->> 'outcome', 'unknown');
  END IF;

  UPDATE public.protection_webhook_events SET outcome = left(v_outcome, 120) WHERE id = v_inserted;
  RETURN jsonb_build_object('outcome', v_outcome);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_apply_protection_event(text, text, text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_apply_protection_event(text, text, text, text, text, jsonb, jsonb) TO service_role;

-- =============================================================
-- 8. Staff: entitlement + ledger summary
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_set_protection_entitlement(p_tenant uuid, p_enabled boolean, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.account_module_entitlements (user_id, module_key, enabled, note, updated_by)
  VALUES (p_tenant, 'service_protection', COALESCE(p_enabled, false), left(p_note, 300), auth.uid())
  ON CONFLICT (user_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled, note = EXCLUDED.note, updated_by = auth.uid();
  PERFORM public.fin_audit(p_tenant, auth.uid(), 'staff', 'module.service_protection', 'module', NULL, NULL, CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END, '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_protection_entitlement(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_protection_entitlement(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_commission_summary(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (product text, partner_key text, currency text, accrued_cents bigint, reversed_cents bigint, settled_cents bigint, outstanding_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'Invalid period' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT e.product, e.partner_key, e.currency,
         COALESCE(SUM(e.amount_cents) FILTER (WHERE e.entry_kind = 'accrual'), 0)::bigint,
         COALESCE(SUM(e.amount_cents) FILTER (WHERE e.entry_kind = 'reversal'), 0)::bigint,
         COALESCE(SUM(e.amount_cents) FILTER (WHERE e.entry_kind = 'settlement'), 0)::bigint,
         (COALESCE(SUM(e.amount_cents) FILTER (WHERE e.entry_kind = 'accrual'), 0)
          - COALESCE(SUM(e.amount_cents) FILTER (WHERE e.entry_kind = 'reversal'), 0)
          - COALESCE(SUM(e.amount_cents) FILTER (WHERE e.entry_kind = 'settlement'), 0))::bigint
    FROM public.partner_commission_entries e
   WHERE e.created_at >= p_from AND e.created_at < p_to
   GROUP BY e.product, e.partner_key, e.currency
   ORDER BY e.product, e.partner_key, e.currency;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_commission_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_commission_summary(timestamptz, timestamptz) TO authenticated;

COMMENT ON TABLE public.service_protection_offers IS
  'Provider-hosted service-protection offers. Price/term/plan/disclosure are provider-supplied verbatim; Vireek authors none of it. Gate: flag service_protection + entitlement + counsel-reviewed region rule.';
COMMENT ON TABLE public.partner_commission_entries IS
  'Append-only commission ledger. Provider-reported amounts only; sandbox partners never write here.';
