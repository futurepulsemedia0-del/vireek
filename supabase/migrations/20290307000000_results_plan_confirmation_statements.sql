/*
  # Results Plan — customer arrival confirmation (SMS) + monthly PDF statements

  STATUS: written WITHOUT access to Postgres. NOT RUN. Apply on staging first, then run the pgTAP file
  supabase/tests/database/results_plan_confirmation_statements.test.sql.

  Requires: 20280402000000..20280402000200 (proof_ledger, charges, flags, accounts), get_account_owner_id(),
  is_vireek_staff(uuid), profiles, jobs. Idempotent: safe to run twice.

  ## What this adds
  1. results_plan_accounts.customer_confirmation_enabled  (default FALSE: the owner opts in; nothing is texted otherwise)
     results_plan_accounts.statement_email_enabled       (default TRUE: the PDF is also emailed to the owner)
  2. results_plan_confirmations — one row per job (UNIQUE user_id+job_id => idempotent), the "Did <business> arrive?" SMS.
     A "NO" reply opens a staff review and HOLDS the charge (bill function skips it) until staff decide.
  3. results_plan_statements — one immutable snapshot per account per month (UNIQUE user_id+month => idempotent generation).
  4. RPCs: rp_set_options (owner), rp_record_confirmation_reply (service_role), rp_staff_resolve_confirmation (staff),
     rp_statement_claim_email (service_role).
  5. Ledger event types 'customer_confirmed' / 'customer_denied' and flag code 'customer_denied_arrival'.

  ## Pricing
  No price, fee or threshold number is introduced here. Statements only print amounts already stored on charges/terms.

  ## Cron (run ONCE in the SQL editor; <project-ref>, <CRON_SECRET> = RESULTS_PLAN_CRON_SECRET)
    select cron.schedule('results-plan-confirm', '*/15 * * * *', $$ select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/results-plan-confirm',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'), body := '{}'::jsonb); $$);
    select cron.schedule('results-plan-statement', '40 * * * *', $$ select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/results-plan-statement',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'), body := jsonb_build_object('action','sweep')); $$);

  ## Rollback (only before real data exists; destroys confirmations and statements)
    DROP FUNCTION IF EXISTS rp_set_options(boolean, boolean), rp_record_confirmation_reply(uuid, text, text),
      rp_staff_resolve_confirmation(uuid, boolean), rp_statement_claim_email(uuid);
    DROP TABLE IF EXISTS results_plan_statements, results_plan_confirmations;
    ALTER TABLE results_plan_accounts DROP COLUMN IF EXISTS customer_confirmation_enabled, DROP COLUMN IF EXISTS statement_email_enabled;
    (the widened CHECK lists on proof_ledger / results_plan_flags are supersets and may stay)
*/

-- =============================================================
-- 1. Account options
-- =============================================================
ALTER TABLE results_plan_accounts
  ADD COLUMN IF NOT EXISTS customer_confirmation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS statement_email_enabled boolean NOT NULL DEFAULT true;

-- Widen the (dynamically named) CHECK constraints; supersets of the current lists.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'public.proof_ledger'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%event_type%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.proof_ledger DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE public.proof_ledger ADD CONSTRAINT proof_ledger_event_type_check CHECK (event_type IN (
    'qualified', 'confirmed', 'completed', 'paid', 'voided', 'charge_posted', 'credited', 'disputed', 'dispute_resolved', 'rejected',
    'customer_confirmed', 'customer_denied'));

  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'public.results_plan_flags'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%completion_marking_drop%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.results_plan_flags DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE public.results_plan_flags ADD CONSTRAINT results_plan_flags_code_check CHECK (code IN (
    'completion_marking_drop', 'relabel_after_charge', 'qualification_spike', 'fair_use_minutes', 'customer_denied_arrival'));
END $$;

-- Owner-only switch (team members cannot change what is texted to customers or billed).
CREATE OR REPLACE FUNCTION public.rp_set_options(p_confirmation boolean, p_statement_email boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF auth.uid() <> v_owner THEN RAISE EXCEPTION 'OWNER_ONLY'; END IF;
  IF p_confirmation IS NULL OR p_statement_email IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  UPDATE results_plan_accounts
     SET customer_confirmation_enabled = p_confirmation, statement_email_enabled = p_statement_email
   WHERE user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_ACCOUNT'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.rp_set_options(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rp_set_options(boolean, boolean) TO authenticated;

-- =============================================================
-- 2. Customer confirmations ("Did <business> arrive?")
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  charge_id uuid REFERENCES results_plan_charges(id) ON DELETE SET NULL,
  customer_phone text NOT NULL CHECK (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'confirmed', 'denied', 'no_response', 'skipped', 'failed')),
  skip_reason text CHECK (skip_reason IS NULL OR char_length(skip_reason) <= 60),
  answer text CHECK (answer IS NULL OR answer IN ('yes', 'no')),
  review_status text NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'open', 'upheld', 'dismissed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  responded_at timestamptz,
  provider_sid text CHECK (provider_sid IS NULL OR char_length(provider_sid) <= 80),
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rp_confirmation_unique_job UNIQUE (user_id, job_id),
  CONSTRAINT rp_confirmation_answered CHECK (status NOT IN ('confirmed', 'denied') OR (responded_at IS NOT NULL AND answer IS NOT NULL)),
  CONSTRAINT rp_confirmation_review CHECK (review_status = 'none' OR status = 'denied')
);
CREATE INDEX IF NOT EXISTS idx_rp_conf_due ON results_plan_confirmations (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_rp_conf_reply ON results_plan_confirmations (user_id, customer_phone, sent_at DESC) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_rp_conf_review ON results_plan_confirmations (user_id) WHERE review_status = 'open';

ALTER TABLE results_plan_confirmations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_rp_confirmations" ON results_plan_confirmations;
CREATE POLICY "select_own_rp_confirmations" ON results_plan_confirmations FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_rp_confirmations" ON results_plan_confirmations;
CREATE POLICY "staff_select_rp_confirmations" ON results_plan_confirmations FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_confirmations FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.rp_confirmation_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.job_id <> OLD.job_id OR NEW.customer_phone <> OLD.customer_phone) THEN
    RAISE EXCEPTION 'confirmation identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rp_confirmation_touch ON results_plan_confirmations;
CREATE TRIGGER trg_rp_confirmation_touch BEFORE INSERT OR UPDATE ON results_plan_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.rp_confirmation_touch();

/*
  Inbound reply. p_answer is parsed by the edge function (pure parser, unit-tested): 'yes' | 'no' | 'stop'.
  - 'stop'  : every unsent/unanswered confirmation for this phone becomes skipped(opted_out); returns handled=false so the
              normal STOP flow (dnc_suppressions) continues untouched.
  - yes/no  : applies to the NEWEST 'sent' confirmation for this phone within 7 days. A repeated identical reply is a no-op.
*/
CREATE OR REPLACE FUNCTION public.rp_record_confirmation_reply(p_user uuid, p_phone text, p_answer text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  c results_plan_confirmations%ROWTYPE; v_rule text; v_n integer;
BEGIN
  IF p_answer IS NULL OR p_answer NOT IN ('yes', 'no', 'stop') THEN RAISE EXCEPTION 'invalid answer'; END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{6,14}$' THEN RETURN jsonb_build_object('handled', false); END IF;
  SELECT rule_version INTO v_rule FROM results_plan_accounts WHERE user_id = p_user;
  IF v_rule IS NULL THEN RETURN jsonb_build_object('handled', false); END IF;

  IF p_answer = 'stop' THEN
    UPDATE results_plan_confirmations SET status = 'skipped', skip_reason = 'opted_out'
     WHERE user_id = p_user AND customer_phone = p_phone AND status IN ('queued', 'sending', 'sent');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('handled', false, 'skipped', v_n);
  END IF;

  SELECT * INTO c FROM results_plan_confirmations
   WHERE user_id = p_user AND customer_phone = p_phone AND status = 'sent' AND sent_at > now() - interval '7 days'
   ORDER BY sent_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    -- Twilio retry / double tap of an already-recorded answer: acknowledge without re-applying.
    IF EXISTS (SELECT 1 FROM results_plan_confirmations WHERE user_id = p_user AND customer_phone = p_phone
                AND status IN ('confirmed', 'denied') AND answer = p_answer AND responded_at > now() - interval '1 day') THEN
      RETURN jsonb_build_object('handled', true, 'outcome', 'already_recorded');
    END IF;
    RETURN jsonb_build_object('handled', false);
  END IF;

  IF p_answer = 'yes' THEN
    UPDATE results_plan_confirmations SET status = 'confirmed', answer = 'yes', responded_at = now() WHERE id = c.id;
    PERFORM public.proof_ledger_append(p_user, c.job_id, 'customer_confirmed', 'cust-confirm:' || c.id::text, v_rule,
      jsonb_build_object('confirmation_id', c.id, 'answer', 'yes', 'asked_at', c.sent_at, 'channel', 'sms'));
    RETURN jsonb_build_object('handled', true, 'outcome', 'confirmed', 'confirmation_id', c.id);
  END IF;

  UPDATE results_plan_confirmations SET status = 'denied', answer = 'no', responded_at = now(), review_status = 'open' WHERE id = c.id;
  PERFORM public.proof_ledger_append(p_user, c.job_id, 'customer_denied', 'cust-deny:' || c.id::text, v_rule,
    jsonb_build_object('confirmation_id', c.id, 'answer', 'no', 'asked_at', c.sent_at, 'channel', 'sms'));
  INSERT INTO results_plan_flags (user_id, code, severity, detail, week_start)
  VALUES (p_user, 'customer_denied_arrival', 'high', 'A customer replied that the business did not arrive. The related charge is on hold pending review.',
          date_trunc('week', now())::date)
  ON CONFLICT (user_id, code, week_start) DO NOTHING;
  RETURN jsonb_build_object('handled', true, 'outcome', 'denied', 'confirmation_id', c.id);
END $$;
REVOKE ALL ON FUNCTION public.rp_record_confirmation_reply(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rp_record_confirmation_reply(uuid, text, text) TO service_role;

-- Staff decision on a denial. uphold = the denial stands (charge voided/credited); dismiss = the work happened (charge proceeds).
CREATE OR REPLACE FUNCTION public.rp_staff_resolve_confirmation(p_id uuid, p_uphold boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE c results_plan_confirmations%ROWTYPE; ch results_plan_charges%ROWTYPE; v_rule text; v_next text;
BEGIN
  PERFORM public.rp_staff_guard();
  IF p_uphold IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT * INTO c FROM results_plan_confirmations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF c.review_status <> 'open' THEN RETURN jsonb_build_object('outcome', 'already_resolved', 'review_status', c.review_status); END IF;
  SELECT rule_version INTO v_rule FROM results_plan_accounts WHERE user_id = c.user_id;

  UPDATE results_plan_confirmations SET review_status = CASE WHEN p_uphold THEN 'upheld' ELSE 'dismissed' END WHERE id = c.id;
  IF p_uphold AND c.charge_id IS NOT NULL THEN
    SELECT * INTO ch FROM results_plan_charges WHERE id = c.charge_id AND user_id = c.user_id FOR UPDATE;
    IF FOUND AND ch.status IN ('pending', 'failed', 'posted') THEN
      v_next := CASE WHEN ch.status = 'posted' THEN 'credited' ELSE 'voided' END;
      UPDATE results_plan_charges SET status = v_next, updated_at = now() WHERE id = ch.id;
      IF v_next = 'credited' THEN
        PERFORM public.proof_ledger_append(c.user_id, c.job_id, 'credited', 'credit:' || ch.id::text, v_rule,
          jsonb_build_object('charge_id', ch.id, 'auto', false, 'why', 'customer denied arrival; upheld by review'));
      ELSE
        PERFORM public.proof_ledger_append(c.user_id, c.job_id, 'voided', 'voided:' || c.job_id::text, v_rule,
          jsonb_build_object('why', 'customer denied arrival; upheld by review', 'charge_id', ch.id));
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', CASE WHEN p_uphold THEN 'upheld' ELSE 'dismissed' END);
END $$;
REVOKE ALL ON FUNCTION public.rp_staff_resolve_confirmation(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rp_staff_resolve_confirmation(uuid, boolean) TO authenticated;

-- =============================================================
-- 3. Monthly statements (immutable snapshot, one per account per month)
-- =============================================================
CREATE TABLE IF NOT EXISTS results_plan_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  terms_id uuid REFERENCES results_plan_pricing_terms(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 2097152),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  line_count integer NOT NULL CHECK (line_count >= 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  email_attempts smallint NOT NULL DEFAULT 0 CHECK (email_attempts BETWEEN 0 AND 20),
  email_updated_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz,
  email_error text CHECK (email_error IS NULL OR char_length(email_error) <= 300),
  CONSTRAINT rp_statement_unique_month UNIQUE (user_id, month)
);
CREATE INDEX IF NOT EXISTS idx_rp_statements_email ON results_plan_statements (email_updated_at) WHERE email_status IN ('pending', 'failed', 'sending');

ALTER TABLE results_plan_statements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_rp_statements" ON results_plan_statements;
CREATE POLICY "select_own_rp_statements" ON results_plan_statements FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_rp_statements" ON results_plan_statements;
CREATE POLICY "staff_select_rp_statements" ON results_plan_statements FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON results_plan_statements FROM anon, authenticated;

-- The numbers on a statement never change after generation; only the delivery columns may.
CREATE OR REPLACE FUNCTION public.rp_statement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.month <> OLD.month OR NEW.currency <> OLD.currency OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_sha256 <> OLD.snapshot_sha256 OR NEW.line_count <> OLD.line_count OR NEW.generated_at <> OLD.generated_at
     OR NEW.terms_id IS DISTINCT FROM OLD.terms_id THEN
    RAISE EXCEPTION 'a generated statement is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.email_updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rp_statement_immutable ON results_plan_statements;
CREATE TRIGGER trg_rp_statement_immutable BEFORE UPDATE ON results_plan_statements
  FOR EACH ROW EXECUTE FUNCTION public.rp_statement_immutable();

/*
  Atomic claim of the email step. true = caller may send. A 'sending' claim older than 30 minutes is considered abandoned
  (process died) and may be re-claimed: at-least-once for a crashed send, never concurrent. 'failed' retries after 15 minutes, max 5 attempts.
*/
CREATE OR REPLACE FUNCTION public.rp_statement_claim_email(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows integer;
BEGIN
  UPDATE results_plan_statements
     SET email_status = 'sending', email_attempts = email_attempts + 1
   WHERE id = p_id AND email_attempts < 5 AND (
         email_status = 'pending'
      OR (email_status = 'failed' AND email_updated_at < now() - interval '15 minutes')
      OR (email_status = 'sending' AND email_updated_at < now() - interval '30 minutes'));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION public.rp_statement_claim_email(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rp_statement_claim_email(uuid) TO service_role;
