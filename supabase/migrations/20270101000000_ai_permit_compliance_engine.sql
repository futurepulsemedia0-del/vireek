/*
  # AI Permit / Code / Compliance Engine

  Before a job starts, Vireek reviews its location, trade, scope and customer
  type against a curated rule library (permits, inspections, licensing,
  safety, documentation, regulations) and - optionally - an AI layer that adds
  context. The result is stored once per job and shown as a warning before
  the technician rolls.

  Design principles
  - Deterministic rules are the backbone; the AI can only ADD items (capped
    at "warning"), never remove or downgrade a rule-derived item.
  - Regular clients cannot write reviews - only the Edge Function
    (service role) does, so severity / likelihood cannot be forged.
  - Users track progress per requirement (open / in_progress / satisfied /
    not_applicable, permit number, note) through a validated RPC. Progress
    survives regeneration because it is stored separately from the AI/rule
    output.
  - Starting a job with unresolved blockers requires a recorded
    acknowledgement (who, when, why) - written to job_compliance_acknowledgements
    and the account audit_log. This is a soft gate by design; it never blocks
    a status change at the database level.

  Purely additive - touches nothing that already exists.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Reviews --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_compliance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,

  jurisdiction jsonb NOT NULL DEFAULT '{}',
  work_types jsonb NOT NULL DEFAULT '[]',
  permit_likelihood text NOT NULL DEFAULT 'unknown'
    CHECK (permit_likelihood IN ('likely_required', 'possibly_required', 'unlikely', 'unknown')),
  summary text,
  requirements jsonb NOT NULL DEFAULT '[]',
  verify_questions jsonb NOT NULL DEFAULT '[]',

  -- Per-requirement user progress, keyed by requirement key. Written ONLY by
  -- set_compliance_item_progress(); survives regeneration.
  item_progress jsonb NOT NULL DEFAULT '{}',

  ai_status text NOT NULL DEFAULT 'skipped' CHECK (ai_status IN ('ok', 'unavailable', 'skipped')),
  input_hash text,
  rules_version text,
  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_compliance_reviews_user_id ON job_compliance_reviews(user_id);

ALTER TABLE job_compliance_reviews ENABLE ROW LEVEL SECURITY;

-- Same scoping as `jobs` itself.
DROP POLICY IF EXISTS "select_own_compliance_reviews" ON job_compliance_reviews;
CREATE POLICY "select_own_compliance_reviews"
ON job_compliance_reviews FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

GRANT ALL ON job_compliance_reviews TO service_role;

-- 2) Acknowledgements (append-only evidence) -------------------------------------

CREATE TABLE IF NOT EXISTS job_compliance_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES job_compliance_reviews(id) ON DELETE CASCADE,
  acknowledged_by uuid NOT NULL DEFAULT auth.uid(),
  reason text,
  unresolved_keys jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_compliance_acks_job ON job_compliance_acknowledgements(job_id, created_at DESC);

ALTER TABLE job_compliance_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_compliance_acks" ON job_compliance_acknowledgements;
CREATE POLICY "select_own_compliance_acks"
ON job_compliance_acknowledgements FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: rows are written only by acknowledge_compliance_review().

GRANT ALL ON job_compliance_acknowledgements TO service_role;

-- 3) Atomic hourly quota (service-role only) ---------------------------------------

CREATE TABLE IF NOT EXISTS compliance_review_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE compliance_review_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_compliance_review_quota(
  p_user_id uuid,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO compliance_review_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_compliance_review_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_compliance_review_quota(uuid, integer, integer) TO service_role;

-- 4) Helper: unresolved blockers of a review ---------------------------------------
-- A blocker is unresolved unless its progress status is satisfied / not_applicable.

CREATE OR REPLACE FUNCTION public.compliance_unresolved_blockers(p_requirements jsonb, p_progress jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key', r->>'key', 'title', r->>'title')), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_requirements, '[]'::jsonb)) AS r
  WHERE r->>'severity' = 'blocker'
    AND COALESCE(p_progress -> (r->>'key') ->> 'status', 'open') NOT IN ('satisfied', 'not_applicable');
$$;

-- 5) RPC: track progress on one requirement ----------------------------------------

CREATE OR REPLACE FUNCTION public.set_compliance_item_progress(
  p_job_id uuid,
  p_key text,
  p_status text,
  p_permit_number text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_review job_compliance_reviews%ROWTYPE;
  v_entry jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('open', 'in_progress', 'satisfied', 'not_applicable') THEN
    RAISE EXCEPTION 'Invalid status.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_review FROM job_compliance_reviews
   WHERE job_id = p_job_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No compliance review for this job.' USING ERRCODE = 'P0002';
  END IF;

  -- The key must be a real requirement of this review (blocks junk keys).
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_review.requirements) r WHERE r->>'key' = p_key
  ) THEN
    RAISE EXCEPTION 'Unknown requirement.' USING ERRCODE = '22023';
  END IF;

  v_entry := jsonb_build_object(
    'status', p_status,
    'permit_number', NULLIF(left(btrim(COALESCE(p_permit_number, '')), 60), ''),
    'note', NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''),
    'updated_by', auth.uid(),
    'updated_at', now()
  );

  UPDATE job_compliance_reviews
     SET item_progress = jsonb_set(COALESCE(item_progress, '{}'::jsonb), ARRAY[p_key], v_entry, true)
   WHERE id = v_review.id;

  PERFORM public.log_audit_event(v_owner, 'compliance.progress.' || p_status, 'job_compliance_reviews', v_review.id::text);
  RETURN v_entry;
END;
$$;

REVOKE ALL ON FUNCTION public.set_compliance_item_progress(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_compliance_item_progress(uuid, text, text, text, text) TO authenticated;

-- 6) RPC: pre-start check (read-only) ----------------------------------------------
-- Returns { has_review, unresolved: [{key,title}], acknowledged, needs_ack }.
-- An acknowledgement is valid only if it was made AFTER the latest generation
-- and covers every currently-unresolved blocker.

CREATE OR REPLACE FUNCTION public.compliance_start_status(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_review job_compliance_reviews%ROWTYPE;
  v_unresolved jsonb;
  v_acked boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_review FROM job_compliance_reviews WHERE job_id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_review', false, 'unresolved', '[]'::jsonb, 'acknowledged', false, 'needs_ack', false);
  END IF;

  v_unresolved := public.compliance_unresolved_blockers(v_review.requirements, v_review.item_progress);

  SELECT EXISTS (
    SELECT 1 FROM job_compliance_acknowledgements a
     WHERE a.job_id = p_job_id
       AND a.review_id = v_review.id
       AND a.created_at >= v_review.generated_at
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_unresolved) u
          WHERE NOT (a.unresolved_keys ? (u->>'key'))
       )
  ) INTO v_acked;

  RETURN jsonb_build_object(
    'has_review', true,
    'unresolved', v_unresolved,
    'acknowledged', v_acked,
    'needs_ack', jsonb_array_length(v_unresolved) > 0 AND NOT v_acked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compliance_start_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_start_status(uuid) TO authenticated;

-- 7) RPC: acknowledge unresolved blockers before starting --------------------------

CREATE OR REPLACE FUNCTION public.acknowledge_compliance_review(p_job_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_review job_compliance_reviews%ROWTYPE;
  v_unresolved jsonb;
  v_reason text := left(btrim(COALESCE(p_reason, '')), 500);
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_review FROM job_compliance_reviews WHERE job_id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No compliance review for this job.' USING ERRCODE = 'P0002';
  END IF;

  v_unresolved := public.compliance_unresolved_blockers(v_review.requirements, v_review.item_progress);
  IF jsonb_array_length(v_unresolved) > 0 AND char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'A reason (at least 8 characters) is required to proceed with unresolved compliance blockers.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO job_compliance_acknowledgements (user_id, job_id, review_id, acknowledged_by, reason, unresolved_keys)
  VALUES (
    v_owner, p_job_id, v_review.id, auth.uid(), NULLIF(v_reason, ''),
    COALESCE((SELECT jsonb_agg(u->>'key') FROM jsonb_array_elements(v_unresolved) u), '[]'::jsonb)
  )
  RETURNING id INTO v_id;

  PERFORM public.log_audit_event(v_owner, 'compliance.acknowledged', 'job_compliance_acknowledgements', v_id::text);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_compliance_review(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_compliance_review(uuid, text) TO authenticated;
