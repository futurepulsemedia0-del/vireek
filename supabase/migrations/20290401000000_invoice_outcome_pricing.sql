-- =====================================================================================================
-- Task E — Invoice-recovery outcome pricing, statements, disputes (extends the Results Plan billing stack)
--
-- STATUS: written from the uploaded repo only. NOT executed against any database (no Postgres was available
--         to the author). NOT live-verified. Apply to STAGING first.
-- SAFETY: one transaction; a guard block at the top aborts with a precise message if the live schema does not
--         match what this file assumes (profiles.id uuid, invoices.user_id uuid, get_account_owner_id(),
--         is_vireek_staff(uuid)). Nothing is changed in that case. Everything is idempotent.
-- DEFAULTS: feature OFF (global + per account), kill switch OFF-by-default meaning "not killed" but the feature
--         itself must be switched on by staff. No existing table, policy or function is modified.
-- ROLLBACK: docs/outcome-pricing/rollback.sql (drops only objects created here).
-- [COUNSEL] hold/contest day counts and SLA hours are placeholders.
-- =====================================================================================================
BEGIN;

-- ---------- 0. guard ----------------------------------------------------------------------------
DO $guard$
DECLARE
  missing text[] := ARRAY[]::text[];
  PROCEDURE_CHECKS text[] := ARRAY['public.get_account_owner_id()', 'public.is_vireek_staff(uuid)'];
  p text;
  c record;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN missing := missing || 'table profiles'; END IF;
  IF to_regclass('public.invoices') IS NULL THEN missing := missing || 'table invoices'; END IF;
  FOREACH p IN ARRAY PROCEDURE_CHECKS LOOP
    IF to_regprocedure(p) IS NULL THEN missing := missing || ('function ' || p); END IF;
  END LOOP;
  FOR c IN SELECT * FROM (VALUES
      ('profiles','id','uuid'), ('invoices','id','uuid'), ('invoices','user_id','uuid'), ('invoices','line_items','jsonb'),
      ('invoices','tax_percent','numeric'), ('invoices','due_date','date'), ('invoices','paid_at','timestamp with time zone'),
      ('invoices','status','text'), ('invoices','created_at','timestamp with time zone'), ('invoices','sent_at','timestamp with time zone'),
      ('invoices','invoice_number','text')
    ) AS v(t, col, typ)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = c.t AND column_name = c.col AND data_type = c.typ) THEN
      missing := missing || (c.t || '.' || c.col || ' ' || c.typ);
    END IF;
  END LOOP;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_outcome preflight failed; missing or different: %', array_to_string(missing, ', ')
      USING HINT = 'Your live DB differs from the repo (e.g. business_id TEXT). Run the read-only pre-flight query and send the output; do not force this migration.';
  END IF;
END
$guard$;

-- ---------- 1. constants & helpers ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_outcome_hold_days() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 14 $$;
CREATE OR REPLACE FUNCTION public.invoice_outcome_contest_days() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 60 $$;

-- True when the owning profile no longer exists (account erasure cascade) — lets cascades through immutability triggers.
CREATE OR REPLACE FUNCTION public.invoice_outcome_owner_gone(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user)
$$;

-- Total in cents with the same rounding as the documented invoice_total_cents parity:
-- sub = SUM(quantity * unit_price_cents) (exact), total = round(sub) + round(sub * tax_percent / 100). NULL if any line is malformed.
CREATE OR REPLACE FUNCTION public.invoice_outcome_total_cents(p_items jsonb, p_tax numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) li
                 WHERE (li->>'quantity') IS NULL OR (li->>'unit_price_cents') IS NULL) THEN NULL
    ELSE (round(s.sub) + round(s.sub * COALESCE(p_tax, 0) / 100))::bigint
  END
  FROM (SELECT COALESCE(SUM((li->>'quantity')::numeric * (li->>'unit_price_cents')::numeric), 0) AS sub
        FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) li) s
$$;

-- ---------- 2. global switch + per-account settings --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_outcome_global (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  feature_enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.invoice_outcome_global (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.invoice_outcome_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  enrolled_at timestamptz,
  suspended_reason text,
  terms_version int,
  confirmation_mode text NOT NULL DEFAULT 'human_or_complete_chain' CHECK (confirmation_mode IN ('human_only', 'human_or_complete_chain')),
  at_risk_days int NOT NULL DEFAULT 30 CHECK (at_risk_days BETWEEN 1 AND 365),
  attribution_window_days int NOT NULL DEFAULT 60 CHECK (attribution_window_days BETWEEN 1 AND 365),
  stripe_customer_id text CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.invoice_outcome_is_active(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT g.feature_enabled AND NOT g.kill_switch FROM public.invoice_outcome_global g WHERE g.id), false)
     AND COALESCE((SELECT s.enabled AND NOT s.kill_switch AND s.enrolled_at IS NOT NULL FROM public.invoice_outcome_settings s WHERE s.user_id = p_user), false)
$$;

-- ---------- 3. versioned contract documents + fee terms ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_outcome_contract_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL CHECK (version >= 1),
  locale text NOT NULL CHECK (locale IN ('en', 'fa')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, locale)
);

CREATE TABLE IF NOT EXISTS public.invoice_outcome_fee_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  version int NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  model text NOT NULL CHECK (model IN ('recovered_pct', 'first_pass_per_invoice', 'none')),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  base_fee_cents bigint NOT NULL DEFAULT 0 CHECK (base_fee_cents >= 0),
  pct_bps int NOT NULL DEFAULT 0 CHECK (pct_bps BETWEEN 0 AND 10000),
  per_invoice_cents bigint NOT NULL DEFAULT 0 CHECK (per_invoice_cents >= 0),
  outcome_floor_cents bigint NOT NULL DEFAULT 0 CHECK (outcome_floor_cents >= 0),
  outcome_cap_cents bigint CHECK (outcome_cap_cents IS NULL OR outcome_cap_cents >= 0),
  monthly_max_total_cents bigint CHECK (monthly_max_total_cents IS NULL OR monthly_max_total_cents >= 0),
  pilot_free_until timestamptz,
  no_fee_first_days int NOT NULL DEFAULT 0 CHECK (no_fee_first_days >= 0),
  contract_doc_version int,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (outcome_cap_cents IS NULL OR outcome_floor_cents <= outcome_cap_cents),
  CHECK (model <> 'recovered_pct' OR pct_bps > 0),
  CHECK (model <> 'first_pass_per_invoice' OR per_invoice_cents > 0),
  CHECK (model <> 'none' OR (pct_bps = 0 AND per_invoice_cents = 0 AND outcome_floor_cents = 0))
);
CREATE INDEX IF NOT EXISTS idx_io_terms_user ON public.invoice_outcome_fee_terms (user_id, effective_from DESC);

-- ---------- 4. action / signal log (append-only evidence) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_outcome_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  kind text NOT NULL CHECK (kind IN ('fix', 'resubmit', 'follow_up', 'escalation', 'payer_rejection', 'payer_rejection_cleared',
                                     'credit_issued', 'invoice_disputed', 'invoice_dispute_cleared', 'human_confirmation')),
  actor text NOT NULL CHECK (actor IN ('vireek', 'human', 'other_system')),
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL,
  risk_snapshot text CHECK (risk_snapshot IS NULL OR risk_snapshot IN ('at_risk', 'not_at_risk')),
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents > 0),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'credit_issued' OR amount_cents IS NOT NULL),
  CHECK (kind <> 'human_confirmation' OR actor_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_io_actions_invoice ON public.invoice_outcome_actions (user_id, invoice_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_io_actions_source ON public.invoice_outcome_actions (user_id, source_ref) WHERE source_ref IS NOT NULL;

-- ---------- 5. statements, lines, events ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_outcome_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved', 'invoiced', 'paid', 'disputed', 'void')),
  idempotency_key text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  terms_version int,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 1048576),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  base_fee_cents bigint NOT NULL CHECK (base_fee_cents >= 0),
  outcome_fee_cents bigint NOT NULL CHECK (outcome_fee_cents >= 0),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  invoiced_at timestamptz,
  paid_at timestamptz,
  stripe_record_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period),
  UNIQUE (idempotency_key),
  CHECK (base_fee_cents + outcome_fee_cents = total_cents)
);
CREATE INDEX IF NOT EXISTS idx_io_statements_user ON public.invoice_outcome_statements (user_id, period DESC);

CREATE TABLE IF NOT EXISTS public.invoice_outcome_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES public.invoice_outcome_statements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  recovered_cents bigint NOT NULL CHECK (recovered_cents > 0),
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  held boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_io_lines_user ON public.invoice_outcome_statement_lines (user_id, statement_id);

CREATE TABLE IF NOT EXISTS public.invoice_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL REFERENCES public.invoice_outcome_statements(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  rule_version text NOT NULL,
  qualifies boolean NOT NULL,
  recovered_cents bigint NOT NULL DEFAULT 0 CHECK (recovered_cents >= 0),
  reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
  released boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id, invoice_id)
);
-- DB-level double-count guard: one live counted outcome per invoice. Voiding a statement releases its events.
CREATE UNIQUE INDEX IF NOT EXISTS uq_io_events_counted ON public.invoice_outcome_events (user_id, invoice_id)
  WHERE qualifies AND recovered_cents > 0 AND NOT released;

-- ---------- 6. disputes -----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_outcome_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  statement_id uuid NOT NULL REFERENCES public.invoice_outcome_statements(id) ON DELETE CASCADE,
  line_id uuid NOT NULL REFERENCES public.invoice_outcome_statement_lines(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'under_review', 'upheld', 'rejected', 'withdrawn')),
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  ack_due_at timestamptz NOT NULL,
  resolve_due_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  CHECK (state NOT IN ('upheld', 'rejected') OR (resolved_at IS NOT NULL AND resolution_note IS NOT NULL AND char_length(btrim(resolution_note)) >= 5))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_io_disputes_active_line ON public.invoice_outcome_disputes (line_id) WHERE state IN ('open', 'under_review');
CREATE INDEX IF NOT EXISTS idx_io_disputes_user ON public.invoice_outcome_disputes (user_id, state);
CREATE INDEX IF NOT EXISTS idx_io_disputes_sla ON public.invoice_outcome_disputes (resolve_due_at) WHERE state IN ('open', 'under_review');

-- ---------- 7. append-only audit ------------------------------------------------------------------------------------
-- No FK to profiles on purpose: the trail must survive and cannot be cascaded away silently. [COUNSEL] retention.
CREATE TABLE IF NOT EXISTS public.invoice_outcome_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid,
  actor_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_io_audit_user ON public.invoice_outcome_audit (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.invoice_outcome_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice_outcome_audit is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_io_audit_immutable ON public.invoice_outcome_audit;
CREATE TRIGGER trg_io_audit_immutable BEFORE UPDATE OR DELETE ON public.invoice_outcome_audit
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_audit_immutable();

CREATE OR REPLACE FUNCTION public.invoice_outcome_audit_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - 'snapshot' - 'body' - 'decision' END;
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'snapshot' - 'body' - 'decision' END;
  r jsonb := COALESCE(n, o);
BEGIN
  INSERT INTO public.invoice_outcome_audit (user_id, actor_id, action, entity, entity_id, detail)
  VALUES (NULLIF(r->>'user_id', '')::uuid, auth.uid(), TG_OP, TG_TABLE_NAME, COALESCE(r->>'id', r->>'user_id'),
          jsonb_strip_nulls(jsonb_build_object('old', o, 'new', n)));
  RETURN COALESCE(NEW, OLD);
END $$;

DO $audit$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_outcome_global', 'invoice_outcome_settings', 'invoice_outcome_contract_docs', 'invoice_outcome_fee_terms',
                           'invoice_outcome_actions', 'invoice_outcome_statements', 'invoice_outcome_disputes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_io_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_io_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_audit_trg()', t);
  END LOOP;
END
$audit$;

-- ---------- 8. integrity triggers ---------------------------------------------------------------------------------------
-- actions: append-only
CREATE OR REPLACE FUNCTION public.invoice_outcome_actions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.invoice_outcome_owner_gone(OLD.user_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'invoice_outcome_actions is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_io_actions_guard ON public.invoice_outcome_actions;
CREATE TRIGGER trg_io_actions_guard BEFORE UPDATE OR DELETE ON public.invoice_outcome_actions
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_actions_guard();

-- approved contract docs & fee terms are immutable (terms may only be retired)
CREATE OR REPLACE FUNCTION public.invoice_outcome_docs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN RAISE EXCEPTION 'approved contract documents are immutable' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'approved' THEN RAISE EXCEPTION 'approved contract documents are immutable' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_io_docs_guard ON public.invoice_outcome_contract_docs;
CREATE TRIGGER trg_io_docs_guard BEFORE UPDATE OR DELETE ON public.invoice_outcome_contract_docs
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_docs_guard();

CREATE OR REPLACE FUNCTION public.invoice_outcome_terms_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT public.invoice_outcome_owner_gone(OLD.user_id) THEN
      RAISE EXCEPTION 'approved fee terms cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved', 'retired') THEN
    IF NEW.status = 'retired' AND OLD.status = 'approved'
       AND (to_jsonb(NEW) - 'status' - 'effective_to') = (to_jsonb(OLD) - 'status' - 'effective_to') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'approved fee terms are immutable (create a new version)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_io_terms_guard ON public.invoice_outcome_fee_terms;
CREATE TRIGGER trg_io_terms_guard BEFORE UPDATE OR DELETE ON public.invoice_outcome_fee_terms
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_terms_guard();

-- statements: legal transitions + immutability after draft (mirrors STATEMENT_TRANSITIONS in outcomeStatement.ts)
CREATE OR REPLACE FUNCTION public.invoice_outcome_statement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE legal boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' AND NOT public.invoice_outcome_owner_gone(OLD.user_id) THEN
      RAISE EXCEPTION 'only draft statements can be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state <> 'draft' AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.period IS DISTINCT FROM OLD.period OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.total_cents IS DISTINCT FROM OLD.total_cents OR NEW.base_fee_cents IS DISTINCT FROM OLD.base_fee_cents
    OR NEW.outcome_fee_cents IS DISTINCT FROM OLD.outcome_fee_cents OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
    OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
    OR NEW.generated_by IS DISTINCT FROM OLD.generated_by) THEN
    RAISE EXCEPTION 'statement content is immutable after approval' USING ERRCODE = '42501';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    legal := CASE OLD.state
      WHEN 'draft' THEN NEW.state IN ('approved', 'void')
      WHEN 'approved' THEN NEW.state IN ('invoiced', 'void')
      WHEN 'invoiced' THEN NEW.state IN ('paid', 'disputed')
      WHEN 'disputed' THEN NEW.state IN ('invoiced', 'void')
      ELSE false END;
    IF NOT legal THEN
      RAISE EXCEPTION 'illegal statement transition % -> %', OLD.state, NEW.state USING ERRCODE = '42501';
    END IF;
    IF NEW.state <> 'void' AND NOT public.invoice_outcome_is_active(NEW.user_id) THEN
      RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
    END IF;
    IF NEW.state = 'approved' THEN
      IF NEW.approved_by IS NULL THEN RAISE EXCEPTION 'approver_required' USING ERRCODE = '42501'; END IF;
      IF NEW.generated_by IS NOT NULL AND NEW.approved_by = NEW.generated_by THEN
        RAISE EXCEPTION 'self_approval_not_allowed' USING ERRCODE = '42501';
      END IF;
      NEW.approved_at := COALESCE(NEW.approved_at, now());
    ELSIF NEW.state = 'invoiced' AND OLD.state = 'approved' THEN
      IF OLD.approved_at IS NULL OR now() < OLD.approved_at + make_interval(days => public.invoice_outcome_hold_days()) THEN
        RAISE EXCEPTION 'dispute_window_open' USING ERRCODE = '42501';
      END IF;
      IF NEW.stripe_record_id IS NULL THEN RAISE EXCEPTION 'stripe_record_required' USING ERRCODE = '42501'; END IF;
      NEW.invoiced_at := COALESCE(NEW.invoiced_at, now());
    ELSIF NEW.state = 'paid' THEN
      NEW.paid_at := COALESCE(NEW.paid_at, now());
    ELSIF NEW.state = 'void' THEN
      UPDATE public.invoice_outcome_events SET released = true WHERE statement_id = OLD.id;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_io_statement_guard ON public.invoice_outcome_statements;
CREATE TRIGGER trg_io_statement_guard BEFORE UPDATE OR DELETE ON public.invoice_outcome_statements
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_statement_guard();

-- lines & events: writable only while the parent statement is a draft (events may additionally be "released")
CREATE OR REPLACE FUNCTION public.invoice_outcome_child_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st text; sid uuid; uid uuid;
BEGIN
  sid := CASE WHEN TG_OP = 'DELETE' THEN OLD.statement_id ELSE NEW.statement_id END;
  uid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  SELECT state INTO st FROM public.invoice_outcome_statements WHERE id = sid;
  IF st IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;  -- parent already gone (cascade)
  IF st = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' AND public.invoice_outcome_owner_gone(uid) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'invoice_outcome_events' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'released') = (to_jsonb(OLD) - 'released') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable once the statement is no longer a draft', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_io_lines_guard ON public.invoice_outcome_statement_lines;
CREATE TRIGGER trg_io_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_outcome_statement_lines
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_child_guard();
DROP TRIGGER IF EXISTS trg_io_events_guard ON public.invoice_outcome_events;
CREATE TRIGGER trg_io_events_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_outcome_events
  FOR EACH ROW EXECUTE FUNCTION public.invoice_outcome_child_guard();

-- ---------- 9. RLS (reads only; every write goes through service role or the SECURITY DEFINER functions below) ------------------------
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_outcome_global', 'invoice_outcome_settings', 'invoice_outcome_contract_docs', 'invoice_outcome_fee_terms',
                           'invoice_outcome_actions', 'invoice_outcome_statements', 'invoice_outcome_statement_lines', 'invoice_outcome_events',
                           'invoice_outcome_disputes', 'invoice_outcome_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
  END LOOP;
END
$rls$;

-- owner reads (tenant = account owner); staff read everything
DO $pol$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_outcome_settings', 'invoice_outcome_fee_terms', 'invoice_outcome_actions', 'invoice_outcome_statements',
                           'invoice_outcome_statement_lines', 'invoice_outcome_events', 'invoice_outcome_disputes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "io_owner_select" ON public.%I', t);
    EXECUTE format('CREATE POLICY "io_owner_select" ON public.%I FOR SELECT TO authenticated USING (user_id = (SELECT public.get_account_owner_id()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoice_outcome_global', 'invoice_outcome_settings', 'invoice_outcome_contract_docs', 'invoice_outcome_fee_terms',
                           'invoice_outcome_actions', 'invoice_outcome_statements', 'invoice_outcome_statement_lines', 'invoice_outcome_events',
                           'invoice_outcome_disputes', 'invoice_outcome_audit'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "io_staff_select" ON public.%I', t);
    EXECUTE format('CREATE POLICY "io_staff_select" ON public.%I FOR SELECT TO authenticated USING ((SELECT public.is_vireek_staff((SELECT auth.uid()))))', t);
  END LOOP;
END
$pol$;

-- the global row is readable by any signed-in user (the UI needs to know whether the feature exists)
DROP POLICY IF EXISTS "io_global_read" ON public.invoice_outcome_global;
CREATE POLICY "io_global_read" ON public.invoice_outcome_global FOR SELECT TO authenticated USING (true);

-- owners see only the contract text their approved terms point to
DROP POLICY IF EXISTS "io_owner_docs" ON public.invoice_outcome_contract_docs;
CREATE POLICY "io_owner_docs" ON public.invoice_outcome_contract_docs FOR SELECT TO authenticated USING (
  status = 'approved' AND EXISTS (
    SELECT 1 FROM public.invoice_outcome_fee_terms t
    WHERE t.user_id = (SELECT public.get_account_owner_id()) AND t.contract_doc_version = invoice_outcome_contract_docs.version AND t.status IN ('approved', 'retired')
  )
);

-- ---------- 10. billable view ------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.invoice_outcome_statement_billable WITH (security_invoker = true) AS
SELECT s.id AS statement_id, s.user_id, s.total_cents,
       GREATEST(s.base_fee_cents, s.total_cents - h.held_cents) AS billable_cents
FROM public.invoice_outcome_statements s
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(l.fee_cents), 0) AS held_cents
  FROM public.invoice_outcome_statement_lines l
  WHERE l.statement_id = s.id
    AND (l.held OR EXISTS (SELECT 1 FROM public.invoice_outcome_disputes d
                            WHERE d.line_id = l.id AND d.state IN ('open', 'under_review', 'upheld')))
) h ON true;
GRANT SELECT ON public.invoice_outcome_statement_billable TO authenticated;

-- ---------- 11. functions: owner ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_outcome_open_dispute(p_line_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_line public.invoice_outcome_statement_lines%ROWTYPE;
  v_st public.invoice_outcome_statements%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF char_length(v_reason) < 10 OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_line FROM public.invoice_outcome_statement_lines WHERE id = p_line_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'line_not_found' USING ERRCODE = '42501'; END IF;   -- cross-tenant ids look identical to missing ones
  SELECT * INTO v_st FROM public.invoice_outcome_statements WHERE id = v_line.statement_id FOR UPDATE;
  IF NOT public.invoice_outcome_is_active(v_owner) THEN RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501'; END IF;
  IF v_st.state NOT IN ('approved', 'invoiced', 'disputed') THEN RAISE EXCEPTION 'statement_not_contestable' USING ERRCODE = '22023'; END IF;
  IF v_st.approved_at IS NULL OR now() >= v_st.approved_at + make_interval(days => public.invoice_outcome_contest_days()) THEN
    RAISE EXCEPTION 'contest_window_closed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO public.invoice_outcome_disputes (user_id, statement_id, line_id, invoice_id, reason, opened_by, ack_due_at, resolve_due_at)
    VALUES (v_owner, v_line.statement_id, v_line.id, v_line.invoice_id, v_reason, auth.uid(), now() + interval '48 hours', now() + interval '10 days')
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_contested' USING ERRCODE = '23505';
  END;
  IF v_st.state = 'invoiced' THEN UPDATE public.invoice_outcome_statements SET state = 'disputed' WHERE id = v_st.id; END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_withdraw_dispute(p_dispute_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_d public.invoice_outcome_disputes%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_d FROM public.invoice_outcome_disputes WHERE id = p_dispute_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute_not_found' USING ERRCODE = '42501'; END IF;
  IF v_d.state NOT IN ('open', 'under_review') THEN RAISE EXCEPTION 'dispute_not_active' USING ERRCODE = '22023'; END IF;
  UPDATE public.invoice_outcome_disputes SET state = 'withdrawn', resolved_at = now(), resolved_by = auth.uid() WHERE id = v_d.id;
  UPDATE public.invoice_outcome_statements s SET state = 'invoiced'
   WHERE s.id = v_d.statement_id AND s.state = 'disputed'
     AND NOT EXISTS (SELECT 1 FROM public.invoice_outcome_disputes d WHERE d.statement_id = s.id AND d.state IN ('open', 'under_review'));
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_confirm(p_invoice_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE id = p_invoice_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = '42501';
  END IF;
  IF NOT public.invoice_outcome_is_active(v_owner) THEN RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.invoice_outcome_actions (user_id, invoice_id, kind, actor, actor_user_id, occurred_at, source_ref)
  VALUES (v_owner, p_invoice_id, 'human_confirmation', 'human', auth.uid(), now(), 'confirm:' || p_invoice_id::text)
  ON CONFLICT (user_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------- 12. functions: staff (admin-only) --------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_outcome_assert_staff() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'staff_only' USING ERRCODE = '42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_set_global(p_feature_enabled boolean, p_kill_switch boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  UPDATE public.invoice_outcome_global SET feature_enabled = p_feature_enabled, kill_switch = p_kill_switch, updated_at = now() WHERE id;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_set_account(
  p_user uuid, p_enabled boolean, p_kill_switch boolean, p_enrolled_at timestamptz, p_suspended_reason text, p_stripe_customer_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  INSERT INTO public.invoice_outcome_settings (user_id, enabled, kill_switch, enrolled_at, suspended_reason, stripe_customer_id)
  VALUES (p_user, p_enabled, p_kill_switch, p_enrolled_at, NULLIF(btrim(p_suspended_reason), ''), p_stripe_customer_id)
  ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, kill_switch = EXCLUDED.kill_switch, enrolled_at = COALESCE(EXCLUDED.enrolled_at, public.invoice_outcome_settings.enrolled_at),
    suspended_reason = EXCLUDED.suspended_reason, stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, public.invoice_outcome_settings.stripe_customer_id), updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_approve_terms(p_terms_id uuid, p_contract_doc_version int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_t public.invoice_outcome_fee_terms%ROWTYPE;
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  SELECT * INTO v_t FROM public.invoice_outcome_fee_terms WHERE id = p_terms_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'terms_not_found' USING ERRCODE = '22023'; END IF;
  IF v_t.status <> 'draft' THEN RAISE EXCEPTION 'terms_not_draft' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_outcome_contract_docs WHERE version = p_contract_doc_version AND status = 'approved' AND locale = 'en') THEN
    RAISE EXCEPTION 'approved_contract_doc_required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.invoice_outcome_fee_terms SET status = 'approved', contract_doc_version = p_contract_doc_version, approved_by = auth.uid(), approved_at = now() WHERE id = p_terms_id;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_transition(p_statement_id uuid, p_to text, p_stripe_record_id text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  IF p_to NOT IN ('approved', 'invoiced', 'paid', 'void') THEN RAISE EXCEPTION 'invalid_target' USING ERRCODE = '22023'; END IF;
  UPDATE public.invoice_outcome_statements
     SET state = p_to,
         approved_by = CASE WHEN p_to = 'approved' THEN auth.uid() ELSE approved_by END,
         stripe_record_id = COALESCE(p_stripe_record_id, stripe_record_id)
   WHERE id = p_statement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'statement_not_found' USING ERRCODE = '22023'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_dispute_set(p_dispute_id uuid, p_to text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_d public.invoice_outcome_disputes%ROWTYPE; v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  SELECT * INTO v_d FROM public.invoice_outcome_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute_not_found' USING ERRCODE = '22023'; END IF;
  IF NOT (CASE v_d.state WHEN 'open' THEN p_to IN ('under_review', 'upheld', 'rejected', 'withdrawn')
                         WHEN 'under_review' THEN p_to IN ('upheld', 'rejected', 'withdrawn') ELSE false END) THEN
    RAISE EXCEPTION 'illegal dispute transition % -> %', v_d.state, p_to USING ERRCODE = '22023';
  END IF;
  IF p_to IN ('upheld', 'rejected') AND (v_note IS NULL OR char_length(v_note) < 5) THEN RAISE EXCEPTION 'resolution_note_required' USING ERRCODE = '22023'; END IF;
  UPDATE public.invoice_outcome_disputes
     SET state = p_to,
         acknowledged_at = COALESCE(acknowledged_at, now()),
         resolved_at = CASE WHEN p_to = 'under_review' THEN NULL ELSE now() END,
         resolved_by = CASE WHEN p_to = 'under_review' THEN NULL ELSE auth.uid() END,
         resolution_note = COALESCE(v_note, resolution_note)
   WHERE id = v_d.id;
  UPDATE public.invoice_outcome_statements s SET state = 'invoiced'
   WHERE s.id = v_d.statement_id AND s.state = 'disputed'
     AND NOT EXISTS (SELECT 1 FROM public.invoice_outcome_disputes d WHERE d.statement_id = s.id AND d.state IN ('open', 'under_review'));
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_save_terms(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  INSERT INTO public.invoice_outcome_fee_terms (user_id, version, effective_from, effective_to, model, currency, base_fee_cents, pct_bps, per_invoice_cents,
                                                outcome_floor_cents, outcome_cap_cents, monthly_max_total_cents, pilot_free_until, no_fee_first_days)
  VALUES ((p->>'user_id')::uuid, (p->>'version')::int, (p->>'effective_from')::timestamptz, NULLIF(p->>'effective_to', '')::timestamptz, p->>'model',
          COALESCE(p->>'currency', 'USD'), COALESCE((p->>'base_fee_cents')::bigint, 0), COALESCE((p->>'pct_bps')::int, 0), COALESCE((p->>'per_invoice_cents')::bigint, 0),
          COALESCE((p->>'outcome_floor_cents')::bigint, 0), NULLIF(p->>'outcome_cap_cents', '')::bigint, NULLIF(p->>'monthly_max_total_cents', '')::bigint,
          NULLIF(p->>'pilot_free_until', '')::timestamptz, COALESCE((p->>'no_fee_first_days')::int, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_save_doc(p_version int, p_locale text, p_title text, p_body text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  INSERT INTO public.invoice_outcome_contract_docs (version, locale, title, body) VALUES (p_version, p_locale, p_title, p_body)
  ON CONFLICT (version, locale) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body;  -- guard trigger rejects edits once approved
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_staff_approve_doc(p_version int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.invoice_outcome_assert_staff();
  IF (SELECT count(*) FROM public.invoice_outcome_contract_docs WHERE version = p_version AND status = 'draft' AND locale IN ('en', 'fa')) <> 2 THEN
    RAISE EXCEPTION 'both_locales_required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.invoice_outcome_contract_docs SET status = 'approved', approved_by = auth.uid(), approved_at = now() WHERE version = p_version AND status = 'draft';
END $$;

CREATE OR REPLACE FUNCTION public.invoice_outcome_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND public.is_vireek_staff(auth.uid())
$$;

-- ---------- 13. functions: service role only -------------------------------------------------------------------------------------------
-- Vireek agents call this to log an action/signal. at_risk snapshot is computed server-side when not supplied.
CREATE OR REPLACE FUNCTION public.invoice_outcome_log_action(
  p_user uuid, p_invoice uuid, p_kind text, p_occurred_at timestamptz, p_actor text, p_source_ref text, p_amount_cents bigint DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_inv public.invoices%ROWTYPE; v_days int; v_snap text; v_id uuid; v_rej boolean;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice AND user_id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = '42501'; END IF;
  IF p_kind IN ('fix', 'resubmit', 'follow_up', 'escalation') THEN
    SELECT COALESCE((SELECT at_risk_days FROM public.invoice_outcome_settings WHERE user_id = p_user), 30) INTO v_days;
    SELECT EXISTS (SELECT 1 FROM public.invoice_outcome_actions r
                    WHERE r.user_id = p_user AND r.invoice_id = p_invoice AND r.kind = 'payer_rejection' AND r.occurred_at <= p_occurred_at
                      AND NOT EXISTS (SELECT 1 FROM public.invoice_outcome_actions c
                                       WHERE c.user_id = p_user AND c.invoice_id = p_invoice AND c.kind = 'payer_rejection_cleared'
                                         AND c.occurred_at > r.occurred_at AND c.occurred_at <= p_occurred_at)) INTO v_rej;
    v_snap := CASE WHEN v_rej OR p_occurred_at - COALESCE(v_inv.sent_at, v_inv.created_at) > make_interval(days => v_days) THEN 'at_risk' ELSE 'not_at_risk' END;
  END IF;
  INSERT INTO public.invoice_outcome_actions (user_id, invoice_id, kind, actor, occurred_at, risk_snapshot, amount_cents, source_ref)
  VALUES (p_user, p_invoice, p_kind, p_actor, p_occurred_at, v_snap, p_amount_cents, p_source_ref)
  ON CONFLICT (user_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Facts for the attribution engine. Payment model: invoices carry one paid_at and are paid in full (no partial-payment table exists).
CREATE OR REPLACE FUNCTION public.invoice_outcome_facts(p_user uuid, p_from timestamptz, p_to timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH inv AS (
    SELECT i.*, public.invoice_outcome_total_cents(i.line_items, i.tax_percent) AS total_cents
    FROM public.invoices i
    WHERE i.user_id = p_user AND i.status = 'paid' AND i.paid_at >= p_from AND i.paid_at < p_to
  ), ok AS (SELECT * FROM inv WHERE total_cents IS NOT NULL AND total_cents > 0)
  SELECT jsonb_build_object(
    'skipped', (SELECT count(*) FROM inv WHERE total_cents IS NULL OR total_cents <= 0),
    'invoices', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'label', COALESCE(o.invoice_number, o.id::text),
        'issuedAt', COALESCE(o.sent_at, o.created_at),
        'dueAt', CASE WHEN o.due_date IS NULL THEN NULL ELSE ((o.due_date + 1)::timestamp AT TIME ZONE 'UTC') - interval '1 second' END,
        'totalCents', o.total_cents, 'status', 'paid',
        'payments', jsonb_build_array(jsonb_build_object('id', 'pay-' || o.id::text, 'at', o.paid_at, 'cents', o.total_cents)),
        'rejectedAt', (SELECT min(a.occurred_at) FROM public.invoice_outcome_actions a WHERE a.user_id = p_user AND a.invoice_id = o.id AND a.kind = 'payer_rejection'),
        'rejectionClearedAt', (SELECT max(a.occurred_at) FROM public.invoice_outcome_actions a WHERE a.user_id = p_user AND a.invoice_id = o.id AND a.kind = 'payer_rejection_cleared'),
        'disputed', EXISTS (SELECT 1 FROM public.invoice_outcome_actions a WHERE a.user_id = p_user AND a.invoice_id = o.id AND a.kind = 'invoice_disputed'
                              AND NOT EXISTS (SELECT 1 FROM public.invoice_outcome_actions c WHERE c.user_id = p_user AND c.invoice_id = o.id AND c.kind = 'invoice_dispute_cleared' AND c.occurred_at > a.occurred_at)),
        'creditedCents', COALESCE((SELECT sum(a.amount_cents) FROM public.invoice_outcome_actions a WHERE a.user_id = p_user AND a.invoice_id = o.id AND a.kind = 'credit_issued'), 0),
        'isTest', false)) FROM ok o), '[]'::jsonb),
    'actions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'invoiceId', a.invoice_id, 'type', a.kind, 'at', a.occurred_at, 'actor', a.actor, 'riskSnapshot', a.risk_snapshot))
                          FROM public.invoice_outcome_actions a JOIN ok o ON o.id = a.invoice_id
                          WHERE a.user_id = p_user AND a.kind IN ('fix', 'resubmit', 'follow_up', 'escalation')), '[]'::jsonb),
    'confirmations', COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('invoiceId', a.invoice_id, 'confirmedAt', a.occurred_at, 'confirmedBy', a.actor_user_id::text))
                                FROM public.invoice_outcome_actions a JOIN ok o ON o.id = a.invoice_id
                                WHERE a.user_id = p_user AND a.kind = 'human_confirmation'), '[]'::jsonb),
    'alreadyCounted', COALESCE((SELECT jsonb_object_agg(e.invoice_id::text, e.recovered_cents)
                                 FROM public.invoice_outcome_events e JOIN ok o ON o.id = e.invoice_id
                                 WHERE e.user_id = p_user AND e.qualifies AND NOT e.released), '{}'::jsonb)
  )
$$;

-- ---------- 14. execute grants -------------------------------------------------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.invoice_outcome_open_dispute(uuid,text)', 'public.invoice_outcome_withdraw_dispute(uuid)', 'public.invoice_outcome_confirm(uuid)',
    'public.invoice_outcome_staff_set_global(boolean,boolean)', 'public.invoice_outcome_staff_set_account(uuid,boolean,boolean,timestamptz,text,text)',
    'public.invoice_outcome_staff_approve_terms(uuid,int)', 'public.invoice_outcome_staff_transition(uuid,text,text)', 'public.invoice_outcome_staff_dispute_set(uuid,text,text)',
    'public.invoice_outcome_staff_save_terms(jsonb)', 'public.invoice_outcome_staff_save_doc(int,text,text,text)', 'public.invoice_outcome_staff_approve_doc(int)',
    'public.invoice_outcome_is_staff()', 'public.invoice_outcome_log_action(uuid,uuid,text,timestamptz,text,text,bigint)', 'public.invoice_outcome_facts(uuid,timestamptz,timestamptz)',
    'public.invoice_outcome_is_active(uuid)', 'public.invoice_outcome_assert_staff()', 'public.invoice_outcome_owner_gone(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.invoice_outcome_open_dispute(uuid,text), public.invoice_outcome_withdraw_dispute(uuid), public.invoice_outcome_confirm(uuid),
    public.invoice_outcome_staff_set_global(boolean,boolean), public.invoice_outcome_staff_set_account(uuid,boolean,boolean,timestamptz,text,text),
    public.invoice_outcome_staff_approve_terms(uuid,int), public.invoice_outcome_staff_transition(uuid,text,text), public.invoice_outcome_staff_dispute_set(uuid,text,text),
    public.invoice_outcome_staff_save_terms(jsonb), public.invoice_outcome_staff_save_doc(int,text,text,text), public.invoice_outcome_staff_approve_doc(int)
    TO authenticated;
  GRANT EXECUTE ON FUNCTION public.invoice_outcome_is_active(uuid), public.invoice_outcome_is_staff() TO authenticated;
  GRANT EXECUTE ON FUNCTION public.invoice_outcome_log_action(uuid,uuid,text,timestamptz,text,text,bigint), public.invoice_outcome_facts(uuid,timestamptz,timestamptz),
    public.invoice_outcome_is_active(uuid), public.invoice_outcome_owner_gone(uuid) TO service_role;
END
$grants$;

COMMIT;
