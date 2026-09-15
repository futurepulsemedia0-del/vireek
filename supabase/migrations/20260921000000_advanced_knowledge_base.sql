/*
  # Advanced Knowledge Base

  ## Why
  Today a tenant's business facts live in two thin places: the free-text
  `business_profile.faqs` array and the `price_book_items` table. Neither
  can hold "what's your warranty on a compressor swap", "do you work in
  Marin County", or "what does the service call fee cover" — so the AI
  receptionist either improvises or falls back to "someone will call you
  back", which is the exact failure the product exists to remove.

  This adds a real, versioned, searchable knowledge base per tenant, and
  the hybrid search that makes it usable mid-call.

  ## Design decisions worth knowing

  1. **No pgvector dependency.** Embeddings are stored as `double
     precision[]` and scored with a plain SQL cosine. A tenant knowledge
     base is hundreds of articles, not millions, so brute force is a few
     milliseconds — and it means this migration runs on any Postgres with
     no extension, no index build, and no ivfflat tuning. If a tenant ever
     grows past ~5k articles, swap the column to `vector(1024)` and the
     `semantic` CTE below to `<=>`; nothing else changes.

  2. **Hybrid, not semantic-only.** Lexical (`tsvector`, weighted so a
     title match beats a body match) and semantic results are fused with
     Reciprocal Rank Fusion. Lexical alone misses "can you come out
     tonight" → "after-hours policy"; semantic alone misses exact model
     numbers and brand names, which callers use constantly. Fusion gets
     both, and the whole thing degrades to lexical-only when no embedding
     provider is configured — search never hard-depends on an API key.

  3. **Gaps are first-class.** Every question the search can't answer is
     recorded in `knowledge_gaps` and de-duplicated, so the dashboard can
     show "callers asked this 7 times and you have no answer" and turn it
     into an article in one click. This is what makes the knowledge base
     improve itself instead of rotting.

  4. **Versioned.** Every edit snapshots the previous body into
     `knowledge_article_versions`. A wrong price or policy going out over
     the phone is a real liability; someone has to be able to see what
     changed, when, and by whom, and roll it back.

  ## Security
  RLS on all three tables, scoped with `public.get_account_owner_id()` —
  the same helper `calls`, `leads` and `jobs` use — so team members see
  their account's knowledge, never another tenant's. The search function
  is SECURITY INVOKER on purpose: it runs under the caller's RLS. The
  vapi-webhook reaches it with the service-role key and passes the tenant
  id it already resolved.
*/

-- =============================================================
-- 1. ARTICLES
-- =============================================================

CREATE TABLE IF NOT EXISTS knowledge_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  title text NOT NULL,
  /* The spoken answer. Kept short on purpose: this is what the voice
     assistant reads out, so it must be one or two sentences, not a wiki
     page. `body` holds the long version for humans and for chat. */
  summary text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',

  category text,
  keywords text[] NOT NULL DEFAULT '{}',

  /* Who is allowed to hear this answer. 'team' facts (margins, vendor
     costs, "never quote below X") must never reach a caller. */
  audience text NOT NULL DEFAULT 'all'
    CHECK (audience IN ('all', 'ai', 'customer', 'team')),

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),

  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'faq_import', 'gap', 'price_book')),

  /* Facts expire. A seasonal promo or a 2026 permit fee should stop being
     said out loud on its own rather than quietly going stale. */
  expires_on date,

  embedding double precision[],
  embedding_model text,
  embedded_at timestamptz,
  /* Set by the trigger below whenever title/summary/body/keywords change,
     so the embedder job knows exactly what to re-embed. */
  embedding_stale boolean NOT NULL DEFAULT true,

  version integer NOT NULL DEFAULT 1,
  usage_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,

  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(keywords, '{}'), ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_knowledge_articles_user ON knowledge_articles(user_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_search ON knowledge_articles USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_stale ON knowledge_articles(embedding_stale) WHERE embedding_stale;

ALTER TABLE knowledge_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_knowledge_articles" ON knowledge_articles;
CREATE POLICY "select_own_knowledge_articles" ON knowledge_articles
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_knowledge_articles" ON knowledge_articles;
CREATE POLICY "insert_own_knowledge_articles" ON knowledge_articles
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_knowledge_articles" ON knowledge_articles;
CREATE POLICY "update_own_knowledge_articles" ON knowledge_articles
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_knowledge_articles" ON knowledge_articles;
CREATE POLICY "delete_own_knowledge_articles" ON knowledge_articles
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. VERSION HISTORY
-- =============================================================

CREATE TABLE IF NOT EXISTS knowledge_article_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  body text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  status text NOT NULL,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_versions_article
  ON knowledge_article_versions(article_id, version DESC);

ALTER TABLE knowledge_article_versions ENABLE ROW LEVEL SECURITY;

-- Read-only history. Rows are written by the trigger below (which runs as
-- the table owner), never by a client, so an edit can't be erased.
DROP POLICY IF EXISTS "select_own_knowledge_versions" ON knowledge_article_versions;
CREATE POLICY "select_own_knowledge_versions" ON knowledge_article_versions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. GAPS — questions with no good answer
-- =============================================================

CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  question text NOT NULL,
  /* lower(trim(question)) — the dedupe key, so 40 callers asking the same
     thing is one row with asked_count = 40, not 40 rows of noise. */
  question_key text NOT NULL,
  source text NOT NULL DEFAULT 'voice'
    CHECK (source IN ('voice', 'chat', 'dashboard', 'sms')),
  asked_count integer NOT NULL DEFAULT 1,
  first_asked_at timestamptz NOT NULL DEFAULT now(),
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  sample_call_id uuid,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'dismissed')),
  resolved_article_id uuid REFERENCES knowledge_articles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_gaps_dedupe
  ON knowledge_gaps(user_id, question_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_open
  ON knowledge_gaps(user_id, status, asked_count DESC);

ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_knowledge_gaps" ON knowledge_gaps;
CREATE POLICY "select_own_knowledge_gaps" ON knowledge_gaps
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_knowledge_gaps" ON knowledge_gaps;
CREATE POLICY "update_own_knowledge_gaps" ON knowledge_gaps
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_knowledge_gaps" ON knowledge_gaps;
CREATE POLICY "delete_own_knowledge_gaps" ON knowledge_gaps
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT policy: gaps are recorded through record_knowledge_gap().

-- =============================================================
-- 4. TRIGGERS — versioning, staleness, updated_at
-- =============================================================

CREATE OR REPLACE FUNCTION public.knowledge_articles_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();

  -- Content changed: snapshot the old row and mark the vector stale.
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.keywords IS DISTINCT FROM OLD.keywords
  THEN
    INSERT INTO knowledge_article_versions (
      article_id, user_id, version, title, summary, body, keywords, status, changed_by
    )
    VALUES (
      OLD.id, OLD.user_id, OLD.version, OLD.title, OLD.summary, OLD.body,
      OLD.keywords, OLD.status, auth.uid()
    );

    NEW.version := OLD.version + 1;
    NEW.embedding_stale := true;
    NEW.updated_by := COALESCE(auth.uid(), OLD.updated_by);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_knowledge_articles_before_update ON knowledge_articles;
CREATE TRIGGER trg_knowledge_articles_before_update
  BEFORE UPDATE ON knowledge_articles
  FOR EACH ROW EXECUTE FUNCTION public.knowledge_articles_before_update();

-- =============================================================
-- 5. SIMILARITY — cosine over float8[], no extension required
-- =============================================================

CREATE OR REPLACE FUNCTION public.array_cosine_similarity(a double precision[], b double precision[])
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL THEN NULL
    WHEN array_length(a, 1) IS DISTINCT FROM array_length(b, 1) THEN NULL
    ELSE (
      SELECT SUM(x * y) / NULLIF(sqrt(SUM(x * x)) * sqrt(SUM(y * y)), 0)
      FROM unnest(a, b) AS t(x, y)
    )
  END;
$$;

-- =============================================================
-- 6. HYBRID SEARCH — lexical + semantic, fused with RRF
-- =============================================================

/*
  Returns the best `p_limit` articles for a natural-language question.

  - `p_embedding` NULL  → lexical only (no embedding provider configured).
  - `p_audience`  NULL  → no audience filter beyond 'team' exclusion rules
    applied by the caller. Pass 'ai' from the voice webhook so internal-only
    articles can never be read out to a caller.
  - Archived, unpublished and expired articles are never returned.

  RRF constant k = 60 is the standard value from the original paper; it
  keeps a strong rank-2 hit from one retriever competitive with a rank-1
  hit from the other, which is the behaviour we want when a caller's
  wording matches one retriever much better than the other.
*/
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
  semantic_rank integer
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
      )::integer AS rnk
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
      s.rnk AS semantic_rank
    FROM lexical l
    FULL OUTER JOIN semantic s ON s.id = l.id
  )
  SELECT
    b.id, b.title, b.summary, b.body, b.category, b.audience,
    f.score, f.lexical_rank, f.semantic_rank
  FROM fused f
  JOIN base b ON b.id = f.id
  ORDER BY f.score DESC, b.usage_count DESC
  LIMIT GREATEST(1, LEAST(p_limit, 20));
$$;

GRANT EXECUTE ON FUNCTION public.search_knowledge_articles(uuid, text, double precision[], text, integer)
  TO authenticated, service_role;

-- =============================================================
-- 7. USAGE + GAP RECORDING
-- =============================================================

CREATE OR REPLACE FUNCTION public.touch_knowledge_articles(p_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE knowledge_articles
  SET usage_count = usage_count + 1, last_used_at = now()
  WHERE id = ANY(COALESCE(p_ids, '{}'))
    -- Definer rights, so scope the write: a signed-in client can only
    -- touch its own account's rows. auth.uid() is NULL for the service
    -- role (the vapi-webhook), which is already tenant-scoped upstream.
    AND (auth.uid() IS NULL OR user_id = public.get_account_owner_id());
$$;

GRANT EXECUTE ON FUNCTION public.touch_knowledge_articles(uuid[]) TO authenticated, service_role;

/*
  Records an unanswered question. Idempotent per (tenant, question): the
  second time someone asks it, `asked_count` goes up instead of a new row
  appearing. A gap already marked 'answered' or 'dismissed' re-opens if the
  question keeps coming back — that usually means the article that was
  written for it isn't actually matching.
*/
CREATE OR REPLACE FUNCTION public.record_knowledge_gap(
  p_user_id uuid,
  p_question text,
  p_source text DEFAULT 'voice',
  p_call_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_question IS NULL OR length(trim(p_question)) < 3 THEN
    RETURN NULL;
  END IF;

  v_key := left(lower(regexp_replace(trim(p_question), '\s+', ' ', 'g')), 300);

  INSERT INTO knowledge_gaps (user_id, question, question_key, source, sample_call_id)
  VALUES (p_user_id, left(trim(p_question), 500), v_key, COALESCE(p_source, 'voice'), p_call_id)
  ON CONFLICT (user_id, question_key) DO UPDATE
    SET asked_count = knowledge_gaps.asked_count + 1,
        last_asked_at = now(),
        sample_call_id = COALESCE(EXCLUDED.sample_call_id, knowledge_gaps.sample_call_id),
        status = CASE WHEN knowledge_gaps.status = 'dismissed' THEN 'dismissed' ELSE 'open' END
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_knowledge_gap(uuid, text, text, uuid) TO authenticated, service_role;

-- =============================================================
-- 8. ONE-CLICK IMPORT of the existing business_profile FAQs
-- =============================================================

/*
  Moves whatever is already in `business_profile.faqs` into real articles so
  a tenant's knowledge base isn't empty on day one. Safe to run twice: it
  skips any FAQ whose question already exists as an article title.
  Returns the number of articles created.
*/
CREATE OR REPLACE FUNCTION public.import_faqs_to_knowledge(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_faq jsonb;
  v_count integer := 0;
BEGIN
  FOR v_faq IN
    SELECT jsonb_array_elements(COALESCE(bp.faqs, '[]'::jsonb))
    FROM business_profile bp
    WHERE bp.user_id = p_user_id
  LOOP
    CONTINUE WHEN COALESCE(trim(v_faq->>'question'), '') = '';

    IF EXISTS (
      SELECT 1 FROM knowledge_articles a
      WHERE a.user_id = p_user_id AND lower(a.title) = lower(trim(v_faq->>'question'))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO knowledge_articles (user_id, title, summary, body, source, status, audience, created_by)
    VALUES (
      p_user_id,
      trim(v_faq->>'question'),
      left(COALESCE(v_faq->>'answer', ''), 400),
      COALESCE(v_faq->>'answer', ''),
      'faq_import',
      'published',
      'all',
      auth.uid()
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_faqs_to_knowledge(uuid) TO authenticated;
