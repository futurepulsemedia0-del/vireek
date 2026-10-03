/*
  # VIREEK Equipment Passport

  A permanent identity for the physical machine, independent of any contractor or owner.

  - equipment_passports        : one row per physical device (public QR/NFC code, make/model/serial).
  - equipment_passport_links   : which Vireek accounts (contractors) are attached to the device.
                                 verified = proved physical access (scanned code) or created it.
  - equipment_passport_events  : append-only, SHA-256 hash-chained history of the DEVICE. It has NO foreign
                                 keys to jobs/accounts, so it survives job deletion, contractor churn and
                                 account deletion.

  History is sanitised on the way in: no customer name/phone/address, no prices, technician = "Maria G.",
  photos = count + fingerprint count (files stay private in the tenant's own bucket).

  Auto behaviour (never blocks the source write):
    equipment INSERT           -> passport issued (or matched by make+serial, unverified until the code is scanned)
    job completed              -> "service_visit" event for every equipment linked to that job
    job_outcomes / warranty_claims INSERT -> follow-up event
    equipment DELETE           -> this contractor's link ends; the passport and its history stay

  Nothing existing is modified except: new triggers on equipment, jobs, job_equipment, job_outcomes, warranty_claims.
*/

-- =============================================================
-- 0. PURE HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.vp_generate_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  -- Crockford base32 (no I L O U)
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  out text := '';
  i int;
BEGIN
  -- bytes 6 and 8 carry fixed UUID version/variant bits -> skip them (12 fully random bytes remain)
  FOR i IN 0..11 LOOP
    out := out || substr(alphabet, (get_byte(b, CASE WHEN i < 6 THEN i ELSE i + 3 END) & 31) + 1, 1);
  END LOOP;
  RETURN out;  -- 60 bits of entropy
END;
$$;

CREATE OR REPLACE FUNCTION public.vp_normalize_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN length(c) = 15 AND left(c, 3) = 'VEQ' THEN substr(c, 4)
    ELSE c
  END
  FROM (
    SELECT translate(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011') AS c
  ) s;
$$;

CREATE OR REPLACE FUNCTION public.vp_serial_key(p_make text, p_serial text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN s IS NULL OR m IS NULL OR length(s) < 4
      OR s IN ('na', 'none', 'unknown', 'tbd', 'notavailable', '0000', '00000', '000000', '123456', '1234')
    THEN NULL
    ELSE m || ':' || s
  END
  FROM (
    SELECT nullif(lower(regexp_replace(coalesce(p_make, ''), '[^a-zA-Z0-9]', '', 'g')), '') AS m,
           nullif(lower(regexp_replace(coalesce(p_serial, ''), '[^a-zA-Z0-9]', '', 'g')), '') AS s
  ) t;
$$;

CREATE OR REPLACE FUNCTION public.vp_mask_serial(p_serial text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN nullif(btrim(p_serial), '') IS NULL THEN NULL
    WHEN length(btrim(p_serial)) <= 4 THEN '••••'
    ELSE '••••' || right(btrim(p_serial), 4)
  END;
$$;

CREATE OR REPLACE FUNCTION public.vp_display_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN n IS NULL OR position('@' IN n) > 0 THEN NULL
    WHEN position(' ' IN n) = 0 THEN left(n, 40)
    ELSE left(split_part(n, ' ', 1), 40) || ' ' || upper(left(btrim(substring(n FROM position(' ' IN n))), 1)) || '.'
  END
  FROM (SELECT nullif(btrim(p_name), '') AS n) t;
$$;

CREATE OR REPLACE FUNCTION public.vp_company_name(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT nullif(btrim(company_name), '') FROM public.profiles WHERE id = p_user),
    'Service provider'
  );
$$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.equipment_passports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL UNIQUE CHECK (public_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  equipment_type text NOT NULL,
  make text,
  model text,
  serial_number text,
  serial_key text,
  install_date date,
  warranty_expires_at date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'merged')),
  superseded_by uuid REFERENCES public.equipment_passports(id),
  created_by_user_id uuid,            -- deliberately NOT a foreign key: the passport outlives the account
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_passports_serial_key
  ON public.equipment_passports (serial_key) WHERE serial_key IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS public.equipment_passport_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.equipment_passports(id),
  user_id uuid NOT NULL,              -- account owner (tenant); not an FK on purpose
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'servicer' CHECK (role IN ('installer', 'servicer')),
  verified boolean NOT NULL DEFAULT false,
  verified_via text CHECK (verified_via IN ('issuer', 'code', 'adopted')),
  show_contractor_publicly boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (passport_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_links_equipment
  ON public.equipment_passport_links (equipment_id) WHERE equipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vp_links_user ON public.equipment_passport_links (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.equipment_passport_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.equipment_passports(id),
  seq integer NOT NULL DEFAULT 0,
  event_type text NOT NULL CHECK (event_type IN (
    'registered', 'installed', 'service_visit', 'inspection', 'repair', 'part_replaced', 'outcome',
    'warranty_event', 'custody_change', 'identity_corrected', 'note', 'decommissioned'
  )),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  contributor_user_id uuid,           -- no FK (survives account deletion)
  contributor_name text,              -- snapshot of the company name at the time
  source_job_id uuid,                 -- no FK (survives job deletion)
  source_key text,
  supersedes_id uuid,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'network')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash text,
  entry_hash text NOT NULL DEFAULT '',
  UNIQUE (passport_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_events_source_key
  ON public.equipment_passport_events (passport_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vp_events_passport ON public.equipment_passport_events (passport_id, occurred_at DESC);

COMMENT ON TABLE public.equipment_passport_events IS
  'Append-only, hash-chained history of a physical device. Never UPDATE/DELETE: add a superseding event instead.';

-- =============================================================
-- 2. HASH CHAIN + IMMUTABILITY
-- =============================================================

CREATE OR REPLACE FUNCTION public.vp_event_hash(e public.equipment_passport_events)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    coalesce(e.prev_hash, 'GENESIS'),
    e.passport_id::text,
    e.seq::text,
    e.event_type,
    e.title,
    coalesce(e.detail, ''),
    e.summary::text,
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(e.contributor_user_id::text, ''),
    coalesce(e.contributor_name, ''),
    coalesce(e.source_job_id::text, ''),
    coalesce(e.source_key, ''),
    coalesce(e.supersedes_id::text, ''),
    e.visibility,
    to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.vp_seal_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
  v_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:equipment-passport:' || NEW.passport_id::text, 0));

  SELECT seq, entry_hash INTO v_seq, v_hash
  FROM public.equipment_passport_events
  WHERE passport_id = NEW.passport_id
  ORDER BY seq DESC
  LIMIT 1;

  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.equipment_passport_events e
    WHERE e.id = NEW.supersedes_id AND e.passport_id = NEW.passport_id
  ) THEN
    RAISE EXCEPTION 'PASSPORT_INVALID: superseded event not found on this passport' USING ERRCODE = 'P0001';
  END IF;

  NEW.seq := coalesce(v_seq, 0) + 1;
  NEW.prev_hash := v_hash;
  NEW.recorded_at := clock_timestamp();
  NEW.entry_hash := public.vp_event_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_seal_event ON public.equipment_passport_events;
CREATE TRIGGER trg_vp_seal_event
  BEFORE INSERT ON public.equipment_passport_events
  FOR EACH ROW EXECUTE FUNCTION public.vp_seal_event();

CREATE OR REPLACE FUNCTION public.vp_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PASSPORT_IMMUTABLE: passport history is append-only; add a superseding event instead' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_block_mutation ON public.equipment_passport_events;
CREATE TRIGGER trg_vp_block_mutation
  BEFORE UPDATE OR DELETE ON public.equipment_passport_events
  FOR EACH ROW EXECUTE FUNCTION public.vp_block_mutation();

DROP TRIGGER IF EXISTS trg_vp_block_truncate ON public.equipment_passport_events;
CREATE TRIGGER trg_vp_block_truncate
  BEFORE TRUNCATE ON public.equipment_passport_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.vp_block_mutation();

CREATE OR REPLACE FUNCTION public.vp_verify_chain(p_passport uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.equipment_passport_events;
  v_prev text := NULL;
  v_n integer := 0;
BEGIN
  FOR e IN SELECT * FROM public.equipment_passport_events WHERE passport_id = p_passport ORDER BY seq LOOP
    v_n := v_n + 1;
    IF e.seq <> v_n OR e.prev_hash IS DISTINCT FROM v_prev OR e.entry_hash <> public.vp_event_hash(e) THEN
      RETURN jsonb_build_object('valid', false, 'checked', v_n, 'broken_at_seq', e.seq);
    END IF;
    v_prev := e.entry_hash;
  END LOOP;
  RETURN jsonb_build_object('valid', true, 'checked', v_n, 'head_hash', v_prev);
END;
$$;

-- =============================================================
-- 3. ROW LEVEL SECURITY (read-only for clients; all writes go through functions)
-- =============================================================

ALTER TABLE public.equipment_passports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_passport_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipment_passport_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vp_links_select" ON public.equipment_passport_links;
CREATE POLICY "vp_links_select" ON public.equipment_passport_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "vp_passports_select" ON public.equipment_passports;
CREATE POLICY "vp_passports_select" ON public.equipment_passports FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.equipment_passport_links l
    WHERE l.passport_id = equipment_passports.id
      AND l.user_id = public.get_account_owner_id() AND l.status = 'active' AND l.verified
  ));

DROP POLICY IF EXISTS "vp_events_select" ON public.equipment_passport_events;
CREATE POLICY "vp_events_select" ON public.equipment_passport_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.equipment_passport_links l
    WHERE l.passport_id = equipment_passport_events.passport_id
      AND l.user_id = public.get_account_owner_id() AND l.status = 'active' AND l.verified
  ));

REVOKE ALL ON public.equipment_passports, public.equipment_passport_links, public.equipment_passport_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.equipment_passports, public.equipment_passport_links, public.equipment_passport_events FROM authenticated;

-- =============================================================
-- 4. INTERNAL WRITERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.vp_append_event(
  p_passport uuid,
  p_type text,
  p_title text,
  p_detail text,
  p_summary jsonb,
  p_occurred timestamptz,
  p_user uuid,
  p_job uuid DEFAULT NULL,
  p_source_key text DEFAULT NULL,
  p_visibility text DEFAULT 'public'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.equipment_passport_events
    (passport_id, event_type, title, detail, summary, occurred_at,
     contributor_user_id, contributor_name, source_job_id, source_key, visibility)
  VALUES
    (p_passport, p_type, left(p_title, 200), left(p_detail, 2000), coalesce(p_summary, '{}'::jsonb),
     coalesce(p_occurred, now()), p_user,
     CASE WHEN p_user IS NULL THEN NULL ELSE public.vp_company_name(p_user) END,
     p_job, p_source_key, p_visibility)
  ON CONFLICT (passport_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Issue (or match) a passport for one equipment row. Idempotent.
CREATE OR REPLACE FUNCTION public.vp_issue_for_equipment(p_equipment uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  eq record;
  v_pid uuid;
  v_key text;
  v_adopt uuid;
  v_code text;
  v_tries integer := 0;
BEGIN
  SELECT * INTO eq FROM public.equipment WHERE id = p_equipment;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT passport_id INTO v_pid FROM public.equipment_passport_links WHERE equipment_id = eq.id;
  IF v_pid IS NOT NULL THEN RETURN v_pid; END IF;

  v_adopt := nullif(current_setting('vireek.passport_adopt', true), '')::uuid;
  v_key := public.vp_serial_key(eq.make, eq.serial_number);

  IF v_adopt IS NOT NULL THEN
    INSERT INTO public.equipment_passport_links (passport_id, user_id, equipment_id, role, verified, verified_via)
    VALUES (v_adopt, eq.user_id, eq.id, 'servicer', true, 'adopted')
    ON CONFLICT (passport_id, user_id) DO UPDATE
      SET equipment_id = EXCLUDED.equipment_id, status = 'active', ended_at = NULL, verified = true, verified_via = 'adopted'
      WHERE equipment_passport_links.status = 'ended' OR equipment_passport_links.equipment_id IS NULL;
    RETURN v_adopt;
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT id INTO v_pid FROM public.equipment_passports WHERE serial_key = v_key AND status = 'active';
  END IF;

  IF v_pid IS NOT NULL THEN
    -- Same physical device already has a passport (another contractor, or an earlier record).
    -- Link, but UNVERIFIED: they must scan the label (prove physical access) before reading or writing history.
    INSERT INTO public.equipment_passport_links (passport_id, user_id, equipment_id, role, verified)
    VALUES (v_pid, eq.user_id, eq.id, 'servicer', false)
    ON CONFLICT (passport_id, user_id) DO NOTHING;
    RETURN v_pid;
  END IF;

  LOOP
    v_tries := v_tries + 1;
    v_code := public.vp_generate_code();
    BEGIN
      INSERT INTO public.equipment_passports
        (public_code, equipment_type, make, model, serial_number, serial_key, install_date, warranty_expires_at, created_by_user_id)
      VALUES
        (v_code, eq.equipment_type, eq.make, eq.model, eq.serial_number, v_key, eq.install_date, eq.warranty_expires_at, eq.user_id)
      RETURNING id INTO v_pid;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_key IS NOT NULL THEN
        SELECT id INTO v_pid FROM public.equipment_passports WHERE serial_key = v_key AND status = 'active';
        IF v_pid IS NOT NULL THEN
          INSERT INTO public.equipment_passport_links (passport_id, user_id, equipment_id, role, verified)
          VALUES (v_pid, eq.user_id, eq.id, 'servicer', false)
          ON CONFLICT (passport_id, user_id) DO NOTHING;
          RETURN v_pid;
        END IF;
      END IF;
      IF v_tries > 10 THEN RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO public.equipment_passport_links (passport_id, user_id, equipment_id, role, verified, verified_via)
  VALUES (v_pid, eq.user_id, eq.id,
          CASE WHEN eq.install_job_id IS NOT NULL THEN 'installer' ELSE 'servicer' END, true, 'issuer');

  PERFORM public.vp_append_event(
    v_pid, 'registered', 'Passport issued', NULL,
    jsonb_build_object('equipment_type', eq.equipment_type), now(), eq.user_id, NULL, 'registered');

  IF eq.install_date IS NOT NULL THEN
    PERFORM public.vp_append_event(
      v_pid, 'installed', 'Installed', NULL,
      jsonb_build_object('equipment_type', eq.equipment_type), eq.install_date::timestamptz, eq.user_id, eq.install_job_id, 'installed');
  END IF;

  RETURN v_pid;
END;
$$;

-- Sanitised service-visit snapshot for one completed job on one piece of equipment.
CREATE OR REPLACE FUNCTION public.vp_record_job_service(p_job uuid, p_equipment uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j record;
  eq record;
  l record;
  v_when timestamptz;
  v_tech text;
  v_parts jsonb;
  v_photos integer;
  v_prints integer;
  v_diag text;
  v_work jsonb;
  v_res jsonb;
  v_outcome jsonb;
  v_warr jsonb;
  v_evid jsonb;
  v_rep jsonb;
  v_claims integer;
  v_has_chain boolean := to_regclass('public.job_evidence_chain_entries') IS NOT NULL;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job;
  IF NOT FOUND OR j.job_status IS DISTINCT FROM 'completed' THEN RETURN NULL; END IF;

  SELECT * INTO eq FROM public.equipment WHERE id = p_equipment AND user_id = j.user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO l FROM public.equipment_passport_links
  WHERE equipment_id = p_equipment AND user_id = j.user_id AND status = 'active';
  IF NOT FOUND THEN
    PERFORM public.vp_issue_for_equipment(p_equipment);
    SELECT * INTO l FROM public.equipment_passport_links
    WHERE equipment_id = p_equipment AND user_id = j.user_id AND status = 'active';
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  IF NOT l.verified THEN RETURN NULL; END IF;   -- never write into a device history you have not verified

  v_when := coalesce(nullif(to_jsonb(j)->>'scheduled_datetime', '')::timestamptz, now());

  SELECT public.vp_display_name(tm.member_name) INTO v_tech
  FROM public.team_members tm WHERE tm.id = j.assigned_technician_id;

  v_parts := '[]'::jsonb; v_photos := 0; v_prints := 0; v_claims := 0; v_work := '[]'::jsonb;

  IF v_has_chain THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', x.payload->>'part_name', 'qty', x.payload->'quantity') ORDER BY x.seq), '[]'::jsonb)
    INTO v_parts
    FROM (
      SELECT seq, payload FROM public.job_evidence_chain_entries
      WHERE job_id = p_job AND stage = 'part' AND coalesce(payload->>'part_name', '') <> ''
      ORDER BY seq LIMIT 20
    ) x;

    SELECT coalesce(sum(CASE WHEN jsonb_typeof(payload->'photo_count') = 'number' THEN (payload->>'photo_count')::integer ELSE 0 END), 0)::integer
           + coalesce(sum(jsonb_array_length(media)), 0)::integer,
           coalesce(sum(jsonb_array_length(media)), 0)::integer
    INTO v_photos, v_prints
    FROM public.job_evidence_chain_entries WHERE job_id = p_job;

    SELECT left(coalesce(nullif(btrim(detail), ''), title), 300) INTO v_diag
    FROM public.job_evidence_chain_entries
    WHERE job_id = p_job AND stage = 'diagnosis' ORDER BY seq DESC LIMIT 1;

    SELECT coalesce(jsonb_agg(left(t.title, 160) ORDER BY t.seq), '[]'::jsonb) INTO v_work
    FROM (
      SELECT seq, title FROM public.job_evidence_chain_entries
      WHERE job_id = p_job AND stage IN ('work', 'test') ORDER BY seq LIMIT 6
    ) t;

    SELECT payload INTO v_res FROM public.job_evidence_chain_entries
    WHERE job_id = p_job AND stage = 'result' AND payload ? 'resolution' ORDER BY seq DESC LIMIT 1;

    SELECT count(*)::integer INTO v_claims FROM public.job_evidence_chain_entries
    WHERE job_id = p_job AND stage = 'warranty';

    BEGIN
      v_rep := public.job_evidence_chain_report(p_job);
      IF v_rep IS NOT NULL THEN
        v_evid := jsonb_strip_nulls(jsonb_build_object(
          'score', v_rep->'score', 'level', v_rep->'level', 'integrity_valid', v_rep->'integrity'->'valid'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_evid := NULL;
    END;
  END IF;

  IF v_res IS NOT NULL THEN
    v_outcome := jsonb_strip_nulls(jsonb_build_object(
      'resolution', v_res->>'resolution',
      'first_time_fix', NOT (coalesce((v_res->>'is_rework')::boolean, false) OR coalesce((v_res->>'caused_callback')::boolean, false)),
      'customer_rating', v_res->'customer_rating'));
  END IF;

  v_warr := jsonb_strip_nulls(jsonb_build_object(
    'expires_at', eq.warranty_expires_at,
    'active_at_service', CASE WHEN eq.warranty_expires_at IS NULL THEN NULL ELSE eq.warranty_expires_at >= v_when::date END,
    'claims', nullif(v_claims, 0)));

  RETURN public.vp_append_event(
    l.passport_id, 'service_visit',
    coalesce(nullif(btrim(j.service_type), ''), 'Service visit'), NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'service_type', nullif(btrim(j.service_type), ''),
      'diagnosis', v_diag,
      'technician', v_tech,
      'parts', v_parts,
      'photos', jsonb_build_object('count', v_photos, 'fingerprinted', v_prints),
      'warranty', v_warr,
      'work', v_work,
      'outcome', v_outcome,
      'evidence', v_evid)),
    v_when, j.user_id, p_job, 'job:' || p_job::text);
END;
$$;

-- =============================================================
-- 5. AUTOMATIC CAPTURE (fail-safe: can NEVER break the source write)
-- =============================================================

CREATE OR REPLACE FUNCTION public.vp_on_equipment_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.vp_issue_for_equipment(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'equipment passport issue skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_equipment_ins ON public.equipment;
CREATE TRIGGER trg_vp_equipment_ins
  AFTER INSERT ON public.equipment
  FOR EACH ROW EXECUTE FUNCTION public.vp_on_equipment_insert();

CREATE OR REPLACE FUNCTION public.vp_on_equipment_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l record;
BEGIN
  BEGIN
    SELECT * INTO l FROM public.equipment_passport_links
    WHERE equipment_id = NEW.id AND status = 'active' AND verified;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Warranty is a fact about the device: keep the furthest-out date.
    IF NEW.warranty_expires_at IS NOT NULL THEN
      UPDATE public.equipment_passports
      SET warranty_expires_at = NEW.warranty_expires_at, updated_at = now()
      WHERE id = l.passport_id AND (warranty_expires_at IS NULL OR warranty_expires_at < NEW.warranty_expires_at);
    END IF;

    -- Identity corrections are only applied when this contractor is the sole one attached, and are logged.
    IF (OLD.equipment_type, OLD.make, OLD.model, OLD.serial_number, OLD.install_date)
       IS DISTINCT FROM (NEW.equipment_type, NEW.make, NEW.model, NEW.serial_number, NEW.install_date)
       AND (SELECT count(*) FROM public.equipment_passport_links WHERE passport_id = l.passport_id AND status = 'active') = 1 THEN
      UPDATE public.equipment_passports
      SET equipment_type = NEW.equipment_type, make = NEW.make, model = NEW.model,
          serial_number = NEW.serial_number, serial_key = public.vp_serial_key(NEW.make, NEW.serial_number),
          install_date = NEW.install_date, updated_at = now()
      WHERE id = l.passport_id;

      PERFORM public.vp_append_event(
        l.passport_id, 'identity_corrected', 'Device details corrected', NULL,
        jsonb_build_object(
          'before', jsonb_build_object('make', OLD.make, 'model', OLD.model, 'serial_masked', public.vp_mask_serial(OLD.serial_number)),
          'after',  jsonb_build_object('make', NEW.make, 'model', NEW.model, 'serial_masked', public.vp_mask_serial(NEW.serial_number))),
        now(), NEW.user_id, NULL, NULL, 'network');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'equipment passport sync skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_equipment_upd ON public.equipment;
CREATE TRIGGER trg_vp_equipment_upd
  AFTER UPDATE ON public.equipment
  FOR EACH ROW
  WHEN (
    OLD.equipment_type IS DISTINCT FROM NEW.equipment_type OR OLD.make IS DISTINCT FROM NEW.make
    OR OLD.model IS DISTINCT FROM NEW.model OR OLD.serial_number IS DISTINCT FROM NEW.serial_number
    OR OLD.install_date IS DISTINCT FROM NEW.install_date OR OLD.warranty_expires_at IS DISTINCT FROM NEW.warranty_expires_at
  )
  EXECUTE FUNCTION public.vp_on_equipment_update();

-- Removing the equipment from a contractor's records ends THEIR link; the passport and its history remain.
CREATE OR REPLACE FUNCTION public.vp_on_equipment_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l record;
BEGIN
  BEGIN
    SELECT * INTO l FROM public.equipment_passport_links WHERE equipment_id = OLD.id;
    IF FOUND THEN
      UPDATE public.equipment_passport_links SET status = 'ended', ended_at = now() WHERE id = l.id;
      IF l.verified THEN
        PERFORM public.vp_append_event(
          l.passport_id, 'custody_change', 'A servicing company removed this unit from its records', NULL,
          jsonb_build_object('action', 'left'), now(), l.user_id, NULL, NULL);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'equipment passport detach skipped: %', SQLERRM;
  END;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_equipment_del ON public.equipment;
CREATE TRIGGER trg_vp_equipment_del
  BEFORE DELETE ON public.equipment
  FOR EACH ROW EXECUTE FUNCTION public.vp_on_equipment_delete();

CREATE OR REPLACE FUNCTION public.vp_on_job_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  BEGIN
    FOR r IN SELECT equipment_id FROM public.job_equipment WHERE job_id = NEW.id LOOP
      PERFORM public.vp_record_job_service(NEW.id, r.equipment_id);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'equipment passport job capture skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_job_closed ON public.jobs;
CREATE TRIGGER trg_vp_job_closed
  AFTER UPDATE OF job_status ON public.jobs
  FOR EACH ROW
  WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.vp_on_job_closed();

CREATE OR REPLACE FUNCTION public.vp_on_job_equipment_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.vp_record_job_service(NEW.job_id, NEW.equipment_id);  -- no-op unless the job is already completed
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'equipment passport link capture skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_vp_job_equipment_ins ON public.job_equipment;
CREATE TRIGGER trg_vp_job_equipment_ins
  AFTER INSERT ON public.job_equipment
  FOR EACH ROW EXECUTE FUNCTION public.vp_on_job_equipment_link();

-- Outcome / warranty claim usually arrive AFTER the job is closed -> they become follow-up events.
CREATE OR REPLACE FUNCTION public.vp_on_job_followup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  v_job uuid := nullif(r->>'job_id', '')::uuid;
  x record;
  v_type text;
  v_title text;
  v_sum jsonb;
BEGIN
  BEGIN
    IF v_job IS NULL THEN RETURN NULL; END IF;

    IF TG_TABLE_NAME = 'job_outcomes' THEN
      v_type := 'outcome';
      v_title := 'Outcome recorded: ' || replace(coalesce(r->>'resolution', 'unknown'), '_', ' ');
      v_sum := jsonb_build_object('outcome', jsonb_strip_nulls(jsonb_build_object(
        'resolution', r->>'resolution',
        'first_time_fix', NOT (coalesce((r->>'is_rework')::boolean, false) OR coalesce((r->>'caused_callback')::boolean, false)),
        'customer_rating', r->'customer_rating')));
    ELSE
      v_type := 'warranty_event';
      v_title := 'Warranty claim opened';
      v_sum := jsonb_build_object('warranty', jsonb_strip_nulls(jsonb_build_object(
        'claim_status', r->>'status', 'claim_deadline', r->>'claim_deadline')));
    END IF;

    FOR x IN
      SELECT l.passport_id, l.user_id
      FROM public.job_equipment je
      JOIN public.equipment_passport_links l
        ON l.equipment_id = je.equipment_id AND l.status = 'active' AND l.verified
      WHERE je.job_id = v_job
    LOOP
      PERFORM public.vp_append_event(x.passport_id, v_type, v_title, NULL, v_sum, now(), x.user_id, v_job,
                                     TG_TABLE_NAME || ':' || (r->>'id'));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'equipment passport follow-up skipped (%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_outcomes', 'warranty_claims'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_vp_followup ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_vp_followup AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.vp_on_job_followup()', t);
    END IF;
  END LOOP;
END;
$$;

-- =============================================================
-- 6. READ MODEL (one builder for member + public views)
-- =============================================================

CREATE OR REPLACE FUNCTION public.vp_passport_json(p_passport uuid, p_member boolean, p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.equipment_passports;
  v_events jsonb;
  v_stats jsonb;
  v_link jsonb;
BEGIN
  SELECT * INTO p FROM public.equipment_passports WHERE id = p_passport;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id,
      'seq', e.seq,
      'event_type', e.event_type,
      'title', e.title,
      'detail', CASE WHEN p_member THEN e.detail END,
      'occurred_at', e.occurred_at,
      'recorded_at', e.recorded_at,
      'contributor_name', CASE WHEN p_member OR coalesce(cl.show_contractor_publicly, true) THEN e.contributor_name END,
      'is_mine', p_member AND e.contributor_user_id IS NOT DISTINCT FROM p_owner,
      'visibility', e.visibility,
      'summary', e.summary,
      'entry_hash', e.entry_hash
    ) ORDER BY e.occurred_at DESC, e.seq DESC), '[]'::jsonb)
  INTO v_events
  FROM (
    SELECT * FROM public.equipment_passport_events
    WHERE passport_id = p_passport AND (p_member OR visibility = 'public')
    ORDER BY occurred_at DESC, seq DESC
    LIMIT 200
  ) e
  LEFT JOIN public.equipment_passport_links cl
    ON cl.passport_id = e.passport_id AND cl.user_id = e.contributor_user_id;

  SELECT jsonb_build_object(
      'event_count', count(*),
      'service_count', count(*) FILTER (WHERE event_type = 'service_visit'),
      'contractor_count', count(DISTINCT contributor_user_id) FILTER (WHERE event_type = 'service_visit'),
      'last_service_at', max(occurred_at) FILTER (WHERE event_type = 'service_visit'),
      'first_event_at', min(occurred_at))
  INTO v_stats
  FROM public.equipment_passport_events
  WHERE passport_id = p_passport AND (p_member OR visibility = 'public');

  IF p_member THEN
    SELECT jsonb_build_object(
      'role', l.role, 'verified', l.verified, 'show_contractor_publicly', l.show_contractor_publicly,
      'equipment_id', l.equipment_id)
    INTO v_link
    FROM public.equipment_passport_links l
    WHERE l.passport_id = p_passport AND l.user_id = p_owner AND l.status = 'active';
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'access', CASE WHEN p_member THEN 'member' ELSE 'public' END,
    'passport', jsonb_build_object(
      'code', p.public_code,
      'status', p.status,
      'equipment_type', p.equipment_type,
      'make', p.make,
      'model', p.model,
      'serial', CASE WHEN p_member THEN p.serial_number ELSE public.vp_mask_serial(p.serial_number) END,
      'install_date', CASE WHEN p_member THEN p.install_date::text ELSE to_char(p.install_date, 'YYYY') END,
      'warranty_expires_at', p.warranty_expires_at,
      'created_at', p.created_at),
    'link', v_link,
    'events', v_events,
    'stats', v_stats,
    'integrity', public.vp_verify_chain(p_passport));
END;
$$;

-- Public (anon) view: sanitised, 'public' events only, serial masked.
CREATE OR REPLACE FUNCTION public.verify_equipment_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.equipment_passports WHERE public_code = public.vp_normalize_code(p_code);
  IF v_id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN public.vp_passport_json(v_id, false, NULL);
END;
$$;

-- Signed-in view: full history if this account has an active, verified link; otherwise the public view.
CREATE OR REPLACE FUNCTION public.get_equipment_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_owner uuid := public.get_account_owner_id();
  v_member boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.equipment_passports WHERE public_code = public.vp_normalize_code(p_code);
  IF v_id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.equipment_passport_links
    WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified
  ) INTO v_member;

  RETURN public.vp_passport_json(v_id, v_member, v_owner);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_equipment_passports()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  RETURN coalesce((
    SELECT jsonb_agg(row_to_json(r)::jsonb ORDER BY r.last_service_at DESC NULLS LAST, r.linked_at DESC)
    FROM (
      SELECT
        CASE WHEN l.verified THEN p.public_code END AS code, p.status, p.equipment_type, p.make, p.model, p.serial_number,
        p.install_date, p.warranty_expires_at,
        l.equipment_id, l.verified, l.role, l.linked_at, l.show_contractor_publicly,
        e.customer_id, c.name AS customer_name,
        CASE WHEN l.verified THEN (SELECT count(*) FROM public.equipment_passport_events ev WHERE ev.passport_id = p.id) ELSE 0 END AS event_count,
        CASE WHEN l.verified THEN (SELECT count(*) FROM public.equipment_passport_events ev WHERE ev.passport_id = p.id AND ev.event_type = 'service_visit') ELSE 0 END AS service_count,
        CASE WHEN l.verified THEN (SELECT max(ev.occurred_at) FROM public.equipment_passport_events ev WHERE ev.passport_id = p.id AND ev.event_type = 'service_visit') END AS last_service_at
      FROM public.equipment_passport_links l
      JOIN public.equipment_passports p ON p.id = l.passport_id
      LEFT JOIN public.equipment e ON e.id = l.equipment_id
      LEFT JOIN public.customers c ON c.id = e.customer_id
      WHERE l.user_id = v_owner AND l.status = 'active'
    ) r
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 7. WRITE RPCs (authenticated)
-- =============================================================

CREATE OR REPLACE FUNCTION public.issue_equipment_passport(p_equipment_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pid uuid;
  v_code text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = p_equipment_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'PASSPORT_EQUIPMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  v_pid := public.vp_issue_for_equipment(p_equipment_id);
  SELECT public_code INTO v_code FROM public.equipment_passports WHERE id = v_pid;
  RETURN v_code;
END;
$$;

-- A second contractor proves physical access by scanning the label, then attaches an equipment record to the passport.
CREATE OR REPLACE FUNCTION public.claim_equipment_passport(p_code text, p_equipment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pid uuid;
  eq record;
  cur record;
  v_was boolean;
  v_rows integer;
  r record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_pid FROM public.equipment_passports
  WHERE public_code = public.vp_normalize_code(p_code) AND status <> 'merged';
  IF v_pid IS NULL THEN RAISE EXCEPTION 'PASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO eq FROM public.equipment WHERE id = p_equipment_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'PASSPORT_EQUIPMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO cur FROM public.equipment_passport_links WHERE equipment_id = eq.id;
  IF FOUND AND cur.passport_id <> v_pid THEN
    -- Equipment already carries a different passport: only a brand-new, empty, single-owner one may be merged away.
    IF EXISTS (SELECT 1 FROM public.equipment_passport_events
               WHERE passport_id = cur.passport_id AND event_type NOT IN ('registered', 'installed'))
       OR EXISTS (SELECT 1 FROM public.equipment_passport_links WHERE passport_id = cur.passport_id AND id <> cur.id) THEN
      RAISE EXCEPTION 'PASSPORT_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.equipment_passports SET status = 'merged', superseded_by = v_pid, updated_at = now() WHERE id = cur.passport_id;
    UPDATE public.equipment_passport_links SET status = 'ended', ended_at = now(), equipment_id = NULL WHERE id = cur.id;
  END IF;

  SELECT verified INTO v_was FROM public.equipment_passport_links WHERE passport_id = v_pid AND user_id = v_owner;

  INSERT INTO public.equipment_passport_links (passport_id, user_id, equipment_id, role, verified, verified_via)
  VALUES (v_pid, v_owner, eq.id, 'servicer', true, 'code')
  ON CONFLICT (passport_id, user_id) DO UPDATE
    SET equipment_id = EXCLUDED.equipment_id, verified = true,
        verified_via = coalesce(equipment_passport_links.verified_via, 'code'),
        status = 'active', ended_at = NULL
    WHERE equipment_passport_links.equipment_id IS NULL OR equipment_passport_links.equipment_id = EXCLUDED.equipment_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'PASSPORT_ALREADY_LINKED' USING ERRCODE = 'P0001'; END IF;

  -- Fill device facts the passport does not have yet (never overwrite).
  UPDATE public.equipment_passports
  SET make = coalesce(make, eq.make), model = coalesce(model, eq.model),
      install_date = coalesce(install_date, eq.install_date),
      warranty_expires_at = greatest(warranty_expires_at, eq.warranty_expires_at),
      updated_at = now()
  WHERE id = v_pid;
  BEGIN
    UPDATE public.equipment_passports
    SET serial_number = eq.serial_number, serial_key = public.vp_serial_key(make, eq.serial_number)
    WHERE id = v_pid AND serial_number IS NULL AND eq.serial_number IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  IF v_was IS DISTINCT FROM true THEN
    PERFORM public.vp_append_event(v_pid, 'custody_change', 'A new servicing company verified this unit', NULL,
                                   jsonb_build_object('action', 'joined'), now(), v_owner, NULL, NULL);
    FOR r IN
      SELECT je.job_id FROM public.job_equipment je JOIN public.jobs j ON j.id = je.job_id
      WHERE je.equipment_id = eq.id AND j.job_status = 'completed'
      ORDER BY j.scheduled_datetime NULLS FIRST
    LOOP
      BEGIN
        PERFORM public.vp_record_job_service(r.job_id, eq.id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'passport backfill skipped: %', SQLERRM;
      END;
    END LOOP;
  END IF;

  RETURN public.vp_passport_json(v_pid, true, v_owner);
END;
$$;

-- Contractor B on site: scan the label, pick the customer, get a ready equipment record bound to the passport.
CREATE OR REPLACE FUNCTION public.adopt_equipment_passport(p_code text, p_customer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pid uuid;
  v_eq uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_pid FROM public.equipment_passports
  WHERE public_code = public.vp_normalize_code(p_code) AND status <> 'merged';
  IF v_pid IS NULL THEN RAISE EXCEPTION 'PASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'PASSPORT_CUSTOMER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.equipment_passport_links
             WHERE passport_id = v_pid AND user_id = v_owner AND status = 'active' AND equipment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PASSPORT_ALREADY_LINKED' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('vireek.passport_adopt', v_pid::text, true);
  INSERT INTO public.equipment (user_id, customer_id, equipment_type, make, model, serial_number, install_date, warranty_expires_at)
  SELECT v_owner, p_customer_id, p.equipment_type, p.make, p.model, p.serial_number, p.install_date, p.warranty_expires_at
  FROM public.equipment_passports p WHERE p.id = v_pid
  RETURNING id INTO v_eq;
  PERFORM set_config('vireek.passport_adopt', '', true);

  PERFORM public.vp_append_event(v_pid, 'custody_change', 'A new servicing company took over service', NULL,
                                 jsonb_build_object('action', 'adopted'), now(), v_owner, NULL, NULL);
  RETURN v_eq;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.passport_adopt', '', true);
  RAISE;
END;
$$;

-- Manual contribution (inspection, repair, part replaced, note, decommission). Private to verified contractors by default.
CREATE OR REPLACE FUNCTION public.add_equipment_passport_event(
  p_code text,
  p_type text,
  p_title text,
  p_detail text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT NULL,
  p_public boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pid uuid;
  v_id uuid;
  v_actor text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF p_type NOT IN ('inspection', 'repair', 'part_replaced', 'note', 'decommissioned') THEN
    RAISE EXCEPTION 'PASSPORT_INVALID: unsupported event type' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'PASSPORT_INVALID: title must be 1-200 characters' USING ERRCODE = 'P0001';
  END IF;
  IF p_occurred_at IS NOT NULL AND p_occurred_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'PASSPORT_INVALID: date is in the future' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.id INTO v_pid
  FROM public.equipment_passports p
  JOIN public.equipment_passport_links l ON l.passport_id = p.id
  WHERE p.public_code = public.vp_normalize_code(p_code)
    AND l.user_id = v_owner AND l.status = 'active' AND l.verified;
  IF v_pid IS NULL THEN RAISE EXCEPTION 'PASSPORT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;

  SELECT public.vp_display_name(tm.member_name) INTO v_actor FROM public.team_members tm WHERE tm.user_id = auth.uid() LIMIT 1;

  v_id := public.vp_append_event(
    v_pid, p_type, btrim(p_title), nullif(btrim(coalesce(p_detail, '')), ''),
    jsonb_strip_nulls(jsonb_build_object('manual', true, 'technician', v_actor)),
    coalesce(p_occurred_at, now()), v_owner, NULL, NULL,
    CASE WHEN p_public THEN 'public' ELSE 'network' END);

  IF p_type = 'decommissioned' THEN
    UPDATE public.equipment_passports SET status = 'retired', updated_at = now() WHERE id = v_pid;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_equipment_passport_sharing(p_code text, p_show_contractor boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.equipment_passport_links l
  SET show_contractor_publicly = p_show_contractor
  FROM public.equipment_passports p
  WHERE p.id = l.passport_id AND p.public_code = public.vp_normalize_code(p_code)
    AND l.user_id = v_owner AND l.status = 'active';
END;
$$;

-- =============================================================
-- 8. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.vp_generate_code() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_company_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_event_hash(public.equipment_passport_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_verify_chain(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_append_event(uuid, text, text, text, jsonb, timestamptz, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_issue_for_equipment(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_record_job_service(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vp_passport_json(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.verify_equipment_passport(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_equipment_passport(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_equipment_passport(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_equipment_passports() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.issue_equipment_passport(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_equipment_passport(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adopt_equipment_passport(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_equipment_passport_event(text, text, text, text, timestamptz, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_equipment_passport_sharing(text, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_equipment_passport(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_equipment_passports() TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_equipment_passport(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_equipment_passport(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adopt_equipment_passport(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_equipment_passport_event(text, text, text, text, timestamptz, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_equipment_passport_sharing(text, boolean) TO authenticated;

-- =============================================================
-- 9. BACKFILL (existing equipment + already-completed jobs). Safe to re-run.
-- =============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.equipment ORDER BY created_at LOOP
    BEGIN
      PERFORM public.vp_issue_for_equipment(r.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'passport backfill (equipment %) skipped: %', r.id, SQLERRM;
    END;
  END LOOP;

  FOR r IN
    SELECT je.job_id, je.equipment_id
    FROM public.job_equipment je JOIN public.jobs j ON j.id = je.job_id
    WHERE j.job_status = 'completed'
    ORDER BY j.scheduled_datetime NULLS FIRST
  LOOP
    BEGIN
      PERFORM public.vp_record_job_service(r.job_id, r.equipment_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'passport backfill (job %) skipped: %', r.job_id, SQLERRM;
    END;
  END LOOP;
END;
$$;
