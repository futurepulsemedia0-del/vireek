/*
  # Talent Network: rating reports (disputes), moderator review, removal rules

  Fills the gap documented in docs/TALENT_NETWORK.md ("no edit/delete/dispute flow exists for ratings").
  Extends 20271201000000_talent_network.sql; it does not replace any table.

  ## Who can do what
  - The RATEE (the party that was rated) can report ONE revealed rating, once. Reporting a rating that is
    still hidden is refused, with the same message as "no such rating", so a ratee can never learn that
    an unrevealed rating exists. This is what keeps the double-blind rule intact.
  - The RATER cannot edit or delete a submitted rating (unchanged: unique per engagement and direction,
    so a removed rating cannot be re-submitted either; that closes the remove-and-retaliate loop).
  - Vireek staff (profiles.is_staff, is_vireek_staff()) claim a dispute and resolve it with ONE of:
      keep            rating stays as it is
      redact_comment  comment text is cleared, stars/tags keep counting
      remove          the whole rating stops counting and stops being shown
    Removal/redaction needs an allowed reason code and a written note. "I disagree with the rating" is not
    a reason code on purpose. A staff member who is a party to the engagement, the reporter or the rater
    cannot claim or resolve it (conflict of interest).

  ## Double-blind semantics preserved
  - Reveal rules are unchanged (own rating submitted OR 14 days after completion).
  - A removed or under-review rating STILL counts as "submitted" for the reveal predicate of the other side,
    so removal can never re-hide or newly reveal the counterpart's rating.
  - Reputation aggregates skip removed ratings only. Ratings under review keep counting
    (default policy [COUNSEL]; avoids using a dispute to suppress a rating while it is pending).

  ## Audit
  - talent_rating_moderation_log is append-only (row triggers + TRUNCATE trigger) and is written only by
    the SECURITY DEFINER functions below. No client, including staff, has table grants on it.
  - Each dispute stores a SHA-256 of the rating content as it was when reported.

  ## Security
  - New tables: RLS on, all privileges revoked from anon/authenticated, no policies. Access is only through RPCs.
  - Every new function is REVOKEd from PUBLIC/anon/authenticated then granted explicitly (bottom of file).
  - Rating substance (stars, tags, direction, parties) is immutable by trigger; only the comment (clear only)
    and the moderation columns can change.

  Idempotent: safe to run more than once. Redefines (CREATE OR REPLACE, same signatures, ACLs preserved):
  talent_get_engagement_ratings, talent_company_reputation, talent_worker_reputation.

  ## Rollback (destroys moderation history; only before real use)
  DROP FUNCTION public.talent_open_rating_dispute(uuid, text, text); DROP FUNCTION public.talent_withdraw_rating_dispute(uuid);
  DROP FUNCTION public.talent_my_rating_disputes(); DROP FUNCTION public.talent_staff_list_rating_disputes(text, integer);
  DROP FUNCTION public.talent_staff_get_rating_dispute(uuid); DROP FUNCTION public.talent_staff_claim_rating_dispute(uuid);
  DROP FUNCTION public.talent_staff_resolve_rating_dispute(uuid, text, text, text);
  DROP TABLE public.talent_rating_moderation_log; DROP TABLE public.talent_rating_disputes;
  ALTER TABLE public.talent_ratings DROP COLUMN moderation_status, DROP COLUMN moderated_at, DROP COLUMN removal_reason, DROP COLUMN comment_redacted_at;
  (then re-run the three function definitions from 20271201000000_talent_network.sql)
*/

-- =============================================================
-- 0. PURE HELPERS (vocabularies)
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_rating_report_reasons()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'harassment_or_hate', 'discriminatory', 'personal_information',
    'not_about_engagement', 'fake_or_retaliatory', 'false_statement_of_fact', 'other'
  ]::text[];
$$;

-- Reasons a moderator may cite to REMOVE or REDACT. A subset on purpose:
-- 'false_statement_of_fact' and 'other' can be reported but only ever end in "keep" unless the moderator
-- finds one of these grounds. [COUNSEL] confirm the list.
CREATE OR REPLACE FUNCTION public.talent_rating_removal_reasons()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'harassment_or_hate', 'discriminatory', 'personal_information',
    'not_about_engagement', 'fake_or_retaliatory', 'legal_obligation'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.talent_rating_keep_reasons()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['no_violation', 'insufficient_evidence', 'outside_policy']::text[];
$$;

-- =============================================================
-- 1. COLUMNS ON talent_ratings
-- =============================================================

ALTER TABLE talent_ratings ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'visible';
ALTER TABLE talent_ratings ADD COLUMN IF NOT EXISTS moderated_at timestamptz;
ALTER TABLE talent_ratings ADD COLUMN IF NOT EXISTS removal_reason text;
ALTER TABLE talent_ratings ADD COLUMN IF NOT EXISTS comment_redacted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trt_moderation_status_check' AND conrelid = 'public.talent_ratings'::regclass) THEN
    ALTER TABLE talent_ratings ADD CONSTRAINT trt_moderation_status_check
      CHECK (moderation_status IN ('visible', 'under_review', 'removed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trt_removal_reason_check' AND conrelid = 'public.talent_ratings'::regclass) THEN
    ALTER TABLE talent_ratings ADD CONSTRAINT trt_removal_reason_check
      CHECK (removal_reason IS NULL OR removal_reason = ANY (public.talent_rating_removal_reasons()));
  END IF;
END;
$$;

-- Defence in depth: the substance of a rating never changes after submission.
-- Only the comment (and only to clear it) and the moderation columns may change.
CREATE OR REPLACE FUNCTION public.talent_ratings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.rater_user_id IS DISTINCT FROM OLD.rater_user_id
     OR NEW.rating IS DISTINCT FROM OLD.rating
     OR NEW.tags IS DISTINCT FROM OLD.tags
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A submitted rating cannot be edited.' USING ERRCODE = '42501';
  END IF;
  IF NEW.comment IS DISTINCT FROM OLD.comment AND NEW.comment IS NOT NULL THEN
    RAISE EXCEPTION 'A rating comment can only be cleared, never rewritten.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trt_guard ON talent_ratings;
CREATE TRIGGER trg_trt_guard BEFORE UPDATE ON talent_ratings
  FOR EACH ROW EXECUTE FUNCTION public.talent_ratings_guard();

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS talent_rating_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_id uuid REFERENCES talent_ratings(id) ON DELETE SET NULL,
  engagement_id uuid NOT NULL,
  direction text NOT NULL,
  reporter_user_id uuid NOT NULL,
  reason_code text NOT NULL,
  details text NOT NULL,
  content_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  assigned_to uuid,
  claimed_at timestamptz,
  decision text,
  resolution_code text,
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trd_direction_check CHECK (direction IN ('business_to_worker', 'worker_to_business')),
  CONSTRAINT trd_reason_check CHECK (reason_code = ANY (public.talent_rating_report_reasons())),
  CONSTRAINT trd_details_check CHECK (char_length(details) BETWEEN 20 AND 1000),
  CONSTRAINT trd_hash_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trd_status_check CHECK (status IN ('open', 'under_review', 'resolved_kept', 'resolved_redacted', 'resolved_removed', 'withdrawn')),
  CONSTRAINT trd_decision_check CHECK (decision IS NULL OR decision IN ('keep', 'redact_comment', 'remove')),
  CONSTRAINT trd_note_check CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 10 AND 2000),
  CONSTRAINT trd_review_check CHECK (status NOT IN ('under_review') OR (assigned_to IS NOT NULL AND claimed_at IS NOT NULL)),
  CONSTRAINT trd_resolved_check CHECK (
    status NOT IN ('resolved_kept', 'resolved_redacted', 'resolved_removed')
    OR (decision IS NOT NULL AND resolution_code IS NOT NULL AND resolution_note IS NOT NULL
        AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

-- One live or finished (non-withdrawn) report per rating. A withdrawn report can be filed again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_one_per_rating
  ON talent_rating_disputes(rating_id) WHERE rating_id IS NOT NULL AND status <> 'withdrawn';
CREATE INDEX IF NOT EXISTS idx_trd_queue ON talent_rating_disputes(status, created_at)
  WHERE status IN ('open', 'under_review');
CREATE INDEX IF NOT EXISTS idx_trd_reporter ON talent_rating_disputes(reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trd_engagement ON talent_rating_disputes(engagement_id);

DROP TRIGGER IF EXISTS trg_trd_touch ON talent_rating_disputes;
CREATE TRIGGER trg_trd_touch BEFORE UPDATE ON talent_rating_disputes
  FOR EACH ROW EXECUTE FUNCTION public.talent_touch_updated_at();

CREATE TABLE IF NOT EXISTS talent_rating_moderation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL,
  rating_id uuid,
  engagement_id uuid NOT NULL,
  actor_user_id uuid,
  actor_kind text NOT NULL,
  action text NOT NULL,
  from_status text,
  to_status text,
  reason_code text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trml_actor_check CHECK (actor_kind IN ('ratee', 'moderator', 'system')),
  CONSTRAINT trml_action_check CHECK (action IN ('opened', 'withdrawn', 'claimed', 'kept', 'comment_redacted', 'removed')),
  CONSTRAINT trml_note_check CHECK (note IS NULL OR char_length(note) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_trml_dispute ON talent_rating_moderation_log(dispute_id, created_at);

CREATE OR REPLACE FUNCTION public.talent_rating_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'The moderation log is append-only.' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_trml_no_update ON talent_rating_moderation_log;
CREATE TRIGGER trg_trml_no_update BEFORE UPDATE OR DELETE ON talent_rating_moderation_log
  FOR EACH ROW EXECUTE FUNCTION public.talent_rating_log_immutable();
DROP TRIGGER IF EXISTS trg_trml_no_truncate ON talent_rating_moderation_log;
CREATE TRIGGER trg_trml_no_truncate BEFORE TRUNCATE ON talent_rating_moderation_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.talent_rating_log_immutable();

ALTER TABLE talent_rating_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE talent_rating_moderation_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON talent_rating_disputes, talent_rating_moderation_log FROM anon, authenticated;
-- Intentionally no policies and no grants: everything goes through the RPCs below.

-- =============================================================
-- 3. INTERNAL HELPERS (no client grants)
-- =============================================================

-- Is the rating in `p_direction` already visible to the party it is ABOUT?
-- Same rule as talent_get_engagement_ratings: the ratee has submitted their own rating for this
-- engagement, or 14 days have passed since completion. Counts a removed rating as submitted.
CREATE OR REPLACE FUNCTION public.talent_rating_revealed_to_ratee(p_engagement_id uuid, p_direction text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM talent_engagements e
    WHERE e.id = p_engagement_id
      AND (
        EXISTS (
          SELECT 1 FROM talent_ratings o
          WHERE o.engagement_id = e.id
            AND o.direction = CASE WHEN p_direction = 'business_to_worker' THEN 'worker_to_business' ELSE 'business_to_worker' END
        )
        OR (e.completed_at IS NOT NULL AND e.completed_at <= now() - interval '14 days')
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.talent_staff_guard()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'Not allowed.' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;

-- True when the calling staff member is a party to the dispute (reporter, rater, engagement worker,
-- or a member of the business account). Such a person must not moderate it.
CREATE OR REPLACE FUNCTION public.talent_staff_has_conflict(p_dispute_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM talent_rating_disputes d
    LEFT JOIN talent_engagements e ON e.id = d.engagement_id
    LEFT JOIN talent_ratings r ON r.id = d.rating_id
    WHERE d.id = p_dispute_id
      AND (
        d.reporter_user_id = auth.uid()
        OR r.rater_user_id = auth.uid()
        OR e.applicant_user_id = auth.uid()
        OR e.account_owner_id = auth.uid()
        OR e.account_owner_id = public.get_account_owner_id()
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.talent_rating_content_hash(p_rating smallint, p_tags text[], p_comment text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(
    p_rating::text || '|' || COALESCE(array_to_string(p_tags, ','), '') || '|' || COALESCE(p_comment, ''), 'UTF8')), 'hex');
$$;

-- =============================================================
-- 4. RATEE-FACING RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_open_rating_dispute(
  p_engagement_id uuid,
  p_reason text,
  p_details text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_eng talent_engagements%ROWTYPE;
  v_theirs text;
  v_rating talent_ratings%ROWTYPE;
  v_details text := btrim(COALESCE(p_details, ''));
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR NOT (p_reason = ANY (public.talent_rating_report_reasons())) THEN
    RAISE EXCEPTION 'Choose a reason for the report.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_details) < 20 OR char_length(v_details) > 1000 THEN
    RAISE EXCEPTION 'Describe the problem in 20 to 1000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_eng FROM talent_engagements WHERE id = p_engagement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;

  -- Same party resolution as talent_get_engagement_ratings. The rating being reported is the one ABOUT the caller.
  IF v_eng.account_owner_id = public.get_account_owner_id() AND public.talent_is_manager() THEN
    v_theirs := 'worker_to_business';
  ELSIF v_eng.applicant_user_id = v_uid THEN
    v_theirs := 'business_to_worker';
  ELSE
    RAISE EXCEPTION 'Engagement not found.' USING ERRCODE = '42501';
  END IF;

  -- Double-blind: never confirm the existence of a rating that is not yet visible to the caller.
  IF NOT public.talent_rating_revealed_to_ratee(v_eng.id, v_theirs) THEN
    RAISE EXCEPTION 'There is no visible rating to report.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_rating FROM talent_ratings
  WHERE engagement_id = v_eng.id AND direction = v_theirs
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no visible rating to report.' USING ERRCODE = '22023';
  END IF;
  IF v_rating.moderation_status = 'removed' THEN
    RAISE EXCEPTION 'This rating has already been removed.' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*) FROM talent_rating_disputes
      WHERE reporter_user_id = v_uid AND status IN ('open', 'under_review')) >= 5 THEN
    RAISE EXCEPTION 'You have too many open reports. Wait for a decision first.' USING ERRCODE = '54000';
  END IF;
  IF (SELECT count(*) FROM talent_rating_disputes
      WHERE reporter_user_id = v_uid AND created_at > now() - interval '30 days') >= 10 THEN
    RAISE EXCEPTION 'Report limit reached. Try again later.' USING ERRCODE = '54000';
  END IF;

  BEGIN
    INSERT INTO talent_rating_disputes (rating_id, engagement_id, direction, reporter_user_id, reason_code, details, content_sha256)
    VALUES (v_rating.id, v_eng.id, v_theirs, v_uid, p_reason, v_details,
            public.talent_rating_content_hash(v_rating.rating, v_rating.tags, v_rating.comment))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This rating has already been reported.' USING ERRCODE = '22023';
  END;

  IF v_rating.moderation_status = 'visible' THEN
    UPDATE talent_ratings SET moderation_status = 'under_review', moderated_at = now() WHERE id = v_rating.id;
  END IF;

  INSERT INTO talent_rating_moderation_log (dispute_id, rating_id, engagement_id, actor_user_id, actor_kind, action, from_status, to_status, reason_code, note)
  VALUES (v_id, v_rating.id, v_eng.id, v_uid, 'ratee', 'opened', NULL, 'open', p_reason, NULL);

  RETURN jsonb_build_object('ok', true, 'dispute_id', v_id, 'status', 'open');
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_withdraw_rating_dispute(p_dispute_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_d talent_rating_disputes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_d FROM talent_rating_disputes WHERE id = p_dispute_id AND reporter_user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found.' USING ERRCODE = '42501';
  END IF;
  IF v_d.status NOT IN ('open', 'under_review') THEN
    RAISE EXCEPTION 'This report has already been decided.' USING ERRCODE = '22023';
  END IF;

  UPDATE talent_rating_disputes SET status = 'withdrawn', assigned_to = NULL WHERE id = v_d.id;
  IF v_d.rating_id IS NOT NULL THEN
    UPDATE talent_ratings SET moderation_status = 'visible', moderated_at = now()
    WHERE id = v_d.rating_id AND moderation_status = 'under_review';
  END IF;

  INSERT INTO talent_rating_moderation_log (dispute_id, rating_id, engagement_id, actor_user_id, actor_kind, action, from_status, to_status)
  VALUES (v_d.id, v_d.rating_id, v_d.engagement_id, v_uid, 'ratee', 'withdrawn', v_d.status, 'withdrawn');

  RETURN jsonb_build_object('ok', true, 'status', 'withdrawn');
END;
$$;

-- The caller's own reports. Never returns moderator notes or the other party's identity.
CREATE OR REPLACE FUNCTION public.talent_my_rating_disputes()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', d.id, 'engagement_id', d.engagement_id, 'status', d.status, 'reason_code', d.reason_code,
    'decision', d.decision, 'created_at', d.created_at, 'resolved_at', d.resolved_at
  ) ORDER BY d.created_at DESC), '[]'::jsonb)
  FROM talent_rating_disputes d
  WHERE d.reporter_user_id = auth.uid();
$$;

-- =============================================================
-- 5. STAFF RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.talent_staff_list_rating_disputes(p_scope text DEFAULT 'active', p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.talent_staff_guard();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('active', 'resolved', 'all') THEN
    RAISE EXCEPTION 'Invalid scope.' USING ERRCODE = '22023';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(q)::jsonb ORDER BY q.sort_open DESC, q.created_at)
    FROM (
      SELECT d.id, d.status, d.reason_code, d.direction, r.rating, d.created_at, d.claimed_at, d.resolved_at, d.decision,
             (d.assigned_to = v_uid) AS assigned_to_me,
             (d.assigned_to IS NOT NULL AND d.assigned_to <> v_uid) AS assigned_to_other,
             CASE WHEN d.status = 'open' THEN 1 ELSE 0 END AS sort_open
      FROM talent_rating_disputes d
      LEFT JOIN talent_ratings r ON r.id = d.rating_id
      WHERE (p_scope = 'all'
             OR (p_scope = 'active' AND d.status IN ('open', 'under_review'))
             OR (p_scope = 'resolved' AND d.status IN ('resolved_kept', 'resolved_redacted', 'resolved_removed', 'withdrawn')))
      ORDER BY CASE WHEN d.status = 'open' THEN 1 ELSE 0 END DESC, d.created_at
      LIMIT v_limit
    ) q
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_staff_get_rating_dispute(p_dispute_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.talent_staff_guard();
  v_d talent_rating_disputes%ROWTYPE;
  v_r talent_ratings%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM talent_rating_disputes WHERE id = p_dispute_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found.' USING ERRCODE = '42501';
  END IF;
  IF v_d.rating_id IS NOT NULL THEN
    SELECT * INTO v_r FROM talent_ratings WHERE id = v_d.rating_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_d.id, 'status', v_d.status, 'reason_code', v_d.reason_code, 'details', v_d.details,
    'direction', v_d.direction, 'engagement_id', v_d.engagement_id,
    'created_at', v_d.created_at, 'claimed_at', v_d.claimed_at, 'resolved_at', v_d.resolved_at,
    'decision', v_d.decision, 'resolution_code', v_d.resolution_code, 'resolution_note', v_d.resolution_note,
    'assigned_to_me', (v_d.assigned_to = v_uid),
    'conflict', public.talent_staff_has_conflict(v_d.id),
    'content_sha256', v_d.content_sha256,
    'rating', CASE WHEN v_r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'rating', v_r.rating, 'tags', to_jsonb(v_r.tags), 'comment', v_r.comment,
      'moderation_status', v_r.moderation_status, 'comment_redacted_at', v_r.comment_redacted_at,
      'current_sha256', public.talent_rating_content_hash(v_r.rating, v_r.tags, v_r.comment)) END,
    'log', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'action', l.action, 'actor_kind', l.actor_kind, 'from_status', l.from_status, 'to_status', l.to_status,
        'reason_code', l.reason_code, 'note', l.note, 'created_at', l.created_at) ORDER BY l.created_at, l.id)
      FROM talent_rating_moderation_log l WHERE l.dispute_id = v_d.id), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_staff_claim_rating_dispute(p_dispute_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.talent_staff_guard();
  v_d talent_rating_disputes%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM talent_rating_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found.' USING ERRCODE = '42501';
  END IF;
  IF public.talent_staff_has_conflict(v_d.id) THEN
    RAISE EXCEPTION 'You are involved in this case and cannot moderate it.' USING ERRCODE = '42501';
  END IF;
  IF v_d.status = 'under_review' AND v_d.assigned_to = v_uid THEN
    RETURN jsonb_build_object('ok', true, 'status', 'under_review'); -- idempotent
  END IF;
  IF v_d.status <> 'open' THEN
    RAISE EXCEPTION 'This report is no longer open.' USING ERRCODE = '22023';
  END IF;

  UPDATE talent_rating_disputes SET status = 'under_review', assigned_to = v_uid, claimed_at = now() WHERE id = v_d.id;

  INSERT INTO talent_rating_moderation_log (dispute_id, rating_id, engagement_id, actor_user_id, actor_kind, action, from_status, to_status)
  VALUES (v_d.id, v_d.rating_id, v_d.engagement_id, v_uid, 'moderator', 'claimed', 'open', 'under_review');

  RETURN jsonb_build_object('ok', true, 'status', 'under_review');
END;
$$;

CREATE OR REPLACE FUNCTION public.talent_staff_resolve_rating_dispute(
  p_dispute_id uuid,
  p_decision text,
  p_reason_code text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.talent_staff_guard();
  v_d talent_rating_disputes%ROWTYPE;
  v_r talent_ratings%ROWTYPE;
  v_note text := btrim(COALESCE(p_note, ''));
  v_status text;
  v_action text;
  v_rater_url text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('keep', 'redact_comment', 'remove') THEN
    RAISE EXCEPTION 'Invalid decision.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) < 10 OR char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'Write a decision note of 10 to 2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_decision = 'keep' AND (p_reason_code IS NULL OR NOT (p_reason_code = ANY (public.talent_rating_keep_reasons()))) THEN
    RAISE EXCEPTION 'Choose a reason for keeping the rating.' USING ERRCODE = '22023';
  END IF;
  IF p_decision <> 'keep' AND (p_reason_code IS NULL OR NOT (p_reason_code = ANY (public.talent_rating_removal_reasons()))) THEN
    RAISE EXCEPTION 'Choose an allowed removal reason.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_d FROM talent_rating_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found.' USING ERRCODE = '42501';
  END IF;
  IF public.talent_staff_has_conflict(v_d.id) THEN
    RAISE EXCEPTION 'You are involved in this case and cannot moderate it.' USING ERRCODE = '42501';
  END IF;
  IF v_d.status <> 'under_review' OR v_d.assigned_to IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Claim this report before deciding it.' USING ERRCODE = '22023';
  END IF;

  IF v_d.rating_id IS NOT NULL THEN
    SELECT * INTO v_r FROM talent_ratings WHERE id = v_d.rating_id FOR UPDATE;
  END IF;
  IF v_r.id IS NULL AND p_decision <> 'keep' THEN
    RAISE EXCEPTION 'The rating no longer exists.' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'keep' THEN
    v_status := 'resolved_kept'; v_action := 'kept';
    IF v_r.id IS NOT NULL THEN
      UPDATE talent_ratings SET moderation_status = 'visible', moderated_at = now() WHERE id = v_r.id;
    END IF;
  ELSIF p_decision = 'redact_comment' THEN
    v_status := 'resolved_redacted'; v_action := 'comment_redacted';
    UPDATE talent_ratings
    SET comment = NULL, comment_redacted_at = now(), moderation_status = 'visible', moderated_at = now(), removal_reason = p_reason_code
    WHERE id = v_r.id;
  ELSE
    v_status := 'resolved_removed'; v_action := 'removed';
    UPDATE talent_ratings
    SET moderation_status = 'removed', moderated_at = now(), removal_reason = p_reason_code
    WHERE id = v_r.id;
  END IF;

  UPDATE talent_rating_disputes
  SET status = v_status, decision = p_decision, resolution_code = p_reason_code, resolution_note = v_note,
      resolved_by = v_uid, resolved_at = now()
  WHERE id = v_d.id;

  INSERT INTO talent_rating_moderation_log (dispute_id, rating_id, engagement_id, actor_user_id, actor_kind, action, from_status, to_status, reason_code, note)
  VALUES (v_d.id, v_d.rating_id, v_d.engagement_id, v_uid, 'moderator', v_action, 'under_review', v_status, p_reason_code, v_note);

  -- Notifications carry the outcome and a fixed reason code only: never the other party's text or the moderator note.
  PERFORM public.talent_notify(v_d.reporter_user_id, 'talent_rating_report_decided', 'Your rating report was reviewed',
    CASE p_decision WHEN 'keep' THEN 'The rating was kept.' WHEN 'redact_comment' THEN 'The comment was removed; the star rating stays.' ELSE 'The rating was removed.' END,
    CASE WHEN v_d.direction = 'business_to_worker' THEN '/talent/me' ELSE '/dashboard/talent?tab=engagements' END);

  IF p_decision <> 'keep' AND v_r.rater_user_id IS NOT NULL THEN
    v_rater_url := CASE WHEN v_d.direction = 'business_to_worker' THEN '/dashboard/talent?tab=engagements' ELSE '/talent/me' END;
    PERFORM public.talent_notify(v_r.rater_user_id, 'talent_rating_moderated', 'A rating you gave was moderated',
      CASE p_decision WHEN 'redact_comment' THEN 'The comment was removed after review. The star rating stays.' ELSE 'The rating was removed after review.' END,
      v_rater_url);
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- =============================================================
-- 6. REDEFINED READ PATHS (same signatures; extra keys / filters only)
-- =============================================================

-- Adds: mine_removed, theirs_removed, theirs_comment_redacted, can_dispute, dispute. Existing keys unchanged.
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
  v_theirs_row talent_ratings%ROWTYPE;
  v_mine_row talent_ratings%ROWTYPE;
  v_dispute talent_rating_disputes%ROWTYPE;
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

  SELECT * INTO v_mine_row FROM talent_ratings WHERE engagement_id = v_eng.id AND direction = v_mine;
  IF v_revealed THEN
    SELECT * INTO v_theirs_row FROM talent_ratings WHERE engagement_id = v_eng.id AND direction = v_theirs;
    IF v_theirs_row.id IS NOT NULL THEN
      SELECT * INTO v_dispute FROM talent_rating_disputes
      WHERE rating_id = v_theirs_row.id AND reporter_user_id = v_uid AND status <> 'withdrawn';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'mine', CASE WHEN v_mine_row.id IS NULL THEN NULL
                 ELSE jsonb_build_object('rating', v_mine_row.rating, 'tags', to_jsonb(v_mine_row.tags), 'comment', v_mine_row.comment) END,
    'theirs', CASE WHEN v_theirs_row.id IS NULL OR v_theirs_row.moderation_status = 'removed' THEN NULL
                   ELSE jsonb_build_object('rating', v_theirs_row.rating, 'tags', to_jsonb(v_theirs_row.tags), 'comment', v_theirs_row.comment) END,
    'revealed', v_revealed,
    'mine_removed', COALESCE(v_mine_row.moderation_status = 'removed', false),
    'theirs_removed', COALESCE(v_theirs_row.moderation_status = 'removed', false),
    'theirs_comment_redacted', (v_theirs_row.comment_redacted_at IS NOT NULL),
    'can_dispute', (v_theirs_row.id IS NOT NULL AND v_theirs_row.moderation_status <> 'removed' AND v_dispute.id IS NULL),
    'dispute', CASE WHEN v_dispute.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_dispute.id, 'status', v_dispute.status, 'decision', v_dispute.decision,
      'created_at', v_dispute.created_at, 'resolved_at', v_dispute.resolved_at) END
  );
END;
$$;

-- Removed ratings stop counting. The EXISTS reveal check intentionally still counts removed rows.
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
    AND r.moderation_status <> 'removed'
    AND e.account_owner_id = p_owner
    AND (
      EXISTS (SELECT 1 FROM talent_ratings o WHERE o.engagement_id = r.engagement_id AND o.direction = 'business_to_worker')
      OR e.completed_at <= now() - interval '14 days'
    );
$$;

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
      AND r.moderation_status <> 'removed'
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
-- 7. FUNCTION PRIVILEGES (deny by default, explicit allow-lists; only the functions defined above)
-- =============================================================

DO $$
DECLARE
  r record;
  v_authenticated text[] := ARRAY[
    'talent_open_rating_dispute', 'talent_withdraw_rating_dispute', 'talent_my_rating_disputes',
    'talent_staff_list_rating_disputes', 'talent_staff_get_rating_dispute',
    'talent_staff_claim_rating_dispute', 'talent_staff_resolve_rating_dispute'
  ];
  v_internal text[] := ARRAY[
    'talent_rating_report_reasons', 'talent_rating_removal_reasons', 'talent_rating_keep_reasons',
    'talent_ratings_guard', 'talent_rating_log_immutable', 'talent_rating_revealed_to_ratee',
    'talent_staff_guard', 'talent_staff_has_conflict', 'talent_rating_content_hash'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname AS fname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname = ANY (v_authenticated) OR p.proname = ANY (v_internal))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    IF r.fname = ANY (v_authenticated) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
  END LOOP;
END;
$$;
