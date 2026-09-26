/*
  # Epistemic Boundary Detector

  ## Why
  knowledge_gaps (20260921000000_advanced_knowledge_base.sql) already
  catches "I know I don't know": zero search hits get logged and
  counted so the dashboard can turn "asked 7 times" into an article.
  It does NOT catch the more dangerous case — search_knowledge_articles
  returns a weak, low-confidence match, formatKnowledgeForVoice reads
  it out as a stated fact, and nothing records that it was a guess.
  That's "not knowing that you don't know": the system is confident it
  answered when it really just returned the least-bad match.

  ## What this adds
  1. `knowledge_gaps.boundary_type` ('no_coverage' | 'weak_match') and
     `best_score` — every gap now records WHY it's a gap, not just
     THAT it is one.
  2. `search_knowledge_articles` now also returns raw
     `semantic_similarity` per hit (previously only RRF rank score,
     which reflects rank position, not match quality) — the signal
     the boundary classifier in
     supabase/functions/_shared/ai-core/epistemicBoundary.ts needs to
     tell "confident" apart from "weak_match".
  3. `record_knowledge_gap` gains two optional params (boundary_type,
     best_score) — old callers with the original 4 args keep working
     identically (both default to the old "true miss" behavior); the
     old 4-arg overload is dropped first specifically to avoid
     PostgREST overload ambiguity, not to remove functionality.
  4. `trigger_knowledge_boundary_learning` — a BEFORE INSERT/UPDATE
     trigger on knowledge_gaps. The active-learning trigger: the
     instant a gap first becomes a weak_match, or first crosses
     asked_count >= 3, it appends a `knowledge.boundary_critical`
     business_activity_events row via the SAME append_activity_event()
     RPC service-recovery-agent already uses — so a business can wire
     an existing workflow playbook (SMS/email "you've been asked X
     five times with no good answer") to it with zero new
     notification code. `escalated_at` makes this fire once, not once
     per call.

  ## Security
  Same as 20260921000000_advanced_knowledge_base.sql: RLS unchanged
  (no new tables), all new columns readable under the same
  get_account_owner_id() policy already on knowledge_gaps. The trigger
  function and both RPCs are SECURITY DEFINER, consistent with every
  other write path in this migration's parent file.
*/

-- =============================================================
-- 1. knowledge_gaps — add boundary classification columns
-- =============================================================

ALTER TABLE knowledge_gaps
  ADD COLUMN IF NOT EXISTS boundary_type text NOT NULL DEFAULT 'no_coverage'
    CHECK (boundary_type IN ('no_coverage', 'weak_match'));
ALTER TABLE knowledge_gaps ADD COLUMN IF NOT EXISTS best_score numeric;
ALTER TABLE knowledge_gaps ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- =============================================================
-- 2. search_knowledge_articles — add raw semantic_similarity output
--    (return type changes, so the old function must be dropped first)
-- =============================================================

DROP FUNCTION IF EXISTS public.search_knowledge_articles(uuid, text, double precision[], text, integer);

CREATE OR REPLACE FUNCTION public.search_knowledge_articles(
  p_user_id uuid,
  p_query text,
  p_embedding double precision[] DEFAULT NULL,
  p_audience text DEFAULT NULL,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  title text,
  summary text,
  body text,
  category text,
  audience text,
  score double precision,
  lexical_rank integer,
  semantic_rank integer,
  semantic_similarity double precision
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT a.*
    FROM knowledge_articles a
    WHERE a.user_id = p_user_id
      AND a.status = 'published'
      AND (a.expires_on IS NULL OR a.expires_on >= CURRENT_DATE)
      AND (
        p_audience IS NULL
        OR a.audience = 'all'
        OR a.audience = p_audience
      )
  ),
  lexical AS (
    SELECT
      b.id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(b.search_vector, websearch_to_tsquery('english', p_query)) DESC
      )::integer AS rnk
    FROM base b
    WHERE p_query IS NOT NULL
      AND length(trim(p_query)) > 0
      AND b.search_vector @@ websearch_to_tsquery('english', p_query)
    LIMIT 25
  ),
  semantic AS (
    SELECT
      b.id,
      ROW_NUMBER() OVER (
        ORDER BY public.array_cosine_similarity(b.embedding, p_embedding) DESC
      )::integer AS rnk,
      public.array_cosine_similarity(b.embedding, p_embedding) AS sim
    FROM base b
    WHERE p_embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND public.array_cosine_similarity(b.embedding, p_embedding) > 0.25
    LIMIT 25
  ),
  fused AS (
    SELECT
      COALESCE(l.id, s.id) AS id,
      COALESCE(1.0 / (60 + l.rnk), 0) + COALESCE(1.0 / (60 + s.rnk), 0) AS score,
      l.rnk AS lexical_rank,
      s.rnk AS semantic_rank,
      COALESCE(s.sim, 0) AS semantic_similarity
    FROM lexical l
    FULL OUTER JOIN semantic s ON s.id = l.id
  )
  SELECT
    b.id, b.title, b.summary, b.body, b.category, b.audience,
    f.score, f.lexical_rank, f.semantic_rank, f.semantic_similarity
  FROM fused f
  JOIN base b ON b.id = f.id
  ORDER BY f.score DESC, b.usage_count DESC
  LIMIT GREATEST(1, LEAST(p_limit, 20));
$$;

GRANT EXECUTE ON FUNCTION public.search_knowledge_articles(uuid, text, double precision[], text, integer)
  TO authenticated, service_role;

-- =============================================================
-- 3. record_knowledge_gap — boundary-aware (old 4-arg calls unaffected)
-- =============================================================

DROP FUNCTION IF EXISTS public.record_knowledge_gap(uuid, text, text, uuid);

CREATE OR REPLACE FUNCTION public.record_knowledge_gap(
  p_user_id uuid,
  p_question text,
  p_source text DEFAULT 'voice',
  p_call_id uuid DEFAULT NULL,
  p_boundary_type text DEFAULT 'no_coverage',
  p_best_score numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_id uuid;
  v_boundary text := CASE WHEN p_boundary_type IN ('no_coverage', 'weak_match') THEN p_boundary_type ELSE 'no_coverage' END;
BEGIN
  IF p_user_id IS NULL OR p_question IS NULL OR length(trim(p_question)) < 3 THEN
    RETURN NULL;
  END IF;

  v_key := left(lower(regexp_replace(trim(p_question), '\s+', ' ', 'g')), 300);

  INSERT INTO knowledge_gaps (user_id, question, question_key, source, sample_call_id, boundary_type, best_score)
  VALUES (p_user_id, left(trim(p_question), 500), v_key, COALESCE(p_source, 'voice'), p_call_id, v_boundary, p_best_score)
  ON CONFLICT (user_id, question_key) DO UPDATE
    SET asked_count = knowledge_gaps.asked_count + 1,
        last_asked_at = now(),
        sample_call_id = COALESCE(EXCLUDED.sample_call_id, knowledge_gaps.sample_call_id),
        boundary_type = EXCLUDED.boundary_type,
        best_score = EXCLUDED.best_score,
        status = CASE WHEN knowledge_gaps.status = 'dismissed' THEN 'dismissed' ELSE 'open' END
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_knowledge_gap(uuid, text, text, uuid, text, numeric) TO authenticated, service_role;

-- =============================================================
-- 4. Active learning trigger — pushes a critical boundary into the
--    existing activity/playbook fabric the instant it matters
-- =============================================================

CREATE OR REPLACE FUNCTION public.trigger_knowledge_boundary_learning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.escalated_at IS NULL
     AND NEW.status = 'open'
     AND (NEW.asked_count >= 3 OR NEW.boundary_type = 'weak_match')
  THEN
    NEW.escalated_at := now();
    PERFORM public.append_activity_event(
      p_aggregate_type := 'knowledge_gap',
      p_aggregate_id := NEW.id,
      p_event_type := 'knowledge.boundary_critical',
      p_event_data := jsonb_build_object(
        'question', NEW.question,
        'asked_count', NEW.asked_count,
        'boundary_type', NEW.boundary_type,
        'best_score', NEW.best_score,
        'source', NEW.source
      ),
      p_actor_type := 'ai',
      p_user_id := NEW.user_id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_gap_boundary_learning ON knowledge_gaps;
CREATE TRIGGER knowledge_gap_boundary_learning
  BEFORE INSERT OR UPDATE ON knowledge_gaps
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_knowledge_boundary_learning();
