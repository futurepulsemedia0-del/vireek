/*
  # Price Book Enforcement

  ## Why
  The `lookup_price` Vapi tool (20260913000000_create_price_book.sql,
  toolLookupPrice in vapi-webhook/index.ts) already lets Sarah fetch a
  real price during a call instead of guessing. But nothing previously
  checked that what she actually SAID matched what the tool returned, or
  whether she called the tool at all before quoting a number. This adds
  that check.

  ## What this does
  1. `price_lookup_log` — every `lookup_price` tool call gets logged here
     (query + what matched), keyed by the Vapi call id (not a `calls.id`
     FK — tool-calls happen mid-call, before the definitive `calls` row
     is written at end-of-call-report, exactly the same ordering problem
     `upsertCallRow`'s vapi_call_id correlation already solves elsewhere
     in this webhook).
  2. Three new columns on `calls`, populated by the new
     `_shared/ai-core/priceEnforcement.ts` module (deterministic — no
     LLM call) right alongside `analyzeCallIntelligence` at
     end-of-call-report:
     - `price_accuracy_status`: 'verified' | 'mismatch' | 'unverified' |
       'not_applicable'
     - `price_accuracy_details`: jsonb array of specific mismatches, each
       with the stated amount, transcript context, and the closest real
       catalog entry for comparison
     - `price_lookups_performed`: how many times lookup_price actually
       ran during the call

  ## Security
  `price_lookup_log` is written only by the webhook's service-role
  client (same as `calls` itself), so RLS here only needs to open SELECT
  for the business owner to review it — no INSERT/UPDATE/DELETE policy
  for `authenticated` is added, matching how `calls` rows are written.
*/

CREATE TABLE IF NOT EXISTS price_lookup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  external_call_id text,

  query text,
  matched_items jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_lookup_log_user_id ON price_lookup_log(user_id);
CREATE INDEX IF NOT EXISTS idx_price_lookup_log_external_call_id ON price_lookup_log(external_call_id);

ALTER TABLE price_lookup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_price_lookup_log" ON price_lookup_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS price_accuracy_status text
    CHECK (price_accuracy_status IN ('verified', 'mismatch', 'unverified', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS price_accuracy_details jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS price_lookups_performed integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_calls_price_accuracy_status ON calls(price_accuracy_status)
  WHERE price_accuracy_status IN ('mismatch', 'unverified');
