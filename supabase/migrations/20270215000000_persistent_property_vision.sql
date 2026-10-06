/*
  # Persistent Property Vision

  Photo -> Vision -> Equipment -> Model -> Serial -> Condition -> Installation quality
        -> Hazard -> Component -> Property Graph        (Image -> Memory -> Structured Reality)

  ## Tables (all tenant-scoped by account owner id; clients are READ-ONLY)
  - property_vision_runs      : one AI analysis pass over 1-4 photos (normalized output + token usage).
  - property_vision_captures  : one row per photo (sha256 fingerprint, location, who/when). Write-once file in bucket.
  - property_assets           : the PERSISTENT physical identity of a unit ("Unit A") with make/model/serial,
                                condition, age/remaining life, installation quality, open-hazard counters.
  - property_capture_assets   : which photo shows which asset (+ region box, match confidence/basis/status).
  - property_findings         : hazards, installation issues, condition indicators, components — tracked over
                                time (first/last seen, times observed, open / not_reobserved / resolved / dismissed).
  - property_events           : append-only timeline ("corrosion first seen", "condition worsened", ...).
  - property_vision_rate_limit: service-role only (never grant clients a write path to their own counter).

  ## Safety principles
  - AI output is a DRAFT memory: assets/findings carry human_confirmed / status and are reviewed through RPCs.
  - Identity is never merged silently: low-confidence matches create a NEW asset flagged possible_duplicate_of.
  - "Not visible any more" never auto-resolves a hazard (absence in a photo != fixed): it becomes not_reobserved.
  - Standards flags are advisory (verify_required) — never presented as a legal violation.

  ## Service Graph
  Adds node types component / hazard / capture and keeps the graph in sync through pv_graph_link_asset()
  (fail-safe: a graph problem only raises a WARNING, never blocks the core write). Edges use source = 'ai',
  so the graph's own pruning of 'system' edges never removes them.

  Additive and idempotent: safe to run on top of the current schema, safe to re-run.
*/

-- =============================================================
-- 0. STORAGE (private, tenant folder = account owner id, write-once for clients)
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('property-vision', 'property-vision', false, 15728640,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "pv_media_select" ON storage.objects;
CREATE POLICY "pv_media_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'property-vision' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

DROP POLICY IF EXISTS "pv_media_insert" ON storage.objects;
CREATE POLICY "pv_media_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'property-vision' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
-- No UPDATE / DELETE policy on purpose: property photos are write-once for clients.

-- =============================================================
-- 1. SERVICE GRAPH: allow the new node types (no-op if graph not installed)
-- =============================================================

DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.service_graph_nodes') IS NULL THEN
    RETURN;
  END IF;
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.service_graph_nodes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%node_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.service_graph_nodes DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.service_graph_nodes ADD CONSTRAINT service_graph_nodes_node_type_check CHECK (node_type IN (
    'customer', 'property', 'equipment', 'failure', 'technician', 'part', 'job',
    'outcome', 'warranty', 'vendor', 'call', 'payment', 'contractor', 'knowledge', 'agent',
    'component', 'hazard', 'capture'
  ));
END $$;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.property_vision_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  property_key text,
  target_asset_id uuid,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  model text,
  prompt_version text,
  room_type text,
  scene_summary text,
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pv_runs_user_created ON public.property_vision_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.property_vision_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.property_vision_runs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  property_key text,
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 120),
  storage_path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 15728640),
  captured_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric,
  longitude numeric,
  captured_by uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'analyzed', 'failed')),
  room_type text,
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  analyzed_at timestamptz,
  UNIQUE (user_id, storage_path),
  UNIQUE (user_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_pv_captures_property ON public.property_vision_captures (user_id, property_key, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_pv_captures_customer ON public.property_vision_captures (user_id, customer_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_pv_captures_job ON public.property_vision_captures (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.property_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  property_key text,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'other' CHECK (char_length(kind) <= 60),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 120),
  make text,
  model text,
  serial_number text,
  serial_norm text,
  serial_verified boolean NOT NULL DEFAULT false,
  specs text,
  condition text NOT NULL DEFAULT 'unknown' CHECK (condition IN ('good', 'fair', 'poor', 'critical', 'unknown')),
  condition_score integer CHECK (condition_score BETWEEN 0 AND 100),
  install_year integer CHECK (install_year BETWEEN 1900 AND 2100),
  age_basis text NOT NULL DEFAULT 'unknown' CHECK (age_basis IN ('human', 'label_date', 'serial_decode', 'visual', 'unknown')),
  age_confidence numeric(4, 3),
  age_years_est numeric(5, 1),
  age_range_min integer,
  age_range_max integer,
  expected_lifespan_years integer,
  remaining_life_years numeric(5, 1),
  installation_quality text NOT NULL DEFAULT 'unknown'
    CHECK (installation_quality IN ('good', 'acceptable', 'deficient', 'unsafe', 'unknown')),
  open_findings_count integer NOT NULL DEFAULT 0,
  open_hazard_count integer NOT NULL DEFAULT 0,
  max_open_severity text,
  capture_count integer NOT NULL DEFAULT 0,
  primary_capture_id uuid REFERENCES public.property_vision_captures(id) ON DELETE SET NULL,
  match_confidence numeric(4, 3),
  possible_duplicate_of uuid REFERENCES public.property_assets(id) ON DELETE SET NULL,
  human_confirmed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'removed', 'merged')),
  merged_into uuid REFERENCES public.property_assets(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pv_assets_property ON public.property_assets (user_id, property_key, status);
CREATE INDEX IF NOT EXISTS idx_pv_assets_customer ON public.property_assets (user_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_pv_assets_serial ON public.property_assets (user_id, serial_norm) WHERE serial_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pv_assets_equipment ON public.property_assets (equipment_id) WHERE equipment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.property_capture_assets (
  capture_id uuid NOT NULL REFERENCES public.property_vision_captures(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.property_assets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  region jsonb,
  confidence numeric(4, 3),
  match_basis text,
  match_status text NOT NULL DEFAULT 'auto' CHECK (match_status IN ('auto', 'suggested', 'new', 'confirmed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_pv_capture_assets_asset ON public.property_capture_assets (asset_id);

CREATE TABLE IF NOT EXISTS public.property_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES public.property_assets(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  property_key text,
  finding_type text NOT NULL CHECK (finding_type IN ('hazard', 'installation_issue', 'condition_indicator', 'component')),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,60}$'),
  locus text NOT NULL DEFAULT '' CHECK (char_length(locus) <= 120),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('info', 'low', 'medium', 'high', 'emergency')),
  -- For finding_type = 'component', status 'open' simply means "currently present / tracked".
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'not_reobserved', 'resolved', 'dismissed')),
  standard_hint text CHECK (standard_hint IS NULL OR char_length(standard_hint) <= 300),
  verify_required boolean NOT NULL DEFAULT false,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  region jsonb,
  first_capture_id uuid REFERENCES public.property_vision_captures(id) ON DELETE SET NULL,
  last_capture_id uuid REFERENCES public.property_vision_captures(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  times_observed integer NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pv_findings_identity ON public.property_findings (
  user_id,
  COALESCE(asset_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(property_key, ''),
  finding_type, code, locus
);
CREATE INDEX IF NOT EXISTS idx_pv_findings_asset ON public.property_findings (asset_id, status);
CREATE INDEX IF NOT EXISTS idx_pv_findings_open ON public.property_findings (user_id, severity)
  WHERE status IN ('open', 'not_reobserved') AND finding_type <> 'component';

CREATE TABLE IF NOT EXISTS public.property_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES public.property_assets(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES public.property_findings(id) ON DELETE SET NULL,
  capture_id uuid REFERENCES public.property_vision_captures(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  property_key text,
  event_type text NOT NULL CHECK (event_type IN (
    'first_seen', 'observed', 'condition_changed', 'model_identified', 'serial_identified',
    'age_estimated', 'finding_new', 'finding_worsened', 'finding_reopened', 'finding_not_reobserved',
    'finding_resolved', 'finding_dismissed', 'component_observed', 'component_replaced_suspected',
    'identity_conflict', 'possible_duplicate', 'merged', 'human_confirmed', 'human_corrected',
    'status_changed', 'promoted_to_equipment'
  )),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'low', 'medium', 'high', 'emergency')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  delta jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_key text,
  actor_type text NOT NULL DEFAULT 'ai' CHECK (actor_type IN ('ai', 'staff', 'system')),
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Makes a retried analysis idempotent (NULLs never conflict).
  UNIQUE (capture_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_pv_events_asset ON public.property_events (asset_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pv_events_property ON public.property_events (user_id, property_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.property_vision_rate_limit (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

-- =============================================================
-- 3. RLS — read-only for clients; every write goes through the edge function / RPCs below
-- =============================================================

ALTER TABLE public.property_vision_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_vision_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_capture_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_vision_rate_limit ENABLE ROW LEVEL SECURITY;
-- property_vision_rate_limit: intentionally no policies (service role only).

DROP POLICY IF EXISTS "pv_runs_select" ON public.property_vision_runs;
CREATE POLICY "pv_runs_select" ON public.property_vision_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pv_captures_select" ON public.property_vision_captures;
CREATE POLICY "pv_captures_select" ON public.property_vision_captures FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pv_assets_select" ON public.property_assets;
CREATE POLICY "pv_assets_select" ON public.property_assets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pv_capture_assets_select" ON public.property_capture_assets;
CREATE POLICY "pv_capture_assets_select" ON public.property_capture_assets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pv_findings_select" ON public.property_findings;
CREATE POLICY "pv_findings_select" ON public.property_findings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pv_events_select" ON public.property_events;
CREATE POLICY "pv_events_select" ON public.property_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._pv_sev_rank(p_sev text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_sev WHEN 'emergency' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END;
$$;

-- Mirrors remainingLifeYears() in supabase/functions/_shared/property-vision/taxonomy.ts
CREATE OR REPLACE FUNCTION public._pv_remaining_life(p_life integer, p_age numeric, p_cond text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_life IS NULL OR p_age IS NULL THEN NULL
    ELSE round((CASE p_cond
      WHEN 'critical' THEN LEAST(GREATEST(p_life - p_age, 0), 1)
      WHEN 'poor' THEN GREATEST(p_life - p_age, 0) * 0.5
      ELSE GREATEST(p_life - p_age, 0)
    END) * 2) / 2
  END;
$$;

CREATE OR REPLACE FUNCTION public._pv_refresh_asset_stats(p_asset_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.property_assets a SET
    open_findings_count = (
      SELECT count(*) FROM public.property_findings f
      WHERE f.asset_id = a.id AND f.finding_type <> 'component' AND f.status IN ('open', 'not_reobserved')),
    open_hazard_count = (
      SELECT count(*) FROM public.property_findings f
      WHERE f.asset_id = a.id AND f.finding_type = 'hazard' AND f.status IN ('open', 'not_reobserved')),
    max_open_severity = (
      SELECT f.severity FROM public.property_findings f
      WHERE f.asset_id = a.id AND f.finding_type <> 'component' AND f.status IN ('open', 'not_reobserved')
      ORDER BY public._pv_sev_rank(f.severity) DESC LIMIT 1),
    capture_count = (
      SELECT count(*) FROM public.property_capture_assets ca
      WHERE ca.asset_id = a.id AND ca.match_status <> 'rejected'),
    updated_at = now()
  WHERE a.id = p_asset_id;
$$;

-- =============================================================
-- 5. GRAPH SYNC (idempotent, fail-safe)
-- =============================================================

CREATE OR REPLACE FUNCTION public.pv_graph_link_asset(p_asset_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.property_assets%ROWTYPE;
  v_node uuid;
  v_prop uuid;
  v_cust uuid;
  v_child uuid;
  v_job uuid;
  v_addr text;
  f record;
  c record;
BEGIN
  IF to_regprocedure('public._sg_node(uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public._sg_edge(uuid,uuid,uuid,text,text,jsonb)') IS NULL THEN
    RETURN; -- Service Graph not installed: nothing to do.
  END IF;

  BEGIN
    SELECT * INTO a FROM public.property_assets WHERE id = p_asset_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    IF a.status = 'merged' THEN
      DELETE FROM public.service_graph_nodes
      WHERE user_id = a.user_id AND node_type = 'equipment' AND node_key = 'pv:' || a.id::text;
      RETURN;
    END IF;

    -- Reuse the real equipment row's node once the asset was promoted; otherwise a standalone node.
    v_node := NULL;
    IF a.equipment_id IS NOT NULL THEN
      v_node := public._sg_find(a.user_id, 'equipment', a.equipment_id::text);
      IF v_node IS NULL AND to_regprocedure('public._sg_sync_equipment(uuid)') IS NOT NULL THEN
        PERFORM public._sg_sync_equipment(a.equipment_id);
        v_node := public._sg_find(a.user_id, 'equipment', a.equipment_id::text);
      END IF;
      IF v_node IS NOT NULL THEN
        DELETE FROM public.service_graph_nodes
        WHERE user_id = a.user_id AND node_type = 'equipment' AND node_key = 'pv:' || a.id::text;
      END IF;
    END IF;
    IF v_node IS NULL THEN
      v_node := public._sg_node(a.user_id, 'equipment', 'pv:' || a.id::text, a.label, '{}'::jsonb);
    END IF;

    UPDATE public.service_graph_nodes SET
      properties = properties || jsonb_strip_nulls(jsonb_build_object(
        'vision', true,
        'asset_id', a.id,
        'kind', a.kind,
        'make', a.make,
        'model', a.model,
        'serial', CASE WHEN a.serial_verified THEN a.serial_number END,
        'condition', a.condition,
        'condition_score', a.condition_score,
        'install_year', a.install_year,
        'age_basis', a.age_basis,
        'remaining_life_years', a.remaining_life_years,
        'installation_quality', a.installation_quality,
        'open_hazards', a.open_hazard_count,
        'human_confirmed', a.human_confirmed,
        'last_seen_at', a.last_seen_at
      )),
      updated_at = now()
    WHERE id = v_node;

    IF a.property_key IS NOT NULL THEN
      v_prop := public._sg_find(a.user_id, 'property', a.property_key);
      IF v_prop IS NULL THEN
        SELECT NULLIF(btrim(to_jsonb(cu)->>'address'), '') INTO v_addr
        FROM public.customers cu WHERE cu.id = a.customer_id;
        v_prop := public._sg_node(a.user_id, 'property', a.property_key, COALESCE(v_addr, a.property_key), '{}'::jsonb);
      END IF;
      PERFORM public._sg_edge(a.user_id, v_prop, v_node, 'has_equipment', 'ai', jsonb_build_object('via', 'property_vision'));
    END IF;

    IF a.customer_id IS NOT NULL THEN
      v_cust := public._sg_find(a.user_id, 'customer', a.customer_id::text);
      IF v_cust IS NOT NULL THEN
        PERFORM public._sg_edge(a.user_id, v_cust, v_node, 'owns_equipment', 'ai', jsonb_build_object('via', 'property_vision'));
      END IF;
    END IF;

    FOR f IN
      SELECT * FROM public.property_findings
      WHERE asset_id = a.id AND finding_type IN ('hazard', 'installation_issue', 'component')
      ORDER BY last_seen_at DESC LIMIT 60
    LOOP
      v_child := public._sg_node(
        a.user_id,
        CASE WHEN f.finding_type = 'component' THEN 'component' ELSE 'hazard' END,
        'pvf:' || f.id::text,
        f.title,
        jsonb_strip_nulls(jsonb_build_object(
          'finding_type', f.finding_type, 'code', f.code, 'severity', f.severity, 'status', f.status,
          'first_seen_at', f.first_seen_at, 'last_seen_at', f.last_seen_at,
          'times_observed', f.times_observed, 'standard_hint', f.standard_hint,
          'verify_required', f.verify_required
        ))
      );
      PERFORM public._sg_edge(
        a.user_id, v_node, v_child,
        CASE WHEN f.finding_type = 'component' THEN 'has_component' ELSE 'has_hazard' END,
        'ai', jsonb_build_object('via', 'property_vision')
      );
    END LOOP;

    FOR c IN
      SELECT pc.id, pc.captured_at, pc.job_id, pc.location_label
      FROM public.property_capture_assets ca
      JOIN public.property_vision_captures pc ON pc.id = ca.capture_id
      WHERE ca.asset_id = a.id AND ca.match_status <> 'rejected'
      ORDER BY pc.captured_at DESC LIMIT 6
    LOOP
      v_child := public._sg_node(
        a.user_id, 'capture', 'pvc:' || c.id::text,
        'Photo ' || to_char(c.captured_at, 'YYYY-MM-DD'),
        jsonb_strip_nulls(jsonb_build_object('captured_at', c.captured_at, 'location', c.location_label))
      );
      PERFORM public._sg_edge(a.user_id, v_child, v_node, 'depicts', 'ai', jsonb_build_object('via', 'property_vision'));
      IF c.job_id IS NOT NULL THEN
        v_job := public._sg_find(a.user_id, 'job', c.job_id::text);
        IF v_job IS NOT NULL THEN
          PERFORM public._sg_edge(a.user_id, v_job, v_child, 'documented', 'ai', jsonb_build_object('via', 'property_vision'));
        END IF;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pv_graph_link_asset(%) skipped: %', p_asset_id, SQLERRM;
  END;
END;
$$;

-- =============================================================
-- 6. HUMAN REVIEW RPCs (account-owner scoped; AI memory never becomes "confirmed" by itself)
-- =============================================================

CREATE OR REPLACE FUNCTION public.pv_review_asset(
  p_asset_id uuid, p_action text, p_patch jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  a public.property_assets%ROWTYPE;
  v_serial text;
  v_year integer;
  v_status text;
  v_type text;
  v_eq uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO a FROM public.property_assets WHERE id = p_asset_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF a.status = 'merged' THEN
    RAISE EXCEPTION 'This asset was merged into another one';
  END IF;

  IF p_action = 'confirm' THEN
    UPDATE public.property_assets
      SET human_confirmed = true, serial_verified = (serial_norm IS NOT NULL), updated_at = now()
      WHERE id = a.id;
    INSERT INTO public.property_events (user_id, asset_id, customer_id, property_key, event_type, summary, actor_type, actor_user_id)
    VALUES (v_owner, a.id, a.customer_id, a.property_key, 'human_confirmed', 'Identity confirmed by staff', 'staff', auth.uid());

  ELSIF p_action = 'not_duplicate' THEN
    UPDATE public.property_assets SET possible_duplicate_of = NULL, updated_at = now() WHERE id = a.id;

  ELSIF p_action = 'correct' THEN
    IF p_patch ? 'serial_number' THEN
      v_serial := upper(regexp_replace(COALESCE(p_patch->>'serial_number', ''), '[^A-Za-z0-9]', '', 'g'));
      IF v_serial = '' THEN
        v_serial := NULL;
      END IF;
    ELSE
      v_serial := a.serial_norm;
    END IF;
    IF p_patch ? 'install_year' AND NULLIF(p_patch->>'install_year', '') IS NOT NULL THEN
      v_year := (p_patch->>'install_year')::integer;
      IF v_year < 1950 OR v_year > date_part('year', now())::integer + 1 THEN
        RAISE EXCEPTION 'Install year out of range';
      END IF;
    ELSE
      v_year := a.install_year;
    END IF;

    UPDATE public.property_assets SET
      label = COALESCE(NULLIF(btrim(p_patch->>'label'), ''), label),
      kind = COALESCE(NULLIF(btrim(p_patch->>'kind'), ''), kind),
      make = CASE WHEN p_patch ? 'make' THEN NULLIF(btrim(p_patch->>'make'), '') ELSE make END,
      model = CASE WHEN p_patch ? 'model' THEN NULLIF(btrim(p_patch->>'model'), '') ELSE model END,
      location_label = CASE WHEN p_patch ? 'location_label' THEN NULLIF(btrim(p_patch->>'location_label'), '') ELSE location_label END,
      serial_number = CASE WHEN p_patch ? 'serial_number' THEN NULLIF(btrim(p_patch->>'serial_number'), '') ELSE serial_number END,
      serial_norm = v_serial,
      serial_verified = CASE WHEN p_patch ? 'serial_number' THEN (v_serial IS NOT NULL) ELSE serial_verified END,
      install_year = v_year,
      age_basis = CASE WHEN v_year IS DISTINCT FROM a.install_year THEN 'human' ELSE age_basis END,
      age_years_est = CASE WHEN v_year IS DISTINCT FROM a.install_year
                           THEN GREATEST(date_part('year', now())::integer - v_year, 0) ELSE age_years_est END,
      human_confirmed = true,
      updated_at = now()
    WHERE id = a.id;

    UPDATE public.property_assets
      SET remaining_life_years = public._pv_remaining_life(expected_lifespan_years, age_years_est, condition)
      WHERE id = a.id;
    INSERT INTO public.property_events (user_id, asset_id, customer_id, property_key, event_type, summary, delta, actor_type, actor_user_id)
    VALUES (v_owner, a.id, a.customer_id, a.property_key, 'human_corrected', 'Details corrected by staff',
            jsonb_build_object('fields', (SELECT jsonb_agg(k) FROM jsonb_object_keys(p_patch) AS k)), 'staff', auth.uid());

  ELSIF p_action = 'set_status' THEN
    v_status := p_patch->>'status';
    IF v_status IS NULL OR v_status NOT IN ('active', 'replaced', 'removed') THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    UPDATE public.property_assets SET status = v_status, updated_at = now() WHERE id = a.id;
    INSERT INTO public.property_events (user_id, asset_id, customer_id, property_key, event_type, summary, delta, actor_type, actor_user_id)
    VALUES (v_owner, a.id, a.customer_id, a.property_key, 'status_changed', 'Marked as ' || v_status,
            jsonb_build_object('from', a.status, 'to', v_status), 'staff', auth.uid());

  ELSIF p_action = 'promote' THEN
    IF a.equipment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Already linked to an equipment record';
    END IF;
    IF a.customer_id IS NULL THEN
      RAISE EXCEPTION 'This asset has no customer — scan it from a customer or job first';
    END IF;
    v_type := CASE a.kind
      WHEN 'water_heater' THEN 'Water Heater' WHEN 'furnace' THEN 'Furnace' WHEN 'boiler' THEN 'Boiler'
      WHEN 'air_conditioner' THEN 'Central AC' WHEN 'heat_pump' THEN 'Heat Pump'
      WHEN 'electrical_panel' THEN 'Electrical Panel' WHEN 'sump_pump' THEN 'Sump Pump'
      WHEN 'well_pump' THEN 'Well Pump'
      ELSE initcap(replace(a.kind, '_', ' '))
    END;
    INSERT INTO public.equipment (user_id, customer_id, equipment_type, make, model, serial_number, install_date, notes, expected_lifespan_years)
    VALUES (
      v_owner, a.customer_id, v_type, a.make, a.model, a.serial_number,
      CASE WHEN a.install_year BETWEEN 1950 AND 2100 AND a.age_basis IN ('label_date', 'serial_decode', 'human')
           THEN make_date(a.install_year, 1, 1) END,
      'Created from Property Vision', COALESCE(a.expected_lifespan_years, 15)
    ) RETURNING id INTO v_eq;
    UPDATE public.property_assets SET equipment_id = v_eq, human_confirmed = true, updated_at = now() WHERE id = a.id;
    INSERT INTO public.property_events (user_id, asset_id, customer_id, property_key, event_type, summary, delta, actor_type, actor_user_id)
    VALUES (v_owner, a.id, a.customer_id, a.property_key, 'promoted_to_equipment', 'Saved as an equipment record',
            jsonb_build_object('equipment_id', v_eq), 'staff', auth.uid());

  ELSE
    RAISE EXCEPTION 'Unknown action';
  END IF;

  PERFORM public._pv_refresh_asset_stats(a.id);
  PERFORM public.pv_graph_link_asset(a.id);
  RETURN jsonb_build_object('ok', true, 'asset_id', a.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.pv_review_finding(p_finding_id uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  f public.property_findings%ROWTYPE;
  v_status text;
  v_event text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO f FROM public.property_findings WHERE id = p_finding_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Finding not found';
  END IF;

  IF p_action = 'resolve' THEN
    v_status := 'resolved'; v_event := 'finding_resolved';
  ELSIF p_action = 'dismiss' THEN
    v_status := 'dismissed'; v_event := 'finding_dismissed';
  ELSIF p_action = 'reopen' THEN
    v_status := 'open'; v_event := 'finding_reopened';
  ELSE
    RAISE EXCEPTION 'Unknown action';
  END IF;

  UPDATE public.property_findings SET
    status = v_status,
    resolved_at = CASE WHEN v_status IN ('resolved', 'dismissed') THEN now() ELSE NULL END,
    resolved_by = CASE WHEN v_status IN ('resolved', 'dismissed') THEN auth.uid() ELSE NULL END
  WHERE id = f.id;

  INSERT INTO public.property_events (user_id, asset_id, finding_id, customer_id, property_key, event_type, severity, summary, delta, actor_type, actor_user_id)
  VALUES (v_owner, f.asset_id, f.id, f.customer_id, f.property_key, v_event, 'info',
          left(f.title || ' — ' || replace(v_status, '_', ' ') || COALESCE(' (' || NULLIF(btrim(p_note), '') || ')', ''), 500),
          jsonb_build_object('from', f.status, 'to', v_status), 'staff', auth.uid());

  IF f.asset_id IS NOT NULL THEN
    PERFORM public._pv_refresh_asset_stats(f.asset_id);
    PERFORM public.pv_graph_link_asset(f.asset_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'finding_id', f.id, 'status', v_status);
END;
$$;

-- Merge a duplicate asset into the one to keep (fixes identity mistakes without losing history).
CREATE OR REPLACE FUNCTION public.pv_merge_assets(p_keep uuid, p_drop uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  k public.property_assets%ROWTYPE;
  d public.property_assets%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_keep IS NULL OR p_drop IS NULL OR p_keep = p_drop THEN
    RAISE EXCEPTION 'Pick two different assets';
  END IF;
  SELECT * INTO k FROM public.property_assets WHERE id = p_keep AND user_id = v_owner AND status <> 'merged' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset to keep not found';
  END IF;
  SELECT * INTO d FROM public.property_assets WHERE id = p_drop AND user_id = v_owner AND status <> 'merged' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset to merge not found';
  END IF;

  -- Photo links (drop conflicting duplicates first)
  DELETE FROM public.property_capture_assets x USING public.property_capture_assets y
  WHERE x.asset_id = p_drop AND y.asset_id = p_keep AND y.capture_id = x.capture_id;
  UPDATE public.property_capture_assets SET asset_id = p_keep, match_status = 'confirmed' WHERE asset_id = p_drop;

  -- Findings: fold counters of identical findings, then move the rest
  UPDATE public.property_findings kf SET
    times_observed = kf.times_observed + df.times_observed,
    first_seen_at = LEAST(kf.first_seen_at, df.first_seen_at),
    last_seen_at = GREATEST(kf.last_seen_at, df.last_seen_at)
  FROM public.property_findings df
  WHERE kf.asset_id = p_keep AND df.asset_id = p_drop
    AND kf.finding_type = df.finding_type AND kf.code = df.code AND kf.locus = df.locus
    AND kf.property_key IS NOT DISTINCT FROM df.property_key
    AND kf.customer_id IS NOT DISTINCT FROM df.customer_id;

  WITH del AS (
    DELETE FROM public.property_findings df USING public.property_findings kf
    WHERE df.asset_id = p_drop AND kf.asset_id = p_keep
      AND kf.finding_type = df.finding_type AND kf.code = df.code AND kf.locus = df.locus
      AND kf.property_key IS NOT DISTINCT FROM df.property_key
      AND kf.customer_id IS NOT DISTINCT FROM df.customer_id
    RETURNING df.id
  )
  DELETE FROM public.service_graph_nodes
  WHERE user_id = v_owner AND node_type IN ('hazard', 'component')
    AND node_key IN (SELECT 'pvf:' || id::text FROM del);

  UPDATE public.property_findings SET asset_id = p_keep WHERE asset_id = p_drop;
  UPDATE public.property_events SET asset_id = p_keep WHERE asset_id = p_drop;

  UPDATE public.property_assets SET
    make = COALESCE(make, d.make),
    model = COALESCE(model, d.model),
    specs = COALESCE(specs, d.specs),
    location_label = COALESCE(location_label, d.location_label),
    serial_number = CASE WHEN serial_norm IS NULL THEN d.serial_number ELSE serial_number END,
    serial_verified = CASE WHEN serial_norm IS NULL THEN d.serial_verified ELSE serial_verified END,
    serial_norm = COALESCE(serial_norm, d.serial_norm),
    equipment_id = COALESCE(equipment_id, d.equipment_id),
    human_confirmed = true,
    possible_duplicate_of = NULL,
    first_seen_at = LEAST(first_seen_at, d.first_seen_at),
    last_seen_at = GREATEST(last_seen_at, d.last_seen_at),
    updated_at = now()
  WHERE id = p_keep;

  UPDATE public.property_assets SET possible_duplicate_of = NULL WHERE possible_duplicate_of IN (p_keep, p_drop);
  UPDATE public.property_assets SET
    status = 'merged', merged_into = p_keep, equipment_id = NULL, primary_capture_id = NULL, updated_at = now()
  WHERE id = p_drop;

  INSERT INTO public.property_events (user_id, asset_id, customer_id, property_key, event_type, summary, delta, actor_type, actor_user_id)
  VALUES (v_owner, p_keep, k.customer_id, k.property_key, 'merged',
          left('Merged duplicate "' || d.label || '" into this asset', 500),
          jsonb_build_object('merged_asset_id', p_drop), 'staff', auth.uid());

  PERFORM public._pv_refresh_asset_stats(p_keep);
  PERFORM public.pv_graph_link_asset(p_drop);
  PERFORM public.pv_graph_link_asset(p_keep);
  RETURN jsonb_build_object('ok', true, 'kept', p_keep, 'merged', p_drop);
END;
$$;

-- =============================================================
-- 7. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public._pv_sev_rank(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pv_remaining_life(integer, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pv_refresh_asset_stats(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pv_graph_link_asset(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pv_sev_rank(text) TO service_role;
GRANT EXECUTE ON FUNCTION public._pv_remaining_life(integer, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public._pv_refresh_asset_stats(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pv_graph_link_asset(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.pv_review_asset(uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pv_review_finding(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pv_merge_assets(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pv_review_asset(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pv_review_finding(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pv_merge_assets(uuid, uuid) TO authenticated;

COMMENT ON TABLE public.property_assets IS
  'Persistent physical identity of a unit at a property, built from photos (AI draft until human_confirmed).';
COMMENT ON TABLE public.property_findings IS
  'Hazards / installation issues / condition indicators / components tracked over time. Absence in a photo never auto-resolves a finding.';
COMMENT ON TABLE public.property_events IS
  'Append-only property memory timeline.';
