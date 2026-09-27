/*
  # Technician Knowledge Capture — Confidence + Expert Verification

  ## Why
  knowledge_articles already receives voice-note drafts from the
  tribal-knowledge-voice-capture pipeline (source='voice_note',
  status='draft'). What's missing is exactly what a senior technician's
  field claim needs before it becomes company-wide knowledge: how sure
  the extraction is, and a second expert's sign-off before it goes live.

  Additive only — same table, same philosophy as every other Company
  Brain migration. No parallel table.

  ## What this does
  1. confidence_score (0-100) — how specific/verifiable the AI judged
     the technician's claim (specific model + error code + fix = high;
     a vague hunch = low). Set once, at capture time.
  2. verified_by / verified_at / verification_note — the second expert
     who confirmed the draft is correct. Must be a different team
     member than whoever contributed it.
  3. verify_knowledge_article() RPC — the only way those columns get
     set. Requires the caller to be a team member on the account,
     different from contributed_by, and the article to be a draft.
     On success it flips status -> 'published', so a verified field
     fix is immediately live for the AI + every technician.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy tribal-knowledge-voice-capture --no-verify-jwt
    3. Apply the src/lib/knowledge.ts + src/pages/KnowledgeBasePage.tsx edits.
*/

ALTER TABLE knowledge_articles
  ADD COLUMN IF NOT EXISTS confidence_score integer,
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_note text;

ALTER TABLE knowledge_articles
  DROP CONSTRAINT IF EXISTS knowledge_articles_confidence_score_check;
ALTER TABLE knowledge_articles
  ADD CONSTRAINT knowledge_articles_confidence_score_check
  CHECK (confidence_score IS NULL OR (confidence_score BETWEEN 0 AND 100));

COMMENT ON COLUMN knowledge_articles.confidence_score IS
  'How specific/verifiable the voice-capture extraction was (0-100). Null for non-AI-extracted articles.';
COMMENT ON COLUMN knowledge_articles.verified_by IS
  'Team member who confirmed a voice-note draft is correct. Must differ from contributed_by.';

CREATE OR REPLACE FUNCTION public.verify_knowledge_article(
  p_article_id uuid,
  p_note text DEFAULT NULL
)
RETURNS knowledge_articles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_caller_member uuid;
  v_row knowledge_articles;
BEGIN
  SELECT public.get_account_owner_id() INTO v_owner;

  SELECT id INTO v_caller_member
  FROM team_members
  WHERE member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
    AND user_id = v_owner
  LIMIT 1;

  IF v_caller_member IS NULL THEN
    RAISE EXCEPTION 'Only a team member on this account can verify knowledge.';
  END IF;

  SELECT * INTO v_row FROM knowledge_articles
  WHERE id = p_article_id AND user_id = v_owner
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Article not found.';
  END IF;

  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft article can be verified.';
  END IF;

  IF v_row.contributed_by IS NOT NULL AND v_row.contributed_by = v_caller_member THEN
    RAISE EXCEPTION 'Ask a different technician to verify this one — the contributor can''t verify their own note.';
  END IF;

  UPDATE knowledge_articles
  SET verified_by = v_caller_member,
      verified_at = now(),
      verification_note = p_note,
      status = 'published',
      updated_at = now()
  WHERE id = p_article_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_knowledge_article(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_knowledge_article(uuid, text) TO authenticated;
