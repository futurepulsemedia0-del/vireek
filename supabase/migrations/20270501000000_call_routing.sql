/*
# Call routing builder

## Why
Accounts could set weekly hours, holidays and escalation rules on
`business_profile`, but there was no single place to describe the full
decision flow of an inbound call (emergency -> holiday -> hours -> language ->
department -> overflow -> voicemail). This adds the persistence layer for the
visual builder at /dashboard/call-routing.

## What this does
- `call_routing_configs`: ONE row per account (keyed by account_owner_id).
  `draft` is what the editor autosaves; `published` is the immutable snapshot
  the live call engine (service role) must read. Publishing bumps
  `published_version` (optimistic-locked by the client).
- `call_routing_can_manage()`: owner/admin, or a team member whose
  `can_manage_numbers` permission (base or custom role) is true. Same gate as
  the Phone Numbers page, enforced server-side too.

## Safety
Purely additive: new table + 2 new functions. No existing table, column,
policy, trigger or function is modified. RLS: members of the account with the
manage permission can read/write ONLY their own account's row. Anonymous: no access.

## Requires (already in your project)
public.get_account_owner_id(), profiles(id, role), team_members(user_id,
permissions, custom_role_id), custom_roles(id, permissions).
*/

CREATE OR REPLACE FUNCTION public.call_routing_can_manage()
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

REVOKE ALL ON FUNCTION public.call_routing_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.call_routing_can_manage() TO authenticated;

CREATE TABLE IF NOT EXISTS call_routing_configs (
  account_owner_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  draft jsonb NOT NULL,
  published jsonb,
  published_version integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_routing_draft_is_object CHECK (jsonb_typeof(draft) = 'object'),
  CONSTRAINT call_routing_published_is_object CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
  CONSTRAINT call_routing_size_cap CHECK (pg_column_size(draft) < 262144 AND (published IS NULL OR pg_column_size(published) < 262144))
);

CREATE OR REPLACE FUNCTION public.call_routing_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_routing_touch ON call_routing_configs;
CREATE TRIGGER trg_call_routing_touch
  BEFORE UPDATE ON call_routing_configs
  FOR EACH ROW EXECUTE FUNCTION public.call_routing_touch_updated_at();

ALTER TABLE call_routing_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crc_select" ON call_routing_configs;
CREATE POLICY "crc_select" ON call_routing_configs FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_routing_can_manage());

DROP POLICY IF EXISTS "crc_insert" ON call_routing_configs;
CREATE POLICY "crc_insert" ON call_routing_configs FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.call_routing_can_manage());

DROP POLICY IF EXISTS "crc_update" ON call_routing_configs;
CREATE POLICY "crc_update" ON call_routing_configs FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.call_routing_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.call_routing_can_manage());

REVOKE ALL ON call_routing_configs FROM anon;
REVOKE DELETE ON call_routing_configs FROM authenticated;
