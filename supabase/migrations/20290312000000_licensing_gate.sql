/*
  # Licensing gate — lending / BNPL / escrow / money-movement capabilities

  Fail-closed control plane: a capability can go LIVE only while
  licensing_confirmed = true AND kill_switch = false. Every capability is seeded
  licensing_confirmed = false. There is no code path that confirms licensing
  automatically: only a staff RPC with a counsel reference does, and every change
  is written to an append-only audit table.

  Capabilities (extend with a new migration, never at runtime):
    bnpl_legacy             legacy Wisetack offers (financing-create-offer, financing_offers INSERT)
    financing_partners      partner financing / working capital / insurance referral (fin_gate)
    pay_instant_payouts, pay_earned_wage_access, pay_spend_cards, pay_capital
                            only for mode = 'live' (sandbox moves no money)
    escrow                  reserved: no escrow code exists today; future code MUST call licensing_gate_allows('escrow')

  TODO(counsel): confirm per capability which licenses/registrations apply in each state served,
  then record the counsel reference via staff_licensing_gate_set(). See docs/compliance/licensing-audit-financing-payments.md.

  DEPLOY WARNING: bnpl_legacy starts BLOCKED. If legacy BNPL offers are already live for tenants, they stop
  until counsel confirms and staff set the gate. This is intentional.

  Rollback (dev/staging only — drops audit evidence): DROP TRIGGER trg_licensing_guard_bnpl_offer ON financing_offers;
  re-run the pay_product_state / fin_gate definitions from 20271102000000 / 20290301000000; DROP the licensing_* objects.
  Production rollback = do NOT drop; confirm via staff_licensing_gate_set() once counsel has signed off.
*/

CREATE TABLE IF NOT EXISTS public.licensing_gate (
  capability text PRIMARY KEY CHECK (capability ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  licensing_confirmed boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  counsel_ref text CHECK (counsel_ref IS NULL OR char_length(btrim(counsel_ref)) BETWEEN 3 AND 200),
  confirmed_by uuid,
  confirmed_at timestamptz,
  killed_by uuid,
  killed_at timestamptz,
  kill_reason text CHECK (kill_reason IS NULL OR char_length(kill_reason) <= 500),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licensing_confirmed_needs_evidence CHECK (
    NOT licensing_confirmed OR (counsel_ref IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);
ALTER TABLE public.licensing_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.licensing_gate FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.licensing_gate_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  capability text NOT NULL,
  action text NOT NULL,
  old_row jsonb,
  new_row jsonb,
  reason text,
  actor uuid,
  at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.licensing_gate_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.licensing_gate_audit FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.licensing_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_licensing_audit_immutable ON public.licensing_gate_audit;
CREATE TRIGGER trg_licensing_audit_immutable BEFORE UPDATE OR DELETE ON public.licensing_gate_audit
  FOR EACH ROW EXECUTE FUNCTION public.licensing_block_mutation();

CREATE OR REPLACE FUNCTION public.licensing_gate_audit_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.licensing_gate_audit (capability, action, old_row, new_row, reason, actor)
  VALUES (NEW.capability, TG_OP,
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW),
          COALESCE(NULLIF(current_setting('vireek.licensing_reason', true), ''), 'unspecified'), auth.uid());
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_licensing_gate_audit ON public.licensing_gate;
CREATE TRIGGER trg_licensing_gate_audit AFTER INSERT OR UPDATE ON public.licensing_gate
  FOR EACH ROW EXECUTE FUNCTION public.licensing_gate_audit_row();

INSERT INTO public.licensing_gate (capability, note) VALUES
  ('bnpl_legacy',            'Legacy Wisetack BNPL offers (financing-create-offer).'),
  ('financing_partners',     'Partner financing, working-capital signals, insurance referrals (fin_gate).'),
  ('pay_instant_payouts',    'Vireek Pay instant payouts, live mode only.'),
  ('pay_earned_wage_access', 'Vireek Pay earned-wage access, live mode only.'),
  ('pay_spend_cards',        'Vireek Pay spend cards, live mode only.'),
  ('pay_capital',            'Vireek Pay capital, live mode only.'),
  ('escrow',                 'Reserved. No escrow code exists; future code must call licensing_gate_allows(''escrow'').')
ON CONFLICT (capability) DO NOTHING;

-- Decision function: unknown capability, kill switch or unconfirmed licensing => not allowed.
CREATE OR REPLACE FUNCTION public.licensing_gate_state(p_capability text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE g public.licensing_gate%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.licensing_gate WHERE capability = p_capability;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_capability'); END IF;
  IF g.kill_switch THEN RETURN jsonb_build_object('allowed', false, 'reason', 'killed'); END IF;
  IF NOT g.licensing_confirmed THEN RETURN jsonb_build_object('allowed', false, 'reason', 'licensing_not_confirmed'); END IF;
  RETURN jsonb_build_object('allowed', true, 'reason', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.licensing_gate_allows(p_capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((public.licensing_gate_state(p_capability) ->> 'allowed')::boolean, false);
$$;

-- Staff RPCs ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_licensing_gate_list()
RETURNS SETOF public.licensing_gate LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT * FROM public.licensing_gate ORDER BY capability;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_licensing_gate_set(
  p_capability text, p_licensing_confirmed boolean, p_counsel_ref text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g public.licensing_gate%ROWTYPE;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'A reason of at least 8 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_licensing_confirmed IS NULL THEN RAISE EXCEPTION 'licensing_confirmed must be true or false' USING ERRCODE = '22023'; END IF;
  IF p_licensing_confirmed AND char_length(btrim(COALESCE(p_counsel_ref, ''))) < 3 THEN
    RAISE EXCEPTION 'A counsel reference is required to confirm licensing' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM public.licensing_gate WHERE capability = p_capability FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown capability' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('vireek.licensing_reason', btrim(p_reason), true);
  UPDATE public.licensing_gate SET
    licensing_confirmed = p_licensing_confirmed,
    counsel_ref  = CASE WHEN p_licensing_confirmed THEN btrim(p_counsel_ref) END,
    confirmed_by = CASE WHEN p_licensing_confirmed THEN auth.uid() END,
    confirmed_at = CASE WHEN p_licensing_confirmed THEN now() END,
    updated_at = now()
  WHERE capability = p_capability;
END;
$$;

-- PANIC BUTTON: every capability off at once. Does not touch licensing_confirmed.
CREATE OR REPLACE FUNCTION public.staff_licensing_kill_all(p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'A reason of at least 8 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.licensing_reason', 'KILL ALL: ' || btrim(p_reason), true);
  UPDATE public.licensing_gate
     SET kill_switch = true, killed_by = auth.uid(), killed_at = now(), kill_reason = left(btrim(p_reason), 500), updated_at = now()
   WHERE NOT kill_switch;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_licensing_resume(p_capability text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 8 THEN
    RAISE EXCEPTION 'A reason of at least 8 characters is required' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.licensing_reason', 'RESUME: ' || btrim(p_reason), true);
  UPDATE public.licensing_gate
     SET kill_switch = false, killed_by = NULL, killed_at = NULL, kill_reason = NULL, updated_at = now()
   WHERE capability = p_capability;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown capability' USING ERRCODE = 'P0002'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.licensing_gate_state(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.licensing_gate_allows(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.licensing_gate_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.licensing_gate_allows(text) TO service_role;
REVOKE ALL ON FUNCTION public.staff_licensing_gate_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_licensing_gate_set(text, boolean, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_licensing_kill_all(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_licensing_resume(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_licensing_gate_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_licensing_gate_set(text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_licensing_kill_all(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_licensing_resume(text, text) TO authenticated;

-- Integration 1: Vireek Pay. Identical to 20271102000000 plus ONE branch: live mode needs the licensing gate.
CREATE OR REPLACE FUNCTION public.pay_product_state(p_product text, p_tenant uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c pay_platform_controls%ROWTYPE;
  v_reason text := NULL;
BEGIN
  SELECT * INTO c FROM pay_platform_controls WHERE product = p_product;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('available', false, 'product', p_product, 'mode', 'sandbox', 'reason', 'unknown_product');
  END IF;

  IF c.killed_at IS NOT NULL THEN
    v_reason := 'killed';
  ELSIF NOT c.enabled THEN
    v_reason := 'platform_disabled';
  ELSIF p_tenant IS NULL THEN
    v_reason := 'no_tenant';
  ELSIF EXISTS (
    SELECT 1 FROM pay_tenant_controls t
     WHERE t.tenant_id = p_tenant AND t.frozen AND t.product IN ('all', p_product)
  ) THEN
    v_reason := 'tenant_frozen';
  ELSIF c.mode = 'live' AND NOT public.licensing_gate_allows('pay_' || p_product) THEN
    v_reason := COALESCE(public.licensing_gate_state('pay_' || p_product) ->> 'reason', 'licensing_not_confirmed');
  ELSIF c.mode = 'live' AND EXISTS (
    SELECT 1 FROM unnest(public.pay_product_disclosure_keys(p_product)) AS k(key)
     WHERE COALESCE((SELECT d.legal_reviewed FROM pay_disclosures d WHERE d.key = k.key ORDER BY d.version DESC LIMIT 1), false) = false
  ) THEN
    v_reason := 'disclosures_not_reviewed';
  END IF;

  RETURN jsonb_build_object(
    'available', v_reason IS NULL,
    'product', c.product,
    'mode', c.mode,
    'reason', v_reason,
    'partner_name', c.partner_name,
    'fee_bps', c.fee_bps,
    'min_fee_cents', c.min_fee_cents,
    'max_fee_cents', c.max_fee_cents,
    'max_single_cents', c.max_single_cents,
    'max_daily_tenant_cents', c.max_daily_tenant_cents,
    'max_pct_of_accrued', c.max_pct_of_accrued,
    'config', c.config
  );
END;
$$;

-- Integration 2: partner financing. Identical to 20290301000000 plus the licensing check after the flag check.
CREATE OR REPLACE FUNCTION public.fin_gate(p_owner uuid, p_product text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_flag boolean; v_ent boolean; v_country text; v_region text; v_rule boolean; v_lic jsonb;
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

  v_lic := public.licensing_gate_state('financing_partners');
  IF NOT COALESCE((v_lic ->> 'allowed')::boolean, false) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', COALESCE(v_lic ->> 'reason', 'licensing_not_confirmed'));
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

-- Integration 3: legacy BNPL. Database backstop — even a service-role insert is refused while the gate is closed.
CREATE OR REPLACE FUNCTION public.licensing_guard_bnpl_offer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.licensing_gate_allows('bnpl_legacy') THEN
    RAISE EXCEPTION 'licensing_not_confirmed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_licensing_guard_bnpl_offer ON public.financing_offers;
CREATE TRIGGER trg_licensing_guard_bnpl_offer BEFORE INSERT ON public.financing_offers
  FOR EACH ROW EXECUTE FUNCTION public.licensing_guard_bnpl_offer();

COMMENT ON TABLE public.licensing_gate IS
  'Fail-closed licensing gate for lending/BNPL/escrow/money movement. licensing_confirmed needs a counsel reference; written only by staff RPCs.';
