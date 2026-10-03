-- Staff-only review queue for submitted marketplace agent versions.
-- (Publishers can only see their own versions via RLS, so staff need a
-- dedicated SECURITY DEFINER read. Staff = profiles.is_staff.)

CREATE OR REPLACE FUNCTION public.list_marketplace_review_queue()
RETURNS TABLE (
  version_id uuid, agent_id uuid, agent_name text, agent_slug text, publisher_name text,
  endpoint_url text, version text, manifest jsonb, manifest_hash text, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  RETURN QUERY
  SELECT v.id, a.id, a.name, a.slug, a.publisher_name, a.endpoint_url, v.version, v.manifest, v.manifest_hash, v.created_at
  FROM marketplace_agent_versions v
  JOIN marketplace_agents a ON a.id = v.agent_id
  WHERE v.status = 'submitted' AND a.status <> 'suspended'
  ORDER BY v.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.list_marketplace_review_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_marketplace_review_queue() TO authenticated;
