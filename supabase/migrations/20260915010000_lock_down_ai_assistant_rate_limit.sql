-- Closes a real bypass: ai_assistant_rate_limit previously granted the
-- authenticated caller INSERT/UPDATE on their own row, meaning any user
-- could call the Supabase REST API directly (with their own JWT, no need
-- to even touch our Edge Function) and reset their own counter, defeating
-- the rate limit entirely. The Edge Function now enforces this table
-- exclusively via a service-role client, which bypasses RLS — so no
-- authenticated-role policy is needed on this table anymore, matching the
-- same "service-role only" pattern already used by
-- site_assistant_rate_limit and demo_chat_rate_limit.

DROP POLICY IF EXISTS "Users can insert their own rate limit row" ON ai_assistant_rate_limit;
DROP POLICY IF EXISTS "Users can update their own rate limit row" ON ai_assistant_rate_limit;
-- SELECT policy is left in place — harmless, read-only, and lets a user's
-- own dashboard show "X of 30 questions used this hour" if you ever want
-- to surface that. RLS stays enabled; no write path remains for the
-- `authenticated` role.
