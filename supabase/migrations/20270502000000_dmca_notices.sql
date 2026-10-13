/*
  # DMCA notices (public /dmca form)

  ## Why
  Vireek hosts third-party content (customer-supplied material, community
  posts, etc.), so it needs a documented, auditable intake for copyright
  takedown notices (17 U.S.C. § 512(c)(3)) and counter-notifications
  (§ 512(g)(3)). Notices are legal records: they must never be lost, never be
  editable by the submitter, and must be visible only to Vireek staff.

  ## Security model
  - RLS is enabled with NO anon/authenticated INSERT policy. The only write
    path is `submit_dmca_notice()` (SECURITY DEFINER), which re-validates
    everything server-side — the client form is a convenience, not a trust
    boundary.
  - Only `is_vireek_staff()` users can SELECT / UPDATE (status workflow).
    No DELETE policy at all: legal records are resolved, never deleted.
  - The function returns ONLY a reference number. It never echoes stored data.

  ## Abuse protection (public, unauthenticated endpoint)
  - Honeypot field (`website`): bots get a fake success and nothing is stored.
  - Per-email cap: 5 notices / 24h. Global flood cap: 100 notices / hour.
  - Hard length / count limits on every field, http(s)-only URLs, max 20 URLs.
  - Signature must match the typed legal name; all required statements must
    be affirmed for the chosen notice type.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- =============================================================
-- 1. Table + reference-number sequence
-- =============================================================

CREATE SEQUENCE IF NOT EXISTS dmca_notice_seq START 1;

CREATE TABLE IF NOT EXISTS dmca_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  notice_type text NOT NULL CHECK (notice_type IN ('takedown', 'counter')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'under_review', 'content_removed', 'counter_pending', 'restored', 'rejected', 'closed')),

  full_name text NOT NULL,
  organization text,
  email text NOT NULL,
  phone text,
  address text NOT NULL,
  capacity text CHECK (capacity IN ('owner', 'agent')),

  work_description text,
  work_url text,
  infringing_urls text[] NOT NULL,
  original_reference text,
  additional_info text,

  statements text[] NOT NULL,
  signature text NOT NULL,

  staff_notes text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dmca_notices_status ON dmca_notices(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dmca_notices_email_recent ON dmca_notices(lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dmca_notices_created_at ON dmca_notices(created_at DESC);

ALTER TABLE dmca_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_staff_dmca_notices" ON dmca_notices;
CREATE POLICY "select_staff_dmca_notices" ON dmca_notices
  FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "update_staff_dmca_notices" ON dmca_notices;
CREATE POLICY "update_staff_dmca_notices" ON dmca_notices
  FOR UPDATE TO authenticated
  USING (is_vireek_staff(auth.uid()))
  WITH CHECK (is_vireek_staff(auth.uid()));

-- Deliberately NO insert/delete policy: rows are created only by
-- submit_dmca_notice() and are never deleted.

CREATE OR REPLACE FUNCTION public.touch_dmca_notice_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_dmca_notice_updated_at ON dmca_notices;
CREATE TRIGGER trg_touch_dmca_notice_updated_at
  BEFORE UPDATE ON dmca_notices
  FOR EACH ROW EXECUTE FUNCTION public.touch_dmca_notice_updated_at();

-- =============================================================
-- 2. Public submission RPC
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_dmca_notice(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_name text;
  v_org text;
  v_email text;
  v_phone text;
  v_address text;
  v_capacity text;
  v_work_desc text;
  v_work_url text;
  v_orig_ref text;
  v_additional text;
  v_signature text;
  v_urls text[];
  v_statements text[];
  v_required text[];
  v_ref text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Honeypot: real users never fill this. Pretend success, store nothing.
  IF COALESCE(trim(p_payload->>'website'), '') <> '' THEN
    RETURN jsonb_build_object('ok', true, 'reference', 'DMCA-' || to_char(now(), 'YYYY') || '-000000');
  END IF;

  v_type       := p_payload->>'notice_type';
  v_name       := trim(COALESCE(p_payload->>'full_name', ''));
  v_org        := NULLIF(trim(COALESCE(p_payload->>'organization', '')), '');
  v_email      := trim(COALESCE(p_payload->>'email', ''));
  v_phone      := NULLIF(trim(COALESCE(p_payload->>'phone', '')), '');
  v_address    := trim(COALESCE(p_payload->>'address', ''));
  v_capacity   := NULLIF(trim(COALESCE(p_payload->>'capacity', '')), '');
  v_work_desc  := NULLIF(trim(COALESCE(p_payload->>'work_description', '')), '');
  v_work_url   := NULLIF(trim(COALESCE(p_payload->>'work_url', '')), '');
  v_orig_ref   := NULLIF(trim(COALESCE(p_payload->>'original_reference', '')), '');
  v_additional := NULLIF(trim(COALESCE(p_payload->>'additional_info', '')), '');
  v_signature  := trim(COALESCE(p_payload->>'signature', ''));

  IF v_type IS NULL OR v_type NOT IN ('takedown', 'counter') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Identity / contact
  IF char_length(v_name) NOT BETWEEN 2 AND 120
     OR char_length(v_email) > 254
     OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     OR char_length(v_address) NOT BETWEEN 10 AND 500
     OR char_length(COALESCE(v_org, '')) > 200
     OR char_length(COALESCE(v_phone, '')) > 40
     OR (v_phone IS NOT NULL AND v_phone !~ '^[+0-9 ().-]{7,40}$')
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Free-text limits
  IF char_length(COALESCE(v_work_desc, '')) > 3000
     OR char_length(COALESCE(v_additional, '')) > 3000
     OR char_length(COALESCE(v_work_url, '')) > 2000
     OR char_length(COALESCE(v_orig_ref, '')) > 64
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Type-specific requirements
  IF v_type = 'takedown' THEN
    IF v_capacity IS NULL OR v_capacity NOT IN ('owner', 'agent')
       OR v_work_desc IS NULL OR char_length(v_work_desc) < 20 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid');
    END IF;
    v_required := ARRAY['good_faith', 'accuracy_authority', 'share_with_user'];
  ELSE
    -- Counter-notifications must include a phone number (17 U.S.C. § 512(g)(3)(D)).
    IF v_phone IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'invalid');
    END IF;
    v_capacity := NULL;
    v_required := ARRAY['mistake', 'jurisdiction', 'service', 'share_with_user'];
  END IF;

  -- URLs: 1..20, http(s) only, no whitespace, <= 2000 chars each
  IF COALESCE(jsonb_typeof(p_payload->'urls'), '') <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;
  IF jsonb_array_length(p_payload->'urls') > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  v_urls := ARRAY(
    SELECT DISTINCT trim(x) FROM jsonb_array_elements_text(p_payload->'urls') AS x WHERE trim(x) <> ''
  );
  IF COALESCE(cardinality(v_urls), 0) NOT BETWEEN 1 AND 20
     OR EXISTS (
       SELECT 1 FROM unnest(v_urls) AS u
       WHERE u !~* '^https?://[^[:space:]]+\.[^[:space:]]+$' OR char_length(u) > 2000
     )
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Statements: every required one must be affirmed; unknown ids are dropped.
  IF COALESCE(jsonb_typeof(p_payload->'statements'), '') <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;
  v_statements := ARRAY(
    SELECT DISTINCT s FROM jsonb_array_elements_text(p_payload->'statements') AS s WHERE s = ANY (v_required)
  );
  IF NOT (v_required <@ v_statements) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Signature must match the typed legal name (whitespace/case-insensitive)
  IF lower(regexp_replace(v_signature, '\s+', ' ', 'g')) <> lower(regexp_replace(v_name, '\s+', ' ', 'g')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Rate limits (public endpoint)
  IF (SELECT count(*) FROM dmca_notices
      WHERE lower(email) = lower(v_email) AND created_at > now() - interval '24 hours') >= 5
     OR (SELECT count(*) FROM dmca_notices WHERE created_at > now() - interval '1 hour') >= 100
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  v_ref := 'DMCA-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('dmca_notice_seq')::text, 6, '0');

  INSERT INTO dmca_notices (
    reference, notice_type, full_name, organization, email, phone, address, capacity,
    work_description, work_url, infringing_urls, original_reference, additional_info,
    statements, signature
  ) VALUES (
    v_ref, v_type, v_name, v_org, v_email, v_phone, v_address, v_capacity,
    v_work_desc, v_work_url, v_urls, v_orig_ref, v_additional,
    v_statements, v_signature
  );

  RETURN jsonb_build_object('ok', true, 'reference', v_ref);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_dmca_notice(jsonb) TO anon, authenticated;
