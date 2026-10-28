/*
  # Job-board syndication (Indeed / ZipRecruiter / LinkedIn)

  Vireek's OWN hiring (platform level, no account_owner_id). Staff = is_vireek_staff(auth.uid()).

  ## Objects
  - job_postings: 4 new OPTIONAL structured-location columns (city, region, country, postal_code)
  - job_board_feeds: one row per board (on/off switch, LinkedIn company id + poster email, fetch stats)
  - record_job_feed_fetch(): service-role-only RPC the public feed function calls to record a crawl

  ## Security
  - job_board_feeds is staff-only (RLS). Staff may change ONLY enabled / linkedin_company_id / poster_email
    (column-level UPDATE grant); stats columns are written solely by the service-role RPC.
  - No client INSERT/DELETE: the three rows are seeded here.
  - The public feed itself reads only OPEN postings and exposes nothing that is not already on /careers.
*/

-- 1) Structured location on postings ----------------------------------------------------------
ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS city text CHECK (city IS NULL OR char_length(btrim(city)) BETWEEN 2 AND 80),
  ADD COLUMN IF NOT EXISTS region text CHECK (region IS NULL OR char_length(btrim(region)) BETWEEN 2 AND 80),
  ADD COLUMN IF NOT EXISTS country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS postal_code text CHECK (postal_code IS NULL OR char_length(btrim(postal_code)) BETWEEN 2 AND 12);

-- 2) Board settings + stats -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_board_feeds (
  board text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  linkedin_company_id text,
  poster_email text,
  enabled_at timestamptz,
  last_fetched_at timestamptz,
  fetch_count bigint NOT NULL DEFAULT 0,
  last_job_count integer,
  last_skipped_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jbf_board_check CHECK (board IN ('indeed', 'ziprecruiter', 'linkedin')),
  CONSTRAINT jbf_company_id_check CHECK (linkedin_company_id IS NULL OR linkedin_company_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT jbf_email_check CHECK (
    poster_email IS NULL OR (char_length(poster_email) <= 254 AND poster_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  )
);

CREATE OR REPLACE FUNCTION public.job_board_feeds_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.board := OLD.board;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  IF NEW.enabled AND NOT OLD.enabled THEN
    NEW.enabled_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_board_feeds_guard ON job_board_feeds;
CREATE TRIGGER trg_job_board_feeds_guard
  BEFORE UPDATE ON job_board_feeds
  FOR EACH ROW EXECUTE FUNCTION public.job_board_feeds_guard();

ALTER TABLE job_board_feeds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jbf_staff_select" ON job_board_feeds;
CREATE POLICY "jbf_staff_select" ON job_board_feeds FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "jbf_staff_update" ON job_board_feeds;
CREATE POLICY "jbf_staff_update" ON job_board_feeds FOR UPDATE TO authenticated
  USING (is_vireek_staff(auth.uid())) WITH CHECK (is_vireek_staff(auth.uid()));

REVOKE ALL ON job_board_feeds FROM anon, authenticated;
GRANT SELECT ON job_board_feeds TO authenticated;
GRANT UPDATE (enabled, linkedin_company_id, poster_email) ON job_board_feeds TO authenticated;

INSERT INTO job_board_feeds (board) VALUES ('indeed'), ('ziprecruiter'), ('linkedin')
ON CONFLICT (board) DO NOTHING;

-- 3) Crawl recorder (called by the job-feeds edge function with the service role) --------------
CREATE OR REPLACE FUNCTION public.record_job_feed_fetch(p_board text, p_jobs integer, p_skipped integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE job_board_feeds
     SET last_fetched_at = now(),
         fetch_count = fetch_count + 1,
         last_job_count = p_jobs,
         last_skipped_count = p_skipped
   WHERE board = p_board;
$$;

REVOKE ALL ON FUNCTION public.record_job_feed_fetch(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_job_feed_fetch(text, integer, integer) TO service_role;
