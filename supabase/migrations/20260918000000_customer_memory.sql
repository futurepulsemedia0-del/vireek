/*
  # AI Business Memory

  Durable, per-customer facts learned across calls (property details,
  preferences, recurring issues) — NOT the same as call_intelligence
  (which is per-call scoring). Written either live by the
  save_customer_memory tool, or automatically after each call via
  analyzeCallIntelligence's memory_facts output. Capped per customer
  (see MAX_MEMORY_PER_CUSTOMER in vapi-webhook) so prompts never bloat.
*/

CREATE TABLE IF NOT EXISTS customer_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  category text NOT NULL DEFAULT 'note'
    CHECK (category IN ('preference', 'property_detail', 'recurring_issue', 'access_info', 'note')),
  fact text NOT NULL,
  source text NOT NULL CHECK (source IN ('ai_tool', 'auto_extracted', 'manual')),
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_memory_lookup ON customer_memory(user_id, customer_phone, created_at DESC);

ALTER TABLE customer_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their own customer memory"
  ON customer_memory FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
