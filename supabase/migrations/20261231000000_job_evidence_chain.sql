/*
  # Vireek Job Evidence Chain

  Problem -> Diagnosis -> Evidence -> Recommendation -> Customer Approval -> Part
  -> Technician -> Work -> Test -> Result -> Payment -> Warranty

  ## What this adds
  - job_evidence_chain_entries : append-only, per-job, SHA-256 hash-chained ledger.
      * Immutable (UPDATE/DELETE/TRUNCATE blocked; corrections are new entries that `supersede` old ones).
      * Server-authoritative: seq, prev_hash, entry_hash, recorded_at, actor identity are set by a
        BEFORE INSERT trigger — the client cannot forge them.
      * `refs` = "because of": an entry can point at earlier entries that justify it
        (Work -> Diagnosis + Evidence). Validated to belong to the same job.
      * `media` = [{path, sha256, mime, bytes, captured_at}] — file fingerprints are inside the hash.
  - Automatic capture (fail-safe, never blocks the source write) from tables that already exist:
      jobs, quotes, diagnosis_sessions, job_evidence_checks, job_parts_required, job_outcomes,
      payment_requests, warranty_claims. Uses to_jsonb(NEW) so it does not depend on exact columns.
  - job_evidence_chain_report(job)   : per-stage status, linkage gaps, score, level, integrity.
  - job_evidence_chain_verify(job)   : recomputes the whole hash chain.
  - job_evidence_chain_portfolio()   : per-job summary for the dashboard.
  - job_evidence_chain_requirements  : OPT-IN per service_type gate on closing a job
      (`JOB_EVIDENCE_CHAIN_BLOCKED: <gap>,<gap>`). Default = off, nothing changes until enabled.
  - Private storage bucket `job-evidence-chain` (tenant-scoped by account owner id, write-once for clients).

  Nothing existing is modified. Safe to run on top of the current schema.
*/

-- =============================================================
-- 0. STORAGE
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'job-evidence-chain', 'job-evidence-chain', false, 26214400,
  ARRAY['image/jpeg','image/png','image/webp','image/heic','video/mp4','video/quicktime','video/webm','application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "evc_media_select" ON storage.objects;
CREATE POLICY "evc_media_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'job-evidence-chain' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "evc_media_insert" ON storage.objects;
CREATE POLICY "evc_media_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'job-evidence-chain' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
-- No UPDATE / DELETE policy on purpose: evidence files are write-once for clients.

-- =============================================================
-- 1. LEDGER TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_evidence_chain_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0,
  stage text NOT NULL CHECK (stage IN (
    'problem','diagnosis','evidence','recommendation','customer_approval','part',
    'technician','work','test','result','payment','warranty'
  )),
  kind text NOT NULL DEFAULT 'statement'
    CHECK (kind IN ('statement','measurement','media','test','approval','part','system')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 4000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  media jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(media) = 'array' AND jsonb_array_length(media) <= 12),
  refs uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(refs) <= 20),
  supersedes_id uuid,
  actor_type text NOT NULL DEFAULT 'staff'
    CHECK (actor_type IN ('technician','staff','customer','ai','system')),
  actor_user_id uuid,
  actor_team_member_id uuid,
  actor_name text,
  latitude numeric,
  longitude numeric,
  source_key text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash text,
  entry_hash text NOT NULL DEFAULT '',
  UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_evc_entries_job ON public.job_evidence_chain_entries (job_id, seq);
CREATE INDEX IF NOT EXISTS idx_evc_entries_user ON public.job_evidence_chain_entries (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evc_entries_source_key
  ON public.job_evidence_chain_entries (job_id, source_key) WHERE source_key IS NOT NULL;

COMMENT ON TABLE public.job_evidence_chain_entries IS
  'Append-only, hash-chained evidence ledger per job. Never UPDATE/DELETE: add a superseding entry instead.';

-- Canonical hash of one entry (used by the seal trigger AND the verifier)
CREATE OR REPLACE FUNCTION public.evc_entry_hash(e public.job_evidence_chain_entries)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    coalesce(e.prev_hash, 'GENESIS'),
    e.job_id::text,
    e.seq::text,
    e.stage,
    e.kind,
    e.title,
    coalesce(e.detail, ''),
    e.payload::text,
    e.media::text,
    array_to_string(e.refs, ','),
    coalesce(e.supersedes_id::text, ''),
    e.actor_type,
    coalesce(e.actor_user_id::text, ''),
    coalesce(e.actor_team_member_id::text, ''),
    coalesce(e.actor_name, ''),
    coalesce(e.source_key, ''),
    to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

-- BEFORE INSERT: assign seq, link to previous hash, stamp server time + real actor, seal.
CREATE OR REPLACE FUNCTION public.evc_seal_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_last_seq integer;
  v_last_hash text;
  v_system boolean := coalesce(current_setting('vireek.evidence_system', true), 'off') = 'on';
  v_tm uuid;
  v_name text;
  v_role text;
BEGIN
  SELECT user_id INTO v_owner FROM public.jobs WHERE id = NEW.job_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_INVALID: unknown job' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize writers per job so seq / prev_hash can never fork.
  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:evidence-chain:' || NEW.job_id::text, 0));

  SELECT seq, entry_hash INTO v_last_seq, v_last_hash
  FROM public.job_evidence_chain_entries
  WHERE job_id = NEW.job_id
  ORDER BY seq DESC
  LIMIT 1;

  IF cardinality(NEW.refs) > 0 THEN
    IF (SELECT count(*) FROM public.job_evidence_chain_entries e
        WHERE e.job_id = NEW.job_id AND e.id = ANY (NEW.refs))
       <> (SELECT count(DISTINCT r) FROM unnest(NEW.refs) AS r) THEN
      RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_INVALID: refs must point to earlier entries of the same job' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.job_evidence_chain_entries e
    WHERE e.id = NEW.supersedes_id AND e.job_id = NEW.job_id
  ) THEN
    RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_INVALID: superseded entry not found on this job' USING ERRCODE = 'P0001';
  END IF;

  NEW.user_id := v_owner;
  NEW.seq := coalesce(v_last_seq, 0) + 1;
  NEW.prev_hash := v_last_hash;
  NEW.recorded_at := clock_timestamp();

  IF NOT v_system THEN
    IF NEW.kind = 'system' THEN
      RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_INVALID: system entries cannot be created manually' USING ERRCODE = 'P0001';
    END IF;

    IF auth.uid() IS NOT NULL THEN
      SELECT tm.id, tm.member_name, tm.role INTO v_tm, v_name, v_role
      FROM public.team_members tm WHERE tm.user_id = auth.uid() LIMIT 1;
      IF v_name IS NULL THEN
        SELECT u.email INTO v_name FROM auth.users u WHERE u.id = auth.uid();
      END IF;
    END IF;

    NEW.actor_user_id := auth.uid();
    NEW.actor_team_member_id := v_tm;
    NEW.actor_name := v_name;
    NEW.actor_type := CASE WHEN v_role = 'technician' THEN 'technician' ELSE 'staff' END;
    NEW.source_key := NULL;
  END IF;

  NEW.entry_hash := public.evc_entry_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evc_seal_entry ON public.job_evidence_chain_entries;
CREATE TRIGGER trg_evc_seal_entry
  BEFORE INSERT ON public.job_evidence_chain_entries
  FOR EACH ROW EXECUTE FUNCTION public.evc_seal_entry();

-- Immutability. Deleting a whole job (FK cascade) is the only permitted delete.
CREATE OR REPLACE FUNCTION public.evc_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_IMMUTABLE: evidence entries are append-only; add a superseding entry instead' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_evc_block_mutation ON public.job_evidence_chain_entries;
CREATE TRIGGER trg_evc_block_mutation
  BEFORE UPDATE OR DELETE ON public.job_evidence_chain_entries
  FOR EACH ROW EXECUTE FUNCTION public.evc_block_mutation();

CREATE OR REPLACE FUNCTION public.evc_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_IMMUTABLE: evidence ledger cannot be truncated' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_evc_block_truncate ON public.job_evidence_chain_entries;
CREATE TRIGGER trg_evc_block_truncate
  BEFORE TRUNCATE ON public.job_evidence_chain_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.evc_block_truncate();

-- RLS: same tenant model as the rest of the project; job visibility is inherited from jobs' own RLS.
ALTER TABLE public.job_evidence_chain_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evc_entries_select" ON public.job_evidence_chain_entries;
CREATE POLICY "evc_entries_select" ON public.job_evidence_chain_entries FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_evidence_chain_entries.job_id)
  );

DROP POLICY IF EXISTS "evc_entries_insert" ON public.job_evidence_chain_entries;
CREATE POLICY "evc_entries_insert" ON public.job_evidence_chain_entries FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_evidence_chain_entries.job_id)
  );
-- No UPDATE / DELETE policies: append-only.

-- =============================================================
-- 2. SYSTEM (AUTOMATIC) ENTRIES
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_job_evidence_system(
  p_job_id uuid,
  p_stage text,
  p_kind text,
  p_title text,
  p_detail text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_actor_type text DEFAULT 'system',
  p_source_key text DEFAULT NULL,
  p_refs uuid[] DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_tm uuid;
  v_name text;
  v_uid uuid;
BEGIN
  IF p_source_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.job_evidence_chain_entries WHERE job_id = p_job_id AND source_key = p_source_key
  ) THEN
    RETURN NULL;
  END IF;

  -- For system-type entries triggered by a signed-in user (e.g. a technician marking a part
  -- installed) keep that person on the record. Customer / AI entries never carry a staff identity.
  IF p_actor_type = 'system' AND auth.uid() IS NOT NULL THEN
    v_uid := auth.uid();
    SELECT tm.id, tm.member_name INTO v_tm, v_name FROM public.team_members tm WHERE tm.user_id = v_uid LIMIT 1;
  END IF;

  PERFORM set_config('vireek.evidence_system', 'on', true);
  INSERT INTO public.job_evidence_chain_entries
    (job_id, stage, kind, title, detail, payload, actor_type, actor_user_id, actor_team_member_id, actor_name, source_key, refs)
  VALUES
    (p_job_id, p_stage, p_kind, left(p_title, 200), left(p_detail, 4000), coalesce(p_payload, '{}'::jsonb),
     p_actor_type, v_uid, v_tm, v_name, p_source_key, coalesce(p_refs, '{}'))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  PERFORM set_config('vireek.evidence_system', 'off', true);

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evidence_system', 'off', true);
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_job_evidence_system(uuid, text, text, text, text, jsonb, text, text, uuid[]) FROM PUBLIC, anon, authenticated;

-- Mirrors a quote's current state onto a job: Recommendation (sent) + Customer Approval (accepted).
CREATE OR REPLACE FUNCTION public.evc_sync_quote(p_job_id uuid, p_quote_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q record;
  v_rec uuid;
BEGIN
  SELECT id, status, sent_at, responded_at,
         CASE WHEN jsonb_typeof(line_items) = 'array' THEN jsonb_array_length(line_items) ELSE 0 END AS items
  INTO q FROM public.quotes WHERE id = p_quote_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF q.sent_at IS NOT NULL OR q.status IN ('sent', 'accepted', 'declined', 'expired') THEN
    PERFORM public.record_job_evidence_system(
      p_job_id, 'recommendation', 'system', 'Estimate presented to customer',
      q.items || ' line item(s)',
      jsonb_build_object('quote_id', q.id, 'sent_at', q.sent_at, 'quote_status', q.status),
      'system', 'quote-sent:' || q.id
    );
  END IF;

  IF q.status = 'accepted' THEN
    SELECT id INTO v_rec FROM public.job_evidence_chain_entries
    WHERE job_id = p_job_id AND source_key = 'quote-sent:' || q.id;
    PERFORM public.record_job_evidence_system(
      p_job_id, 'customer_approval', 'approval', 'Customer accepted the estimate', NULL,
      jsonb_build_object('quote_id', q.id, 'accepted_at', q.responded_at, 'method', 'online_quote'),
      'customer', 'quote-accepted:' || q.id,
      CASE WHEN v_rec IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_rec] END
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.evc_sync_quote(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- One capture function for all source tables. It can NEVER break the source write.
CREATE OR REPLACE FUNCTION public.evc_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_job uuid;
  v_name text;
  v_rep jsonb;
  v_photos integer;
BEGIN
  BEGIN
    CASE TG_TABLE_NAME

      WHEN 'jobs' THEN
        IF TG_OP = 'INSERT' THEN
          PERFORM public.record_job_evidence_system(
            NEW.id, 'problem', 'system', 'Service request opened',
            coalesce(r->>'service_type', 'General service'),
            jsonb_strip_nulls(jsonb_build_object(
              'call_id', r->>'call_id', 'lead_id', r->>'lead_id', 'customer_type', r->>'customer_type'
            )),
            'system', 'job-created'
          );
        END IF;

        IF r->>'assigned_technician_id' IS NOT NULL
           AND (TG_OP = 'INSERT' OR r->>'assigned_technician_id' IS DISTINCT FROM o->>'assigned_technician_id') THEN
          SELECT tm.member_name INTO v_name FROM public.team_members tm
          WHERE tm.id = (r->>'assigned_technician_id')::uuid;
          PERFORM public.record_job_evidence_system(
            NEW.id, 'technician', 'system', 'Technician assigned', v_name,
            jsonb_build_object('technician_id', r->>'assigned_technician_id', 'technician_name', v_name),
            'system', NULL
          );
        END IF;

        IF r->>'quote_id' IS NOT NULL
           AND (TG_OP = 'INSERT' OR r->>'quote_id' IS DISTINCT FROM o->>'quote_id') THEN
          PERFORM public.evc_sync_quote(NEW.id, (r->>'quote_id')::uuid);
        END IF;

        IF r->>'customer_signature_at' IS NOT NULL
           AND r->>'customer_signature_at' IS DISTINCT FROM o->>'customer_signature_at' THEN
          PERFORM public.record_job_evidence_system(
            NEW.id, 'result', 'approval', 'Customer signed off on completed work',
            r->>'customer_signature_name',
            jsonb_strip_nulls(jsonb_build_object(
              'phase', 'completion_signoff', 'signed_by', r->>'customer_signature_name',
              'signed_at', r->>'customer_signature_at'
            )),
            'customer', 'signoff:' || (r->>'customer_signature_at')
          );
        END IF;

        IF TG_OP = 'UPDATE' AND r->>'job_status' = 'completed' AND o->>'job_status' IS DISTINCT FROM 'completed' THEN
          v_rep := public.job_evidence_chain_report(NEW.id);
          IF v_rep IS NOT NULL THEN
            PERFORM public.record_job_evidence_system(
              NEW.id, 'result', 'system', 'Evidence chain snapshot at close', NULL,
              jsonb_build_object(
                'snapshot', true,
                'score', v_rep->'score',
                'level', v_rep->'level',
                'blocking_gaps', coalesce(v_rep->'blocking_gaps', '[]'::jsonb),
                'integrity_valid', v_rep->'integrity'->'valid'
              ),
              'system', NULL
            );
          END IF;
        END IF;

      WHEN 'diagnosis_sessions' THEN
        IF r->>'job_id' IS NOT NULL THEN
          v_job := (r->>'job_id')::uuid;
          v_photos := CASE WHEN jsonb_typeof(r->'photo_paths') = 'array' THEN jsonb_array_length(r->'photo_paths') ELSE 0 END;
          IF coalesce(btrim(r->>'meter_readings'), '') <> '' THEN
            PERFORM public.record_job_evidence_system(
              v_job, 'evidence', 'system', 'Meter readings captured', left(r->>'meter_readings', 1000),
              jsonb_build_object('session_id', r->>'id', 'photo_count', v_photos),
              'ai', 'diag-meter:' || (r->>'id')
            );
          END IF;
          PERFORM public.record_job_evidence_system(
            v_job, 'diagnosis', 'system', 'AI diagnosis session', left(r->>'symptoms', 1000),
            jsonb_strip_nulls(jsonb_build_object(
              'session_id', r->>'id', 'severity', r->>'severity', 'confidence', r->'confidence',
              'equipment_label', r->>'equipment_label', 'photo_count', v_photos
            )),
            'ai', 'diag:' || (r->>'id')
          );
        END IF;

      WHEN 'job_evidence_checks' THEN
        IF r->>'job_id' IS NOT NULL THEN
          PERFORM public.record_job_evidence_system(
            (r->>'job_id')::uuid, 'evidence', 'system', 'Photo evidence verified by AI', left(r->>'ai_summary', 1000),
            jsonb_strip_nulls(jsonb_build_object(
              'check_id', r->>'id', 'verdict', r->>'verdict', 'completeness', r->'evidence_completeness',
              'photo_count', CASE WHEN jsonb_typeof(r->'photo_paths') = 'array' THEN jsonb_array_length(r->'photo_paths') ELSE 0 END,
              'detected_serials', r->'detected_serials'
            )),
            'ai', 'evc:' || (r->>'id')
          );
        END IF;

      WHEN 'job_parts_required' THEN
        IF r->>'job_id' IS NOT NULL AND r->>'status' = 'installed'
           AND (TG_OP = 'INSERT' OR o->>'status' IS DISTINCT FROM 'installed') THEN
          SELECT to_jsonb(p)->>'name' INTO v_name FROM public.inventory_parts p WHERE p.id = (r->>'part_id')::uuid;
          PERFORM public.record_job_evidence_system(
            (r->>'job_id')::uuid, 'part', 'part', 'Part installed', v_name,
            jsonb_strip_nulls(jsonb_build_object(
              'part_id', r->>'part_id', 'part_name', v_name, 'quantity', r->'quantity_required'
            )),
            'system', 'part:' || (r->>'id')
          );
        END IF;

      WHEN 'job_outcomes' THEN
        IF r->>'job_id' IS NOT NULL THEN
          PERFORM public.record_job_evidence_system(
            (r->>'job_id')::uuid, 'result', 'system',
            'Outcome recorded: ' || replace(coalesce(r->>'resolution', 'unknown'), '_', ' '), NULL,
            jsonb_strip_nulls(jsonb_build_object(
              'resolution', r->>'resolution', 'is_rework', r->'is_rework',
              'caused_callback', r->'caused_callback', 'customer_rating', r->'customer_rating'
            )),
            'system', 'outcome:' || (r->>'id')
          );
        END IF;

      WHEN 'payment_requests' THEN
        IF r->>'job_id' IS NOT NULL AND r->>'status' = 'paid'
           AND (TG_OP = 'INSERT' OR o->>'status' IS DISTINCT FROM 'paid') THEN
          PERFORM public.record_job_evidence_system(
            (r->>'job_id')::uuid, 'payment', 'system', 'Payment received', NULL,
            jsonb_strip_nulls(jsonb_build_object(
              'payment_request_id', r->>'id', 'amount', r->'amount', 'currency', r->>'currency', 'paid_at', r->>'paid_at'
            )),
            'customer', 'pay:' || (r->>'id')
          );
        END IF;

      WHEN 'warranty_claims' THEN
        IF r->>'job_id' IS NOT NULL THEN
          PERFORM public.record_job_evidence_system(
            (r->>'job_id')::uuid, 'warranty', 'system', 'Warranty claim opened', left(r->>'failure_description', 500),
            jsonb_strip_nulls(jsonb_build_object(
              'claim_id', r->>'id', 'claim_status', r->>'status',
              'warranty_expires_at', r->>'warranty_expires_at', 'claim_deadline', r->>'claim_deadline'
            )),
            'system', 'warranty-claim:' || (r->>'id')
          );
        END IF;

      WHEN 'quotes' THEN
        FOR v_job IN SELECT j.id FROM public.jobs j WHERE j.quote_id = NEW.id LOOP
          PERFORM public.evc_sync_quote(v_job, NEW.id);
        END LOOP;

      ELSE
        NULL;
    END CASE;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'job evidence chain capture skipped (%): %', TG_TABLE_NAME, SQLERRM;
  END;

  RETURN NULL;
END;
$$;

-- Attach triggers only where the tables exist (safe on partially migrated environments).
DO $$
DECLARE
  t text;
BEGIN
  IF to_regclass('public.jobs') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_evc_capture_jobs_ins ON public.jobs;
    CREATE TRIGGER trg_evc_capture_jobs_ins
      AFTER INSERT ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.evc_capture();

    DROP TRIGGER IF EXISTS trg_evc_capture_jobs_upd ON public.jobs;
    CREATE TRIGGER trg_evc_capture_jobs_upd
      AFTER UPDATE ON public.jobs
      FOR EACH ROW
      WHEN (
        OLD.assigned_technician_id IS DISTINCT FROM NEW.assigned_technician_id
        OR OLD.customer_signature_at IS DISTINCT FROM NEW.customer_signature_at
        OR OLD.job_status IS DISTINCT FROM NEW.job_status
        OR OLD.quote_id IS DISTINCT FROM NEW.quote_id
      )
      EXECUTE FUNCTION public.evc_capture();
  END IF;

  IF to_regclass('public.quotes') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_evc_capture ON public.quotes;
    CREATE TRIGGER trg_evc_capture
      AFTER UPDATE ON public.quotes
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION public.evc_capture();
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'diagnosis_sessions', 'job_evidence_checks', 'job_parts_required',
    'job_outcomes', 'payment_requests', 'warranty_claims'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_evc_capture ON public.%I', t);
      EXECUTE format(
        'CREATE TRIGGER trg_evc_capture AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.evc_capture()',
        t
      );
    END IF;
  END LOOP;
END
$$;

-- =============================================================
-- 3. VERIFY + REPORT (SECURITY INVOKER: RLS decides what the caller can see)
-- =============================================================

CREATE OR REPLACE FUNCTION public.evc_active(p_job_id uuid)
RETURNS SETOF public.job_evidence_chain_entries
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT e.*
  FROM public.job_evidence_chain_entries e
  WHERE e.job_id = p_job_id
    AND coalesce(e.payload->>'snapshot', 'false') <> 'true'
    AND NOT EXISTS (
      SELECT 1 FROM public.job_evidence_chain_entries s
      WHERE s.job_id = e.job_id AND s.supersedes_id = e.id
    );
$$;

CREATE OR REPLACE FUNCTION public.job_evidence_chain_verify(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  r public.job_evidence_chain_entries;
  v_expected integer := 1;
  v_prev text := NULL;
  v_count integer := 0;
  v_broken integer;
  v_reason text;
BEGIN
  FOR r IN SELECT * FROM public.job_evidence_chain_entries WHERE job_id = p_job_id ORDER BY seq LOOP
    v_count := v_count + 1;
    IF r.seq <> v_expected THEN
      v_broken := r.seq; v_reason := 'sequence_gap'; EXIT;
    END IF;
    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      v_broken := r.seq; v_reason := 'broken_link'; EXIT;
    END IF;
    IF r.entry_hash <> public.evc_entry_hash(r) THEN
      v_broken := r.seq; v_reason := 'hash_mismatch'; EXIT;
    END IF;
    v_prev := r.entry_hash;
    v_expected := v_expected + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'valid', v_broken IS NULL,
    'entries', v_count,
    'broken_seq', v_broken,
    'reason', v_reason,
    'head_hash', v_prev
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.evc_gap(p_key text, p_stage text, p_severity text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('key', p_key, 'stage', p_stage, 'severity', p_severity);
$$;

CREATE OR REPLACE FUNCTION public.evc_stage(p_stage text, p_applicable boolean, p_satisfied boolean, p_count integer, p_weight integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'stage', p_stage,
    'status', CASE WHEN NOT p_applicable THEN 'not_applicable' WHEN p_satisfied THEN 'complete' ELSE 'missing' END,
    'applicable', p_applicable,
    'satisfied', p_satisfied,
    'count', p_count,
    'weight', p_weight
  );
$$;

CREATE OR REPLACE FUNCTION public.job_evidence_chain_report(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_job jsonb;
  v_integrity jsonb;
  v_cnt jsonb;
  v_chargeable boolean;
  v_assigned boolean;
  v_has_work boolean;
  v_replaces_part boolean;
  v_emergency boolean;
  v_work_min integer;
  v_work_max integer;
  v_first_approval integer;
  v_test_seq integer;
  v_test_passed boolean;
  v_unsupported integer := 0;
  v_unjustified integer := 0;
  v_pair_meas boolean;
  v_pair_media boolean;
  v_before_photos integer;
  v_after_photos integer;

  c_problem integer; c_diagnosis integer; c_evidence integer; c_recommendation integer;
  c_approval integer; c_part integer; c_technician integer; c_work integer; c_test integer;
  c_result integer; c_payment integer; c_warranty integer;

  ok_problem boolean; ok_diagnosis boolean; ok_evidence boolean; ok_recommendation boolean;
  ok_approval boolean; ok_part boolean; ok_technician boolean; ok_work boolean; ok_test boolean;
  ok_result boolean; ok_payment boolean; ok_warranty boolean;
  app_approval boolean; app_part boolean; app_payment boolean;

  v_stages jsonb;
  v_gaps jsonb := '[]'::jsonb;
  v_blocking jsonb;
  v_blocking_count integer;
  v_base numeric;
  v_penalty integer := 0;
  v_score integer;
  v_level text;
  v_entries integer;
  v_verified integer;
  v_manual integer;
  v_media integer;
BEGIN
  SELECT to_jsonb(j) INTO v_job FROM public.jobs j WHERE j.id = p_job_id;
  IF v_job IS NULL THEN
    RETURN NULL;
  END IF;

  v_integrity := public.job_evidence_chain_verify(p_job_id);

  SELECT coalesce(jsonb_object_agg(stage, c), '{}'::jsonb) INTO v_cnt
  FROM (SELECT a.stage, count(*) AS c FROM public.evc_active(p_job_id) a GROUP BY a.stage) s;

  c_problem := coalesce((v_cnt->>'problem')::integer, 0);
  c_diagnosis := coalesce((v_cnt->>'diagnosis')::integer, 0);
  c_evidence := coalesce((v_cnt->>'evidence')::integer, 0);
  c_recommendation := coalesce((v_cnt->>'recommendation')::integer, 0);
  c_approval := coalesce((v_cnt->>'customer_approval')::integer, 0);
  c_part := coalesce((v_cnt->>'part')::integer, 0);
  c_technician := coalesce((v_cnt->>'technician')::integer, 0);
  c_work := coalesce((v_cnt->>'work')::integer, 0);
  c_test := coalesce((v_cnt->>'test')::integer, 0);
  c_payment := coalesce((v_cnt->>'payment')::integer, 0);
  c_warranty := coalesce((v_cnt->>'warranty')::integer, 0);

  -- Result: a real outcome, not the customer sign-off line and not the close snapshot.
  SELECT count(*) INTO c_result FROM public.evc_active(p_job_id) a
  WHERE a.stage = 'result' AND coalesce(a.payload->>'phase', '') <> 'completion_signoff';

  v_chargeable := coalesce((v_job->>'invoice_amount')::numeric, 0) > 0 OR (v_job->>'quote_id') IS NOT NULL;
  v_assigned := (v_job->>'assigned_technician_id') IS NOT NULL;
  v_has_work := c_work > 0;

  SELECT coalesce(bool_or(a.payload->>'replaces_part' = 'true'), false) INTO v_replaces_part
  FROM public.evc_active(p_job_id) a WHERE a.stage = 'work';

  SELECT coalesce(bool_or(a.payload->>'emergency' = 'true'), false) INTO v_emergency
  FROM public.evc_active(p_job_id) a WHERE a.stage IN ('work', 'customer_approval');

  SELECT min(a.seq), max(a.seq) INTO v_work_min, v_work_max
  FROM public.evc_active(p_job_id) a WHERE a.stage = 'work';

  SELECT min(a.seq) INTO v_first_approval
  FROM public.evc_active(p_job_id) a
  WHERE a.stage = 'customer_approval' AND coalesce(a.payload->>'phase', '') <> 'completion_signoff';

  -- Latest test recorded after the last piece of work.
  SELECT a.seq, (a.payload->>'passed' = 'true') INTO v_test_seq, v_test_passed
  FROM public.evc_active(p_job_id) a
  WHERE a.stage = 'test' AND (v_work_max IS NULL OR a.seq > v_work_max)
  ORDER BY a.seq DESC LIMIT 1;

  -- Linkage: manual Work / Part / Recommendation entries must trace back (via refs) to Diagnosis + Evidence.
  WITH RECURSIVE act AS (
    SELECT a.id, a.stage, a.refs
    FROM public.evc_active(p_job_id) a
    WHERE a.actor_type IN ('technician', 'staff') AND a.stage IN ('work', 'part', 'recommendation')
  ),
  anc(root, node) AS (
    SELECT act.id, r FROM act CROSS JOIN LATERAL unnest(act.refs) AS r
    UNION
    SELECT anc.root, r
    FROM anc
    JOIN public.job_evidence_chain_entries n ON n.id = anc.node
    CROSS JOIN LATERAL unnest(n.refs) AS r
  ),
  chk AS (
    SELECT act.id, act.stage,
      EXISTS (SELECT 1 FROM anc JOIN public.job_evidence_chain_entries n ON n.id = anc.node
              WHERE anc.root = act.id AND n.stage = 'diagnosis') AS has_diag,
      EXISTS (SELECT 1 FROM anc JOIN public.job_evidence_chain_entries n ON n.id = anc.node
              WHERE anc.root = act.id AND n.stage = 'evidence') AS has_ev
    FROM act
  )
  SELECT
    count(*) FILTER (WHERE stage IN ('work', 'part') AND NOT (has_diag AND has_ev)),
    count(*) FILTER (WHERE stage = 'recommendation' AND NOT has_diag)
  INTO v_unsupported, v_unjustified
  FROM chk;

  -- Before / After proof
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT lower(btrim(a.payload->>'label')) AS label
      FROM public.evc_active(p_job_id) a
      WHERE a.kind = 'measurement' AND a.payload->>'phase' IN ('before', 'after')
        AND coalesce(btrim(a.payload->>'label'), '') <> ''
      GROUP BY lower(btrim(a.payload->>'label'))
      HAVING count(DISTINCT a.payload->>'phase') = 2
    ) m
  ) INTO v_pair_meas;

  v_before_photos := CASE WHEN jsonb_typeof(v_job->'before_photos') = 'array' THEN jsonb_array_length(v_job->'before_photos') ELSE 0 END;
  v_after_photos := CASE WHEN jsonb_typeof(v_job->'after_photos') = 'array' THEN jsonb_array_length(v_job->'after_photos') ELSE 0 END;

  SELECT (
    (v_before_photos > 0 OR EXISTS (
      SELECT 1 FROM public.evc_active(p_job_id) a
      WHERE a.kind = 'media' AND a.payload->>'phase' = 'before' AND jsonb_array_length(a.media) > 0))
    AND
    (v_after_photos > 0 OR EXISTS (
      SELECT 1 FROM public.evc_active(p_job_id) a
      WHERE a.kind = 'media' AND a.payload->>'phase' = 'after' AND jsonb_array_length(a.media) > 0))
  ) INTO v_pair_media;

  -- Stage satisfaction
  SELECT EXISTS (
    SELECT 1 FROM public.evc_active(p_job_id) a
    WHERE a.stage = 'evidence' AND (a.kind IN ('measurement', 'system') OR jsonb_array_length(a.media) > 0)
  ) INTO ok_evidence;

  app_approval := v_chargeable;
  app_part := c_part > 0 OR v_replaces_part;
  app_payment := v_chargeable;

  ok_problem := c_problem > 0;
  ok_diagnosis := c_diagnosis > 0;
  ok_recommendation := c_recommendation > 0;
  ok_approval := v_first_approval IS NOT NULL;
  ok_part := c_part > 0;
  ok_technician := v_assigned OR c_technician > 0 OR EXISTS (
    SELECT 1 FROM public.evc_active(p_job_id) a WHERE a.actor_type = 'technician'
  );
  ok_work := v_has_work;
  ok_test := CASE WHEN v_has_work THEN coalesce(v_test_passed, false) ELSE c_test > 0 END;
  ok_result := c_result > 0;
  ok_payment := c_payment > 0;
  ok_warranty := c_warranty > 0;

  v_stages := jsonb_build_array(
    public.evc_stage('problem', true, ok_problem, c_problem, 8),
    public.evc_stage('diagnosis', true, ok_diagnosis, c_diagnosis, 12),
    public.evc_stage('evidence', true, ok_evidence, c_evidence, 14),
    public.evc_stage('recommendation', true, ok_recommendation, c_recommendation, 8),
    public.evc_stage('customer_approval', app_approval, ok_approval, c_approval, 8),
    public.evc_stage('part', app_part, ok_part, c_part, 6),
    public.evc_stage('technician', true, ok_technician, c_technician, 6),
    public.evc_stage('work', true, ok_work, c_work, 8),
    public.evc_stage('test', true, ok_test, c_test, 12),
    public.evc_stage('result', true, ok_result, c_result, 8),
    public.evc_stage('payment', app_payment, ok_payment, c_payment, 4),
    public.evc_stage('warranty', true, ok_warranty, c_warranty, 6)
  );

  -- Gaps (blocking = must be fixed before a gated close; advisory = shown but never blocks)
  IF NOT ok_problem THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('problem', 'problem', 'blocking')); END IF;
  IF NOT ok_diagnosis THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('diagnosis', 'diagnosis', 'blocking')); END IF;
  IF NOT ok_evidence THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('evidence', 'evidence', 'blocking')); END IF;
  IF NOT ok_recommendation THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('recommendation', 'recommendation', 'blocking')); END IF;
  IF app_approval AND NOT ok_approval THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('customer_approval', 'customer_approval', 'blocking')); END IF;
  IF NOT ok_work THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('work', 'work', 'blocking')); END IF;
  IF app_part AND NOT ok_part THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('part_traceability', 'part', 'blocking')); END IF;

  IF v_has_work THEN
    IF v_test_seq IS NULL THEN
      v_gaps := v_gaps || jsonb_build_array(public.evc_gap('post_repair_test', 'test', 'blocking'));
    ELSIF NOT coalesce(v_test_passed, false) THEN
      v_gaps := v_gaps || jsonb_build_array(public.evc_gap('post_repair_test_failed', 'test', 'blocking'));
      v_penalty := v_penalty + 10;
    END IF;
    IF NOT (v_pair_meas OR v_pair_media) THEN
      v_gaps := v_gaps || jsonb_build_array(public.evc_gap('before_after', 'evidence', 'blocking'));
      v_penalty := v_penalty + 10;
    END IF;
    IF app_approval AND ok_approval AND NOT v_emergency AND v_first_approval > v_work_min THEN
      v_gaps := v_gaps || jsonb_build_array(public.evc_gap('work_before_approval', 'customer_approval', 'blocking'));
      v_penalty := v_penalty + 10;
    END IF;
  ELSIF c_test = 0 THEN
    v_gaps := v_gaps || jsonb_build_array(public.evc_gap('post_repair_test', 'test', 'blocking'));
  END IF;

  IF v_unsupported > 0 THEN
    v_gaps := v_gaps || jsonb_build_array(public.evc_gap('unsupported_work', 'work', 'blocking'));
    v_penalty := v_penalty + 10;
  END IF;
  IF v_unjustified > 0 THEN
    v_gaps := v_gaps || jsonb_build_array(public.evc_gap('unjustified_recommendation', 'recommendation', 'blocking'));
    v_penalty := v_penalty + 10;
  END IF;
  IF NOT ok_result THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('result', 'result', 'blocking')); END IF;
  IF NOT ok_technician THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('technician', 'technician', 'advisory')); END IF;
  IF app_payment AND NOT ok_payment THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('payment', 'payment', 'advisory')); END IF;
  IF NOT ok_warranty THEN v_gaps := v_gaps || jsonb_build_array(public.evc_gap('warranty', 'warranty', 'advisory')); END IF;
  IF NOT coalesce((v_integrity->>'valid')::boolean, true) THEN
    v_gaps := v_gaps || jsonb_build_array(public.evc_gap('integrity', 'work', 'blocking'));
  END IF;

  SELECT coalesce(jsonb_agg(g->>'key'), '[]'::jsonb), count(*)::integer
  INTO v_blocking, v_blocking_count
  FROM jsonb_array_elements(v_gaps) g WHERE g->>'severity' = 'blocking';

  SELECT CASE WHEN sum((s->>'weight')::integer) FILTER (WHERE (s->>'applicable')::boolean) > 0
    THEN 100.0 * coalesce(sum((s->>'weight')::integer) FILTER (WHERE (s->>'applicable')::boolean AND (s->>'satisfied')::boolean), 0)
         / sum((s->>'weight')::integer) FILTER (WHERE (s->>'applicable')::boolean)
    ELSE 0 END
  INTO v_base
  FROM jsonb_array_elements(v_stages) s;

  v_entries := coalesce((v_integrity->>'entries')::integer, 0);
  v_score := greatest(0, round(v_base)::integer - least(v_penalty, 30));

  IF v_entries = 0 THEN
    v_score := 0;
    v_level := 'not_started';
  ELSIF NOT coalesce((v_integrity->>'valid')::boolean, true) THEN
    v_score := 0;
    v_level := 'compromised';
  ELSIF v_score >= 90 AND v_blocking_count = 0 THEN
    v_level := 'audit_ready';
  ELSIF v_score >= 75 THEN
    v_level := 'strong';
  ELSIF v_score >= 40 THEN
    v_level := 'partial';
  ELSE
    v_level := 'weak';
  END IF;

  SELECT count(*) FILTER (WHERE a.actor_type IN ('system', 'customer', 'ai')),
         count(*) FILTER (WHERE a.actor_type IN ('technician', 'staff')),
         coalesce(sum(jsonb_array_length(a.media)), 0)
  INTO v_verified, v_manual, v_media
  FROM public.evc_active(p_job_id) a;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'score', v_score,
    'level', v_level,
    'ready', v_blocking_count = 0 AND coalesce((v_integrity->>'valid')::boolean, true) AND v_entries > 0,
    'stages', v_stages,
    'gaps', v_gaps,
    'blocking_gaps', v_blocking,
    'integrity', v_integrity,
    'stats', jsonb_build_object(
      'system_verified', v_verified,
      'human_recorded', v_manual,
      'media_files', v_media,
      'before_after_measurement', v_pair_meas,
      'before_after_media', v_pair_media,
      'chargeable', v_chargeable,
      'post_repair_test_passed', coalesce(v_test_passed, false)
    ),
    'generated_at', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.job_evidence_chain_portfolio(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(t.obj ORDER BY t.created_at DESC), '[]'::jsonb)
  FROM (
    SELECT
      j.created_at AS created_at,
      jsonb_build_object(
        'job_id', j.id,
        'customer_name', j.customer_name,
        'service_type', j.service_type,
        'job_status', j.job_status,
        'created_at', j.created_at,
        'score', (r.rep->>'score')::integer,
        'level', r.rep->>'level',
        'blocking', (SELECT count(*) FROM jsonb_array_elements(r.rep->'gaps') g WHERE g->>'severity' = 'blocking'),
        'integrity_valid', (r.rep->'integrity'->>'valid')::boolean,
        'entries', (r.rep->'integrity'->>'entries')::integer,
        'head_hash', r.rep->'integrity'->>'head_hash'
      ) AS obj
    FROM (
      SELECT * FROM public.jobs
      WHERE user_id = public.get_account_owner_id()
      ORDER BY created_at DESC
      LIMIT least(greatest(coalesce(p_limit, 100), 1), 200)
    ) j
    CROSS JOIN LATERAL (SELECT public.job_evidence_chain_report(j.id) AS rep) r
  ) t;
$$;

-- =============================================================
-- 4. OPT-IN CLOSE GATE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_evidence_chain_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  service_type text NOT NULL,            -- '*' = default for every service type
  enforce_on_close boolean NOT NULL DEFAULT false,
  min_score smallint NOT NULL DEFAULT 70 CHECK (min_score BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, service_type)
);

CREATE INDEX IF NOT EXISTS idx_evc_requirements_user ON public.job_evidence_chain_requirements (user_id);

DO $$
BEGIN
  IF to_regprocedure('public.set_updated_at()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_evc_requirements_updated_at ON public.job_evidence_chain_requirements;
    CREATE TRIGGER trg_evc_requirements_updated_at
      BEFORE UPDATE ON public.job_evidence_chain_requirements
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END
$$;

ALTER TABLE public.job_evidence_chain_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evc_req_select" ON public.job_evidence_chain_requirements;
CREATE POLICY "evc_req_select" ON public.job_evidence_chain_requirements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "evc_req_insert" ON public.job_evidence_chain_requirements;
CREATE POLICY "evc_req_insert" ON public.job_evidence_chain_requirements FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "evc_req_update" ON public.job_evidence_chain_requirements;
CREATE POLICY "evc_req_update" ON public.job_evidence_chain_requirements FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "evc_req_delete" ON public.job_evidence_chain_requirements;
CREATE POLICY "evc_req_delete" ON public.job_evidence_chain_requirements FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.enforce_job_evidence_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_req public.job_evidence_chain_requirements%ROWTYPE;
  v_rep jsonb;
  v_keys text;
BEGIN
  IF NEW.job_status IS DISTINCT FROM 'completed' OR OLD.job_status IS NOT DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_req FROM public.job_evidence_chain_requirements
  WHERE user_id = NEW.user_id AND service_type = coalesce(NEW.service_type, '*')
  LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO v_req FROM public.job_evidence_chain_requirements
    WHERE user_id = NEW.user_id AND service_type = '*'
    LIMIT 1;
  END IF;

  IF NOT FOUND OR NOT v_req.enforce_on_close THEN
    RETURN NEW;
  END IF;

  v_rep := public.job_evidence_chain_report(NEW.id);
  IF v_rep IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(g->>'key', ',') INTO v_keys
  FROM jsonb_array_elements(v_rep->'gaps') g WHERE g->>'severity' = 'blocking';

  IF v_keys IS NULL AND (v_rep->>'score')::integer < v_req.min_score THEN
    v_keys := 'score_below_minimum';
  END IF;

  IF v_keys IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_EVIDENCE_CHAIN_BLOCKED: %', v_keys USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_job_evidence_chain ON public.jobs;
CREATE TRIGGER trg_enforce_job_evidence_chain
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_job_evidence_chain();

-- =============================================================
-- 5. GRANTS
-- =============================================================

GRANT EXECUTE ON FUNCTION public.job_evidence_chain_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_evidence_chain_verify(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_evidence_chain_portfolio(integer) TO authenticated;
