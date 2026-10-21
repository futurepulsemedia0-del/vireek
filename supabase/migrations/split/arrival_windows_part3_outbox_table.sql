-- Run this part ALONE, then the next. If you get a lock timeout, just run it again.
SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 3. Customer-notification outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arrival_window_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('confirmed', 'narrowed', 'changed')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  previous_start timestamptz,
  previous_end timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  send_after timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_arrival_window_notif_dedupe
  ON arrival_window_notifications (job_id, kind, window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_arrival_window_notif_queue
  ON arrival_window_notifications (send_after) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_arrival_window_notif_job
  ON arrival_window_notifications (job_id, created_at DESC);

ALTER TABLE arrival_window_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "arrival_window_notifications_select_own" ON arrival_window_notifications;
CREATE POLICY "arrival_window_notifications_select_own" ON arrival_window_notifications
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies on purpose: only SECURITY DEFINER code below writes here.
