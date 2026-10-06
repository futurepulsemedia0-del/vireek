/*
  # Vireek Operational Truth Engine

  Trust infrastructure underneath every Vireek agent. Every operational fact an
  agent may act on is a CLAIM with provenance:

      Source -> Evidence -> Freshness -> Confidence -> Conflict -> Verification

  Purely additive. The only touch on existing tables is a non-blocking AFTER
  trigger on technician_credentials that mirrors credentials into claims
  (any failure there is downgraded to a WARNING, so compliance writes never break).

  - truth_facts          one claim per (subject, predicate, source); newer claim from the same
                         source supersedes the old row. Claim content is immutable.
  - truth_evidence       append-only evidence attached to a claim (hash / uri / excerpt).
  - truth_verifications  append-only log of every assert / confirm / reject.
  - truth_conflicts      open / resolved disagreements between trusted sources.
  - truth_policies       per-account freshness + confidence policy overrides.
  - truth_decisions      append-only audit of every agent gate decision (allow / block + why).

  Writes go through the operational-truth Edge Function (service role). Clients can
  only READ their account's rows and manage their own policies.
*/

-- =============================================================
-- Guards
-- =============================================================

CREATE OR REPLACE FUNCTION public.truth_slug(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(NULLIF(left(btrim(lower(regexp_replace(COALESCE(p_text, ''), '[^a-zA-Z0-9]+', '_', 'g')), '_'), 60), ''), 'unknown');
$$;

-- Append-only: no UPDATE, and DELETE only as part of an FK cascade (account erasure),
-- where pg_trigger_depth() > 1.
CREATE OR REPLACE FUNCTION public.truth_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '% is append-only — % is not allowed. Record a new entry instead.', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE FUNCTION public.truth_facts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.value_hash := md5(NEW.value::text);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.predicate IS DISTINCT FROM OLD.predicate
       OR NEW.value IS DISTINCT FROM OLD.value
       OR NEW.source_key IS DISTINCT FROM OLD.source_key
       OR NEW.base_confidence IS DISTINCT FROM OLD.base_confidence THEN
      RAISE EXCEPTION 'truth_facts claims are immutable — supersede the claim with a new one.';
    END IF;
    IF OLD.status <> 'current'
       AND (NEW.status IS DISTINCT FROM OLD.status
            OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
      RAISE EXCEPTION 'A superseded or revoked claim can no longer change.';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: only inside an FK cascade (account erasure)
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'truth_facts rows cannot be deleted — revoke or supersede the claim.';
END;
$$;

-- =============================================================
-- 1. Claims
-- =============================================================

CREATE TABLE IF NOT EXISTS truth_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  subject_id text NOT NULL CHECK (subject_id ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  predicate text NOT NULL CHECK (char_length(predicate) <= 120 AND predicate ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_:-]+)+$'),
  value jsonb NOT NULL DEFAULT 'true'::jsonb,
  value_hash text NOT NULL DEFAULT '',
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 2 AND 64),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 300),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  base_confidence numeric(5, 4) NOT NULL CHECK (base_confidence > 0 AND base_confidence <= 1),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'revoked')),
  supersedes_id uuid REFERENCES truth_facts(id) ON DELETE SET NULL,
  verification_method text NOT NULL DEFAULT 'asserted',
  expiry_alert_stage text CHECK (expiry_alert_stage IN ('expiring_soon', 'expired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT truth_facts_expiry_after_verify CHECK (expires_at IS NULL OR expires_at > verified_at)
);

COMMENT ON TABLE truth_facts IS 'Operational claims with provenance. Agents act only on claims the Truth Engine resolves to verdict=verified.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_truth_facts_current_per_source
  ON truth_facts(user_id, subject_type, subject_id, predicate, source_key) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_truth_facts_lookup
  ON truth_facts(user_id, subject_type, subject_id, predicate) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_truth_facts_expiry
  ON truth_facts(user_id, expires_at) WHERE status = 'current' AND expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_truth_facts_guard_ins ON truth_facts;
CREATE TRIGGER trg_truth_facts_guard_ins BEFORE INSERT ON truth_facts
  FOR EACH ROW EXECUTE FUNCTION public.truth_facts_guard();
DROP TRIGGER IF EXISTS trg_truth_facts_guard_upd ON truth_facts;
CREATE TRIGGER trg_truth_facts_guard_upd BEFORE UPDATE ON truth_facts
  FOR EACH ROW EXECUTE FUNCTION public.truth_facts_guard();
DROP TRIGGER IF EXISTS trg_truth_facts_guard_del ON truth_facts;
CREATE TRIGGER trg_truth_facts_guard_del BEFORE DELETE ON truth_facts
  FOR EACH ROW EXECUTE FUNCTION public.truth_facts_guard();

ALTER TABLE truth_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_truth_facts" ON truth_facts;
CREATE POLICY "select_own_truth_facts" ON truth_facts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. Evidence (append-only)
-- =============================================================

CREATE TABLE IF NOT EXISTS truth_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES truth_facts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('document', 'api_response', 'photo', 'signature', 'record', 'note')),
  uri text CHECK (uri IS NULL OR char_length(uri) <= 500),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 500),
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT truth_evidence_has_payload CHECK (uri IS NOT NULL OR content_hash IS NOT NULL OR excerpt IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_truth_evidence_fact ON truth_evidence(fact_id);

DROP TRIGGER IF EXISTS trg_truth_evidence_guard_upd ON truth_evidence;
CREATE TRIGGER trg_truth_evidence_guard_upd BEFORE UPDATE ON truth_evidence
  FOR EACH ROW EXECUTE FUNCTION public.truth_append_only_guard();
DROP TRIGGER IF EXISTS trg_truth_evidence_guard_del ON truth_evidence;
CREATE TRIGGER trg_truth_evidence_guard_del BEFORE DELETE ON truth_evidence
  FOR EACH ROW EXECUTE FUNCTION public.truth_append_only_guard();

ALTER TABLE truth_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_truth_evidence" ON truth_evidence;
CREATE POLICY "select_own_truth_evidence" ON truth_evidence FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. Verification log (append-only)
-- =============================================================

CREATE TABLE IF NOT EXISTS truth_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES truth_facts(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('asserted', 'confirmed', 'rejected', 'superseded', 'auto_projected', 'conflict_resolved')),
  method text,
  previous_expires_at timestamptz,
  new_expires_at timestamptz,
  actor_id uuid,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_truth_verifications_fact ON truth_verifications(fact_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_truth_verifications_guard_upd ON truth_verifications;
CREATE TRIGGER trg_truth_verifications_guard_upd BEFORE UPDATE ON truth_verifications
  FOR EACH ROW EXECUTE FUNCTION public.truth_append_only_guard();
DROP TRIGGER IF EXISTS trg_truth_verifications_guard_del ON truth_verifications;
CREATE TRIGGER trg_truth_verifications_guard_del BEFORE DELETE ON truth_verifications
  FOR EACH ROW EXECUTE FUNCTION public.truth_append_only_guard();

ALTER TABLE truth_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_truth_verifications" ON truth_verifications;
CREATE POLICY "select_own_truth_verifications" ON truth_verifications FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. Conflicts
-- =============================================================

CREATE TABLE IF NOT EXISTS truth_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  predicate text NOT NULL,
  fact_ids uuid[] NOT NULL DEFAULT '{}',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_truth_conflicts_open
  ON truth_conflicts(user_id, subject_type, subject_id, predicate) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_truth_conflicts_user ON truth_conflicts(user_id, status, opened_at DESC);

ALTER TABLE truth_conflicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_truth_conflicts" ON truth_conflicts;
CREATE POLICY "select_own_truth_conflicts" ON truth_conflicts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 5. Policy overrides (owner-managed)
-- =============================================================

CREATE TABLE IF NOT EXISTS truth_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  predicate text NOT NULL CHECK (char_length(predicate) <= 120 AND predicate ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_:-]*)+$'),
  min_confidence numeric(4, 3) NOT NULL DEFAULT 0.8 CHECK (min_confidence >= 0.3 AND min_confidence <= 0.999),
  max_age_days integer NOT NULL DEFAULT 90 CHECK (max_age_days BETWEEN 1 AND 3650),
  min_independent_sources integer NOT NULL DEFAULT 1 CHECK (min_independent_sources BETWEEN 1 AND 5),
  expiring_warning_days integer NOT NULL DEFAULT 14 CHECK (expiring_warning_days BETWEEN 0 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT truth_policies_unique UNIQUE (user_id, predicate)
);

COMMENT ON COLUMN truth_policies.predicate IS 'Exact predicate, or a prefix ending in a dot (e.g. credential.) to cover a whole family.';

DROP TRIGGER IF EXISTS trg_truth_policies_updated_at ON truth_policies;
CREATE TRIGGER trg_truth_policies_updated_at BEFORE UPDATE ON truth_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE truth_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_truth_policies" ON truth_policies;
CREATE POLICY "select_own_truth_policies" ON truth_policies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_truth_policies" ON truth_policies;
CREATE POLICY "insert_own_truth_policies" ON truth_policies FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_truth_policies" ON truth_policies;
CREATE POLICY "update_own_truth_policies" ON truth_policies FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_truth_policies" ON truth_policies;
CREATE POLICY "delete_own_truth_policies" ON truth_policies FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================
-- 6. Decision audit (append-only; written only by the service role)
-- =============================================================

CREATE TABLE IF NOT EXISTS truth_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent text NOT NULL CHECK (char_length(agent) BETWEEN 1 AND 80),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  predicate text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('verified', 'unverified', 'stale', 'expired', 'conflict', 'low_confidence', 'insufficient_corroboration', 'denied')),
  allow boolean NOT NULL,
  confidence numeric(5, 4) NOT NULL DEFAULT 0,
  reason text,
  fact_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_truth_decisions_user ON truth_decisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_truth_decisions_blocked ON truth_decisions(user_id, created_at DESC) WHERE allow = false;

DROP TRIGGER IF EXISTS trg_truth_decisions_guard_upd ON truth_decisions;
CREATE TRIGGER trg_truth_decisions_guard_upd BEFORE UPDATE ON truth_decisions
  FOR EACH ROW EXECUTE FUNCTION public.truth_append_only_guard();
DROP TRIGGER IF EXISTS trg_truth_decisions_guard_del ON truth_decisions;
CREATE TRIGGER trg_truth_decisions_guard_del BEFORE DELETE ON truth_decisions
  FOR EACH ROW EXECUTE FUNCTION public.truth_append_only_guard();

ALTER TABLE truth_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_truth_decisions" ON truth_decisions;
CREATE POLICY "select_own_truth_decisions" ON truth_decisions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 7. Credential projection
--    Mirrors technician_credentials into claims so the engine has real data from
--    day one. It is an OWNER-ENTERED claim (not an authority check): verified_at is
--    the moment the owner last changed it, and confidence stays below the credential
--    policy threshold until a document or an authority corroborates it.
-- =============================================================

CREATE OR REPLACE FUNCTION public.truth_refresh_credential(p_user uuid, p_tech uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pred text := 'credential.' || p_slug;
  v_count integer;
  v_valid boolean;
  v_exp date;
  v_expires timestamptz;
  v_fact uuid;
BEGIN
  SELECT count(*),
         COALESCE(bool_or(status = 'active' AND (expires_at IS NULL OR expires_at >= current_date)), false)
    INTO v_count, v_valid
    FROM technician_credentials
   WHERE user_id = p_user AND technician_id = p_tech AND public.truth_slug(credential_type) = p_slug;

  IF v_count = 0 THEN
    UPDATE truth_facts SET status = 'revoked'
     WHERE user_id = p_user AND subject_type = 'technician' AND subject_id = p_tech::text
       AND predicate = v_pred AND source_key = 'owner_entered' AND status = 'current';
    RETURN;
  END IF;

  IF v_valid THEN
    SELECT CASE WHEN bool_or(expires_at IS NULL) THEN NULL ELSE max(expires_at) END
      INTO v_exp
      FROM technician_credentials
     WHERE user_id = p_user AND technician_id = p_tech AND public.truth_slug(credential_type) = p_slug
       AND status = 'active' AND (expires_at IS NULL OR expires_at >= current_date);
    IF v_exp IS NOT NULL THEN
      v_expires := ((v_exp + 1)::timestamp AT TIME ZONE 'UTC');
    END IF;
  END IF;

  -- Nothing new to say: keep the existing claim (and its real age).
  PERFORM 1 FROM truth_facts
   WHERE user_id = p_user AND subject_type = 'technician' AND subject_id = p_tech::text
     AND predicate = v_pred AND source_key = 'owner_entered' AND status = 'current'
     AND value = to_jsonb(v_valid) AND expires_at IS NOT DISTINCT FROM v_expires;
  IF FOUND THEN
    RETURN;
  END IF;

  UPDATE truth_facts SET status = 'superseded'
   WHERE user_id = p_user AND subject_type = 'technician' AND subject_id = p_tech::text
     AND predicate = v_pred AND source_key = 'owner_entered' AND status = 'current';

  INSERT INTO truth_facts (user_id, subject_type, subject_id, predicate, value, source_key, source_ref,
                           verified_at, expires_at, base_confidence, verification_method)
  VALUES (p_user, 'technician', p_tech::text, v_pred, to_jsonb(v_valid), 'owner_entered', 'technician_credentials',
          now(), v_expires, 0.595, 'auto_projected')
  RETURNING id INTO v_fact;

  INSERT INTO truth_verifications (user_id, fact_id, action, method, new_expires_at)
  VALUES (p_user, v_fact, 'auto_projected', 'technician_credentials', v_expires);
END;
$$;

REVOKE ALL ON FUNCTION public.truth_refresh_credential(uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.truth_project_credential()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.truth_refresh_credential(OLD.user_id, OLD.technician_id, public.truth_slug(OLD.credential_type));
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM public.truth_refresh_credential(NEW.user_id, NEW.technician_id, public.truth_slug(NEW.credential_type));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The truth layer must never block a compliance write.
    RAISE WARNING 'truth_project_credential failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_truth_project_credential ON technician_credentials;
CREATE TRIGGER trg_truth_project_credential
  AFTER INSERT OR DELETE OR UPDATE OF credential_type, technician_id, status, expires_at ON technician_credentials
  FOR EACH ROW EXECUTE FUNCTION public.truth_project_credential();

-- Backfill existing credentials (idempotent: no-op when a matching claim already exists).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT user_id, technician_id, public.truth_slug(credential_type) AS slug
      FROM technician_credentials
  LOOP
    BEGIN
      PERFORM public.truth_refresh_credential(r.user_id, r.technician_id, r.slug);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'truth backfill skipped one credential group: %', SQLERRM;
    END;
  END LOOP;
END $$;

-- =============================================================
-- 8. Atomic write RPCs (service role only — called by the operational-truth
--    Edge Function after it has authenticated and authorised the caller)
-- =============================================================

CREATE OR REPLACE FUNCTION public.truth_write_claim(
  p_user uuid,
  p_actor uuid,
  p_subject_type text,
  p_subject_id text,
  p_predicate text,
  p_value jsonb,
  p_source_key text,
  p_source_ref text,
  p_verified_at timestamptz,
  p_expires_at timestamptz,
  p_confidence numeric,
  p_method text,
  p_evidence jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev uuid;
  v_fact uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user::text || '|' || p_subject_type || '|' || p_subject_id || '|' || p_predicate || '|' || p_source_key, 0)
  );

  SELECT id INTO v_prev
    FROM truth_facts
   WHERE user_id = p_user AND subject_type = p_subject_type AND subject_id = p_subject_id
     AND predicate = p_predicate AND source_key = p_source_key AND status = 'current';

  IF v_prev IS NOT NULL THEN
    UPDATE truth_facts SET status = 'superseded' WHERE id = v_prev;
    INSERT INTO truth_verifications (user_id, fact_id, action, method, actor_id)
    VALUES (p_user, v_prev, 'superseded', p_method, p_actor);
  END IF;

  INSERT INTO truth_facts (user_id, subject_type, subject_id, predicate, value, source_key, source_ref,
                           verified_at, expires_at, base_confidence, supersedes_id, verification_method, created_by)
  VALUES (p_user, p_subject_type, p_subject_id, p_predicate, p_value, p_source_key, p_source_ref,
          p_verified_at, p_expires_at, p_confidence, v_prev, p_method, p_actor)
  RETURNING id INTO v_fact;

  INSERT INTO truth_evidence (user_id, fact_id, kind, uri, content_hash, excerpt, created_by)
  SELECT p_user, v_fact, e ->> 'kind', NULLIF(e ->> 'uri', ''), NULLIF(e ->> 'content_hash', ''), NULLIF(e ->> 'excerpt', ''), p_actor
    FROM jsonb_array_elements(COALESCE(p_evidence, '[]'::jsonb)) AS e;

  INSERT INTO truth_verifications (user_id, fact_id, action, method, new_expires_at, actor_id)
  VALUES (p_user, v_fact, 'asserted', p_method, p_expires_at, p_actor);

  RETURN v_fact;
END;
$$;

CREATE OR REPLACE FUNCTION public.truth_verify_claim(
  p_user uuid,
  p_actor uuid,
  p_fact uuid,
  p_result text,
  p_new_expires timestamptz,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f truth_facts%ROWTYPE;
  v_exp timestamptz;
BEGIN
  SELECT * INTO f FROM truth_facts WHERE id = p_fact AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.';
  END IF;
  IF f.status <> 'current' THEN
    RAISE EXCEPTION 'Only a current claim can be verified.';
  END IF;

  IF p_result = 'confirmed' THEN
    v_exp := COALESCE(p_new_expires, f.expires_at);
    IF v_exp IS NOT NULL AND v_exp <= now() THEN
      RAISE EXCEPTION 'A new expiry date in the future is required.';
    END IF;
    UPDATE truth_facts
       SET verified_at = now(), expires_at = v_exp, expiry_alert_stage = NULL, verification_method = 'human_confirmed'
     WHERE id = f.id;
    INSERT INTO truth_verifications (user_id, fact_id, action, method, previous_expires_at, new_expires_at, actor_id, note)
    VALUES (p_user, f.id, 'confirmed', 'human_confirmed', f.expires_at, v_exp, p_actor, left(p_note, 500));
    RETURN jsonb_build_object('status', 'confirmed', 'verified_at', now(), 'expires_at', v_exp);
  ELSIF p_result = 'rejected' THEN
    UPDATE truth_facts SET status = 'revoked' WHERE id = f.id;
    INSERT INTO truth_verifications (user_id, fact_id, action, method, previous_expires_at, actor_id, note)
    VALUES (p_user, f.id, 'rejected', 'human_review', f.expires_at, p_actor, left(p_note, 500));
    RETURN jsonb_build_object('status', 'rejected');
  END IF;

  RAISE EXCEPTION 'Invalid verification result.';
END;
$$;

CREATE OR REPLACE FUNCTION public.truth_resolve_conflict(
  p_user uuid,
  p_actor uuid,
  p_conflict uuid,
  p_winner uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c truth_conflicts%ROWTYPE;
  w truth_facts%ROWTYPE;
  r record;
  v_lost integer := 0;
BEGIN
  SELECT * INTO c FROM truth_conflicts WHERE id = p_conflict AND user_id = p_user AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open conflict not found.';
  END IF;

  SELECT * INTO w FROM truth_facts
   WHERE id = p_winner AND user_id = p_user AND status = 'current'
     AND subject_type = c.subject_type AND subject_id = c.subject_id AND predicate = c.predicate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The winning claim must be a current claim of this conflict.';
  END IF;

  FOR r IN
    SELECT id FROM truth_facts
     WHERE user_id = p_user AND subject_type = c.subject_type AND subject_id = c.subject_id
       AND predicate = c.predicate AND status = 'current' AND value_hash <> w.value_hash
  LOOP
    UPDATE truth_facts SET status = 'superseded' WHERE id = r.id;
    INSERT INTO truth_verifications (user_id, fact_id, action, method, actor_id, note)
    VALUES (p_user, r.id, 'superseded', 'conflict_resolution', p_actor, left(p_note, 500));
    v_lost := v_lost + 1;
  END LOOP;

  INSERT INTO truth_verifications (user_id, fact_id, action, method, actor_id, note)
  VALUES (p_user, w.id, 'conflict_resolved', 'conflict_resolution', p_actor, left(p_note, 500));

  UPDATE truth_conflicts
     SET status = 'resolved', resolved_at = now(), resolved_by = p_actor,
         resolution = jsonb_build_object('winning_fact_id', w.id, 'superseded_claims', v_lost, 'note', left(p_note, 500))
   WHERE id = c.id;

  RETURN jsonb_build_object('status', 'resolved', 'superseded_claims', v_lost);
END;
$$;

REVOKE ALL ON FUNCTION public.truth_write_claim(uuid, uuid, text, text, text, jsonb, text, text, timestamptz, timestamptz, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.truth_verify_claim(uuid, uuid, uuid, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.truth_resolve_conflict(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.truth_write_claim(uuid, uuid, text, text, text, jsonb, text, text, timestamptz, timestamptz, numeric, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.truth_verify_claim(uuid, uuid, uuid, text, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.truth_resolve_conflict(uuid, uuid, uuid, uuid, text) TO service_role;
