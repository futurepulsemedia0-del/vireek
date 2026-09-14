/*
  # CSM onboarding bookings + call feedback (NPS/CSAT)

  ## onboarding_bookings
  Same secure pattern as demo_bookings: public INSERT (anon+authenticated),
  admin-only SELECT, unique slot_start, PII-free RPC for slot availability.

  ## call_feedback
  One feedback row per call, owned by the tenant (auth.uid() = user_id).
  Only the call's owner can insert/select/update their own feedback.
*/

CREATE TABLE IF NOT EXISTS onboarding_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  work_email text NOT NULL,
  company_name text NOT NULL,
  phone text,
  plan_tier text,
  message text,
  slot_start timestamptz NOT NULL,
  slot_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'canceled', 'no_show')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slot_start)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_bookings_slot_start ON onboarding_bookings(slot_start);

ALTER TABLE onboarding_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can request onboarding slot"
  ON onboarding_bookings FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Only admins read onboarding bookings"
  ON onboarding_bookings FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

CREATE OR REPLACE FUNCTION get_booked_onboarding_slot_starts(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (slot_start timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ob.slot_start FROM onboarding_bookings ob
  WHERE ob.slot_start >= p_start AND ob.slot_start < p_end;
$$;

GRANT EXECUTE ON FUNCTION get_booked_onboarding_slot_starts(timestamptz, timestamptz) TO anon, authenticated;

-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS idx_call_feedback_user_id ON call_feedback(user_id);

ALTER TABLE call_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their own call feedback"
  ON call_feedback FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
