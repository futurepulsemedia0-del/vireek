/*
  # Dispatch Copilot — per-user hourly rate limit

  One row per "Ask AI Copilot" click. Written and read ONLY by the dispatch-copilot edge function
  (service role): RLS is enabled with no policies, so no client can read, reset or forge a counter.
  The function also prunes rows older than 7 days for the calling user on every run.
*/

CREATE TABLE IF NOT EXISTS public.dispatch_copilot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_copilot_runs_actor_time
  ON public.dispatch_copilot_runs (actor_id, created_at DESC);

ALTER TABLE public.dispatch_copilot_runs ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service role only.
