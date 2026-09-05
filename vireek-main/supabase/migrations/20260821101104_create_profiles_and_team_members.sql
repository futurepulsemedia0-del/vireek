/*
# Create profiles + team_members tables with auto-creation trigger and RLS

## What this migration does
Creates the foundational authentication tables for the Vireek dashboard:
- `profiles`: business customer account information, auto-created on signup
- `team_members`: team members invited by an account owner, with granular permissions

A database trigger automatically creates a fresh empty profile row whenever a
new user signs up via Supabase Auth. Row Level Security ensures each authenticated
user can only read and update their own profile row, and team members can access
data belonging to their account owner.

## New Tables

### profiles
- `id` (uuid, PK, FK to auth.users.id ON DELETE CASCADE)
- `email` (text, not null — copied from auth.users at signup)
- `full_name` (text, nullable — filled during onboarding)
- `company_name` (text, nullable — filled during onboarding)
- `phone` (text, nullable — filled during onboarding)
- `plan` (text, not null, default 'starter' — 'starter' or 'professional')
- `minutes_used_this_month` (integer, not null, default 0)
- `minutes_included` (integer, not null, default 50)
- `status` (text, not null, default 'active' — 'active', 'suspended', 'canceled')
- `role` (text, not null, default 'owner' — 'owner', 'admin', 'member')
- `onboarding_completed` (boolean, not null, default false)
- `forwarding_number` (text, nullable — the phone number that forwards to Sarah)
- `external_id` (text, nullable — for matching incoming Airtable/Zapier data)
- `created_at` (timestamptz, default now)

### team_members
- `id` (uuid, PK)
- `account_owner_id` (uuid, FK to profiles.id ON DELETE CASCADE)
- `member_email` (text, not null)
- `member_name` (text, nullable)
- `role` (text, not null, default 'member' — 'owner', 'admin', 'technician', 'member')
- `permissions` (jsonb, default — granular flags: can_view_billing, can_manage_team, can_edit_business_profile, can_view_all_jobs)
- `invite_status` (text, not null, default 'pending' — 'pending', 'active')
- `created_at` (timestamptz, default now)

## Security
- RLS enabled on both tables.
- profiles: users can SELECT/UPDATE only their own row (auth.uid() = id).
  INSERT allowed only when auth.uid() = id (for the trigger).
- team_members: an account owner can SELECT/INSERT/UPDATE/DELETE rows where
  account_owner_id = auth.uid(). A team member can SELECT rows where their
  member_email matches auth.jwt() -> email (so they can see who invited them).
  A helper function `get_account_owner_id()` resolves the calling user's
  account owner for cross-table RLS in later migrations.

## Trigger
- `handle_new_user()` — fires AFTER INSERT on auth.users, inserts a matching
  row into `profiles` with the user's email and default values.

## Important Notes
1. The trigger function is SECURITY DEFINER so it can insert into `profiles`
   even though the calling context runs as anon/authenticated.
2. `get_account_owner_id()` returns the account owner's profile id for the
   current user — either their own profile id (if they are an owner) or the
   account_owner_id from team_members (if they are a team member). This function
   is used by RLS policies on all data tables in subsequent migrations.
3. An index on team_members(member_email) speeds up the lookup in
   get_account_owner_id().
*/

-- =============================================================
-- PROFILES TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  company_name text,
  phone text,
  plan text NOT NULL DEFAULT 'starter',
  minutes_used_this_month integer NOT NULL DEFAULT 0,
  minutes_included integer NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'active',
  role text NOT NULL DEFAULT 'owner',
  onboarding_completed boolean NOT NULL DEFAULT false,
  forwarding_number text,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_profile" ON profiles;
CREATE POLICY "select_own_profile"
ON profiles FOR SELECT
TO authenticated
USING (auth.uid() = id);

DROP POLICY IF EXISTS "insert_own_profile" ON profiles;
CREATE POLICY "insert_own_profile"
ON profiles FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "update_own_profile" ON profiles;
CREATE POLICY "update_own_profile"
ON profiles FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- =============================================================
-- TEAM_MEMBERS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_email text NOT NULL,
  member_name text,
  role text NOT NULL DEFAULT 'member',
  permissions jsonb NOT NULL DEFAULT '{
    "can_view_billing": false,
    "can_manage_team": false,
    "can_edit_business_profile": false,
    "can_view_all_jobs": false
  }'::jsonb,
  invite_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_members_member_email ON team_members(member_email);
CREATE INDEX IF NOT EXISTS idx_team_members_account_owner_id ON team_members(account_owner_id);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

-- Account owner can manage their team members
DROP POLICY IF EXISTS "select_own_team_members" ON team_members;
CREATE POLICY "select_own_team_members"
ON team_members FOR SELECT
TO authenticated
USING (account_owner_id = auth.uid() OR member_email = (SELECT email FROM auth.users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "insert_own_team_members" ON team_members;
CREATE POLICY "insert_own_team_members"
ON team_members FOR INSERT
TO authenticated
WITH CHECK (account_owner_id = auth.uid());

DROP POLICY IF EXISTS "update_own_team_members" ON team_members;
CREATE POLICY "update_own_team_members"
ON team_members FOR UPDATE
TO authenticated
USING (account_owner_id = auth.uid())
WITH CHECK (account_owner_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_team_members" ON team_members;
CREATE POLICY "delete_own_team_members"
ON team_members FOR DELETE
TO authenticated
USING (account_owner_id = auth.uid());

-- =============================================================
-- HELPER FUNCTION: get_account_owner_id()
-- Returns the account owner's profile id for the current user.
-- If the user is an owner (has a profile), returns their own id.
-- If they are a team member, returns the account_owner_id.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_account_owner_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT id FROM profiles WHERE id = auth.uid()),
    (SELECT account_owner_id FROM team_members WHERE member_email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1)
  );
$$;

-- =============================================================
-- TRIGGER: auto-create profile on signup
-- =============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
