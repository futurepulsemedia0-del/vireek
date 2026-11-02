-- Time-to-first-success per API key: seconds from key creation to its first 2xx request.
-- security_invoker: a signed-in owner sees only their own keys (RLS on the base tables applies).
-- For team-wide quickstart metrics query it with the service role.
-- Caveat: api_request_logs keeps 30 days, so keys older than that show NULL.
-- Rollback: DROP VIEW api_key_first_success;
CREATE OR REPLACE VIEW public.api_key_first_success
WITH (security_invoker = true) AS
SELECT
  k.id AS api_key_id,
  k.mode,
  k.created_at AS key_created_at,
  min(l.created_at) FILTER (WHERE l.status BETWEEN 200 AND 299 AND l.created_at >= k.created_at) AS first_success_at,
  EXTRACT(EPOCH FROM (min(l.created_at) FILTER (WHERE l.status BETWEEN 200 AND 299 AND l.created_at >= k.created_at) - k.created_at))::integer AS seconds_to_first_success
FROM public.api_keys k
LEFT JOIN public.api_request_logs l ON l.api_key_id = k.id
GROUP BY k.id, k.mode, k.created_at;
