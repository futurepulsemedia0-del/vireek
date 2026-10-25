/*
  # Talent Network

  Job board + vetted worker network for tradespeople, built on top of the existing
  tenant model. Reuses (read-only): profiles, team_members, employees, notifications,
  technician_credentials, get_account_owner_id().

  ## What it adds
  - Worker side  : talent_profiles, talent_credentials (licenses + certifications),
                   talent_references (confidential, token-gated referee response).
  - Business side: talent_postings (kind = job | gig/overflow), talent_applications,
                   talent_application_events (append-only audit), talent_credential_attestations.
  - Compliance   : talent_background_checks (provider-agnostic status only; NO report content),
                   FCRA-style decision gate, talent_compute_compliance() hire gate.
  - Onboarding   : talent_hire_applicant() creates the technician account (team_members invite)
                   + payroll record (employees) + engagement checklist, atomically.
  - Ratings      : talent_ratings, double-blind (revealed when both sides rated or after 14 days).
  - Private storage bucket talent-docs for credential documents.

  ## Security model
  - Workers own their data (RLS by auth.uid()). Businesses NEVER get direct table access to
    worker rows: they read an applicant only through talent_get_applicant(), and only for
    applications submitted to THEIR postings (worker consent captured at apply time).
  - Anonymous visitors can only call 4 RPCs: list/get open postings, and the token-gated
    reference response pair.
  - Every function is deny-by-default: the grants block at the end revokes everything on
    talent_* functions, then grants exactly the allow-lists.
  - Verification columns on credentials are not writable by clients (column grants), and
    editing a credential's substance resets its verification (trigger).
  - Provider/service writes (background check, reference tokens, primary-source verification,
    sweep) are service_role-only functions.

  Idempotent: safe to run more than once. Touches no existing table or policy.
*/

-- =============================================================
-- 0. PURE HELPERS (no table access)
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_trades()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'hvac','plumbing','electrical','roofing','restoration','locksmith','appliance_repair',
    'garage_door','pest_control','landscaping','solar','general_handyman','painting',
    'flooring','carpentry','welding'
  ]::text[];
$$;

-- Keep the tag lists in sync with src/lib/talentNetwork.ts
CREATE OR REPLACE FUNCTION public.talent_worker_rating_tags()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'reliable','skilled','safe_work','communicates_well','on_time','professional',
    'no_show','unsafe','poor_quality','unprofessional'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.talent_business_rating_tags()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'paid_on_time','clear_scope','respectful','safe_site','good_communication',
    'late_payment','unclear_scope','unsafe_site','disrespectful'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.talent_reference_strengths()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['reliable','skilled','safe','teamwork','communication','leadership','fast_learner']::text[];
$$;

-- Weekdays strictly after p_from up to and including p_to (no holiday calendar).
CREATE OR REPLACE FUNCTION public.talent_business_days_between(p_from date, p_to date)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT count(*)::integer
  FROM generate_series(1, GREATEST(p_to - p_from, 0)) AS g(n)
  WHERE extract(isodow FROM (p_from + g.n)) < 6;
$$;

CREATE OR REPLACE FUNCTION public.talent_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 1. WORKER TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS talent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  headline text,
  bio text,
  contact_email text NOT NULL,
  phone text,
  trades text[] NOT NULL DEFAULT '{}'::text[],
  experience_years smallint,
  city text,
  region text,
  country text NOT NULL DEFAULT 'US',
  service_radius_miles smallint,
  open_to text[] NOT NULL DEFAULT ARRAY['gig']::text[],
  desired_hourly_cents integer,
  availability text NOT NULL DEFAULT 'open',
  status text NOT NULL DEFAULT 'active',
  terms_accepted_at timestamptz,
  terms_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tp_name_check CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 80),
  CONSTRAINT tp_headline_check CHECK (headline IS NULL OR char_length(headline) <= 120),
  CONSTRAINT tp_bio_check CHECK (bio IS NULL OR char_length(bio) <= 2000),
  CONSTRAINT tp_email_check CHECK (char_length(contact_email) <= 254),
  CONSTRAINT tp_phone_check CHECK (phone IS NULL OR char_length(phone) <= 30),
  CONSTRAINT tp_trades_check CHECK (cardinality(trades) <= 8 AND trades <@ public.talent_trades()),
  CONSTRAINT tp_experience_check CHECK (experience_years IS NULL OR experience_years BETWEEN 0 AND 60),
  CONSTRAINT tp_location_check CHECK ((city IS NULL OR char_length(city) <= 80) AND (region IS NULL OR char_length(region) <= 40)),
  CONSTRAINT tp_country_check CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT tp_radius_check CHECK (service_radius_miles IS NULL OR service_radius_miles BETWEEN 1 AND 500),
  CONSTRAINT tp_open_to_check CHECK (
    cardinality(open_to) BETWEEN 1 AND 4
    AND open_to <@ ARRAY['full_time','part_time','contract','gig']::text[]
  ),
  CONSTRAINT tp_rate_check CHECK (desired_hourly_cents IS NULL OR desired_hourly_cents BETWEEN 0 AND 100000),
  CONSTRAINT tp_availability_check CHECK (availability IN ('open', 'limited', 'unavailable')),
  CONSTRAINT tp_status_check CHECK (status IN ('active', 'paused'))
);

CREATE TABLE IF NOT EXISTS talent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES talent_profiles(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  issuing_authority text,
  credential_number text,
  region text,
  issued_on date,
  expires_on date,
  document_path text,
  verification_status text NOT NULL DEFAULT 'unverified',
  verification_method text,
  verified_at timestamptz,
  verification_note text,
  expiry_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tc_kind_check CHECK (kind IN ('license', 'certification')),
  CONSTRAINT tc_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  CONSTRAINT tc_authority_check CHECK (issuing_authority IS NULL OR char_length(issuing_authority) <= 120),
  CONSTRAINT tc_number_check CHECK (credential_number IS NULL OR char_length(credential_number) <= 60),
  CONSTRAINT tc_region_check CHECK (region IS NULL OR char_length(region) <= 40),
  CONSTRAINT tc_dates_check CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT tc_document_check CHECK (
    document_path IS NULL OR document_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,120}$'
  ),
  CONSTRAINT tc_status_check CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed', 'expired')),
  CONSTRAINT tc_method_check CHECK (verification_method IS NULL OR verification_method IN ('primary_source', 'manual_review')),
  CONSTRAINT tc_note_check CHECK (verification_note IS NULL OR char_length(verification_note) <= 500)
);

CREATE TABLE IF NOT EXISTS talent_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES talent_profiles(id) ON DELETE CASCADE,
  referee_name text NOT NULL,
  referee_email text NOT NULL,
  referee_phone text,
  relationship text NOT NULL,
  company text,
  years_known smallint,
  status text NOT NULL DEFAULT 'added',
  request_token uuid,
  request_expires_at timestamptz,
  requested_at timestamptz,
  request_count smallint NOT NULL DEFAULT 0,
  responded_at timestamptz,
  response_rating smallint,
  response_would_rehire text,
  response_strengths text[] NOT NULL DEFAULT '{}'::text[],
  response_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tr_name_check CHECK (char_length(btrim(referee_name)) BETWEEN 2 AND 120),
  CONSTRAINT tr_email_check CHECK (char_length(referee_email) <= 254 AND referee_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT tr_phone_check CHECK (referee_phone IS NULL OR char_length(referee_phone) <= 30),
  CONSTRAINT tr_relationship_check CHECK (relationship IN ('supervisor', 'coworker', 'client', 'business_owner', 'instructor', 'other')),
  CONSTRAINT tr_company_check CHECK (company IS NULL OR char_length(company) <= 120),
  CONSTRAINT tr_years_check CHECK (years_known IS NULL OR years_known BETWEEN 0 AND 60),
  CONSTRAINT tr_status_check CHECK (status IN ('added', 'requested', 'received', 'declined', 'expired')),
  CONSTRAINT tr_rating_check CHECK (response_rating IS NULL OR response_rating BETWEEN 1 AND 5),
  CONSTRAINT tr_rehire_check CHECK (response_would_rehire IS NULL OR response_would_rehire IN ('yes', 'no', 'unsure')),
  CONSTRAINT tr_strengths_check CHECK (cardinality(response_strengths) <= 3 AND response_strengths <@ public.talent_reference_strengths()),
  CONSTRAINT tr_comment_check CHECK (response_comment IS NULL OR char_length(response_comment) <= 800)
);

-- =============================================================
-- 2. BUSINESS TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS talent_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slug text NOT NULL,
  kind text NOT NULL DEFAULT 'job',
  title text NOT NULL,
  trade text NOT NULL,
  summary text NOT NULL,
  description text NOT NULL,
  requirements text[] NOT NULL DEFAULT '{}'::text[],
  company_name text NOT NULL,
  city text,
  region text,
  country text NOT NULL DEFAULT 'US',
  employment_type text NOT NULL DEFAULT 'full_time',
  engagement_type text NOT NULL DEFAULT 'w2',
  pay_type text NOT NULL DEFAULT 'hourly',
  pay_min_cents integer,
  pay_max_cents integer,
  pay_currency text NOT NULL DEFAULT 'USD',
  starts_on date,
  ends_on date,
  headcount smallint NOT NULL DEFAULT 1,
  requires_license boolean NOT NULL DEFAULT false,
  requires_background_check boolean NOT NULL DEFAULT false,
  min_references smallint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  closed_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tpo_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 100),
  CONSTRAINT tpo_kind_check CHECK (kind IN ('job', 'gig')),
  CONSTRAINT tpo_title_check CHECK (char_length(btrim(title)) BETWEEN 5 AND 120),
  CONSTRAINT tpo_trade_check CHECK (trade = ANY (public.talent_trades())),
  CONSTRAINT tpo_summary_check CHECK (char_length(btrim(summary)) BETWEEN 20 AND 300),
  CONSTRAINT tpo_description_check CHECK (char_length(btrim(description)) BETWEEN 40 AND 8000),
  CONSTRAINT tpo_requirements_check CHECK (cardinality(requirements) <= 15),
  CONSTRAINT tpo_company_check CHECK (char_length(btrim(company_name)) BETWEEN 2 AND 120),
  CONSTRAINT tpo_location_check CHECK ((city IS NULL OR char_length(city) <= 80) AND (region IS NULL OR char_length(region) <= 40)),
  CONSTRAINT tpo_country_check CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT tpo_employment_check CHECK (employment_type IN ('full_time', 'part_time', 'contract')),
  CONSTRAINT tpo_engagement_check CHECK (engagement_type IN ('w2', '1099')),
  CONSTRAINT tpo_pay_type_check CHECK (pay_type IN ('hourly', 'salary', 'flat')),
  CONSTRAINT tpo_pay_check CHECK (
    (pay_min_cents IS NULL AND pay_max_cents IS NULL)
    OR (pay_min_cents IS NOT NULL AND pay_max_cents IS NOT NULL AND pay_min_cents > 0
        AND pay_min_cents <= pay_max_cents AND pay_max_cents <= 50000000)
  ),
  CONSTRAINT tpo_currency_check CHECK (pay_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT tpo_dates_check CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT tpo_headcount_check CHECK (headcount BETWEEN 1 AND 50),
  CONSTRAINT tpo_min_refs_check CHECK (min_references BETWEEN 0 AND 3),
  CONSTRAINT tpo_status_check CHECK (status IN ('draft', 'open', 'paused', 'filled', 'closed'))
);

CREATE TABLE IF NOT EXISTS talent_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id uuid NOT NULL REFERENCES talent_postings(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES talent_profiles(id) ON DELETE SET NULL,
  applicant_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'submitted',
  cover_note text,
  availability_note text,
  expected_rate_cents integer,
  profile_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_at timestamptz NOT NULL DEFAULT now(),
  decision_reason text,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ta_status_check CHECK (status IN ('submitted', 'reviewing', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  CONSTRAINT ta_cover_check CHECK (cover_note IS NULL OR char_length(cover_note) <= 1500),
  CONSTRAINT ta_availability_check CHECK (availability_note IS NULL OR char_length(availability_note) <= 500),
  CONSTRAINT ta_rate_check CHECK (expected_rate_cents IS NULL OR expected_rate_cents BETWEEN 0 AND 100000),
  CONSTRAINT ta_reason_check CHECK (
    decision_reason IS NULL OR decision_reason IN
      ('not_a_fit', 'position_filled', 'missing_credentials', 'better_qualified_candidate', 'background_check_adverse', 'other')
  ),
  CONSTRAINT ta_note_check CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  CONSTRAINT ta_unique_applicant UNIQUE (posting_id, profile_id)
);

CREATE TABLE IF NOT EXISTS talent_application_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES talent_applications(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor_user_id uuid,
  actor_role text NOT NULL DEFAULT 'system',
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tae_role_check CHECK (actor_role IN ('worker', 'manager', 'system')),
  CONSTRAINT tae_kind_check CHECK (char_length(kind) BETWEEN 2 AND 60)
);

CREATE TABLE IF NOT EXISTS talent_credential_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES talent_credentials(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  application_id uuid REFERENCES talent_applications(id) ON DELETE SET NULL,
  outcome text NOT NULL,
  method text NOT NULL,
  note text,
  attested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tca_outcome_check CHECK (outcome IN ('verified', 'not_verified')),
  CONSTRAINT tca_method_check CHECK (method IN ('state_board_lookup', 'document_review', 'issuer_contact', 'other')),
  CONSTRAINT tca_note_check CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT tca_unique UNIQUE (credential_id, account_owner_id)
);

-- Background checks: STATUS ONLY. Report contents stay with the screening provider.
CREATE TABLE IF NOT EXISTS talent_background_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES talent_applications(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES talent_profiles(id) ON DELETE SET NULL,
  applicant_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'checkr',
  package text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'pending_provider',
  result text,
  provider_candidate_id text,
  provider_invitation_id text,
  provider_report_id text,
  invitation_url text,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text,
  decision text,
  pre_adverse_sent_at timestamptz,
  adverse_final_at timestamptz,
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tbc_provider_check CHECK (provider IN ('checkr')),
  CONSTRAINT tbc_package_check CHECK (package ~ '^[a-z0-9_]{2,60}$'),
  CONSTRAINT tbc_status_check CHECK (status IN ('pending_provider', 'invited', 'in_progress', 'complete', 'suspended', 'canceled', 'failed')),
  CONSTRAINT tbc_result_check CHECK (result IS NULL OR result IN ('clear', 'consider')),
  CONSTRAINT tbc_decision_check CHECK (decision IS NULL OR decision IN ('pending_review', 'engage', 'pre_adverse_sent', 'adverse_final')),
  CONSTRAINT tbc_error_check CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  CONSTRAINT tbc_note_check CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000)
);

-- Webhook de-duplication (service role only; RLS enabled with no policies).
CREATE TABLE IF NOT EXISTS talent_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS talent_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES talent_applications(id) ON DELETE CASCADE,
  posting_id uuid NOT NULL REFERENCES talent_postings(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES talent_profiles(id) ON DELETE SET NULL,
  applicant_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  kind text NOT NULL,
  engagement_type text NOT NULL,
  status text NOT NULL DEFAULT 'onboarding',
  starts_on date NOT NULL,
  ends_on date,
  agreement_signed_at timestamptz,
  tax_form_received_at timestamptz,
  i9_completed_at timestamptz,
  direct_deposit_set_at timestamptz,
  onboarding_completed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT te_kind_check CHECK (kind IN ('job', 'gig')),
  CONSTRAINT te_type_check CHECK (engagement_type IN ('w2', '1099')),
  CONSTRAINT te_status_check CHECK (status IN ('onboarding', 'active', 'completed', 'terminated')),
  CONSTRAINT te_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS talent_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES talent_engagements(id) ON DELETE CASCADE,
  direction text NOT NULL,
  rater_user_id uuid NOT NULL,
  ratee_profile_id uuid REFERENCES talent_profiles(id) ON DELETE SET NULL,
  ratee_account_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  rating smallint NOT NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trt_direction_check CHECK (direction IN ('business_to_worker', 'worker_to_business')),
  CONSTRAINT trt_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT trt_tags_check CHECK (cardinality(tags) <= 5),
  CONSTRAINT trt_comment_check CHECK (comment IS NULL OR char_length(comment) <= 600),
  CONSTRAINT trt_unique UNIQUE (engagement_id, direction)
);

-- =============================================================
-- 3. INDEXES
-- =============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_tpo_slug ON talent_postings(slug);
CREATE INDEX IF NOT EXISTS idx_tpo_open ON talent_postings(published_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_tpo_account ON talent_postings(account_owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tc_profile ON talent_credentials(profile_id);
CREATE INDEX IF NOT EXISTS idx_tc_expiry ON talent_credentials(expires_on) WHERE expires_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tr_profile ON talent_references(profile_id);
CREATE INDEX IF NOT EXISTS idx_tr_token ON talent_references(request_token) WHERE request_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ta_account ON talent_applications(account_owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ta_posting ON talent_applications(posting_id, status);
CREATE INDEX IF NOT EXISTS idx_ta_applicant ON talent_applications(applicant_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tae_application ON talent_application_events(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tca_credential ON talent_credential_attestations(credential_id);
CREATE INDEX IF NOT EXISTS idx_tbc_application ON talent_background_checks(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tbc_report ON talent_background_checks(provider_report_id) WHERE provider_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tbc_invitation ON talent_background_checks(provider_invitation_id) WHERE provider_invitation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tbc_candidate ON talent_background_checks(provider_candidate_id) WHERE provider_candidate_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tbc_one_active
  ON talent_background_checks(application_id)
  WHERE status IN ('pending_provider', 'invited', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_te_account ON talent_engagements(account_owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_te_applicant ON talent_engagements(applicant_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trt_engagement ON talent_ratings(engagement_id);
CREATE INDEX IF NOT EXISTS idx_trt_ratee_profile ON talent_ratings(ratee_profile_id) WHERE ratee_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trt_ratee_account ON talent_ratings(ratee_account_id) WHERE ratee_account_id IS NOT NULL;

-- =============================================================
-- 4. TABLE-DEPENDENT HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND (
          COALESCE(m.permissions ->> 'can_manage_team', 'false') = 'true'
          OR COALESCE(m.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.talent_my_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tp.id FROM talent_profiles tp WHERE tp.user_id = auth.uid() LIMIT 1;
$$;

-- Business may read a credential document only while an application from that worker is live.
CREATE OR REPLACE FUNCTION public.talent_business_can_read_doc(p_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.talent_is_manager() AND EXISTS (
    SELECT 1
    FROM talent_credentials c
    JOIN talent_profiles p ON p.id = c.profile_id
    JOIN talent_applications a ON a.applicant_user_id = p.user_id
    WHERE c.document_path = p_path
      AND split_part(c.document_path, '/', 1) = p.user_id::text
      AND a.account_owner_id = public.get_account_owner_id()
      AND a.status IN ('submitted', 'reviewing', 'interview', 'offer', 'hired')
  );
$$;

-- Internal: append-only audit trail.
CREATE OR REPLACE FUNCTION public.talent_log_event(
  p_application_id uuid, p_owner uuid, p_actor_role text, p_kind text, p_detail jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO talent_application_events (application_id, account_owner_id, actor_user_id, actor_role, kind, detail)
  VALUES (p_application_id, p_owner, auth.uid(), p_actor_role, p_kind, COALESCE(p_detail, '{}'::jsonb));
$$;

-- Internal: a failed notification must never block the business action.
CREATE OR REPLACE FUNCTION public.talent_notify(
  p_user uuid, p_type text, p_title text, p_message text, p_url text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (p_user, p_type, left(p_title, 200), left(p_message, 500), p_url);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'talent_notify failed: %', SQLERRM;
  END;
END;
$$;

-- Internal: company reputation (revealed worker->business ratings only).
CREATE OR REPLACE FUNCTION public.talent_company_reputation(p_owner uuid)
RETURNS TABLE (rating_avg numeric, rating_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT round(avg(r.rating)::numeric, 2), count(*)::integer
  FROM talent_ratings r
  JOIN talent_engagements e ON e.id = r.engagement_id
  WHERE r.direction = 'worker_to_business'
    AND e.account_owner_id = p_owner
    AND (
      EXISTS (SELECT 1 FROM talent_ratings o WHERE o.engagement_id = r.engagement_id AND o.direction = 'business_to_worker')
      OR e.completed_at <= now() - interval '14 days'
    );
$$;

-- Internal: worker reputation (revealed business->worker ratings only).
CREATE OR REPLACE FUNCTION public.talent_worker_reputation(p_profile_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rev AS (
    SELECT r.rating, r.tags
    FROM talent_ratings r
    JOIN talent_engagements e ON e.id = r.engagement_id
    WHERE r.direction = 'business_to_worker'
      AND r.ratee_profile_id = p_profile_id
      AND (
        EXISTS (SELECT 1 FROM talent_ratings o WHERE o.engagement_id = r.engagement_id AND o.direction = 'worker_to_business')
        OR e.completed_at <= now() - interval '14 days'
      )
  ),
  tg AS (
    SELECT t.tag, count(*)::integer AS n
    FROM rev CROSS JOIN LATERAL unnest(rev.tags) AS t(tag)
    GROUP BY t.tag
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*)::integer FROM rev),
    'avg', (SELECT round(avg(rating)::numeric, 2) FROM rev),
    'tags', COALESCE((SELECT jsonb_agg(jsonb_build_object('tag', tg.tag, 'count', tg.n) ORDER BY tg.n DESC, tg.tag) FROM tg), '[]'::jsonb)
  );
$$;

-- =============================================================
-- 5. TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_tp_touch ON talent_profiles;
CREATE TRIGGER trg_tp_touch BEFORE UPDATE ON talent_profiles
  FOR EACH ROW EXECUTE FUNCTION public.talent_touch_updated_at();

DROP TRIGGER IF EXISTS trg_ta_touch ON talent_applications;
CREATE TRIGGER trg_ta_touch BEFORE UPDATE ON talent_applications
  FOR EACH ROW EXECUTE FUNCTION public.talent_touch_updated_at();

DROP TRIGGER IF EXISTS trg_tbc_touch ON talent_background_checks;
CREATE TRIGGER trg_tbc_touch BEFORE UPDATE ON talent_background_checks
  FOR EACH ROW EXECUTE FUNCTION public.talent_touch_updated_at();

DROP TRIGGER IF EXISTS trg_te_touch ON talent_engagements;
CREATE TRIGGER trg_te_touch BEFORE UPDATE ON talent_engagements
  FOR EACH ROW EXECUTE FUNCTION public.talent_touch_updated_at();

-- Credentials: client edits reset verification; document path must live in the owner's folder.
CREATE OR REPLACE FUNCTION public.talent_credentials_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_client boolean := current_user IN ('authenticated', 'anon');
BEGIN
  IF v_client AND NEW.document_path IS NOT NULL
     AND split_part(NEW.document_path, '/', 1) <> COALESCE(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Documents must be uploaded to your own folder.' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_client AND (SELECT count(*) FROM talent_credentials c WHERE c.profile_id = NEW.profile_id) >= 30 THEN
      RAISE EXCEPTION 'You can store up to 30 credentials.' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_client AND (NEW.kind, NEW.name, NEW.issuing_authority, NEW.credential_number, NEW.region, NEW.issued_on, NEW.expires_on)
       IS DISTINCT FROM
       (OLD.kind, OLD.name, OLD.issuing_authority, OLD.credential_number, OLD.region, OLD.issued_on, OLD.expires_on) THEN
      NEW.verification_status := 'unverified';
      NEW.verification_method := NULL;
      NEW.verified_at := NULL;
      NEW.verification_note := NULL;
    END IF;
    IF NEW.expires_on IS DISTINCT FROM OLD.expires_on THEN
      NEW.expiry_notified_at := NULL;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tc_guard ON talent_credentials;
CREATE TRIGGER trg_tc_guard BEFORE INSERT OR UPDATE ON talent_credentials
  FOR EACH ROW EXECUTE FUNCTION public.talent_credentials_guard();

-- References: max 6, no self-reference, identity frozen once requested.
CREATE OR REPLACE FUNCTION public.talent_references_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_client boolean := current_user IN ('authenticated', 'anon');
  v_own_email text;
BEGIN
  IF v_client THEN
    SELECT tp.contact_email INTO v_own_email FROM talent_profiles tp WHERE tp.id = NEW.profile_id;
    IF v_own_email IS NOT NULL AND lower(btrim(NEW.referee_email)) = lower(v_own_email) THEN
      RAISE EXCEPTION 'A reference must be another person, not your own email.' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_client AND (SELECT count(*) FROM talent_references r WHERE r.profile_id = NEW.profile_id) >= 6 THEN
      RAISE EXCEPTION 'You can add up to 6 references.' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_client AND OLD.status <> 'added'
       AND (NEW.referee_name, NEW.referee_email) IS DISTINCT FROM (OLD.referee_name, OLD.referee_email) THEN
      RAISE EXCEPTION 'A requested reference cannot be edited. Delete it and add a new one.' USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tr_guard ON talent_references;
CREATE TRIGGER trg_tr_guard BEFORE INSERT OR UPDATE ON talent_references
  FOR EACH ROW EXECUTE FUNCTION public.talent_references_guard();

-- Postings: tenant stamp, slug, publish rules (pay transparency, gig dates, real business only).
CREATE OR REPLACE FUNCTION public.talent_postings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company text;
  v_onboarded boolean;
  v_open_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.account_owner_id IS NULL THEN
      NEW.account_owner_id := public.get_account_owner_id();
    END IF;
    IF NEW.slug IS NULL OR btrim(NEW.slug) = '' THEN
      NEW.slug := left(
        COALESCE(NULLIF(regexp_replace(lower(btrim(NEW.title)), '[^a-z0-9]+', '-', 'g'), ''), 'posting'),
        80
      );
      NEW.slug := trim(both '-' from NEW.slug) || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
    END IF;
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.published_at := NULL;
    NEW.closed_at := NULL;
  ELSE
    NEW.account_owner_id := OLD.account_owner_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    IF OLD.published_at IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
      RAISE EXCEPTION 'The URL slug cannot change after a posting has been published.' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.company_name IS NULL OR btrim(NEW.company_name) = '' THEN
    SELECT NULLIF(btrim(p.company_name), '') INTO v_company FROM profiles p WHERE p.id = NEW.account_owner_id;
    NEW.company_name := COALESCE(v_company, 'Local service business');
  END IF;

  IF NEW.status = 'open' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'open') THEN
    IF NEW.pay_min_cents IS NULL OR NEW.pay_max_cents IS NULL THEN
      RAISE EXCEPTION 'A pay range is required to publish (pay-transparency laws apply in many states).' USING ERRCODE = '22023';
    END IF;
    IF NEW.kind = 'gig' AND (NEW.starts_on IS NULL OR NEW.ends_on IS NULL) THEN
      RAISE EXCEPTION 'Gig work needs a start and end date.' USING ERRCODE = '22023';
    END IF;
    IF NEW.city IS NULL OR btrim(NEW.city) = '' OR NEW.region IS NULL OR btrim(NEW.region) = '' THEN
      RAISE EXCEPTION 'City and state/region are required to publish.' USING ERRCODE = '22023';
    END IF;
    SELECT p.onboarding_completed INTO v_onboarded FROM profiles p WHERE p.id = NEW.account_owner_id;
    IF NOT COALESCE(v_onboarded, false) THEN
      RAISE EXCEPTION 'Finish your Vireek onboarding before publishing postings.' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_open_count FROM talent_postings t
      WHERE t.account_owner_id = NEW.account_owner_id AND t.status = 'open'
        AND (TG_OP = 'INSERT' OR t.id <> NEW.id);
    IF v_open_count >= 25 THEN
      RAISE EXCEPTION 'You can have up to 25 open postings.' USING ERRCODE = '22023';
    END IF;
    NEW.published_at := COALESCE(NEW.published_at, now());
    NEW.closed_at := NULL;
  ELSIF NEW.status IN ('closed', 'filled') THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tpo_guard ON talent_postings;
CREATE TRIGGER trg_tpo_guard BEFORE INSERT OR UPDATE ON talent_postings
  FOR EACH ROW EXECUTE FUNCTION public.talent_postings_guard();

-- =============================================================
-- 6. ROW LEVEL SECURITY + TABLE PRIVILEGES
-- =============================================================

ALTER TABLE talent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_application_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_credential_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_background_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_ratings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON talent_profiles, talent_credentials, talent_references, talent_postings,
  talent_applications, talent_application_events, talent_credential_attestations,
  talent_background_checks, talent_provider_events, talent_engagements, talent_ratings
  FROM anon, authenticated;

-- Worker: profile (read own; writes go through talent_save_profile)
DROP POLICY IF EXISTS "tp_select_own" ON talent_profiles;
CREATE POLICY "tp_select_own" ON talent_profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid());
GRANT SELECT ON talent_profiles TO authenticated;

-- Worker: credentials (verification columns are NOT writable)
DROP POLICY IF EXISTS "tc_select_own" ON talent_credentials;
CREATE POLICY "tc_select_own" ON talent_credentials FOR SELECT TO authenticated
  USING (profile_id = public.talent_my_profile_id());
DROP POLICY IF EXISTS "tc_insert_own" ON talent_credentials;
CREATE POLICY "tc_insert_own" ON talent_credentials FOR INSERT TO authenticated
  WITH CHECK (profile_id = public.talent_my_profile_id());
DROP POLICY IF EXISTS "tc_update_own" ON talent_credentials;
CREATE POLICY "tc_update_own" ON talent_credentials FOR UPDATE TO authenticated
  USING (profile_id = public.talent_my_profile_id())
  WITH CHECK (profile_id = public.talent_my_profile_id());
DROP POLICY IF EXISTS "tc_delete_own" ON talent_credentials;
CREATE POLICY "tc_delete_own" ON talent_credentials FOR DELETE TO authenticated
  USING (profile_id = public.talent_my_profile_id());
GRANT SELECT, DELETE ON talent_credentials TO authenticated;
GRANT INSERT (profile_id, kind, name, issuing_authority, credential_number, region, issued_on, expires_on, document_path)
  ON talent_credentials TO authenticated;
GRANT UPDATE (kind, name, issuing_authority, credential_number, region, issued_on, expires_on, document_path)
  ON talent_credentials TO authenticated;

-- Worker: references (token + response columns are NOT readable or writable by the worker)
DROP POLICY IF EXISTS "tr_select_own" ON talent_references;
CREATE POLICY "tr_select_own" ON talent_references FOR SELECT TO authenticated
  USING (profile_id = public.talent_my_profile_id());
DROP POLICY IF EXISTS "tr_insert_own" ON talent_references;
CREATE POLICY "tr_insert_own" ON talent_references FOR INSERT TO authenticated
  WITH CHECK (profile_id = public.talent_my_profile_id());
DROP POLICY IF EXISTS "tr_update_own" ON talent_references;
CREATE POLICY "tr_update_own" ON talent_references FOR UPDATE TO authenticated
  USING (profile_id = public.talent_my_profile_id())
  WITH CHECK (profile_id = public.talent_my_profile_id());
DROP POLICY IF EXISTS "tr_delete_own" ON talent_references;
CREATE POLICY "tr_delete_own" ON talent_references FOR DELETE TO authenticated
  USING (profile_id = public.talent_my_profile_id());
GRANT SELECT (id, profile_id, referee_name, referee_email, referee_phone, relationship, company, years_known,
              status, requested_at, request_count, responded_at, created_at, updated_at)
  ON talent_references TO authenticated;
GRANT DELETE ON talent_references TO authenticated;
GRANT INSERT (profile_id, referee_name, referee_email, referee_phone, relationship, company, years_known)
  ON talent_references TO authenticated;
GRANT UPDATE (referee_name, referee_email, referee_phone, relationship, company, years_known)
  ON talent_references TO authenticated;

-- Business: postings
DROP POLICY IF EXISTS "tpo_manager_all" ON talent_postings;
CREATE POLICY "tpo_manager_all" ON talent_postings FOR ALL TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager());
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_postings TO authenticated;

-- Applications (read only; every change goes through an RPC)
DROP POLICY IF EXISTS "ta_select_worker" ON talent_applications;
CREATE POLICY "ta_select_worker" ON talent_applications FOR SELECT TO authenticated
  USING (applicant_user_id = auth.uid());
DROP POLICY IF EXISTS "ta_select_manager" ON talent_applications;
CREATE POLICY "ta_select_manager" ON talent_applications FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager());
GRANT SELECT ON talent_applications TO authenticated;

DROP POLICY IF EXISTS "tae_select_manager" ON talent_application_events;
CREATE POLICY "tae_select_manager" ON talent_application_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager());
GRANT SELECT ON talent_application_events TO authenticated;

DROP POLICY IF EXISTS "tca_select_manager" ON talent_credential_attestations;
CREATE POLICY "tca_select_manager" ON talent_credential_attestations FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager());
GRANT SELECT ON talent_credential_attestations TO authenticated;

DROP POLICY IF EXISTS "tbc_select_manager" ON talent_background_checks;
CREATE POLICY "tbc_select_manager" ON talent_background_checks FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager());
DROP POLICY IF EXISTS "tbc_select_worker" ON talent_background_checks;
CREATE POLICY "tbc_select_worker" ON talent_background_checks FOR SELECT TO authenticated
  USING (applicant_user_id = auth.uid());
GRANT SELECT ON talent_background_checks TO authenticated;

DROP POLICY IF EXISTS "te_select_manager" ON talent_engagements;
CREATE POLICY "te_select_manager" ON talent_engagements FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.talent_is_manager());
DROP POLICY IF EXISTS "te_select_worker" ON talent_engagements;
CREATE POLICY "te_select_worker" ON talent_engagements FOR SELECT TO authenticated
  USING (applicant_user_id = auth.uid());
GRANT SELECT ON talent_engagements TO authenticated;

DROP POLICY IF EXISTS "trt_select_own" ON talent_ratings;
CREATE POLICY "trt_select_own" ON talent_ratings FOR SELECT TO authenticated
  USING (rater_user_id = auth.uid());
GRANT SELECT ON talent_ratings TO authenticated;

-- =============================================================
-- 7. STORAGE: private bucket for credential documents
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'talent-docs', 'talent-docs', false, 10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "talent_docs_insert_own" ON storage.objects;
CREATE POLICY "talent_docs_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'talent-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "talent_docs_select_own" ON storage.objects;
CREATE POLICY "talent_docs_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'talent-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "talent_docs_delete_own" ON storage.objects;
CREATE POLICY "talent_docs_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'talent-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "talent_docs_business_read" ON storage.objects;
CREATE POLICY "talent_docs_business_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'talent-docs' AND public.talent_business_can_read_doc(name));

-- =============================================================
-- 8. PUBLIC RPCs (anonymous allowed)
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_list_open_postings(
  p_trade text DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, slug text, kind text, title text, trade text, summary text, company_name text,
  city text, region text, country text, employment_type text, pay_type text,
  pay_min_cents integer, pay_max_cents integer, pay_currency text,
  starts_on date, ends_on date, headcount smallint, requires_license boolean,
  published_at timestamptz, company_rating_avg numeric, company_rating_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_pat text := NULL;
BEGIN
  IF p_query IS NOT NULL AND btrim(p_query) <> '' THEN
    v_pat := '%' || replace(replace(replace(left(btrim(p_query), 80), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  RETURN QUERY
  SELECT p.id, p.slug, p.kind, p.title, p.trade, p.summary, p.company_name,
         p.city, p.region, p.country, p.employment_type, p.pay_type,
         p.pay_min_cents, p.pay_max_cents, p.pay_currency,
         p.starts_on, p.ends_on, p.headcount, p.requires_license,
         p.published_at, r.rating_avg, r.rating_count
  FROM talent_postings p
  LEFT JOIN LATERAL public.talent_company_reputation(p.account_owner_id) r ON true
  WHERE p.status = 'open'
    AND (p_trade IS NULL OR p.trade = p_trade)
    AND (p_kind IS NULL OR p.kind = p_kind)
    AND (p_region IS NULL OR upper(p.region) = upper(btrim(p_region)))
    AND (v_pat IS NULL OR p.title ILIKE v_pat OR p.summary ILIKE v_pat OR p.company_name ILIKE v_pat)
  ORDER BY p.published_at DESC NULLS LAST, p.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 50))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_get_open_posting(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'slug', p.slug, 'kind', p.kind, 'title', p.title, 'trade', p.trade,
    'summary', p.summary, 'description', p.description, 'requirements', to_jsonb(p.requirements),
    'company_name', p.company_name, 'city', p.city, 'region', p.region, 'country', p.country,
    'employment_type', p.employment_type, 'engagement_type', p.engagement_type, 'pay_type', p.pay_type,
    'pay_min_cents', p.pay_min_cents, 'pay_max_cents', p.pay_max_cents, 'pay_currency', p.pay_currency,
    'starts_on', p.starts_on, 'ends_on', p.ends_on, 'headcount', p.headcount,
    'requires_license', p.requires_license, 'requires_background_check', p.requires_background_check,
    'min_references', p.min_references, 'published_at', p.published_at,
    'company_rating_avg', r.rating_avg, 'company_rating_count', r.rating_count
  )
  FROM talent_postings p
  LEFT JOIN LATERAL public.talent_company_reputation(p.account_owner_id) r ON true
  WHERE p.slug = p_slug AND p.status = 'open';
$$;

-- Referee page: who is asking, and is the link still valid? (first name only)
CREATE OR REPLACE FUNCTION public.talent_get_reference_request(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'valid', true,
    'referee_name', r.referee_name,
    'relationship', r.relationship,
    'worker_first_name', COALESCE(NULLIF(split_part(btrim(p.display_name), ' ', 1), ''), 'this person')
  )
  FROM talent_references r
  JOIN talent_profiles p ON p.id = r.profile_id
  WHERE r.request_token = p_token AND r.status = 'requested' AND r.request_expires_at > now();
$$;

CREATE OR REPLACE FUNCTION public.talent_submit_reference(
  p_token uuid,
  p_rating smallint,
  p_would_rehire text,
  p_strengths text[],
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref talent_references%ROWTYPE;
  v_user uuid;
  v_strengths text[];
BEGIN
  IF p_token IS NULL OR p_rating IS NULL OR p_rating < 1 OR p_rating > 5
     OR p_would_rehire IS NULL OR p_would_rehire NOT IN ('yes', 'no', 'unsure') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  v_strengths := ARRAY(
    SELECT DISTINCT s FROM unnest(COALESCE(p_strengths, '{}'::text[])) AS u(s)
    WHERE s = ANY (public.talent_reference_strengths())
    ORDER BY s
    LIMIT 3
  );

  SELECT * INTO v_ref FROM talent_references
  WHERE request_token = p_token AND status = 'requested' AND request_expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_or_expired');
  END IF;

  UPDATE talent_references
  SET status = 'received',
      request_token = NULL,
      request_expires_at = NULL,
      responded_at = now(),
      response_rating = p_rating,
      response_would_rehire = p_would_rehire,
      response_strengths = v_strengths,
      response_comment = left(NULLIF(btrim(COALESCE(p_comment, '')), ''), 800)
  WHERE id = v_ref.id;

  SELECT tp.user_id INTO v_user FROM talent_profiles tp WHERE tp.id = v_ref.profile_id;
  PERFORM public.talent_notify(v_user, 'talent_reference_received', 'A reference was received',
    'One of your references responded. Businesses you apply to will see it.', '/talent/me');

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- =============================================================
-- 9. WORKER RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_save_profile(
  p_display_name text,
  p_headline text,
  p_bio text,
  p_phone text,
  p_trades text[],
  p_experience_years integer,
  p_city text,
  p_region text,
  p_country text,
  p_service_radius_miles integer,
  p_open_to text[],
  p_desired_hourly_cents integer,
  p_availability text,
  p_status text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_trades text[];
  v_open text[];
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Your account has no email address.' USING ERRCODE = '22023';
  END IF;

  IF p_display_name IS NULL OR char_length(btrim(p_display_name)) < 2 THEN
    RAISE EXCEPTION 'Enter your name (at least 2 characters).' USING ERRCODE = '22023';
  END IF;

  v_trades := ARRAY(
    SELECT DISTINCT t FROM unnest(COALESCE(p_trades, '{}'::text[])) AS u(t)
    WHERE t = ANY (public.talent_trades()) ORDER BY t LIMIT 8
  );
  IF cardinality(v_trades) = 0 THEN
    RAISE EXCEPTION 'Select at least one trade.' USING ERRCODE = '22023';
  END IF;

  v_open := ARRAY(
    SELECT DISTINCT o FROM unnest(COALESCE(p_open_to, '{}'::text[])) AS u(o)
    WHERE o IN ('full_time', 'part_time', 'contract', 'gig') ORDER BY o
  );
  IF cardinality(v_open) = 0 THEN
    RAISE EXCEPTION 'Choose at least one type of work you are open to.' USING ERRCODE = '22023';
  END IF;

  IF p_availability IS NULL OR p_availability NOT IN ('open', 'limited', 'unavailable') THEN
    RAISE EXCEPTION 'Invalid availability.' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'Invalid status.' USING ERRCODE = '22023';
  END IF;
  IF p_experience_years IS NOT NULL AND (p_experience_years < 0 OR p_experience_years > 60) THEN
    RAISE EXCEPTION 'Experience must be between 0 and 60 years.' USING ERRCODE = '22023';
  END IF;
  IF p_service_radius_miles IS NOT NULL AND (p_service_radius_miles < 1 OR p_service_radius_miles > 500) THEN
    RAISE EXCEPTION 'Service radius must be between 1 and 500 miles.' USING ERRCODE = '22023';
  END IF;
  IF p_desired_hourly_cents IS NOT NULL AND (p_desired_hourly_cents < 0 OR p_desired_hourly_cents > 100000) THEN
    RAISE EXCEPTION 'Desired hourly rate is out of range.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO talent_profiles (
    user_id, display_name, headline, bio, contact_email, phone, trades, experience_years,
    city, region, country, service_radius_miles, open_to, desired_hourly_cents, availability, status
  )
  VALUES (
    v_uid,
    left(btrim(p_display_name), 80),
    left(NULLIF(btrim(COALESCE(p_headline, '')), ''), 120),
    left(NULLIF(btrim(COALESCE(p_bio, '')), ''), 2000),
    v_email,
    left(NULLIF(btrim(COALESCE(p_phone, '')), ''), 30),
    v_trades,
    p_experience_years::smallint,
    left(NULLIF(btrim(COALESCE(p_city, '')), ''), 80),
    left(NULLIF(upper(btrim(COALESCE(p_region, ''))), ''), 40),
    CASE WHEN upper(btrim(COALESCE(p_country, ''))) ~ '^[A-Z]{2}$' THEN upper(btrim(p_country)) ELSE 'US' END,
    p_service_radius_miles::smallint,
    v_open,
    p_desired_hourly_cents,
    p_availability,
    p_status
  )
  ON CONFLICT (user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    headline = EXCLUDED.headline,
    bio = EXCLUDED.bio,
    contact_email = EXCLUDED.contact_email,
    phone = EXCLUDED.phone,
    trades = EXCLUDED.trades,
    experience_years = EXCLUDED.experience_years,
    city = EXCLUDED.city,
    region = EXCLUDED.region,
    country = EXCLUDED.country,
    service_radius_miles = EXCLUDED.service_radius_miles,
    open_to = EXCLUDED.open_to,
    desired_hourly_cents = EXCLUDED.desired_hourly_cents,
    availability = EXCLUDED.availability,
    status = EXCLUDED.status
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_accept_terms(p_version text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  UPDATE talent_profiles
  SET terms_accepted_at = now(),
      terms_version = left(COALESCE(NULLIF(btrim(p_version), ''), 'v1'), 20)
  WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Create your profile first.' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_apply(
  p_posting_id uuid,
  p_cover_note text DEFAULT NULL,
  p_expected_rate_cents integer DEFAULT NULL,
  p_availability_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prof talent_profiles%ROWTYPE;
  v_post talent_postings%ROWTYPE;
  v_snapshot jsonb;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_prof FROM talent_profiles WHERE user_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Create your talent profile before applying.' USING ERRCODE = '22023';
  END IF;
  IF v_prof.status <> 'active' THEN
    RAISE EXCEPTION 'Your profile is paused. Set it to active to apply.' USING ERRCODE = '22023';
  END IF;
  IF v_prof.terms_accepted_at IS NULL THEN
    RAISE EXCEPTION 'Accept the Talent Network terms before applying.' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_prof.trades) = 0 OR v_prof.region IS NULL THEN
    RAISE EXCEPTION 'Add your trade and location to your profile first.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_post FROM talent_postings WHERE id = p_posting_id AND status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This posting is no longer open.' USING ERRCODE = '22023';
  END IF;
  IF v_post.account_owner_id = v_uid OR v_post.account_owner_id = public.get_account_owner_id() THEN
    RAISE EXCEPTION 'You cannot apply to your own company.' USING ERRCODE = '22023';
  END IF;
  IF p_expected_rate_cents IS NOT NULL AND (p_expected_rate_cents < 0 OR p_expected_rate_cents > 100000) THEN
    RAISE EXCEPTION 'Expected rate is out of range.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM talent_applications a
      WHERE a.applicant_user_id = v_uid AND a.created_at > now() - interval '24 hours') >= 20 THEN
    RAISE EXCEPTION 'Daily application limit reached. Try again tomorrow.' USING ERRCODE = '22023';
  END IF;

  v_snapshot := jsonb_build_object(
    'display_name', v_prof.display_name,
    'headline', v_prof.headline,
    'trades', to_jsonb(v_prof.trades),
    'experience_years', v_prof.experience_years,
    'city', v_prof.city,
    'region', v_prof.region,
    'country', v_prof.country,
    'open_to', to_jsonb(v_prof.open_to),
    'credentials', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', c.kind, 'name', c.name, 'issuing_authority', c.issuing_authority,
        'region', c.region, 'expires_on', c.expires_on, 'verification_status', c.verification_status
      ) ORDER BY c.kind, c.name)
      FROM talent_credentials c WHERE c.profile_id = v_prof.id
    ), '[]'::jsonb)
  );

  BEGIN
    INSERT INTO talent_applications (
      posting_id, account_owner_id, profile_id, applicant_user_id,
      cover_note, availability_note, expected_rate_cents, profile_snapshot
    )
    VALUES (
      v_post.id, v_post.account_owner_id, v_prof.id, v_uid,
      left(NULLIF(btrim(COALESCE(p_cover_note, '')), ''), 1500),
      left(NULLIF(btrim(COALESCE(p_availability_note, '')), ''), 500),
      p_expected_rate_cents, v_snapshot
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You have already applied to this posting.' USING ERRCODE = '22023';
  END;

  PERFORM public.talent_log_event(v_id, v_post.account_owner_id, 'worker', 'applied', jsonb_build_object('posting_id', v_post.id));
  PERFORM public.talent_notify(v_post.account_owner_id, 'talent_application_received',
    'New applicant: ' || v_post.title,
    v_prof.display_name || ' applied. Review the application in Talent Network.',
    '/dashboard/talent?tab=applicants&app=' || v_id::text);

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_withdraw_application(p_application_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app talent_applications%ROWTYPE;
BEGIN
  SELECT * INTO v_app FROM talent_applications
  WHERE id = p_application_id AND applicant_user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;
  IF v_app.status IN ('hired', 'withdrawn', 'rejected') THEN
    RAISE EXCEPTION 'This application can no longer be withdrawn.' USING ERRCODE = '22023';
  END IF;
  UPDATE talent_applications SET status = 'withdrawn', decided_at = now() WHERE id = v_app.id;
  UPDATE talent_background_checks SET status = 'canceled'
    WHERE application_id = v_app.id AND status IN ('pending_provider', 'invited', 'in_progress');
  PERFORM public.talent_log_event(v_app.id, v_app.account_owner_id, 'worker', 'withdrawn', '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_my_applications()
RETURNS TABLE (
  application_id uuid, status text, applied_at timestamptz, posting_id uuid, posting_title text,
  company_name text, kind text, trade text, city text, region text, decision_reason text,
  background_check_status text, background_check_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT a.id, a.status, a.created_at, p.id, p.title, p.company_name, p.kind, p.trade, p.city, p.region,
         CASE WHEN a.decision_reason = 'background_check_adverse' THEN 'see_notice' ELSE a.decision_reason END,
         bc.status, bc.invitation_url
  FROM talent_applications a
  JOIN talent_postings p ON p.id = a.posting_id
  LEFT JOIN LATERAL (
    SELECT b.status, b.invitation_url FROM talent_background_checks b
    WHERE b.application_id = a.id ORDER BY b.created_at DESC LIMIT 1
  ) bc ON true
  WHERE a.applicant_user_id = auth.uid()
  ORDER BY a.created_at DESC
  LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_my_reputation()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.talent_my_profile_id() IS NULL
              THEN jsonb_build_object('count', 0, 'avg', NULL, 'tags', '[]'::jsonb)
              ELSE public.talent_worker_reputation(public.talent_my_profile_id()) END;
$$;

CREATE OR REPLACE FUNCTION public.talent_list_engagements_worker()
RETURNS TABLE (
  engagement_id uuid, posting_title text, company_name text, kind text, engagement_type text,
  status text, starts_on date, ends_on date, completed_at timestamptz,
  my_rating_submitted boolean, counterpart_revealed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT e.id, p.title, p.company_name, e.kind, e.engagement_type, e.status, e.starts_on, e.ends_on, e.completed_at,
         EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = e.id AND r.direction = 'worker_to_business'),
         (EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = e.id AND r.direction = 'business_to_worker')
          AND (EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = e.id AND r.direction = 'worker_to_business')
               OR e.completed_at <= now() - interval '14 days'))
  FROM talent_engagements e
  JOIN talent_postings p ON p.id = e.posting_id
  WHERE e.applicant_user_id = auth.uid()
  ORDER BY e.created_at DESC
  LIMIT 100;
END;
$$;

-- Data-subject access: everything the worker stored, minus confidential reference responses.
CREATE OR REPLACE FUNCTION public.talent_export_my_data()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid uuid := public.talent_my_profile_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'exported_at', now(),
    'profile', (SELECT to_jsonb(p) - 'id' - 'user_id' FROM talent_profiles p WHERE p.id = v_pid),
    'credentials', COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'id' - 'profile_id') FROM talent_credentials c WHERE c.profile_id = v_pid), '[]'::jsonb),
    'references', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'referee_name', r.referee_name, 'relationship', r.relationship, 'status', r.status, 'requested_at', r.requested_at))
      FROM talent_references r WHERE r.profile_id = v_pid), '[]'::jsonb),
    'applications', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'applied_at', a.created_at, 'status', a.status, 'posting_id', a.posting_id, 'shared_profile', a.profile_snapshot,
        'cover_note', a.cover_note))
      FROM talent_applications a WHERE a.applicant_user_id = auth.uid()), '[]'::jsonb),
    'ratings_given', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rating', r.rating, 'tags', r.tags, 'comment', r.comment, 'created_at', r.created_at))
      FROM talent_ratings r WHERE r.rater_user_id = auth.uid()), '[]'::jsonb),
    'reputation', public.talent_worker_reputation(v_pid)
  );
END;
$$;

-- Erasure: removes the worker's own profile, credentials and references.
-- Business-side hiring records survive (profile_id is set to NULL) for legal retention.
CREATE OR REPLACE FUNCTION public.talent_delete_my_profile()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pid uuid := public.talent_my_profile_id();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF v_pid IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM talent_engagements e WHERE e.applicant_user_id = auth.uid() AND e.status IN ('onboarding', 'active')) THEN
    RAISE EXCEPTION 'You have an active engagement. Ask the business to complete it first.' USING ERRCODE = '22023';
  END IF;
  UPDATE talent_applications SET status = 'withdrawn', decided_at = now()
    WHERE applicant_user_id = auth.uid() AND status IN ('submitted', 'reviewing', 'interview', 'offer');
  DELETE FROM talent_profiles WHERE id = v_pid;
END;
$$;

-- =============================================================
-- 10. COMPLIANCE ENGINE (single source of truth for the hire gate)
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_compute_compliance(p_application_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app talent_applications%ROWTYPE;
  v_post talent_postings%ROWTYPE;
  v_bg talent_background_checks%ROWTYPE;
  v_checks jsonb := '[]'::jsonb;
  v_ok boolean;
  v_n integer;
  v_status text;
  v_detail text;
  v_blockers integer;
BEGIN
  SELECT * INTO v_app FROM talent_applications WHERE id = p_application_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('checks', '[]'::jsonb, 'blockers', 0, 'can_hire', false);
  END IF;
  SELECT * INTO v_post FROM talent_postings WHERE id = v_app.posting_id;

  -- 1. Trade license
  IF v_post.requires_license THEN
    SELECT EXISTS (
      SELECT 1 FROM talent_credentials c
      WHERE c.profile_id = v_app.profile_id AND c.kind = 'license'
        AND (c.expires_on IS NULL OR c.expires_on >= current_date)
        AND (
          c.verification_status = 'verified'
          OR EXISTS (
            SELECT 1 FROM talent_credential_attestations a
            WHERE a.credential_id = c.id AND a.account_owner_id = v_app.account_owner_id AND a.outcome = 'verified'
          )
        )
    ) INTO v_ok;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'key', 'licenses', 'label', 'Trade license verified', 'blocking', true,
      'status', CASE WHEN v_ok THEN 'pass' ELSE 'fail' END,
      'detail', CASE WHEN v_ok THEN 'A current license is verified.'
                     ELSE 'No current, verified license. Verify one against the state board and attest it.' END
    ));
  END IF;

  -- 2. Expiring / expired credentials (warning only)
  SELECT count(*) INTO v_n FROM talent_credentials c
  WHERE c.profile_id = v_app.profile_id AND c.expires_on IS NOT NULL AND c.expires_on < current_date + 30;
  IF v_n > 0 THEN
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'key', 'credential_expiry', 'label', 'Credential expiry', 'blocking', false, 'status', 'warn',
      'detail', v_n::text || ' credential(s) expired or expire within 30 days.'
    ));
  END IF;

  -- 3. References
  IF v_post.min_references > 0 THEN
    SELECT count(*) INTO v_n FROM talent_references r WHERE r.profile_id = v_app.profile_id AND r.status = 'received';
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'key', 'references', 'label', 'References received', 'blocking', true,
      'status', CASE WHEN v_n >= v_post.min_references THEN 'pass' ELSE 'fail' END,
      'detail', v_n::text || ' of ' || v_post.min_references::text || ' required reference(s) received.'
    ));
  END IF;

  -- 4. Background check (only after a conditional offer; result alone never rejects anyone)
  IF v_post.requires_background_check THEN
    SELECT * INTO v_bg FROM talent_background_checks b
      WHERE b.application_id = p_application_id ORDER BY b.created_at DESC LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail';
      v_detail := 'Not started. Available after a conditional offer.';
    ELSIF v_bg.status IN ('pending_provider', 'invited', 'in_progress') THEN
      v_status := 'pending';
      v_detail := 'In progress with the screening provider.';
    ELSIF v_bg.status = 'complete' AND (v_bg.result = 'clear' OR v_bg.decision = 'engage') THEN
      v_status := 'pass';
      v_detail := CASE WHEN v_bg.result = 'clear' THEN 'Completed: clear.' ELSE 'Completed: reviewed, decision recorded to proceed.' END;
    ELSIF v_bg.status = 'complete' AND v_bg.decision IN ('pre_adverse_sent', 'adverse_final') THEN
      v_status := 'fail';
      v_detail := 'Adverse-action process is underway. Do not hire.';
    ELSIF v_bg.status = 'complete' THEN
      v_status := 'fail';
      v_detail := 'Individualized review required before any decision.';
    ELSE
      v_status := 'fail';
      v_detail := 'The check did not complete (' || v_bg.status || '). Start a new one.';
    END IF;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'key', 'background_check', 'label', 'Background check', 'blocking', true,
      'status', v_status, 'detail', v_detail
    ));
  END IF;

  -- 5. Classification reminder (informational)
  IF v_post.engagement_type = '1099' THEN
    v_checks := v_checks || jsonb_build_array(jsonb_build_object(
      'key', 'worker_classification', 'label', 'Contractor classification', 'blocking', false, 'status', 'info',
      'detail', 'Engaged as an independent contractor. Confirm classification with your advisor (ABC-test states).'
    ));
  END IF;

  SELECT count(*)::integer INTO v_blockers
  FROM jsonb_array_elements(v_checks) AS e(value)
  WHERE COALESCE((e.value ->> 'blocking')::boolean, false) AND (e.value ->> 'status') IN ('fail', 'pending');

  RETURN jsonb_build_object('checks', v_checks, 'blockers', v_blockers, 'can_hire', v_blockers = 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_application_compliance(p_application_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.talent_is_manager() OR NOT EXISTS (
    SELECT 1 FROM talent_applications a
    WHERE a.id = p_application_id AND a.account_owner_id = public.get_account_owner_id()
  ) THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;
  RETURN public.talent_compute_compliance(p_application_id);
END;
$$;

-- =============================================================
-- 11. BUSINESS RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_set_application_status(
  p_application_id uuid,
  p_status text,
  p_reason text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app talent_applications%ROWTYPE;
  v_title text;
  v_msg text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_app FROM talent_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND OR v_app.account_owner_id <> v_owner THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;
  IF v_app.status NOT IN ('submitted', 'reviewing', 'interview', 'offer') THEN
    RAISE EXCEPTION 'This application is already closed.' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('reviewing', 'interview', 'offer', 'rejected') THEN
    RAISE EXCEPTION 'Invalid status. Use the Hire action to hire.' USING ERRCODE = '22023';
  END IF;

  IF p_status = 'rejected' THEN
    IF p_reason IS NULL OR p_reason NOT IN ('not_a_fit', 'position_filled', 'missing_credentials', 'better_qualified_candidate', 'other') THEN
      RAISE EXCEPTION 'Choose a rejection reason. Background-check outcomes use their own process.' USING ERRCODE = '22023';
    END IF;
    UPDATE talent_applications
    SET status = 'rejected', decision_reason = p_reason,
        decision_note = left(NULLIF(btrim(COALESCE(p_note, '')), ''), 500), decided_at = now()
    WHERE id = v_app.id;
    UPDATE talent_background_checks SET status = 'canceled'
      WHERE application_id = v_app.id AND status IN ('pending_provider', 'invited', 'in_progress');
    v_msg := 'Your application was closed by the employer.';
  ELSE
    UPDATE talent_applications SET status = p_status WHERE id = v_app.id;
    v_msg := CASE p_status
      WHEN 'reviewing' THEN 'Your application is being reviewed.'
      WHEN 'interview' THEN 'You have been selected for an interview. The employer will contact you.'
      ELSE 'You received an offer. The employer will contact you with details.' END;
  END IF;

  SELECT t.title INTO v_title FROM talent_postings t WHERE t.id = v_app.posting_id;
  PERFORM public.talent_log_event(v_app.id, v_owner, 'manager', 'status_' || p_status,
    jsonb_build_object('from', v_app.status, 'reason', p_reason));
  PERFORM public.talent_notify(v_app.applicant_user_id, 'talent_application_update',
    'Update: ' || COALESCE(v_title, 'your application'), v_msg, '/talent/me');
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_attest_credential(
  p_application_id uuid,
  p_credential_id uuid,
  p_outcome text,
  p_method text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app talent_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_app FROM talent_applications WHERE id = p_application_id;
  IF NOT FOUND OR v_app.account_owner_id <> v_owner THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM talent_credentials c WHERE c.id = p_credential_id AND c.profile_id = v_app.profile_id) THEN
    RAISE EXCEPTION 'Credential not found for this applicant.' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('verified', 'not_verified')
     OR p_method IS NULL OR p_method NOT IN ('state_board_lookup', 'document_review', 'issuer_contact', 'other') THEN
    RAISE EXCEPTION 'Invalid attestation.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO talent_credential_attestations (credential_id, account_owner_id, application_id, outcome, method, note, attested_by)
  VALUES (p_credential_id, v_owner, v_app.id, p_outcome, p_method, left(NULLIF(btrim(COALESCE(p_note, '')), ''), 500), auth.uid())
  ON CONFLICT (credential_id, account_owner_id) DO UPDATE SET
    application_id = EXCLUDED.application_id, outcome = EXCLUDED.outcome, method = EXCLUDED.method,
    note = EXCLUDED.note, attested_by = EXCLUDED.attested_by, created_at = now();

  PERFORM public.talent_log_event(v_app.id, v_owner, 'manager', 'credential_attested',
    jsonb_build_object('credential_id', p_credential_id, 'outcome', p_outcome, 'method', p_method));
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_get_applicant(p_application_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app talent_applications%ROWTYPE;
  v_live boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_app FROM talent_applications WHERE id = p_application_id;
  IF NOT FOUND OR v_app.account_owner_id <> v_owner THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;

  v_live := v_app.profile_id IS NOT NULL AND v_app.status IN ('submitted', 'reviewing', 'interview', 'offer', 'hired');

  RETURN jsonb_build_object(
    'application', to_jsonb(v_app),
    'profile', CASE WHEN v_live THEN (
      SELECT jsonb_build_object(
        'display_name', p.display_name, 'headline', p.headline, 'bio', p.bio,
        'contact_email', p.contact_email, 'phone', p.phone, 'trades', to_jsonb(p.trades),
        'experience_years', p.experience_years, 'city', p.city, 'region', p.region, 'country', p.country,
        'open_to', to_jsonb(p.open_to), 'desired_hourly_cents', p.desired_hourly_cents, 'availability', p.availability)
      FROM talent_profiles p WHERE p.id = v_app.profile_id
    ) ELSE NULL END,
    'credentials', CASE WHEN v_live THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'name', c.name, 'issuing_authority', c.issuing_authority,
        'credential_number', c.credential_number, 'region', c.region, 'issued_on', c.issued_on,
        'expires_on', c.expires_on, 'document_path', c.document_path,
        'verification_status', c.verification_status, 'verification_method', c.verification_method,
        'attestation', (SELECT jsonb_build_object('outcome', a.outcome, 'method', a.method, 'note', a.note, 'at', a.created_at)
                        FROM talent_credential_attestations a
                        WHERE a.credential_id = c.id AND a.account_owner_id = v_owner)
      ) ORDER BY c.kind, c.name)
      FROM talent_credentials c WHERE c.profile_id = v_app.profile_id
    ), '[]'::jsonb) ELSE '[]'::jsonb END,
    'references', CASE WHEN v_live THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'referee_name', r.referee_name, 'relationship', r.relationship, 'company', r.company,
        'status', r.status, 'rating', r.response_rating, 'would_rehire', r.response_would_rehire,
        'strengths', to_jsonb(r.response_strengths), 'comment', r.response_comment, 'responded_at', r.responded_at
      ) ORDER BY r.created_at)
      FROM talent_references r WHERE r.profile_id = v_app.profile_id
    ), '[]'::jsonb) ELSE '[]'::jsonb END,
    'background_check', (
      SELECT jsonb_build_object(
        'id', b.id, 'status', b.status, 'result', b.result, 'decision', b.decision,
        'pre_adverse_sent_at', b.pre_adverse_sent_at, 'adverse_final_at', b.adverse_final_at,
        'requested_at', b.requested_at, 'completed_at', b.completed_at, 'package', b.package,
        'decision_note', b.decision_note
      )
      FROM talent_background_checks b WHERE b.application_id = v_app.id ORDER BY b.created_at DESC LIMIT 1
    ),
    'compliance', public.talent_compute_compliance(v_app.id),
    'reputation', CASE WHEN v_live THEN public.talent_worker_reputation(v_app.profile_id) ELSE NULL END,
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', x.kind, 'actor_role', x.actor_role, 'detail', x.detail, 'created_at', x.created_at)
                       ORDER BY x.created_at DESC)
      FROM (SELECT * FROM talent_application_events ev WHERE ev.application_id = v_app.id ORDER BY ev.created_at DESC LIMIT 50) x
    ), '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- 12. BACKGROUND CHECKS (FCRA-aware workflow; provider calls live in the edge function)
-- =============================================================

-- Manager authorizes + creates the check row. Only after a conditional offer, only if the posting requires it.
CREATE OR REPLACE FUNCTION public.talent_prepare_background_check(p_application_id uuid, p_package text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app talent_applications%ROWTYPE;
  v_post talent_postings%ROWTYPE;
  v_prof talent_profiles%ROWTYPE;
  v_pkg text := COALESCE(NULLIF(btrim(p_package), ''), 'default');
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_app FROM talent_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND OR v_app.account_owner_id <> v_owner THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;
  IF v_pkg !~ '^[a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'Invalid package name.' USING ERRCODE = '22023';
  END IF;
  IF v_app.status <> 'offer' THEN
    RAISE EXCEPTION 'Background checks can only start after a conditional offer (fair-chance laws).' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_post FROM talent_postings WHERE id = v_app.posting_id;
  IF NOT v_post.requires_background_check THEN
    RAISE EXCEPTION 'This posting does not require a background check.' USING ERRCODE = '22023';
  END IF;
  IF v_app.profile_id IS NULL THEN
    RAISE EXCEPTION 'The applicant removed their profile.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM talent_background_checks b WHERE b.application_id = v_app.id AND b.status IN ('pending_provider', 'invited', 'in_progress')) THEN
    RAISE EXCEPTION 'A background check is already in progress.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM talent_background_checks b WHERE b.application_id = v_app.id) >= 3 THEN
    RAISE EXCEPTION 'Maximum number of checks reached for this applicant.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_prof FROM talent_profiles WHERE id = v_app.profile_id;

  INSERT INTO talent_background_checks (application_id, account_owner_id, profile_id, applicant_user_id, package, requested_by)
  VALUES (v_app.id, v_owner, v_app.profile_id, v_app.applicant_user_id, v_pkg, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.talent_log_event(v_app.id, v_owner, 'manager', 'background_check_requested', jsonb_build_object('check_id', v_id));

  RETURN jsonb_build_object(
    'check_id', v_id,
    'package', v_pkg,
    'candidate', jsonb_build_object(
      'email', v_prof.contact_email,
      'name', v_prof.display_name,
      'city', v_prof.city,
      'region', v_prof.region,
      'country', v_prof.country
    )
  );
END;
$$;

-- Service role: attach provider identifiers (or a failure) after calling the provider.
CREATE OR REPLACE FUNCTION public.talent_background_set_provider(
  p_check_id uuid,
  p_candidate_id text,
  p_invitation_id text,
  p_invitation_url text,
  p_status text,
  p_error_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('invited', 'failed') THEN
    RAISE EXCEPTION 'Invalid status.' USING ERRCODE = '22023';
  END IF;
  UPDATE talent_background_checks
  SET provider_candidate_id = COALESCE(p_candidate_id, provider_candidate_id),
      provider_invitation_id = COALESCE(p_invitation_id, provider_invitation_id),
      invitation_url = COALESCE(left(p_invitation_url, 500), invitation_url),
      status = p_status,
      error_code = left(p_error_code, 60)
  WHERE id = p_check_id AND status = 'pending_provider';
END;
$$;

-- Service role: apply a verified webhook event. Idempotent by event id.
CREATE OR REPLACE FUNCTION public.talent_background_apply_event(
  p_event_id text,
  p_candidate_id text,
  p_invitation_id text,
  p_report_id text,
  p_status text,
  p_result text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_chk talent_background_checks%ROWTYPE;
  v_done boolean;
  v_name text;
BEGIN
  IF p_event_id IS NULL OR btrim(p_event_id) = '' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'missing_event_id');
  END IF;
  INSERT INTO talent_provider_events (provider, event_id) VALUES ('checkr', p_event_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'duplicate');
  END IF;
  IF p_status NOT IN ('invited', 'in_progress', 'complete', 'suspended', 'canceled', 'failed') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'ignored_status');
  END IF;

  SELECT * INTO v_chk FROM talent_background_checks b
  WHERE (p_report_id IS NOT NULL AND b.provider_report_id = p_report_id)
     OR (p_invitation_id IS NOT NULL AND b.provider_invitation_id = p_invitation_id)
     OR (p_candidate_id IS NOT NULL AND b.provider_candidate_id = p_candidate_id)
  ORDER BY b.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'unknown_check');
  END IF;
  IF v_chk.status IN ('canceled', 'complete') AND p_status <> 'complete' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'terminal');
  END IF;

  v_done := (p_status = 'complete');
  UPDATE talent_background_checks
  SET status = p_status,
      provider_report_id = COALESCE(p_report_id, provider_report_id),
      result = CASE WHEN v_done AND p_result IN ('clear', 'consider') THEN p_result ELSE result END,
      completed_at = CASE WHEN v_done THEN now() ELSE completed_at END,
      decision = CASE WHEN v_done AND p_result = 'consider' AND decision IS NULL THEN 'pending_review' ELSE decision END
  WHERE id = v_chk.id;

  IF v_done THEN
    SELECT COALESCE(NULLIF(a.profile_snapshot ->> 'display_name', ''), 'The applicant') INTO v_name
      FROM talent_applications a WHERE a.id = v_chk.application_id;
    PERFORM public.talent_notify(v_chk.account_owner_id, 'talent_background_complete',
      'Background check complete',
      v_name || '''s screening finished. Open the applicant to continue.',
      '/dashboard/talent?tab=applicants&app=' || v_chk.application_id::text);
  END IF;
  RETURN jsonb_build_object('applied', true);
END;
$$;

-- Individualized-assessment + adverse-action record keeping. Vireek records; the employer acts.
CREATE OR REPLACE FUNCTION public.talent_record_background_decision(
  p_check_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_chk talent_background_checks%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_chk FROM talent_background_checks WHERE id = p_check_id FOR UPDATE;
  IF NOT FOUND OR v_chk.account_owner_id <> v_owner THEN
    RAISE EXCEPTION 'Background check not found.' USING ERRCODE = '42501';
  END IF;
  IF v_chk.status <> 'complete' THEN
    RAISE EXCEPTION 'The check has not completed yet.' USING ERRCODE = '22023';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('engage', 'pre_adverse_sent', 'adverse_final') THEN
    RAISE EXCEPTION 'Invalid decision.' USING ERRCODE = '22023';
  END IF;
  IF v_chk.result = 'clear' AND p_decision <> 'engage' THEN
    RAISE EXCEPTION 'A clear result cannot start an adverse-action process.' USING ERRCODE = '22023';
  END IF;
  IF v_chk.decision = 'adverse_final' THEN
    RAISE EXCEPTION 'The adverse-action process is already final.' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'engage' THEN
    IF v_chk.result = 'consider' AND (v_note IS NULL OR char_length(v_note) < 20) THEN
      RAISE EXCEPTION 'Record your individualized assessment (at least 20 characters).' USING ERRCODE = '22023';
    END IF;
    UPDATE talent_background_checks
    SET decision = 'engage', decision_note = left(v_note, 1000), decided_by = auth.uid(), decided_at = now()
    WHERE id = v_chk.id;

  ELSIF p_decision = 'pre_adverse_sent' THEN
    IF v_chk.decision = 'pre_adverse_sent' THEN
      RAISE EXCEPTION 'Pre-adverse notice is already recorded.' USING ERRCODE = '22023';
    END IF;
    IF v_note IS NULL OR char_length(v_note) < 20 THEN
      RAISE EXCEPTION 'Record your individualized assessment (at least 20 characters).' USING ERRCODE = '22023';
    END IF;
    UPDATE talent_background_checks
    SET decision = 'pre_adverse_sent', pre_adverse_sent_at = now(), decision_note = left(v_note, 1000),
        decided_by = auth.uid(), decided_at = now()
    WHERE id = v_chk.id;

  ELSE
    IF v_chk.decision IS DISTINCT FROM 'pre_adverse_sent' OR v_chk.pre_adverse_sent_at IS NULL THEN
      RAISE EXCEPTION 'Send and record the pre-adverse-action notice first.' USING ERRCODE = '22023';
    END IF;
    IF public.talent_business_days_between(v_chk.pre_adverse_sent_at::date, current_date) < 5 THEN
      RAISE EXCEPTION 'Wait at least 5 business days after the pre-adverse notice so the candidate can respond.' USING ERRCODE = '22023';
    END IF;
    UPDATE talent_background_checks
    SET decision = 'adverse_final', adverse_final_at = now(), decided_by = auth.uid(), decided_at = now(),
        decision_note = COALESCE(left(v_note, 1000), decision_note)
    WHERE id = v_chk.id;
    UPDATE talent_applications
    SET status = 'rejected', decision_reason = 'background_check_adverse', decided_at = now()
    WHERE id = v_chk.application_id AND status IN ('submitted', 'reviewing', 'interview', 'offer');
    PERFORM public.talent_notify(v_chk.applicant_user_id, 'talent_application_update',
      'Your application was closed',
      'Check your email for the notices the employer is required to send you.', '/talent/me');
  END IF;

  PERFORM public.talent_log_event(v_chk.application_id, v_owner, 'manager', 'background_decision_' || p_decision,
    jsonb_build_object('check_id', v_chk.id));
END;
$$;

-- =============================================================
-- 13. HIRE: technician account + payroll record + engagement, atomically
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_hire_applicant(
  p_application_id uuid,
  p_engagement_type text,
  p_starts_on date,
  p_ends_on date,
  p_hourly_rate_cents integer,
  p_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app talent_applications%ROWTYPE;
  v_post talent_postings%ROWTYPE;
  v_prof talent_profiles%ROWTYPE;
  v_comp jsonb;
  v_keys text[];
  v_override text := NULLIF(btrim(COALESCE(p_override_reason, '')), '');
  v_tm uuid;
  v_emp uuid;
  v_eng uuid;
  v_hired integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to hire.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_app FROM talent_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND OR v_app.account_owner_id <> v_owner THEN
    RAISE EXCEPTION 'Application not found.' USING ERRCODE = '42501';
  END IF;
  IF v_app.status <> 'offer' THEN
    RAISE EXCEPTION 'Move the applicant to Offer before hiring.' USING ERRCODE = '22023';
  END IF;
  IF v_app.profile_id IS NULL THEN
    RAISE EXCEPTION 'The applicant removed their profile.' USING ERRCODE = '22023';
  END IF;
  IF p_engagement_type IS NULL OR p_engagement_type NOT IN ('w2', '1099') THEN
    RAISE EXCEPTION 'Choose W-2 employee or 1099 contractor.' USING ERRCODE = '22023';
  END IF;
  IF p_starts_on IS NULL OR (p_ends_on IS NOT NULL AND p_ends_on < p_starts_on) THEN
    RAISE EXCEPTION 'Enter a valid start date (and an end date after it).' USING ERRCODE = '22023';
  END IF;
  IF p_hourly_rate_cents IS NULL OR p_hourly_rate_cents <= 0 OR p_hourly_rate_cents > 100000 THEN
    RAISE EXCEPTION 'Enter an hourly rate between $0.01 and $1,000.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_post FROM talent_postings WHERE id = v_app.posting_id;
  SELECT * INTO v_prof FROM talent_profiles WHERE id = v_app.profile_id;

  v_comp := public.talent_compute_compliance(v_app.id);
  SELECT COALESCE(array_agg(e.value ->> 'key'), '{}'::text[]) INTO v_keys
  FROM jsonb_array_elements(v_comp -> 'checks') AS e(value)
  WHERE COALESCE((e.value ->> 'blocking')::boolean, false) AND (e.value ->> 'status') IN ('fail', 'pending');

  IF 'background_check' = ANY (v_keys) THEN
    RAISE EXCEPTION 'The background-check requirement is not satisfied. This cannot be overridden.' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_keys) > 0 THEN
    IF v_override IS NULL OR char_length(v_override) < 20 THEN
      RAISE EXCEPTION 'Compliance blockers: %. Resolve them or record an override reason (at least 20 characters).',
        array_to_string(v_keys, ', ') USING ERRCODE = '22023';
    END IF;
    PERFORM public.talent_log_event(v_app.id, v_owner, 'manager', 'compliance_override',
      jsonb_build_object('blockers', to_jsonb(v_keys), 'reason', left(v_override, 500)));
  END IF;

  -- Technician account (invite is sent by the client through send-team-invite)
  SELECT m.id INTO v_tm FROM team_members m
    WHERE m.account_owner_id = v_owner AND lower(m.member_email) = lower(v_prof.contact_email) LIMIT 1;
  IF v_tm IS NULL THEN
    INSERT INTO team_members (account_owner_id, member_email, member_name, role, invite_status)
    VALUES (v_owner, v_prof.contact_email, v_prof.display_name, 'technician', 'pending')
    RETURNING id INTO v_tm;
  END IF;

  -- Payroll record
  SELECT e.id INTO v_emp FROM employees e WHERE e.user_id = v_owner AND e.team_member_id = v_tm LIMIT 1;
  IF v_emp IS NULL THEN
    INSERT INTO employees (user_id, team_member_id, full_name, employment_type, pay_type, hourly_rate_cents)
    VALUES (v_owner, v_tm, v_prof.display_name, p_engagement_type, 'hourly', p_hourly_rate_cents)
    RETURNING id INTO v_emp;
  END IF;

  -- Feed verified credentials into the existing compliance dispatch gate (never blocks the hire)
  BEGIN
    INSERT INTO technician_credentials (user_id, technician_id, credential_type, credential_name,
                                        issuing_authority, credential_number, issued_at, expires_at, status)
    SELECT v_owner, v_tm, c.name, c.name, c.issuing_authority, c.credential_number, c.issued_on, c.expires_on, 'active'
    FROM talent_credentials c
    WHERE c.profile_id = v_app.profile_id
      AND (c.expires_on IS NULL OR c.expires_on >= current_date)
      AND (c.verification_status = 'verified' OR EXISTS (
            SELECT 1 FROM talent_credential_attestations a
            WHERE a.credential_id = c.id AND a.account_owner_id = v_owner AND a.outcome = 'verified'))
      AND NOT EXISTS (SELECT 1 FROM technician_credentials t WHERE t.technician_id = v_tm AND t.credential_type = c.name);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'talent_hire_applicant: credential copy skipped: %', SQLERRM;
  END;

  INSERT INTO talent_engagements (application_id, posting_id, account_owner_id, profile_id, applicant_user_id,
                                  team_member_id, employee_id, kind, engagement_type, starts_on, ends_on)
  VALUES (v_app.id, v_post.id, v_owner, v_app.profile_id, v_app.applicant_user_id,
          v_tm, v_emp, v_post.kind, p_engagement_type, p_starts_on, p_ends_on)
  RETURNING id INTO v_eng;

  UPDATE talent_applications SET status = 'hired', decided_at = now() WHERE id = v_app.id;

  SELECT count(*)::integer INTO v_hired FROM talent_applications a WHERE a.posting_id = v_post.id AND a.status = 'hired';
  IF v_hired >= v_post.headcount AND v_post.status = 'open' THEN
    UPDATE talent_postings SET status = 'filled' WHERE id = v_post.id;
  END IF;

  PERFORM public.talent_log_event(v_app.id, v_owner, 'manager', 'hired',
    jsonb_build_object('engagement_id', v_eng, 'engagement_type', p_engagement_type));
  PERFORM public.talent_notify(v_app.applicant_user_id, 'talent_hired',
    'You are hired: ' || v_post.title,
    'Check your email for your team invite to finish setting up your technician account.', '/talent/me');

  RETURN jsonb_build_object(
    'engagement_id', v_eng, 'team_member_id', v_tm, 'employee_id', v_emp,
    'invite_email', v_prof.contact_email, 'member_name', v_prof.display_name
  );
END;
$$;

-- =============================================================
-- 14. ENGAGEMENTS: onboarding checklist, completion, listing
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_mark_onboarding_item(
  p_engagement_id uuid,
  p_item text,
  p_done boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eng talent_engagements%ROWTYPE;
  v_ts timestamptz := CASE WHEN COALESCE(p_done, true) THEN now() ELSE NULL END;
  v_complete boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_eng FROM talent_engagements
    WHERE id = p_engagement_id AND account_owner_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;
  IF v_eng.status NOT IN ('onboarding', 'active') THEN
    RAISE EXCEPTION 'This engagement has ended.' USING ERRCODE = '22023';
  END IF;

  -- Vireek records completion only. SSNs, TINs and ID documents never enter this system.
  IF p_item = 'agreement_signed' THEN
    UPDATE talent_engagements SET agreement_signed_at = v_ts WHERE id = v_eng.id;
  ELSIF p_item = 'tax_form_received' THEN
    UPDATE talent_engagements SET tax_form_received_at = v_ts WHERE id = v_eng.id;
  ELSIF p_item = 'direct_deposit_set' THEN
    UPDATE talent_engagements SET direct_deposit_set_at = v_ts WHERE id = v_eng.id;
  ELSIF p_item = 'i9_completed' THEN
    IF v_eng.engagement_type <> 'w2' THEN
      RAISE EXCEPTION 'Form I-9 applies to W-2 employees only.' USING ERRCODE = '22023';
    END IF;
    UPDATE talent_engagements SET i9_completed_at = v_ts WHERE id = v_eng.id;
  ELSE
    RAISE EXCEPTION 'Unknown checklist item.' USING ERRCODE = '22023';
  END IF;

  SELECT (e.agreement_signed_at IS NOT NULL AND e.tax_form_received_at IS NOT NULL
          AND (e.engagement_type = '1099' OR e.i9_completed_at IS NOT NULL))
  INTO v_complete FROM talent_engagements e WHERE e.id = v_eng.id;

  UPDATE talent_engagements
  SET onboarding_completed_at = CASE WHEN v_complete THEN COALESCE(onboarding_completed_at, now()) ELSE NULL END,
      status = CASE WHEN v_complete THEN 'active' ELSE 'onboarding' END
  WHERE id = v_eng.id;

  PERFORM public.talent_log_event(v_eng.application_id, v_eng.account_owner_id, 'manager',
    'onboarding_' || p_item, jsonb_build_object('done', COALESCE(p_done, true)));
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_complete_engagement(
  p_engagement_id uuid,
  p_outcome text DEFAULT 'completed',
  p_ends_on date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eng talent_engagements%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('completed', 'terminated') THEN
    RAISE EXCEPTION 'Invalid outcome.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_eng FROM talent_engagements
    WHERE id = p_engagement_id AND account_owner_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;
  IF v_eng.status NOT IN ('onboarding', 'active') THEN
    RAISE EXCEPTION 'This engagement has already ended.' USING ERRCODE = '22023';
  END IF;

  UPDATE talent_engagements
  SET status = p_outcome, completed_at = now(),
      ends_on = GREATEST(COALESCE(p_ends_on, ends_on, current_date), starts_on)
  WHERE id = v_eng.id;

  -- Stop dispatching to gig workers once the gig ends (never blocks completion).
  IF v_eng.kind = 'gig' AND v_eng.team_member_id IS NOT NULL THEN
    BEGIN
      UPDATE team_members SET dispatch_enabled = false WHERE id = v_eng.team_member_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'talent_complete_engagement: dispatch toggle skipped: %', SQLERRM;
    END;
  END IF;

  PERFORM public.talent_log_event(v_eng.application_id, v_eng.account_owner_id, 'manager', 'engagement_' || p_outcome, '{}'::jsonb);
  PERFORM public.talent_notify(v_eng.applicant_user_id, 'talent_rating_received',
    'Engagement ended: rate your experience',
    'Share a rating. Ratings stay private until both sides submit or 14 days pass.', '/talent/me');
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_list_engagements_business()
RETURNS TABLE (
  engagement_id uuid, application_id uuid, posting_title text, kind text, worker_name text,
  engagement_type text, status text, starts_on date, ends_on date,
  agreement_signed_at timestamptz, tax_form_received_at timestamptz, i9_completed_at timestamptz,
  direct_deposit_set_at timestamptz, onboarding_completed_at timestamptz, completed_at timestamptz,
  team_member_id uuid, my_rating_submitted boolean, counterpart_revealed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.talent_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to do that.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.application_id, p.title, e.kind,
         COALESCE(NULLIF(a.profile_snapshot ->> 'display_name', ''), 'Worker'),
         e.engagement_type, e.status, e.starts_on, e.ends_on,
         e.agreement_signed_at, e.tax_form_received_at, e.i9_completed_at,
         e.direct_deposit_set_at, e.onboarding_completed_at, e.completed_at, e.team_member_id,
         EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = e.id AND r.direction = 'business_to_worker'),
         (EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = e.id AND r.direction = 'worker_to_business')
          AND (EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = e.id AND r.direction = 'business_to_worker')
               OR e.completed_at <= now() - interval '14 days'))
  FROM talent_engagements e
  JOIN talent_postings p ON p.id = e.posting_id
  JOIN talent_applications a ON a.id = e.application_id
  WHERE e.account_owner_id = public.get_account_owner_id()
  ORDER BY e.created_at DESC
  LIMIT 200;
END;
$$;

-- =============================================================
-- 15. RATINGS (double-blind)
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_submit_rating(
  p_engagement_id uuid,
  p_rating smallint,
  p_tags text[] DEFAULT '{}'::text[],
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_eng talent_engagements%ROWTYPE;
  v_dir text;
  v_allowed text[];
  v_tags text[];
  v_other boolean;
  v_target uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'Rating must be between 1 and 5.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_eng FROM talent_engagements WHERE id = p_engagement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;
  IF v_eng.status NOT IN ('completed', 'terminated') THEN
    RAISE EXCEPTION 'You can rate once the engagement has ended.' USING ERRCODE = '22023';
  END IF;

  IF v_eng.account_owner_id = public.get_account_owner_id() AND public.talent_is_manager() THEN
    v_dir := 'business_to_worker';
    v_allowed := public.talent_worker_rating_tags();
    v_target := v_eng.applicant_user_id;
  ELSIF v_eng.applicant_user_id = v_uid THEN
    v_dir := 'worker_to_business';
    v_allowed := public.talent_business_rating_tags();
    v_target := v_eng.account_owner_id;
  ELSE
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;

  v_tags := ARRAY(
    SELECT DISTINCT t FROM unnest(COALESCE(p_tags, '{}'::text[])) AS u(t)
    WHERE t = ANY (v_allowed) ORDER BY t LIMIT 5
  );

  BEGIN
    INSERT INTO talent_ratings (engagement_id, direction, rater_user_id, ratee_profile_id, ratee_account_id, rating, tags, comment)
    VALUES (
      v_eng.id, v_dir, v_uid,
      CASE WHEN v_dir = 'business_to_worker' THEN v_eng.profile_id ELSE NULL END,
      CASE WHEN v_dir = 'worker_to_business' THEN v_eng.account_owner_id ELSE NULL END,
      p_rating, v_tags, left(NULLIF(btrim(COALESCE(p_comment, '')), ''), 600)
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You already rated this engagement.' USING ERRCODE = '22023';
  END;

  SELECT EXISTS (
    SELECT 1 FROM talent_ratings r WHERE r.engagement_id = v_eng.id
      AND r.direction = CASE WHEN v_dir = 'business_to_worker' THEN 'worker_to_business' ELSE 'business_to_worker' END
  ) INTO v_other;

  PERFORM public.talent_notify(v_target, 'talent_rating_received', 'You received a new rating',
    CASE WHEN v_other THEN 'Both ratings are now visible.' ELSE 'It becomes visible when you submit yours or after 14 days.' END,
    CASE WHEN v_dir = 'business_to_worker' THEN '/talent/me' ELSE '/dashboard/talent?tab=engagements' END);

  RETURN jsonb_build_object('ok', true, 'revealed', v_other);
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_get_engagement_ratings(p_engagement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_eng talent_engagements%ROWTYPE;
  v_mine text;
  v_theirs text;
  v_revealed boolean;
BEGIN
  SELECT * INTO v_eng FROM talent_engagements WHERE id = p_engagement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;
  IF v_eng.account_owner_id = public.get_account_owner_id() AND public.talent_is_manager() THEN
    v_mine := 'business_to_worker'; v_theirs := 'worker_to_business';
  ELSIF v_eng.applicant_user_id = v_uid THEN
    v_mine := 'worker_to_business'; v_theirs := 'business_to_worker';
  ELSE
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;

  v_revealed := EXISTS (SELECT 1 FROM talent_ratings r WHERE r.engagement_id = v_eng.id AND r.direction = v_mine)
                OR (v_eng.completed_at IS NOT NULL AND v_eng.completed_at <= now() - interval '14 days');

  RETURN jsonb_build_object(
    'mine', (SELECT jsonb_build_object('rating', r.rating, 'tags', to_jsonb(r.tags), 'comment', r.comment)
             FROM talent_ratings r WHERE r.engagement_id = v_eng.id AND r.direction = v_mine),
    'theirs', CASE WHEN v_revealed THEN
              (SELECT jsonb_build_object('rating', r.rating, 'tags', to_jsonb(r.tags), 'comment', r.comment)
               FROM talent_ratings r WHERE r.engagement_id = v_eng.id AND r.direction = v_theirs)
              ELSE NULL END,
    'revealed', v_revealed
  );
END;
$$;

-- =============================================================
-- 16. SERVICE-ROLE FUNCTIONS
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_issue_reference_token(p_user_id uuid, p_reference_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref talent_references%ROWTYPE;
  v_prof talent_profiles%ROWTYPE;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_prof FROM talent_profiles WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ref FROM talent_references WHERE id = p_reference_id AND profile_id = v_prof.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reference not found.' USING ERRCODE = '42501';
  END IF;
  IF v_ref.status IN ('received', 'declined') THEN
    RAISE EXCEPTION 'This reference has already responded.' USING ERRCODE = '22023';
  END IF;
  IF v_ref.requested_at IS NOT NULL AND v_ref.requested_at > now() - interval '24 hours' THEN
    RAISE EXCEPTION 'You can re-send a request once every 24 hours.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM talent_references r WHERE r.profile_id = v_prof.id AND r.requested_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'Daily reference-request limit reached.' USING ERRCODE = '22023';
  END IF;

  UPDATE talent_references
  SET status = 'requested', request_token = v_token, request_expires_at = now() + interval '14 days',
      requested_at = now(), request_count = LEAST(request_count + 1, 100)
  WHERE id = v_ref.id;

  RETURN jsonb_build_object(
    'token', v_token, 'referee_email', v_ref.referee_email, 'referee_name', v_ref.referee_name,
    'worker_name', v_prof.display_name, 'expires_at', now() + interval '14 days'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_system_set_credential_verification(
  p_credential_id uuid,
  p_status text,
  p_method text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('pending', 'verified', 'failed', 'expired') OR p_method NOT IN ('primary_source', 'manual_review') THEN
    RAISE EXCEPTION 'Invalid verification values.' USING ERRCODE = '22023';
  END IF;
  UPDATE talent_credentials
  SET verification_status = p_status,
      verification_method = p_method,
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE NULL END,
      verification_note = left(p_note, 500)
  WHERE id = p_credential_id;
END;
$$;

-- Daily sweep (pg_cron or edge scheduler): expire stale verifications, warn workers 30 days ahead.
CREATE OR REPLACE FUNCTION public.talent_sweep_credentials()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer := 0;
  v_warned integer := 0;
  r record;
BEGIN
  UPDATE talent_credentials
  SET verification_status = 'expired'
  WHERE expires_on IS NOT NULL AND expires_on < current_date AND verification_status IN ('verified', 'pending');
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  FOR r IN
    SELECT c.id, c.name, c.expires_on, p.user_id
    FROM talent_credentials c
    JOIN talent_profiles p ON p.id = c.profile_id
    WHERE c.expires_on IS NOT NULL
      AND c.expires_on BETWEEN current_date AND current_date + 30
      AND c.expiry_notified_at IS NULL
    LIMIT 500
  LOOP
    PERFORM public.talent_notify(r.user_id, 'talent_credential_expiring',
      'Credential expiring: ' || r.name,
      'It expires on ' || to_char(r.expires_on, 'YYYY-MM-DD') || '. Update it to stay eligible for work.', '/talent/me');
    UPDATE talent_credentials SET expiry_notified_at = now() WHERE id = r.id;
    v_warned := v_warned + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'warned', v_warned);
END;
$$;

-- =============================================================
-- 17. FUNCTION PRIVILEGES (deny by default, then explicit allow-lists)
-- =============================================================

DO $$
DECLARE
  r record;
  v_public text[] := ARRAY[
    'talent_list_open_postings', 'talent_get_open_posting', 'talent_get_reference_request', 'talent_submit_reference',
    'talent_trades', 'talent_worker_rating_tags', 'talent_business_rating_tags', 'talent_reference_strengths',
    'talent_business_days_between'
  ];
  v_authenticated text[] := ARRAY[
    'talent_is_manager', 'talent_my_profile_id', 'talent_business_can_read_doc',
    'talent_save_profile', 'talent_accept_terms', 'talent_apply', 'talent_withdraw_application',
    'talent_my_applications', 'talent_my_reputation', 'talent_list_engagements_worker',
    'talent_export_my_data', 'talent_delete_my_profile',
    'talent_application_compliance', 'talent_set_application_status', 'talent_attest_credential',
    'talent_get_applicant', 'talent_prepare_background_check', 'talent_record_background_decision',
    'talent_hire_applicant', 'talent_mark_onboarding_item', 'talent_complete_engagement',
    'talent_list_engagements_business', 'talent_submit_rating', 'talent_get_engagement_ratings'
  ];
  v_service text[] := ARRAY[
    'talent_issue_reference_token', 'talent_background_set_provider', 'talent_background_apply_event',
    'talent_system_set_credential_verification', 'talent_sweep_credentials'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname AS fname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'talent\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    IF r.fname = ANY (v_public) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', r.sig);
    ELSIF r.fname = ANY (v_authenticated) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    ELSIF r.fname = ANY (v_service) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
  END LOOP;
END;
$$;
