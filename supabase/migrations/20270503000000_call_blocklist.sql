/*
# Blocklist, DNC manager, auto-block rules and per-call overrides

## Why
`dnc_suppressions` is the OUTBOUND "never contact this number" list. Inbound
spam/robocall blocking has different semantics (a hit counter, categories,
rules, temporary overrides), so it gets its own tables instead of stretching
the DNC CHECK constraint that outbound-dialer and sms-webhook already rely on.

## What this does
Existing table `dnc_suppressions` (ADDITIVE ONLY):
- new nullable columns `note`, `added_by`
- new team-member policies so a teammate with number-management access can
  read/add/remove rows for the ACCOUNT OWNER (rows are keyed by the owner's
  id, which is what outbound-dialer and sms-webhook query). The original
  `user_id = auth.uid()` policies are untouched; policies are OR-ed.

New tables, all keyed by `account_owner_id`:
- `call_blocklist`        manual / imported / auto spam, robocall, scam numbers
- `call_block_rules`      prefix, anonymous, neighbor-spoof, repeat-short-call rules
- `call_block_overrides`  time-boxed, use-limited "let this number through"
- `call_block_events`     audit log of blocked calls (written by the call path only)

New functions:
- `blocklist_can_manage()`          owner/admin or `can_manage_numbers`
- `call_block_record_hit(...)`      service_role only: logs event + bumps hit_count
- `call_block_consume_override(...)` service_role only: decrements uses_remaining

## Safety
No existing column, constraint, trigger or policy is modified or dropped.
Anonymous role: no access to anything. RPCs: service_role only.

## Requires (already in your project)
public.get_account_owner_id(), profiles(id, role), team_members(user_id,
permissions, custom_role_id), custom_roles(id, permissions), calls(id).
*/

CREATE OR REPLACE FUNCTION public.blocklist_can_manage()
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

REVOKE ALL ON FUNCTION public.blocklist_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.blocklist_can_manage() TO authenticated;

-- ---------------------------------------------------------------------------
-- dnc_suppressions: additive columns + team policies
-- ---------------------------------------------------------------------------
ALTER TABLE dnc_suppressions ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE dnc_suppressions ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dnc_suppressions_note_len') THEN
    ALTER TABLE dnc_suppressions ADD CONSTRAINT dnc_suppressions_note_len CHECK (note IS NULL OR char_length(note) <= 200);
  END IF;
END $$;

DROP POLICY IF EXISTS "dnc_team_select" ON dnc_suppressions;
CREATE POLICY "dnc_team_select" ON dnc_suppressions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.blocklist_can_manage());

DROP POLICY IF EXISTS "dnc_team_insert" ON dnc_suppressions;
CREATE POLICY "dnc_team_insert" ON dnc_suppressions FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.blocklist_can_manage());

DROP POLICY IF EXISTS "dnc_team_delete" ON dnc_suppressions;
CREATE POLICY "dnc_team_delete" ON dnc_suppressions FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.blocklist_can_manage());

-- ---------------------------------------------------------------------------
-- call_blocklist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  category text NOT NULL DEFAULT 'spam' CHECK (category IN ('spam', 'robocall', 'scam', 'manual')),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'call_flag')),
  hit_count integer NOT NULL DEFAULT 0,
  last_blocked_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, phone_number)
);
CREATE INDEX IF NOT EXISTS idx_call_blocklist_owner_created ON call_blocklist(account_owner_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- call_block_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_block_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('prefix', 'anonymous', 'neighbor_spoof', 'repeat_short_calls')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_block_rules_owner ON call_block_rules(account_owner_id, enabled);

CREATE OR REPLACE FUNCTION public.call_block_rules_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT count(*) FROM call_block_rules WHERE account_owner_id = NEW.account_owner_id) >= 25 THEN
    RAISE EXCEPTION 'An account can have at most 25 auto-block rules' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_call_block_rules_cap ON call_block_rules;
CREATE TRIGGER trg_call_block_rules_cap BEFORE INSERT ON call_block_rules
  FOR EACH ROW EXECUTE FUNCTION public.call_block_rules_cap();

-- ---------------------------------------------------------------------------
-- call_block_overrides
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_block_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  uses_remaining integer NOT NULL DEFAULT 1 CHECK (uses_remaining BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_block_overrides_lookup ON call_block_overrides(account_owner_id, phone_number, expires_at);

-- ---------------------------------------------------------------------------
-- call_block_events (written only by call_block_record_hit)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_block_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone_number text,
  reason text NOT NULL CHECK (reason IN ('blocklist', 'rule')),
  rule_id uuid REFERENCES call_block_rules(id) ON DELETE SET NULL,
  category text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_block_events_owner_created ON call_block_events(account_owner_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE call_blocklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_block_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_block_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_block_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  scope text := 'account_owner_id = public.get_account_owner_id() AND public.blocklist_can_manage()';
BEGIN
  FOREACH t IN ARRAY ARRAY['call_blocklist', 'call_block_rules', 'call_block_overrides'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON %1$s FOR SELECT TO authenticated USING (%2$s)', t, scope);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT TO authenticated WITH CHECK (%2$s)', t, scope);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE TO authenticated USING (%2$s) WITH CHECK (%2$s)', t, scope);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_delete" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON %1$s FOR DELETE TO authenticated USING (%2$s)', t, scope);
    EXECUTE format('REVOKE ALL ON %1$s FROM anon', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "call_block_events_select" ON call_block_events;
CREATE POLICY "call_block_events_select" ON call_block_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.blocklist_can_manage());
REVOKE ALL ON call_block_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON call_block_events FROM authenticated;

-- ---------------------------------------------------------------------------
-- Call-path RPCs (service_role only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.call_block_record_hit(
  p_owner uuid, p_phone text, p_reason text, p_rule uuid, p_category text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO call_block_events (account_owner_id, phone_number, reason, rule_id, category)
  VALUES (p_owner, p_phone, p_reason, p_rule, p_category);

  IF p_reason = 'blocklist' AND p_phone IS NOT NULL THEN
    UPDATE call_blocklist
       SET hit_count = hit_count + 1, last_blocked_at = now()
     WHERE account_owner_id = p_owner AND phone_number = p_phone;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.call_block_consume_override(p_override uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE call_block_overrides
     SET uses_remaining = uses_remaining - 1
   WHERE id = p_override AND uses_remaining > 0 AND expires_at > now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.call_block_record_hit(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_block_consume_override(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_block_record_hit(uuid, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.call_block_consume_override(uuid) TO service_role;
