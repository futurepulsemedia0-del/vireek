/*
  # Multi-entity reporting — per-entity P&L, combined view, intercompany elimination

  ## Why
  One Vireek account (one owner) can run several legal entities / brands. The
  general ledger (20261203000001_accounting_general_ledger.sql) is a single
  book per account, so there was no way to see each entity's P&L, a combined
  view, or to strip out money the entities charge each other.

  ## What this adds (additive only — nothing existing is dropped or renamed)
  1. reporting_entities          — the entities under one account. One default
                                   entity per account ("MAIN"); ledger rows with
                                   no entity belong to the default entity, so no
                                   existing data needs to be rewritten.
  2. reporting_entity_access     — which team members may see which entity.
  3. reporting_entity_audit_events — append-only trail of every change.
  4. journal_entries gets four nullable/defaulted columns: entity_id,
     counterparty_entity_id, is_intercompany, intercompany_group_id, plus
     composite foreign keys (entity, account) so an entry can never point at
     another account's entity.
  5. A BEFORE INSERT trigger so a reversal created by void_journal_entry()
     inherits the entity / intercompany flags of the entry it reverses.
  6. RPCs (all SECURITY DEFINER, all scoped by get_account_owner_id()):
       ensure_default_reporting_entity, list_reporting_entities,
       create_reporting_entity, update_reporting_entity,
       get_reporting_entity_access_overview, set_reporting_entity_access,
       list_journal_entries_for_entity, assign_journal_entries_to_entity,
       post_intercompany_entry, get_multi_entity_profit_and_loss.

  ## Access model ("RLS per entity")
  - The account owner sees and manages every entity.
  - A team member sees an entity only if (a) they have can_view_billing AND
    (b) the owner granted them that entity. Everything else is invisible:
    entities, reports, entry lists. Requesting an entity you cannot see raises
    42501 instead of silently returning less.
  - Note: can_manage_chart_of_accounts() is NOT used here on purpose — every
    auth user has a profiles row, so its first branch is always true.
  - New tables have SELECT policies only; every write is an RPC.

  ## Intercompany elimination
  post_intercompany_entry() books the two sides atomically (provider:
  Dr receivable / Cr revenue, recipient: Dr expense / Cr payable) and flags
  both entries is_intercompany. In the report, revenue/expense lines of flagged
  entries are eliminated only when the counterparty entity is ALSO inside the
  selected scope, so a partial selection never hides one-sided income.

  ## Report invariant
  Summing gross_cents of get_multi_entity_profit_and_loss over all entities
  equals get_profit_and_loss() for the same dates (same posted-only rule).
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS reporting_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code),
  UNIQUE (id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reporting_entities_default
  ON reporting_entities (user_id) WHERE is_default;

ALTER TABLE reporting_entities ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS reporting_entity_access (
  entity_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  member_user_id uuid NOT NULL,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, member_user_id),
  FOREIGN KEY (entity_id, owner_id) REFERENCES reporting_entities (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reporting_entity_access_member ON reporting_entity_access (member_user_id);

ALTER TABLE reporting_entity_access ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS reporting_entity_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  entity_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reporting_entity_audit_user ON reporting_entity_audit_events (user_id, created_at DESC);

ALTER TABLE reporting_entity_audit_events ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- JOURNAL ENTRIES: entity + intercompany columns (additive)
-- =============================================================

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS counterparty_entity_id uuid,
  ADD COLUMN IF NOT EXISTS is_intercompany boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS intercompany_group_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_entries_entity_fk' AND conrelid = 'public.journal_entries'::regclass
  ) THEN
    ALTER TABLE public.journal_entries
      ADD CONSTRAINT journal_entries_entity_fk
      FOREIGN KEY (entity_id, user_id) REFERENCES public.reporting_entities (id, user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_entries_counterparty_entity_fk' AND conrelid = 'public.journal_entries'::regclass
  ) THEN
    ALTER TABLE public.journal_entries
      ADD CONSTRAINT journal_entries_counterparty_entity_fk
      FOREIGN KEY (counterparty_entity_id, user_id) REFERENCES public.reporting_entities (id, user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_entries_intercompany_chk' AND conrelid = 'public.journal_entries'::regclass
  ) THEN
    ALTER TABLE public.journal_entries
      ADD CONSTRAINT journal_entries_intercompany_chk
      CHECK (
        NOT is_intercompany
        OR (
          entity_id IS NOT NULL
          AND counterparty_entity_id IS NOT NULL
          AND entity_id <> counterparty_entity_id
          AND intercompany_group_id IS NOT NULL
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_journal_entries_entity
  ON journal_entries (user_id, entity_id, entry_date) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_ic_group
  ON journal_entries (intercompany_group_id) WHERE intercompany_group_id IS NOT NULL;

-- =============================================================
-- ACCESS HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._mer_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND public.get_account_owner_id() = auth.uid();
$$;

-- Owner, or a team member of this account holding can_view_billing.
CREATE OR REPLACE FUNCTION public._mer_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.get_account_owner_id() = auth.uid()
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

-- The single source of truth for "may the caller see this entity?".
-- Used by the SELECT policy below and by every RPC.
CREATE OR REPLACE FUNCTION public._mer_can_access_entity(p_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM reporting_entities e
    WHERE e.id = p_entity_id
      AND e.user_id = public.get_account_owner_id()
      AND (
        public.get_account_owner_id() = auth.uid()
        OR (
          public._mer_can_view()
          AND EXISTS (
            SELECT 1 FROM reporting_entity_access a
            WHERE a.entity_id = e.id AND a.member_user_id = auth.uid()
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public._mer_is_owner() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._mer_can_view() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._mer_can_access_entity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._mer_is_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public._mer_can_view() TO authenticated;
GRANT EXECUTE ON FUNCTION public._mer_can_access_entity(uuid) TO authenticated;

-- Internal guards: not callable from the client at all.
CREATE OR REPLACE FUNCTION public._mer_require_owner()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._mer_is_owner() THEN
    RAISE EXCEPTION 'Only the account owner can do this' USING ERRCODE = '42501';
  END IF;
  RETURN public.get_account_owner_id();
END;
$$;

CREATE OR REPLACE FUNCTION public._mer_require_billing()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._mer_can_view() THEN
    RAISE EXCEPTION 'You do not have permission to view entity reports' USING ERRCODE = '42501';
  END IF;
  RETURN public.get_account_owner_id();
END;
$$;

CREATE OR REPLACE FUNCTION public._mer_audit(p_owner uuid, p_entity_id uuid, p_action text, p_detail jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO reporting_entity_audit_events (user_id, actor_id, entity_id, action, detail)
  VALUES (p_owner, auth.uid(), p_entity_id, p_action, COALESCE(p_detail, '{}'::jsonb));
$$;

-- Creates the account's default entity on first use. Idempotent and race-safe.
CREATE OR REPLACE FUNCTION public._mer_ensure_default(p_owner uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT e.id INTO v_id FROM reporting_entities e WHERE e.user_id = p_owner AND e.is_default;
  IF v_id IS NULL THEN
    INSERT INTO reporting_entities (user_id, code, name, is_default)
    VALUES (
      p_owner, 'MAIN',
      COALESCE(NULLIF(left(btrim((SELECT p.company_name FROM profiles p WHERE p.id = p_owner)), 120), ''), 'Main entity'),
      true
    )
    ON CONFLICT DO NOTHING;
    SELECT e.id INTO v_id FROM reporting_entities e WHERE e.user_id = p_owner AND e.is_default;
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Could not create the default entity';
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._mer_require_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._mer_require_billing() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._mer_audit(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._mer_ensure_default(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RLS POLICIES (SELECT only — every write is an RPC)
-- =============================================================

DROP POLICY IF EXISTS "select_accessible_reporting_entities" ON reporting_entities;
CREATE POLICY "select_accessible_reporting_entities" ON reporting_entities FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._mer_can_access_entity(id));

DROP POLICY IF EXISTS "select_own_reporting_entity_access" ON reporting_entity_access;
CREATE POLICY "select_own_reporting_entity_access" ON reporting_entity_access FOR SELECT TO authenticated
  USING (
    owner_id = public.get_account_owner_id()
    AND (public._mer_is_owner() OR member_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "select_owner_reporting_entity_audit" ON reporting_entity_audit_events;
CREATE POLICY "select_owner_reporting_entity_audit" ON reporting_entity_audit_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._mer_is_owner());

-- =============================================================
-- TRIGGER: a reversal inherits the entity of the entry it reverses
-- (void_journal_entry() posts the reversal with source_id = original id)
-- =============================================================

CREATE OR REPLACE FUNCTION public._mer_inherit_entity_on_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orig record;
BEGIN
  SELECT je.entity_id, je.counterparty_entity_id, je.is_intercompany, je.intercompany_group_id
  INTO v_orig
  FROM journal_entries je
  WHERE je.id = NEW.source_id AND je.user_id = NEW.user_id;

  IF FOUND THEN
    NEW.entity_id := v_orig.entity_id;
    NEW.counterparty_entity_id := v_orig.counterparty_entity_id;
    NEW.is_intercompany := v_orig.is_intercompany;
    NEW.intercompany_group_id := v_orig.intercompany_group_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._mer_inherit_entity_on_reversal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_mer_inherit_entity_on_reversal ON journal_entries;
CREATE TRIGGER trg_mer_inherit_entity_on_reversal
  BEFORE INSERT ON journal_entries
  FOR EACH ROW
  WHEN (NEW.source_type = 'reversal' AND NEW.source_id IS NOT NULL AND NEW.entity_id IS NULL)
  EXECUTE FUNCTION public._mer_inherit_entity_on_reversal();

-- =============================================================
-- RPC: entities
-- =============================================================

CREATE OR REPLACE FUNCTION public.ensure_default_reporting_entity()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_id uuid;
BEGIN
  v_owner := public._mer_require_billing();
  v_id := public._mer_ensure_default(v_owner);
  IF public._mer_can_access_entity(v_id) THEN
    RETURN v_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_reporting_entities()
RETURNS TABLE (
  entity_id uuid, entity_code text, entity_name text, is_default boolean,
  is_active boolean, entry_count bigint, created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := public._mer_require_billing();
  PERFORM public._mer_ensure_default(v_owner);

  RETURN QUERY
  SELECT
    e.id, e.code, e.name, e.is_default, e.is_active,
    (
      SELECT count(*) FROM journal_entries je
      WHERE je.user_id = v_owner AND je.status = 'posted'
        AND (je.entity_id = e.id OR (e.is_default AND je.entity_id IS NULL))
    )::bigint,
    e.created_at
  FROM reporting_entities e
  WHERE e.user_id = v_owner AND public._mer_can_access_entity(e.id)
  ORDER BY e.is_default DESC, e.code;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_reporting_entity(p_name text, p_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_name text;
  v_code text;
  v_id uuid;
BEGIN
  v_owner := public._mer_require_owner();
  v_name := btrim(COALESCE(p_name, ''));
  v_code := upper(btrim(COALESCE(p_code, '')));

  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Entity name must be 1 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' THEN
    RAISE EXCEPTION 'Entity code must be 1 to 20 characters: letters, numbers, - or _' USING ERRCODE = '22023';
  END IF;

  PERFORM public._mer_ensure_default(v_owner);

  IF (SELECT count(*) FROM reporting_entities e WHERE e.user_id = v_owner) >= 25 THEN
    RAISE EXCEPTION 'An account can have at most 25 entities' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO reporting_entities (user_id, code, name)
    VALUES (v_owner, v_code, v_name)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'An entity with code % already exists', v_code USING ERRCODE = '23505';
  END;

  PERFORM public._mer_audit(v_owner, v_id, 'entity_created', jsonb_build_object('code', v_code, 'name', v_name));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_reporting_entity(p_entity_id uuid, p_name text, p_is_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_row reporting_entities%ROWTYPE;
  v_name text;
  v_active boolean;
BEGIN
  v_owner := public._mer_require_owner();

  SELECT * INTO v_row FROM reporting_entities e WHERE e.id = p_entity_id AND e.user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entity not found' USING ERRCODE = 'P0002';
  END IF;

  v_name := COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), v_row.name);
  v_active := COALESCE(p_is_active, v_row.is_active);

  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Entity name must be 1 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF v_row.is_default AND NOT v_active THEN
    RAISE EXCEPTION 'The default entity cannot be deactivated' USING ERRCODE = '22023';
  END IF;

  UPDATE reporting_entities SET name = v_name, is_active = v_active, updated_at = now()
  WHERE id = p_entity_id AND user_id = v_owner;

  PERFORM public._mer_audit(v_owner, p_entity_id, 'entity_updated',
    jsonb_build_object('name', v_name, 'is_active', v_active));
END;
$$;

-- =============================================================
-- RPC: per-entity access (owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_reporting_entity_access_overview()
RETURNS TABLE (
  entity_id uuid, entity_code text, entity_name text,
  member_user_id uuid, member_name text, member_email text, has_access boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := public._mer_require_owner();
  PERFORM public._mer_ensure_default(v_owner);

  RETURN QUERY
  SELECT
    e.id, e.code, e.name,
    tm.user_id, tm.member_name, tm.member_email,
    EXISTS (
      SELECT 1 FROM reporting_entity_access a
      WHERE a.entity_id = e.id AND a.member_user_id = tm.user_id
    )
  FROM reporting_entities e
  JOIN team_members tm ON tm.account_owner_id = v_owner AND tm.user_id IS NOT NULL
  WHERE e.user_id = v_owner
  ORDER BY e.is_default DESC, e.code, tm.member_name NULLS LAST, tm.member_email;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_reporting_entity_access(p_entity_id uuid, p_member_user_id uuid, p_granted boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := public._mer_require_owner();

  IF NOT EXISTS (SELECT 1 FROM reporting_entities e WHERE e.id = p_entity_id AND e.user_id = v_owner) THEN
    RAISE EXCEPTION 'Entity not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.user_id = p_member_user_id AND tm.account_owner_id = v_owner
  ) THEN
    RAISE EXCEPTION 'That person is not on your team' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_granted, false) THEN
    INSERT INTO reporting_entity_access (entity_id, owner_id, member_user_id, granted_by)
    VALUES (p_entity_id, v_owner, p_member_user_id, auth.uid())
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM reporting_entity_access a
    WHERE a.entity_id = p_entity_id AND a.owner_id = v_owner AND a.member_user_id = p_member_user_id;
  END IF;

  PERFORM public._mer_audit(
    v_owner, p_entity_id,
    CASE WHEN COALESCE(p_granted, false) THEN 'access_granted' ELSE 'access_revoked' END,
    jsonb_build_object('member_user_id', p_member_user_id)
  );
END;
$$;

-- =============================================================
-- RPC: assign existing ledger entries to an entity
-- =============================================================

CREATE OR REPLACE FUNCTION public.list_journal_entries_for_entity(p_entity_id uuid, p_limit integer DEFAULT 100)
RETURNS TABLE (
  entry_id uuid, entry_number text, entry_date date, memo text,
  source_type text, total_cents bigint, is_intercompany boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_is_default boolean;
  v_limit integer;
BEGIN
  v_owner := public._mer_require_billing();
  PERFORM public._mer_ensure_default(v_owner);

  SELECT e.is_default INTO v_is_default
  FROM reporting_entities e WHERE e.id = p_entity_id AND e.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entity not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public._mer_can_access_entity(p_entity_id) THEN
    RAISE EXCEPTION 'You do not have access to this entity' USING ERRCODE = '42501';
  END IF;

  v_limit := least(greatest(COALESCE(p_limit, 100), 1), 200);

  RETURN QUERY
  SELECT
    je.id, je.entry_number, je.entry_date, je.memo, je.source_type,
    (SELECT COALESCE(sum(jl.debit_cents), 0) FROM journal_lines jl WHERE jl.journal_entry_id = je.id)::bigint,
    je.is_intercompany
  FROM journal_entries je
  WHERE je.user_id = v_owner
    AND je.status = 'posted'
    AND je.source_type <> 'reversal'
    AND (je.entity_id = p_entity_id OR (v_is_default AND je.entity_id IS NULL))
  ORDER BY je.entry_date DESC, je.created_at DESC
  LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_journal_entries_to_entity(p_entry_ids uuid[], p_entity_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_default uuid;
  v_ids uuid[];
  v_row record;
  v_found integer := 0;
  v_moved integer := 0;
BEGIN
  v_owner := public._mer_require_billing();

  IF p_entry_ids IS NULL OR cardinality(p_entry_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one entry' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_entry_ids) > 500 THEN
    RAISE EXCEPTION 'Move at most 500 entries at a time' USING ERRCODE = '22023';
  END IF;

  v_default := public._mer_ensure_default(v_owner);
  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(p_entry_ids) AS x);

  IF NOT EXISTS (
    SELECT 1 FROM reporting_entities e WHERE e.id = p_entity_id AND e.user_id = v_owner AND e.is_active
  ) THEN
    RAISE EXCEPTION 'Target entity not found or inactive' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public._mer_can_access_entity(p_entity_id) THEN
    RAISE EXCEPTION 'You do not have access to the target entity' USING ERRCODE = '42501';
  END IF;

  FOR v_row IN
    SELECT je.id, je.entry_date, je.status, je.is_intercompany, je.source_type,
           COALESCE(je.entity_id, v_default) AS current_entity
    FROM journal_entries je
    WHERE je.id = ANY(v_ids) AND je.user_id = v_owner
    ORDER BY je.id
    FOR UPDATE
  LOOP
    v_found := v_found + 1;
    IF v_row.status <> 'posted' THEN
      RAISE EXCEPTION 'A voided entry cannot be moved' USING ERRCODE = '22023';
    END IF;
    IF v_row.is_intercompany THEN
      RAISE EXCEPTION 'Intercompany entries are tied to their two entities and cannot be moved' USING ERRCODE = '22023';
    END IF;
    IF v_row.source_type = 'reversal' THEN
      RAISE EXCEPTION 'A reversal always follows the entry it reverses' USING ERRCODE = '22023';
    END IF;
    IF NOT public._mer_can_access_entity(v_row.current_entity) THEN
      RAISE EXCEPTION 'You do not have access to the entity this entry currently belongs to' USING ERRCODE = '42501';
    END IF;
    PERFORM public._gl_assert_period_open(v_owner, v_row.entry_date);
  END LOOP;

  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One or more entries were not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE journal_entries je SET entity_id = p_entity_id
  WHERE je.id = ANY(v_ids) AND je.user_id = v_owner
    AND COALESCE(je.entity_id, v_default) <> p_entity_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  PERFORM public._mer_audit(v_owner, p_entity_id, 'entries_assigned',
    jsonb_build_object('requested', cardinality(v_ids), 'moved', v_moved));
  RETURN v_moved;
END;
$$;

-- =============================================================
-- RPC: intercompany posting (both sides, atomically)
-- Returns the intercompany group id shared by the two entries.
-- =============================================================

CREATE OR REPLACE FUNCTION public.post_intercompany_entry(
  p_entry_date date,
  p_memo text,
  p_provider_entity_id uuid,
  p_recipient_entity_id uuid,
  p_amount_cents integer,
  p_receivable_account_id uuid,
  p_revenue_account_id uuid,
  p_expense_account_id uuid,
  p_payable_account_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_group uuid := gen_random_uuid();
  v_memo text;
  v_provider_code text;
  v_recipient_code text;
  v_label text;
  v_a uuid;
  v_b uuid;
BEGIN
  v_owner := public._mer_require_billing();

  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'Entry date is required' USING ERRCODE = '22023';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF p_provider_entity_id IS NULL OR p_recipient_entity_id IS NULL OR p_provider_entity_id = p_recipient_entity_id THEN
    RAISE EXCEPTION 'Pick two different entities' USING ERRCODE = '22023';
  END IF;

  v_memo := btrim(COALESCE(p_memo, ''));
  IF char_length(v_memo) > 500 THEN
    RAISE EXCEPTION 'Memo must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;

  SELECT e.code INTO v_provider_code
  FROM reporting_entities e WHERE e.id = p_provider_entity_id AND e.user_id = v_owner AND e.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Providing entity not found or inactive' USING ERRCODE = 'P0002';
  END IF;

  SELECT e.code INTO v_recipient_code
  FROM reporting_entities e WHERE e.id = p_recipient_entity_id AND e.user_id = v_owner AND e.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving entity not found or inactive' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public._mer_can_access_entity(p_provider_entity_id)
     OR NOT public._mer_can_access_entity(p_recipient_entity_id) THEN
    RAISE EXCEPTION 'You need access to both entities' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.id = p_receivable_account_id AND c.user_id = v_owner AND c.is_active AND c.type = 'asset') THEN
    RAISE EXCEPTION 'The receivable account must be an active asset account' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.id = p_revenue_account_id AND c.user_id = v_owner AND c.is_active AND c.type = 'revenue') THEN
    RAISE EXCEPTION 'The revenue account must be an active revenue account' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.id = p_expense_account_id AND c.user_id = v_owner AND c.is_active AND c.type = 'expense') THEN
    RAISE EXCEPTION 'The expense account must be an active expense account' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.id = p_payable_account_id AND c.user_id = v_owner AND c.is_active AND c.type = 'liability') THEN
    RAISE EXCEPTION 'The payable account must be an active liability account' USING ERRCODE = '22023';
  END IF;

  v_label := 'Intercompany ' || v_provider_code || ' to ' || v_recipient_code
    || CASE WHEN v_memo <> '' THEN ': ' || v_memo ELSE '' END;

  v_a := public.post_journal_entry(
    p_entry_date, v_label, 'manual', NULL::uuid,
    jsonb_build_array(
      jsonb_build_object('account_id', p_receivable_account_id, 'debit_cents', p_amount_cents, 'credit_cents', 0,
        'description', 'Intercompany receivable from ' || v_recipient_code),
      jsonb_build_object('account_id', p_revenue_account_id, 'debit_cents', 0, 'credit_cents', p_amount_cents,
        'description', 'Intercompany revenue from ' || v_recipient_code)
    )
  );

  v_b := public.post_journal_entry(
    p_entry_date, v_label, 'manual', NULL::uuid,
    jsonb_build_array(
      jsonb_build_object('account_id', p_expense_account_id, 'debit_cents', p_amount_cents, 'credit_cents', 0,
        'description', 'Intercompany expense to ' || v_provider_code),
      jsonb_build_object('account_id', p_payable_account_id, 'debit_cents', 0, 'credit_cents', p_amount_cents,
        'description', 'Intercompany payable to ' || v_provider_code)
    )
  );

  UPDATE journal_entries je SET
    entity_id = CASE WHEN je.id = v_a THEN p_provider_entity_id ELSE p_recipient_entity_id END,
    counterparty_entity_id = CASE WHEN je.id = v_a THEN p_recipient_entity_id ELSE p_provider_entity_id END,
    is_intercompany = true,
    intercompany_group_id = v_group
  WHERE je.id IN (v_a, v_b) AND je.user_id = v_owner;

  PERFORM public._mer_audit(v_owner, p_provider_entity_id, 'intercompany_posted',
    jsonb_build_object(
      'group_id', v_group, 'provider', p_provider_entity_id, 'recipient', p_recipient_entity_id,
      'amount_cents', p_amount_cents, 'entry_date', p_entry_date
    ));

  RETURN v_group;
END;
$$;

-- =============================================================
-- REPORT: per-entity P&L rows with intercompany elimination
--
-- One row per (entity, revenue/expense account):
--   gross_cents         everything posted to that entity (its own books)
--   intercompany_cents  the part of gross_cents that comes from intercompany entries
--   eliminated_cents    the part removed in the combined view: intercompany lines
--                       whose counterparty is also inside the selected scope,
--                       and only when p_eliminate is true
-- Sign convention matches get_profit_and_loss(): revenue = credit - debit,
-- expense = debit - credit. Only posted entries count (same rule as the base report).
-- p_entity_ids NULL = every entity the caller can access.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_multi_entity_profit_and_loss(
  p_start date,
  p_end date,
  p_entity_ids uuid[] DEFAULT NULL,
  p_eliminate boolean DEFAULT true
)
RETURNS TABLE (
  entity_id uuid, entity_code text, entity_name text,
  account_code text, account_name text, type text,
  gross_cents bigint, intercompany_cents bigint, eliminated_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_default uuid;
  v_all uuid[];
  v_scope uuid[];
BEGIN
  v_owner := public._mer_require_billing();

  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;

  v_default := public._mer_ensure_default(v_owner);

  SELECT COALESCE(array_agg(e.id), ARRAY[]::uuid[]) INTO v_all
  FROM reporting_entities e
  WHERE e.user_id = v_owner AND public._mer_can_access_entity(e.id);

  IF p_entity_ids IS NULL THEN
    v_scope := v_all;
  ELSE
    IF NOT (p_entity_ids <@ v_all) THEN
      RAISE EXCEPTION 'You do not have access to one or more of the selected entities' USING ERRCODE = '42501';
    END IF;
    v_scope := p_entity_ids;
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      COALESCE(je.entity_id, v_default) AS eid,
      c.id AS cid,
      c.code AS acode,
      c.name AS aname,
      c.type AS atype,
      CASE WHEN c.type = 'revenue' THEN jl.credit_cents - jl.debit_cents
           ELSE jl.debit_cents - jl.credit_cents END AS amt,
      je.is_intercompany AS ic,
      (je.is_intercompany AND COALESCE(p_eliminate, true) AND COALESCE(je.counterparty_entity_id = ANY (v_scope), false)) AS elim
    FROM journal_entries je
    JOIN journal_lines jl ON jl.journal_entry_id = je.id
    JOIN chart_of_accounts c ON c.id = jl.account_id AND c.user_id = v_owner
    WHERE je.user_id = v_owner
      AND je.status = 'posted'
      AND je.entry_date BETWEEN p_start AND p_end
      AND c.type IN ('revenue', 'expense')
  )
  SELECT
    e.id, e.code, e.name, s.acode, s.aname, s.atype,
    COALESCE(sum(s.amt), 0)::bigint,
    COALESCE(sum(s.amt) FILTER (WHERE s.ic), 0)::bigint,
    COALESCE(sum(s.amt) FILTER (WHERE s.elim), 0)::bigint
  FROM scoped s
  JOIN reporting_entities e ON e.id = s.eid AND e.user_id = v_owner
  WHERE s.eid = ANY (v_scope)
  GROUP BY e.id, e.code, e.name, e.is_default, s.cid, s.acode, s.aname, s.atype
  ORDER BY e.is_default DESC, e.code, s.atype DESC, s.acode;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.ensure_default_reporting_entity() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_reporting_entities() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_reporting_entity(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_reporting_entity(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_reporting_entity_access_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_reporting_entity_access(uuid, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_journal_entries_for_entity(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assign_journal_entries_to_entity(uuid[], uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_intercompany_entry(date, text, uuid, uuid, integer, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_multi_entity_profit_and_loss(date, date, uuid[], boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.ensure_default_reporting_entity() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_reporting_entities() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_reporting_entity(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_reporting_entity(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reporting_entity_access_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_reporting_entity_access(uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_journal_entries_for_entity(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_journal_entries_to_entity(uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_intercompany_entry(date, text, uuid, uuid, integer, uuid, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_multi_entity_profit_and_loss(date, date, uuid[], boolean) TO authenticated;
