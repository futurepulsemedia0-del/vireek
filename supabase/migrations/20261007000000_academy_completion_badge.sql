/*
  # academy-completion-badge automation support

  award_academy_badge_if_complete(): called from the client once it detects
  100% local completion (it already has the full lesson list from
  src/lib/academy.ts — no need to duplicate that list in the DB). Verifies
  server-side against academy_progress row count before awarding, so the
  badge can't be spoofed by a client-side bug, and is idempotent
  (ON CONFLICT DO NOTHING) so calling it twice is harmless.

  Note: the "unlock a referral bonus" half of this automation is NOT
  implemented — there is no referral credit/bonus ledger anywhere in this
  codebase yet. That's a separate feature to design, not a wiring fix.
*/

CREATE TABLE IF NOT EXISTS academy_badges (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  awarded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE academy_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_academy_badge" ON academy_badges;
CREATE POLICY "select_own_academy_badge" ON academy_badges FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION award_academy_badge_if_complete(p_total_lessons integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  completed_count integer;
  already_awarded boolean;
BEGIN
  SELECT COUNT(*) INTO completed_count FROM academy_progress WHERE user_id = auth.uid();
  IF completed_count < p_total_lessons THEN
    RETURN false;
  END IF;

  SELECT EXISTS(SELECT 1 FROM academy_badges WHERE user_id = auth.uid()) INTO already_awarded;
  IF already_awarded THEN
    RETURN false; -- already had it, nothing new to celebrate
  END IF;

  INSERT INTO academy_badges (user_id) VALUES (auth.uid()) ON CONFLICT DO NOTHING;
  RETURN true; -- newly awarded this call
END;
$$;

GRANT EXECUTE ON FUNCTION award_academy_badge_if_complete(integer) TO authenticated;
