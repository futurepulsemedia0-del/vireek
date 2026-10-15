/*
  # Post-job NPS / CSAT surveys + low-score service recovery

  ## What this adds (all additive — no existing table, column, policy or trigger is touched)
  - survey_templates       : the survey builder (NPS 0-10 or CSAT 1-5, channel, auto-send, threshold)
  - survey_invitations     : one row per survey sent to a customer for a job. Doubles as the response
                             record (score/comment/responded_at) so analytics need a single table.
  - survey_recovery_cases  : opened automatically when a response is at/below the template's low-score
                             threshold. Staff work the case: open -> contacted -> resolved | dismissed.
  - get_survey_for_response(token) / submit_survey_response(token, score, comment)
                           : the ONLY anon-facing surface (public /s/:token page). SECURITY DEFINER,
                             token-gated, single-use, validated server-side.

  ## Security model
  - Every table is scoped with public.get_account_owner_id() (team members see the owner's data).
  - Reading responses/cases and editing templates requires public.identity_is_manager()
    (owner/admin or can_view_billing) — the same bar as Coaching Reports / Customer Intelligence.
  - Authenticated clients can NOT insert/update/delete invitations. Only the survey-dispatcher edge
    function (service role) and submit_survey_response() write them, so a client cannot fabricate
    a score. Recovery cases can only have status/resolution_note changed by staff (column grants).

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, jobs (completed_at),
  customers, team_members, notifications, calls not required.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy survey-dispatcher --no-verify-jwt
    3. supabase secrets set CRON_SECRET=<same value your other cron functions use>   (SITE_URL must already be set)
    4. Point your cron at survey-dispatcher every 10 minutes with header X-Cron-Secret.
*/

-- =============================================================
-- Shared helper: updated_at
-- =============================================================
CREATE OR REPLACE FUNCTION public.survey_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 1. survey_templates
-- =============================================================
CREATE TABLE IF NOT EXISTS survey_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  survey_type text NOT NULL CHECK (survey_type IN ('nps', 'csat')),
  question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 5 AND 300),
  follow_up_question text CHECK (follow_up_question IS NULL OR char_length(follow_up_question) <= 300),
  thank_you_message text NOT NULL DEFAULT 'Thank you — your feedback helps us serve you better.'
    CHECK (char_length(thank_you_message) BETWEEN 1 AND 500),
  channel text NOT NULL DEFAULT 'both' CHECK (channel IN ('sms', 'email', 'both')),
  sms_body text NOT NULL DEFAULT 'Hi {{customer_first_name}}, thanks for choosing {{business_name}}! How did we do? It takes 10 seconds: {{link}}'
    CHECK (char_length(sms_body) BETWEEN 10 AND 320 AND position('{{link}}' IN sms_body) > 0),
  email_subject text NOT NULL DEFAULT 'How did we do, {{customer_first_name}}?'
    CHECK (char_length(btrim(email_subject)) BETWEEN 1 AND 150),
  auto_send boolean NOT NULL DEFAULT false,
  auto_send_enabled_at timestamptz,
  send_delay_minutes integer NOT NULL DEFAULT 120 CHECK (send_delay_minutes BETWEEN 0 AND 10080),
  cooldown_days integer NOT NULL DEFAULT 30 CHECK (cooldown_days BETWEEN 0 AND 365),
  timezone text NOT NULL DEFAULT 'America/New_York' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  low_score_threshold smallint NOT NULL DEFAULT 6,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- NPS detractors are 0-6 (allow 0-8 so a business can be stricter); CSAT "dissatisfied" is 1-2 (allow 1-4).
  CONSTRAINT survey_templates_threshold_valid CHECK (
    (survey_type = 'nps' AND low_score_threshold BETWEEN 0 AND 8)
    OR (survey_type = 'csat' AND low_score_threshold BETWEEN 1 AND 4)
  )
);

-- At most one live auto-send template per type per account, so a customer is never double-surveyed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_templates_one_auto_per_type
  ON survey_templates (user_id, survey_type)
  WHERE auto_send AND is_active;
CREATE INDEX IF NOT EXISTS idx_survey_templates_user ON survey_templates (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_templates_auto ON survey_templates (auto_send, is_active) WHERE auto_send AND is_active;

-- Remember WHEN auto-send was switched on so enabling it never blasts the customer's job history.
CREATE OR REPLACE FUNCTION public.survey_templates_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.auto_send AND NEW.is_active
     AND (TG_OP = 'INSERT' OR NOT OLD.auto_send OR NOT OLD.is_active OR NEW.auto_send_enabled_at IS NULL) THEN
    NEW.auto_send_enabled_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_survey_templates_before_write ON survey_templates;
CREATE TRIGGER trg_survey_templates_before_write
  BEFORE INSERT OR UPDATE ON survey_templates
  FOR EACH ROW EXECUTE FUNCTION public.survey_templates_before_write();

ALTER TABLE survey_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "survey_templates_select" ON survey_templates;
CREATE POLICY "survey_templates_select" ON survey_templates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "survey_templates_insert" ON survey_templates;
CREATE POLICY "survey_templates_insert" ON survey_templates FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "survey_templates_update" ON survey_templates;
CREATE POLICY "survey_templates_update" ON survey_templates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "survey_templates_delete" ON survey_templates;
CREATE POLICY "survey_templates_delete" ON survey_templates FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

REVOKE ALL ON survey_templates FROM anon;

-- =============================================================
-- 2. survey_invitations (invitation + response in one row)
-- =============================================================
CREATE TABLE IF NOT EXISTS survey_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  template_id uuid REFERENCES survey_templates(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,

  -- Snapshots: a survey stays exactly as the customer saw it even if the template is edited/deleted later.
  template_name text NOT NULL,
  survey_type text NOT NULL CHECK (survey_type IN ('nps', 'csat')),
  question text NOT NULL,
  follow_up_question text,
  thank_you_message text NOT NULL,
  low_score_threshold smallint NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'both')),
  sms_body text NOT NULL,
  email_subject text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',

  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  service_type text,

  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  trigger_source text NOT NULL DEFAULT 'auto' CHECK (trigger_source IN ('auto', 'manual')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'responded')),
  send_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  channel_used text,
  attempts smallint NOT NULL DEFAULT 0,
  delivery_error text,

  score smallint CHECK (score IS NULL OR score BETWEEN 0 AND 10),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 2000),
  responded_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT survey_invitations_score_range CHECK (
    score IS NULL
    OR (survey_type = 'nps' AND score BETWEEN 0 AND 10)
    OR (survey_type = 'csat' AND score BETWEEN 1 AND 5)
  ),
  CONSTRAINT survey_invitations_responded_consistent CHECK (
    (status = 'responded') = (score IS NOT NULL AND responded_at IS NOT NULL)
  )
);

-- One survey per job per template (idempotent enqueue). NULLs never conflict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_invitations_template_job
  ON survey_invitations (template_id, job_id);
CREATE INDEX IF NOT EXISTS idx_survey_invitations_user_created ON survey_invitations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_invitations_user_responded
  ON survey_invitations (user_id, responded_at DESC) WHERE status = 'responded';
CREATE INDEX IF NOT EXISTS idx_survey_invitations_pending ON survey_invitations (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_survey_invitations_sending ON survey_invitations (claimed_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS idx_survey_invitations_job ON survey_invitations (job_id);

ALTER TABLE survey_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "survey_invitations_select" ON survey_invitations;
CREATE POLICY "survey_invitations_select" ON survey_invitations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

-- No INSERT/UPDATE/DELETE policy and no grant: service role + submit_survey_response() only.
REVOKE ALL ON survey_invitations FROM anon, authenticated;
GRANT SELECT ON survey_invitations TO authenticated;

-- =============================================================
-- 3. survey_recovery_cases
-- =============================================================
CREATE TABLE IF NOT EXISTS survey_recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL UNIQUE REFERENCES survey_invitations(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  survey_type text NOT NULL CHECK (survey_type IN ('nps', 'csat')),
  score smallint NOT NULL,
  comment text,
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  severity text NOT NULL CHECK (severity IN ('high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contacted', 'resolved', 'dismissed')),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000),
  contacted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_cases_user_status ON survey_recovery_cases (user_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.survey_cases_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'contacted' AND NEW.contacted_at IS NULL THEN NEW.contacted_at := now(); END IF;
    IF NEW.status IN ('resolved', 'dismissed') THEN
      NEW.resolved_at := now();
      IF NEW.contacted_at IS NULL AND NEW.status = 'resolved' THEN NEW.contacted_at := now(); END IF;
    ELSE
      NEW.resolved_at := NULL;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_survey_cases_before_update ON survey_recovery_cases;
CREATE TRIGGER trg_survey_cases_before_update
  BEFORE UPDATE ON survey_recovery_cases
  FOR EACH ROW EXECUTE FUNCTION public.survey_cases_before_update();

ALTER TABLE survey_recovery_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "survey_cases_select" ON survey_recovery_cases;
CREATE POLICY "survey_cases_select" ON survey_recovery_cases FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "survey_cases_update" ON survey_recovery_cases;
CREATE POLICY "survey_cases_update" ON survey_recovery_cases FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

REVOKE ALL ON survey_recovery_cases FROM anon, authenticated;
GRANT SELECT ON survey_recovery_cases TO authenticated;
GRANT UPDATE (status, resolution_note) ON survey_recovery_cases TO authenticated;

-- =============================================================
-- 4. Public (anon) surface: read a survey by token, submit once
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_survey_for_response(p_token uuid)
RETURNS TABLE (
  survey_type text,
  question text,
  follow_up_question text,
  thank_you_message text,
  business_name text,
  customer_first_name text,
  already_responded boolean,
  expired boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    i.survey_type,
    i.question,
    i.follow_up_question,
    i.thank_you_message,
    p.company_name,
    split_part(btrim(i.customer_name), ' ', 1),
    (i.status = 'responded'),
    (i.status <> 'responded' AND i.sent_at < now() - interval '30 days')
  FROM survey_invitations i
  JOIN profiles p ON p.id = i.user_id
  WHERE i.token = p_token
    AND i.status IN ('sent', 'responded');
$$;

CREATE OR REPLACE FUNCTION public.submit_survey_response(p_token uuid, p_score integer, p_comment text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv survey_invitations%ROWTYPE;
  clean_comment text;
  is_low boolean;
  sev text;
  new_case_id uuid;
BEGIN
  SELECT * INTO inv FROM survey_invitations WHERE token = p_token AND status IN ('sent', 'responded') FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF inv.status = 'responded' THEN RETURN 'already_responded'; END IF;
  IF inv.sent_at < now() - interval '30 days' THEN RETURN 'expired'; END IF;

  IF p_score IS NULL
     OR (inv.survey_type = 'nps' AND p_score NOT BETWEEN 0 AND 10)
     OR (inv.survey_type = 'csat' AND p_score NOT BETWEEN 1 AND 5) THEN
    RETURN 'invalid_score';
  END IF;

  clean_comment := NULLIF(left(btrim(coalesce(p_comment, '')), 2000), '');

  UPDATE survey_invitations
     SET status = 'responded', score = p_score, comment = clean_comment, responded_at = now()
   WHERE id = inv.id;

  is_low := p_score <= inv.low_score_threshold;
  IF is_low THEN
    sev := CASE
      WHEN inv.survey_type = 'nps' AND p_score <= 3 THEN 'critical'
      WHEN inv.survey_type = 'csat' AND p_score = 1 THEN 'critical'
      ELSE 'high'
    END;

    INSERT INTO survey_recovery_cases
      (user_id, invitation_id, job_id, survey_type, score, comment,
       customer_name, customer_phone, customer_email, severity)
    VALUES
      (inv.user_id, inv.id, inv.job_id, inv.survey_type, p_score, clean_comment,
       inv.customer_name, inv.customer_phone, inv.customer_email, sev)
    ON CONFLICT (invitation_id) DO NOTHING
    RETURNING id INTO new_case_id;

    IF new_case_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (
        inv.user_id,
        'survey_low_score',
        CASE WHEN sev = 'critical' THEN 'Unhappy customer — act now' ELSE 'Low survey score' END,
        inv.customer_name || ' rated ' || p_score || (CASE WHEN inv.survey_type = 'nps' THEN '/10' ELSE '/5' END)
          || (CASE WHEN clean_comment IS NOT NULL THEN ': "' || left(clean_comment, 140) || '"' ELSE '.' END),
        '/dashboard/surveys?tab=recovery'
      );
    END IF;
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.get_survey_for_response(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_survey_response(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_survey_for_response(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_survey_response(uuid, integer, text) TO anon, authenticated;

-- =============================================================
-- 5. Realtime (RLS still applies to what each subscriber receives)
-- =============================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE survey_invitations;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE survey_recovery_cases;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
