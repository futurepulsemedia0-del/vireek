/*
  # Fixed monthly cost rates (phone number rental, platform hosting)

  Requires 20290303000000_seed_provider_cost_rates.sql. Run 20290303000200_validate_fixed_cost_checks.sql right after.
  - Widens the provider_cost_rates CHECKs: unit += 'per_month'; component += 'phone_number', 'platform_fixed'.
    The existing CHECKs are found by their definition (not by name) and recreated with fixed names; every old value stays allowed,
    so no existing row can violate the new constraints. Re-running is safe.
  - Seeds (only when no rate exists yet for the same component+unit, same guard as the first seed; never overwrites human rates):
      phone_number  twilio    per_month  1.15  official          (Twilio US local number, per number)
      platform_fixed supabase per_month  25    secondary_source  (Supabase Pro, whole platform, NOT per tenant)
  - These are fixed costs: they are never written to cost_ledger (unchanged design) and never counted as per-call cost.
    The dashboard uses phone_number per tenant (numbers per tenant is an explicit assumption in the UI) and shows
    platform_fixed separately as overhead.

  NOT EXECUTED in authoring (no Postgres available): run on a staging copy first.
  Rollback: DELETE FROM public.provider_cost_rates WHERE created_by IS NULL AND source LIKE 'seed 2026-11-09:%' AND unit = 'per_month';
            (the widened CHECKs are harmless and may stay)
*/

-- rollback: delete the per_month seed rows (see note above); the widened CHECKs are harmless and may stay.
-- The new CHECKs are added NOT VALID here and validated in 20290303000200_validate_fixed_cost_checks.sql (repo lint rule).

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.provider_cost_rates'::regclass AND contype = 'c'
  LOOP
    IF c.def LIKE '%carrier_inbound%' OR c.def LIKE '%per_gb_month%' THEN
      EXECUTE format('ALTER TABLE public.provider_cost_rates DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
END
$$;

ALTER TABLE public.provider_cost_rates ADD CONSTRAINT provider_cost_rates_component_check CHECK (component IN (
  'carrier_inbound','carrier_outbound','carrier_unclassified','asr','llm','tts','voice_platform',
  'sms_segment','recording_storage','transcription','embeddings','vision','provider_other','provider_total_unbroken',
  'phone_number','platform_fixed')) NOT VALID;
ALTER TABLE public.provider_cost_rates ADD CONSTRAINT provider_cost_rates_unit_check CHECK (unit IN (
  'per_minute','per_1m_input_tokens','per_1m_output_tokens','per_segment',
  'per_1k_characters','per_gb_month','per_image','per_event','per_month')) NOT VALID;

INSERT INTO public.provider_cost_rates (component, provider, unit, rate_usd, status, source, source_url, notes, effective_from)
SELECT v.component, v.provider, v.unit, v.rate_usd, v.status, v.source, v.source_url, v.notes, DATE '2026-11-09'
FROM (VALUES
  ('phone_number', 'twilio', 'per_month', 1.15000000, 'official', 'seed 2026-11-09: Twilio official pricing, US local number per month', NULL, 'Per phone number. Replace with the real invoice.'),
  ('platform_fixed', 'supabase', 'per_month', 25.00000000, 'secondary_source', 'seed 2026-11-09: Supabase Pro plan, secondary mirror of the official pricing page', NULL, 'Whole-platform fixed cost, not per tenant. Not read from the official page.')
) AS v(component, provider, unit, rate_usd, status, source, source_url, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_cost_rates r WHERE r.component = v.component AND r.unit = v.unit
)
ON CONFLICT (component, provider, unit, effective_from) DO NOTHING;
