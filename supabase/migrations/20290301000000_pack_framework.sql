/*
  # Config-driven Trade Pack framework (versioned packs, install / upgrade / rollback)

  ## Why
  New trades must never fork code. A pack is versioned DATA (job types, custom fields, forms /
  checklists, statuses + workflow rules, pricing templates, terminology, document templates,
  recurring-contract rules, reports, onboarding presets). Pack manifests live in the code base
  (src/lib/packs), are validated there, and are published here as immutable versions.

  ## Safety model
  - Module is behind the feature flag `trade_pack_framework` (seeded OFF, 0%) AND a per-account
    entitlement row (`packs:<id>`). With the flag off nothing changes for any account.
  - The older pest-control / pool-service packs (trade_packs, trade_pack_installs, ...) are NOT touched.
  - Account data is in `pack_artifacts` (live content + the pack content it was based on).
    INVARIANT, enforced by pack_apply(): base_content is the installed version's content for that
    artifact, or NULL when the artifact is account-owned. Customized = content <> base_content.
  - Writes only through SECURITY DEFINER RPCs. Every op carries the state it expects; a stale or
    forged plan is rejected and NOTHING is applied (the function is one transaction).
  - pack_events is append-only (audit + rollback source). pack_versions is immutable.

  ## Depends on
  20270411000100 (feature_flags, feature_flag_is_on, feature_flag_overrides), 20271201000000
  (can_manage_trade_packs), get_account_owner_id(), log_audit_event(), is_vireek_staff(uuid), profiles.

  ## Not verified here
  Written without a Postgres instance available; run supabase/tests/database/pack_framework.test.sql
  and `supabase db reset` before release.
*/
-- rollback: manual and destructive, so not automated. Disable first (flag trade_pack_framework off). To remove: DROP FUNCTION pack_apply(text,text,text,jsonb,uuid,uuid), pack_customize(text,text,jsonb,uuid), staff_publish_pack_version(text,text,text,jsonb), staff_set_pack_entitlement(uuid,text,boolean), pack_require_access(text,boolean), pack_framework_on(uuid); DROP TABLE pack_events, pack_artifacts, pack_installs, pack_entitlements, pack_versions; DELETE FROM feature_flags WHERE key = 'trade_pack_framework'. Account data in these tables is lost on DROP; export pack_artifacts first.

-- =============================================================
-- 1. Feature flag (OFF by default)
-- =============================================================
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('trade_pack_framework', 'Trade Pack framework',
        'Versioned, config-driven trade packs with install / upgrade / rollback. Also needs a per-account packs:<id> entitlement.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 2. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pack_versions (
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'),
  seq integer NOT NULL CHECK (seq >= 1),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- artifact id ("kind:key") -> content object
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts) = 'object' AND octet_length(artifacts::text) <= 262144),
  published_by uuid DEFAULT auth.uid(),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, version),
  UNIQUE (pack_id, seq)
);

CREATE TABLE IF NOT EXISTS public.pack_entitlements (
  user_id uuid NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  entitlement text GENERATED ALWAYS AS ('packs:' || pack_id) STORED,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS public.pack_installs (
  user_id uuid NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  version text,
  status text NOT NULL CHECK (status IN ('installed', 'uninstalled')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack_id),
  FOREIGN KEY (pack_id, version) REFERENCES public.pack_versions (pack_id, version),
  CHECK ((status = 'installed') = (version IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.pack_artifacts (
  user_id uuid NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  artifact_id text NOT NULL CHECK (artifact_id ~ '^[a-z_]{3,24}:[a-z][a-z0-9_]{1,60}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 16000),
  base_content jsonb CHECK (base_content IS NULL OR (jsonb_typeof(base_content) = 'object' AND octet_length(base_content::text) <= 16000)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS public.pack_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ord bigint GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  kind text NOT NULL CHECK (kind IN ('install', 'upgrade', 'rollback', 'customize')),
  from_version text,
  to_version text,
  reverts_event_id uuid REFERENCES public.pack_events (id),
  idempotency_key uuid NOT NULL,
  actor_id uuid DEFAULT auth.uid(),
  ops jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ops) = 'array'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pack_events_reverts ON public.pack_events (reverts_event_id) WHERE reverts_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pack_events_user_pack ON public.pack_events (user_id, pack_id, ord DESC);

-- =============================================================
-- 3. Immutability / append-only guards
-- =============================================================
CREATE OR REPLACE FUNCTION public.pack_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only / immutable', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_pack_versions_immutable ON public.pack_versions;
CREATE TRIGGER trg_pack_versions_immutable BEFORE UPDATE OR DELETE ON public.pack_versions
  FOR EACH ROW EXECUTE FUNCTION public.pack_immutable_guard();
DROP TRIGGER IF EXISTS trg_pack_events_immutable ON public.pack_events;
CREATE TRIGGER trg_pack_events_immutable BEFORE UPDATE OR DELETE ON public.pack_events
  FOR EACH ROW EXECUTE FUNCTION public.pack_immutable_guard();

-- =============================================================
-- 4. RLS: read own tenant only; every write goes through the RPCs below
-- =============================================================
ALTER TABLE public.pack_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_pack_versions" ON public.pack_versions;
CREATE POLICY "read_pack_versions" ON public.pack_versions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "read_pack_entitlements" ON public.pack_entitlements;
CREATE POLICY "read_pack_entitlements" ON public.pack_entitlements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "read_pack_installs" ON public.pack_installs;
CREATE POLICY "read_pack_installs" ON public.pack_installs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "read_pack_artifacts" ON public.pack_artifacts;
CREATE POLICY "read_pack_artifacts" ON public.pack_artifacts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "read_pack_events" ON public.pack_events;
CREATE POLICY "read_pack_events" ON public.pack_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE ON public.pack_versions, public.pack_entitlements, public.pack_installs, public.pack_artifacts, public.pack_events FROM anon, authenticated;

-- =============================================================
-- 5. Internal helpers (not callable by clients)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pack_framework_on(p_tenant uuid)
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
     WHERE f.key = 'trade_pack_framework'
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.pack_require_access(p_pack text, p_need_entitlement boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_pack IS NULL OR p_pack !~ '^[a-z][a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'invalid_pack' USING ERRCODE = '22023';
  END IF;
  IF NOT public.pack_framework_on(v_owner) THEN
    RAISE EXCEPTION 'feature_disabled' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_need_entitlement AND NOT EXISTS (
    SELECT 1 FROM public.pack_entitlements e
     WHERE e.user_id = v_owner AND e.pack_id = p_pack AND e.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not_entitled' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public.pack_framework_on(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pack_require_access(text, boolean) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. pack_apply: install / upgrade / rollback, all-or-nothing, guarded, idempotent
-- =============================================================
CREATE OR REPLACE FUNCTION public.pack_apply(
  p_pack text,
  p_kind text,
  p_to_version text,
  p_ops jsonb,
  p_idempotency_key uuid,
  p_reverts uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_inst public.pack_installs%ROWTYPE;
  v_have_inst boolean;
  v_ev public.pack_events%ROWTYPE;
  v_rev public.pack_events%ROWTYPE;
  v_from text;
  v_to text;
  v_from_seq integer;
  v_to_seq integer;
  o jsonb;
  v_op text;
  v_id text;
  v_lb jsonb;
  v_la jsonb;
  v_bb jsonb;
  v_ba jsonb;
  v_man jsonb;
  r public.pack_artifacts%ROWTYPE;
  v_found boolean;
  v_seen text[] := ARRAY[]::text[];
  v_new uuid;
  v_n integer := 0;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('install', 'upgrade', 'rollback') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  v_owner := public.pack_require_access(p_pack, p_kind <> 'rollback');
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' OR jsonb_array_length(p_ops) > 1000 THEN
    RAISE EXCEPTION 'invalid_ops' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':pack:' || p_pack, 0));

  -- Idempotent replay (the lock above serialises concurrent duplicates).
  SELECT * INTO v_ev FROM public.pack_events WHERE user_id = v_owner AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_ev.pack_id <> p_pack OR v_ev.kind <> p_kind THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('event_id', v_ev.id, 'replayed', true, 'to_version', v_ev.to_version, 'ops', v_ev.summary -> 'ops');
  END IF;

  SELECT * INTO v_inst FROM public.pack_installs WHERE user_id = v_owner AND pack_id = p_pack FOR UPDATE;
  v_have_inst := FOUND;

  IF p_kind = 'install' THEN
    IF v_have_inst AND v_inst.status = 'installed' THEN
      RAISE EXCEPTION 'already_installed' USING ERRCODE = '23505';
    END IF;
    v_from := NULL;
    v_to := p_to_version;
  ELSIF p_kind = 'upgrade' THEN
    IF NOT v_have_inst OR v_inst.status <> 'installed' THEN
      RAISE EXCEPTION 'not_installed' USING ERRCODE = 'P0002';
    END IF;
    v_from := v_inst.version;
    v_to := p_to_version;
  ELSE
    IF p_reverts IS NULL THEN
      RAISE EXCEPTION 'reverts_required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_rev FROM public.pack_events WHERE id = p_reverts AND user_id = v_owner AND pack_id = p_pack;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown_event' USING ERRCODE = 'P0002';
    END IF;
    IF v_rev.kind NOT IN ('install', 'upgrade') THEN
      RAISE EXCEPTION 'event_not_revertible' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pack_events x WHERE x.reverts_event_id = p_reverts) THEN
      RAISE EXCEPTION 'already_reverted' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.pack_events e
       WHERE e.user_id = v_owner AND e.pack_id = p_pack AND e.kind IN ('install', 'upgrade') AND e.ord > v_rev.ord
         AND NOT EXISTS (SELECT 1 FROM public.pack_events x WHERE x.reverts_event_id = e.id)
    ) THEN
      RAISE EXCEPTION 'not_latest_event' USING ERRCODE = '22023';
    END IF;
    IF NOT v_have_inst OR v_inst.status <> 'installed' OR v_inst.version IS DISTINCT FROM v_rev.to_version THEN
      RAISE EXCEPTION 'state_mismatch' USING ERRCODE = '22023';
    END IF;
    v_from := v_inst.version;
    v_to := v_rev.from_version; -- NULL = uninstall
  END IF;

  IF p_kind <> 'rollback' AND v_to IS NULL THEN
    RAISE EXCEPTION 'version_required' USING ERRCODE = '22023';
  END IF;
  IF v_to IS NOT NULL THEN
    SELECT seq INTO v_to_seq FROM public.pack_versions WHERE pack_id = p_pack AND version = v_to;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown_version' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF p_kind = 'upgrade' THEN
    SELECT seq INTO v_from_seq FROM public.pack_versions WHERE pack_id = p_pack AND version = v_from;
    IF v_to_seq < v_from_seq THEN
      RAISE EXCEPTION 'downgrade_requires_rollback' USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR o IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    IF jsonb_typeof(o) <> 'object' THEN
      RAISE EXCEPTION 'invalid_op' USING ERRCODE = '22023';
    END IF;
    v_op := o ->> 'op';
    v_id := o ->> 'id';
    IF v_op IS NULL OR v_op NOT IN ('create', 'update', 'remove', 'rebase', 'detach') THEN
      RAISE EXCEPTION 'invalid_op: %', COALESCE(v_op, '?') USING ERRCODE = '22023';
    END IF;
    IF v_id IS NULL OR v_id !~ '^[a-z_]{3,24}:[a-z][a-z0-9_]{1,60}$'
       OR NOT (split_part(v_id, ':', 1) = ANY (ARRAY['job_type','custom_field','form','status','workflow_rule','pricing_template','term','document_template','recurring_rule','report','onboarding_preset'])) THEN
      RAISE EXCEPTION 'invalid_artifact_id: %', COALESCE(v_id, '?') USING ERRCODE = '22023';
    END IF;
    IF v_id = ANY (v_seen) THEN
      RAISE EXCEPTION 'duplicate_op: %', v_id USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_id;

    v_lb := NULLIF(o -> 'liveBefore', 'null'::jsonb);
    v_la := NULLIF(o -> 'liveAfter', 'null'::jsonb);
    v_bb := NULLIF(o -> 'baseBefore', 'null'::jsonb);
    v_ba := NULLIF(o -> 'baseAfter', 'null'::jsonb);
    IF (v_lb IS NOT NULL AND jsonb_typeof(v_lb) <> 'object') OR (v_la IS NOT NULL AND jsonb_typeof(v_la) <> 'object')
       OR (v_bb IS NOT NULL AND jsonb_typeof(v_bb) <> 'object') OR (v_ba IS NOT NULL AND jsonb_typeof(v_ba) <> 'object') THEN
      RAISE EXCEPTION 'invalid_content: %', v_id USING ERRCODE = '22023';
    END IF;

    -- New base must be exactly the TARGET version's published content.
    IF v_ba IS NOT NULL THEN
      v_man := CASE WHEN v_to IS NULL THEN NULL
                    ELSE (SELECT pv.artifacts -> v_id FROM public.pack_versions pv WHERE pv.pack_id = p_pack AND pv.version = v_to) END;
      IF v_man IS NULL OR v_man <> v_ba THEN
        RAISE EXCEPTION 'base_not_in_target_version: %', v_id USING ERRCODE = '22023';
      END IF;
    END IF;
    -- Live may stay as it is, become the pack content, or be removed; never anything else.
    IF v_la IS NOT NULL AND NOT (v_la IS NOT DISTINCT FROM v_lb OR v_la IS NOT DISTINCT FROM v_ba) THEN
      RAISE EXCEPTION 'live_not_allowed: %', v_id USING ERRCODE = '22023';
    END IF;

    SELECT * INTO r FROM public.pack_artifacts WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = v_id FOR UPDATE;
    v_found := FOUND;

    IF v_op = 'create' THEN
      IF v_found THEN RAISE EXCEPTION 'already_exists: %', v_id USING ERRCODE = '23505'; END IF;
      IF v_lb IS NOT NULL OR v_bb IS NOT NULL OR v_la IS NULL OR v_ba IS NULL OR v_la <> v_ba THEN
        RAISE EXCEPTION 'malformed_create: %', v_id USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.pack_artifacts (user_id, pack_id, artifact_id, content, base_content) VALUES (v_owner, p_pack, v_id, v_la, v_ba);
    ELSE
      IF NOT v_found THEN RAISE EXCEPTION 'missing: %', v_id USING ERRCODE = 'P0002'; END IF;
      IF r.content IS DISTINCT FROM v_lb OR r.base_content IS DISTINCT FROM v_bb THEN
        RAISE EXCEPTION 'stale_plan: %', v_id USING ERRCODE = '40001';
      END IF;
      IF v_op = 'remove' THEN
        IF v_la IS NOT NULL OR v_ba IS NOT NULL THEN RAISE EXCEPTION 'malformed_remove: %', v_id USING ERRCODE = '22023'; END IF;
        DELETE FROM public.pack_artifacts WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = v_id;
      ELSIF v_op = 'detach' THEN
        IF v_ba IS NOT NULL OR v_la IS DISTINCT FROM v_lb THEN RAISE EXCEPTION 'malformed_detach: %', v_id USING ERRCODE = '22023'; END IF;
        UPDATE public.pack_artifacts SET base_content = NULL, updated_at = now() WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = v_id;
      ELSIF v_op = 'rebase' THEN
        IF v_ba IS NULL OR v_la IS DISTINCT FROM v_lb THEN RAISE EXCEPTION 'malformed_rebase: %', v_id USING ERRCODE = '22023'; END IF;
        UPDATE public.pack_artifacts SET base_content = v_ba, updated_at = now() WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = v_id;
      ELSE -- update
        IF v_ba IS NULL OR v_la IS NULL OR v_la <> v_ba THEN RAISE EXCEPTION 'malformed_update: %', v_id USING ERRCODE = '22023'; END IF;
        UPDATE public.pack_artifacts SET content = v_la, base_content = v_ba, updated_at = now() WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = v_id;
      END IF;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  -- Post-conditions: the invariant must hold for EVERY artifact, whatever the client sent.
  IF v_to IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.pack_artifacts a WHERE a.user_id = v_owner AND a.pack_id = p_pack AND a.base_content IS NOT NULL) THEN
      RAISE EXCEPTION 'invariant_violation: pack-managed artifacts remain after uninstall' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.pack_artifacts a
        JOIN public.pack_versions pv ON pv.pack_id = a.pack_id AND pv.version = v_to
       WHERE a.user_id = v_owner AND a.pack_id = p_pack AND a.base_content IS NOT NULL
         AND a.base_content IS DISTINCT FROM (pv.artifacts -> a.artifact_id)
    ) THEN
      RAISE EXCEPTION 'invariant_violation: an artifact is not at the target version' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.pack_versions pv, jsonb_object_keys(pv.artifacts) AS k(id)
       WHERE pv.pack_id = p_pack AND pv.version = v_to
         AND NOT EXISTS (SELECT 1 FROM public.pack_artifacts a WHERE a.user_id = v_owner AND a.pack_id = p_pack AND a.artifact_id = k.id)
    ) THEN
      RAISE EXCEPTION 'incomplete_plan: the target version has artifacts the plan did not cover' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_to IS NULL THEN
    UPDATE public.pack_installs SET version = NULL, status = 'uninstalled', updated_at = now() WHERE user_id = v_owner AND pack_id = p_pack;
  ELSE
    INSERT INTO public.pack_installs (user_id, pack_id, version, status) VALUES (v_owner, p_pack, v_to, 'installed')
    ON CONFLICT (user_id, pack_id) DO UPDATE SET version = EXCLUDED.version, status = 'installed', updated_at = now();
  END IF;

  INSERT INTO public.pack_events (user_id, pack_id, kind, from_version, to_version, reverts_event_id, idempotency_key, ops, summary)
  VALUES (v_owner, p_pack, p_kind, v_from, v_to, CASE WHEN p_kind = 'rollback' THEN p_reverts END, p_idempotency_key, p_ops, jsonb_build_object('ops', v_n))
  RETURNING id INTO v_new;

  PERFORM public.log_audit_event(v_owner, 'pack.' || p_kind, 'pack_installs', p_pack);
  RETURN jsonb_build_object('event_id', v_new, 'replayed', false, 'to_version', v_to, 'ops', v_n);
END;
$$;
GRANT EXECUTE ON FUNCTION public.pack_apply(text, text, text, jsonb, uuid, uuid) TO authenticated;

-- =============================================================
-- 7. pack_customize: the account edits one artifact (kept by every later upgrade)
-- =============================================================
CREATE OR REPLACE FUNCTION public.pack_customize(
  p_pack text,
  p_artifact_id text,
  p_content jsonb,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_ev public.pack_events%ROWTYPE;
  r public.pack_artifacts%ROWTYPE;
  v_new uuid;
BEGIN
  v_owner := public.pack_require_access(p_pack, true);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_artifact_id IS NULL OR p_artifact_id !~ '^[a-z_]{3,24}:[a-z][a-z0-9_]{1,60}$' THEN
    RAISE EXCEPTION 'invalid_artifact_id' USING ERRCODE = '22023';
  END IF;
  -- Shape is validated by the client (src/lib/packs/schema.ts); the server enforces the cheap invariants.
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'object' OR octet_length(p_content::text) > 16000
     OR (p_content ->> 'key') IS DISTINCT FROM split_part(p_artifact_id, ':', 2) THEN
    RAISE EXCEPTION 'invalid_content' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':pack:' || p_pack, 0));

  SELECT * INTO v_ev FROM public.pack_events WHERE user_id = v_owner AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_ev.pack_id <> p_pack OR v_ev.kind <> 'customize' THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('event_id', v_ev.id, 'replayed', true);
  END IF;

  SELECT * INTO r FROM public.pack_artifacts WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = p_artifact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing: %', p_artifact_id USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.pack_artifacts SET content = p_content, updated_at = now()
   WHERE user_id = v_owner AND pack_id = p_pack AND artifact_id = p_artifact_id;

  INSERT INTO public.pack_events (user_id, pack_id, kind, idempotency_key, ops, summary)
  VALUES (v_owner, p_pack, 'customize', p_idempotency_key,
          jsonb_build_array(jsonb_build_object('op', 'customize', 'id', p_artifact_id, 'liveBefore', r.content, 'liveAfter', p_content)),
          jsonb_build_object('ops', 1))
  RETURNING id INTO v_new;
  PERFORM public.log_audit_event(v_owner, 'pack.customize', 'pack_artifacts', p_pack || '/' || p_artifact_id);
  RETURN jsonb_build_object('event_id', v_new, 'replayed', false);
END;
$$;
GRANT EXECUTE ON FUNCTION public.pack_customize(text, text, jsonb, uuid) TO authenticated;

-- =============================================================
-- 8. Staff RPCs: publish an immutable version, grant / revoke the entitlement
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_publish_pack_version(
  p_pack text,
  p_version text,
  p_name text,
  p_artifacts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.pack_versions%ROWTYPE;
  v_seq integer;
  k text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_pack IS NULL OR p_pack !~ '^[a-z][a-z0-9_]{1,40}$'
     OR p_version IS NULL OR p_version !~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
     OR p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 80
     OR p_artifacts IS NULL OR jsonb_typeof(p_artifacts) <> 'object' OR octet_length(p_artifacts::text) > 262144 THEN
    RAISE EXCEPTION 'invalid_pack_version' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_artifacts) LOOP
    IF k !~ '^[a-z_]{3,24}:[a-z][a-z0-9_]{1,60}$' OR jsonb_typeof(p_artifacts -> k) <> 'object'
       OR octet_length((p_artifacts -> k)::text) > 16000 OR (p_artifacts -> k ->> 'key') IS DISTINCT FROM split_part(k, ':', 2) THEN
      RAISE EXCEPTION 'invalid_artifact: %', k USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('pack_publish:' || p_pack, 0));

  SELECT * INTO v_existing FROM public.pack_versions WHERE pack_id = p_pack AND version = p_version;
  IF FOUND THEN
    IF v_existing.artifacts = p_artifacts AND v_existing.name = p_name THEN
      RETURN jsonb_build_object('published', false, 'seq', v_existing.seq);
    END IF;
    RAISE EXCEPTION 'version_immutable: publish a new version instead' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pack_versions pv
     WHERE pv.pack_id = p_pack
       AND string_to_array(pv.version, '.')::int[] > string_to_array(p_version, '.')::int[]
  ) THEN
    RAISE EXCEPTION 'version_not_monotonic' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM public.pack_versions WHERE pack_id = p_pack;
  INSERT INTO public.pack_versions (pack_id, version, seq, name, artifacts) VALUES (p_pack, p_version, v_seq, btrim(p_name), p_artifacts);
  PERFORM public.log_audit_event(auth.uid(), 'pack.publish', 'pack_versions', p_pack || '@' || p_version);
  RETURN jsonb_build_object('published', true, 'seq', v_seq);
END;
$$;
GRANT EXECUTE ON FUNCTION public.staff_publish_pack_version(text, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_set_pack_entitlement(
  p_tenant uuid,
  p_pack text,
  p_granted boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tenant IS NULL OR p_granted IS NULL OR p_pack IS NULL OR p_pack !~ '^[a-z][a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'unknown_tenant' USING ERRCODE = 'P0002';
  END IF;
  IF p_granted THEN
    IF NOT EXISTS (SELECT 1 FROM public.pack_versions WHERE pack_id = p_pack) THEN
      RAISE EXCEPTION 'pack_not_published' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.pack_entitlements (user_id, pack_id, granted_by) VALUES (p_tenant, p_pack, auth.uid())
    ON CONFLICT (user_id, pack_id) DO UPDATE SET revoked_at = NULL, granted_by = auth.uid(), granted_at = now();
  ELSE
    UPDATE public.pack_entitlements SET revoked_at = now() WHERE user_id = p_tenant AND pack_id = p_pack AND revoked_at IS NULL;
  END IF;
  PERFORM public.log_audit_event(p_tenant, CASE WHEN p_granted THEN 'pack.entitlement_granted' ELSE 'pack.entitlement_revoked' END, 'pack_entitlements', p_pack);
END;
$$;
GRANT EXECUTE ON FUNCTION public.staff_set_pack_entitlement(uuid, text, boolean) TO authenticated;
