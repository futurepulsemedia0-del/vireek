/*
  # Stripe Disputes (chargebacks) — /dashboard/disputes

  ## Why
  Payments run as Stripe destination charges on the platform account
  (create-payment-request -> payment_intent_data.transfer_data). A chargeback therefore
  lands on the PLATFORM account and is only linkable through
  payment_requests.stripe_payment_intent_id. This migration stores every dispute per
  account, the evidence the contractor is preparing, a deduplicated event log, and
  win/loss statistics.

  ## Design
  - Writes to stripe_disputes happen ONLY via apply_stripe_dispute_event() (service role,
    called by the stripe-dispute-webhook edge function). It is atomic: event dedupe +
    upsert + notification in one transaction, and an out-of-order guard (an older event
    can never overwrite a newer state).
  - status / reason are plain text with NO CHECK: Stripe adds values over time and a
    constraint would make the webhook fail and Stripe retry forever.
  - Staff access = account owner or team member with permissions.can_view_billing
    (same rule as Receivables Intelligence). Everything is scoped by
    public.get_account_owner_id().
  - Evidence files live in the private bucket `dispute-evidence`, folder = account owner id.
  - Setting jobs.customer_disputed = true on a new dispute feeds the existing
    Service Recovery agent. It is never reset automatically (a manual flag may exist).

  ## Requires (already in your project)
  get_account_owner_id(), profiles, team_members, payment_requests(stripe_payment_intent_id),
  stripe_connect_accounts, jobs, notifications.

  ## Stripe limits used (verify against current Stripe docs before launch)
  Evidence files: PDF/JPG/PNG, total <= 4.5 MB. Total evidence text <= 150,000 characters.
*/

-- =============================================================
-- ACCESS HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_access_disputes()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;
GRANT EXECUTE ON FUNCTION public.can_access_disputes() TO authenticated;

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS stripe_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_dispute_id text NOT NULL UNIQUE,
  stripe_charge_id text,
  stripe_payment_intent_id text,
  stripe_account_id text,
  payment_request_id uuid REFERENCES payment_requests(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'usd',
  reason text,
  network_reason_code text,
  status text NOT NULL,
  is_charge_refundable boolean,
  evidence_due_by timestamptz,
  has_evidence boolean NOT NULL DEFAULT false,
  past_due boolean NOT NULL DEFAULT false,
  submission_count integer NOT NULL DEFAULT 0,
  evidence_submitted_at timestamptz,
  net_balance_cents bigint NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  evidence_draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_draft) = 'object'),
  deadline_notified_at timestamptz,
  last_event_type text,
  last_event_created bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_user_opened ON stripe_disputes(user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_user_status ON stripe_disputes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_due ON stripe_disputes(evidence_due_by) WHERE status IN ('needs_response', 'warning_needs_response');
CREATE INDEX IF NOT EXISTS idx_stripe_disputes_job ON stripe_disputes(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_dispute_events (
  stripe_event_id text PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE, -- NULL = could not be matched to an account (e.g. a Vireek-subscription dispute)
  dispute_id uuid REFERENCES stripe_disputes(id) ON DELETE CASCADE,
  stripe_dispute_id text NOT NULL,
  event_type text NOT NULL,
  event_created bigint NOT NULL,
  status_after text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_dispute_events_dispute ON stripe_dispute_events(dispute_id, event_created);

CREATE TABLE IF NOT EXISTS stripe_dispute_evidence_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dispute_id uuid NOT NULL REFERENCES stripe_disputes(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'receipt', 'customer_communication', 'service_documentation', 'customer_signature',
    'cancellation_policy', 'refund_policy', 'duplicate_charge_documentation', 'uncategorized_file'
  )),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4500000),
  stripe_file_id text,
  uploaded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispute_evidence_files_dispute ON stripe_dispute_evidence_files(dispute_id);

-- =============================================================
-- RLS (read-only for clients; all writes go through the RPCs/edge functions below)
-- =============================================================
ALTER TABLE stripe_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_dispute_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_dispute_evidence_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_stripe_disputes" ON stripe_disputes;
CREATE POLICY "select_own_stripe_disputes" ON stripe_disputes
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_access_disputes());

DROP POLICY IF EXISTS "select_own_stripe_dispute_events" ON stripe_dispute_events;
CREATE POLICY "select_own_stripe_dispute_events" ON stripe_dispute_events
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_access_disputes());

DROP POLICY IF EXISTS "select_own_dispute_evidence_files" ON stripe_dispute_evidence_files;
CREATE POLICY "select_own_dispute_evidence_files" ON stripe_dispute_evidence_files
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_access_disputes());

-- =============================================================
-- PRIVATE EVIDENCE BUCKET  (path: <account_owner_id>/<dispute_id>/<uuid>-<file>)
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dispute-evidence', 'dispute-evidence', false, 4500000, ARRAY['application/pdf', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "dispute_evidence_select" ON storage.objects;
CREATE POLICY "dispute_evidence_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'dispute-evidence' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text AND public.can_access_disputes());

DROP POLICY IF EXISTS "dispute_evidence_insert" ON storage.objects;
CREATE POLICY "dispute_evidence_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'dispute-evidence' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text AND public.can_access_disputes());

DROP POLICY IF EXISTS "dispute_evidence_delete" ON storage.objects;
CREATE POLICY "dispute_evidence_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'dispute-evidence' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text AND public.can_access_disputes());

-- =============================================================
-- WEBHOOK INGEST (service role only) — atomic, idempotent, order-safe
-- p = { event_id, event_type, event_created, stripe_account_id, dispute: { normalized fields } }
-- =============================================================
CREATE OR REPLACE FUNCTION public.apply_stripe_dispute_event(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d jsonb := p -> 'dispute';
  v_user uuid;
  v_pr_id uuid;
  v_job uuid;
  v_customer text;
  v_dispute_id uuid;
  v_inserted boolean;
  v_event_created bigint := (p ->> 'event_created')::bigint;
  v_status text := d ->> 'status';
  v_closed boolean := (p ->> 'event_type') = 'charge.dispute.closed';
BEGIN
  -- Dedupe first: a replayed event is a no-op inside the same transaction.
  INSERT INTO stripe_dispute_events (stripe_event_id, stripe_dispute_id, event_type, event_created, status_after)
  VALUES (p ->> 'event_id', d ->> 'stripe_dispute_id', p ->> 'event_type', v_event_created, v_status)
  ON CONFLICT (stripe_event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('matched', true, 'duplicate', true);
  END IF;

  -- Resolve the account: destination charge -> payment_request; direct charge -> connect account.
  SELECT pr.user_id, pr.id, pr.job_id, pr.customer_name
    INTO v_user, v_pr_id, v_job, v_customer
  FROM payment_requests pr
  WHERE pr.stripe_payment_intent_id = d ->> 'stripe_payment_intent_id'
    AND d ->> 'stripe_payment_intent_id' IS NOT NULL
  LIMIT 1;

  IF v_user IS NULL AND NULLIF(p ->> 'stripe_account_id', '') IS NOT NULL THEN
    SELECT sca.user_id INTO v_user FROM stripe_connect_accounts sca
    WHERE sca.stripe_account_id = p ->> 'stripe_account_id' LIMIT 1;
  END IF;

  IF v_user IS NULL THEN
    RETURN jsonb_build_object('matched', false);
  END IF;

  INSERT INTO stripe_disputes AS sd (
    user_id, stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, stripe_account_id,
    payment_request_id, job_id, customer_name, amount_cents, currency, reason, network_reason_code,
    status, is_charge_refundable, evidence_due_by, has_evidence, past_due, submission_count,
    evidence_submitted_at, net_balance_cents, opened_at, closed_at, last_event_type, last_event_created
  ) VALUES (
    v_user, d ->> 'stripe_dispute_id', d ->> 'stripe_charge_id', d ->> 'stripe_payment_intent_id',
    NULLIF(p ->> 'stripe_account_id', ''), v_pr_id, v_job, v_customer,
    COALESCE((d ->> 'amount_cents')::bigint, 0), COALESCE(d ->> 'currency', 'usd'),
    d ->> 'reason', d ->> 'network_reason_code', v_status,
    (d ->> 'is_charge_refundable')::boolean,
    to_timestamp(NULLIF(d ->> 'evidence_due_by', '')::double precision),
    COALESCE((d ->> 'has_evidence')::boolean, false), COALESCE((d ->> 'past_due')::boolean, false),
    COALESCE((d ->> 'submission_count')::integer, 0),
    CASE WHEN COALESCE((d ->> 'submission_count')::integer, 0) > 0 THEN to_timestamp(v_event_created) END,
    COALESCE((d ->> 'net_balance_cents')::bigint, 0),
    to_timestamp((d ->> 'opened_at')::double precision),
    CASE WHEN v_closed THEN to_timestamp(v_event_created) END,
    p ->> 'event_type', v_event_created
  )
  ON CONFLICT (stripe_dispute_id) DO UPDATE SET
    stripe_charge_id = COALESCE(EXCLUDED.stripe_charge_id, sd.stripe_charge_id),
    amount_cents = EXCLUDED.amount_cents,
    reason = COALESCE(EXCLUDED.reason, sd.reason),
    network_reason_code = COALESCE(EXCLUDED.network_reason_code, sd.network_reason_code),
    status = EXCLUDED.status,
    is_charge_refundable = EXCLUDED.is_charge_refundable,
    evidence_due_by = COALESCE(EXCLUDED.evidence_due_by, sd.evidence_due_by),
    has_evidence = EXCLUDED.has_evidence,
    past_due = EXCLUDED.past_due,
    submission_count = GREATEST(EXCLUDED.submission_count, sd.submission_count),
    evidence_submitted_at = COALESCE(sd.evidence_submitted_at,
      CASE WHEN EXCLUDED.submission_count > 0 THEN to_timestamp(v_event_created) END),
    net_balance_cents = EXCLUDED.net_balance_cents,
    closed_at = COALESCE(EXCLUDED.closed_at, sd.closed_at),
    last_event_type = EXCLUDED.last_event_type,
    last_event_created = EXCLUDED.last_event_created,
    updated_at = now()
  WHERE sd.last_event_created <= EXCLUDED.last_event_created   -- an older event never overwrites newer state
  RETURNING sd.id, (xmax = 0) INTO v_dispute_id, v_inserted;

  IF v_dispute_id IS NULL THEN  -- stale event: keep the row, just link the log entry
    SELECT id INTO v_dispute_id FROM stripe_disputes WHERE stripe_dispute_id = d ->> 'stripe_dispute_id';
    v_inserted := false;
  END IF;

  UPDATE stripe_dispute_events SET user_id = v_user, dispute_id = v_dispute_id
  WHERE stripe_event_id = p ->> 'event_id';

  IF v_inserted THEN
    IF v_job IS NOT NULL AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'customer_disputed'
    ) THEN
      EXECUTE 'UPDATE jobs SET customer_disputed = true WHERE id = $1 AND user_id = $2' USING v_job, v_user;
    END IF;
    IF v_status IN ('needs_response', 'warning_needs_response') THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (
        v_user, 'system', 'New payment dispute',
        format('A customer disputed %s %s. Submit evidence before %s.',
          to_char(COALESCE((d ->> 'amount_cents')::numeric, 0) / 100, 'FM999,999,990.00'),
          upper(COALESCE(d ->> 'currency', 'usd')),
          COALESCE(to_char(to_timestamp(NULLIF(d ->> 'evidence_due_by', '')::double precision) AT TIME ZONE 'UTC', 'Mon DD, YYYY HH24:MI "UTC"'), 'the deadline')),
        '/dashboard/disputes?d=' || v_dispute_id::text
      );
    END IF;
  ELSIF v_closed AND v_status IN ('won', 'lost') THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (v_user, 'system',
      CASE WHEN v_status = 'won' THEN 'Dispute won' ELSE 'Dispute lost' END,
      CASE WHEN v_status = 'won' THEN 'The bank ruled in your favor. The funds are returned to your balance.'
           ELSE 'The bank ruled against you. The disputed amount stays withdrawn.' END,
      '/dashboard/disputes?d=' || v_dispute_id::text);
  END IF;

  RETURN jsonb_build_object('matched', true, 'duplicate', false, 'dispute_id', v_dispute_id, 'created', v_inserted);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_stripe_dispute_event(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_stripe_dispute_event(jsonb) TO service_role;

-- =============================================================
-- STAFF RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.save_dispute_evidence_draft(p_dispute_id uuid, p_draft jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_allowed text[] := ARRAY['product_description', 'customer_name', 'customer_email_address', 'billing_address',
    'service_date', 'uncategorized_text', 'cancellation_rebuttal', 'refund_refusal_explanation',
    'duplicate_charge_explanation', 'access_activity_log'];
  v_key text; v_val jsonb; v_total integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.can_access_disputes() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_draft IS NULL OR jsonb_typeof(p_draft) <> 'object' THEN
    RAISE EXCEPTION 'Invalid draft' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_val IN SELECT * FROM jsonb_each(p_draft) LOOP
    IF NOT (v_key = ANY (v_allowed)) OR jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') > 20000 THEN
      RAISE EXCEPTION 'Invalid evidence field: %', v_key USING ERRCODE = '22023';
    END IF;
    v_total := v_total + char_length(v_val #>> '{}');
  END LOOP;
  IF v_total > 150000 THEN
    RAISE EXCEPTION 'Evidence text exceeds the 150,000 character limit' USING ERRCODE = '22023';
  END IF;
  UPDATE stripe_disputes SET evidence_draft = p_draft, updated_at = now()
  WHERE id = p_dispute_id AND user_id = v_owner AND status IN ('needs_response', 'warning_needs_response');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispute not found or no longer accepting evidence' USING ERRCODE = 'P0002';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_dispute_evidence_draft(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_dispute_evidence_file(
  p_dispute_id uuid, p_category text, p_file_name text, p_storage_path text, p_mime_type text, p_size_bytes integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.can_access_disputes() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stripe_disputes WHERE id = p_dispute_id AND user_id = v_owner
                 AND status IN ('needs_response', 'warning_needs_response')) THEN
    RAISE EXCEPTION 'Dispute not found or no longer accepting evidence' USING ERRCODE = 'P0002';
  END IF;
  IF p_storage_path NOT LIKE v_owner::text || '/' || p_dispute_id::text || '/%' THEN
    RAISE EXCEPTION 'Invalid storage path' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM stripe_dispute_evidence_files WHERE dispute_id = p_dispute_id) >= 20 THEN
    RAISE EXCEPTION 'Maximum of 20 files per dispute' USING ERRCODE = '22023';
  END IF;
  IF COALESCE((SELECT sum(size_bytes) FROM stripe_dispute_evidence_files WHERE dispute_id = p_dispute_id), 0) + p_size_bytes > 4500000 THEN
    RAISE EXCEPTION 'Total evidence file size cannot exceed 4.5 MB' USING ERRCODE = '22023';
  END IF;
  INSERT INTO stripe_dispute_evidence_files (user_id, dispute_id, category, file_name, storage_path, mime_type, size_bytes)
  VALUES (v_owner, p_dispute_id, p_category, left(p_file_name, 200), p_storage_path, p_mime_type, p_size_bytes)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.register_dispute_evidence_file(uuid, text, text, text, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_dispute_evidence_file(p_file_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_path text;
BEGIN
  IF v_owner IS NULL OR NOT public.can_access_disputes() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  DELETE FROM stripe_dispute_evidence_files f
  USING stripe_disputes d
  WHERE f.id = p_file_id AND f.user_id = v_owner AND d.id = f.dispute_id
    AND d.status IN ('needs_response', 'warning_needs_response')
  RETURNING f.storage_path INTO v_path;
  RETURN v_path;  -- caller then deletes the storage object
END;
$$;
GRANT EXECUTE ON FUNCTION public.remove_dispute_evidence_file(uuid) TO authenticated;

-- =============================================================
-- STATS  (win rate = won / (won + lost); warning_closed inquiries are excluded)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_dispute_stats(p_days integer DEFAULT 365)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_since timestamptz;
  v_paid integer;
  v_res jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.can_access_disputes() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  p_days := LEAST(GREATEST(COALESCE(p_days, 365), 30), 1095);
  v_since := now() - make_interval(days => p_days);

  SELECT count(*) INTO v_paid FROM payment_requests
  WHERE user_id = v_owner AND status = 'paid' AND COALESCE(paid_at, created_at) >= v_since;

  SELECT jsonb_build_object(
    'window_days', p_days,
    'total', count(*),
    'needs_response', count(*) FILTER (WHERE status IN ('needs_response', 'warning_needs_response')),
    'under_review', count(*) FILTER (WHERE status IN ('under_review', 'warning_under_review')),
    'won', count(*) FILTER (WHERE status = 'won'),
    'lost', count(*) FILTER (WHERE status = 'lost'),
    'lost_unanswered', count(*) FILTER (WHERE status = 'lost' AND submission_count = 0),
    'win_rate', CASE WHEN count(*) FILTER (WHERE status IN ('won', 'lost')) = 0 THEN NULL
      ELSE round(100.0 * count(*) FILTER (WHERE status = 'won') / count(*) FILTER (WHERE status IN ('won', 'lost')), 1) END,
    'at_stake_cents', COALESCE(sum(amount_cents) FILTER (WHERE status IN ('needs_response', 'under_review')), 0),
    'won_cents', COALESCE(sum(amount_cents) FILTER (WHERE status = 'won'), 0),
    'lost_cents', COALESCE(sum(amount_cents) FILTER (WHERE status = 'lost'), 0),
    'due_soon', count(*) FILTER (WHERE status IN ('needs_response', 'warning_needs_response')
                                   AND evidence_due_by > now() AND evidence_due_by <= now() + interval '72 hours'),
    'overdue', count(*) FILTER (WHERE status IN ('needs_response', 'warning_needs_response') AND evidence_due_by <= now()),
    'paid_payments', v_paid,
    'dispute_rate_pct', CASE WHEN v_paid = 0 THEN NULL ELSE round(100.0 * count(*) / v_paid, 2) END
  ) INTO v_res
  FROM stripe_disputes WHERE user_id = v_owner AND opened_at >= v_since;

  RETURN v_res || jsonb_build_object(
    'by_reason', COALESCE((
      SELECT jsonb_agg(r ORDER BY r.total DESC) FROM (
        SELECT COALESCE(reason, 'general') AS reason, count(*)::int AS total,
               count(*) FILTER (WHERE status = 'won')::int AS won,
               count(*) FILTER (WHERE status = 'lost')::int AS lost,
               CASE WHEN count(*) FILTER (WHERE status IN ('won', 'lost')) = 0 THEN NULL
                    ELSE round(100.0 * count(*) FILTER (WHERE status = 'won') / count(*) FILTER (WHERE status IN ('won', 'lost')), 1) END AS win_rate
        FROM stripe_disputes WHERE user_id = v_owner AND opened_at >= v_since GROUP BY 1
      ) r), '[]'::jsonb),
    'monthly', COALESCE((
      SELECT jsonb_agg(m ORDER BY m.month) FROM (
        SELECT to_char(g, 'YYYY-MM') AS month,
               count(d.id)::int AS opened,
               count(d.id) FILTER (WHERE d.status = 'won')::int AS won,
               count(d.id) FILTER (WHERE d.status = 'lost')::int AS lost
        FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') g
        LEFT JOIN stripe_disputes d ON d.user_id = v_owner AND date_trunc('month', d.opened_at) = g
        GROUP BY g
      ) m), '[]'::jsonb)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_dispute_stats(integer) TO authenticated;

-- =============================================================
-- DEADLINE REMINDERS (once per dispute, 72h before the evidence deadline)
-- =============================================================
CREATE OR REPLACE FUNCTION public.notify_dispute_deadlines()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  WITH due AS (
    UPDATE stripe_disputes SET deadline_notified_at = now()
    WHERE status IN ('needs_response', 'warning_needs_response')
      AND deadline_notified_at IS NULL AND submission_count = 0
      AND evidence_due_by > now() AND evidence_due_by <= now() + interval '72 hours'
    RETURNING id, user_id, evidence_due_by
  ), ins AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT user_id, 'system', 'Dispute evidence due soon',
           'You have less than 72 hours to submit evidence. Missing the deadline means an automatic loss.',
           '/dashboard/disputes?d=' || id::text
    FROM due RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_dispute_deadlines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_dispute_deadlines() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-dispute-deadline-reminders', '17 * * * *', 'select public.notify_dispute_deadlines()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
