-- Public helpful / not-helpful feedback for /help/:slug articles.
-- Anonymous visitors write ONLY through submit_help_feedback(); the table has RLS on and
-- no policies, and anon/authenticated have no direct table privileges.

CREATE TABLE IF NOT EXISTS public.help_article_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_slug text NOT NULL
    CHECK (article_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(article_slug) <= 120),
  visitor_id text NOT NULL CHECK (char_length(visitor_id) BETWEEN 8 AND 64),
  helpful boolean NOT NULL,
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_slug, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_help_feedback_slug ON public.help_article_feedback (article_slug, helpful);
CREATE INDEX IF NOT EXISTS idx_help_feedback_visitor ON public.help_article_feedback (visitor_id, updated_at DESC);

ALTER TABLE public.help_article_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.help_article_feedback FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_help_feedback(
  p_slug text,
  p_helpful boolean,
  p_comment text DEFAULT NULL,
  p_visitor_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comment text;
  v_recent integer;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(p_slug) > 120 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_slug');
  END IF;
  IF p_helpful IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_vote');
  END IF;
  IF p_visitor_id IS NULL OR char_length(p_visitor_id) NOT BETWEEN 8 AND 64 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_visitor');
  END IF;

  v_comment := NULLIF(btrim(left(coalesce(p_comment, ''), 1000)), '');

  -- Spam damping (visitor_id is client-supplied, so this is not a security boundary).
  SELECT count(*) INTO v_recent
  FROM help_article_feedback
  WHERE visitor_id = p_visitor_id AND updated_at > now() - interval '1 hour';
  IF v_recent >= 30 THEN
    RETURN jsonb_build_object('success', false, 'error', 'rate_limited');
  END IF;

  INSERT INTO help_article_feedback (article_slug, visitor_id, helpful, comment)
  VALUES (p_slug, p_visitor_id, p_helpful, v_comment)
  ON CONFLICT (article_slug, visitor_id)
  DO UPDATE SET helpful = EXCLUDED.helpful, comment = EXCLUDED.comment, updated_at = now();

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_help_feedback(text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_help_feedback(text, boolean, text, text) TO anon, authenticated;

-- Team-side reporting (service role / SQL editor only; not exposed to anon or authenticated).
CREATE OR REPLACE VIEW public.help_article_feedback_summary AS
SELECT article_slug,
       count(*) FILTER (WHERE helpful) AS helpful_count,
       count(*) FILTER (WHERE NOT helpful) AS not_helpful_count,
       max(updated_at) AS last_feedback_at
FROM public.help_article_feedback
GROUP BY article_slug;
REVOKE ALL ON public.help_article_feedback_summary FROM anon, authenticated;
