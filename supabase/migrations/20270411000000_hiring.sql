/*
  # Hiring: public job postings + applications

  Vireek's OWN hiring (platform level, not tenant data), so there is no account_owner_id.
  Staff = profiles.is_staff via is_vireek_staff(auth.uid()) (20260913020000_live_chat_and_academy.sql).

  ## Objects
  - job_postings        : public read of OPEN rows only; staff manage everything
  - job_applications    : staff only; rows are created ONLY by submit_job_application()
  - job_posting_stats   : applicant counts per posting (security_invoker view, staff-only effect)
  - submit_job_application : anon-callable RPC (validation, honeypot, throttles, idempotent)

  ## Security
  - No client INSERT policy on job_applications. The RPC is the only write path.
  - Re-applying to the same role with the same email is a silent no-op, so the form never
    reveals who has applied.
  - Applicant-supplied columns are frozen after insert (staff may only change status/rating/notes).
*/

-- 1) Postings ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL,
  department text NOT NULL,
  location text NOT NULL,
  location_type text NOT NULL DEFAULT 'remote',
  employment_type text NOT NULL DEFAULT 'full_time',
  summary text NOT NULL,
  description text NOT NULL,
  responsibilities text[] NOT NULL DEFAULT '{}',
  requirements text[] NOT NULL DEFAULT '{}',
  salary_min integer,
  salary_max integer,
  salary_currency text NOT NULL DEFAULT 'USD',
  salary_period text NOT NULL DEFAULT 'year',
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
  CONSTRAINT jp_title_check CHECK (char_length(btrim(title)) BETWEEN 3 AND 120),
  CONSTRAINT jp_department_check CHECK (char_length(btrim(department)) BETWEEN 2 AND 60),
  CONSTRAINT jp_location_check CHECK (char_length(btrim(location)) BETWEEN 2 AND 100),
  CONSTRAINT jp_summary_check CHECK (char_length(btrim(summary)) BETWEEN 10 AND 300),
  CONSTRAINT jp_description_check CHECK (char_length(btrim(description)) BETWEEN 20 AND 10000),
  CONSTRAINT jp_location_type_check CHECK (location_type IN ('remote', 'hybrid', 'onsite')),
  CONSTRAINT jp_employment_type_check CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'internship')),
  CONSTRAINT jp_status_check CHECK (status IN ('draft', 'open', 'closed')),
  CONSTRAINT jp_lists_check CHECK (cardinality(responsibilities) <= 20 AND cardinality(requirements) <= 20),
  CONSTRAINT jp_salary_check CHECK (
    (salary_min IS NULL AND salary_max IS NULL)
    OR (salary_min IS NOT NULL AND salary_max IS NOT NULL AND salary_min > 0 AND salary_min <= salary_max)
  ),
  CONSTRAINT jp_currency_check CHECK (salary_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT jp_period_check CHECK (salary_period IN ('year', 'hour'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jp_slug ON job_postings(slug);
CREATE INDEX IF NOT EXISTS idx_jp_status ON job_postings(status, published_at DESC);

CREATE OR REPLACE FUNCTION public.job_postings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.published_at IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
      RAISE EXCEPTION 'The URL slug cannot change after a posting has been published (it would break public links).'
        USING ERRCODE = '22023';
    END IF;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  IF NEW.status = 'open' THEN
    NEW.published_at := COALESCE(NEW.published_at, now());
    NEW.closed_at := NULL;
  ELSIF NEW.status = 'closed' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_postings_guard ON job_postings;
CREATE TRIGGER trg_job_postings_guard
  BEFORE INSERT OR UPDATE ON job_postings
  FOR EACH ROW EXECUTE FUNCTION public.job_postings_guard();

ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jp_public_select" ON job_postings;
CREATE POLICY "jp_public_select" ON job_postings FOR SELECT TO anon, authenticated
  USING (status = 'open');

DROP POLICY IF EXISTS "jp_staff_select" ON job_postings;
CREATE POLICY "jp_staff_select" ON job_postings FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "jp_staff_insert" ON job_postings;
CREATE POLICY "jp_staff_insert" ON job_postings FOR INSERT TO authenticated
  WITH CHECK (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "jp_staff_update" ON job_postings;
CREATE POLICY "jp_staff_update" ON job_postings FOR UPDATE TO authenticated
  USING (is_vireek_staff(auth.uid())) WITH CHECK (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "jp_staff_delete" ON job_postings;
CREATE POLICY "jp_staff_delete" ON job_postings FOR DELETE TO authenticated
  USING (is_vireek_staff(auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON job_postings FROM anon;

-- 2) Applications -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  location text,
  linkedin_url text,
  portfolio_url text,
  resume_url text,
  cover_note text,
  referral_source text,
  consent_given_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new',
  rating smallint,
  staff_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ja_name_check CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 120),
  CONSTRAINT ja_email_check CHECK (char_length(email) <= 254 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT ja_status_check CHECK (status IN ('new', 'reviewing', 'interview', 'offer', 'hired', 'rejected')),
  CONSTRAINT ja_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT ja_text_check CHECK (
    (phone IS NULL OR char_length(phone) <= 40)
    AND (location IS NULL OR char_length(location) <= 100)
    AND (referral_source IS NULL OR char_length(referral_source) <= 100)
    AND (cover_note IS NULL OR char_length(cover_note) <= 3000)
    AND (staff_notes IS NULL OR char_length(staff_notes) <= 4000)
  ),
  CONSTRAINT ja_urls_check CHECK (
    (linkedin_url IS NULL OR linkedin_url ~* '^https?://\S{3,490}$')
    AND (portfolio_url IS NULL OR portfolio_url ~* '^https?://\S{3,490}$')
    AND (resume_url IS NULL OR resume_url ~* '^https?://\S{3,490}$')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ja_unique ON job_applications(posting_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_ja_posting ON job_applications(posting_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ja_created ON job_applications(created_at DESC);

CREATE OR REPLACE FUNCTION public.job_applications_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.posting_id IS DISTINCT FROM OLD.posting_id
     OR NEW.full_name IS DISTINCT FROM OLD.full_name
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.consent_given_at IS DISTINCT FROM OLD.consent_given_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Applicant-supplied fields are immutable' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_applications_guard ON job_applications;
CREATE TRIGGER trg_job_applications_guard
  BEFORE UPDATE ON job_applications
  FOR EACH ROW EXECUTE FUNCTION public.job_applications_guard();

ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ja_staff_select" ON job_applications;
CREATE POLICY "ja_staff_select" ON job_applications FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "ja_staff_update" ON job_applications;
CREATE POLICY "ja_staff_update" ON job_applications FOR UPDATE TO authenticated
  USING (is_vireek_staff(auth.uid())) WITH CHECK (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "ja_staff_delete" ON job_applications;
CREATE POLICY "ja_staff_delete" ON job_applications FOR DELETE TO authenticated
  USING (is_vireek_staff(auth.uid()));

REVOKE INSERT ON job_applications FROM anon, authenticated;
REVOKE SELECT, UPDATE, DELETE ON job_applications FROM anon;

-- 3) Stats view ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW job_posting_stats WITH (security_invoker = true) AS
SELECT
  p.id AS posting_id,
  count(a.id) AS applicants_total,
  count(a.id) FILTER (WHERE a.status = 'new') AS applicants_new
FROM job_postings p
LEFT JOIN job_applications a ON a.posting_id = p.id
GROUP BY p.id;

GRANT SELECT ON job_posting_stats TO authenticated;

-- 4) Public submit RPC ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_job_application(
  p_slug text,
  p_full_name text,
  p_email text,
  p_phone text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_linkedin_url text DEFAULT NULL,
  p_portfolio_url text DEFAULT NULL,
  p_resume_url text DEFAULT NULL,
  p_cover_note text DEFAULT NULL,
  p_referral_source text DEFAULT NULL,
  p_consent boolean DEFAULT false,
  p_website text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_posting_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_full_name, ''));
BEGIN
  -- Honeypot: real people never see or fill this field. Pretend success, store nothing.
  IF btrim(coalesce(p_website, '')) <> '' THEN
    RETURN jsonb_build_object('ok', true);
  END IF;

  IF NOT coalesce(p_consent, false) THEN
    RAISE EXCEPTION 'Please confirm that we may process your application data.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'Please enter your full name.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_email) > 254 OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_linkedin_url, '') <> '' AND p_linkedin_url !~* '^https?://\S{3,490}$' THEN
    RAISE EXCEPTION 'Links must start with http:// or https:// and contain no spaces.' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_portfolio_url, '') <> '' AND p_portfolio_url !~* '^https?://\S{3,490}$' THEN
    RAISE EXCEPTION 'Links must start with http:// or https:// and contain no spaces.' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_resume_url, '') <> '' AND p_resume_url !~* '^https?://\S{3,490}$' THEN
    RAISE EXCEPTION 'Links must start with http:// or https:// and contain no spaces.' USING ERRCODE = '22023';
  END IF;
  IF char_length(coalesce(p_cover_note, '')) > 3000 THEN
    RAISE EXCEPTION 'Please keep your note under 3,000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_posting_id FROM job_postings WHERE slug = p_slug AND status = 'open';
  IF v_posting_id IS NULL THEN
    RAISE EXCEPTION 'This position is no longer accepting applications.' USING ERRCODE = 'P0002';
  END IF;

  IF (SELECT count(*) FROM job_applications
      WHERE lower(email) = v_email AND created_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'Too many applications from this email. Please try again tomorrow.' USING ERRCODE = '54000';
  END IF;
  IF (SELECT count(*) FROM job_applications WHERE created_at > now() - interval '1 hour') >= 200 THEN
    RAISE EXCEPTION 'We are receiving a lot of applications right now. Please try again in a little while.'
      USING ERRCODE = '54000';
  END IF;

  INSERT INTO job_applications (
    posting_id, full_name, email, phone, location, linkedin_url, portfolio_url, resume_url,
    cover_note, referral_source
  ) VALUES (
    v_posting_id, v_name, v_email,
    NULLIF(btrim(coalesce(p_phone, '')), ''),
    NULLIF(btrim(coalesce(p_location, '')), ''),
    NULLIF(btrim(coalesce(p_linkedin_url, '')), ''),
    NULLIF(btrim(coalesce(p_portfolio_url, '')), ''),
    NULLIF(btrim(coalesce(p_resume_url, '')), ''),
    NULLIF(btrim(coalesce(p_cover_note, '')), ''),
    NULLIF(btrim(coalesce(p_referral_source, '')), '')
  )
  ON CONFLICT DO NOTHING;  -- same email + same posting: succeed silently (no applicant enumeration)

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_job_application(text, text, text, text, text, text, text, text, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_job_application(text, text, text, text, text, text, text, text, text, text, boolean, text) TO anon, authenticated;
