-- =============================================================
-- Fair Sale Protocol, part 2/2 — settings, sessions, immutable protection log,
-- trusted contacts, second-review queue, observational metrics
--
-- Principles (see supabase/functions/_shared/fair-sale/types.ts):
--   * NO demographic, biometric or health column exists in any table here, and none may be added:
--     the fairness test in fairness.test.ts scans identifiers for such words.
--   * The event log stores CODES, never transcript text (a CHECK rejects text-like keys), so it can be
--     immutable without holding personal data. It is append-only and hash-chained per session.
--   * Trusted-contact data is the only personal data held, exists only with the customer's explicit
--     consent, is revocable at any time, and is deleted with the customer.
--   * Writes happen through SECURITY DEFINER RPCs or the service role; the browser can only read its
--     own account's rows (RLS). No policy grants INSERT/UPDATE/DELETE.
--
-- NOT LEGAL ADVICE. Statutory requirements come from counsel-approved compliance rule versions.
-- Depends on: customers, audit_log, get_account_owner_id(), compliance_can_manage(),
--             20271110000000_compliance_rule_packs.sql, 20281102000000_fair_sale_rule_kinds.sql.
-- Safe to re-run. Rollback notes are at the bottom of this file.
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.customers') IS NULL OR to_regclass('public.audit_log') IS NULL
     OR to_regprocedure('public.get_account_owner_id()') IS NULL
     OR to_regprocedure('public.compliance_can_manage()') IS NULL THEN
    RAISE EXCEPTION 'customers / audit_log / get_account_owner_id() / compliance_can_manage() are missing — run the earlier migrations first.';
  END IF;
END $$;

-- 1. Settings: thresholds owners may tune WITHIN platform floors/ceilings -------------------
-- Keep the bounds in sync with supabase/functions/_shared/fair-sale/config.ts (CONFIG_BOUNDS).
CREATE TABLE IF NOT EXISTS public.fair_sale_settings (
  user_id                        uuid PRIMARY KEY,
  large_job_cents                integer NOT NULL DEFAULT 500000 CHECK (large_job_cents BETWEEN 50000 AND 2000000),
  large_deposit_cents            integer NOT NULL DEFAULT 100000 CHECK (large_deposit_cents BETWEEN 10000 AND 1000000),
  large_deposit_percent          integer NOT NULL DEFAULT 30 CHECK (large_deposit_percent BETWEEN 5 AND 50),
  scope_escalation_percent       integer NOT NULL DEFAULT 50 CHECK (scope_escalation_percent BETWEEN 10 AND 100),
  pause_threshold_cents          integer NOT NULL DEFAULT 250000 CHECK (pause_threshold_cents BETWEEN 50000 AND 1000000),
  pause_hours                    integer NOT NULL DEFAULT 24 CHECK (pause_hours BETWEEN 12 AND 168),
  manager_approval_deposit_cents integer NOT NULL DEFAULT 100000 CHECK (manager_approval_deposit_cents BETWEEN 10000 AND 1000000),
  manager_approval_financing     boolean NOT NULL DEFAULT true CHECK (manager_approval_financing),
  confusion_repeat_threshold     integer NOT NULL DEFAULT 2 CHECK (confusion_repeat_threshold BETWEEN 2 AND 4),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  updated_by                     uuid
);

-- 2. Sessions: one per (account, subject) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fair_sale_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  customer_id        uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  subject_type       text NOT NULL CHECK (subject_type IN ('call', 'chat', 'quote', 'contract')),
  subject_id         text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 120),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  active             boolean NOT NULL DEFAULT false,
  emergency          text CHECK (emergency IS NULL OR emergency IN ('safety', 'active_damage')),
  total_cents        integer CHECK (total_cents IS NULL OR total_cents >= 0),
  deposit_cents      integer CHECK (deposit_cents IS NULL OR deposit_cents >= 0),
  job_band           text NOT NULL DEFAULT 'unknown' CHECK (job_band IN ('small', 'medium', 'large', 'unknown')),
  counterparty_state text CHECK (counterparty_state IS NULL OR counterparty_state ~ '^[A-Z]{2}$'),
  hold_until         timestamptz,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_fair_sale_sessions_user ON public.fair_sale_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fair_sale_sessions_customer ON public.fair_sale_sessions (customer_id) WHERE customer_id IS NOT NULL;

-- lint:allow-destructive TRUNCATE appears only in a trigger and a REVOKE that PROTECT the append-only log
-- 3. Immutable protection log (append-only, hash-chained per session) ----------------------
CREATE TABLE IF NOT EXISTS public.fair_sale_events (
  id               bigserial PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES public.fair_sale_sessions(id) ON DELETE RESTRICT,
  user_id          uuid NOT NULL,
  event_type       text NOT NULL CHECK (event_type IN (
                     'signal_detected', 'protection_offered', 'customer_choice', 'staff_override',
                     'approval_requested', 'approval_decided', 'price_second_look', 'pause_started',
                     'trusted_contact_consented', 'trusted_contact_revoked', 'trusted_contact_notified',
                     'callback_requested', 'compliance_evaluated')),
  protection       text CHECK (protection IS NULL OR protection IN (
                     'plain_summary', 'no_same_day_decision', 'price_second_look', 'trusted_contact_offer',
                     'manager_approval', 'help_check_prompt', 'human_callback', 'no_false_urgency', 'payment_channel_guard')),
  choice           text CHECK (choice IS NULL OR choice IN ('pending', 'accepted', 'declined', 'deferred')),
  signal_codes     text[] NOT NULL DEFAULT '{}',
  rule_version_ids uuid[] NOT NULL DEFAULT '{}',
  actor_type       text NOT NULL CHECK (actor_type IN ('system', 'customer', 'staff', 'ai_agent')),
  actor_id         uuid,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 4096
                          AND NOT (details ?| ARRAY['transcript', 'text', 'utterance', 'message', 'quote'])),
  prev_hash        text,
  hash             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fair_sale_events_session ON public.fair_sale_events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_fair_sale_events_user ON public.fair_sale_events (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fair_sale_event_hash_input(e public.fair_sale_events)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT concat_ws('|',
    COALESCE(e.prev_hash, ''), e.session_id::text, e.event_type, COALESCE(e.protection, ''), COALESCE(e.choice, ''),
    array_to_string(e.signal_codes, ','), array_to_string(e.rule_version_ids, ','), e.actor_type,
    COALESCE(e.actor_id::text, ''), e.details::text,
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))
$$;

CREATE OR REPLACE FUNCTION public.fair_sale_events_chain()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Serialise appends per session so two writers can never fork the chain.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id::text, 0));
  SELECT e.hash INTO NEW.prev_hash FROM public.fair_sale_events e WHERE e.session_id = NEW.session_id ORDER BY e.id DESC LIMIT 1;
  NEW.hash := encode(sha256(convert_to(public.fair_sale_event_hash_input(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fair_sale_events_chain ON public.fair_sale_events;
CREATE TRIGGER trg_fair_sale_events_chain BEFORE INSERT ON public.fair_sale_events
  FOR EACH ROW EXECUTE FUNCTION public.fair_sale_events_chain();

CREATE OR REPLACE FUNCTION public.fair_sale_events_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'fair_sale_immutable: the protection log is append-only';
END $$;

DROP TRIGGER IF EXISTS trg_fair_sale_events_immutable ON public.fair_sale_events;
CREATE TRIGGER trg_fair_sale_events_immutable BEFORE UPDATE OR DELETE ON public.fair_sale_events
  FOR EACH ROW EXECUTE FUNCTION public.fair_sale_events_immutable();
DROP TRIGGER IF EXISTS trg_fair_sale_events_no_truncate ON public.fair_sale_events;
CREATE TRIGGER trg_fair_sale_events_no_truncate BEFORE TRUNCATE ON public.fair_sale_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.fair_sale_events_immutable();

-- 4. Trusted contacts: explicit consent, revocable, minimal ---------------------------------------
CREATE TABLE IF NOT EXISTS public.fair_sale_trusted_contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  customer_id      uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  session_id       uuid REFERENCES public.fair_sale_sessions(id) ON DELETE SET NULL,
  contact_name     text NOT NULL CHECK (char_length(btrim(contact_name)) BETWEEN 1 AND 120),
  contact_phone    text CHECK (contact_phone IS NULL OR char_length(contact_phone) BETWEEN 5 AND 32),
  contact_email    text CHECK (contact_email IS NULL OR char_length(contact_email) BETWEEN 3 AND 254),
  relationship     text CHECK (relationship IS NULL OR char_length(relationship) <= 60),
  scope            text[] NOT NULL DEFAULT ARRAY['summary_copy']::text[]
                   CHECK (cardinality(scope) >= 1 AND scope <@ ARRAY['summary_copy', 'callback_notice']::text[]),
  consent_source   text NOT NULL CHECK (consent_source IN ('customer_verbal', 'customer_written', 'customer_web')),
  consent_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(consent_evidence) = 'object' AND octet_length(consent_evidence::text) <= 2048),
  status           text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  consented_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoke_source    text CHECK (revoke_source IS NULL OR revoke_source IN ('customer_verbal', 'customer_written', 'customer_web', 'staff_on_request')),
  revoke_token_hash text,
  created_by       uuid,
  CHECK (contact_phone IS NOT NULL OR contact_email IS NOT NULL),
  CHECK ((status = 'granted' AND revoked_at IS NULL AND revoke_source IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_source IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_fair_sale_tc_customer ON public.fair_sale_trusted_contacts (customer_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fair_sale_tc_token ON public.fair_sale_trusted_contacts (revoke_token_hash) WHERE revoke_token_hash IS NOT NULL;

-- Only granted -> revoked is possible. A new consent is a NEW row; revoked never flips back.
CREATE OR REPLACE FUNCTION public.fair_sale_tc_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'fair_sale_immutable: a revoked trusted contact cannot change — record a new consent instead';
  END IF;
  IF (NEW.user_id, NEW.customer_id, NEW.contact_name, NEW.contact_phone, NEW.contact_email, NEW.scope, NEW.consent_source, NEW.consented_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.customer_id, OLD.contact_name, OLD.contact_phone, OLD.contact_email, OLD.scope, OLD.consent_source, OLD.consented_at) THEN
    RAISE EXCEPTION 'fair_sale_immutable: consent details cannot be edited — revoke and record a new consent';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fair_sale_tc_guard ON public.fair_sale_trusted_contacts;
CREATE TRIGGER trg_fair_sale_tc_guard BEFORE UPDATE ON public.fair_sale_trusted_contacts
  FOR EACH ROW EXECUTE FUNCTION public.fair_sale_tc_guard();

-- 5. Second-review queue -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fair_sale_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  session_id     uuid NOT NULL REFERENCES public.fair_sale_sessions(id) ON DELETE RESTRICT,
  kind           text NOT NULL CHECK (kind IN ('deposit', 'financing', 'payment_channel', 'price', 'scope_escalation')),
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  blocking       boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'changes_requested', 'declined')),
  requested_by   uuid,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid,
  decided_by_email text,
  decided_at     timestamptz,
  decision_notes text CHECK (decision_notes IS NULL OR char_length(decision_notes) <= 1000),
  self_review    boolean NOT NULL DEFAULT false,
  UNIQUE (session_id, kind),
  CHECK (status = 'open' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND char_length(btrim(COALESCE(decision_notes, ''))) >= 10))
);
CREATE INDEX IF NOT EXISTS idx_fair_sale_reviews_open ON public.fair_sale_reviews (user_id, status, requested_at);

-- 6. RLS: read-only for the account's team; everything else via RPC / service role ------------------
ALTER TABLE public.fair_sale_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fair_sale_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fair_sale_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fair_sale_trusted_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fair_sale_reviews          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_fair_sale_settings ON public.fair_sale_settings;
CREATE POLICY select_own_fair_sale_settings ON public.fair_sale_settings
  FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));
DROP POLICY IF EXISTS select_own_fair_sale_sessions ON public.fair_sale_sessions;
CREATE POLICY select_own_fair_sale_sessions ON public.fair_sale_sessions
  FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));
DROP POLICY IF EXISTS select_own_fair_sale_events ON public.fair_sale_events;
CREATE POLICY select_own_fair_sale_events ON public.fair_sale_events
  FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));
DROP POLICY IF EXISTS select_own_fair_sale_reviews ON public.fair_sale_reviews;
CREATE POLICY select_own_fair_sale_reviews ON public.fair_sale_reviews
  FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));
-- Trusted-contact rows hold a third party's contact details: managers only.
DROP POLICY IF EXISTS select_own_fair_sale_tc ON public.fair_sale_trusted_contacts;
CREATE POLICY select_own_fair_sale_tc ON public.fair_sale_trusted_contacts
  FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()) AND (select public.compliance_can_manage()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.fair_sale_settings, public.fair_sale_sessions, public.fair_sale_events,
  public.fair_sale_trusted_contacts, public.fair_sale_reviews FROM anon, authenticated;

-- 7. Internal append helper (service-side only) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_sale_append_event(
  p_session uuid, p_type text, p_protection text, p_choice text, p_signals text[], p_versions uuid[],
  p_actor_type text, p_actor uuid, p_details jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_id bigint;
BEGIN
  SELECT s.user_id INTO v_user FROM public.fair_sale_sessions s WHERE s.id = p_session;
  IF v_user IS NULL THEN RAISE EXCEPTION 'fair_sale_not_found: session'; END IF;
  INSERT INTO public.fair_sale_events (session_id, user_id, event_type, protection, choice, signal_codes, rule_version_ids, actor_type, actor_id, details)
  VALUES (p_session, v_user, p_type, p_protection, p_choice, COALESCE(p_signals, '{}'), COALESCE(p_versions, '{}'), p_actor_type, p_actor, COALESCE(p_details, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.fair_sale_append_event(uuid, text, text, text, text[], uuid[], text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fair_sale_actor_email()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.email FROM auth.users u WHERE u.id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.fair_sale_actor_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fair_sale_actor_email() TO authenticated;

-- 8. Owner-facing RPCs ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fair_sale_get_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); s public.fair_sale_settings;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM public.fair_sale_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN
    s.large_job_cents := 500000; s.large_deposit_cents := 100000; s.large_deposit_percent := 30; s.scope_escalation_percent := 50;
    s.pause_threshold_cents := 250000; s.pause_hours := 24; s.manager_approval_deposit_cents := 100000;
    s.manager_approval_financing := true; s.confusion_repeat_threshold := 2;
  END IF;
  RETURN jsonb_build_object(
    'largeJobCents', s.large_job_cents, 'largeDepositCents', s.large_deposit_cents, 'largeDepositPercent', s.large_deposit_percent,
    'scopeEscalationPercent', s.scope_escalation_percent, 'pauseThresholdCents', s.pause_threshold_cents, 'pauseHours', s.pause_hours,
    'managerApprovalDepositCents', s.manager_approval_deposit_cents, 'managerApprovalFinancing', s.manager_approval_financing,
    'confusionRepeatThreshold', s.confusion_repeat_threshold);
END $$;

CREATE OR REPLACE FUNCTION public.fair_sale_save_settings(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'fair_sale_invalid: settings must be an object'; END IF;
  INSERT INTO public.fair_sale_settings AS t (
    user_id, large_job_cents, large_deposit_cents, large_deposit_percent, scope_escalation_percent, pause_threshold_cents,
    pause_hours, manager_approval_deposit_cents, manager_approval_financing, confusion_repeat_threshold, updated_at, updated_by)
  VALUES (
    v_owner,
    COALESCE((p ->> 'largeJobCents')::integer, 500000), COALESCE((p ->> 'largeDepositCents')::integer, 100000),
    COALESCE((p ->> 'largeDepositPercent')::integer, 30), COALESCE((p ->> 'scopeEscalationPercent')::integer, 50),
    COALESCE((p ->> 'pauseThresholdCents')::integer, 250000), COALESCE((p ->> 'pauseHours')::integer, 24),
    COALESCE((p ->> 'managerApprovalDepositCents')::integer, 100000), COALESCE((p ->> 'managerApprovalFinancing')::boolean, true),
    COALESCE((p ->> 'confusionRepeatThreshold')::integer, 2), now(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    large_job_cents = EXCLUDED.large_job_cents, large_deposit_cents = EXCLUDED.large_deposit_cents,
    large_deposit_percent = EXCLUDED.large_deposit_percent, scope_escalation_percent = EXCLUDED.scope_escalation_percent,
    pause_threshold_cents = EXCLUDED.pause_threshold_cents, pause_hours = EXCLUDED.pause_hours,
    manager_approval_deposit_cents = EXCLUDED.manager_approval_deposit_cents, manager_approval_financing = EXCLUDED.manager_approval_financing,
    confusion_repeat_threshold = EXCLUDED.confusion_repeat_threshold, updated_at = now(), updated_by = auth.uid();
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.fair_sale_actor_email(), 'fair_sale.settings_saved', 'fair_sale_settings', v_owner::text);
  RETURN public.fair_sale_get_settings();
END $$;

-- Manager decision on a queued review. Nobody approves their own sale unless they are the account owner (flagged).
CREATE OR REPLACE FUNCTION public.fair_sale_decide_review(p_review uuid, p_decision text, p_notes text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); r public.fair_sale_reviews; v_self boolean; v_is_owner boolean;
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('approved', 'changes_requested', 'declined') THEN RAISE EXCEPTION 'fair_sale_invalid: decision'; END IF;
  IF p_notes IS NULL OR char_length(btrim(p_notes)) < 10 THEN RAISE EXCEPTION 'fair_sale_invalid: written notes of at least 10 characters are required'; END IF;
  SELECT * INTO r FROM public.fair_sale_reviews WHERE id = p_review AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fair_sale_not_found: review'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'fair_sale_invalid: this review has already been decided'; END IF;
  v_self := r.requested_by IS NOT DISTINCT FROM auth.uid();
  v_is_owner := EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner');
  IF v_self AND NOT v_is_owner THEN RAISE EXCEPTION 'fair_sale_forbidden: you cannot approve your own sale — ask another manager'; END IF;
  UPDATE public.fair_sale_reviews SET status = p_decision, decided_by = auth.uid(), decided_by_email = public.fair_sale_actor_email(),
    decided_at = now(), decision_notes = btrim(p_notes), self_review = v_self WHERE id = r.id;
  PERFORM public.fair_sale_append_event(r.session_id, 'approval_decided', 'manager_approval', NULL, '{}', '{}', 'staff', auth.uid(),
    jsonb_build_object('kind', r.kind, 'decision', p_decision, 'selfReview', v_self));
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.fair_sale_actor_email(), 'fair_sale.review_' || p_decision, 'fair_sale_reviews', r.id::text);
END $$;

-- Staff removes a voluntary protection (the app also enforces that customer-requested ones stay on).
CREATE OR REPLACE FUNCTION public.fair_sale_staff_override(p_session uuid, p_protection text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.compliance_can_manage() THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF p_protection IN ('human_callback', 'no_false_urgency', 'payment_channel_guard', 'manager_approval') THEN
    RAISE EXCEPTION 'fair_sale_forbidden: this protection can never be turned off';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'fair_sale_invalid: a written reason of at least 10 characters is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fair_sale_sessions WHERE id = p_session AND user_id = v_owner) THEN RAISE EXCEPTION 'fair_sale_not_found: session'; END IF;
  -- A protection the customer asked for in this session stays on.
  IF EXISTS (SELECT 1 FROM public.fair_sale_events e WHERE e.session_id = p_session AND e.event_type = 'signal_detected'
             AND ((p_protection = 'no_same_day_decision' AND 'more_time' = ANY (e.signal_codes))
               OR (p_protection = 'trusted_contact_offer' AND 'trusted_contact' = ANY (e.signal_codes))
               OR (p_protection = 'plain_summary' AND 'written_summary' = ANY (e.signal_codes))
               OR (p_protection = 'price_second_look' AND 'second_opinion' = ANY (e.signal_codes)))) THEN
    RAISE EXCEPTION 'fair_sale_forbidden: the customer asked for this protection, so it stays on';
  END IF;
  PERFORM public.fair_sale_append_event(p_session, 'staff_override', p_protection, NULL, '{}', '{}', 'staff', auth.uid(),
    jsonb_build_object('reason', left(btrim(p_reason), 500)));
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.fair_sale_actor_email(), 'fair_sale.override', 'fair_sale_sessions', p_session::text);
END $$;

-- Staff records the customer's answer given on the phone / in person.
CREATE OR REPLACE FUNCTION public.fair_sale_record_choice(p_session uuid, p_protection text, p_choice text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF p_choice NOT IN ('accepted', 'declined', 'deferred') THEN RAISE EXCEPTION 'fair_sale_invalid: choice'; END IF;
  IF p_choice = 'declined' AND p_protection IN ('human_callback', 'no_false_urgency', 'payment_channel_guard', 'manager_approval') THEN
    RAISE EXCEPTION 'fair_sale_forbidden: this protection cannot be declined';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fair_sale_sessions WHERE id = p_session AND user_id = v_owner) THEN RAISE EXCEPTION 'fair_sale_not_found: session'; END IF;
  PERFORM public.fair_sale_append_event(p_session, 'customer_choice', p_protection, p_choice, '{}', '{}', 'staff', auth.uid(), '{"recordedBy":"staff"}'::jsonb);
END $$;

-- Staff records a trusted contact the CUSTOMER agreed to. Returns the new id.
CREATE OR REPLACE FUNCTION public.fair_sale_record_trusted_contact(
  p_customer uuid, p_session uuid, p_name text, p_phone text, p_email text, p_relationship text,
  p_scope text[], p_source text, p_evidence jsonb, p_token_hash text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer AND c.user_id = v_owner) THEN RAISE EXCEPTION 'fair_sale_not_found: customer'; END IF;
  IF p_session IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fair_sale_sessions WHERE id = p_session AND user_id = v_owner) THEN RAISE EXCEPTION 'fair_sale_not_found: session'; END IF;
  INSERT INTO public.fair_sale_trusted_contacts (user_id, customer_id, session_id, contact_name, contact_phone, contact_email, relationship, scope, consent_source, consent_evidence, revoke_token_hash, created_by)
  VALUES (v_owner, p_customer, p_session, btrim(p_name), NULLIF(btrim(p_phone), ''), NULLIF(btrim(p_email), ''), NULLIF(btrim(p_relationship), ''),
          COALESCE(p_scope, ARRAY['summary_copy']::text[]), p_source, COALESCE(p_evidence, '{}'::jsonb), p_token_hash, auth.uid())
  RETURNING id INTO v_id;
  IF p_session IS NOT NULL THEN
    PERFORM public.fair_sale_append_event(p_session, 'trusted_contact_consented', 'trusted_contact_offer', 'accepted', '{}', '{}', 'staff', auth.uid(),
      jsonb_build_object('trustedContactId', v_id, 'source', p_source));
  END IF;
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.fair_sale_actor_email(), 'fair_sale.trusted_contact_consented', 'fair_sale_trusted_contacts', v_id::text);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.fair_sale_revoke_trusted_contact(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); t public.fair_sale_trusted_contacts;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.fair_sale_trusted_contacts WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fair_sale_not_found: trusted contact'; END IF;
  IF t.status = 'revoked' THEN RETURN; END IF;
  UPDATE public.fair_sale_trusted_contacts SET status = 'revoked', revoked_at = now(), revoke_source = 'staff_on_request', revoke_token_hash = NULL WHERE id = t.id;
  IF t.session_id IS NOT NULL THEN
    PERFORM public.fair_sale_append_event(t.session_id, 'trusted_contact_revoked', 'trusted_contact_offer', NULL, '{}', '{}', 'staff', auth.uid(), jsonb_build_object('trustedContactId', t.id));
  END IF;
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_owner, auth.uid(), public.fair_sale_actor_email(), 'fair_sale.trusted_contact_revoked', 'fair_sale_trusted_contacts', t.id::text);
END $$;

-- Customer-initiated revocation from the link they were given. Service role only (called by the fair-sale-public edge function).
CREATE OR REPLACE FUNCTION public.fair_sale_revoke_by_token(p_token text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t public.fair_sale_trusted_contacts; v_hash text;
BEGIN
  IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 32 AND 128 THEN RETURN false; END IF;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT * INTO t FROM public.fair_sale_trusted_contacts WHERE revoke_token_hash = v_hash AND status = 'granted' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.fair_sale_trusted_contacts SET status = 'revoked', revoked_at = now(), revoke_source = 'customer_web', revoke_token_hash = NULL WHERE id = t.id;
  IF t.session_id IS NOT NULL THEN
    PERFORM public.fair_sale_append_event(t.session_id, 'trusted_contact_revoked', 'trusted_contact_offer', NULL, '{}', '{}', 'customer', NULL, jsonb_build_object('trustedContactId', t.id));
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fair_sale_revoke_by_token(text) FROM PUBLIC, anon, authenticated;

-- Tamper check: recompute the chain for a session. Returns the first bad event id, or NULL when intact.
CREATE OR REPLACE FUNCTION public.fair_sale_verify_chain(p_session uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); e public.fair_sale_events; v_prev text := NULL; v_calc text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fair_sale_sessions WHERE id = p_session AND user_id = v_owner) THEN RAISE EXCEPTION 'fair_sale_not_found: session'; END IF;
  FOR e IN SELECT * FROM public.fair_sale_events WHERE session_id = p_session ORDER BY id LOOP
    IF e.prev_hash IS DISTINCT FROM v_prev THEN RETURN e.id; END IF;
    v_calc := encode(sha256(convert_to(public.fair_sale_event_hash_input(e), 'UTF8')), 'hex');
    IF v_calc <> e.hash THEN RETURN e.id; END IF;
    v_prev := e.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Observational counts by month and job-size band. No outcome joins here: complaints, cancellations,
-- chargebacks and satisfaction come from their own sources and are supplied to the report separately.
CREATE OR REPLACE FUNCTION public.fair_sale_metrics(p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'fair_sale_forbidden' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 800 THEN RAISE EXCEPTION 'fair_sale_invalid: date range'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."month", t."jobBand"), '[]'::jsonb) INTO v FROM (
    SELECT to_char(date_trunc('month', s.created_at), 'YYYY-MM') AS "month", s.job_band AS "jobBand",
      count(*) AS "sessions",
      count(*) FILTER (WHERE s.active) AS "activeSessions",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.fair_sale_events e WHERE e.session_id = s.id AND e.event_type = 'protection_offered'
        AND e.protection NOT IN ('human_callback', 'no_false_urgency', 'payment_channel_guard'))) AS "protectedSessions",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.fair_sale_events e WHERE e.session_id = s.id AND e.event_type = 'customer_choice'
        AND e.protection = 'no_same_day_decision' AND e.choice = 'accepted')) AS "pausesAccepted",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.fair_sale_events e WHERE e.session_id = s.id AND e.event_type = 'customer_choice'
        AND e.protection = 'no_same_day_decision' AND e.choice = 'declined')) AS "pausesDeclined",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.fair_sale_reviews r WHERE r.session_id = s.id)) AS "sessionsWithReview",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.fair_sale_reviews r WHERE r.session_id = s.id AND r.status = 'approved')) AS "sessionsApproved"
    FROM public.fair_sale_sessions s
    WHERE s.user_id = v_owner AND s.created_at >= p_from AND s.created_at < (p_to + 1)
    GROUP BY 1, 2
  ) t;
  RETURN v;
END $$;

-- 9. Grants: owner-facing RPCs to signed-in users only -------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fair_sale_get_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_save_settings(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_decide_review(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_staff_override(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_record_choice(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_record_trusted_contact(uuid, uuid, text, text, text, text, text[], text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_revoke_trusted_contact(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_verify_chain(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fair_sale_metrics(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fair_sale_get_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_save_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_decide_review(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_staff_override(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_record_choice(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_record_trusted_contact(uuid, uuid, text, text, text, text, text[], text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_revoke_trusted_contact(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_verify_chain(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fair_sale_metrics(date, date) TO authenticated;

-- =============================================================
-- Rollback / recovery (run manually, in this order, only if you must remove the feature):
--   DROP FUNCTION IF EXISTS public.fair_sale_metrics(date, date), public.fair_sale_verify_chain(uuid),
--     public.fair_sale_revoke_by_token(text), public.fair_sale_revoke_trusted_contact(uuid),
--     public.fair_sale_record_trusted_contact(uuid, uuid, text, text, text, text, text[], text, jsonb, text),
--     public.fair_sale_record_choice(uuid, text, text), public.fair_sale_staff_override(uuid, text, text),
--     public.fair_sale_decide_review(uuid, text, text), public.fair_sale_save_settings(jsonb), public.fair_sale_get_settings(),
--     public.fair_sale_actor_email(), public.fair_sale_append_event(uuid, text, text, text, text[], uuid[], text, uuid, jsonb);
--   The protection log is evidence for disputes and regulators: export it BEFORE dropping
--   (fair_sale_events, fair_sale_reviews, fair_sale_sessions, fair_sale_trusted_contacts, fair_sale_settings).
--   Part 1 (rule kinds) can stay: it only adds capability and changes no existing behaviour.
-- =============================================================
