/*
  # Automatic post-job summaries ("what we did")

  ## What this adds (purely additive — no existing table, column, policy or trigger is touched)
  - job_summary_settings : per-account switches (auto-generate, auto-send + review window, channel,
                           which sections to include, labor/parts warranty text, custom tips, SMS/email copy)
  - job_summaries        : ONE row per completed job. Holds the customer-facing content (editable by staff),
                           the delivery state per channel (SMS / email) and portal visibility.
  - get_portal_job_summaries(token) : read-only list for the customer portal (token + portal opt-in gated)

  ## Security model
  - Every table is scoped with public.get_account_owner_id() (team members see the owner's rows).
  - Settings: owner/admin/"View Billing" only (public.identity_is_manager(), same bar as Surveys).
  - Summaries: read + edit needs public.can_manage_job_summaries() (owner, or team member with
    "can_view_all_jobs"). Authenticated clients can NOT insert/delete rows and can NOT touch status,
    delivery or token columns (column-level grants). Only the job-summary-engine edge function
    (service role) generates and sends — so a client can never fake "sent" or hijack the public link.
  - A trigger verifies every photo reference belongs to THIS job in THIS account, so staff can never
    expose another tenant's file through the public summary page.
  - The public page reads ONLY through the job-summary-public edge function (unguessable token,
    short-lived signed photo URLs). Nothing is opened to the anon role on these tables.

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, jobs, customers,
  team_members, custom_roles, job_photos, business_profile.allow_customer_portal.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy job-summary-engine --no-verify-jwt
       supabase functions deploy job-summary-public --no-verify-jwt
    3. supabase secrets set CRON_SECRET=<same value your other cron functions use>   (SITE_URL must already be set)
    4. Point your cron at job-summary-engine every 5 minutes with header X-Cron-Secret.
*/

-- =============================================================
-- Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_job_summaries()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM team_members t
      LEFT JOIN custom_roles cr ON cr.id = t.custom_role_id
      WHERE t.user_id = auth.uid()
        AND COALESCE(
              (cr.permissions ->> 'can_view_all_jobs')::boolean,
              (t.permissions ->> 'can_view_all_jobs')::boolean,
              false
            )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_job_summaries() TO authenticated;

CREATE OR REPLACE FUNCTION public.job_summary_texts_ok(p_arr text[], p_max_items integer, p_max_len integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_arr IS NOT NULL
    AND COALESCE(cardinality(p_arr), 0) <= p_max_items
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_arr) AS t
      WHERE t IS NULL OR char_length(btrim(t)) = 0 OR char_length(t) > p_max_len
    );
$$;

-- =============================================================
-- 1. job_summary_settings (one row per account)
-- =============================================================
CREATE TABLE IF NOT EXISTS job_summary_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  auto_generate boolean NOT NULL DEFAULT false,
  auto_generate_enabled_at timestamptz,
  auto_send boolean NOT NULL DEFAULT false,
  review_window_minutes integer NOT NULL DEFAULT 60 CHECK (review_window_minutes BETWEEN 0 AND 2880),
  channel text NOT NULL DEFAULT 'both' CHECK (channel IN ('sms', 'email', 'both')),
  ai_polish boolean NOT NULL DEFAULT true,
  include_photos boolean NOT NULL DEFAULT true,
  include_parts boolean NOT NULL DEFAULT true,
  include_warranty boolean NOT NULL DEFAULT true,
  include_tips boolean NOT NULL DEFAULT true,
  max_photos integer NOT NULL DEFAULT 6 CHECK (max_photos BETWEEN 0 AND 12),
  labor_warranty_days integer CHECK (labor_warranty_days IS NULL OR labor_warranty_days BETWEEN 1 AND 3650),
  parts_warranty_note text CHECK (parts_warranty_note IS NULL OR char_length(parts_warranty_note) <= 300),
  default_service_interval_months integer NOT NULL DEFAULT 12 CHECK (default_service_interval_months BETWEEN 1 AND 120),
  custom_tips text[] NOT NULL DEFAULT '{}' CHECK (public.job_summary_texts_ok(custom_tips, 6, 300)),
  sms_body text NOT NULL DEFAULT 'Hi {{customer_first_name}}, here is a summary of your recent visit from {{business_name}}: {{link}}'
    CHECK (char_length(sms_body) BETWEEN 10 AND 320 AND position('{{link}}' IN sms_body) > 0),
  email_subject text NOT NULL DEFAULT 'Your service summary from {{business_name}}'
    CHECK (char_length(btrim(email_subject)) BETWEEN 1 AND 150),
  timezone text NOT NULL DEFAULT 'America/New_York' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Remember WHEN auto-generate was switched on so enabling it never back-fills the job history.
CREATE OR REPLACE FUNCTION public.job_summary_settings_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.auto_generate THEN
    IF TG_OP = 'INSERT' THEN
      NEW.auto_generate_enabled_at := now();
    ELSIF NOT OLD.auto_generate OR NEW.auto_generate_enabled_at IS NULL THEN
      NEW.auto_generate_enabled_at := now();
    END IF;
  END IF;
  -- Auto-send is meaningless without auto-generate.
  IF NOT NEW.auto_generate THEN
    NEW.auto_send := false;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_summary_settings_before_write ON job_summary_settings;
CREATE TRIGGER trg_job_summary_settings_before_write
  BEFORE INSERT OR UPDATE ON job_summary_settings
  FOR EACH ROW EXECUTE FUNCTION public.job_summary_settings_before_write();

ALTER TABLE job_summary_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "job_summary_settings_select" ON job_summary_settings;
CREATE POLICY "job_summary_settings_select" ON job_summary_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "job_summary_settings_insert" ON job_summary_settings;
CREATE POLICY "job_summary_settings_insert" ON job_summary_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "job_summary_settings_update" ON job_summary_settings;
CREATE POLICY "job_summary_settings_update" ON job_summary_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

REVOKE ALL ON job_summary_settings FROM anon;

-- =============================================================
-- 2. job_summaries (one per job)
-- =============================================================
CREATE TABLE IF NOT EXISTS job_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- Unguessable public link: /summary/:token
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  -- ---- customer-facing content (staff-editable) ----
  headline text NOT NULL CHECK (char_length(btrim(headline)) BETWEEN 1 AND 140),
  intro text NOT NULL DEFAULT '' CHECK (char_length(intro) <= 600),
  work_summary text NOT NULL DEFAULT '' CHECK (char_length(work_summary) <= 3000),
  work_items text[] NOT NULL DEFAULT '{}' CHECK (public.job_summary_texts_ok(work_items, 12, 300)),
  parts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) <= 30),
  warranty jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warranty) = 'array' AND jsonb_array_length(warranty) <= 10),
  -- [{ bucket: 'job-photos'|'job-room-photos', path, kind: 'before'|'after'|'progress', caption? }]
  photos jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photos) = 'array' AND jsonb_array_length(photos) <= 12),
  maintenance_tips text[] NOT NULL DEFAULT '{}' CHECK (public.job_summary_texts_ok(maintenance_tips, 8, 300)),
  next_service_date date,
  next_service_note text CHECK (next_service_note IS NULL OR char_length(next_service_note) <= 300),

  -- ---- snapshots ----
  technician_first_name text CHECK (technician_first_name IS NULL OR char_length(technician_first_name) <= 60),
  service_type text CHECK (service_type IS NULL OR char_length(service_type) <= 80),
  service_date date,
  customer_name text NOT NULL DEFAULT 'Customer',
  warnings text[] NOT NULL DEFAULT '{}',
  ai_polished boolean NOT NULL DEFAULT false,
  trigger_source text NOT NULL DEFAULT 'manual' CHECK (trigger_source IN ('auto', 'manual')),

  -- ---- delivery (written only by the edge function) ----
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'skipped')),
  channel text NOT NULL DEFAULT 'both' CHECK (channel IN ('sms', 'email', 'both')),
  scheduled_send_at timestamptz,
  sms_state text NOT NULL DEFAULT 'pending' CHECK (sms_state IN ('pending', 'sent', 'failed', 'skipped')),
  email_state text NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending', 'sent', 'failed', 'skipped')),
  sent_at timestamptz,
  channel_used text,
  delivery_error text CHECK (delivery_error IS NULL OR char_length(delivery_error) <= 500),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,

  -- ---- engagement + audit ----
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  last_edited_at timestamptz,
  last_edited_by uuid,
  edited_after_send_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_summaries_user_status ON job_summaries (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_summaries_due ON job_summaries (scheduled_send_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_job_summaries_customer ON job_summaries (customer_id) WHERE customer_id IS NOT NULL;

-- Integrity: same account as the job, and every photo belongs to THIS job (see header).
CREATE OR REPLACE FUNCTION public.job_summaries_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_photo jsonb;
  v_bucket text;
  v_path text;
  v_ok boolean;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = NEW.job_id;
  IF v_job.id IS NULL OR v_job.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'JOB_SUMMARY_JOB_MISMATCH' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.photos IS NOT DISTINCT FROM OLD.photos THEN
      RETURN NEW;
    END IF;
  END IF;

  FOR v_photo IN SELECT * FROM jsonb_array_elements(NEW.photos) LOOP
    v_bucket := v_photo ->> 'bucket';
    v_path := v_photo ->> 'path';
    IF v_path IS NULL OR char_length(v_path) > 500
       OR COALESCE(v_photo ->> 'kind', '') NOT IN ('before', 'after', 'progress') THEN
      RAISE EXCEPTION 'JOB_SUMMARY_INVALID_PHOTO' USING ERRCODE = '22023';
    END IF;

    IF v_bucket = 'job-photos' THEN
      SELECT EXISTS (
        SELECT 1 FROM job_photos jp
        WHERE jp.storage_path = v_path AND jp.user_id = NEW.user_id AND jp.job_id = NEW.job_id
      ) INTO v_ok;
    ELSIF v_bucket = 'job-room-photos' THEN
      v_ok := (v_path = ANY (v_job.before_photos)) OR (v_path = ANY (v_job.after_photos));
    ELSE
      v_ok := false;
    END IF;

    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'JOB_SUMMARY_INVALID_PHOTO' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_summaries_guard ON job_summaries;
CREATE TRIGGER trg_job_summaries_guard
  BEFORE INSERT OR UPDATE ON job_summaries
  FOR EACH ROW EXECUTE FUNCTION public.job_summaries_guard();

-- Audit human edits (service-role writes have auth.uid() NULL and are not counted as edits).
CREATE OR REPLACE FUNCTION public.job_summaries_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF auth.uid() IS NOT NULL AND (
       NEW.headline IS DISTINCT FROM OLD.headline
    OR NEW.intro IS DISTINCT FROM OLD.intro
    OR NEW.work_summary IS DISTINCT FROM OLD.work_summary
    OR NEW.work_items IS DISTINCT FROM OLD.work_items
    OR NEW.parts IS DISTINCT FROM OLD.parts
    OR NEW.warranty IS DISTINCT FROM OLD.warranty
    OR NEW.photos IS DISTINCT FROM OLD.photos
    OR NEW.maintenance_tips IS DISTINCT FROM OLD.maintenance_tips
    OR NEW.next_service_date IS DISTINCT FROM OLD.next_service_date
    OR NEW.next_service_note IS DISTINCT FROM OLD.next_service_note
  ) THEN
    NEW.last_edited_at := now();
    NEW.last_edited_by := auth.uid();
    IF OLD.sent_at IS NOT NULL THEN
      NEW.edited_after_send_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_summaries_before_update ON job_summaries;
CREATE TRIGGER trg_job_summaries_before_update
  BEFORE UPDATE ON job_summaries
  FOR EACH ROW EXECUTE FUNCTION public.job_summaries_before_update();

ALTER TABLE job_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "job_summaries_select" ON job_summaries;
CREATE POLICY "job_summaries_select" ON job_summaries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_summaries());

-- Edits are blocked only while the row is mid-delivery ('sending').
DROP POLICY IF EXISTS "job_summaries_update" ON job_summaries;
CREATE POLICY "job_summaries_update" ON job_summaries FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_summaries() AND status <> 'sending')
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_job_summaries());

-- Column-level lock: clients may change customer-facing content + channel, nothing else.
REVOKE ALL ON job_summaries FROM anon, authenticated;
GRANT SELECT ON job_summaries TO authenticated;
GRANT UPDATE (
  headline, intro, work_summary, work_items, parts, warranty, photos,
  maintenance_tips, next_service_date, next_service_note, channel
) ON job_summaries TO authenticated;

-- Live updates for the review queue / job page.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'job_summaries'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.job_summaries;
  END IF;
END;
$$;

-- =============================================================
-- 3. Customer portal list (read-only; same gating as get_customer_portal_history)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_portal_job_summaries(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_enabled boolean;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(bp.allow_customer_portal, false) INTO v_enabled
  FROM business_profile bp WHERE bp.user_id = v_customer.user_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NULL;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(t.item ORDER BY t.sent_at DESC)
    FROM (
      SELECT
        s.sent_at,
        jsonb_build_object(
          'token', s.token,
          'headline', s.headline,
          'service_type', s.service_type,
          'service_date', s.service_date,
          'sent_at', s.sent_at,
          'first_item', s.work_items[1]
        ) AS item
      FROM job_summaries s
      JOIN jobs j ON j.id = s.job_id
      WHERE s.user_id = v_customer.user_id
        AND s.sent_at IS NOT NULL
        AND (j.customer_id = v_customer.id
             OR (v_customer.phone IS NOT NULL AND j.customer_phone = v_customer.phone))
      ORDER BY s.sent_at DESC
      LIMIT 50
    ) t
  ), '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_portal_job_summaries(uuid) TO anon, authenticated;
