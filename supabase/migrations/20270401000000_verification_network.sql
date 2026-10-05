/*
  # Automated License + Insurance Verification Network

  Adds an EXTERNAL verification layer on top of what already exists (technician_credentials,
  technician_insurance_policies, Technician Passport 2.0). Touches NO existing table, trigger
  or function - it only reads them.

  ## Objects
  - verification_sources          : global registry of primary sources (state boards, ...). Data, not code.
  - verification_checks           : one row per verification attempt. Finalised rows are immutable.
  - verification_events           : append-only audit trail.
  - background_consents           : technician's own consent (required before any background check).
  - verification_current (view)   : latest FINAL check per subject.
  - verification_enqueue_subject  : service_role - queue one check (idempotent while one is pending).
  - verification_enqueue_due      : service_role - queue new / changed / due subjects (cron).
  - verification_claim_pending    : service_role - atomically claim pending checks (SKIP LOCKED).
  - get_technician_verification_profile : authenticated - score, tier, blockers (manager: all, technician: self).
  - is_technician_externally_verified   : authenticated - boolean gate for dispatch / marketplace / claims.
  - record_background_consent     : technician (self only).

  ## Integrity rules
  - verified_primary only comes from a primary-source match (name + status + expiry); see _shared/verification-network/engine.ts.
  - A verified row whose expires_on has passed is treated as adverse at READ time, so a stale "verified"
    can never outlive the credential.
  - Authenticated users cannot insert/update/delete checks or events. Only the edge function (service role) writes.

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), public.get_my_team_member_id(),
  profiles, team_members(account_owner_id, role, member_name), technician_credentials, technician_insurance_policies.

  ## Scheduling (run once, after deploying the function; same pattern as your other cron jobs)
    select cron.schedule('verification-network-sweep', '0-59/10 * * * *', $$
      select net.http_post(
        url := '<project-ref>.supabase.co/functions/v1/verification-network',
        headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'Content-Type', 'application/json'),
        body := jsonb_build_object('action', 'sweep')
      );
    $$);
*/

-- 1) Sources -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  label text NOT NULL,
  kind text NOT NULL,
  jurisdiction text NOT NULL,
  provider text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vs_key_check CHECK (source_key ~ '^[a-z0-9_]{3,64}$'),
  CONSTRAINT vs_kind_check CHECK (kind IN ('license', 'insurance', 'background')),
  CONSTRAINT vs_provider_check CHECK (provider IN ('socrata')),
  CONSTRAINT vs_jurisdiction_check CHECK (jurisdiction ~ '^US-[A-Z]{2}$')
);
CREATE INDEX IF NOT EXISTS idx_vs_lookup ON verification_sources(kind, jurisdiction) WHERE active;

ALTER TABLE verification_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vs_select" ON verification_sources;
CREATE POLICY "vs_select" ON verification_sources FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON verification_sources FROM anon, authenticated;

-- 2) Checks --------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  kind text NOT NULL,
  subject_key text NOT NULL,
  credential_id uuid REFERENCES technician_credentials(id) ON DELETE SET NULL,
  insurance_policy_id uuid REFERENCES technician_insurance_policies(id) ON DELETE SET NULL,
  source_id uuid REFERENCES verification_sources(id) ON DELETE SET NULL,
  jurisdiction text,
  trade text,
  subject_identifier text,
  subject_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  method text,
  license_status text,
  holder_name text,
  name_match_score numeric(3, 2),
  classification text,
  expires_on date,
  disciplinary_flag boolean,
  coverage_cents bigint,
  carrier text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_sha256 text,
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  error_message text,
  requested_by uuid,
  checked_at timestamptz,
  next_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vc_kind_check CHECK (kind IN ('license', 'insurance', 'background')),
  CONSTRAINT vc_status_check CHECK (status IN ('pending', 'verified_primary', 'verified_document', 'needs_review', 'adverse', 'error')),
  CONSTRAINT vc_method_check CHECK (method IS NULL OR method IN ('primary_source_api', 'rules_engine', 'document_review', 'manual')),
  CONSTRAINT vc_final_has_time CHECK ((status = 'pending') = (checked_at IS NULL)),
  CONSTRAINT vc_jurisdiction_check CHECK (jurisdiction IS NULL OR jurisdiction ~ '^US-[A-Z]{2}$'),
  CONSTRAINT vc_error_len CHECK (error_message IS NULL OR length(error_message) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_vc_subject ON verification_checks(technician_id, kind, subject_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vc_owner ON verification_checks(account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vc_pending ON verification_checks(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_vc_due ON verification_checks(next_check_at) WHERE next_check_at IS NOT NULL;
-- At most one in-flight check per subject.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vc_one_pending
  ON verification_checks(technician_id, kind, subject_key) WHERE status = 'pending';

-- Finalised checks are evidence: immutable, except FK SET NULL when the underlying credential/policy is deleted.
CREATE OR REPLACE FUNCTION public.vc_protect_final()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending'
     AND (to_jsonb(NEW) - 'credential_id' - 'insurance_policy_id')
         IS DISTINCT FROM (to_jsonb(OLD) - 'credential_id' - 'insurance_policy_id') THEN
    RAISE EXCEPTION 'finalised verification checks are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_vc_protect_final ON verification_checks;
CREATE TRIGGER trg_vc_protect_final BEFORE UPDATE ON verification_checks
  FOR EACH ROW EXECUTE FUNCTION public.vc_protect_final();

ALTER TABLE verification_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vc_select" ON verification_checks;
CREATE POLICY "vc_select" ON verification_checks FOR SELECT TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id())
  );
REVOKE INSERT, UPDATE, DELETE ON verification_checks FROM anon, authenticated;

-- 3) Events (append-only) --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES verification_checks(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ve_type_check CHECK (event_type IN ('queued', 'completed', 'status_changed', 'manual_resolution', 'error'))
);
CREATE INDEX IF NOT EXISTS idx_ve_check ON verification_events(check_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ve_owner ON verification_events(account_owner_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ve_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'verification events are append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_ve_no_update ON verification_events;
CREATE TRIGGER trg_ve_no_update BEFORE UPDATE ON verification_events
  FOR EACH ROW EXECUTE FUNCTION public.ve_no_update();

ALTER TABLE verification_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ve_select" ON verification_events;
CREATE POLICY "ve_select" ON verification_events FOR SELECT TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id())
  );
REVOKE INSERT, UPDATE, DELETE ON verification_events FROM anon, authenticated;

-- 4) Background consent (the technician consents for themself, never a manager) ------------------
CREATE TABLE IF NOT EXISTS background_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  consent_version text NOT NULL DEFAULT 'v1',
  consented_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bc_tech ON background_consents(technician_id, consented_at DESC);

ALTER TABLE background_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bc_select" ON background_consents;
CREATE POLICY "bc_select" ON background_consents FOR SELECT TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND (public.identity_is_manager() OR technician_id = public.get_my_team_member_id())
  );
REVOKE INSERT, UPDATE, DELETE ON background_consents FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_background_consent(p_version text DEFAULT 'v1')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tid uuid := public.get_my_team_member_id();
  v_owner uuid;
  v_id uuid;
BEGIN
  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'only a technician can give background-check consent' USING ERRCODE = '42501';
  END IF;
  SELECT account_owner_id INTO v_owner FROM team_members WHERE id = v_tid;
  INSERT INTO background_consents (account_owner_id, technician_id, consent_version)
  VALUES (v_owner, v_tid, left(coalesce(nullif(btrim(p_version), ''), 'v1'), 20))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_background_consent(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_background_consent(text) TO authenticated;

-- 5) Current-state view ----------------------------------------------------------------------
CREATE OR REPLACE VIEW public.verification_current WITH (security_invoker = true) AS
SELECT DISTINCT ON (technician_id, kind, subject_key) *
FROM verification_checks
WHERE status <> 'pending'
ORDER BY technician_id, kind, subject_key, created_at DESC;

-- Explicit read grants (RLS still decides which rows); writes stay service-role only.
GRANT SELECT ON verification_sources, verification_checks, verification_events, background_consents, verification_current TO authenticated;

-- 6) Fingerprints (detect that a credential/policy changed since it was last checked) --------------
CREATE OR REPLACE FUNCTION public.verification_fingerprint_credential(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT md5(concat_ws('|', c.credential_number, c.issuing_authority, c.expires_at::text, c.status))
  FROM technician_credentials c WHERE c.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.verification_fingerprint_policy(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT md5(concat_ws('|', p.policy_type, p.carrier, p.policy_number, p.coverage_amount_cents::text,
                       p.expires_at::text, p.effective_date::text, p.status, (p.verified_at IS NOT NULL)::text))
  FROM technician_insurance_policies p WHERE p.id = p_id;
$$;
REVOKE ALL ON FUNCTION public.verification_fingerprint_credential(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verification_fingerprint_policy(uuid) FROM PUBLIC, anon, authenticated;

-- 7) Queue ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verification_enqueue_subject(
  p_owner uuid,
  p_technician uuid,
  p_kind text,
  p_credential uuid DEFAULT NULL,
  p_policy uuid DEFAULT NULL,
  p_jurisdiction text DEFAULT NULL,
  p_requested_by uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subject_key text;
  v_ident text;
  v_fp text;
  v_juris text := p_jurisdiction;
  v_trade text;
  v_attempts integer := 0;
  v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM team_members m
    WHERE m.id = p_technician AND m.account_owner_id = p_owner AND m.role = 'technician'
  ) THEN
    RAISE EXCEPTION 'technician not found in this account' USING ERRCODE = 'P0002';
  END IF;

  IF p_kind = 'license' THEN
    IF p_credential IS NULL THEN RAISE EXCEPTION 'credential required for a license check'; END IF;
    SELECT upper(regexp_replace(coalesce(c.credential_number, ''), '[^A-Za-z0-9-]', '', 'g')),
           c.credential_type
      INTO v_ident, v_trade
    FROM technician_credentials c
    WHERE c.id = p_credential AND c.technician_id = p_technician AND c.user_id = p_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'credential not found for this technician' USING ERRCODE = 'P0002'; END IF;
    v_subject_key := p_credential::text;
    v_fp := public.verification_fingerprint_credential(p_credential);
    IF v_juris IS NULL THEN
      SELECT k.jurisdiction INTO v_juris FROM verification_checks k
      WHERE k.technician_id = p_technician AND k.kind = 'license' AND k.subject_key = v_subject_key AND k.jurisdiction IS NOT NULL
      ORDER BY k.created_at DESC LIMIT 1;
    END IF;
  ELSIF p_kind = 'insurance' THEN
    IF p_policy IS NULL THEN RAISE EXCEPTION 'policy required for an insurance check'; END IF;
    PERFORM 1 FROM technician_insurance_policies p
    WHERE p.id = p_policy AND p.technician_id = p_technician AND p.account_owner_id = p_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'policy not found for this technician' USING ERRCODE = 'P0002'; END IF;
    v_subject_key := p_policy::text;
    v_fp := public.verification_fingerprint_policy(p_policy);
  ELSIF p_kind = 'background' THEN
    v_subject_key := 'technician';
    SELECT md5('bg|' || b.id::text) INTO v_fp FROM background_consents b
    WHERE b.technician_id = p_technician AND b.revoked_at IS NULL ORDER BY b.consented_at DESC LIMIT 1;
    v_fp := coalesce(v_fp, md5('bg|none'));
  ELSE
    RAISE EXCEPTION 'unknown verification kind';
  END IF;

  -- Retries after a provider error keep their attempt counter so backoff and the cap really work.
  SELECT k.attempts INTO v_attempts FROM verification_current k
  WHERE k.technician_id = p_technician AND k.kind = p_kind AND k.subject_key = v_subject_key AND k.status = 'error';
  v_attempts := coalesce(v_attempts, 0);

  INSERT INTO verification_checks (
    account_owner_id, technician_id, kind, subject_key, credential_id, insurance_policy_id,
    jurisdiction, trade, subject_identifier, subject_fingerprint, attempts, requested_by
  ) VALUES (
    p_owner, p_technician, p_kind, v_subject_key, p_credential, p_policy,
    v_juris, v_trade, nullif(v_ident, ''), v_fp, v_attempts, p_requested_by
  )
  ON CONFLICT (technician_id, kind, subject_key) WHERE status = 'pending' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM verification_checks
    WHERE technician_id = p_technician AND kind = p_kind AND subject_key = v_subject_key AND status = 'pending';
    RETURN v_id;
  END IF;

  INSERT INTO verification_events (check_id, account_owner_id, technician_id, event_type, actor_id, payload)
  VALUES (v_id, p_owner, p_technician, 'queued', p_requested_by,
          jsonb_build_object('kind', p_kind, 'automatic', p_requested_by IS NULL));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.verification_enqueue_subject(uuid, uuid, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verification_enqueue_subject(uuid, uuid, text, uuid, uuid, text, uuid) TO service_role;

-- Queue everything that is new, changed or due. Credentials count as licences when their type
-- mentions "licen[sc]e" or a licence check was ever requested for them (so EPA / training certs
-- are not dragged into a state-board lookup unless a manager opts them in).
CREATE OR REPLACE FUNCTION public.verification_enqueue_due(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    WITH lic AS (
      SELECT c.user_id AS owner_id, c.technician_id, 'license'::text AS kind, c.id AS cred_id, NULL::uuid AS pol_id,
             public.verification_fingerprint_credential(c.id) AS fp
      FROM technician_credentials c
      JOIN team_members m ON m.id = c.technician_id AND m.role = 'technician' AND m.account_owner_id = c.user_id
      WHERE c.status <> 'revoked'
        AND (c.credential_type ~* 'licen[sc]e'
             OR EXISTS (SELECT 1 FROM verification_checks k WHERE k.credential_id = c.id))
    ), ins AS (
      SELECT p.account_owner_id, p.technician_id, 'insurance'::text, NULL::uuid, p.id,
             public.verification_fingerprint_policy(p.id)
      FROM technician_insurance_policies p
      JOIN team_members m ON m.id = p.technician_id AND m.role = 'technician'
      WHERE p.status = 'active'
    ), subj AS (
      SELECT * FROM lic UNION ALL SELECT * FROM ins
    )
    SELECT s.owner_id, s.technician_id, s.kind, s.cred_id, s.pol_id
    FROM subj s
    LEFT JOIN LATERAL (
      SELECT k.subject_fingerprint, k.next_check_at FROM verification_current k
      WHERE k.technician_id = s.technician_id AND k.kind = s.kind
        AND k.subject_key = coalesce(s.cred_id, s.pol_id)::text
    ) cur ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM verification_checks q
      WHERE q.technician_id = s.technician_id AND q.kind = s.kind
        AND q.subject_key = coalesce(s.cred_id, s.pol_id)::text AND q.status = 'pending'
    )
    AND (cur.subject_fingerprint IS NULL
         OR cur.subject_fingerprint IS DISTINCT FROM s.fp
         OR (cur.next_check_at IS NOT NULL AND cur.next_check_at <= now()))
    LIMIT p_limit
  LOOP
    PERFORM public.verification_enqueue_subject(r.owner_id, r.technician_id, r.kind, r.cred_id, r.pol_id);
    v_count := v_count + 1;
  END LOOP;

  -- Background checks are never auto-enrolled; only re-queued when a previous result is due.
  FOR r IN
    SELECT k.account_owner_id, k.technician_id FROM verification_current k
    WHERE k.kind = 'background' AND k.next_check_at IS NOT NULL AND k.next_check_at <= now()
      AND NOT EXISTS (SELECT 1 FROM verification_checks q WHERE q.technician_id = k.technician_id AND q.kind = 'background' AND q.status = 'pending')
    LIMIT p_limit
  LOOP
    PERFORM public.verification_enqueue_subject(r.account_owner_id, r.technician_id, 'background');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.verification_enqueue_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verification_enqueue_due(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.verification_claim_pending(p_limit integer DEFAULT 25, p_id uuid DEFAULT NULL)
RETURNS SETOF verification_checks
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE verification_checks k
  SET claimed_at = now(), attempts = k.attempts + 1
  WHERE k.id IN (
    SELECT q.id FROM verification_checks q
    WHERE q.status = 'pending'
      AND (p_id IS NULL OR q.id = p_id)
      AND (q.claimed_at IS NULL OR q.claimed_at < now() - interval '10 minutes')
    ORDER BY q.created_at
    LIMIT greatest(1, least(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  )
  RETURNING k.*;
$$;
REVOKE ALL ON FUNCTION public.verification_claim_pending(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verification_claim_pending(integer, uuid) TO service_role;

-- 8) Verification profile (score, tier, blockers) ------------------------------------------------
-- Score 0-100: license 40 + insurance 35 (+ background 25 only if a background result exists),
-- renormalised. Per subject: primary-source 100, document-verified 80, needs-review/error 25,
-- adverse/unchecked 0; verified values decay with age (<=60d x1, <=120d x0.8, <=240d x0.5, else x0.25).
CREATE OR REPLACE FUNCTION public.get_technician_verification_profile(p_technician_id uuid DEFAULT NULL)
RETURNS TABLE (
  technician_id uuid,
  technician_name text,
  verification_score integer,
  tier text,
  blockers jsonb,
  kinds jsonb,
  pending_count integer,
  last_verified_at timestamptz,
  generated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH owner AS (SELECT public.get_account_owner_id() AS id),
  techs AS (
    SELECT tm.id, tm.member_name
    FROM team_members tm, owner
    WHERE tm.account_owner_id = owner.id
      AND tm.role = 'technician'
      AND (p_technician_id IS NULL OR tm.id = p_technician_id)
      AND (public.identity_is_manager() OR tm.id = public.get_my_team_member_id())
  ),
  cur AS (
    SELECT v.technician_id, v.kind, v.credential_id, v.insurance_policy_id, v.checked_at, v.disciplinary_flag,
      CASE WHEN v.status IN ('verified_primary', 'verified_document') AND v.expires_on IS NOT NULL AND v.expires_on < current_date
           THEN 'adverse' ELSE v.status END AS eff,
      CASE WHEN v.status IN ('verified_primary', 'verified_document') AND v.expires_on IS NOT NULL AND v.expires_on < current_date
           THEN 'expired_since_check' ELSE v.reason END AS eff_reason
    FROM verification_current v
    WHERE v.technician_id IN (SELECT id FROM techs)
  ),
  subjects AS (
    SELECT t.id AS tid, 'license'::text AS kind, c.id AS sid
    FROM techs t JOIN technician_credentials c ON c.technician_id = t.id AND c.status <> 'revoked'
    WHERE c.credential_type ~* 'licen[sc]e'
       OR EXISTS (SELECT 1 FROM verification_checks k WHERE k.credential_id = c.id)
    UNION ALL
    SELECT t.id, 'insurance', p.id
    FROM techs t JOIN technician_insurance_policies p ON p.technician_id = t.id AND p.status = 'active'
    UNION ALL
    SELECT DISTINCT cu.technician_id, 'background', NULL::uuid FROM cur cu WHERE cu.kind = 'background'
  ),
  scored AS (
    SELECT s.tid, s.kind, v.eff, v.eff_reason, v.disciplinary_flag, v.checked_at,
      (CASE v.eff
         WHEN 'verified_primary' THEN 100 WHEN 'verified_document' THEN 80
         WHEN 'needs_review' THEN 25 WHEN 'error' THEN 25 ELSE 0 END)
      * (CASE WHEN v.eff IN ('verified_primary', 'verified_document') THEN
           CASE WHEN now() - v.checked_at <= interval '60 days' THEN 1.0
                WHEN now() - v.checked_at <= interval '120 days' THEN 0.8
                WHEN now() - v.checked_at <= interval '240 days' THEN 0.5
                ELSE 0.25 END
         ELSE 1.0 END) AS val
    FROM subjects s
    LEFT JOIN cur v ON v.technician_id = s.tid AND v.kind = s.kind
      AND ((s.kind = 'license' AND v.credential_id = s.sid)
        OR (s.kind = 'insurance' AND v.insurance_policy_id = s.sid)
        OR s.kind = 'background')
  ),
  kind_agg AS (
    SELECT tid, kind,
      count(*) AS n,
      avg(val) AS comp,
      count(*) FILTER (WHERE eff IN ('verified_primary', 'verified_document')) AS verified_n,
      count(*) FILTER (WHERE eff = 'adverse') AS adverse_n,
      count(*) FILTER (WHERE eff IN ('needs_review', 'error')) AS review_n,
      count(*) FILTER (WHERE eff IS NULL) AS unchecked_n,
      count(*) FILTER (WHERE disciplinary_flag IS TRUE) AS disciplinary_n
    FROM scored GROUP BY tid, kind
  ),
  per_tech AS (
    SELECT t.id AS tid, t.member_name,
      (40 * coalesce(l.comp, 0) + 35 * coalesce(i.comp, 0) + CASE WHEN b.n IS NOT NULL THEN 25 * coalesce(b.comp, 0) ELSE 0 END)
        / (75 + CASE WHEN b.n IS NOT NULL THEN 25 ELSE 0 END) AS score_raw,
      coalesce(l.n, 0) AS lic_n, coalesce(i.n, 0) AS ins_n,
      coalesce(l.adverse_n, 0) + coalesce(i.adverse_n, 0) + coalesce(b.adverse_n, 0) AS adverse_total,
      coalesce(l.disciplinary_n, 0) AS disc_total,
      (coalesce(l.n, 0) > 0 AND coalesce(l.verified_n, 0) = l.n
        AND coalesce(i.n, 0) > 0 AND coalesce(i.verified_n, 0) = i.n
        AND (b.n IS NULL OR b.verified_n = b.n)) AS all_verified
    FROM techs t
    LEFT JOIN kind_agg l ON l.tid = t.id AND l.kind = 'license'
    LEFT JOIN kind_agg i ON i.tid = t.id AND i.kind = 'insurance'
    LEFT JOIN kind_agg b ON b.tid = t.id AND b.kind = 'background'
  )
  SELECT
    p.tid,
    p.member_name,
    round(p.score_raw)::integer,
    CASE
      WHEN p.adverse_total > 0 OR p.disc_total > 0 THEN 'attention'
      WHEN p.all_verified AND p.score_raw >= 75 THEN 'verified'
      WHEN p.score_raw >= 40 THEN 'partially_verified'
      ELSE 'unverified'
    END,
    (
      SELECT coalesce(jsonb_agg(x.b), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('code', 'adverse_' || ka.kind, 'kind', ka.kind, 'count', ka.adverse_n) AS b
        FROM kind_agg ka WHERE ka.tid = p.tid AND ka.adverse_n > 0
        UNION ALL
        SELECT jsonb_build_object('code', 'disciplinary_action', 'kind', 'license', 'count', ka.disciplinary_n)
        FROM kind_agg ka WHERE ka.tid = p.tid AND ka.disciplinary_n > 0
        UNION ALL
        SELECT jsonb_build_object('code', 'unverified_' || ka.kind, 'kind', ka.kind, 'count', ka.n - ka.verified_n - ka.adverse_n)
        FROM kind_agg ka WHERE ka.tid = p.tid AND ka.n - ka.verified_n - ka.adverse_n > 0
        UNION ALL
        SELECT jsonb_build_object('code', 'no_license_on_file', 'kind', 'license', 'count', 0) WHERE p.lic_n = 0
        UNION ALL
        SELECT jsonb_build_object('code', 'no_insurance_on_file', 'kind', 'insurance', 'count', 0) WHERE p.ins_n = 0
      ) x
    ),
    (
      SELECT coalesce(jsonb_object_agg(ka.kind, jsonb_build_object(
        'subjects', ka.n, 'verified', ka.verified_n, 'adverse', ka.adverse_n,
        'needs_review', ka.review_n, 'unchecked', ka.unchecked_n)), '{}'::jsonb)
      FROM kind_agg ka WHERE ka.tid = p.tid
    ),
    (SELECT count(*)::integer FROM verification_checks q WHERE q.technician_id = p.tid AND q.status = 'pending'),
    (SELECT max(cu.checked_at) FROM cur cu WHERE cu.technician_id = p.tid AND cu.eff IN ('verified_primary', 'verified_document')),
    now()
  FROM per_tech p
  ORDER BY p.member_name;
$$;
REVOKE ALL ON FUNCTION public.get_technician_verification_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_technician_verification_profile(uuid) TO authenticated;

-- One boolean for dispatch gates, marketplace admission, insurance-claim assignment, franchise rules.
CREATE OR REPLACE FUNCTION public.is_technician_externally_verified(p_technician_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT p.tier = 'verified' FROM public.get_technician_verification_profile(p_technician_id) p LIMIT 1), false);
$$;
REVOKE ALL ON FUNCTION public.is_technician_externally_verified(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_technician_externally_verified(uuid) TO authenticated;
