/*
  # Voice Studio test calls: per-account rate limiting for "call my phone".
  Rollback: DROP TABLE public.voice_test_calls;
*/
CREATE TABLE IF NOT EXISTS public.voice_test_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  ok boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_test_calls_user_time ON public.voice_test_calls (user_id, created_at DESC);

ALTER TABLE public.voice_test_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_test_calls_select ON public.voice_test_calls;
CREATE POLICY voice_test_calls_select ON public.voice_test_calls
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
GRANT SELECT ON public.voice_test_calls TO authenticated;
