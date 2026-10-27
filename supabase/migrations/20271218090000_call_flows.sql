/*
# Call flows (visual IVR builder)

## Why
Call Routing decides WHO answers by rules. Call Flows describes WHAT the caller
experiences: menus ("press 1 for service"), business-hours branches, routing and
fallbacks, built visually at /dashboard/calls/flows.

## What this does
- `call_flows`: many flows per account. `draft` is what the editor saves;
  `published` is the immutable snapshot the live call engine (service role) must read.
  Publishing bumps `published_version` (optimistic-locked by the client).
- `call_flow_settings`: ONE row per account holding `live_flow_id`, the flow that
  answers calls. Switching the live flow is a single atomic upsert. The composite
  foreign key guarantees the live flow belongs to the same account; the RLS check
  guarantees it is published.
- `call_flows_can_manage()`: owner/admin, or a team member whose
  `can_manage_numbers` permission (base or custom role) is true - the same gate as
  Phone Numbers and Call Routing, enforced server-side too.

## Safety
Purely additive: 2 new tables, 2 new functions. No existing table, column, policy,
trigger or function is modified. Safe to run more than once (IF NOT EXISTS /
OR REPLACE / DROP ... IF EXISTS for the objects created here). RLS: members of the
account with the manage permission can read/write ONLY their own account's rows.
Anonymous: no access. Deleting the live flow is blocked by the foreign key.

## Requires (already in your project)
public.get_account_owner_id(), profiles(id, role), team_members(user_id,
permissions, custom_role_id), custom_roles(id, permissions).
*/

CREATE OR REPLACE FUNCTION public.call_flows_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1
      FROM team_members m
      LEFT JOIN custom_roles cr ON cr.id = m.custom_role_id
      WHERE m.user_id = auth.uid()
        AND coalesce(
          (cr.permissions ->> 'can_manage_numbers')::boolean,
          (m.permissions ->> 'can_manage_numbers')::boolean,
          false
        )
    );
$$;

REVOKE ALL ON FUNCTION public.call_flows_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.call_flows_can_manage() TO authenticated;

CREATE TABLE IF NOT EXISTS call_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  draft jsonb NOT NULL,
  published jsonb,
  published_version integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_flows_id_owner_uk UNIQUE (id, account_owner_id),
  CONSTRAINT call_flows_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT call_flows_draft_is_object CHECK (jsonb_typeof(draft) = 'object'),
  CONSTRAINT call_flows_published_is_object CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
  CONSTRAINT call_flows_size_cap CHECK (pg_column_size(draft) < 262144 AND (published IS NULL OR pg_column_size(published) < 262144))
);

CREATE INDEX IF NOT EXISTS call_flows_owner_updated_idx ON call_flows (account_owner_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS call_flows_owner_name_uk ON call_flows (account_owner_id, lower(btrim(name)));

CREATE OR REPLACE FUNCTION public.call_flows_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_flows_touch ON call_flows;
CREATE TRIGGER trg_call_flows_touch
  BEFORE UPDATE ON call_flows
  FOR EACH ROW EXECUTE FUNCTION public.call_flows_touch_updated_at();

ALTER TABLE call_flows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cf_select" ON call_flows;
CREATE POLICY "cf_select" ON call_flows FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage());

DROP POLICY IF EXISTS "cf_insert" ON call_flows;
CREATE POLICY "cf_insert" ON call_flows FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage());

DROP POLICY IF EXISTS "cf_update" ON call_flows;
CREATE POLICY "cf_update" ON call_flows FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage());

DROP POLICY IF EXISTS "cf_delete" ON call_flows;
CREATE POLICY "cf_delete" ON call_flows FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage());

REVOKE ALL ON call_flows FROM anon;

CREATE TABLE IF NOT EXISTS call_flow_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  live_flow_id uuid,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_flow_settings_live_fk FOREIGN KEY (live_flow_id, account_owner_id)
    REFERENCES call_flows (id, account_owner_id)
);

ALTER TABLE call_flow_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cfs_select" ON call_flow_settings;
CREATE POLICY "cfs_select" ON call_flow_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage());

DROP POLICY IF EXISTS "cfs_insert" ON call_flow_settings;
CREATE POLICY "cfs_insert" ON call_flow_settings FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.call_flows_can_manage()
    AND (live_flow_id IS NULL OR EXISTS (SELECT 1 FROM call_flows f WHERE f.id = live_flow_id AND f.published IS NOT NULL))
  );

DROP POLICY IF EXISTS "cfs_update" ON call_flow_settings;
CREATE POLICY "cfs_update" ON call_flow_settings FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_flows_can_manage())
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.call_flows_can_manage()
    AND (live_flow_id IS NULL OR EXISTS (SELECT 1 FROM call_flows f WHERE f.id = live_flow_id AND f.published IS NOT NULL))
  );

REVOKE ALL ON call_flow_settings FROM anon;
REVOKE DELETE ON call_flow_settings FROM authenticated;
