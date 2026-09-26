/*
  # Organizational Memory — Decisions, Exceptions & Search

  ## Why
  `org_memory_entries` (20261127000000_organizational_memory_genome.sql)
  already stores playbooks, failure patterns, tribal knowledge and best
  practices, attributed to the person who logged them. It's missing two
  entry types the business actually needs captured — a DECISION that was
  made (and why) and an EXCEPTION granted outside the normal rule — plus
  an explicit "reasoning" field distinct from "what happened", and a way
  to search the whole memory instead of only filtering by type/status.

  This is additive to that table. No parallel table, same philosophy as
  the Company Brain migration that extended knowledge_articles instead of
  forking it.

  ## What this does
  1. Widens org_memory_entries.entry_type to add 'decision' and 'exception'.
  2. Adds `rationale` — the "why", kept separate from `outcome_summary`
     (the "what happened"), because a decision's reasoning is often known
     before its outcome is.
  3. Adds a generated tsvector `search_vector` + GIN index over
     title/situation/action_taken/outcome_summary/rationale, and a
     `search_org_memory()` RPC that ranks by relevance and joins the
     contributor's name in one round trip.
  4. Adds `get_org_memory_summary()` for a dashboard overview (counts per
     type/status, endorsements, distinct contributors).
*/

-- 1) New entry types -------------------------------------------------------
ALTER TABLE org_memory_entries DROP CONSTRAINT IF EXISTS org_memory_entries_entry_type_check;
ALTER TABLE org_memory_entries ADD CONSTRAINT org_memory_entries_entry_type_check
  CHECK (entry_type IN ('winning_playbook', 'failure_pattern', 'tribal_knowledge', 'best_practice', 'decision', 'exception'));

-- 2) Explicit reasoning field ----------------------------------------------
ALTER TABLE org_memory_entries ADD COLUMN IF NOT EXISTS rationale text;
COMMENT ON COLUMN org_memory_entries.rationale IS
  'Why the decision/exception/practice was made — kept separate from outcome_summary, which is what happened as a result.';

-- 3) Full-text search --------------------------------------------------------
ALTER TABLE org_memory_entries ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(situation, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(action_taken, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(rationale, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(outcome_summary, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_org_memory_entries_search ON org_memory_entries USING GIN (search_vector);

CREATE OR REPLACE FUNCTION public.search_org_memory(
  p_query text DEFAULT NULL,
  p_entry_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  entry_type text,
  title text,
  situation text,
  action_taken text,
  rationale text,
  outcome_summary text,
  confidence_score integer,
  sample_size integer,
  source text,
  contributor_id uuid,
  contributor_name text,
  tags text[],
  status text,
  endorsement_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  rank real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id, e.entry_type, e.title, e.situation, e.action_taken, e.rationale, e.outcome_summary,
    e.confidence_score, e.sample_size, e.source, e.contributor_id, tm.member_name AS contributor_name,
    e.tags, e.status, e.endorsement_count, e.created_at, e.updated_at,
    CASE WHEN p_query IS NULL OR p_query = '' THEN 0
      ELSE ts_rank(e.search_vector, websearch_to_tsquery('english', p_query)) END AS rank
  FROM org_memory_entries e
  LEFT JOIN team_members tm ON tm.id = e.contributor_id
  WHERE e.user_id = public.get_account_owner_id()
    AND (p_entry_type IS NULL OR e.entry_type = p_entry_type)
    AND (p_status IS NULL OR e.status = p_status)
    AND (p_query IS NULL OR p_query = '' OR e.search_vector @@ websearch_to_tsquery('english', p_query))
  ORDER BY
    CASE WHEN p_query IS NULL OR p_query = '' THEN e.created_at END DESC,
    CASE WHEN p_query IS NOT NULL AND p_query <> '' THEN ts_rank(e.search_vector, websearch_to_tsquery('english', p_query)) END DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.search_org_memory(text, text, text, integer) TO authenticated;

-- 4) Dashboard summary -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_org_memory_summary()
RETURNS TABLE (
  entry_type text,
  active_count integer,
  needs_review_count integer,
  total_endorsements integer,
  distinct_contributors integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    entry_type,
    count(*) FILTER (WHERE status = 'active')::integer,
    count(*) FILTER (WHERE status = 'needs_review')::integer,
    coalesce(sum(endorsement_count), 0)::integer,
    count(DISTINCT contributor_id)::integer
  FROM org_memory_entries
  WHERE user_id = public.get_account_owner_id()
  GROUP BY entry_type;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_memory_summary() TO authenticated;
