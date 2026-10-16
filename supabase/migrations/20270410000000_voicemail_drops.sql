/*
  # Voicemail Drops library

  Pre-recorded voicemail drops for outbound campaigns.

  ## Objects
  - voicemail_drops         : library rows (one per audio file), account-scoped
  - voicemail_drop_events   : append-only usage log (written only by service_role)
  - voicemail_drop_stats    : per-drop usage aggregates (security_invoker view)
  - record_voicemail_drop_use : service_role RPC the dialer calls before dropping
  - storage bucket voicemail-drops (private) + storage.objects policies

  ## Rules
  - Everything is scoped by account_owner_id = get_account_owner_id().
  - Any account member can read; only managers (identity_is_manager) can write.
  - compliance_ready is GENERATED: all four checklist flags must be true.
  - record_voicemail_drop_use refuses archived or non-compliant drops.

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, outbound_calls
*/

-- 1) Library ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  storage_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  duration_seconds integer,
  transcript text,
  campaign_types text[] NOT NULL DEFAULT '{}',
  uses_ai_voice boolean NOT NULL DEFAULT false,
  discloses_business_name boolean NOT NULL DEFAULT false,
  includes_callback_number boolean NOT NULL DEFAULT false,
  includes_opt_out boolean NOT NULL DEFAULT false,
  consent_confirmed boolean NOT NULL DEFAULT false,
  compliance_ready boolean GENERATED ALWAYS AS (
    discloses_business_name AND includes_callback_number AND includes_opt_out AND consent_confirmed
  ) STORED,
  status text NOT NULL DEFAULT 'active',
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT vd_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT vd_text_check CHECK (
    (description IS NULL OR char_length(description) <= 500)
    AND (transcript IS NULL OR char_length(transcript) <= 2000)
  ),
  CONSTRAINT vd_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vd_mime_check CHECK (mime_type IN ('audio/mpeg', 'audio/wav')),
  CONSTRAINT vd_size_check CHECK (size_bytes BETWEEN 1 AND 15728640),
  CONSTRAINT vd_duration_check CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 120),
  CONSTRAINT vd_campaigns_check CHECK (
    campaign_types <@ ARRAY['quote_followup', 'appointment_reminder', 'review_request_call']::text[]
  ),
  CONSTRAINT vd_path_check CHECK (storage_path LIKE account_owner_id::text || '/%'),
  CONSTRAINT vd_path_unique UNIQUE (storage_path)
);

CREATE INDEX IF NOT EXISTS idx_vd_owner_status ON voicemail_drops(account_owner_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vd_active_name
  ON voicemail_drops(account_owner_id, lower(btrim(name))) WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.voicemail_drops_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'owner, file and creation time of a voicemail drop are immutable' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    NEW.archived_at := now();
  ELSIF NEW.status = 'active' THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_voicemail_drops_guard ON voicemail_drops;
CREATE TRIGGER trg_voicemail_drops_guard
  BEFORE UPDATE ON voicemail_drops
  FOR EACH ROW EXECUTE FUNCTION public.voicemail_drops_guard();

ALTER TABLE voicemail_drops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vd_select" ON voicemail_drops;
CREATE POLICY "vd_select" ON voicemail_drops FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "vd_insert" ON voicemail_drops;
CREATE POLICY "vd_insert" ON voicemail_drops FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "vd_update" ON voicemail_drops;
CREATE POLICY "vd_update" ON voicemail_drops FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "vd_delete" ON voicemail_drops;
CREATE POLICY "vd_delete" ON voicemail_drops FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 2) Usage events (append-only; service_role writes via RPC) ------------------------------
CREATE TABLE IF NOT EXISTS voicemail_drop_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  drop_id uuid NOT NULL REFERENCES voicemail_drops(id) ON DELETE CASCADE,
  outbound_call_id uuid REFERENCES outbound_calls(id) ON DELETE SET NULL,
  campaign_type text,
  outcome text NOT NULL DEFAULT 'delivered',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vde_outcome_check CHECK (outcome IN ('delivered', 'failed')),
  CONSTRAINT vde_campaign_check CHECK (
    campaign_type IS NULL
    OR campaign_type IN ('quote_followup', 'appointment_reminder', 'review_request_call')
  )
);

CREATE INDEX IF NOT EXISTS idx_vde_drop ON voicemail_drop_events(drop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vde_owner ON voicemail_drop_events(account_owner_id, created_at DESC);

ALTER TABLE voicemail_drop_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vde_select" ON voicemail_drop_events;
CREATE POLICY "vde_select" ON voicemail_drop_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE ON voicemail_drop_events FROM anon, authenticated;

-- 3) Stats view (RLS of the caller applies) -------------------------------------------------
CREATE OR REPLACE VIEW voicemail_drop_stats WITH (security_invoker = true) AS
SELECT
  d.id AS drop_id,
  d.account_owner_id,
  count(e.id) AS total_uses,
  count(e.id) FILTER (WHERE e.created_at >= now() - interval '30 days') AS uses_30d,
  count(e.id) FILTER (WHERE e.outcome = 'delivered') AS delivered,
  count(e.id) FILTER (WHERE e.outcome = 'failed') AS failed,
  max(e.created_at) AS last_used_at
FROM voicemail_drops d
LEFT JOIN voicemail_drop_events e ON e.drop_id = d.id
GROUP BY d.id, d.account_owner_id;

GRANT SELECT ON voicemail_drop_stats TO authenticated;

-- 4) Dialer hook: records a use, refuses archived / non-compliant drops ---------------------
CREATE OR REPLACE FUNCTION public.record_voicemail_drop_use(
  p_drop_id uuid,
  p_outbound_call_id uuid DEFAULT NULL,
  p_campaign_type text DEFAULT NULL,
  p_outcome text DEFAULT 'delivered'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_drop voicemail_drops%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_drop FROM voicemail_drops WHERE id = p_drop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'voicemail drop not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_drop.status <> 'active' THEN
    RAISE EXCEPTION 'voicemail drop is archived' USING ERRCODE = '22023';
  END IF;
  IF NOT v_drop.compliance_ready THEN
    RAISE EXCEPTION 'voicemail drop has not passed the compliance checklist' USING ERRCODE = '22023';
  END IF;

  INSERT INTO voicemail_drop_events (account_owner_id, drop_id, outbound_call_id, campaign_type, outcome)
  VALUES (v_drop.account_owner_id, v_drop.id, p_outbound_call_id, p_campaign_type, p_outcome)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_voicemail_drop_use(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_voicemail_drop_use(uuid, uuid, text, text) TO service_role;

-- 5) Storage: private bucket, folder = account owner id -----------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'voicemail-drops', 'voicemail-drops', false, 15728640,
  ARRAY['audio/mpeg', 'audio/wav']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "vd_storage_select" ON storage.objects;
CREATE POLICY "vd_storage_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voicemail-drops'
         AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "vd_storage_insert" ON storage.objects;
CREATE POLICY "vd_storage_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'voicemail-drops'
              AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
              AND public.identity_is_manager());

DROP POLICY IF EXISTS "vd_storage_update" ON storage.objects;
CREATE POLICY "vd_storage_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'voicemail-drops'
         AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
         AND public.identity_is_manager())
  WITH CHECK (bucket_id = 'voicemail-drops'
              AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
              AND public.identity_is_manager());

DROP POLICY IF EXISTS "vd_storage_delete" ON storage.objects;
CREATE POLICY "vd_storage_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'voicemail-drops'
         AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
         AND public.identity_is_manager());
