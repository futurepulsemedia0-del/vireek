/*
  # Business Valuation + Exit-Readiness Score + Data Room Checklist

  ## Why
  An owner who may sell, bring in a partner or raise capital needs three
  things: an honest ballpark of what the business is worth, a score showing
  how ready it is for a buyer's due diligence, and a checklist of the
  documents a buyer will ask for. This stores the inputs, the questionnaire
  answers, the data-room progress and a history of saved snapshots.

  ## Model
  - valuation_profiles   one row per account: financial inputs, multiple band,
                         readiness-questionnaire answers (jsonb), target exit date
  - data_room_items      one row per checklist item (catalog lives in the app,
                         the database only stores status + note per item key)
  - valuation_snapshots  append-only history of scores and estimates

  ## Security
  - Valuation data is the most sensitive financial data on the account, so
    EVERY operation (read and write) is limited to the account OWNER
    (is_valuation_owner()). Team members, including managers, get no access.
  - Tenancy: user_id = public.get_account_owner_id().
  - Snapshots have no UPDATE / DELETE policy (append-only history).

  ## Depends on
  20260821101104_create_profiles_and_team_members.sql (profiles, team_members, get_account_owner_id)
*/

-- =============================================================
-- 1. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_valuation_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.is_valuation_owner() TO authenticated;

CREATE OR REPLACE FUNCTION public.valuation_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS valuation_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE DEFAULT public.get_account_owner_id(),
  annual_revenue numeric(14, 2)
    CHECK (annual_revenue IS NULL OR annual_revenue BETWEEN 0 AND 10000000000),
  owner_earnings numeric(14, 2)
    CHECK (owner_earnings IS NULL OR owner_earnings BETWEEN -1000000000 AND 10000000000),
  revenue_growth_pct numeric(7, 2)
    CHECK (revenue_growth_pct IS NULL OR revenue_growth_pct BETWEEN -100 AND 1000),
  recurring_revenue_pct numeric(5, 2)
    CHECK (recurring_revenue_pct IS NULL OR recurring_revenue_pct BETWEEN 0 AND 100),
  top_customer_pct numeric(5, 2)
    CHECK (top_customer_pct IS NULL OR top_customer_pct BETWEEN 0 AND 100),
  cash_on_hand numeric(14, 2)
    CHECK (cash_on_hand IS NULL OR cash_on_hand BETWEEN 0 AND 10000000000),
  total_debt numeric(14, 2)
    CHECK (total_debt IS NULL OR total_debt BETWEEN 0 AND 10000000000),
  multiple_low numeric(4, 2) NOT NULL DEFAULT 2.00 CHECK (multiple_low BETWEEN 0.5 AND 10),
  multiple_high numeric(4, 2) NOT NULL DEFAULT 3.50 CHECK (multiple_high BETWEEN 0.5 AND 10),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 4000),
  target_exit_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (multiple_high > multiple_low)
);

CREATE TABLE IF NOT EXISTS data_room_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  item_key text NOT NULL CHECK (item_key ~ '^[a-z0-9_]{3,40}$'),
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'ready', 'not_applicable')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_key)
);

CREATE TABLE IF NOT EXISTS valuation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  label text CHECK (label IS NULL OR char_length(label) <= 120),
  readiness_score integer CHECK (readiness_score IS NULL OR readiness_score BETWEEN 0 AND 100),
  assessment_score integer CHECK (assessment_score IS NULL OR assessment_score BETWEEN 0 AND 100),
  data_room_score integer CHECK (data_room_score IS NULL OR data_room_score BETWEEN 0 AND 100),
  value_low numeric(14, 2),
  value_mid numeric(14, 2),
  value_high numeric(14, 2),
  owner_earnings numeric(14, 2),
  multiple_mid numeric(5, 2),
  dimension_scores jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(dimension_scores) = 'object' AND octet_length(dimension_scores::text) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_room_items_owner ON data_room_items (user_id);
CREATE INDEX IF NOT EXISTS idx_valuation_snapshots_owner_created ON valuation_snapshots (user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_valuation_profiles_updated_at ON valuation_profiles;
CREATE TRIGGER trg_valuation_profiles_updated_at
  BEFORE UPDATE ON valuation_profiles
  FOR EACH ROW EXECUTE FUNCTION public.valuation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_data_room_items_updated_at ON data_room_items;
CREATE TRIGGER trg_data_room_items_updated_at
  BEFORE UPDATE ON data_room_items
  FOR EACH ROW EXECUTE FUNCTION public.valuation_touch_updated_at();

-- =============================================================
-- 3. RLS (owner only, read and write)
-- =============================================================

ALTER TABLE valuation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_room_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE valuation_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_select_valuation_profiles" ON valuation_profiles;
CREATE POLICY "owner_select_valuation_profiles" ON valuation_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_insert_valuation_profiles" ON valuation_profiles;
CREATE POLICY "owner_insert_valuation_profiles" ON valuation_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_update_valuation_profiles" ON valuation_profiles;
CREATE POLICY "owner_update_valuation_profiles" ON valuation_profiles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.is_valuation_owner())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_select_data_room_items" ON data_room_items;
CREATE POLICY "owner_select_data_room_items" ON data_room_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_insert_data_room_items" ON data_room_items;
CREATE POLICY "owner_insert_data_room_items" ON data_room_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_update_data_room_items" ON data_room_items;
CREATE POLICY "owner_update_data_room_items" ON data_room_items FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.is_valuation_owner())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_select_valuation_snapshots" ON valuation_snapshots;
CREATE POLICY "owner_select_valuation_snapshots" ON valuation_snapshots FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.is_valuation_owner());

DROP POLICY IF EXISTS "owner_insert_valuation_snapshots" ON valuation_snapshots;
CREATE POLICY "owner_insert_valuation_snapshots" ON valuation_snapshots FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.is_valuation_owner());
