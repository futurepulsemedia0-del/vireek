/*
  # Promise Tracker

  ## Why
  On a live call, Sarah (or a human team member) says things like "we'll
  text you a confirmation in 10 minutes," "the technician will be there
  by 2pm tomorrow," or "I'll waive the trip fee." Right now those
  commitments live only in the transcript — nobody tracks whether they
  actually happened. This adds a `promises` table populated by a new
  extraction step at end-of-call-report, plus manual resolution from the
  dashboard.

  ## Design decisions worth knowing
  1. **Hybrid extraction, not fully automatic.** The LLM
     (_shared/ai-core/promiseExtraction.ts) only extracts WHAT was
     promised and a rough relative timeframe ("tomorrow morning" ->
     roughly how many hours out). The actual `due_at` timestamp is
     computed deterministically in vapi-webhook from the call's real end
     time — the same "AI extracts meaning, code does the arithmetic"
     split used in Price Book Enforcement.
  2. **No automatic "broken" status.** This project has no cron
     infrastructure wired up yet (see IMPLEMENTATION_NOTES.md's existing
     note on scheduled jobs not auto-flagging), so a promise never
     silently flips to "broken" on its own. The dashboard computes
     "overdue" client-side from `due_at` vs. now for display, but the
     status column itself only changes when a human resolves it
     (fulfilled / broken / cancelled) — never a false machine verdict.
  3. **Only 0-5 promises per call**, capped in the extraction module —
     if a call surfaces more, something is almost certainly being
     mis-extracted, and 5 genuine commitments in one call is already a
     lot for a human to track.
*/

CREATE TABLE IF NOT EXISTS promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,

  customer_name text,
  customer_phone text,

  promise_text text NOT NULL,
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('callback', 'arrival_time', 'pricing', 'follow_up', 'documentation', 'other')),

  due_description text,
  due_at timestamptz,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fulfilled', 'broken', 'cancelled')),
  resolved_at timestamptz,
  resolution_note text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promises_user_id ON promises(user_id);
CREATE INDEX IF NOT EXISTS idx_promises_call_id ON promises(call_id);
CREATE INDEX IF NOT EXISTS idx_promises_user_status_due ON promises(user_id, status, due_at);

ALTER TABLE promises ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_promises" ON promises
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_promises" ON promises
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- No INSERT policy for `authenticated` — rows are only ever created by
-- the webhook's service-role client, same pattern as `calls` and
-- `price_lookup_log`.
