/*
  # Seed provider cost rates + default plan cost ceilings (staff-only tables, no schema break)

  Requires 20281101000000 .. 20281110000000 (provider_cost_rates, plan_cost_limits).
  Adds nullable `status` + `notes` to provider_cost_rates so dashboards can show a "rate not verified" badge:
    status = official | secondary_source | unverified | assumption   (NULL = entered by a human / legacy: no badge)

  Safety / idempotency
  - A seed row is inserted ONLY when NO rate exists yet for the same (component, unit) (any provider, any date), so a rate a
    human already entered is never shadowed or overwritten, and the dashboard never sees two providers for one component+unit
    (priceUsageEvents treats that as "ambiguous"). ON CONFLICT DO NOTHING covers the unique key. Re-running changes nothing.
  - Seed rows have created_by IS NULL and source starting with "seed 2026-11-09:" (rollback below targets exactly those).
  - Prices are USD, accessed 2026-11-09. effective_from = 2026-11-09 (calls before that date stay unpriced, never $0).
  - SMS: Twilio segment 0.0083 + carrier fee 0.0035 = 0.0118 per segment, stored as ONE row (unique key + single-provider rule).
  - Gemini is keyed by provider id `gemini` (what ai_usage_logs stores). The table has no model column, so this rate applies
    to every Gemini model; it equals the default in costTracking.ts (0.30 / 2.50), so logged AI cost does not change.
  - NOT seeded (no unit/component for a monthly fixed cost; fixed costs are kept out of the rate table by design):
    Twilio US local number 1.15 USD/month, Supabase Pro 25 USD/month.
  - plan_cost_limits: inserted only if the table exists AND is empty. hard_cost_usd = 3 x (included minutes x 0.107)
    + SMS allowance cost. No SMS allowance exists in the pricing catalog, so that term is 0 (tune later).
    free 50 -> 16.05 | starter 400 -> 128.40 | professional 1500 -> 481.50 | business 4000 -> 1284.00. soft limit and
    max_call_seconds stay NULL. NOTE: a hard limit makes the guardrail restrict non-emergency work once reached.

  NOT EXECUTED in authoring (no Postgres available): run on a staging copy first.
  Rollback:
    DELETE FROM public.provider_cost_rates WHERE created_by IS NULL AND source LIKE 'seed 2026-11-09:%';
    DELETE FROM public.plan_cost_limits WHERE plan IN ('free','starter','professional','business') AND updated_by IS NULL;
    (the nullable status/notes columns are harmless and may stay)
-- rollback: delete the seed rows (created_by IS NULL AND source LIKE 'seed 2026-11-09:%'); the nullable status/notes columns may stay.
*/

ALTER TABLE public.provider_cost_rates
  ADD COLUMN IF NOT EXISTS status text
  CHECK (status IS NULL OR status IN ('official', 'secondary_source', 'unverified', 'assumption'));
ALTER TABLE public.provider_cost_rates ADD COLUMN IF NOT EXISTS notes text;

INSERT INTO public.provider_cost_rates (component, provider, unit, rate_usd, status, source, source_url, notes, effective_from)
SELECT v.component, v.provider, v.unit, v.rate_usd, v.status, v.source, v.source_url, v.notes, DATE '2026-11-09'
FROM (VALUES
  ('voice_platform', 'vapi', 'per_minute', 0.05000000, 'official', 'seed 2026-11-09: Vapi official pricing', 'https://vapi.ai/pricing', 'Vapi platform fee per minute.'),
  ('carrier_inbound', 'twilio', 'per_minute', 0.00850000, 'official', 'seed 2026-11-09: Twilio official pricing, US local inbound', NULL, 'Replace with the real invoice.'),
  ('carrier_outbound', 'twilio', 'per_minute', 0.01400000, 'official', 'seed 2026-11-09: Twilio official pricing, US outbound', NULL, 'Replace with the real invoice.'),
  ('asr', 'deepgram', 'per_minute', 0.00970000, 'unverified', 'seed 2026-11-09: Vapi official cost calculator (Deepgram)', 'https://vapi.ai/pricing', 'Calculator figure; the STT provider actually used live is UNVERIFIED.'),
  ('llm', 'voice_llm_assumed', 'per_minute', 0.02000000, 'assumption', 'seed 2026-11-09: ASSUMPTION for the live voice LLM', NULL, 'Vapi calculator range 0.0077-0.0452 per minute. Replace with real per-call LLM cost.'),
  ('tts', 'elevenlabs', 'per_minute', 0.01920000, 'unverified', 'seed 2026-11-09: Vapi cost calculator (ElevenLabs), midpoint of range', 'https://vapi.ai/pricing', 'Midpoint of 0.0146-0.0238 per minute; the live voice mix is UNVERIFIED.'),
  ('sms_segment', 'twilio', 'per_segment', 0.01180000, 'official', 'seed 2026-11-09: Twilio official pricing, US SMS 0.0083 + carrier fee 0.0035', NULL, 'One combined row: 0.0083 per segment + 0.0035 carrier fee per segment.'),
  ('llm', 'gemini', 'per_1m_input_tokens', 0.30000000, 'secondary_source', 'seed 2026-11-09: Gemini 2.5 Flash, secondary mirrors of the official Google pricing page', NULL, 'Not read from the official page. Applies to every model logged under provider gemini.'),
  ('llm', 'gemini', 'per_1m_output_tokens', 2.50000000, 'secondary_source', 'seed 2026-11-09: Gemini 2.5 Flash, secondary mirrors of the official Google pricing page', NULL, 'Not read from the official page. Applies to every model logged under provider gemini.')
) AS v(component, provider, unit, rate_usd, status, source, source_url, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_cost_rates r WHERE r.component = v.component AND r.unit = v.unit
)
ON CONFLICT (component, provider, unit, effective_from) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('public.plan_cost_limits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.plan_cost_limits) THEN
    INSERT INTO public.plan_cost_limits (plan, hard_cost_usd) VALUES
      ('free', 16.05),
      ('starter', 128.40),
      ('professional', 481.50),
      ('business', 1284.00);
  END IF;
END
$$;
