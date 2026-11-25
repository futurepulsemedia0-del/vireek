/*
# State Do-Not-Call registries: importable lists, per-account rules, scrub proof

## Why
`dnc_suppressions` only holds numbers that asked THIS business to stop. State (and federal) registries are separate
lists a business obtains from the registry operator under its own agreement. This migration lets an account IMPORT such a
list, attach per-jurisdiction rules, and keeps an append-only proof of every scrub done before an outbound call.
Nothing here talks to any registry: lists are uploaded files only. No registry name, fee, API, retention period or
legal threshold is assumed (TODO(owner) / TODO(counsel): see docs/compliance/state-dnc.md).

## New tables (all keyed by account_owner_id, same scoping as call_blocklist)
- dnc_registry_lists    one imported file = one list version (importing -> active -> superseded | failed)
- dnc_registry_entries  the numbers of a list (E.164). Composite FK keeps entries in the SAME tenant as their list.
- dnc_state_rules       per-jurisdiction rule overrides set by the account (purposes, max list age, list required)
- dnc_scrub_proofs      append-only record of each scrub (phone stored only as a salted SHA-256 + last 4 digits)

## New function
- dnc_registry_activate(list, expected_rows)  service_role only; atomic activation + supersede of the previous list.

## Safety
Additive only: no existing table, column, policy or trigger is changed. anon has no access. Authenticated users can only
READ their own account's rows (and manage dnc_state_rules) when public.blocklist_can_manage(); lists, entries and proofs are
written only by the dnc-registry-import / dial-path edge code using the service role.

## Rollback (data loss: imported lists and proofs)
  DROP FUNCTION IF EXISTS public.dnc_registry_activate(uuid, integer);
  DROP TABLE IF EXISTS public.dnc_scrub_proofs, public.dnc_registry_entries, public.dnc_state_rules, public.dnc_registry_lists CASCADE;
Rolling the CODE back first (STATE_DNC_GATE_MODE=shadow, or remove the scrub calls) is enough to stop any call being held.

## Requires (already in your project)
public.get_account_owner_id(), public.blocklist_can_manage() (20270503000000_call_blocklist.sql), profiles(id).
*/

-- ---------------------------------------------------------------------------
-- dnc_registry_lists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dnc_registry_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- 'US' = national/federal list; 'US-TX' = one state's list. Free choice of the importer: nothing assumes a registry exists.
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^US(-[A-Z]{2})?$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  source_label text CHECK (source_label IS NULL OR char_length(source_label) <= 200),
  version_label text CHECK (version_label IS NULL OR char_length(version_label) <= 80),
  effective_date date,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'importing' CHECK (status IN ('importing', 'active', 'superseded', 'failed')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_owner_id)
);
CREATE INDEX IF NOT EXISTS idx_dnc_registry_lists_owner ON public.dnc_registry_lists (account_owner_id, jurisdiction, status);
-- At most ONE active list per account and jurisdiction: activation supersedes the previous one in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS ux_dnc_registry_lists_one_active
  ON public.dnc_registry_lists (account_owner_id, jurisdiction) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- dnc_registry_entries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dnc_registry_entries (
  list_id uuid NOT NULL,
  account_owner_id uuid NOT NULL,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  PRIMARY KEY (list_id, phone_e164),
  FOREIGN KEY (list_id, account_owner_id) REFERENCES public.dnc_registry_lists (id, account_owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dnc_registry_entries_lookup ON public.dnc_registry_entries (account_owner_id, phone_e164);

-- ---------------------------------------------------------------------------
-- dnc_state_rules (per account, per jurisdiction; absence = strictest defaults in stateDnc/decide.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dnc_state_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^US(-[A-Z]{2})?$'),
  applies_to_purposes text[] NOT NULL DEFAULT ARRAY['marketing', 'service']::text[]
    CHECK (applies_to_purposes <@ ARRAY['marketing', 'service', 'emergency']::text[]),
  max_age_days integer CHECK (max_age_days IS NULL OR max_age_days BETWEEN 1 AND 3650),
  require_active_list boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, jurisdiction)
);

-- ---------------------------------------------------------------------------
-- dnc_scrub_proofs (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dnc_scrub_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone_sha256 text NOT NULL CHECK (phone_sha256 ~ '^[0-9a-f]{64}$'),
  phone_last4 text NOT NULL CHECK (phone_last4 ~ '^[0-9]{1,4}$'),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 60),
  purpose text NOT NULL CHECK (purpose IN ('marketing', 'service', 'emergency')),
  correlation_id text CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 120),
  resolved_state text CHECK (resolved_state IS NULL OR resolved_state ~ '^[A-Z]{2}$'),
  residency_basis text NOT NULL CHECK (residency_basis IN ('explicit', 'address', 'phone', 'unknown')),
  gate_mode text NOT NULL CHECK (gate_mode IN ('shadow', 'enforce')),
  decision text NOT NULL CHECK (decision IN (
    'clear', 'suppressed', 'blocked_no_list', 'blocked_stale_list', 'blocked_unavailable', 'blocked_invalid_number')),
  reason_code text NOT NULL CHECK (char_length(reason_code) <= 60),
  would_block boolean NOT NULL,
  internal_dnc_hit boolean NOT NULL DEFAULT false,
  matched_list_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  lists jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lists) = 'array'),
  rules_version text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dnc_scrub_proofs_owner_time ON public.dnc_scrub_proofs (account_owner_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_dnc_scrub_proofs_phone ON public.dnc_scrub_proofs (account_owner_id, phone_sha256, checked_at DESC);

-- Proofs are never edited. (DELETE stays possible for the retention sweep and for account deletion via ON DELETE CASCADE.)
CREATE OR REPLACE FUNCTION public.dnc_scrub_proofs_no_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dnc_scrub_proofs rows are append-only' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS trg_dnc_scrub_proofs_no_update ON public.dnc_scrub_proofs;
CREATE TRIGGER trg_dnc_scrub_proofs_no_update BEFORE UPDATE ON public.dnc_scrub_proofs
  FOR EACH ROW EXECUTE FUNCTION public.dnc_scrub_proofs_no_update();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.dnc_registry_lists   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dnc_registry_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dnc_state_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dnc_scrub_proofs     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  scope text := 'account_owner_id = public.get_account_owner_id() AND public.blocklist_can_manage()';
BEGIN
  -- read-only for the account (writes: service role only)
  FOREACH t IN ARRAY ARRAY['dnc_registry_lists', 'dnc_registry_entries', 'dnc_scrub_proofs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT TO authenticated USING (%2$s)', t, scope);
    EXECUTE format('REVOKE ALL ON public.%1$s FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%1$s FROM authenticated', t);
  END LOOP;

  -- rules: the account manages its own rows
  EXECUTE 'DROP POLICY IF EXISTS "dnc_state_rules_select" ON public.dnc_state_rules';
  EXECUTE format('CREATE POLICY "dnc_state_rules_select" ON public.dnc_state_rules FOR SELECT TO authenticated USING (%s)', scope);
  EXECUTE 'DROP POLICY IF EXISTS "dnc_state_rules_insert" ON public.dnc_state_rules';
  EXECUTE format('CREATE POLICY "dnc_state_rules_insert" ON public.dnc_state_rules FOR INSERT TO authenticated WITH CHECK (%s)', scope);
  EXECUTE 'DROP POLICY IF EXISTS "dnc_state_rules_update" ON public.dnc_state_rules';
  EXECUTE format('CREATE POLICY "dnc_state_rules_update" ON public.dnc_state_rules FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', scope);
  EXECUTE 'DROP POLICY IF EXISTS "dnc_state_rules_delete" ON public.dnc_state_rules';
  EXECUTE format('CREATE POLICY "dnc_state_rules_delete" ON public.dnc_state_rules FOR DELETE TO authenticated USING (%s)', scope);
  EXECUTE 'REVOKE ALL ON public.dnc_state_rules FROM anon';
END $$;

-- ---------------------------------------------------------------------------
-- Atomic activation (service_role only; the edge function authorizes the human first)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dnc_registry_activate(p_list uuid, p_expected_rows integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.dnc_registry_lists%ROWTYPE;
  n integer;
  h text;
  max_rows constant integer := 2000000;
BEGIN
  SELECT * INTO l FROM public.dnc_registry_lists WHERE id = p_list FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'list_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF l.status <> 'importing' THEN RAISE EXCEPTION 'list_not_importing' USING ERRCODE = 'check_violation'; END IF;

  SELECT count(*) INTO n FROM public.dnc_registry_entries WHERE list_id = p_list;
  IF n = 0 THEN RAISE EXCEPTION 'list_empty' USING ERRCODE = 'check_violation'; END IF;
  IF n > max_rows THEN RAISE EXCEPTION 'list_too_large' USING ERRCODE = 'check_violation'; END IF;
  IF p_expected_rows IS NOT NULL AND p_expected_rows <> n THEN
    RAISE EXCEPTION 'row_count_mismatch' USING ERRCODE = 'check_violation';
  END IF;

  -- Order-independent content fingerprint: sha256 of the sorted numbers.
  SELECT encode(sha256(convert_to(string_agg(phone_e164, ',' ORDER BY phone_e164), 'UTF8')), 'hex') INTO h
    FROM public.dnc_registry_entries WHERE list_id = p_list;

  UPDATE public.dnc_registry_lists SET status = 'superseded'
   WHERE account_owner_id = l.account_owner_id AND jurisdiction = l.jurisdiction AND status = 'active' AND id <> p_list;

  UPDATE public.dnc_registry_lists
     SET status = 'active', row_count = n, content_sha256 = h, activated_at = now()
   WHERE id = p_list;

  RETURN jsonb_build_object('list_id', p_list, 'row_count', n, 'content_sha256', h, 'jurisdiction', l.jurisdiction);
END;
$$;

REVOKE ALL ON FUNCTION public.dnc_registry_activate(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dnc_registry_activate(uuid, integer) TO service_role;
