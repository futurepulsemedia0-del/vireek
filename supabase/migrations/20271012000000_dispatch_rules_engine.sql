/*
  # Dispatch Rules Engine

  Owner-defined rules that score technicians for auto-assign:
  skill match, zone, VIP priority, max drive time, technician preferences, overtime limit.

  - `dispatch_rules`: one row per rule type per account (mode require|score, weight 0-100, params jsonb).
  - `dispatch_technician_preferences`: prefer / avoid / require a technician for a customer and/or service type.
  - `dispatch_decisions`: append-only audit log — what the engine recommended, who got the job, why,
    and manual overrides with an optional reason.

  Purely additive. assign_technician_to_job() is NOT replaced: the engine picks the technician and
  writes through that RPC, so time-off, capacity-lock and credential gates keep applying.

  Depends on: public.get_account_owner_id(), public.time_off_can_manage() (20270502000000_time_off_availability.sql).
*/

-- =============================================================
-- dispatch_rules
-- =============================================================
CREATE TABLE IF NOT EXISTS dispatch_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('skill_match', 'zone', 'vip_priority', 'max_drive_time', 'tech_preference', 'overtime_limit')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'score' CHECK (mode IN ('require', 'score')),
  weight integer NOT NULL DEFAULT 10 CHECK (weight BETWEEN 0 AND 100),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_rules_one_per_type UNIQUE (user_id, rule_type)
);

ALTER TABLE dispatch_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_rules_select" ON dispatch_rules
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "dispatch_rules_insert" ON dispatch_rules
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());
CREATE POLICY "dispatch_rules_update" ON dispatch_rules
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());
CREATE POLICY "dispatch_rules_delete" ON dispatch_rules
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage());

-- =============================================================
-- dispatch_technician_preferences
-- =============================================================
CREATE TABLE IF NOT EXISTS dispatch_technician_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  service_type text CHECK (service_type IS NULL OR char_length(btrim(service_type)) BETWEEN 1 AND 80),
  preference text NOT NULL CHECK (preference IN ('prefer', 'avoid', 'require')),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_pref_scope CHECK (customer_id IS NOT NULL OR service_type IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_pref_user ON dispatch_technician_preferences (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_pref_scope
  ON dispatch_technician_preferences (user_id, technician_id, COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(lower(service_type), ''));

ALTER TABLE dispatch_technician_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_pref_select" ON dispatch_technician_preferences
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "dispatch_pref_insert" ON dispatch_technician_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.time_off_can_manage());
CREATE POLICY "dispatch_pref_delete" ON dispatch_technician_preferences
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id() AND public.time_off_can_manage());

-- =============================================================
-- dispatch_decisions (append-only audit log)
-- =============================================================
CREATE TABLE IF NOT EXISTS dispatch_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  recommended_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('auto', 'manual', 'override', 'no_eligible')),
  score numeric(7,1),
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_user_created ON dispatch_decisions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_job ON dispatch_decisions (job_id);

ALTER TABLE dispatch_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_decisions_select" ON dispatch_decisions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "dispatch_decisions_insert" ON dispatch_decisions
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
-- No UPDATE / DELETE policies: the log is append-only for users (service role bypasses RLS).
