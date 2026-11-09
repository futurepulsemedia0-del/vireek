/*
  # Partner-based financing & insurance offers  (module: financing_partners)

  Vireek NEVER makes credit decisions and NEVER holds funds. A partner hosts
  the application, decides, funds and reports status; Vireek records partner
  references + coarse statuses only. No credit data (APR, income, score,
  decline reason) is stored by THIS module. Legacy financing_offers /
  financing_offer_events are untouched.

  Safety: default OFF (flag `financing_partners` + per-account entitlement +
  counsel-attested region rule, see fin_gate). RLS via get_account_owner_id();
  writes only through SECURITY DEFINER functions; consents + audit append-only;
  webhooks idempotent with a forward-only transition matrix.

  REQUIRES COUNSEL: disclosure wording/placement and region enablement.

  Rollback (dev/staging only — drops audit evidence): DROP the tables
  insurance_referrals, working_capital_shares, quote_financing_offers,
  financing_webhook_events, financing_audit_events, financing_consents,
  financing_disclosures, financing_account_settings, financing_region_rules,
  account_module_entitlements (CASCADE), drop every fin_* / *_financing_*
  function, DELETE FROM feature_flags WHERE key='financing_partners'.
  Production rollback = turn the flag OFF (zero behaviour change).
*/

-- 0. Append-only guard
CREATE OR REPLACE FUNCTION public.fin_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- 1. Module entitlement + flag seed (default OFF)
CREATE TABLE IF NOT EXISTS public.account_module_entitlements (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  enabled boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_key)
);
ALTER TABLE public.account_module_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ame_select_own" ON public.account_module_entitlements;
CREATE POLICY "ame_select_own" ON public.account_module_entitlements
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.account_module_entitlements FROM anon, authenticated;
GRANT SELECT ON public.account_module_entitlements TO authenticated;
DROP TRIGGER IF EXISTS trg_ame_updated_at ON public.account_module_entitlements;
CREATE TRIGGER trg_ame_updated_at BEFORE UPDATE ON public.account_module_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('financing_partners', 'Partner financing & insurance',
        'Partner-hosted financing on quotes, working-capital signals (consent-gated) and insurance referrals. Default OFF.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

-- 2. Region gating
CREATE TABLE IF NOT EXISTS public.financing_region_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL CHECK (product IN ('consumer_financing', 'working_capital', 'insurance_referral')),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  region text NOT NULL DEFAULT '*' CHECK (region = '*' OR region ~ '^[A-Z0-9-]{1,10}$'),
  enabled boolean NOT NULL DEFAULT false,
  counsel_reviewed_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, country, region),
  CONSTRAINT fin_region_enabled_needs_counsel CHECK (NOT enabled OR counsel_reviewed_at IS NOT NULL)
);
ALTER TABLE public.financing_region_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financing_region_rules FROM anon, authenticated;
DROP TRIGGER IF EXISTS trg_fin_region_updated_at ON public.financing_region_rules;
CREATE TRIGGER trg_fin_region_updated_at BEFORE UPDATE ON public.financing_region_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS public.financing_account_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  region_code text CHECK (region_code IS NULL OR region_code ~ '^[A-Z0-9-]{1,10}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.financing_account_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fas_select_own" ON public.financing_account_settings;
CREATE POLICY "fas_select_own" ON public.financing_account_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE ALL ON public.financing_account_settings FROM anon, authenticated;
GRANT SELECT ON public.financing_account_settings TO authenticated;

-- 3. Versioned disclosures (immutable wording) — REQUIRES COUNSEL
CREATE TABLE IF NOT EXISTS public.financing_disclosures (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9_.-]{3,40}$'),
  product text NOT NULL CHECK (product IN ('consumer_financing', 'working_capital', 'insurance_referral')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 40 AND 4000),
  active boolean NOT NULL DEFAULT false,
  counsel_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.financing_disclosures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financing_disclosures FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_disclosure_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version OR NEW.body IS DISTINCT FROM OLD.body OR NEW.product IS DISTINCT FROM OLD.product THEN
    RAISE EXCEPTION 'Disclosure wording is immutable; publish a new version' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fin_disclosure_immutable ON public.financing_disclosures;
CREATE TRIGGER trg_fin_disclosure_immutable BEFORE UPDATE ON public.financing_disclosures
  FOR EACH ROW EXECUTE FUNCTION public.fin_disclosure_immutable();

INSERT INTO public.financing_disclosures (version, product, body, active) VALUES
 ('cf-placeholder-1', 'consumer_financing',
  '{partner} — not Vireek and not your contractor — offers and decides financing. Vireek does not make credit decisions, lend money or hold funds. Applying takes you to {partner}''s website, where {partner} alone determines approval, rates and terms and handles your information under its own privacy policy. Financing is optional; you can pay your contractor directly instead. [PLACEHOLDER WORDING — REQUIRES COUNSEL]',
  true),
 ('wc-placeholder-1', 'working_capital',
  'You authorize Vireek to share the business-activity signals you select (banded totals, never individual customers or invoices) with {partner}. {partner}, not Vireek, decides whether to offer working capital and on what terms; sharing is not an application and does not guarantee any offer. You can revoke this at any time; revoking stops future sharing but cannot recall data already sent. [PLACEHOLDER WORDING — REQUIRES COUNSEL]',
  true),
 ('ins-placeholder-1', 'insurance_referral',
  'Vireek is introducing your business to {partner}. Vireek is not an insurer, broker or agent and does not recommend a policy. If you continue, your business name and (if you tick the box) your email will be shared with {partner} so it can contact you. [PLACEHOLDER WORDING — REQUIRES COUNSEL]',
  true)
ON CONFLICT (version) DO NOTHING;

-- 4. Append-only consent log + audit trail
CREATE TABLE IF NOT EXISTS public.financing_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  consent_type text NOT NULL CHECK (consent_type IN ('financing_disclosure_ack', 'working_capital_share', 'insurance_referral_contact')),
  action text NOT NULL CHECK (action IN ('granted', 'revoked')),
  subject_id uuid,
  partner_key text NOT NULL,
  disclosure_version text NOT NULL,
  disclosure_sha256 text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('customer', 'account_user', 'system')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_consents_lookup ON public.financing_consents (user_id, consent_type, partner_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_consents_subject ON public.financing_consents (subject_id) WHERE subject_id IS NOT NULL;
ALTER TABLE public.financing_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fin_consents_select_owner" ON public.financing_consents;
CREATE POLICY "fin_consents_select_owner" ON public.financing_consents
  FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.financing_consents FROM anon, authenticated;
GRANT SELECT ON public.financing_consents TO authenticated;
DROP TRIGGER IF EXISTS trg_fin_consents_append_only ON public.financing_consents;
CREATE TRIGGER trg_fin_consents_append_only BEFORE UPDATE OR DELETE ON public.financing_consents
  FOR EACH ROW EXECUTE FUNCTION public.fin_block_mutation();
DROP TRIGGER IF EXISTS trg_fin_consents_no_truncate ON public.financing_consents;
CREATE TRIGGER trg_fin_consents_no_truncate BEFORE TRUNCATE ON public.financing_consents
  FOR EACH STATEMENT EXECUTE FUNCTION public.fin_block_mutation();

CREATE TABLE IF NOT EXISTS public.financing_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('customer', 'account_user', 'partner', 'staff', 'system')),
  action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 80),
  entity_type text NOT NULL CHECK (entity_type IN ('quote_offer', 'working_capital_share', 'insurance_referral', 'consent', 'module')),
  entity_id uuid,
  from_status text,
  to_status text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_audit_user_time ON public.financing_audit_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_audit_entity ON public.financing_audit_events (entity_type, entity_id);
ALTER TABLE public.financing_audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fin_audit_select_owner" ON public.financing_audit_events;
CREATE POLICY "fin_audit_select_owner" ON public.financing_audit_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.financing_audit_events FROM anon, authenticated;
GRANT SELECT ON public.financing_audit_events TO authenticated;
DROP TRIGGER IF EXISTS trg_fin_audit_append_only ON public.financing_audit_events;
CREATE TRIGGER trg_fin_audit_append_only BEFORE UPDATE OR DELETE ON public.financing_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.fin_block_mutation();
DROP TRIGGER IF EXISTS trg_fin_audit_no_truncate ON public.financing_audit_events;
CREATE TRIGGER trg_fin_audit_no_truncate BEFORE TRUNCATE ON public.financing_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.fin_block_mutation();

CREATE OR REPLACE FUNCTION public.fin_audit(
  p_user uuid, p_actor uuid, p_actor_kind text, p_action text, p_entity_type text,
  p_entity_id uuid, p_from text, p_to text, p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.financing_audit_events (user_id, actor_id, actor_kind, action, entity_type, entity_id, from_status, to_status, details)
  VALUES (p_user, p_actor, p_actor_kind, p_action, p_entity_type, p_entity_id, p_from, p_to, COALESCE(p_details, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.fin_audit(uuid, uuid, text, text, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_audit(uuid, uuid, text, text, text, uuid, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_record_consent(
  p_user uuid, p_type text, p_action text, p_subject uuid, p_partner text,
  p_version text, p_body text, p_scope jsonb, p_actor uuid, p_actor_kind text, p_expires timestamptz
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.financing_consents (user_id, consent_type, action, subject_id, partner_key, disclosure_version,
                                         disclosure_sha256, scope, actor_id, actor_kind, expires_at)
  VALUES (p_user, p_type, p_action, p_subject, p_partner, p_version,
          encode(sha256(convert_to(p_body, 'UTF8')), 'hex'), COALESCE(p_scope, '{}'::jsonb), p_actor, p_actor_kind, p_expires)
  RETURNING id INTO v_id;
  PERFORM public.fin_audit(p_user, p_actor, CASE WHEN p_actor_kind = 'customer' THEN 'customer' ELSE 'account_user' END,
                           'consent.' || p_action, 'consent', v_id, NULL, NULL,
                           jsonb_build_object('type', p_type, 'partner', p_partner, 'version', p_version));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_record_consent(uuid, text, text, uuid, text, text, text, jsonb, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_record_consent(uuid, text, text, uuid, text, text, text, jsonb, uuid, text, timestamptz) TO service_role;

-- 5. Actor / permission / gate helpers
CREATE OR REPLACE FUNCTION public.fin_owner_of(p_user uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT id FROM public.profiles WHERE id = p_user),
    (SELECT account_owner_id FROM public.team_members
      WHERE member_email = (SELECT email FROM auth.users WHERE id = p_user) LIMIT 1)
  );
$$;

CREATE OR REPLACE FUNCTION public.fin_can_manage(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_user IS NULL THEN false
    WHEN public.fin_owner_of(p_user) IS NULL THEN false
    WHEN public.fin_owner_of(p_user) = p_user THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.team_members tm
       WHERE tm.account_owner_id = public.fin_owner_of(p_user)
         AND tm.member_email = (SELECT email FROM auth.users WHERE id = p_user)
         AND (tm.role = 'admin' OR COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true')
    )
  END;
$$;
GRANT EXECUTE ON FUNCTION public.fin_owner_of(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_can_manage(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fin_gate(p_owner uuid, p_product text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flag boolean; v_ent boolean; v_country text; v_region text; v_rule boolean;
BEGIN
  IF p_owner IS NULL OR p_product NOT IN ('consumer_financing', 'working_capital', 'insurance_referral') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid');
  END IF;

  SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_owner, f.key) INTO v_flag
    FROM public.feature_flags f
    LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_owner
   WHERE f.key = 'financing_partners';
  IF NOT COALESCE(v_flag, false) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'flag_off');
  END IF;

  SELECT enabled INTO v_ent FROM public.account_module_entitlements
   WHERE user_id = p_owner AND module_key = 'financing_partners';
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

CREATE OR REPLACE FUNCTION public.my_financing_gate(p_product text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN NOT public.fin_can_manage(auth.uid()) THEN jsonb_build_object('allowed', false, 'reason', 'forbidden')
    ELSE public.fin_gate(public.get_account_owner_id(), p_product)
  END;
$$;
REVOKE ALL ON FUNCTION public.my_financing_gate(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_financing_gate(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_financing_region(p_region_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can set the financing region' USING ERRCODE = '42501';
  END IF;
  IF p_region_code IS NOT NULL AND p_region_code !~ '^[A-Z0-9-]{1,10}$' THEN
    RAISE EXCEPTION 'Invalid region code' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.financing_account_settings (user_id, region_code, updated_at)
  VALUES (v_owner, p_region_code, now())
  ON CONFLICT (user_id) DO UPDATE SET region_code = EXCLUDED.region_code, updated_at = now();
  PERFORM public.fin_audit(v_owner, auth.uid(), 'account_user', 'settings.region_set', 'module', NULL, NULL, NULL,
                           jsonb_build_object('region_code', p_region_code));
END;
$$;
REVOKE ALL ON FUNCTION public.set_financing_region(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_financing_region(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_financing_disclosure(p_product text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(d) FROM (
    SELECT version, product, body, counsel_reviewed_at IS NOT NULL AS counsel_reviewed
      FROM public.financing_disclosures
     WHERE product = p_product AND active
     ORDER BY created_at DESC LIMIT 1
  ) d
  WHERE public.fin_can_manage(auth.uid());
$$;
REVOKE ALL ON FUNCTION public.get_financing_disclosure(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_financing_disclosure(text) TO authenticated;

-- 6. Transition matrices (mirror of stateMachine.ts)
CREATE OR REPLACE FUNCTION public.fin_financing_rank(p text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'offered' THEN 0 WHEN 'link_opened' THEN 1 WHEN 'submitted' THEN 2 WHEN 'approved' THEN 3 WHEN 'funded' THEN 4 END;
$$;
CREATE OR REPLACE FUNCTION public.fin_financing_transition(p_from text, p_to text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN 'noop'
    WHEN p_from IN ('funded', 'declined', 'expired', 'canceled') THEN 'reject'
    WHEN p_to = 'declined' THEN CASE WHEN p_from IN ('offered', 'link_opened', 'submitted') THEN 'apply' ELSE 'reject' END
    WHEN p_to IN ('expired', 'canceled') THEN 'apply'
    WHEN public.fin_financing_rank(p_from) IS NULL OR public.fin_financing_rank(p_to) IS NULL THEN 'reject'
    WHEN public.fin_financing_rank(p_to) > public.fin_financing_rank(p_from) THEN 'apply'
    ELSE 'reject'
  END;
$$;
CREATE OR REPLACE FUNCTION public.fin_insurance_rank(p text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'referred' THEN 0 WHEN 'contacted' THEN 1 WHEN 'quoted' THEN 2 WHEN 'bound' THEN 3 END;
$$;
CREATE OR REPLACE FUNCTION public.fin_insurance_transition(p_from text, p_to text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN 'noop'
    WHEN p_from IN ('bound', 'declined', 'expired', 'canceled') THEN 'reject'
    WHEN p_to = 'declined' THEN CASE WHEN p_from IN ('referred', 'contacted', 'quoted') THEN 'apply' ELSE 'reject' END
    WHEN p_to IN ('expired', 'canceled') THEN 'apply'
    WHEN public.fin_insurance_rank(p_from) IS NULL OR public.fin_insurance_rank(p_to) IS NULL THEN 'reject'
    WHEN public.fin_insurance_rank(p_to) > public.fin_insurance_rank(p_from) THEN 'apply'
    ELSE 'reject'
  END;
$$;

-- 7. Quote financing offers (partner reference + status only)
CREATE TABLE IF NOT EXISTS public.quote_financing_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  partner_key text NOT NULL CHECK (partner_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  partner_name text NOT NULL CHECK (char_length(btrim(partner_name)) BETWEEN 1 AND 80),
  partner_reference text CHECK (partner_reference IS NULL OR char_length(partner_reference) <= 128),
  application_url text CHECK (application_url IS NULL OR (application_url ~ '^https://' AND char_length(application_url) <= 2048)),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered', 'link_opened', 'submitted', 'approved', 'funded', 'declined', 'expired', 'canceled')),
  public_token uuid NOT NULL DEFAULT gen_random_uuid(),
  disclosure_version text NOT NULL REFERENCES public.financing_disclosures(version),
  needs_review boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  link_opened_at timestamptz,
  submitted_at timestamptz,
  approved_at timestamptz,
  funded_at timestamptz,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qfo_public_token ON public.quote_financing_offers (public_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qfo_partner_ref ON public.quote_financing_offers (partner_key, partner_reference) WHERE partner_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qfo_live_per_quote ON public.quote_financing_offers (quote_id, partner_key)
  WHERE status IN ('offered', 'link_opened', 'submitted', 'approved');
CREATE INDEX IF NOT EXISTS idx_qfo_user_created ON public.quote_financing_offers (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qfo_quote ON public.quote_financing_offers (quote_id);
CREATE INDEX IF NOT EXISTS idx_qfo_expiry ON public.quote_financing_offers (expires_at) WHERE status IN ('offered', 'link_opened');

ALTER TABLE public.quote_financing_offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qfo_select_manager" ON public.quote_financing_offers;
CREATE POLICY "qfo_select_manager" ON public.quote_financing_offers
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fin_can_manage(auth.uid()));
REVOKE ALL ON public.quote_financing_offers FROM anon, authenticated;
GRANT SELECT (id, user_id, quote_id, partner_key, partner_name, partner_reference, amount_cents, currency, status,
              disclosure_version, needs_review, expires_at, link_opened_at, submitted_at, approved_at, funded_at,
              closed_at, created_by, created_at, updated_at)
  ON public.quote_financing_offers TO authenticated;
DROP TRIGGER IF EXISTS trg_qfo_updated_at ON public.quote_financing_offers;
CREATE TRIGGER trg_qfo_updated_at BEFORE UPDATE ON public.quote_financing_offers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS public.financing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_key text NOT NULL,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('financing', 'insurance')),
  partner_reference text NOT NULL,
  reported_status text NOT NULL,
  payload_sha256 text NOT NULL,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_key, event_id)
);
ALTER TABLE public.financing_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financing_webhook_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_create_quote_offer(
  p_owner uuid, p_actor uuid, p_quote uuid, p_partner_key text, p_partner_name text,
  p_min_cents integer, p_max_cents integer, p_ttl_days integer DEFAULT 14
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g jsonb; q public.quotes%ROWTYPE; v_sub numeric; v_total numeric; v_amount integer;
  v_disc text; v_id uuid; v_existing public.quote_financing_offers%ROWTYPE; v_currency text;
BEGIN
  IF p_owner IS NULL OR p_actor IS NULL OR public.fin_owner_of(p_actor) IS DISTINCT FROM p_owner OR NOT public.fin_can_manage(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  g := public.fin_gate(p_owner, 'consumer_financing');
  IF NOT (g ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason');
  END IF;

  SELECT * INTO q FROM public.quotes WHERE id = p_quote AND user_id = p_owner AND status IN ('sent', 'accepted');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'quote_not_found'); END IF;

  SELECT COALESCE(SUM(
           CASE WHEN (li ->> 'quantity') ~ '^[0-9]+(\.[0-9]+)?$' AND (li ->> 'unit_price_cents') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (li ->> 'quantity')::numeric * (li ->> 'unit_price_cents')::numeric ELSE 0 END), 0)
    INTO v_sub
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.line_items) = 'array' THEN q.line_items ELSE '[]'::jsonb END) li;
  v_total := v_sub + round(v_sub * COALESCE(q.tax_percent, 0) / 100);
  IF v_total <= 0 OR v_total > 2147483647 THEN RETURN jsonb_build_object('ok', false, 'error', 'amount_unavailable'); END IF;
  v_amount := v_total::integer;
  IF p_min_cents IS NOT NULL AND v_amount < p_min_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'below_minimum', 'min_cents', p_min_cents); END IF;
  IF p_max_cents IS NOT NULL AND v_amount > p_max_cents THEN RETURN jsonb_build_object('ok', false, 'error', 'above_maximum', 'max_cents', p_max_cents); END IF;

  SELECT version INTO v_disc FROM public.financing_disclosures WHERE product = 'consumer_financing' AND active ORDER BY created_at DESC LIMIT 1;
  IF v_disc IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'disclosure_unavailable'); END IF;

  SELECT * INTO v_existing FROM public.quote_financing_offers
   WHERE quote_id = p_quote AND partner_key = p_partner_key AND status IN ('offered', 'link_opened', 'submitted', 'approved') LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'existing', true, 'offer_id', v_existing.id, 'amount_cents', v_existing.amount_cents, 'has_reference', v_existing.partner_reference IS NOT NULL); END IF;

  v_currency := upper(COALESCE(to_jsonb(q) ->> 'currency', 'USD'));
  IF v_currency !~ '^[A-Z]{3}$' THEN v_currency := 'USD'; END IF;

  BEGIN
    INSERT INTO public.quote_financing_offers (user_id, quote_id, partner_key, partner_name, amount_cents, currency,
                                               disclosure_version, expires_at, created_by)
    VALUES (p_owner, p_quote, p_partner_key, p_partner_name, v_amount, v_currency, v_disc,
            now() + make_interval(days => GREATEST(1, LEAST(COALESCE(p_ttl_days, 14), 60))), p_actor)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.quote_financing_offers
     WHERE quote_id = p_quote AND partner_key = p_partner_key AND status IN ('offered', 'link_opened', 'submitted', 'approved') LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'existing', true, 'offer_id', v_existing.id, 'amount_cents', v_existing.amount_cents, 'has_reference', v_existing.partner_reference IS NOT NULL);
  END;

  PERFORM public.fin_audit(p_owner, p_actor, 'account_user', 'offer.created', 'quote_offer', v_id, NULL, 'offered',
                           jsonb_build_object('partner', p_partner_key, 'disclosure_version', v_disc));
  RETURN jsonb_build_object('ok', true, 'existing', false, 'offer_id', v_id, 'amount_cents', v_amount, 'currency', v_currency, 'has_reference', false);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_create_quote_offer(uuid, uuid, uuid, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_create_quote_offer(uuid, uuid, uuid, text, text, integer, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_attach_offer_partner_ref(p_offer uuid, p_ref text, p_url text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_n int;
BEGIN
  IF p_ref IS NULL OR char_length(p_ref) > 128 OR p_url IS NULL OR p_url !~ '^https://' OR char_length(p_url) > 2048 THEN RETURN false; END IF;
  UPDATE public.quote_financing_offers SET partner_reference = p_ref, application_url = p_url
   WHERE id = p_offer AND status = 'offered' AND partner_reference IS NULL
  RETURNING user_id INTO v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    PERFORM public.fin_audit(v_owner, NULL, 'system', 'offer.partner_linked', 'quote_offer', p_offer, 'offered', 'offered', '{}'::jsonb);
    RETURN true;
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_attach_offer_partner_ref(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_attach_offer_partner_ref(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_set_offer_status(p_offer uuid, p_to text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.quote_financing_offers SET
    status = p_to,
    link_opened_at = CASE WHEN p_to IN ('link_opened', 'submitted', 'approved', 'funded') THEN COALESCE(link_opened_at, now()) ELSE link_opened_at END,
    submitted_at   = CASE WHEN p_to IN ('submitted', 'approved', 'funded') THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
    approved_at    = CASE WHEN p_to IN ('approved', 'funded') THEN COALESCE(approved_at, now()) ELSE approved_at END,
    funded_at      = CASE WHEN p_to = 'funded' THEN COALESCE(funded_at, now()) ELSE funded_at END,
    closed_at      = CASE WHEN p_to IN ('funded', 'declined', 'expired', 'canceled') THEN COALESCE(closed_at, now()) ELSE closed_at END
  WHERE id = p_offer;
$$;
REVOKE ALL ON FUNCTION public.fin_set_offer_status(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_set_offer_status(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_fail_offer(p_offer uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.quote_financing_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.quote_financing_offers WHERE id = p_offer FOR UPDATE;
  IF NOT FOUND OR public.fin_financing_transition(o.status, 'canceled') <> 'apply' THEN RETURN; END IF;
  PERFORM public.fin_set_offer_status(p_offer, 'canceled');
  PERFORM public.fin_audit(o.user_id, NULL, 'system', 'offer.partner_failed', 'quote_offer', p_offer, o.status, 'canceled',
                           jsonb_build_object('code', left(COALESCE(p_reason, 'unknown'), 40)));
END;
$$;
REVOKE ALL ON FUNCTION public.fin_fail_offer(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_fail_offer(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_quote_financing_offer(p_offer uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.quote_financing_offers%ROWTYPE; v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.fin_can_manage(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  SELECT * INTO o FROM public.quote_financing_offers WHERE id = p_offer AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF public.fin_financing_transition(o.status, 'canceled') <> 'apply' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelable', 'status', o.status);
  END IF;
  PERFORM public.fin_set_offer_status(o.id, 'canceled');
  PERFORM public.fin_audit(v_owner, auth.uid(), 'account_user', 'offer.canceled', 'quote_offer', o.id, o.status, 'canceled', '{}'::jsonb);
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_quote_financing_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_quote_financing_offer(uuid) TO authenticated;

-- 8. Signed, idempotent webhook application
CREATE OR REPLACE FUNCTION public.fin_apply_partner_event(
  p_partner_key text, p_event_id text, p_kind text, p_partner_reference text, p_status text, p_payload_sha256 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inserted uuid; v_outcome text; v_verdict text;
  o public.quote_financing_offers%ROWTYPE; r public.insurance_referrals%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('financing', 'insurance') THEN RETURN jsonb_build_object('outcome', 'invalid_kind'); END IF;

  INSERT INTO public.financing_webhook_events (partner_key, event_id, kind, partner_reference, reported_status, payload_sha256, outcome)
  VALUES (p_partner_key, p_event_id, p_kind, p_partner_reference, p_status, p_payload_sha256, 'processing')
  ON CONFLICT (partner_key, event_id) DO NOTHING
  RETURNING id INTO v_inserted;
  IF v_inserted IS NULL THEN RETURN jsonb_build_object('outcome', 'duplicate'); END IF;

  IF p_kind = 'financing' THEN
    SELECT * INTO o FROM public.quote_financing_offers
     WHERE partner_key = p_partner_key AND partner_reference = p_partner_reference FOR UPDATE;
    IF NOT FOUND THEN
      v_outcome := 'unknown_reference';
    ELSE
      v_verdict := public.fin_financing_transition(o.status, p_status);
      IF p_status NOT IN ('submitted', 'approved', 'funded', 'declined', 'expired', 'canceled') THEN
        v_outcome := 'invalid_status';
      ELSIF v_verdict = 'apply' THEN
        PERFORM public.fin_set_offer_status(o.id, p_status);
        PERFORM public.fin_audit(o.user_id, NULL, 'partner', 'offer.status_changed', 'quote_offer', o.id, o.status, p_status,
                                 jsonb_build_object('partner', p_partner_key));
        v_outcome := 'applied';
      ELSIF v_verdict = 'noop' THEN
        v_outcome := 'noop';
      ELSE
        v_outcome := 'rejected_transition';
        IF p_status IN ('submitted', 'approved', 'funded') THEN
          UPDATE public.quote_financing_offers SET needs_review = true WHERE id = o.id;
        END IF;
        PERFORM public.fin_audit(o.user_id, NULL, 'partner', 'offer.transition_rejected', 'quote_offer', o.id, o.status, p_status,
                                 jsonb_build_object('partner', p_partner_key));
      END IF;
    END IF;
  ELSE
    SELECT * INTO r FROM public.insurance_referrals
     WHERE partner_key = p_partner_key AND partner_reference = p_partner_reference FOR UPDATE;
    IF NOT FOUND THEN
      v_outcome := 'unknown_reference';
    ELSE
      v_verdict := public.fin_insurance_transition(r.status, p_status);
      IF p_status NOT IN ('contacted', 'quoted', 'bound', 'declined', 'expired', 'canceled') THEN
        v_outcome := 'invalid_status';
      ELSIF v_verdict = 'apply' THEN
        UPDATE public.insurance_referrals SET status = p_status WHERE id = r.id;
        PERFORM public.fin_audit(r.user_id, NULL, 'partner', 'referral.status_changed', 'insurance_referral', r.id, r.status, p_status,
                                 jsonb_build_object('partner', p_partner_key));
        v_outcome := 'applied';
      ELSIF v_verdict = 'noop' THEN
        v_outcome := 'noop';
      ELSE
        v_outcome := 'rejected_transition';
        PERFORM public.fin_audit(r.user_id, NULL, 'partner', 'referral.transition_rejected', 'insurance_referral', r.id, r.status, p_status,
                                 jsonb_build_object('partner', p_partner_key));
      END IF;
    END IF;
  END IF;

  UPDATE public.financing_webhook_events SET outcome = v_outcome WHERE id = v_inserted;
  RETURN jsonb_build_object('outcome', v_outcome);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_apply_partner_event(text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_apply_partner_event(text, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_expire_stale_offers()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.quote_financing_offers%ROWTYPE; v_n integer := 0;
BEGIN
  FOR o IN SELECT * FROM public.quote_financing_offers
            WHERE status IN ('offered', 'link_opened') AND expires_at <= now() FOR UPDATE SKIP LOCKED LOOP
    PERFORM public.fin_set_offer_status(o.id, 'expired');
    PERFORM public.fin_audit(o.user_id, NULL, 'system', 'offer.expired', 'quote_offer', o.id, o.status, 'expired', '{}'::jsonb);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_expire_stale_offers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_expire_stale_offers() TO service_role;

-- 9. Customer-facing (token-gated, anon-callable)
CREATE OR REPLACE FUNCTION public.get_public_quote_financing(p_quote_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE q public.quotes%ROWTYPE; o public.quote_financing_offers%ROWTYPE; d public.financing_disclosures%ROWTYPE; v_status text;
BEGIN
  IF p_quote_token IS NULL THEN RETURN jsonb_build_object('available', false); END IF;
  SELECT * INTO q FROM public.quotes WHERE quote_token = p_quote_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false); END IF;
  IF NOT (public.fin_gate(q.user_id, 'consumer_financing') ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('available', false);
  END IF;
  SELECT * INTO o FROM public.quote_financing_offers WHERE quote_id = q.id ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND OR o.partner_reference IS NULL THEN RETURN jsonb_build_object('available', false); END IF;
  SELECT * INTO d FROM public.financing_disclosures WHERE version = o.disclosure_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false); END IF;
  v_status := CASE WHEN o.status IN ('offered', 'link_opened') AND o.expires_at <= now() THEN 'expired' ELSE o.status END;
  RETURN jsonb_build_object(
    'available', true,
    'offer_token', o.public_token,
    'status', v_status,
    'amount_cents', o.amount_cents,
    'currency', o.currency,
    'partner_name', o.partner_name,
    'disclosure_version', d.version,
    'disclosure_body', replace(d.body, '{partner}', o.partner_name),
    'expires_at', o.expires_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_quote_financing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_quote_financing(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.customer_open_financing_application(p_offer_token uuid, p_disclosure_version text, p_acknowledged boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.quote_financing_offers%ROWTYPE; d public.financing_disclosures%ROWTYPE;
BEGIN
  IF p_offer_token IS NULL OR NOT COALESCE(p_acknowledged, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'acknowledgement_required');
  END IF;
  SELECT * INTO o FROM public.quote_financing_offers WHERE public_token = p_offer_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF NOT (public.fin_gate(o.user_id, 'consumer_financing') ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unavailable');
  END IF;
  IF o.status NOT IN ('offered', 'link_opened') OR o.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;
  IF o.application_url IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_ready'); END IF;
  IF p_disclosure_version IS DISTINCT FROM o.disclosure_version THEN
    RETURN jsonb_build_object('ok', false, 'error', 'disclosure_mismatch');
  END IF;
  SELECT * INTO d FROM public.financing_disclosures WHERE version = o.disclosure_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'disclosure_unavailable'); END IF;

  PERFORM public.fin_record_consent(o.user_id, 'financing_disclosure_ack', 'granted', o.id, o.partner_key,
                                    d.version, d.body, jsonb_build_object('quote_offer', o.id), NULL, 'customer', NULL);
  IF o.status = 'offered' THEN
    PERFORM public.fin_set_offer_status(o.id, 'link_opened');
    PERFORM public.fin_audit(o.user_id, NULL, 'customer', 'offer.link_opened', 'quote_offer', o.id, 'offered', 'link_opened', '{}'::jsonb);
  END IF;
  RETURN jsonb_build_object('ok', true, 'application_url', o.application_url);
END;
$$;
REVOKE ALL ON FUNCTION public.customer_open_financing_application(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_open_financing_application(uuid, text, boolean) TO anon, authenticated;

-- 10. Working-capital signals (informational; NOT a credit decision)
CREATE OR REPLACE FUNCTION public.fin_compute_wc_signals(p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_first timestamptz; v_tenure int; v_active int; v_jobs int; v_invoiced int; v_paid_n int; v_rev numeric;
  v_paid_rate int; v_pay_n int; v_med numeric; v_currency text; v_suff text;
  v_jobs_band text; v_rev_band text; v_pay_band text;
BEGIN
  SELECT min(created_at) INTO v_first FROM public.jobs WHERE user_id = p_owner;
  v_tenure := CASE WHEN v_first IS NULL THEN 0 ELSE GREATEST(0, (EXTRACT(year FROM age(now(), v_first)) * 12 + EXTRACT(month FROM age(now(), v_first)))::int) END;

  SELECT count(DISTINCT date_trunc('month', created_at)), count(*),
         count(*) FILTER (WHERE COALESCE(invoice_amount, 0) > 0 AND invoice_status IN ('sent', 'paid')),
         count(*) FILTER (WHERE COALESCE(invoice_amount, 0) > 0 AND invoice_status = 'paid'),
         COALESCE(sum(invoice_amount) FILTER (WHERE invoice_status = 'paid' AND COALESCE(invoice_amount, 0) > 0), 0)
    INTO v_active, v_jobs, v_invoiced, v_paid_n, v_rev
    FROM public.jobs WHERE user_id = p_owner AND created_at >= now() - interval '12 months';

  SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (paid_at - created_at)) / 86400.0)
    INTO v_pay_n, v_med
    FROM public.payment_requests
   WHERE user_id = p_owner AND status = 'paid' AND paid_at IS NOT NULL AND paid_at >= created_at
     AND paid_at >= now() - interval '12 months';

  SELECT COALESCE((SELECT currency FROM public.business_regional_settings WHERE user_id = p_owner), 'USD') INTO v_currency;

  v_jobs_band := CASE WHEN v_jobs < 50 THEN '<50' WHEN v_jobs < 200 THEN '50-199' WHEN v_jobs < 600 THEN '200-599' ELSE '600+' END;
  v_rev_band  := CASE WHEN v_rev < 50000 THEN '<50k' WHEN v_rev < 150000 THEN '50k-150k' WHEN v_rev < 500000 THEN '150k-500k' ELSE '500k+' END;
  v_paid_rate := CASE WHEN v_invoiced >= 10 THEN (round((100.0 * v_paid_n / v_invoiced) / 5) * 5)::int END;
  v_pay_band  := CASE WHEN v_pay_n < 10 OR v_med IS NULL THEN NULL
                      WHEN v_med <= 7 THEN '<=7d' WHEN v_med <= 14 THEN '8-14d' WHEN v_med <= 30 THEN '15-30d' ELSE '>30d' END;
  v_suff := CASE WHEN v_active < 3 OR v_invoiced < 10 THEN 'insufficient'
                 WHEN v_tenure < 12 OR v_active < 9 THEN 'limited' ELSE 'established' END;

  RETURN jsonb_build_object(
    'method_version', 'wc-signals-v1',
    'informational_only', true,
    'currency', v_currency,
    'data_sufficiency', v_suff,
    'signals', jsonb_strip_nulls(jsonb_build_object(
      'tenure_months', v_tenure,
      'active_months_12m', v_active,
      'jobs_12m_band', v_jobs_band,
      'paid_revenue_12m_band', v_rev_band,
      'invoice_paid_rate_pct', v_paid_rate,
      'median_days_to_pay_band', v_pay_band
    ))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.fin_compute_wc_signals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_compute_wc_signals(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_active_wc_consent(p_owner uuid, p_partner text)
RETURNS public.financing_consents LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.* FROM public.financing_consents c
   WHERE c.user_id = p_owner AND c.consent_type = 'working_capital_share' AND c.partner_key = p_partner
   ORDER BY c.created_at DESC, c.id DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.fin_active_wc_consent(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_active_wc_consent(uuid, text) TO service_role;

CREATE TABLE IF NOT EXISTS public.working_capital_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  partner_key text NOT NULL CHECK (partner_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  consent_id uuid NOT NULL REFERENCES public.financing_consents(id),
  signals_shared jsonb NOT NULL,
  signals_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'sent', 'failed')),
  partner_reference text CHECK (partner_reference IS NULL OR char_length(partner_reference) <= 128),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wcs_user_time ON public.working_capital_shares (user_id, partner_key, created_at DESC);
ALTER TABLE public.working_capital_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wcs_select_owner" ON public.working_capital_shares;
CREATE POLICY "wcs_select_owner" ON public.working_capital_shares FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.working_capital_shares FROM anon, authenticated;
GRANT SELECT ON public.working_capital_shares TO authenticated;
DROP TRIGGER IF EXISTS trg_wcs_updated_at ON public.working_capital_shares;
CREATE TRIGGER trg_wcs_updated_at BEFORE UPDATE ON public.working_capital_shares
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.get_working_capital_overview(p_partner_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); g jsonb; c public.financing_consents; v_active boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'owner_required');
  END IF;
  g := public.fin_gate(v_owner, 'working_capital');
  IF NOT (g ->> 'allowed')::boolean THEN RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason'); END IF;
  c := public.fin_active_wc_consent(v_owner, p_partner_key);
  IF c.id IS NOT NULL THEN v_active := c.action = 'granted' AND (c.expires_at IS NULL OR c.expires_at > now()); END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'computed', public.fin_compute_wc_signals(v_owner),
    'consent', jsonb_build_object(
      'active', v_active,
      'granted_at', CASE WHEN v_active THEN c.created_at END,
      'expires_at', CASE WHEN v_active THEN c.expires_at END,
      'scopes', CASE WHEN v_active THEN COALESCE(c.scope -> 'signals', '[]'::jsonb) ELSE '[]'::jsonb END,
      'disclosure_version', CASE WHEN v_active THEN c.disclosure_version END
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_working_capital_overview(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_working_capital_overview(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_working_capital_consent(p_partner_key text, p_grant boolean, p_scopes text[], p_disclosure_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id(); g jsonb; d public.financing_disclosures%ROWTYPE; v_id uuid;
  v_allowed text[] := ARRAY['tenure_months', 'active_months_12m', 'jobs_12m_band', 'paid_revenue_12m_band', 'invoice_paid_rate_pct', 'median_days_to_pay_band'];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'owner_required');
  END IF;
  IF p_partner_key IS NULL OR p_partner_key !~ '^[a-z][a-z0-9_]{1,31}$' THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_partner'); END IF;
  g := public.fin_gate(v_owner, 'working_capital');
  IF NOT (g ->> 'allowed')::boolean THEN RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason'); END IF;

  SELECT * INTO d FROM public.financing_disclosures WHERE product = 'working_capital' AND active ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'disclosure_unavailable'); END IF;

  IF COALESCE(p_grant, false) THEN
    IF p_disclosure_version IS DISTINCT FROM d.version THEN RETURN jsonb_build_object('ok', false, 'error', 'disclosure_mismatch'); END IF;
    IF p_scopes IS NULL OR cardinality(p_scopes) = 0 OR NOT (p_scopes <@ v_allowed) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid_scope');
    END IF;
    v_id := public.fin_record_consent(v_owner, 'working_capital_share', 'granted', NULL, p_partner_key, d.version, d.body,
                                      jsonb_build_object('signals', to_jsonb(p_scopes)), auth.uid(), 'account_user', now() + interval '12 months');
  ELSE
    v_id := public.fin_record_consent(v_owner, 'working_capital_share', 'revoked', NULL, p_partner_key, d.version, d.body,
                                      '{}'::jsonb, auth.uid(), 'account_user', NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'consent_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.set_working_capital_consent(text, boolean, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_working_capital_consent(text, boolean, text[], text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fin_prepare_wc_share(p_owner uuid, p_actor uuid, p_partner_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g jsonb; c public.financing_consents; v_computed jsonb; v_filtered jsonb := '{}'::jsonb; k text; v_id uuid;
BEGIN
  IF p_owner IS NULL OR p_actor IS NULL OR p_actor <> p_owner OR public.fin_owner_of(p_actor) IS DISTINCT FROM p_owner THEN
    RETURN jsonb_build_object('ok', false, 'error', 'owner_required');
  END IF;
  g := public.fin_gate(p_owner, 'working_capital');
  IF NOT (g ->> 'allowed')::boolean THEN RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason'); END IF;

  c := public.fin_active_wc_consent(p_owner, p_partner_key);
  IF c.id IS NULL OR c.action <> 'granted' OR (c.expires_at IS NOT NULL AND c.expires_at <= now()) THEN
    PERFORM public.fin_audit(p_owner, p_actor, 'account_user', 'wc_share.blocked_no_consent', 'working_capital_share', NULL, NULL, NULL,
                             jsonb_build_object('partner', p_partner_key));
    RETURN jsonb_build_object('ok', false, 'error', 'consent_required');
  END IF;
  IF EXISTS (SELECT 1 FROM public.working_capital_shares WHERE user_id = p_owner AND partner_key = p_partner_key
                AND status <> 'failed' AND created_at > now() - interval '24 hours') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'recently_shared');
  END IF;

  v_computed := public.fin_compute_wc_signals(p_owner);
  IF v_computed ->> 'data_sufficiency' = 'insufficient' THEN RETURN jsonb_build_object('ok', false, 'error', 'insufficient_data'); END IF;
  FOR k IN SELECT jsonb_array_elements_text(COALESCE(c.scope -> 'signals', '[]'::jsonb)) LOOP
    IF (v_computed -> 'signals') ? k THEN v_filtered := v_filtered || jsonb_build_object(k, v_computed -> 'signals' -> k); END IF;
  END LOOP;
  IF v_filtered = '{}'::jsonb THEN RETURN jsonb_build_object('ok', false, 'error', 'nothing_to_share'); END IF;

  INSERT INTO public.working_capital_shares (user_id, partner_key, consent_id, signals_shared, signals_sha256, created_by)
  VALUES (p_owner, p_partner_key, c.id, v_filtered, encode(sha256(convert_to(v_filtered::text, 'UTF8')), 'hex'), p_actor)
  RETURNING id INTO v_id;
  PERFORM public.fin_audit(p_owner, p_actor, 'account_user', 'wc_share.prepared', 'working_capital_share', v_id, NULL, 'prepared',
                           jsonb_build_object('partner', p_partner_key, 'keys', (SELECT jsonb_agg(x) FROM jsonb_object_keys(v_filtered) x)));
  RETURN jsonb_build_object('ok', true, 'share_id', v_id, 'signals', v_filtered);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_prepare_wc_share(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_prepare_wc_share(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_mark_wc_share(p_share uuid, p_status text, p_ref text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN RETURN; END IF;
  UPDATE public.working_capital_shares SET status = p_status, partner_reference = left(p_ref, 128)
   WHERE id = p_share AND status = 'prepared' RETURNING user_id INTO v_owner;
  IF v_owner IS NOT NULL THEN
    PERFORM public.fin_audit(v_owner, NULL, 'system', 'wc_share.' || p_status, 'working_capital_share', p_share, 'prepared', p_status, '{}'::jsonb);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_mark_wc_share(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_mark_wc_share(uuid, text, text) TO service_role;

-- 11. Insurance referrals
CREATE TABLE IF NOT EXISTS public.insurance_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  line text NOT NULL CHECK (line IN ('general_liability', 'workers_comp', 'commercial_auto', 'equipment', 'home_warranty')),
  partner_key text NOT NULL CHECK (partner_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  partner_reference text CHECK (partner_reference IS NULL OR char_length(partner_reference) <= 128),
  status text NOT NULL DEFAULT 'referred' CHECK (status IN ('referred', 'contacted', 'quoted', 'bound', 'declined', 'expired', 'canceled')),
  contact_shared boolean NOT NULL DEFAULT false,
  consent_id uuid NOT NULL REFERENCES public.financing_consents(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ins_partner_ref ON public.insurance_referrals (partner_key, partner_reference) WHERE partner_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ins_live ON public.insurance_referrals (user_id, line, partner_key) WHERE status IN ('referred', 'contacted', 'quoted');
CREATE INDEX IF NOT EXISTS idx_ins_user_time ON public.insurance_referrals (user_id, created_at DESC);
ALTER TABLE public.insurance_referrals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ins_select_manager" ON public.insurance_referrals;
CREATE POLICY "ins_select_manager" ON public.insurance_referrals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.fin_can_manage(auth.uid()));
REVOKE ALL ON public.insurance_referrals FROM anon, authenticated;
GRANT SELECT ON public.insurance_referrals TO authenticated;
DROP TRIGGER IF EXISTS trg_ins_updated_at ON public.insurance_referrals;
CREATE TRIGGER trg_ins_updated_at BEFORE UPDATE ON public.insurance_referrals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.fin_create_insurance_referral(
  p_owner uuid, p_actor uuid, p_partner_key text, p_line text, p_acknowledged boolean,
  p_disclosure_version text, p_share_email boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g jsonb; d public.financing_disclosures%ROWTYPE; v_consent uuid; v_id uuid; v_name text; v_email text;
BEGIN
  IF p_owner IS NULL OR p_actor IS NULL OR public.fin_owner_of(p_actor) IS DISTINCT FROM p_owner OR NOT public.fin_can_manage(p_actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_line NOT IN ('general_liability', 'workers_comp', 'commercial_auto', 'equipment', 'home_warranty') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_line');
  END IF;
  IF NOT COALESCE(p_acknowledged, false) THEN RETURN jsonb_build_object('ok', false, 'error', 'acknowledgement_required'); END IF;
  g := public.fin_gate(p_owner, 'insurance_referral');
  IF NOT (g ->> 'allowed')::boolean THEN RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason'); END IF;
  SELECT * INTO d FROM public.financing_disclosures WHERE product = 'insurance_referral' AND active ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'disclosure_unavailable'); END IF;
  IF p_disclosure_version IS DISTINCT FROM d.version THEN RETURN jsonb_build_object('ok', false, 'error', 'disclosure_mismatch'); END IF;

  IF EXISTS (SELECT 1 FROM public.insurance_referrals WHERE user_id = p_owner AND line = p_line AND partner_key = p_partner_key
               AND status IN ('referred', 'contacted', 'quoted')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_referred');
  END IF;

  v_consent := public.fin_record_consent(p_owner, 'insurance_referral_contact', 'granted', NULL, p_partner_key, d.version, d.body,
                                         jsonb_build_object('line', p_line, 'share_email', COALESCE(p_share_email, false)),
                                         p_actor, 'account_user', NULL);
  BEGIN
    INSERT INTO public.insurance_referrals (user_id, line, partner_key, contact_shared, consent_id, created_by)
    VALUES (p_owner, p_line, p_partner_key, COALESCE(p_share_email, false), v_consent, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_referred');
  END;
  SELECT company_name, email INTO v_name, v_email FROM public.profiles WHERE id = p_owner;
  PERFORM public.fin_audit(p_owner, p_actor, 'account_user', 'referral.created', 'insurance_referral', v_id, NULL, 'referred',
                           jsonb_build_object('line', p_line, 'partner', p_partner_key, 'email_shared', COALESCE(p_share_email, false)));
  RETURN jsonb_build_object('ok', true, 'referral_id', v_id, 'business_name', COALESCE(NULLIF(btrim(v_name), ''), 'Business'),
                            'contact_email', CASE WHEN COALESCE(p_share_email, false) THEN v_email END);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_create_insurance_referral(uuid, uuid, text, text, boolean, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_create_insurance_referral(uuid, uuid, text, text, boolean, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_attach_insurance_ref(p_id uuid, p_ref text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_ref IS NULL OR char_length(p_ref) > 128 THEN RETURN false; END IF;
  UPDATE public.insurance_referrals SET partner_reference = p_ref WHERE id = p_id AND partner_reference IS NULL AND status = 'referred'
  RETURNING user_id INTO v_owner;
  IF v_owner IS NULL THEN RETURN false; END IF;
  PERFORM public.fin_audit(v_owner, NULL, 'system', 'referral.partner_linked', 'insurance_referral', p_id, 'referred', 'referred', '{}'::jsonb);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_attach_insurance_ref(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_attach_insurance_ref(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_fail_insurance(p_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.insurance_referrals%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.insurance_referrals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR public.fin_insurance_transition(r.status, 'canceled') <> 'apply' THEN RETURN; END IF;
  UPDATE public.insurance_referrals SET status = 'canceled' WHERE id = p_id;
  PERFORM public.fin_audit(r.user_id, NULL, 'system', 'referral.partner_failed', 'insurance_referral', p_id, r.status, 'canceled',
                           jsonb_build_object('code', left(COALESCE(p_reason, 'unknown'), 40)));
END;
$$;
REVOKE ALL ON FUNCTION public.fin_fail_insurance(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_fail_insurance(uuid, text) TO service_role;

-- 12. Reporting: offer rate, application rate, funded rate
CREATE OR REPLACE FUNCTION public.financing_funnel_report(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); g jsonb; v_quotes int; v_by jsonb; v_tot jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.fin_can_manage(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  g := public.fin_gate(v_owner, 'consumer_financing');
  IF NOT (g ->> 'allowed')::boolean THEN RETURN jsonb_build_object('ok', false, 'error', 'unavailable', 'reason', g ->> 'reason'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '400 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_range');
  END IF;

  SELECT count(*) INTO v_quotes FROM public.quotes
   WHERE user_id = v_owner AND status IN ('sent', 'accepted', 'declined', 'expired') AND sent_at >= p_from AND sent_at < p_to;

  SELECT jsonb_build_object(
           'offered_quotes', count(DISTINCT quote_id), 'offers', count(*),
           'link_opened', count(*) FILTER (WHERE link_opened_at IS NOT NULL),
           'submitted', count(*) FILTER (WHERE submitted_at IS NOT NULL),
           'approved', count(*) FILTER (WHERE approved_at IS NOT NULL),
           'funded', count(*) FILTER (WHERE status = 'funded'),
           'declined', count(*) FILTER (WHERE status = 'declined'),
           'expired', count(*) FILTER (WHERE status = 'expired'),
           'canceled', count(*) FILTER (WHERE status = 'canceled'),
           'needs_review', count(*) FILTER (WHERE needs_review),
           'funded_amount_cents', COALESCE(sum(amount_cents) FILTER (WHERE status = 'funded'), 0))
    INTO v_tot
    FROM public.quote_financing_offers WHERE user_id = v_owner AND created_at >= p_from AND created_at < p_to;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_by FROM (
    SELECT partner_key, max(partner_name) AS partner_name, count(*) AS offers,
           count(*) FILTER (WHERE submitted_at IS NOT NULL) AS submitted,
           count(*) FILTER (WHERE status = 'funded') AS funded
      FROM public.quote_financing_offers WHERE user_id = v_owner AND created_at >= p_from AND created_at < p_to
     GROUP BY partner_key ORDER BY partner_key) t;

  RETURN jsonb_build_object('ok', true, 'from', p_from, 'to', p_to, 'quotes_sent', v_quotes, 'totals', v_tot, 'by_partner', v_by);
END;
$$;
REVOKE ALL ON FUNCTION public.financing_funnel_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financing_funnel_report(timestamptz, timestamptz) TO authenticated;

-- 13. Staff administration (each re-checks is_vireek_staff)
CREATE OR REPLACE FUNCTION public.staff_set_module_entitlement(p_tenant uuid, p_enabled boolean, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.account_module_entitlements (user_id, module_key, enabled, note, updated_by)
  VALUES (p_tenant, 'financing_partners', COALESCE(p_enabled, false), p_note, auth.uid())
  ON CONFLICT (user_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled, note = EXCLUDED.note, updated_by = auth.uid();
  PERFORM public.fin_audit(p_tenant, auth.uid(), 'staff', CASE WHEN p_enabled THEN 'module.enabled' ELSE 'module.disabled' END,
                           'module', NULL, NULL, NULL, jsonb_build_object('module', 'financing_partners'));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_module_entitlement(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_module_entitlement(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_upsert_region_rule(
  p_product text, p_country text, p_region text, p_enabled boolean, p_counsel_reviewed boolean, p_note text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_enabled, false) AND NOT COALESCE(p_counsel_reviewed, false)
     AND NOT EXISTS (SELECT 1 FROM public.financing_region_rules WHERE product = p_product AND country = p_country
                       AND region = COALESCE(p_region, '*') AND counsel_reviewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A region cannot be enabled without a recorded counsel review (REQUIRES COUNSEL)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.financing_region_rules (product, country, region, enabled, counsel_reviewed_at, note, updated_by)
  VALUES (p_product, upper(p_country), COALESCE(p_region, '*'), COALESCE(p_enabled, false),
          CASE WHEN COALESCE(p_counsel_reviewed, false) THEN now() END, p_note, auth.uid())
  ON CONFLICT (product, country, region) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    counsel_reviewed_at = COALESCE(EXCLUDED.counsel_reviewed_at, public.financing_region_rules.counsel_reviewed_at),
    note = EXCLUDED.note, updated_by = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.staff_upsert_region_rule(text, text, text, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_upsert_region_rule(text, text, text, boolean, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_publish_disclosure(p_version text, p_product text, p_body text, p_counsel_reviewed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.financing_disclosures (version, product, body, active, counsel_reviewed_at)
  VALUES (p_version, p_product, p_body, true, CASE WHEN COALESCE(p_counsel_reviewed, false) THEN now() END);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_publish_disclosure(text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_publish_disclosure(text, text, text, boolean) TO authenticated;
