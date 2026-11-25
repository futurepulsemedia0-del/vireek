-- Number reputation: spam-label alert dedupe + rotate/retire workflow.
--
-- Builds on 20290310000100_number_health.sql. Idempotent: safe to run twice.
--
-- 1. number_health.alerted_label / alerted_at: the worst label already notified for a number, so the scheduled poll
--    alerts once per escalation instead of every 6 hours. Written only by the service role (poll function).
-- 2. number_rotations: one row per "replace this number" decision. Owner-scoped like phone_numbers
--    (account_id = auth.uid()). No client writes; every change goes through the SECURITY DEFINER functions below.
--
-- Retiring marks the number 'released' IN VIREEK, exactly like the existing "Release" action in the dashboard
-- (src/lib/phoneNumbers.ts releasePhoneNumber). It does NOT release the number at the carrier: nothing in this
-- repository does. [VERIFY] what your carrier needs to stop billing the number.

ALTER TABLE public.number_health ADD COLUMN IF NOT EXISTS alerted_label text
  CHECK (alerted_label IS NULL OR alerted_label IN ('suspected', 'flagged'));
ALTER TABLE public.number_health ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

CREATE TABLE IF NOT EXISTS public.number_rotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,                     -- account owner
  phone_number_id uuid NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,   -- the number being replaced
  replacement_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('spam_flagged', 'spam_suspected', 'manual')),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'retired', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (replacement_number_id IS NULL OR replacement_number_id <> phone_number_id)
);
CREATE INDEX IF NOT EXISTS number_rotations_user_idx ON public.number_rotations (user_id, created_at DESC);
-- At most one open rotation per number, and a number can be the replacement in at most one open rotation.
CREATE UNIQUE INDEX IF NOT EXISTS number_rotations_one_open_per_number ON public.number_rotations (phone_number_id) WHERE status = 'planned';
CREATE UNIQUE INDEX IF NOT EXISTS number_rotations_one_open_per_replacement ON public.number_rotations (replacement_number_id) WHERE status = 'planned' AND replacement_number_id IS NOT NULL;

ALTER TABLE public.number_rotations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "number_rotations_select_own" ON public.number_rotations;
CREATE POLICY "number_rotations_select_own" ON public.number_rotations FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.number_rotations FROM anon, authenticated;

-- Start (or return the already-open) rotation for one of the caller's active numbers.
CREATE OR REPLACE FUNCTION public.number_rotation_start(p_number_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('spam_flagged', 'spam_suspected', 'manual') THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM phone_numbers WHERE id = p_number_id AND account_id = v_uid AND status = 'active') THEN
    RAISE EXCEPTION 'Number not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO number_rotations (user_id, phone_number_id, reason) VALUES (v_uid, p_number_id, p_reason)
    ON CONFLICT (phone_number_id) WHERE status = 'planned' DO NOTHING
    RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM number_rotations WHERE phone_number_id = p_number_id AND status = 'planned' AND user_id = v_uid;
  END IF;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END;
$$;

-- Choose (or clear, with NULL) the replacement for an open rotation. The replacement must be one of the caller's own
-- active numbers, different from the old one, and not already part of another open rotation.
CREATE OR REPLACE FUNCTION public.number_rotation_set_replacement(p_rotation_id uuid, p_replacement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  SELECT phone_number_id INTO v_old FROM number_rotations WHERE id = p_rotation_id AND user_id = v_uid AND status = 'planned' FOR UPDATE;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Rotation not found' USING ERRCODE = '42501'; END IF;
  IF p_replacement_id IS NOT NULL THEN
    IF p_replacement_id = v_old THEN RAISE EXCEPTION 'Replacement must differ' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM phone_numbers WHERE id = p_replacement_id AND account_id = v_uid AND status = 'active') THEN
      RAISE EXCEPTION 'Replacement not found' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM number_rotations WHERE phone_number_id = p_replacement_id AND status = 'planned') THEN
      RAISE EXCEPTION 'Replacement is being retired' USING ERRCODE = '22023';
    END IF;
  END IF;
  BEGIN
    UPDATE number_rotations SET replacement_number_id = p_replacement_id, updated_at = now() WHERE id = p_rotation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Replacement already in use' USING ERRCODE = '22023';
  END;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.number_rotation_cancel(p_rotation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  UPDATE number_rotations SET status = 'cancelled', updated_at = now() WHERE id = p_rotation_id AND user_id = v_uid AND status = 'planned';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Rotation not found' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- Complete a rotation: release the old number in Vireek and, if it was the primary line, hand "primary" to the
-- replacement. One transaction (a function body), rows locked in a fixed order. Without a replacement it refuses
-- unless the caller passes p_allow_no_replacement = true.
CREATE OR REPLACE FUNCTION public.number_rotation_retire(p_rotation_id uuid, p_allow_no_replacement boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old uuid;
  v_new uuid;
  v_was_primary boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  SELECT phone_number_id, replacement_number_id INTO v_old, v_new FROM number_rotations WHERE id = p_rotation_id AND user_id = v_uid AND status = 'planned' FOR UPDATE;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Rotation not found' USING ERRCODE = '42501'; END IF;
  IF v_new IS NULL AND NOT coalesce(p_allow_no_replacement, false) THEN RAISE EXCEPTION 'Choose a replacement first' USING ERRCODE = '22023'; END IF;

  -- Lock both phone rows (lower id first) so two retirements cannot interleave.
  PERFORM 1 FROM phone_numbers WHERE id IN (v_old, coalesce(v_new, v_old)) AND account_id = v_uid ORDER BY id FOR UPDATE;
  SELECT is_primary INTO v_was_primary FROM phone_numbers WHERE id = v_old AND account_id = v_uid AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Number is no longer active' USING ERRCODE = '22023'; END IF;
  IF v_new IS NOT NULL AND NOT EXISTS (SELECT 1 FROM phone_numbers WHERE id = v_new AND account_id = v_uid AND status = 'active') THEN
    RAISE EXCEPTION 'Replacement is no longer active' USING ERRCODE = '22023';
  END IF;

  UPDATE phone_numbers SET status = 'released', is_primary = false, updated_at = now() WHERE id = v_old AND account_id = v_uid;
  IF v_new IS NOT NULL AND v_was_primary THEN
    UPDATE phone_numbers SET is_primary = true, updated_at = now() WHERE id = v_new AND account_id = v_uid;
  END IF;
  UPDATE number_rotations SET status = 'retired', retired_at = now(), updated_at = now() WHERE id = p_rotation_id;
  PERFORM public.log_audit_event(v_uid, 'retired_phone_number', 'phone_numbers', v_old::text);
  RETURN jsonb_build_object('success', true, 'primary_moved', v_new IS NOT NULL AND v_was_primary);
END;
$$;

REVOKE ALL ON FUNCTION public.number_rotation_start(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.number_rotation_set_replacement(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.number_rotation_cancel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.number_rotation_retire(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.number_rotation_start(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.number_rotation_set_replacement(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.number_rotation_cancel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.number_rotation_retire(uuid, boolean) TO authenticated;

/*
## ROLLBACK (manual, destructive: loses rotation history; released numbers stay released)
    -- drop function public.number_rotation_retire(uuid, boolean), public.number_rotation_cancel(uuid),
    --   public.number_rotation_set_replacement(uuid, uuid), public.number_rotation_start(uuid, text);
    -- drop table public.number_rotations;
    -- alter table public.number_health drop column alerted_label, drop column alerted_at;
*/
