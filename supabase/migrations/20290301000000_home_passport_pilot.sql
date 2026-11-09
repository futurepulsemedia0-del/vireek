/*
  # Home Service Passport — PILOT (flag OFF)

  Extends (does NOT replace) the two existing passport layers:
    - 20270210000000_home_service_passport.sql          : manager-issued sealed links (home_passport_transfers)
    - 20270410000000_universal_home_passport_network.sql: property-level hash-chained network

  ## What this migration fixes in existing work (ALWAYS ON, no flag)
  1. `verify_home_passport(text)` was defined twice with the same signature. The 20270410 definition silently
     replaced the 20270210 one, so the sealed-link RPC called by src/lib/homeServicePassport.ts
     (`{ p_token }`) no longer existed. Restored here; the network public view is renamed
     `verify_home_passport_code(text)` (route /h/:code).
  2. Public verification now has abuse protection (failed-lookup + per-link view throttling).

  ## New capability (everything below is gated by feature flag `home_passport_pilot`, default OFF,
  ##   enabled per account with a feature_flag_overrides row = per-account entitlement)
  - home_passport_pilot_settings     : contractor opt-in + company-name visibility (default: opted OUT)
  - home_passport_snapshots          : versioned, immutable, SHA-256 sealed, hash-linked per customer
  - home_passport_share_links        : expiring, view-capped, revocable links (token hash only)
  - home_passport_ownership_transfers: sale hand-over with explicit, recorded current-owner consent
  - home_passport_pilot_audit        : append-only audit (no PII) that also feeds the pilot metrics
  - home_passport_pilot_hits         : throttle counters (no PII; client key is a salted-per-day hash)

  ## Redaction rules (enforced server-side, then re-verified by a forbidden-key scan that FAILS CLOSED)
  - Never exported: customer name/phone/email, technician names, prices/amounts/costs paid, internal notes,
    retailer, purchase price. There is no "approve to include prices" path in this pilot: prices are excluded
    by construction.
  - Address: city/state only unless the manager explicitly chooses 'full' for that snapshot.
  - Company name: only if the account opted in AND chose to show it.
  - Predictions: cost = low/high ranges (rounded outward to 50) + assumptions + disclaimer, never a point value;
    maintenance = date WINDOWS; remaining-life point values are removed.
  - Verification levels: contractor_verified | contractor_recorded | owner_added.

  ## REQUIRES COUNSEL (not asserted by this code): consent wording (see consent_text_version), jurisdictional
  ## privacy rules (GDPR/CCPA etc.), retention of immutable snapshots vs. erasure requests, disclaimer wording.

  Depends on: feature_flags (20270411000100), home_service_passport (20270210000000),
  universal_home_passport_network (20270410000000), home_lifetime_graph (home_ownership_periods),
  customer_home_inventory (home_inventory_items), identity_is_manager().

  -- rollback: DROP the objects created here in reverse order (functions hpp_*/create_home_passport_*/
  -- request_home_ownership_transfer/..., tables home_passport_pilot_hits, home_passport_pilot_audit,
  -- home_passport_ownership_transfers, home_passport_share_links, home_passport_snapshots,
  -- home_passport_pilot_settings; DELETE FROM feature_flags WHERE key='home_passport_pilot'). Do NOT roll back
  -- the verify_home_passport fix unless you also fix the callers: reverting re-breaks the sealed-link page.
*/

-- =============================================================
-- 0. FEATURE FLAG (default OFF, rollout 0%) + per-account gate
-- =============================================================

INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('home_passport_pilot', 'Home Service Passport pilot',
        'Versioned snapshots, expiring share links/QR, ownership transfer with owner consent, contractor opt-in redaction, pilot metrics.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.home_passport_pilot_enabled(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_tenant, f.key)
    FROM public.feature_flags f
    LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
    WHERE f.key = 'home_passport_pilot'
  ), false);
$$;

REVOKE ALL ON FUNCTION public.home_passport_pilot_enabled(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.home_passport_pilot_enabled(uuid) TO authenticated, service_role;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.home_passport_pilot_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  contributor_opt_in boolean NOT NULL DEFAULT false,
  show_company_name boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (contributor_opt_in OR NOT show_company_name)
);

CREATE TABLE IF NOT EXISTS public.home_passport_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  site_id uuid REFERENCES public.customer_sites(id) ON DELETE SET NULL,
  version integer NOT NULL CHECK (version >= 1),
  purpose text NOT NULL DEFAULT 'share' CHECK (purpose IN ('share', 'ownership_transfer')),
  schema_id text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 2000000),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  prev_snapshot_hash text CHECK (prev_snapshot_hash IS NULL OR prev_snapshot_hash ~ '^[0-9a-f]{64}$'),
  redaction jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, customer_id, version)
);
CREATE INDEX IF NOT EXISTS idx_hpp_snapshots_customer ON public.home_passport_snapshots (account_owner_id, customer_id, version DESC);

CREATE TABLE IF NOT EXISTS public.home_passport_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES public.home_passport_snapshots(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  recipient_type text NOT NULL CHECK (recipient_type IN ('buyer', 'agent', 'inspector', 'insurer', 'lender', 'owner')),
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  expires_at timestamptz NOT NULL,
  max_views integer NOT NULL DEFAULT 100 CHECK (max_views BETWEEN 1 AND 1000),
  view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  consent_confirmed_at timestamptz NOT NULL,
  consent_text_version text NOT NULL CHECK (char_length(btrim(consent_text_version)) BETWEEN 1 AND 40),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hpp_links_snapshot ON public.home_passport_share_links (snapshot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hpp_links_owner ON public.home_passport_share_links (account_owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.home_passport_ownership_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.customer_sites(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.home_passport_snapshots(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  consent_method text NOT NULL CHECK (consent_method IN ('owner_in_person', 'owner_written', 'owner_electronic')),
  consent_text_version text NOT NULL CHECK (char_length(btrim(consent_text_version)) BETWEEN 1 AND 40),
  consent_confirmed_at timestamptz NOT NULL DEFAULT now(),
  consent_confirmed_by uuid,
  closing_date date,
  expires_at timestamptz NOT NULL,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  CHECK (status = 'pending' OR resolved_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hpp_transfer_pending_site
  ON public.home_passport_ownership_transfers (site_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_hpp_transfers_owner ON public.home_passport_ownership_transfers (account_owner_id, created_at DESC);

-- Audit: deliberately NO foreign keys (the trail must outlive account/customer deletion) and NO PII in detail.
CREATE TABLE IF NOT EXISTS public.home_passport_pilot_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_owner_id uuid NOT NULL,
  actor_user_id uuid,
  action text NOT NULL CHECK (action IN (
    'settings_changed', 'snapshot_created', 'share_created', 'share_viewed', 'share_revoked',
    'transfer_requested', 'transfer_completed', 'transfer_cancelled'
  )),
  subject_type text NOT NULL CHECK (subject_type IN ('settings', 'snapshot', 'share_link', 'ownership_transfer')),
  subject_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hpp_audit_owner ON public.home_passport_pilot_audit (account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hpp_audit_subject ON public.home_passport_pilot_audit (subject_id, action, created_at DESC);

CREATE TABLE IF NOT EXISTS public.home_passport_pilot_hits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL CHECK (char_length(bucket) <= 80),
  kind text NOT NULL CHECK (kind IN ('fail', 'view')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hpp_hits_lookup ON public.home_passport_pilot_hits (bucket, kind, created_at DESC);

-- =============================================================
-- 2. IMMUTABILITY GUARDS
-- =============================================================

CREATE OR REPLACE FUNCTION public.hpp_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HPP_IMMUTABLE: this record is append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_hpp_audit_block ON public.home_passport_pilot_audit;
CREATE TRIGGER trg_hpp_audit_block BEFORE UPDATE OR DELETE ON public.home_passport_pilot_audit
  FOR EACH ROW EXECUTE FUNCTION public.hpp_block_mutation();
DROP TRIGGER IF EXISTS trg_hpp_audit_block_truncate ON public.home_passport_pilot_audit;
CREATE TRIGGER trg_hpp_audit_block_truncate BEFORE TRUNCATE ON public.home_passport_pilot_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.hpp_block_mutation();

-- Snapshot CONTENT can never change. Deletion is possible only through account/customer erasure (FK cascade);
-- no client role holds DELETE.
CREATE OR REPLACE FUNCTION public.hpp_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HPP_IMMUTABLE: issued snapshots cannot be modified; create a new version' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_hpp_snapshot_guard ON public.home_passport_snapshots;
CREATE TRIGGER trg_hpp_snapshot_guard BEFORE UPDATE ON public.home_passport_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.hpp_snapshot_guard();

-- Share links: only view counters and a one-way revoke may change.
CREATE OR REPLACE FUNCTION public.hpp_link_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.recipient_type IS DISTINCT FROM OLD.recipient_type
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.max_views IS DISTINCT FROM OLD.max_views
     OR NEW.consent_confirmed_at IS DISTINCT FROM OLD.consent_confirmed_at
     OR NEW.consent_text_version IS DISTINCT FROM OLD.consent_text_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HPP_IMMUTABLE: share link terms cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'HPP_IMMUTABLE: link is already revoked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hpp_link_guard ON public.home_passport_share_links;
CREATE TRIGGER trg_hpp_link_guard BEFORE UPDATE ON public.home_passport_share_links
  FOR EACH ROW EXECUTE FUNCTION public.hpp_link_guard();

-- Ownership transfers: consent record is frozen; only pending -> completed/cancelled once.
CREATE OR REPLACE FUNCTION public.hpp_transfer_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'HPP_IMMUTABLE: this transfer is already resolved' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.consent_method IS DISTINCT FROM OLD.consent_method
     OR NEW.consent_text_version IS DISTINCT FROM OLD.consent_text_version
     OR NEW.consent_confirmed_at IS DISTINCT FROM OLD.consent_confirmed_at
     OR NEW.consent_confirmed_by IS DISTINCT FROM OLD.consent_confirmed_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HPP_IMMUTABLE: consent record cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hpp_transfer_guard ON public.home_passport_ownership_transfers;
CREATE TRIGGER trg_hpp_transfer_guard BEFORE UPDATE ON public.home_passport_ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION public.hpp_transfer_guard();

-- =============================================================
-- 3. ROW LEVEL SECURITY (reads for managers of the owning account; ALL writes via RPC)
-- =============================================================

ALTER TABLE public.home_passport_pilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_ownership_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_pilot_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_pilot_hits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hpp_settings_select" ON public.home_passport_pilot_settings;
CREATE POLICY "hpp_settings_select" ON public.home_passport_pilot_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "hpp_snapshots_select" ON public.home_passport_snapshots;
CREATE POLICY "hpp_snapshots_select" ON public.home_passport_snapshots FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "hpp_transfers_select" ON public.home_passport_ownership_transfers;
CREATE POLICY "hpp_transfers_select" ON public.home_passport_ownership_transfers FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "hpp_audit_select" ON public.home_passport_pilot_audit;
CREATE POLICY "hpp_audit_select" ON public.home_passport_pilot_audit FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- share_links and hits: no client policy at all (RPC only; token hashes and throttle keys never leave the server).
REVOKE ALL ON public.home_passport_pilot_settings, public.home_passport_snapshots, public.home_passport_share_links,
  public.home_passport_ownership_transfers, public.home_passport_pilot_audit, public.home_passport_pilot_hits FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.home_passport_pilot_settings, public.home_passport_snapshots,
  public.home_passport_ownership_transfers, public.home_passport_pilot_audit FROM authenticated;
REVOKE ALL ON public.home_passport_share_links, public.home_passport_pilot_hits FROM authenticated;
GRANT ALL ON public.home_passport_pilot_settings, public.home_passport_snapshots, public.home_passport_share_links,
  public.home_passport_ownership_transfers, public.home_passport_pilot_audit, public.home_passport_pilot_hits TO service_role;

-- =============================================================
-- 4. INTERNAL HELPERS (never callable from the browser)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hpp_require_manager()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'HPP_UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'HPP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'HPP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT public.home_passport_pilot_enabled(v_owner) THEN
    RAISE EXCEPTION 'HPP_DISABLED' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.hpp_audit(
  p_owner uuid, p_actor uuid, p_action text, p_subject_type text, p_subject_id uuid, p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.home_passport_pilot_audit (account_owner_id, actor_user_id, action, subject_type, subject_id, detail)
  VALUES (p_owner, p_actor, p_action, p_subject_type, p_subject_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- Salted-per-day hash of the caller's IP (from the PostgREST forwarded header). Never the raw address.
CREATE OR REPLACE FUNCTION public.hpp_client_key()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip text;
BEGIN
  BEGIN
    v_ip := split_part(coalesce((nullif(current_setting('request.headers', true), '')::json) ->> 'x-forwarded-for', ''), ',', 1);
  EXCEPTION WHEN OTHERS THEN
    v_ip := '';
  END;
  RETURN left(encode(sha256(convert_to(coalesce(nullif(btrim(v_ip), ''), 'unknown') || ':' || current_date::text, 'UTF8')), 'hex'), 32);
END;
$$;

-- Record one hit and return how many hits this bucket/kind has inside the window (including this one).
CREATE OR REPLACE FUNCTION public.hpp_hit(p_bucket text, p_kind text, p_window interval)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.home_passport_pilot_hits (bucket, kind) VALUES (left(p_bucket, 80), p_kind);
  SELECT count(*)::integer INTO v_n FROM public.home_passport_pilot_hits
  WHERE bucket = left(p_bucket, 80) AND kind = p_kind AND created_at > now() - p_window;
  RETURN v_n;
END;
$$;

-- Housekeeping for the throttle table. Schedule from pg_cron / an edge cron (service role only).
CREATE OR REPLACE FUNCTION public.hpp_purge_hits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.home_passport_pilot_hits WHERE created_at < now() - interval '2 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.hpp_range_disclaimer()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- REQUIRES COUNSEL: final wording.
  SELECT 'Estimates only. Ranges are modelled from equipment age, typical service life and the assumptions listed. They are not a quote, appraisal, inspection or guarantee, and actual needs and costs can differ.'::text;
$$;

-- Deep-ish scan: any JSON KEY (not value) that names a forbidden concept. Used as a fail-closed guard.
CREATE OR REPLACE FUNCTION public.hpp_find_forbidden_keys(p jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}'::text[])
  FROM regexp_matches(
    coalesce(p::text, ''),
    '"(customer_name|customer_phone|customer_email|customer_address|phone|email|price|price_cents|purchase_price_cents|amount|total_cents|cost|cost_cents|invoice|invoice_total|margin|technician|technician_name|notes|retailer)"\s*:',
    'g'
  ) AS m;
$$;

-- Cost RANGE only. Rejects anything without assumptions or with a degenerate (point) range.
CREATE OR REPLACE FUNCTION public.hpp_clean_ranges(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c jsonb;
  v_asm jsonb;
  a_lo numeric;
  a_hi numeric;
  f_lo numeric;
  f_hi numeric;
BEGIN
  c := public.home_passport_clean_projections(p);   -- validates numeric bounds; NULL when malformed
  IF c IS NULL THEN RETURN NULL; END IF;
  v_asm := coalesce(c -> 'assumptions', '[]'::jsonb);
  IF jsonb_array_length(v_asm) = 0 THEN RETURN NULL; END IF;   -- never show a range without its assumptions
  a_lo := (c ->> 'annualLow')::numeric;
  a_hi := (c ->> 'annualHigh')::numeric;
  f_lo := (c ->> 'fiveYearLow')::numeric;
  f_hi := (c ->> 'fiveYearHigh')::numeric;
  IF a_hi <= a_lo OR f_hi <= f_lo THEN RETURN NULL; END IF;     -- a "range" must have width
  RETURN jsonb_build_object(
    'model', c ->> 'model',
    'is_estimate', true,
    'annual_range', jsonb_build_object('low', floor(a_lo / 50) * 50, 'high', ceil(a_hi / 50) * 50),
    'five_year_range', jsonb_build_object('low', floor(f_lo / 50) * 50, 'high', ceil(f_hi / 50) * 50),
    'confidence', c ->> 'confidence',
    'assumptions', v_asm,
    'disclaimer', public.hpp_range_disclaimer()
  );
END;
$$;

-- Canonical v2 payload: v1 builder output, redacted + labelled + prediction-safe.
CREATE OR REPLACE FUNCTION public.hpp_build_payload(
  p_owner uuid, p_customer uuid, p_show_company boolean, p_address_level text, p_projections jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v1 jsonb;
  v_prop jsonb;
  v_equipment jsonb;
  v_history jsonb;
  v_owner_items jsonb;
  v_windows jsonb;
  v_summary jsonb;
BEGIN
  v1 := public.build_home_passport_payload(p_owner, p_customer);

  v_prop := coalesce(v1 -> 'property', '{}'::jsonb);
  IF p_address_level <> 'full' THEN
    v_prop := v_prop - 'address' - 'postal_code';
  END IF;

  -- Equipment: contractor-recorded; the point prediction "remaining_years" is removed (see windows below).
  SELECT coalesce(jsonb_agg((e.item - 'remaining_years') || jsonb_build_object('verification', 'contractor_recorded') ORDER BY e.ord), '[]'::jsonb)
  INTO v_equipment
  FROM jsonb_array_elements(coalesce(v1 -> 'equipment', '[]'::jsonb)) WITH ORDINALITY AS e(item, ord);

  SELECT coalesce(jsonb_agg(h.item || jsonb_build_object('verification',
           CASE WHEN coalesce((h.item ->> 'evidence_verified')::boolean, false) THEN 'contractor_verified' ELSE 'contractor_recorded' END)
           ORDER BY h.ord), '[]'::jsonb)
  INTO v_history
  FROM jsonb_array_elements(coalesce(v1 -> 'service_history', '[]'::jsonb)) WITH ORDINALITY AS h(item, ord);

  -- Owner-added items: whitelist only. NEVER price, retailer, serial, location, notes.
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'category', i.category, 'name', i.name, 'brand', i.brand, 'model', i.model,
           'purchase_date', i.purchase_date, 'warranty_expires_at', i.warranty_expires_at,
           'verification', 'owner_added')) ORDER BY i.created_at), '[]'::jsonb)
  INTO v_owner_items
  FROM (
    SELECT * FROM public.home_inventory_items
    WHERE user_id = p_owner AND customer_id = p_customer
    ORDER BY created_at LIMIT 100
  ) i;

  -- Maintenance predictions as WINDOWS (-30 / +60 days around the scheduled date), never a single date.
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'equipment', m.item ->> 'equipment',
           'overdue', coalesce((m.item ->> 'overdue')::boolean, false),
           'service_window_from', CASE WHEN nullif(m.item ->> 'next_due', '') IS NOT NULL THEN (m.item ->> 'next_due')::date - 30 END,
           'service_window_to',   CASE WHEN nullif(m.item ->> 'next_due', '') IS NOT NULL THEN (m.item ->> 'next_due')::date + 60 END,
           'issue_window_from',   CASE WHEN nullif(m.item ->> 'predicted_issue_due', '') IS NOT NULL THEN (m.item ->> 'predicted_issue_due')::date - 30 END,
           'issue_window_to',     CASE WHEN nullif(m.item ->> 'predicted_issue_due', '') IS NOT NULL THEN (m.item ->> 'predicted_issue_due')::date + 60 END,
           'is_estimate', true)) ORDER BY m.ord), '[]'::jsonb)
  INTO v_windows
  FROM jsonb_array_elements(coalesce(v1 -> 'predicted_maintenance', '[]'::jsonb)) WITH ORDINALITY AS m(item, ord);

  v_summary := coalesce(v1 -> 'summary', '{}'::jsonb) - 'avg_remaining_years';

  RETURN jsonb_build_object(
    'schema', 'vireek.home_passport.v2',
    'generated_at', now(),
    'serviced_by', CASE WHEN p_show_company THEN coalesce(v1 -> 'serviced_by', 'null'::jsonb) ELSE 'null'::jsonb END,
    'property', v_prop,
    'summary', v_summary,
    'health', coalesce(v1 -> 'health', 'null'::jsonb),
    'equipment', v_equipment,
    'owner_added_items', v_owner_items,
    'service_history', v_history,
    'permits', coalesce(v1 -> 'permits', '[]'::jsonb),
    'known_problems', coalesce(v1 -> 'known_problems', '[]'::jsonb),
    'maintenance_windows', v_windows,
    'cost_ranges', public.hpp_clean_ranges(p_projections),
    'prediction_notes', jsonb_build_array(
      'Maintenance windows run from 30 days before to 60 days after the scheduled date; actual need may fall outside them.',
      'Remaining-life point values are intentionally not shown.'),
    'verification_levels', jsonb_build_object(
      'contractor_verified', 'Recorded by the service company and backed by verified job evidence.',
      'contractor_recorded', 'Recorded by the service company without verified evidence.',
      'owner_added', 'Entered by the homeowner; not verified by Vireek or a contractor.'),
    'redaction', jsonb_build_object(
      'address_level', p_address_level,
      'company_name_shown', p_show_company,
      'customer_contact_details', 'excluded',
      'prices_and_amounts', 'excluded',
      'technician_names', 'excluded')
  );
END;
$$;

-- Create one immutable, hash-linked snapshot version. Internal: callers have already authorised.
CREATE OR REPLACE FUNCTION public.hpp_create_snapshot(
  p_owner uuid, p_actor uuid, p_customer uuid, p_site uuid, p_address_level text, p_projections jsonb, p_purpose text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.home_passport_pilot_settings;
  v_site uuid := p_site;
  v_version integer;
  v_prev text;
  v_payload jsonb;
  v_hash text;
  v_id uuid;
  v_bad text[];
  v_created timestamptz;
BEGIN
  IF p_address_level IS NULL OR p_address_level NOT IN ('city', 'full') THEN
    RAISE EXCEPTION 'HPP_INVALID: address level must be city or full' USING ERRCODE = 'P0001';
  END IF;
  IF p_purpose NOT IN ('share', 'ownership_transfer') THEN
    RAISE EXCEPTION 'HPP_INVALID: unknown purpose' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer AND c.user_id = p_owner) THEN
    RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_site IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customer_sites cs WHERE cs.id = v_site AND cs.user_id = p_owner AND cs.customer_id = p_customer
  ) THEN
    RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_site IS NULL THEN
    SELECT cs.id INTO v_site FROM public.customer_sites cs
    WHERE cs.customer_id = p_customer AND cs.user_id = p_owner
    ORDER BY cs.is_primary DESC, cs.created_at LIMIT 1;
  END IF;

  SELECT * INTO s FROM public.home_passport_pilot_settings WHERE account_owner_id = p_owner;
  IF NOT FOUND OR NOT s.contributor_opt_in THEN
    RAISE EXCEPTION 'HPP_OPT_IN_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  IF (SELECT count(*) FROM public.home_passport_snapshots
      WHERE account_owner_id = p_owner AND created_at > now() - interval '1 day') >= 30 THEN
    RAISE EXCEPTION 'HPP_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:hpp:snapshot:' || p_owner::text || ':' || p_customer::text, 0));

  SELECT x.version, x.snapshot_hash INTO v_version, v_prev
  FROM public.home_passport_snapshots x
  WHERE x.account_owner_id = p_owner AND x.customer_id = p_customer
  ORDER BY x.version DESC LIMIT 1;
  v_version := coalesce(v_version, 0) + 1;

  v_payload := public.hpp_build_payload(p_owner, p_customer, s.show_company_name, p_address_level, p_projections);

  v_bad := public.hpp_find_forbidden_keys(v_payload);
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'HPP_REDACTION_FAILED: forbidden fields present (%)', array_to_string(v_bad, ',') USING ERRCODE = 'P0001';
  END IF;

  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');

  INSERT INTO public.home_passport_snapshots
    (account_owner_id, customer_id, site_id, version, purpose, schema_id, snapshot, snapshot_hash, prev_snapshot_hash, redaction, created_by)
  VALUES
    (p_owner, p_customer, v_site, v_version, p_purpose, 'vireek.home_passport.v2', v_payload, v_hash, v_prev,
     v_payload -> 'redaction', p_actor)
  RETURNING id, created_at INTO v_id, v_created;

  PERFORM public.hpp_audit(p_owner, p_actor, 'snapshot_created', 'snapshot', v_id,
    jsonb_build_object('version', v_version, 'purpose', p_purpose, 'address_level', p_address_level,
                       'has_cost_ranges', (v_payload -> 'cost_ranges') IS DISTINCT FROM 'null'::jsonb AND (v_payload -> 'cost_ranges') IS NOT NULL));

  RETURN jsonb_build_object('snapshot_id', v_id, 'version', v_version, 'snapshot_hash', v_hash,
                            'created_at', v_created, 'site_id', v_site);
END;
$$;

-- =============================================================
-- 5. CLIENT RPCs — settings / snapshots / shares (manager + flag required unless noted)
-- =============================================================

-- Callable while the flag is OFF so the UI can decide what to render. Returns only the caller's own state.
CREATE OR REPLACE FUNCTION public.get_home_passport_pilot_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s public.home_passport_pilot_settings;
  v_on boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;
  v_on := public.home_passport_pilot_enabled(v_owner);
  IF NOT v_on OR NOT public.identity_is_manager() THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;
  SELECT * INTO s FROM public.home_passport_pilot_settings WHERE account_owner_id = v_owner;
  RETURN jsonb_build_object(
    'enabled', true,
    'contributor_opt_in', coalesce(s.contributor_opt_in, false),
    'show_company_name', coalesce(s.show_company_name, false));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_home_passport_pilot_settings(p_opt_in boolean, p_show_company boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  v_opt boolean := coalesce(p_opt_in, false);
  v_show boolean := coalesce(p_show_company, false) AND coalesce(p_opt_in, false);
  v_revoked integer := 0;
BEGIN
  INSERT INTO public.home_passport_pilot_settings (account_owner_id, contributor_opt_in, show_company_name, updated_by)
  VALUES (v_owner, v_opt, v_show, auth.uid())
  ON CONFLICT (account_owner_id) DO UPDATE SET
    contributor_opt_in = EXCLUDED.contributor_opt_in,
    show_company_name = EXCLUDED.show_company_name,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  -- Withdrawing consent to contribute ends every live link immediately.
  IF NOT v_opt THEN
    UPDATE public.home_passport_share_links
    SET revoked_at = now(), revoked_by = auth.uid()
    WHERE account_owner_id = v_owner AND revoked_at IS NULL;
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
  END IF;

  PERFORM public.hpp_audit(v_owner, auth.uid(), 'settings_changed', 'settings', NULL,
    jsonb_build_object('opt_in', v_opt, 'show_company_name', v_show, 'links_revoked', v_revoked));
  RETURN jsonb_build_object('contributor_opt_in', v_opt, 'show_company_name', v_show, 'links_revoked', v_revoked);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_home_passport_snapshot(
  p_customer_id uuid,
  p_address_level text DEFAULT 'city',
  p_projections jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
BEGIN
  RETURN public.hpp_create_snapshot(v_owner, auth.uid(), p_customer_id, NULL, p_address_level, p_projections, 'share');
END;
$$;

CREATE OR REPLACE FUNCTION public.list_home_passport_snapshots(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'snapshot_id', s.id, 'version', s.version, 'purpose', s.purpose, 'snapshot_hash', s.snapshot_hash,
      'created_at', s.created_at, 'redaction', s.redaction,
      'active_links', (SELECT count(*) FROM public.home_passport_share_links l
                       WHERE l.snapshot_id = s.id AND l.revoked_at IS NULL AND l.expires_at > now() AND l.view_count < l.max_views)
    ) ORDER BY s.version DESC)
    FROM (SELECT * FROM public.home_passport_snapshots
          WHERE account_owner_id = v_owner AND customer_id = p_customer_id
          ORDER BY version DESC LIMIT 50) s
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_home_passport_share(
  p_snapshot_id uuid,
  p_recipient_type text DEFAULT 'buyer',
  p_label text DEFAULT NULL,
  p_valid_days integer DEFAULT 30,
  p_max_views integer DEFAULT 100,
  p_owner_consent boolean DEFAULT false,
  p_consent_text_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  snap public.home_passport_snapshots;
  s public.home_passport_pilot_settings;
  v_token text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF p_owner_consent IS DISTINCT FROM true OR char_length(btrim(coalesce(p_consent_text_version, ''))) = 0 THEN
    RAISE EXCEPTION 'HPP_CONSENT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_recipient_type IS NULL OR p_recipient_type NOT IN ('buyer', 'agent', 'inspector', 'insurer', 'lender', 'owner') THEN
    RAISE EXCEPTION 'HPP_INVALID: recipient type' USING ERRCODE = 'P0001';
  END IF;
  IF p_valid_days IS NULL OR p_valid_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'HPP_INVALID: expiry must be 1-90 days' USING ERRCODE = 'P0001';
  END IF;
  IF p_max_views IS NULL OR p_max_views NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'HPP_INVALID: max views must be 1-1000' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO snap FROM public.home_passport_snapshots WHERE id = p_snapshot_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO s FROM public.home_passport_pilot_settings WHERE account_owner_id = v_owner;
  IF NOT FOUND OR NOT s.contributor_opt_in THEN
    RAISE EXCEPTION 'HPP_OPT_IN_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  IF (SELECT count(*) FROM public.home_passport_share_links
      WHERE snapshot_id = snap.id AND revoked_at IS NULL AND expires_at > now()) >= 10
     OR (SELECT count(*) FROM public.home_passport_pilot_audit
         WHERE account_owner_id = v_owner AND action = 'share_created' AND created_at > now() - interval '1 day') >= 50 THEN
    RAISE EXCEPTION 'HPP_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_exp := now() + make_interval(days => p_valid_days);

  INSERT INTO public.home_passport_share_links
    (snapshot_id, account_owner_id, token_hash, recipient_type, label, expires_at, max_views,
     consent_confirmed_at, consent_text_version, created_by)
  VALUES
    (snap.id, v_owner, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_recipient_type,
     left(nullif(btrim(coalesce(p_label, '')), ''), 80), v_exp, p_max_views, now(), btrim(p_consent_text_version), auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.hpp_audit(v_owner, auth.uid(), 'share_created', 'share_link', v_id,
    jsonb_build_object('snapshot_id', snap.id, 'version', snap.version, 'recipient_type', p_recipient_type,
                       'expires_at', v_exp, 'max_views', p_max_views, 'consent_text_version', btrim(p_consent_text_version)));

  -- The plaintext token is returned exactly once; only its hash is stored.
  RETURN jsonb_build_object('link_id', v_id, 'token', v_token, 'expires_at', v_exp,
                            'snapshot_id', snap.id, 'version', snap.version);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_home_passport_shares(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'link_id', l.id, 'snapshot_id', s.id, 'version', s.version, 'recipient_type', l.recipient_type, 'label', l.label,
      'expires_at', l.expires_at, 'max_views', l.max_views, 'view_count', l.view_count, 'last_viewed_at', l.last_viewed_at,
      'revoked_at', l.revoked_at, 'created_at', l.created_at,
      'state', CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked'
                    WHEN l.expires_at <= now() THEN 'expired'
                    WHEN l.view_count >= l.max_views THEN 'exhausted'
                    ELSE 'active' END
    ) ORDER BY l.created_at DESC)
    FROM public.home_passport_share_links l
    JOIN public.home_passport_snapshots s ON s.id = l.snapshot_id
    WHERE l.account_owner_id = v_owner AND s.customer_id = p_customer_id
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_home_passport_share(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  l public.home_passport_share_links;
BEGIN
  SELECT * INTO l FROM public.home_passport_share_links WHERE id = p_link_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF l.revoked_at IS NOT NULL THEN RETURN; END IF;   -- idempotent
  UPDATE public.home_passport_share_links SET revoked_at = now(), revoked_by = auth.uid() WHERE id = l.id;
  PERFORM public.hpp_audit(v_owner, auth.uid(), 'share_revoked', 'share_link', l.id, jsonb_build_object('snapshot_id', l.snapshot_id));
END;
$$;

-- =============================================================
-- 6. PUBLIC VERIFICATION (anon) + abuse protection
-- =============================================================

-- New versioned share links:  /passport/share/:token
CREATE OR REPLACE FUNCTION public.verify_home_passport_share(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.home_passport_share_links;
  s public.home_passport_snapshots;
  v_hash text;
  v_status text;
  v_n integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    IF public.hpp_hit(public.hpp_client_key(), 'fail', interval '10 minutes') > 20 THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT * INTO l FROM public.home_passport_share_links WHERE token_hash = v_hash FOR UPDATE;
  IF NOT FOUND THEN
    IF public.hpp_hit(public.hpp_client_key(), 'fail', interval '10 minutes') > 20 THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO s FROM public.home_passport_snapshots WHERE id = l.snapshot_id;
  IF encode(sha256(convert_to(s.snapshot::text, 'UTF8')), 'hex') <> s.snapshot_hash THEN
    RETURN jsonb_build_object('status', 'tampered');
  END IF;

  v_status := CASE
    WHEN l.revoked_at IS NOT NULL THEN 'revoked'
    WHEN l.expires_at <= now() THEN 'expired'
    WHEN l.view_count >= l.max_views THEN 'exhausted'
    ELSE 'valid'
  END;

  IF v_status = 'valid' THEN
    v_n := public.hpp_hit('share:' || left(v_hash, 24), 'view', interval '1 hour');
    IF v_n > 120 THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    UPDATE public.home_passport_share_links SET view_count = view_count + 1, last_viewed_at = now() WHERE id = l.id;
    -- One audit row per link per hour keeps the append-only trail from being inflated by refreshes.
    IF NOT EXISTS (
      SELECT 1 FROM public.home_passport_pilot_audit a
      WHERE a.subject_id = l.id AND a.action = 'share_viewed' AND a.created_at > now() - interval '1 hour'
    ) THEN
      PERFORM public.hpp_audit(l.account_owner_id, NULL, 'share_viewed', 'share_link', l.id,
                               jsonb_build_object('version', s.version, 'recipient_type', l.recipient_type));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'issued_at', l.created_at,
    'expires_at', l.expires_at,
    'recipient_type', l.recipient_type,
    'version', s.version,
    'snapshot_hash', s.snapshot_hash,
    'snapshot', CASE WHEN v_status = 'valid' THEN s.snapshot ELSE NULL END
  );
END;
$$;

-- FIX: restore the sealed-link verifier that 20270410 overwrote (callers pass { p_token }).
-- Parameter names cannot change via CREATE OR REPLACE, so the colliding function is dropped first.
DROP FUNCTION IF EXISTS public.verify_home_passport(text);

CREATE FUNCTION public.verify_home_passport(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.home_passport_transfers%ROWTYPE;
  v_status text;
  v_hash text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    IF public.hpp_hit(public.hpp_client_key(), 'fail', interval '10 minutes') > 20 THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT * INTO v_row FROM public.home_passport_transfers WHERE token_hash = v_hash;
  IF NOT FOUND THEN
    IF public.hpp_hit(public.hpp_client_key(), 'fail', interval '10 minutes') > 20 THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF encode(sha256(convert_to(v_row.snapshot::text, 'UTF8')), 'hex') <> v_row.snapshot_hash THEN
    RETURN jsonb_build_object('status', 'tampered');
  END IF;

  v_status := CASE
    WHEN v_row.revoked_at IS NOT NULL THEN 'revoked'
    WHEN v_row.expires_at <= now() THEN 'expired'
    ELSE 'valid'
  END;

  IF v_status = 'valid' THEN
    IF public.hpp_hit('legacy:' || left(v_hash, 24), 'view', interval '1 hour') > 120 THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    UPDATE public.home_passport_transfers
    SET view_count = view_count + 1, last_viewed_at = now()
    WHERE id = v_row.id;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'issued_at', v_row.issued_at,
    'expires_at', v_row.expires_at,
    'recipient_type', v_row.recipient_type,
    'snapshot_hash', v_row.snapshot_hash,
    'snapshot', CASE WHEN v_status = 'valid' THEN v_row.snapshot ELSE NULL END
  );
END;
$$;

-- RENAMED network public (QR) view: identity, trust counts and chain integrity only. Route /h/:code
CREATE OR REPLACE FUNCTION public.verify_home_passport_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_code IS NULL OR char_length(p_code) > 40 THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN
    IF public.hpp_hit(public.hpp_client_key(), 'fail', interval '10 minutes') > 20 THEN
      RETURN jsonb_build_object('found', false, 'rate_limited', true);
    END IF;
    RETURN jsonb_build_object('found', false);
  END IF;
  RETURN public.hp_passport_json(v_id, false, NULL);
END;
$$;

-- =============================================================
-- 7. OWNERSHIP TRANSFER AT SALE (explicit, recorded current-owner consent)
-- =============================================================

CREATE OR REPLACE FUNCTION public.request_home_ownership_transfer(
  p_customer_id uuid,
  p_site_id uuid,
  p_consent_method text,
  p_consent_text_version text,
  p_valid_days integer DEFAULT 30,
  p_address_level text DEFAULT 'city',
  p_projections jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  v_snap jsonb;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF p_consent_method IS NULL OR p_consent_method NOT IN ('owner_in_person', 'owner_written', 'owner_electronic')
     OR char_length(btrim(coalesce(p_consent_text_version, ''))) = 0 THEN
    RAISE EXCEPTION 'HPP_CONSENT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_valid_days IS NULL OR p_valid_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'HPP_INVALID: validity must be 1-90 days' USING ERRCODE = 'P0001';
  END IF;
  IF p_site_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.customer_sites cs WHERE cs.id = p_site_id AND cs.user_id = v_owner AND cs.customer_id = p_customer_id
  ) THEN
    RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Expired pending requests free the one-pending-per-site slot.
  UPDATE public.home_passport_ownership_transfers
  SET status = 'cancelled', resolved_at = now(), resolved_by = NULL
  WHERE site_id = p_site_id AND account_owner_id = v_owner AND status = 'pending' AND expires_at <= now();

  IF EXISTS (SELECT 1 FROM public.home_passport_ownership_transfers
             WHERE site_id = p_site_id AND account_owner_id = v_owner AND status = 'pending') THEN
    RAISE EXCEPTION 'HPP_CONFLICT: a transfer is already pending for this property' USING ERRCODE = 'P0001';
  END IF;

  v_snap := public.hpp_create_snapshot(v_owner, auth.uid(), p_customer_id, p_site_id, p_address_level, p_projections, 'ownership_transfer');
  v_exp := now() + make_interval(days => p_valid_days);

  INSERT INTO public.home_passport_ownership_transfers
    (account_owner_id, customer_id, site_id, snapshot_id, consent_method, consent_text_version,
     consent_confirmed_by, expires_at, requested_by)
  VALUES
    (v_owner, p_customer_id, p_site_id, (v_snap ->> 'snapshot_id')::uuid, p_consent_method, btrim(p_consent_text_version),
     auth.uid(), v_exp, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.hpp_audit(v_owner, auth.uid(), 'transfer_requested', 'ownership_transfer', v_id,
    jsonb_build_object('snapshot_id', v_snap ->> 'snapshot_id', 'version', v_snap -> 'version',
                       'consent_method', p_consent_method, 'consent_text_version', btrim(p_consent_text_version),
                       'expires_at', v_exp));

  RETURN jsonb_build_object('transfer_id', v_id, 'snapshot_id', v_snap -> 'snapshot_id', 'version', v_snap -> 'version',
                            'expires_at', v_exp);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_home_ownership_transfer(p_transfer_id uuid, p_closing_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  t public.home_passport_ownership_transfers;
  per public.home_ownership_periods;
  v_close date := coalesce(p_closing_date, current_date);
  v_revoked integer := 0;
BEGIN
  SELECT * INTO t FROM public.home_passport_ownership_transfers
  WHERE id = p_transfer_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'pending' THEN RAISE EXCEPTION 'HPP_CONFLICT: transfer is not pending' USING ERRCODE = 'P0001'; END IF;
  IF t.expires_at <= now() THEN RAISE EXCEPTION 'HPP_EXPIRED' USING ERRCODE = 'P0001'; END IF;
  IF v_close > current_date THEN RAISE EXCEPTION 'HPP_INVALID: closing date cannot be in the future' USING ERRCODE = 'P0001'; END IF;

  -- End the seller's period (the unique "one open period per site" index requires this to come first).
  SELECT * INTO per FROM public.home_ownership_periods
  WHERE site_id = t.site_id AND user_id = v_owner AND ended_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF v_close < per.started_at THEN
      RAISE EXCEPTION 'HPP_INVALID: closing date is before the current ownership began' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.home_ownership_periods SET ended_at = v_close WHERE id = per.id;
  END IF;

  -- The buyer's period carries no customer link and no name. (The existing trigger also appends a
  -- name-free ownership_change event to the property's hash-chained history.)
  INSERT INTO public.home_ownership_periods (user_id, site_id, customer_id, started_at, transfer_reason)
  VALUES (v_owner, t.site_id, NULL, v_close, 'sale');

  -- Seller-era share links end at the sale; links on the hand-over snapshot itself stay valid for the buyer side.
  UPDATE public.home_passport_share_links l
  SET revoked_at = now(), revoked_by = auth.uid()
  WHERE l.account_owner_id = v_owner AND l.revoked_at IS NULL AND l.snapshot_id <> t.snapshot_id
    AND l.snapshot_id IN (SELECT s.id FROM public.home_passport_snapshots s
                          WHERE s.account_owner_id = v_owner AND s.customer_id = t.customer_id);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  UPDATE public.home_passport_ownership_transfers
  SET status = 'completed', closing_date = v_close, resolved_at = now(), resolved_by = auth.uid()
  WHERE id = t.id;

  PERFORM public.hpp_audit(v_owner, auth.uid(), 'transfer_completed', 'ownership_transfer', t.id,
    jsonb_build_object('snapshot_id', t.snapshot_id, 'closing_date', v_close, 'links_revoked', v_revoked));

  RETURN jsonb_build_object('transfer_id', t.id, 'status', 'completed', 'closing_date', v_close,
                            'snapshot_id', t.snapshot_id, 'links_revoked', v_revoked);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_home_ownership_transfer(p_transfer_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  t public.home_passport_ownership_transfers;
BEGIN
  SELECT * INTO t FROM public.home_passport_ownership_transfers
  WHERE id = p_transfer_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HPP_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'pending' THEN RAISE EXCEPTION 'HPP_CONFLICT: transfer is not pending' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.home_passport_ownership_transfers
  SET status = 'cancelled', resolved_at = now(), resolved_by = auth.uid() WHERE id = t.id;
  PERFORM public.hpp_audit(v_owner, auth.uid(), 'transfer_cancelled', 'ownership_transfer', t.id, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_home_ownership_transfers(p_customer_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'transfer_id', t.id, 'customer_id', t.customer_id, 'site_id', t.site_id, 'snapshot_id', t.snapshot_id,
      'status', CASE WHEN t.status = 'pending' AND t.expires_at <= now() THEN 'expired' ELSE t.status END,
      'consent_method', t.consent_method, 'consent_text_version', t.consent_text_version,
      'consent_confirmed_at', t.consent_confirmed_at, 'closing_date', t.closing_date,
      'expires_at', t.expires_at, 'created_at', t.created_at, 'resolved_at', t.resolved_at
    ) ORDER BY t.created_at DESC)
    FROM (SELECT * FROM public.home_passport_ownership_transfers
          WHERE account_owner_id = v_owner AND (p_customer_id IS NULL OR customer_id = p_customer_id)
          ORDER BY created_at DESC LIMIT 100) t
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 8. PILOT INSTRUMENTATION + AUDIT READ
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_home_passport_pilot_metrics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz;
  v_totals jsonb;
  v_daily jsonb;
BEGIN
  v_since := date_trunc('day', now()) - make_interval(days => v_days - 1);

  SELECT jsonb_build_object(
    'passports_created', count(*) FILTER (WHERE action = 'snapshot_created' AND detail ->> 'version' = '1'),
    'snapshots_created', count(*) FILTER (WHERE action = 'snapshot_created'),
    'shares_created',    count(*) FILTER (WHERE action = 'share_created'),
    'share_views',       count(*) FILTER (WHERE action = 'share_viewed'),
    'shares_revoked',    count(*) FILTER (WHERE action = 'share_revoked'),
    'transfers_requested', count(*) FILTER (WHERE action = 'transfer_requested'),
    'transfers_completed', count(*) FILTER (WHERE action = 'transfer_completed'),
    'transfers_cancelled', count(*) FILTER (WHERE action = 'transfer_cancelled')
  ) INTO v_totals
  FROM public.home_passport_pilot_audit
  WHERE account_owner_id = v_owner AND created_at >= v_since;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'day', d.day, 'passports', d.passports, 'shares', d.shares, 'views', d.views, 'transfers', d.transfers
  ) ORDER BY d.day), '[]'::jsonb) INTO v_daily
  FROM (
    SELECT created_at::date AS day,
           count(*) FILTER (WHERE action = 'snapshot_created' AND detail ->> 'version' = '1') AS passports,
           count(*) FILTER (WHERE action = 'share_created') AS shares,
           count(*) FILTER (WHERE action = 'share_viewed') AS views,
           count(*) FILTER (WHERE action = 'transfer_completed') AS transfers
    FROM public.home_passport_pilot_audit
    WHERE account_owner_id = v_owner AND created_at >= v_since
    GROUP BY 1
  ) d;

  RETURN jsonb_build_object(
    'window_days', v_days,
    'totals', v_totals,
    -- Raw counter (every view, not the hourly-deduplicated audit rows).
    'raw_views_all_time', coalesce((SELECT sum(view_count) FROM public.home_passport_share_links WHERE account_owner_id = v_owner), 0),
    'daily', v_daily
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_home_passport_pilot_audit(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.hpp_require_manager();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id, 'action', a.action, 'subject_type', a.subject_type, 'subject_id', a.subject_id,
      'detail', a.detail, 'by_me', a.actor_user_id IS NOT DISTINCT FROM auth.uid(),
      'by_public_visitor', a.actor_user_id IS NULL, 'created_at', a.created_at
    ) ORDER BY a.id DESC)
    FROM (SELECT * FROM public.home_passport_pilot_audit
          WHERE account_owner_id = v_owner ORDER BY id DESC LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)) a
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 9. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.hpp_require_manager() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_audit(uuid, uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_client_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_hit(text, text, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_purge_hits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_range_disclaimer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_find_forbidden_keys(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_clean_ranges(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_build_payload(uuid, uuid, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hpp_create_snapshot(uuid, uuid, uuid, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hpp_purge_hits() TO service_role;

REVOKE ALL ON FUNCTION public.get_home_passport_pilot_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_home_passport_pilot_settings(boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_home_passport_snapshot(uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_home_passport_snapshots(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_home_passport_share(uuid, text, text, integer, integer, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_home_passport_shares(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_home_passport_share(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_home_ownership_transfer(uuid, uuid, text, text, integer, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_home_ownership_transfer(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_home_ownership_transfer(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_home_ownership_transfers(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_home_passport_pilot_metrics(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_home_passport_pilot_audit(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_home_passport_pilot_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_home_passport_pilot_settings(boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_home_passport_snapshot(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_home_passport_snapshots(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_home_passport_share(uuid, text, text, integer, integer, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_home_passport_shares(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_home_passport_share(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_home_ownership_transfer(uuid, uuid, text, text, integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_home_ownership_transfer(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_home_ownership_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_home_ownership_transfers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_home_passport_pilot_metrics(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_home_passport_pilot_audit(integer) TO authenticated;

-- Public (anon) verification endpoints.
REVOKE ALL ON FUNCTION public.verify_home_passport_share(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_home_passport(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_home_passport_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_home_passport_share(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_home_passport(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_home_passport_code(text) TO anon, authenticated;
