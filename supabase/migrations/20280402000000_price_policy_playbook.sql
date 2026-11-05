/*
  # Price-First Playbook: per-service price policies + conversation events

  1. New tables
    - `price_policies`: what Sarah is ALLOWED to say about price, per service.
      mode = exact_flat | range | starting_at | diagnostic_fee_only | needs_visit.
      Dollar figures are either owner-entered (stored here) or read LIVE from
      `price_book_items` (source_kind = 'price_book'), so a catalog edit can never
      leave a stale number in a policy. Every figure carries verified_at; the engine
      refuses to speak figures older than 180 days or in states counsel has not approved.
    - `price_playbook_settings`: one row per account with the value claims Sarah may make
      (licensed techs, warranty months, on-time policy) and which fast next steps are offered.
      Nothing is claimed unless the owner turned it on.
    - `price_playbook_events`: one row per stage a price conversation reaches
      (voice / sms / web). Written ONLY by service-role edge functions.

  2. Security
    - RLS on both tables, scoped with public.get_account_owner_id() like `calls`.
    - `price_policies`: owner-scoped SELECT/INSERT/UPDATE/DELETE.
    - `price_playbook_events`: owner-scoped SELECT only (no client writes).

  3. Safety
    - Additive only. No existing table or policy is changed.
    - Rollback: DROP TABLE price_playbook_events; DROP TABLE price_policies;
      DROP TABLE price_playbook_settings; DROP FUNCTION set_price_policies_updated_at(); (no other object depends on them).
*/

CREATE TABLE IF NOT EXISTS public.price_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  service_key text NOT NULL CHECK (char_length(service_key) BETWEEN 1 AND 80),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  trade text NOT NULL DEFAULT 'general'
    CHECK (trade IN ('hvac', 'plumbing', 'electrical', 'appliance', 'roofing', 'general')),
  mode text NOT NULL
    CHECK (mode IN ('exact_flat', 'range', 'starting_at', 'diagnostic_fee_only', 'needs_visit')),
  source_kind text NOT NULL DEFAULT 'owner_entered'
    CHECK (source_kind IN ('price_book', 'owner_entered')),
  price_book_item_id uuid REFERENCES public.price_book_items(id) ON DELETE SET NULL,
  amount_low_cents integer CHECK (amount_low_cents IS NULL OR amount_low_cents > 0),
  amount_high_cents integer CHECK (amount_high_cents IS NULL OR amount_high_cents > 0),
  diagnostic_fee_cents integer CHECK (diagnostic_fee_cents IS NULL OR diagnostic_fee_cents > 0),
  fee_credited_on_repair boolean NOT NULL DEFAULT false,
  written_price_before_work boolean NOT NULL DEFAULT false,
  keywords text[] NOT NULL DEFAULT '{}',
  includes text[] NOT NULL DEFAULT '{}',
  changes_price text[] NOT NULL DEFAULT '{}',
  verified_at timestamptz NOT NULL DEFAULT now(),
  approved_states text[] NOT NULL DEFAULT '{}',
  legal_review_status text NOT NULL DEFAULT 'pending'
    CHECK (legal_review_status IN ('pending', 'approved')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, service_key),
  CONSTRAINT price_policies_book_link CHECK (source_kind <> 'price_book' OR price_book_item_id IS NOT NULL),
  CONSTRAINT price_policies_range_order CHECK (
    amount_high_cents IS NULL OR amount_low_cents IS NULL OR amount_high_cents >= amount_low_cents
  ),
  CONSTRAINT price_policies_mode_amounts CHECK (
    source_kind = 'price_book'
    OR (mode = 'exact_flat' AND amount_low_cents IS NOT NULL)
    OR (mode = 'starting_at' AND amount_low_cents IS NOT NULL)
    OR (mode = 'range' AND amount_low_cents IS NOT NULL AND amount_high_cents IS NOT NULL)
    OR (mode = 'diagnostic_fee_only' AND diagnostic_fee_cents IS NOT NULL)
    OR mode = 'needs_visit'
  ),
  CONSTRAINT price_policies_states_upper CHECK (
    approved_states <@ ARRAY[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT',
      'NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
    ]::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_price_policies_user_active
  ON public.price_policies (user_id, active);

ALTER TABLE public.price_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_price_policies" ON public.price_policies;
CREATE POLICY "select_own_price_policies" ON public.price_policies
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_price_policies" ON public.price_policies;
CREATE POLICY "insert_own_price_policies" ON public.price_policies
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_price_policies" ON public.price_policies;
CREATE POLICY "update_own_price_policies" ON public.price_policies
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_price_policies" ON public.price_policies;
CREATE POLICY "delete_own_price_policies" ON public.price_policies
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.set_price_policies_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_price_policies_updated_at ON public.price_policies;
CREATE TRIGGER trg_price_policies_updated_at
  BEFORE UPDATE ON public.price_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_price_policies_updated_at();

CREATE TABLE IF NOT EXISTS public.price_playbook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('voice', 'sms', 'web')),
  conversation_key text NOT NULL CHECK (char_length(conversation_key) BETWEEN 1 AND 200),
  service_key text,
  mode_used text CHECK (mode_used IS NULL OR mode_used IN ('exact_flat', 'range', 'starting_at', 'diagnostic_fee_only', 'needs_visit')),
  downgraded_reason text,
  stage text NOT NULL
    CHECK (stage IN ('price_asked', 'answer_given', 'qualified', 'objection', 'next_step_offered', 'booked', 'abandoned')),
  ticket_cents integer CHECK (ticket_cents IS NULL OR ticket_cents >= 0),
  experiment_key text,
  variant text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_playbook_events_user_time
  ON public.price_playbook_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_playbook_events_conversation
  ON public.price_playbook_events (user_id, conversation_key);

-- Idempotency under webhook retries: one price_asked and one terminal outcome per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_playbook_events_asked
  ON public.price_playbook_events (user_id, conversation_key) WHERE stage = 'price_asked';
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_playbook_events_terminal
  ON public.price_playbook_events (user_id, conversation_key) WHERE stage IN ('booked', 'abandoned');

ALTER TABLE public.price_playbook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_price_playbook_events" ON public.price_playbook_events;
CREATE POLICY "select_own_price_playbook_events" ON public.price_playbook_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS public.price_playbook_settings (
  user_id uuid PRIMARY KEY,
  licensed_techs boolean NOT NULL DEFAULT false,
  warranty_months integer CHECK (warranty_months IS NULL OR warranty_months BETWEEN 1 AND 120),
  on_time_guarantee boolean NOT NULL DEFAULT false,
  same_day_diagnostic_enabled boolean NOT NULL DEFAULT false,
  human_callback_enabled boolean NOT NULL DEFAULT false,
  financing_min_cents integer CHECK (financing_min_cents IS NULL OR financing_min_cents > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.price_playbook_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_price_playbook_settings" ON public.price_playbook_settings;
CREATE POLICY "select_own_price_playbook_settings" ON public.price_playbook_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_price_playbook_settings" ON public.price_playbook_settings;
CREATE POLICY "insert_own_price_playbook_settings" ON public.price_playbook_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_price_playbook_settings" ON public.price_playbook_settings;
CREATE POLICY "update_own_price_playbook_settings" ON public.price_playbook_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trg_price_playbook_settings_updated_at ON public.price_playbook_settings;
CREATE TRIGGER trg_price_playbook_settings_updated_at
  BEFORE UPDATE ON public.price_playbook_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_price_policies_updated_at();
