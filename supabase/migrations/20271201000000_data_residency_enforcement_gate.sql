/*
  Data residency gate: a region can only be chosen once the platform
  proves it enforces it (data_regions.enforced_at), and the UI is behind
  the feature flag data_residency_ui (default OFF).
*/

ALTER TABLE public.data_regions
  ADD COLUMN IF NOT EXISTS enforced_at timestamptz;

COMMENT ON COLUMN public.data_regions.enforced_at IS
  'Set by staff only after the region passed the enforcement probe (data plane reachable, bucket exists, guard rejects cross-region writes). NULL = not enforced; UI must not offer it.';

ALTER TABLE public.data_regions DROP CONSTRAINT IF EXISTS data_regions_enforced_requires_available;
ALTER TABLE public.data_regions
  ADD CONSTRAINT data_regions_enforced_requires_available
  CHECK (enforced_at IS NULL OR is_available);

CREATE OR REPLACE FUNCTION public.data_region_enforced_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_region text;
BEGIN
  -- Nested on purpose: NEW.to_region does not exist on tenant_residency.
  IF TG_TABLE_NAME = 'tenant_residency' THEN
    v_region := NEW.region;
  ELSE
    v_region := NEW.to_region;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.data_regions WHERE code = v_region AND enforced_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Region % is not enforced by the platform yet.', v_region USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_residency_enforced ON public.tenant_residency;
CREATE TRIGGER trg_tenant_residency_enforced BEFORE INSERT ON public.tenant_residency
  FOR EACH ROW EXECUTE FUNCTION public.data_region_enforced_guard();

DROP TRIGGER IF EXISTS trg_residency_change_enforced ON public.residency_change_requests;
CREATE TRIGGER trg_residency_change_enforced BEFORE INSERT ON public.residency_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.data_region_enforced_guard();

INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('data_residency_ui', 'Data residency UI',
        'Shows the Residency tab in Trust Pack. Turn on only after a region has data_regions.enforced_at set.',
        false, 0)
ON CONFLICT (key) DO NOTHING;
