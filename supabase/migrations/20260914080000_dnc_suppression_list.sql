/*
  # Do-Not-Call suppression list

  Gate that both outbound-queue-builder and outbound-dialer check before
  ever contacting a number. Two ways a number lands here:

  1. Automatically — the moment any outbound_calls row is set to
     'opted_out' (dashboard action), a trigger copies that phone number
     in here permanently. This never depends on any external service
     being configured.
  2. Manually / via an external National DNC Registry scrub, if wired up
     later — insert directly into this table with reason
     'national_registry'.

  Suppression is scoped per business (user_id), same as every other
  tenant table, since "don't call me" was said to *this* business.
*/

CREATE TABLE IF NOT EXISTS dnc_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  phone_number text NOT NULL,
  reason text NOT NULL DEFAULT 'customer_opt_out'
    CHECK (reason IN ('customer_opt_out', 'manual', 'national_registry')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_dnc_suppressions_lookup ON dnc_suppressions(user_id, phone_number);

ALTER TABLE dnc_suppressions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_dnc_suppressions" ON dnc_suppressions;
CREATE POLICY "select_own_dnc_suppressions" ON dnc_suppressions FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_dnc_suppressions" ON dnc_suppressions;
CREATE POLICY "insert_own_dnc_suppressions" ON dnc_suppressions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_dnc_suppressions" ON dnc_suppressions;
CREATE POLICY "delete_own_dnc_suppressions" ON dnc_suppressions FOR DELETE TO authenticated USING (user_id = auth.uid());
-- No UPDATE policy: suppression entries are append/delete only, never edited in place.

CREATE OR REPLACE FUNCTION sync_dnc_suppression_on_opt_out()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'opted_out' AND NEW.customer_phone IS NOT NULL
     AND (OLD.status IS DISTINCT FROM 'opted_out') THEN
    INSERT INTO dnc_suppressions (user_id, phone_number, reason)
    VALUES (NEW.user_id, NEW.customer_phone, 'customer_opt_out')
    ON CONFLICT (user_id, phone_number) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_dnc_suppression ON outbound_calls;
CREATE TRIGGER trg_sync_dnc_suppression
  AFTER UPDATE ON outbound_calls
  FOR EACH ROW EXECUTE FUNCTION sync_dnc_suppression_on_opt_out();
