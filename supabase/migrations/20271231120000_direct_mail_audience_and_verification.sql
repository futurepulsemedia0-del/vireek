/*
  # Direct mail: segment audiences + address verification

  - direct_mail_pieces: verification_status / verification_note / verified_at. The ORIGINAL address is never
    rewritten, so address_key (de-duplication) stays stable.
  - direct_mail_campaigns: remembers which marketing segment the audience was built from (name snapshot, so the
    dashboard needs no join and never breaks if the segment is later renamed or deleted).
  - direct_mail_apply_verification(): service role only, called by the direct-mail-verify edge function.
  - direct_mail_verification_summary() / direct_mail_link_audience(): manager-only RPCs for the dashboard.

  NOT LIVE-VERIFIED against Lob's US verification API (see docs/DIRECT_MAIL.md).
*/

ALTER TABLE public.direct_mail_pieces
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'deliverable', 'review', 'undeliverable')),
  ADD COLUMN IF NOT EXISTS verification_note text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_direct_mail_pieces_verify
  ON public.direct_mail_pieces (campaign_id, verification_status) WHERE status = 'queued';

ALTER TABLE public.direct_mail_campaigns
  ADD COLUMN IF NOT EXISTS audience_segment_id uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS audience_segment_name text,
  ADD COLUMN IF NOT EXISTS audience_synced_at timestamptz;

-- ------------------------------------------------------------------ client RPCs (manager only)
CREATE OR REPLACE FUNCTION public.direct_mail_link_audience(p_campaign_id uuid, p_segment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  v_status text;
  v_name text;
BEGIN
  SELECT status INTO v_status FROM public.direct_mail_campaigns WHERE id = p_campaign_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'campaign_locked' USING ERRCODE = '55000';
  END IF;
  SELECT name INTO v_name FROM public.marketing_segments WHERE id = p_segment_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.direct_mail_campaigns
  SET audience_segment_id = p_segment_id, audience_segment_name = left(v_name, 120), audience_synced_at = now()
  WHERE id = p_campaign_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.direct_mail_verification_summary(p_campaign_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  v_res jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.direct_mail_campaigns WHERE id = p_campaign_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT jsonb_build_object(
    'queued', count(*) FILTER (WHERE status = 'queued'),
    'unverified', count(*) FILTER (WHERE status = 'queued' AND verification_status = 'unverified'),
    'deliverable', count(*) FILTER (WHERE verification_status = 'deliverable'),
    'review', count(*) FILTER (WHERE verification_status = 'review'),
    'undeliverable', count(*) FILTER (WHERE verification_status = 'undeliverable')
  ) INTO v_res
  FROM public.direct_mail_pieces
  WHERE campaign_id = p_campaign_id AND user_id = v_owner AND status <> 'cancelled';
  RETURN v_res;
END;
$$;

-- ------------------------------------------------------------------ service role only
-- Records one verification result. Only touches pieces that are still queued (never one that is being printed).
-- p_block = true (live mode) also fails an undeliverable piece so it is never printed or charged.
CREATE OR REPLACE FUNCTION public.direct_mail_apply_verification(
  p_user_id uuid, p_piece_id uuid, p_status text, p_note text, p_block boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_status NOT IN ('deliverable', 'review', 'undeliverable') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.direct_mail_pieces
  SET verification_status = p_status,
      verification_note = nullif(left(btrim(coalesce(p_note, '')), 300), ''),
      verified_at = now(),
      status = CASE WHEN p_status = 'undeliverable' AND p_block THEN 'failed' ELSE status END,
      last_error = CASE WHEN p_status = 'undeliverable' AND p_block
                        THEN 'Undeliverable address: USPS could not match it. Not mailed, not charged.' ELSE last_error END
  WHERE id = p_piece_id AND user_id = p_user_id AND status = 'queued';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.direct_mail_link_audience(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_verification_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_apply_verification(uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_link_audience(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_verification_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_apply_verification(uuid, uuid, text, text, boolean) TO service_role;
