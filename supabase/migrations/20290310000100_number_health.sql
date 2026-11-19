-- Number reputation monitoring: one row of current health per phone number, plus an audit trail of changes.
--
-- Extends public.phone_numbers (20260915_phone_numbers.sql). Scoped exactly like phone_numbers: the account owner
-- (auth.uid() = user_id). Rows are written only by the scheduled function `number-health-poll` (service role).
-- The only client write is number_health_set_step(), which ticks a remediation step for a number the caller owns.
--
-- What is stored is what a reputation provider REPORTED (spam label, STIR/SHAKEN attestation, names of the sources that
-- labelled the number). There is no computed "reputation score". While no real provider is connected, rows say
-- provider = 'stub', provider_live = false and every value is 'unknown'.

CREATE TABLE IF NOT EXISTS public.number_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,         -- account owner (same as phone_numbers.account_id)
  phone_number_id uuid NOT NULL UNIQUE REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stub' CHECK (char_length(provider) BETWEEN 1 AND 40),
  provider_live boolean NOT NULL DEFAULT false,
  spam_label text NOT NULL DEFAULT 'unknown' CHECK (spam_label IN ('clean', 'suspected', 'flagged', 'unknown')),
  attestation text NOT NULL DEFAULT 'unknown' CHECK (attestation IN ('A', 'B', 'C', 'unknown')),
  label_sources text[] NOT NULL DEFAULT '{}' CHECK (cardinality(label_sources) <= 5),
  status text NOT NULL DEFAULT 'never' CHECK (status IN ('never', 'ok', 'error')),
  checked_at timestamptz,                                                     -- last SUCCESSFUL check
  last_attempt_at timestamptz,                                                -- last attempt, successful or not
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 40),
  remediation_done jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(remediation_done) = 'object' AND octet_length(remediation_done::text) <= 600),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS number_health_user_idx ON public.number_health (user_id);
CREATE INDEX IF NOT EXISTS number_health_attempt_idx ON public.number_health (last_attempt_at NULLS FIRST);

ALTER TABLE public.number_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "number_health_select_own" ON public.number_health;
CREATE POLICY "number_health_select_own" ON public.number_health FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.number_health_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number_id uuid NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('label_changed', 'attestation_changed')),
  from_value text NOT NULL CHECK (char_length(from_value) <= 20),
  to_value text NOT NULL CHECK (char_length(to_value) <= 20),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS number_health_events_number_idx ON public.number_health_events (phone_number_id, created_at DESC);
ALTER TABLE public.number_health_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "number_health_events_select_own" ON public.number_health_events;
CREATE POLICY "number_health_events_select_own" ON public.number_health_events FOR SELECT TO authenticated USING (user_id = auth.uid());

-- No client writes. The scheduled function uses the service role; ticks go through number_health_set_step().
REVOKE INSERT, UPDATE, DELETE ON public.number_health, public.number_health_events FROM anon, authenticated;

-- Tick or untick one remediation step for a number the caller owns. Idempotent; creates the row if the first scheduled
-- run has not happened yet. Step ids are validated by shape here and by the TypeScript list (REMEDIATION_STEP_IDS).
CREATE OR REPLACE FUNCTION public.number_health_set_step(p_number_id uuid, p_step text, p_done boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_done jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF p_step IS NULL OR p_step !~ '^[a-z_]{3,40}$' OR p_done IS NULL THEN RAISE EXCEPTION 'Invalid step' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM phone_numbers WHERE id = p_number_id AND account_id = v_uid) THEN
    RAISE EXCEPTION 'Number not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO number_health (user_id, phone_number_id) VALUES (v_uid, p_number_id) ON CONFLICT (phone_number_id) DO NOTHING;
  UPDATE number_health
     SET remediation_done = CASE WHEN p_done THEN remediation_done || jsonb_build_object(p_step, true) ELSE remediation_done - p_step END,
         updated_at = now()
   WHERE phone_number_id = p_number_id AND user_id = v_uid
   RETURNING remediation_done INTO v_done;
  RETURN jsonb_build_object('success', true, 'remediation_done', coalesce(v_done, '{}'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.number_health_set_step(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.number_health_set_step(uuid, text, boolean) TO authenticated;

/*
## Cron (run once in the Supabase SQL editor; needs pg_cron + pg_net). Every 6 hours; the function itself skips numbers
## checked in the last 5 hours, so a double fire is harmless.

    select cron.schedule('number-health-poll', '15 */6 * * *', $$
      select net.http_post(
        url := '<project-ref>.supabase.co/functions/v1/number-health-poll',
        headers := jsonb_build_object('Authorization','Bearer <service-role-key>','X-Cron-Secret','<CRON_SECRET>'),
        body := '{"mode":"tick"}'::jsonb);
    $$);

## ROLLBACK (manual, destructive; the table only caches provider results, ticks are the only user-entered data)
    -- drop function public.number_health_set_step(uuid, text, boolean);
    -- drop table public.number_health_events, public.number_health cascade;
*/
