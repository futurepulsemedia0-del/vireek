/*
  # Unit economics foundation (internal, staff-only)

  - provider_cost_rates   : editable provider rates with source + effective dates. NO seed rows (never invent prices).
  - call_cost_components  : per-call cost by component. basis = estimated | provider_reported | invoiced.

  Security: RLS on; only is_vireek_staff can read/edit rates and read costs. Writes to
  call_cost_components happen only via the service role (edge functions); no client write policy exists.
  Rollback: DROP TABLE call_cost_components; DROP TABLE provider_cost_rates; (no other object depends on them yet).
*/

CREATE TABLE IF NOT EXISTS public.provider_cost_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component      text NOT NULL CHECK (component IN (
    'carrier_inbound','carrier_outbound','carrier_unclassified','asr','llm','tts','voice_platform',
    'sms_segment','recording_storage','transcription','embeddings','vision','provider_other','provider_total_unbroken')),
  provider       text NOT NULL CHECK (length(btrim(provider)) > 0),
  unit           text NOT NULL CHECK (unit IN (
    'per_minute','per_1m_input_tokens','per_1m_output_tokens','per_segment',
    'per_1k_characters','per_gb_month','per_image','per_event')),
  rate_usd       numeric(18,8) NOT NULL CHECK (rate_usd >= 0),
  source         text NOT NULL CHECK (length(btrim(source)) > 0),
  source_url     text,
  effective_from date NOT NULL,
  effective_to   date,
  created_by     uuid DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (component, provider, unit, effective_from)
);

CREATE TABLE IF NOT EXISTS public.call_cost_components (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  vapi_call_id text NOT NULL,
  component    text NOT NULL,
  amount_usd   numeric(14,6) NOT NULL CHECK (amount_usd >= 0),
  basis        text NOT NULL CHECK (basis IN ('estimated','provider_reported','invoiced')),
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vapi_call_id, component)
);

CREATE INDEX IF NOT EXISTS idx_call_cost_components_user_created
  ON public.call_cost_components (user_id, created_at DESC);

ALTER TABLE public.provider_cost_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_cost_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_cost_rates_staff_all ON public.provider_cost_rates;
CREATE POLICY provider_cost_rates_staff_all ON public.provider_cost_rates
  FOR ALL TO authenticated
  USING (public.is_vireek_staff(auth.uid()))
  WITH CHECK (public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS call_cost_components_staff_select ON public.call_cost_components;
CREATE POLICY call_cost_components_staff_select ON public.call_cost_components
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.provider_cost_rates FROM anon;
REVOKE ALL ON public.call_cost_components FROM anon;
