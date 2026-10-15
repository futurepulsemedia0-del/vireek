/*
  # Live Calls — realtime board of calls in progress

  ## Why
  The `calls` table only gets its row at call start/end with no "in progress"
  state, so owners could not see a call while it was happening, watch the AI,
  or step in. This adds a small, purpose-built live layer that the
  vapi-webhook feeds from its existing server messages.

  ## What this adds
  1. `live_calls`       one row per Vapi call: status, caller, rolling
                        intent / sentiment, emergency + "wants a human"
                        flags, hand-off audit fields.
  2. `live_call_lines`  FINAL transcript utterances, one row each (streamed to
                        the dashboard through Supabase Realtime).
  3. A trigger on `calls` that mirrors `is_emergency` and
     `human_transfer_requested` onto the live row and closes it when the
     end-of-call report lands (safety net if a status event is missed).

  ## Security
  - Written ONLY by the vapi-webhook / live-call-control (service role).
    `authenticated` gets SELECT only, so the dashboard can never fabricate a
    call or a hand-off.
  - SELECT requires `user_id = get_account_owner_id()` AND
    `can_view_live_calls()` (the DB-level twin of the dashboard's
    `can_manage_numbers` gate): live transcripts contain caller PII.
  - Rows are tenant-keyed by the account OWNER id, so team members receive
    the owner's calls, never another account's.
*/

-- =============================================================
-- 0. Permission helper (same shape as can_manage_ai_security)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_view_live_calls()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_manage_numbers', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_manage_numbers', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_live_calls() TO authenticated;

-- =============================================================
-- 1. live_calls
-- =============================================================

CREATE TABLE IF NOT EXISTS public.live_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL UNIQUE,
  caller_phone text,
  caller_name text,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('ringing', 'in_progress', 'ended')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason text,

  intent text CHECK (intent IS NULL OR intent IN
    ('emergency', 'complaint', 'reschedule_cancel', 'price_quote', 'existing_customer', 'new_inquiry')),
  sentiment text NOT NULL DEFAULT 'neutral' CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  sentiment_score real NOT NULL DEFAULT 0,
  signal_text text NOT NULL DEFAULT '',
  wants_human boolean NOT NULL DEFAULT false,
  is_emergency boolean NOT NULL DEFAULT false,
  human_transfer_requested boolean NOT NULL DEFAULT false,

  last_line_role text CHECK (last_line_role IS NULL OR last_line_role IN ('caller', 'assistant')),
  last_line_preview text,
  last_line_at timestamptz,

  handoff_status text NOT NULL DEFAULT 'none' CHECK (handoff_status IN ('none', 'requested', 'failed')),
  handoff_mode text CHECK (handoff_mode IS NULL OR handoff_mode IN ('take_over', 'transfer')),
  handoff_by uuid,
  handoff_at timestamptz,
  handoff_error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_calls_user_status_started
  ON public.live_calls (user_id, status, started_at DESC);

-- =============================================================
-- 2. live_call_lines (final utterances only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.live_call_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  live_call_id uuid NOT NULL REFERENCES public.live_calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('caller', 'assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_call_lines_call
  ON public.live_call_lines (live_call_id, id);
CREATE INDEX IF NOT EXISTS idx_live_call_lines_user
  ON public.live_call_lines (user_id);

-- =============================================================
-- 3. Mirror flags from `calls` + close live rows (safety net)
-- =============================================================

CREATE OR REPLACE FUNCTION public.sync_live_call_from_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.vapi_call_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.live_calls
     SET is_emergency = NEW.is_emergency,
         human_transfer_requested = NEW.human_transfer_requested,
         updated_at = now()
   WHERE vapi_call_id = NEW.vapi_call_id
     AND (is_emergency IS DISTINCT FROM NEW.is_emergency
          OR human_transfer_requested IS DISTINCT FROM NEW.human_transfer_requested);

  -- duration_seconds is only set by the end-of-call report.
  IF NEW.duration_seconds IS NOT NULL THEN
    UPDATE public.live_calls
       SET status = 'ended', ended_at = COALESCE(ended_at, now()), updated_at = now()
     WHERE vapi_call_id = NEW.vapi_call_id AND status <> 'ended';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_calls_sync_live_call ON public.calls;
CREATE TRIGGER trg_calls_sync_live_call
  AFTER INSERT OR UPDATE ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.sync_live_call_from_calls();

-- =============================================================
-- 4. Row Level Security (SELECT only for the dashboard)
-- =============================================================

ALTER TABLE public.live_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_call_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_calls_select" ON public.live_calls;
CREATE POLICY "live_calls_select" ON public.live_calls
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_live_calls());

DROP POLICY IF EXISTS "live_call_lines_select" ON public.live_call_lines;
CREATE POLICY "live_call_lines_select" ON public.live_call_lines
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_live_calls());

-- =============================================================
-- 5. Realtime
-- =============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.live_calls;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.live_call_lines;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
