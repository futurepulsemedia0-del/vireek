/*
  # Quote detail workspace — /dashboard/quotes/:id

  ## Why
  The detail page needs three things the schema does not have yet:
    1. VERSION HISTORY  — every material edit to a quote is snapshotted so two
       versions can be diffed. Written by a trigger on `quotes`, so EVERY save
       path (builder, tiered builder, anything added later) is covered without
       touching application code.
    2. FOLLOW-UP SCHEDULE — a dated, per-quote task list (sms / call / email /
       visit) that stops itself the moment the quote is accepted, declined or
       expired.
    3. CONVERT TO JOB — one atomic, idempotent, permission-checked function.

  ## Additive only
  No existing table is altered, no existing policy / constraint / function is
  touched. New: 2 tables, 2 triggers on `quotes`, 5 functions.

  ## Security
  - New tables: RLS on, SELECT only, scoped to get_account_owner_id() AND the
    can_view_billing permission. No client INSERT/UPDATE/DELETE policy at all —
    rows are written only by the SECURITY DEFINER functions below.
  - Every RPC re-checks: authenticated, can_view_billing (owner always passes;
    team members honour custom-role overrides exactly like AuthContext), and
    that the quote belongs to the caller's account.
  - EXECUTE is revoked from PUBLIC/anon and granted to `authenticated` only.
*/

-- =============================================================
-- 0. PERMISSION HELPER (mirrors AuthContext: custom role overrides base)
-- =============================================================

CREATE OR REPLACE FUNCTION public.quote_workspace_caller_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner') THEN true
    ELSE COALESCE((
      SELECT COALESCE(
        (cr.permissions ->> 'can_view_billing')::boolean,
        (tm.permissions ->> 'can_view_billing')::boolean,
        false
      )
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
      LIMIT 1
    ), false)
  END;
$$;

REVOKE ALL ON FUNCTION public.quote_workspace_caller_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_workspace_caller_can_view() TO authenticated;

-- =============================================================
-- 1. QUOTE VERSIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  snapshot jsonb NOT NULL,
  total_cents bigint NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_quote_versions_quote ON quote_versions(quote_id, version_number DESC);

ALTER TABLE quote_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_quote_versions" ON quote_versions;
CREATE POLICY "select_account_quote_versions" ON quote_versions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

-- The tracked, customer-visible content of a quote. Anything NOT listed here
-- (status, view counters, tokens, timestamps) never creates a version.
CREATE OR REPLACE FUNCTION public.quote_snapshot(p_quote quotes)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'customer_name', p_quote.customer_name,
    'customer_phone', p_quote.customer_phone,
    'customer_email', p_quote.customer_email,
    'line_items', COALESCE(p_quote.line_items, '[]'::jsonb),
    'options', COALESCE(p_quote.options, '[]'::jsonb),
    'recommended_option_id', p_quote.recommended_option_id,
    'tax_percent', COALESCE(p_quote.tax_percent, 0),
    'deposit_percent', COALESCE(p_quote.deposit_percent, 0),
    'valid_until', p_quote.valid_until,
    'presentation_note', p_quote.presentation_note
  );
$$;

-- Headline price: recommended option for tiered quotes, else the flat total.
CREATE OR REPLACE FUNCTION public.quote_headline_total_cents(p_quote quotes)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_rec text;
  v_sub bigint;
BEGIN
  IF jsonb_typeof(p_quote.options) = 'array' AND jsonb_array_length(p_quote.options) > 0 THEN
    v_rec := COALESCE(
      p_quote.recommended_option_id,
      (SELECT o ->> 'id' FROM jsonb_array_elements(p_quote.options) AS o
        WHERE (o ->> 'recommended') = 'true' LIMIT 1)
    );
    RETURN COALESCE(
      public.quote_option_total_cents(p_quote.options, v_rec, p_quote.tax_percent),
      public.quote_option_total_cents(p_quote.options, p_quote.options -> 0 ->> 'id', p_quote.tax_percent),
      0
    );
  END IF;

  v_sub := public.quote_line_items_subtotal_cents(p_quote.line_items);
  RETURN v_sub + round(v_sub * COALESCE(p_quote.tax_percent, 0) / 100.0);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quote_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snap jsonb;
  v_last jsonb;
  v_last_no integer;
BEGIN
  v_snap := public.quote_snapshot(NEW);

  SELECT snapshot, version_number INTO v_last, v_last_no
  FROM quote_versions
  WHERE quote_id = NEW.id
  ORDER BY version_number DESC
  LIMIT 1;

  -- Saved without changing anything customer-visible: no new version.
  IF v_last IS NOT NULL AND v_last = v_snap THEN
    RETURN NEW;
  END IF;

  INSERT INTO quote_versions (quote_id, user_id, version_number, snapshot, total_cents, created_by)
  VALUES (NEW.id, NEW.user_id, COALESCE(v_last_no, 0) + 1, v_snap, public.quote_headline_total_cents(NEW), auth.uid());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotes_record_version_ins ON quotes;
CREATE TRIGGER trg_quotes_record_version_ins
  AFTER INSERT ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.record_quote_version();

DROP TRIGGER IF EXISTS trg_quotes_record_version_upd ON quotes;
CREATE TRIGGER trg_quotes_record_version_upd
  AFTER UPDATE OF customer_name, customer_phone, customer_email, line_items, options,
                  recommended_option_id, tax_percent, deposit_percent, valid_until, presentation_note
  ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.record_quote_version();

-- Baseline: every existing quote gets version 1 = its state right now.
INSERT INTO quote_versions (quote_id, user_id, version_number, snapshot, total_cents, created_at)
SELECT q.id, q.user_id, 1, public.quote_snapshot(q), public.quote_headline_total_cents(q), q.created_at
FROM quotes q
WHERE NOT EXISTS (SELECT 1 FROM quote_versions v WHERE v.quote_id = q.id)
ON CONFLICT (quote_id, version_number) DO NOTHING;

-- =============================================================
-- 2. FOLLOW-UP SCHEDULE
-- =============================================================

CREATE TABLE IF NOT EXISTS quote_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  step_number integer NOT NULL CHECK (step_number >= 1),
  channel text NOT NULL CHECK (channel IN ('call', 'sms', 'email', 'visit')),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'cancelled')),
  suggested_message text,
  outcome text,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_quote_followups_quote ON quote_followups(quote_id, step_number);
CREATE INDEX IF NOT EXISTS idx_quote_followups_due ON quote_followups(user_id, status, due_at);

ALTER TABLE quote_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_quote_followups" ON quote_followups;
CREATE POLICY "select_account_quote_followups" ON quote_followups
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

-- A closed quote must never keep nagging the team.
CREATE OR REPLACE FUNCTION public.cancel_quote_followups_on_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE quote_followups
  SET status = 'cancelled'
  WHERE quote_id = NEW.id AND status = 'pending';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotes_cancel_followups ON quotes;
CREATE TRIGGER trg_quotes_cancel_followups
  AFTER UPDATE OF status ON quotes
  FOR EACH ROW
  WHEN (NEW.status IN ('accepted', 'declined', 'expired') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.cancel_quote_followups_on_close();

-- =============================================================
-- 3. RPCs
-- =============================================================

-- One round trip for the whole page. NULL = not found in this account.
CREATE OR REPLACE FUNCTION public.get_quote_workspace(p_quote_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_quote quotes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'quote', to_jsonb(v_quote) - 'ai_report',
    'versions', COALESCE((
      SELECT jsonb_agg(to_jsonb(v) - 'created_by' ORDER BY v.version_number DESC)
      FROM quote_versions v WHERE v.quote_id = v_quote.id
    ), '[]'::jsonb),
    'events', COALESCE((
      SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC)
      FROM (SELECT * FROM quote_events WHERE quote_id = v_quote.id ORDER BY created_at DESC LIMIT 100) e
    ), '[]'::jsonb),
    'followups', COALESCE((
      SELECT jsonb_agg(to_jsonb(f) - 'completed_by' ORDER BY f.step_number)
      FROM quote_followups f WHERE f.quote_id = v_quote.id
    ), '[]'::jsonb),
    'job', (
      SELECT to_jsonb(j)
      FROM (
        SELECT id, job_status, scheduled_datetime, created_at
        FROM jobs WHERE quote_id = v_quote.id AND user_id = v_owner
        ORDER BY created_at ASC LIMIT 1
      ) j
    ),
    'lead', (
      SELECT to_jsonb(l)
      FROM (
        SELECT id, stage, follow_up_count, last_follow_up_at
        FROM leads WHERE id = v_quote.lead_id AND user_id = v_owner
      ) l
    )
  );
END;
$$;

-- Replaces the PENDING steps with a new plan. p_steps:
--   [{ "channel": "sms"|"call"|"email"|"visit", "due_at": ISO, "message": text }, ...]  (1..8 items)
CREATE OR REPLACE FUNCTION public.schedule_quote_followups(p_quote_id uuid, p_steps jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_quote quotes%ROWTYPE;
  v_base integer;
  v_count integer;
  v_step jsonb;
  v_ord integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_quote.status <> 'sent' THEN
    RAISE EXCEPTION 'quote_not_sent' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'invalid_plan' USING ERRCODE = 'P0001';
  END IF;
  v_count := jsonb_array_length(p_steps);
  IF v_count < 1 OR v_count > 8 THEN
    RAISE EXCEPTION 'invalid_plan' USING ERRCODE = 'P0001';
  END IF;

  FOR v_step IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
    IF (v_step ->> 'channel') IS NULL OR (v_step ->> 'channel') NOT IN ('call', 'sms', 'email', 'visit')
       OR (v_step ->> 'due_at') IS NULL THEN
      RAISE EXCEPTION 'invalid_plan' USING ERRCODE = 'P0001';
    END IF;
    PERFORM (v_step ->> 'due_at')::timestamptz;
  END LOOP;

  UPDATE quote_followups SET status = 'cancelled' WHERE quote_id = v_quote.id AND status = 'pending';

  SELECT COALESCE(MAX(step_number), 0) INTO v_base FROM quote_followups WHERE quote_id = v_quote.id;

  FOR v_step, v_ord IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(p_steps) WITH ORDINALITY
  LOOP
    INSERT INTO quote_followups (quote_id, user_id, step_number, channel, due_at, suggested_message)
    VALUES (
      v_quote.id,
      v_owner,
      v_base + v_ord,
      v_step ->> 'channel',
      (v_step ->> 'due_at')::timestamptz,
      NULLIF(left(btrim(COALESCE(v_step ->> 'message', '')), 500), '')
    );
  END LOOP;

  RETURN v_count;
END;
$$;

-- Marks a step done/skipped. A "done" also feeds the existing lead tracker
-- (leads.follow_up_count / last_follow_up_at) so the Quotes list stays truthful.
CREATE OR REPLACE FUNCTION public.complete_quote_followup(
  p_followup_id uuid,
  p_status text,
  p_outcome text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_f quote_followups%ROWTYPE;
  v_lead uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('done', 'skipped') THEN
    RETURN false;
  END IF;

  SELECT * INTO v_f FROM quote_followups WHERE id = p_followup_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_f.status <> 'pending' THEN
    RETURN false;
  END IF;

  UPDATE quote_followups
  SET status = p_status,
      outcome = NULLIF(left(btrim(COALESCE(p_outcome, '')), 500), ''),
      completed_at = now(),
      completed_by = auth.uid()
  WHERE id = v_f.id;

  IF p_status = 'done' THEN
    SELECT lead_id INTO v_lead FROM quotes WHERE id = v_f.quote_id AND user_id = v_owner;
    IF v_lead IS NOT NULL THEN
      UPDATE leads
      SET follow_up_count = COALESCE(follow_up_count, 0) + 1,
          last_follow_up_at = now()
      WHERE id = v_lead AND user_id = v_owner;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- Accepted quote -> scheduled job. Idempotent: calling twice (double click,
-- two teammates) returns the SAME job id and never creates a second job.
CREATE OR REPLACE FUNCTION public.convert_quote_to_job(
  p_quote_id uuid,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_address text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_quote quotes%ROWTYPE;
  v_job_id uuid;
  v_service text;
  v_scope text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.quote_workspace_caller_can_view() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('convert_quote_to_job:' || p_quote_id::text));

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_quote.status <> 'accepted' THEN
    RAISE EXCEPTION 'quote_not_accepted' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_job_id FROM jobs WHERE quote_id = v_quote.id AND user_id = v_owner ORDER BY created_at ASC LIMIT 1;
  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  -- Service type + scope come from the option the customer actually chose.
  IF v_quote.selected_option_id IS NOT NULL AND jsonb_typeof(v_quote.options) = 'array' THEN
    SELECT o ->> 'name',
           (SELECT string_agg(li ->> 'description', '; ')
              FROM jsonb_array_elements(COALESCE(o -> 'line_items', '[]'::jsonb)) li)
    INTO v_service, v_scope
    FROM jsonb_array_elements(v_quote.options) o
    WHERE o ->> 'id' = v_quote.selected_option_id
    LIMIT 1;
  END IF;

  IF v_service IS NULL OR btrim(v_service) = '' THEN
    v_service := v_quote.line_items -> 0 ->> 'description';
  END IF;
  IF v_scope IS NULL OR btrim(v_scope) = '' THEN
    SELECT string_agg(li ->> 'description', '; ') INTO v_scope
    FROM jsonb_array_elements(COALESCE(v_quote.line_items, '[]'::jsonb)) li;
  END IF;

  INSERT INTO jobs (
    user_id, lead_id, customer_name, customer_phone, service_type, address,
    scheduled_datetime, job_status, invoice_status, quote_id, dispatch_note
  )
  VALUES (
    v_owner,
    v_quote.lead_id,
    v_quote.customer_name,
    v_quote.customer_phone,
    NULLIF(left(btrim(COALESCE(v_service, '')), 120), ''),
    NULLIF(left(btrim(COALESCE(p_address, '')), 300), ''),
    p_scheduled_at,
    'scheduled',
    'not_sent',
    v_quote.id,
    NULLIF(left('From accepted quote. Scope: ' || COALESCE(v_scope, ''), 500), 'From accepted quote. Scope: ')
  )
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_quote_workspace(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.schedule_quote_followups(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_quote_followup(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.convert_quote_to_job(uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_quote_workspace(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_quote_followups(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_quote_followup(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_quote_to_job(uuid, timestamptz, text) TO authenticated;
