/*
  # Voice engine flag (per business)

  Chooses which live-voice engine a tenant uses. Vapi is the default and the ONLY engine that is
  active today: no row = Vapi. The OpenAI Realtime engine is a stub (see docs/voice-engines.md).

  ## Security model (same pattern as the missed-call audit tables)
  - service_role-only: RLS enabled and deliberately NO policies for anon/authenticated.
  - Why not a column on business_profile? That table has "update_own_business_profile", so a tenant
    could flip their own engine from the browser. This table can only be written by staff / service role.

  ## Rollout (nothing changes until ALL of these are true)
  1. this table has a row with engine = 'openai_realtime' for the tenant,
  2. the secret VOICE_OPENAI_REALTIME_ENABLED = true is set on the Edge Functions,
  3. the OpenAI engine reports isReady() (it never does while it is a stub).

  ## Enable for one tenant later (run manually as service role)
    insert into public.voice_engine_flags (user_id, engine, note)
    values ('<tenant-user-uuid>', 'openai_realtime', 'pilot')
    on conflict (user_id) do update set engine = excluded.engine, note = excluded.note, updated_at = now();

  ## Rollback (safe: nothing else depends on this table; code falls back to Vapi if it is missing)
    drop table if exists public.voice_engine_flags;
*/

CREATE TABLE IF NOT EXISTS public.voice_engine_flags (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  engine text NOT NULL DEFAULT 'vapi' CHECK (engine IN ('vapi', 'openai_realtime')),
  note text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.voice_engine_flags ENABLE ROW LEVEL SECURITY;

-- Belt and braces: even if someone later adds a broad GRANT, browsers never get this table.
REVOKE ALL ON public.voice_engine_flags FROM anon, authenticated;
GRANT ALL ON public.voice_engine_flags TO service_role;
