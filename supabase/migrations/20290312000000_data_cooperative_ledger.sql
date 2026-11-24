/*
  # Data cooperative — contributor benefit ledger + calculation hooks

  ## Why
  The Service Data Exchange (20270215000000_service_data_exchange.sql) already owns consent
  (sde_consents / sde_consent_events / sde_set_consent), the per-run contribution ledger
  (sde_contribution_ledger) and give-to-get benchmark access (sde_get_intelligence).
  What was missing is a durable, auditable record of what a contributor has EARNED for contributing,
  and a rule-driven way to calculate it. This migration adds exactly that and nothing more.
  Design doc: docs/data/cooperative.md

  ## What this adds
  1. coop_benefit_rules      per-domain accrual rules. Seeded INACTIVE with NO numbers (TODO(owner)).
                             A rule cannot be activated without a counsel reference.
  2. coop_rule_audit         append-only history of rule changes.
  3. coop_benefit_ledger     append-only ledger of abstract "credit units" (accrual / redemption / adjustment).
                             Units are NOT money. No payment, invoice or payout is created anywhere here.
  4. coop_calc_units()       pure calculation (mirrored by src/lib/cooperativeBenefits.ts).
  5. coop_accrue_benefits()  service_role only. Reads sde_contribution_ledger, consent re-checked live.
  6. coop_record_redemption() service_role only. Idempotent, balance-checked, per-user serialised.
  7. coop_get_my_ledger()    owner-facing read RPC.
  8. staff_coop_set_rule() / staff_coop_adjust()  staff-only governance RPCs.

  ## Safety
  Idempotent (IF NOT EXISTS / OR REPLACE / DO NOTHING). No DROP, no DELETE of existing data, no policy loosened.
  Accrual only ever reads sde_contribution_ledger, whose counts already include ONLY cohorts that cleared k-anonymity.
  Revocation: accrual joins sde_consents live, so a revoked domain stops earning on the next run.
  Whether already-earned units survive revocation is an open governance decision [COUNSEL] — nothing here claws back automatically.

  ## Rollback
    DROP FUNCTION IF EXISTS public.staff_coop_adjust(uuid, text, numeric, text);
    DROP FUNCTION IF EXISTS public.staff_coop_set_rule(text, jsonb, text);
    DROP FUNCTION IF EXISTS public.coop_get_my_ledger(integer);
    DROP FUNCTION IF EXISTS public.coop_record_redemption(uuid, numeric, text, text);
    DROP FUNCTION IF EXISTS public.coop_accrue_benefits(date);
    DROP FUNCTION IF EXISTS public.coop_calc_units(integer, integer, numeric, numeric, numeric, numeric);
    DROP TABLE IF EXISTS public.coop_benefit_ledger, public.coop_rule_audit, public.coop_benefit_rules;
*/

-- =============================================================
-- 1. Rules (values deliberately empty: product/counsel decide)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.coop_benefit_rules (
  domain text PRIMARY KEY CHECK (domain IN ('failure', 'equipment', 'pricing', 'labor', 'parts', 'outcomes')),
  active boolean NOT NULL DEFAULT false,
  unit_label text NOT NULL DEFAULT 'credit units' CHECK (char_length(unit_label) BETWEEN 1 AND 40),
  -- TODO(owner): every number below stays NULL until you decide it. NULL = contributes nothing.
  units_per_1000_records numeric CHECK (units_per_1000_records IS NULL OR units_per_1000_records >= 0),
  units_per_cohort numeric CHECK (units_per_cohort IS NULL OR units_per_cohort >= 0),
  max_units_per_30d numeric CHECK (max_units_per_30d IS NULL OR max_units_per_30d >= 0),
  counsel_ref text CHECK (counsel_ref IS NULL OR char_length(btrim(counsel_ref)) BETWEEN 3 AND 200),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coop_rule_active_needs_counsel CHECK (
    NOT active OR (counsel_ref IS NOT NULL AND (units_per_1000_records IS NOT NULL OR units_per_cohort IS NOT NULL))
  )
);

INSERT INTO public.coop_benefit_rules (domain) VALUES
  ('failure'), ('equipment'), ('pricing'), ('labor'), ('parts'), ('outcomes')
ON CONFLICT (domain) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.coop_rule_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  old_row jsonb,
  new_row jsonb,
  actor_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.coop_benefit_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coop_rule_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coop_benefit_rules, public.coop_rule_audit FROM PUBLIC, anon, authenticated;
-- No policies: clients read rules only through coop_get_my_ledger(); writes only through staff RPCs.

CREATE OR REPLACE FUNCTION public.coop_rule_audit_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.coop_rule_audit (domain, old_row, new_row, actor_id, reason)
  VALUES (NEW.domain, to_jsonb(OLD), to_jsonb(NEW), auth.uid(), nullif(current_setting('vireek.coop_reason', true), ''));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_coop_rule_audit ON public.coop_benefit_rules;
CREATE TRIGGER trg_coop_rule_audit AFTER UPDATE ON public.coop_benefit_rules
  FOR EACH ROW EXECUTE FUNCTION public.coop_rule_audit_trg();

-- =============================================================
-- 2. Ledger (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.coop_benefit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  domain text CHECK (domain IS NULL OR domain IN ('failure', 'equipment', 'pricing', 'labor', 'parts', 'outcomes')),
  kind text NOT NULL CHECK (kind IN ('accrual', 'redemption', 'adjustment')),
  run_date date,
  units numeric(14, 4) NOT NULL,
  unit_label text NOT NULL DEFAULT 'credit units',
  source_key text CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 3 AND 120),
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rule_snapshot) = 'object'),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coop_ledger_sign CHECK (
    (kind = 'accrual' AND units > 0 AND domain IS NOT NULL AND run_date IS NOT NULL)
    OR (kind = 'redemption' AND units < 0 AND source_key IS NOT NULL)
    OR (kind = 'adjustment' AND units <> 0 AND note IS NOT NULL)
  )
);

-- One accrual per account x domain x run: re-running the job is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_coop_ledger_accrual
  ON public.coop_benefit_ledger (user_id, domain, run_date) WHERE kind = 'accrual';
-- One redemption per external reference: retries cannot double-spend.
CREATE UNIQUE INDEX IF NOT EXISTS uq_coop_ledger_redemption
  ON public.coop_benefit_ledger (user_id, source_key) WHERE kind = 'redemption';
CREATE INDEX IF NOT EXISTS idx_coop_ledger_user_time
  ON public.coop_benefit_ledger (user_id, created_at DESC);

ALTER TABLE public.coop_benefit_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_coop_ledger" ON public.coop_benefit_ledger;
CREATE POLICY "select_own_coop_ledger" ON public.coop_benefit_ledger
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.coop_benefit_ledger FROM anon, authenticated;
REVOKE ALL ON public.coop_benefit_ledger FROM anon;

-- UPDATE is always refused. DELETE stays possible only through ON DELETE CASCADE (account erasure) or service_role.
CREATE OR REPLACE FUNCTION public.coop_ledger_no_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'coop_benefit_ledger is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_coop_ledger_no_update ON public.coop_benefit_ledger;
CREATE TRIGGER trg_coop_ledger_no_update BEFORE UPDATE ON public.coop_benefit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.coop_ledger_no_update();

-- =============================================================
-- 3. Calculation hook (pure)
-- =============================================================
-- units = records/1000 x per_1000 + cohorts x per_cohort, then clamped so that
-- (trailing 30-day accruals + this run) never exceeds max_units_per_30d. NULL rates => 0.
CREATE OR REPLACE FUNCTION public.coop_calc_units(
  p_records integer, p_cohorts integer,
  p_per_1000 numeric, p_per_cohort numeric,
  p_cap_30d numeric, p_trailing_30d numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(GREATEST(
    LEAST(
      GREATEST(COALESCE(p_records, 0), 0) / 1000.0 * COALESCE(p_per_1000, 0)
        + GREATEST(COALESCE(p_cohorts, 0), 0) * COALESCE(p_per_cohort, 0),
      CASE WHEN p_cap_30d IS NULL THEN 'Infinity'::numeric
           ELSE GREATEST(p_cap_30d - GREATEST(COALESCE(p_trailing_30d, 0), 0), 0) END
    ), 0), 4);
$$;

-- =============================================================
-- 4. Accrual (service_role only; schedule after sde_refresh_exchange)
-- =============================================================
CREATE OR REPLACE FUNCTION public.coop_accrue_benefits(p_run_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.coop_benefit_ledger (user_id, domain, kind, run_date, units, unit_label, source_key, rule_snapshot)
  SELECT l.user_id, l.domain, 'accrual', l.run_date, u.units, r.unit_label,
         'sde:' || l.domain || ':' || l.run_date::text,
         jsonb_build_object(
           'records', l.records_contributed, 'cohorts', l.cohorts_contributed,
           'units_per_1000_records', r.units_per_1000_records, 'units_per_cohort', r.units_per_cohort,
           'max_units_per_30d', r.max_units_per_30d, 'counsel_ref', r.counsel_ref)
  FROM public.sde_contribution_ledger l
  JOIN public.sde_consents c ON c.user_id = l.user_id AND c.domain = l.domain AND c.status = 'granted'
  JOIN public.coop_benefit_rules r ON r.domain = l.domain AND r.active
  CROSS JOIN LATERAL (
    SELECT public.coop_calc_units(
      l.records_contributed, l.cohorts_contributed,
      r.units_per_1000_records, r.units_per_cohort, r.max_units_per_30d,
      (SELECT COALESCE(sum(t.units), 0) FROM public.coop_benefit_ledger t
        WHERE t.user_id = l.user_id AND t.domain = l.domain AND t.kind = 'accrual'
          AND t.run_date > p_run_date - 30 AND t.run_date < p_run_date)
    ) AS units
  ) u
  WHERE l.run_date = p_run_date AND u.units > 0
  ON CONFLICT (user_id, domain, run_date) WHERE kind = 'accrual' DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- =============================================================
-- 5. Redemption hook (service_role only; used by a future, separately-reviewed consumer)
-- =============================================================
CREATE OR REPLACE FUNCTION public.coop_record_redemption(p_user uuid, p_units numeric, p_ref text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_user IS NULL OR p_units IS NULL OR p_units <= 0 THEN
    RAISE EXCEPTION 'p_user and a positive p_units are required' USING ERRCODE = '22023';
  END IF;
  IF p_ref IS NULL OR char_length(p_ref) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'p_ref must be 3-120 characters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('coop:' || p_user::text, 0));

  IF EXISTS (SELECT 1 FROM public.coop_benefit_ledger WHERE user_id = p_user AND kind = 'redemption' AND source_key = p_ref) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT COALESCE(sum(units), 0) INTO v_balance FROM public.coop_benefit_ledger WHERE user_id = p_user;
  IF v_balance < p_units THEN
    RETURN jsonb_build_object('status', 'insufficient', 'balance', v_balance);
  END IF;

  INSERT INTO public.coop_benefit_ledger (user_id, kind, units, source_key, note)
  VALUES (p_user, 'redemption', -round(p_units, 4), p_ref, left(p_note, 500));
  RETURN jsonb_build_object('status', 'recorded', 'balance', v_balance - round(p_units, 4));
END;
$$;

-- =============================================================
-- 6. Owner-facing read
-- =============================================================
CREATE OR REPLACE FUNCTION public.coop_get_my_ledger(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'balance', COALESCE((SELECT sum(units) FROM public.coop_benefit_ledger WHERE user_id = v_tenant), 0),
    'accrued_30d', COALESCE((SELECT sum(units) FROM public.coop_benefit_ledger
                              WHERE user_id = v_tenant AND kind = 'accrual' AND run_date > CURRENT_DATE - 30), 0),
    'rules', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'domain', r.domain, 'active', r.active, 'unit_label', r.unit_label,
                'units_per_1000_records', r.units_per_1000_records, 'units_per_cohort', r.units_per_cohort,
                'max_units_per_30d', r.max_units_per_30d) ORDER BY r.domain) FROM public.coop_benefit_rules r), '[]'::jsonb),
    'entries', COALESCE((SELECT jsonb_agg(e ORDER BY e.created_at DESC) FROM (
                SELECT id, domain, kind, run_date, units, unit_label, note, created_at
                FROM public.coop_benefit_ledger WHERE user_id = v_tenant
                ORDER BY created_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))) e), '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- 7. Staff governance
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_coop_set_rule(p_domain text, p_patch jsonb, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.coop_benefit_rules;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a JSON object' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.coop_reason', left(p_reason, 300), true);

  UPDATE public.coop_benefit_rules r SET
    active = COALESCE((p_patch ->> 'active')::boolean, r.active),
    unit_label = COALESCE(p_patch ->> 'unit_label', r.unit_label),
    units_per_1000_records = CASE WHEN p_patch ? 'units_per_1000_records' THEN (p_patch ->> 'units_per_1000_records')::numeric ELSE r.units_per_1000_records END,
    units_per_cohort = CASE WHEN p_patch ? 'units_per_cohort' THEN (p_patch ->> 'units_per_cohort')::numeric ELSE r.units_per_cohort END,
    max_units_per_30d = CASE WHEN p_patch ? 'max_units_per_30d' THEN (p_patch ->> 'max_units_per_30d')::numeric ELSE r.max_units_per_30d END,
    counsel_ref = CASE WHEN p_patch ? 'counsel_ref' THEN nullif(btrim(p_patch ->> 'counsel_ref'), '') ELSE r.counsel_ref END,
    updated_by = auth.uid(), updated_at = now()
  WHERE r.domain = p_domain
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown domain' USING ERRCODE = '22023';
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_coop_adjust(p_user uuid, p_domain text, p_units numeric, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_units IS NULL OR p_units = 0 THEN
    RAISE EXCEPTION 'Non-zero units required' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) < 10 THEN
    RAISE EXCEPTION 'A note of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.coop_benefit_ledger (user_id, domain, kind, units, note, created_by)
  VALUES (p_user, p_domain, 'adjustment', round(p_units, 4), left(p_note, 500), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- =============================================================
-- 8. Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.coop_calc_units(integer, integer, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coop_accrue_benefits(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coop_record_redemption(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coop_get_my_ledger(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_coop_set_rule(text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_coop_adjust(uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coop_calc_units(integer, integer, numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.coop_accrue_benefits(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.coop_record_redemption(uuid, numeric, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.coop_get_my_ledger(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_coop_set_rule(text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_coop_adjust(uuid, text, numeric, text) TO authenticated;

-- Nightly accrual, 20 minutes after the SDE refresh slot (04:10). No-op, not an error, if pg_cron is absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-coop-accrue-benefits');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-coop-accrue-benefits', '30 4 * * *', 'select public.coop_accrue_benefits(current_date)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
