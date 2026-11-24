-- Billing-region gate: a non-default regional pack cannot be ENABLED until staff have cleared it
-- against a complete, verified payments / e-invoicing matrix row set.
--
-- Source of the matrix: config/global/payments-einvoicing.json (docs/global/payments-einvoicing.md).
-- The repo check (npm run payments-einvoicing:check) decides whether rows are complete; this migration is the
-- runtime enforcement point. Staff supply the pack hash printed by `npm run payments-einvoicing:hash -- <PACK>`.
--
-- ADDITIVE and IDEMPOTENT. Depends on: public.is_vireek_staff(uuid), public.log_audit_event(uuid,text,text,text,jsonb),
--   public.get_account_owner_id(), public.can_manage_regional_packs() and public.regional_pack_enablements
--   (20271021000000_regional_packs.sql).
--
-- BEHAVIOUR CHANGE (intended): set_regional_pack(<CA|GB|EU|AU>, true) now fails with SQLSTATE 55000 unless the pack is
-- cleared. US is never gated. A pack a tenant ALREADY has enabled stays enabled and re-enabling it is a no-op;
-- disabling is always allowed. Nothing is cleared by this migration, so new enablements of CA/GB/EU/AU are blocked
-- until staff clear them.
--
-- ROLLBACK (restores the previous set_regional_pack body; the gate table holds only clearances):
--   CREATE OR REPLACE FUNCTION public.set_regional_pack(p_pack text, p_enabled boolean) RETURNS void
--     LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
--     DECLARE v_owner uuid := public.get_account_owner_id();
--     BEGIN
--       IF auth.uid() IS NULL OR NOT public.can_manage_regional_packs() THEN
--         RAISE EXCEPTION 'You do not have permission to manage regional packs.' USING ERRCODE = '42501'; END IF;
--       IF p_pack IS NULL OR p_pack NOT IN ('US','CA','GB','EU','AU') THEN
--         RAISE EXCEPTION 'Unknown regional pack.' USING ERRCODE = '22023'; END IF;
--       INSERT INTO public.regional_pack_enablements (user_id, pack_code, enabled) VALUES (v_owner, p_pack, COALESCE(p_enabled, true))
--         ON CONFLICT (user_id, pack_code) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = auth.uid(), updated_at = now();
--       PERFORM public.log_audit_event(v_owner, CASE WHEN p_enabled THEN 'regional_pack.enabled' ELSE 'regional_pack.disabled' END,
--         'regional_pack_enablements', p_pack, NULL);
--     END; $f$;
--   DROP FUNCTION IF EXISTS public.staff_set_billing_region_clearance(text,boolean,text,text,date,text,date,text);
--   DROP FUNCTION IF EXISTS public.get_billing_region_clearances();
--   DROP FUNCTION IF EXISTS public.billing_region_allowed(text);
--   DROP TABLE    IF EXISTS public.billing_region_clearances;

CREATE TABLE IF NOT EXISTS public.billing_region_clearances (
  pack_code text PRIMARY KEY CHECK (pack_code IN ('US', 'CA', 'GB', 'EU', 'AU')),
  cleared boolean NOT NULL DEFAULT false,
  matrix_sha256 text CHECK (matrix_sha256 IS NULL OR matrix_sha256 ~ '^[0-9a-f]{64}$'),
  verified_by text CHECK (verified_by IS NULL OR length(btrim(verified_by)) BETWEEN 1 AND 200),
  verified_on date,
  counsel_reviewer text CHECK (counsel_reviewer IS NULL OR length(btrim(counsel_reviewer)) BETWEEN 1 AND 200),
  counsel_reviewed_on date,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  cleared_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A cleared pack must carry the whole attestation. Completeness of the rows themselves is checked in the repo.
  CONSTRAINT brc_attestation_required CHECK (
    NOT cleared OR (
      matrix_sha256 IS NOT NULL
      AND btrim(COALESCE(verified_by, '')) <> '' AND verified_on IS NOT NULL
      AND btrim(COALESCE(counsel_reviewer, '')) <> '' AND counsel_reviewed_on IS NOT NULL
    )
  )
);
ALTER TABLE public.billing_region_clearances ENABLE ROW LEVEL SECURITY;

-- Staff can read the full attestation; tenants only see the boolean through get_billing_region_clearances().
DROP POLICY IF EXISTS brc_staff_select ON public.billing_region_clearances;
CREATE POLICY brc_staff_select ON public.billing_region_clearances FOR SELECT
  USING (auth.uid() IS NOT NULL AND public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.billing_region_clearances FROM anon, authenticated;

INSERT INTO public.billing_region_clearances (pack_code, cleared)
VALUES ('US', false), ('CA', false), ('GB', false), ('EU', false), ('AU', false)
ON CONFLICT (pack_code) DO NOTHING;

-- US is the default region and is never gated (same rule as src/lib/regionConfig/gate.ts).
CREATE OR REPLACE FUNCTION public.billing_region_allowed(p_pack text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_pack = 'US'
      OR COALESCE((SELECT c.cleared FROM public.billing_region_clearances c WHERE c.pack_code = p_pack), false);
$$;
REVOKE ALL ON FUNCTION public.billing_region_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_region_allowed(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_billing_region_clearances()
RETURNS TABLE (pack_code text, cleared boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.pack_code, (c.pack_code = 'US' OR c.cleared) FROM public.billing_region_clearances c ORDER BY c.pack_code;
$$;
REVOKE ALL ON FUNCTION public.get_billing_region_clearances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_billing_region_clearances() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_set_billing_region_clearance(
  p_pack text, p_cleared boolean, p_matrix_sha256 text DEFAULT NULL, p_verified_by text DEFAULT NULL,
  p_verified_on date DEFAULT NULL, p_counsel_reviewer text DEFAULT NULL, p_counsel_reviewed_on date DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff access is required for this action.' USING ERRCODE = '42501';
  END IF;
  IF p_pack IS NULL OR p_pack NOT IN ('US', 'CA', 'GB', 'EU', 'AU') THEN
    RAISE EXCEPTION 'Unknown regional pack.' USING ERRCODE = '22023';
  END IF;
  IF p_pack = 'US' THEN
    RAISE EXCEPTION 'The US pack is the default region and is not gated.' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 1000 THEN
    RAISE EXCEPTION 'Note is too long (max 1000 characters).' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_cleared, false) THEN
    IF p_matrix_sha256 IS NULL OR p_matrix_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'A 64-character lowercase sha256 of the matrix rows is required.' USING ERRCODE = '22023';
    END IF;
    IF btrim(COALESCE(p_verified_by, '')) = '' OR p_verified_on IS NULL
       OR btrim(COALESCE(p_counsel_reviewer, '')) = '' OR p_counsel_reviewed_on IS NULL THEN
      RAISE EXCEPTION 'Verifier, counsel reviewer and both dates are required to clear a pack.' USING ERRCODE = '22023';
    END IF;
    IF p_verified_on > current_date OR p_counsel_reviewed_on > current_date THEN
      RAISE EXCEPTION 'Review dates cannot be in the future.' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.billing_region_clearances AS c
    (pack_code, cleared, matrix_sha256, verified_by, verified_on, counsel_reviewer, counsel_reviewed_on, note, cleared_by, updated_at)
  VALUES
    (p_pack, COALESCE(p_cleared, false), p_matrix_sha256, p_verified_by, p_verified_on, p_counsel_reviewer, p_counsel_reviewed_on, p_note, auth.uid(), now())
  ON CONFLICT (pack_code) DO UPDATE SET
    cleared = EXCLUDED.cleared, matrix_sha256 = EXCLUDED.matrix_sha256, verified_by = EXCLUDED.verified_by,
    verified_on = EXCLUDED.verified_on, counsel_reviewer = EXCLUDED.counsel_reviewer,
    counsel_reviewed_on = EXCLUDED.counsel_reviewed_on, note = EXCLUDED.note, cleared_by = auth.uid(), updated_at = now();

  PERFORM public.log_audit_event(
    auth.uid(),
    CASE WHEN COALESCE(p_cleared, false) THEN 'billing_region.cleared' ELSE 'billing_region.revoked' END,
    'billing_region_clearances', p_pack,
    jsonb_build_object('matrix_sha256', p_matrix_sha256, 'verified_on', p_verified_on, 'counsel_reviewed_on', p_counsel_reviewed_on));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_billing_region_clearance(text, boolean, text, text, date, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_billing_region_clearance(text, boolean, text, text, date, text, date, text) TO authenticated;

-- The enforcement point. Identical to the previous body plus the gate block.
CREATE OR REPLACE FUNCTION public.set_regional_pack(p_pack text, p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_regional_packs() THEN
    RAISE EXCEPTION 'You do not have permission to manage regional packs.' USING ERRCODE = '42501';
  END IF;
  IF p_pack IS NULL OR p_pack NOT IN ('US', 'CA', 'GB', 'EU', 'AU') THEN
    RAISE EXCEPTION 'Unknown regional pack.' USING ERRCODE = '22023';
  END IF;

  -- Billing gate: enabling a non-default pack unlocks its billing currencies and methods.
  IF COALESCE(p_enabled, true)
     AND NOT public.billing_region_allowed(p_pack)
     AND NOT EXISTS (
       SELECT 1 FROM public.regional_pack_enablements e
       WHERE e.user_id = v_owner AND e.pack_code = p_pack AND e.enabled
     ) THEN
    RAISE EXCEPTION 'This region is not cleared for billing yet.' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.regional_pack_enablements (user_id, pack_code, enabled)
  VALUES (v_owner, p_pack, COALESCE(p_enabled, true))
  ON CONFLICT (user_id, pack_code)
  DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = auth.uid(), updated_at = now();
  PERFORM public.log_audit_event(v_owner, CASE WHEN p_enabled THEN 'regional_pack.enabled' ELSE 'regional_pack.disabled' END,
    'regional_pack_enablements', p_pack, NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_regional_pack(text, boolean) TO authenticated;
