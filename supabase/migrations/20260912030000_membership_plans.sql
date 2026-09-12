/*
  # Membership plans & upsell tracking

  - membership_plans: recurring service-plan offers a business can pitch (e.g. "Annual Maintenance Plan")
  - memberships: tracks who was offered a plan, who accepted, who cancelled
  - RLS scoped to auth.uid(), same pattern as review_requests / outbound_campaigns
*/

CREATE TABLE IF NOT EXISTS membership_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  billing_interval text NOT NULL DEFAULT 'yearly'
    CHECK (billing_interval IN ('monthly', 'yearly')),
  benefits text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  plan_id uuid REFERENCES membership_plans(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  status text NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered', 'active', 'cancelled')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_membership_plans_user_id ON membership_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_status ON memberships(status);

ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_membership_plans" ON membership_plans;
CREATE POLICY "select_own_membership_plans" ON membership_plans FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_membership_plans" ON membership_plans;
CREATE POLICY "insert_own_membership_plans" ON membership_plans FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_membership_plans" ON membership_plans;
CREATE POLICY "update_own_membership_plans" ON membership_plans FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_membership_plans" ON membership_plans;
CREATE POLICY "delete_own_membership_plans" ON membership_plans FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "select_own_memberships" ON memberships;
CREATE POLICY "select_own_memberships" ON memberships FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_memberships" ON memberships;
CREATE POLICY "insert_own_memberships" ON memberships FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_memberships" ON memberships;
CREATE POLICY "update_own_memberships" ON memberships FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_memberships" ON memberships;
CREATE POLICY "delete_own_memberships" ON memberships FOR DELETE TO authenticated USING (user_id = auth.uid());
