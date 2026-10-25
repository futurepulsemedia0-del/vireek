/*
  Open Voice Benchmark (OVB) — home-service AI receptionist benchmark

  Reuses the existing eval plane: each published suite version can be mirrored
  into ai_eval_suites / ai_eval_cases (done by the ovb-run edge function), and
  every OVB run is mirrored into ai_eval_runs / ai_eval_results so AI Ops and
  the nightly AI regression see it. Purely additive. Nothing existing is altered.

  Integrity layer (enforced in the database, not in application code):
    * scenario content hashes + the exact canonical text that was hashed
    * published suites are immutable; held-out set is committed to by a salted hash
    * hash-chained, append-only run log (ovb_run_events) + ovb_verify_run_chain()
    * a run can only be published when: completed, certification purpose, zero
      unresolved human reviews, intact chain, and the agent is listed
    * agents are only ever listed publicly if first-party or they consented
    * corrections are append-only; retracted runs stay visible with their correction

  Writes: edge functions (service role) and staff RPCs only.
  Public reads: SECURITY DEFINER RPCs that never expose held-out scenarios,
  storage paths, contact details or unlisted agents.
  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 0) Helpers -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ovb_sha256_hex(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.ovb_event_hash_input(
  p_prev text, p_run uuid, p_seq integer, p_type text, p_payload jsonb, p_at timestamptz
)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT p_prev || '|' || p_run::text || '|' || p_seq::text || '|' || p_type || '|' || p_payload::text || '|'
         || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

-- 1) Suites (versioned) --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ovb_suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  changelog text NOT NULL DEFAULT '',
  rubric jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  public_manifest_hash text,
  held_out_commitment text,
  held_out_count integer NOT NULL DEFAULT 0 CHECK (held_out_count >= 0),
  held_out_salt text,
  held_out_revealed_at timestamptz,
  eval_suite_id uuid REFERENCES public.ai_eval_suites(id) ON DELETE SET NULL,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid()
);

-- 2) Scenarios --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ovb_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid NOT NULL REFERENCES public.ovb_suites(id) ON DELETE CASCADE,
  scenario_key text NOT NULL CHECK (scenario_key ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'),
  category text NOT NULL CHECK (category IN (
    'emergency_triage', 'noisy_job_site', 'accents', 'interruptions', 'price_pushback',
    'wrong_number_spam', 'after_hours_booking', 'out_of_area', 'multi_intent', 'ai_disclosure'
  )),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 140),
  summary text NOT NULL DEFAULT '',
  difficulty smallint NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),
  weight numeric(4, 2) NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 5),
  is_held_out boolean NOT NULL DEFAULT false,
  persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  acoustic jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  turns jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(turns) = 'array' THEN jsonb_array_length(turns) BETWEEN 1 AND 30 ELSE false END),
  checks jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(checks) = 'array' THEN jsonb_array_length(checks) BETWEEN 1 AND 40 ELSE false END),
  canonical_text text,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suite_id, scenario_key)
);
CREATE INDEX IF NOT EXISTS idx_ovb_scenarios_suite ON public.ovb_scenarios (suite_id, category);

-- 3) Agents (participants) -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ovb_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 120),
  vendor_name text NOT NULL CHECK (char_length(vendor_name) BETWEEN 2 AND 120),
  is_first_party boolean NOT NULL DEFAULT false,
  interface_kind text NOT NULL DEFAULT 'api' CHECK (interface_kind IN ('internal', 'phone', 'api', 'harness')),
  phone_number text CHECK (phone_number IS NULL OR phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  api_base_url text CHECK (api_base_url IS NULL OR api_base_url ~ '^https://'),
  public_listing_consent boolean NOT NULL DEFAULT false,
  listing_status text NOT NULL DEFAULT 'unlisted' CHECK (listing_status IN ('unlisted', 'listed', 'delisted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ovb_agents_listing_requires_consent CHECK (listing_status <> 'listed' OR is_first_party OR public_listing_consent)
);

-- 4) Vendor submissions (private) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ovb_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES public.ovb_agents(id) ON DELETE SET NULL,
  org_name text NOT NULL CHECK (char_length(org_name) BETWEEN 2 AND 120),
  contact_name text NOT NULL CHECK (char_length(contact_name) BETWEEN 2 AND 120),
  contact_email text NOT NULL CHECK (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND char_length(contact_email) <= 200),
  website text CHECK (website IS NULL OR char_length(website) <= 300),
  interface_kind text NOT NULL CHECK (interface_kind IN ('phone', 'api', 'harness')),
  phone_number text CHECK (phone_number IS NULL OR phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  api_base_url text CHECK (api_base_url IS NULL OR api_base_url ~ '^https://'),
  agent_name text NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 120),
  agent_version text NOT NULL CHECK (char_length(agent_version) BETWEEN 1 AND 80),
  wants_independent_run boolean NOT NULL DEFAULT false,
  wants_bundle boolean NOT NULL DEFAULT false,
  public_listing_consent boolean NOT NULL DEFAULT false,
  attestations jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  token_hash text,
  token_prefix text,
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ovb_submissions_one_path CHECK (wants_independent_run OR wants_bundle)
);
CREATE INDEX IF NOT EXISTS idx_ovb_submissions_email ON public.ovb_submissions (lower(contact_email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ovb_submissions_token ON public.ovb_submissions (token_hash) WHERE token_hash IS NOT NULL;

-- 5) Corrections (public, append-only) + incoming correction requests --------------------------
CREATE TABLE IF NOT EXISTS public.ovb_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('error', 'methodology', 'scenario_fix', 'retraction', 'clarification')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 4000),
  suite_version text,
  run_id uuid,
  supersedes_id uuid REFERENCES public.ovb_corrections(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid DEFAULT auth.uid()
);

CREATE TABLE IF NOT EXISTS public.ovb_correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_name text NOT NULL CHECK (char_length(requester_name) BETWEEN 2 AND 120),
  requester_email text NOT NULL CHECK (requester_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND char_length(requester_email) <= 200),
  requester_org text CHECK (requester_org IS NULL OR char_length(requester_org) <= 120),
  run_id uuid,
  suite_version text CHECK (suite_version IS NULL OR char_length(suite_version) <= 20),
  message text NOT NULL CHECK (char_length(message) BETWEEN 20 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'declined')),
  response_correction_id uuid REFERENCES public.ovb_corrections(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ovb_correction_requests_email ON public.ovb_correction_requests (lower(requester_email), created_at DESC);

-- 6) Runs ----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ovb_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid NOT NULL REFERENCES public.ovb_suites(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES public.ovb_agents(id) ON DELETE RESTRICT,
  submission_id uuid REFERENCES public.ovb_submissions(id) ON DELETE SET NULL,
  provenance text NOT NULL CHECK (provenance IN ('first_party', 'independent', 'vendor_submitted')),
  channel text NOT NULL CHECK (channel IN ('text_api', 'phone', 'bundle')),
  latency_basis text NOT NULL CHECK (latency_basis IN ('api_text', 'phone_e2e', 'vendor_reported')),
  purpose text NOT NULL DEFAULT 'certification' CHECK (purpose IN ('certification', 'regression')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'needs_review', 'completed', 'failed')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public', 'retracted')),
  agent_version text NOT NULL DEFAULT 'unknown' CHECK (char_length(agent_version) BETWEEN 1 AND 80),
  agent_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  engine_version text NOT NULL,
  rubric_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  seed integer NOT NULL DEFAULT 0,
  include_held_out boolean NOT NULL DEFAULT false,
  manifest_hash text NOT NULL,
  held_out_commitment text,
  scenario_count integer NOT NULL DEFAULT 0,
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_log_head text,
  eval_run_id uuid REFERENCES public.ai_eval_runs(id) ON DELETE SET NULL,
  triggered_by uuid,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  published_at timestamptz,
  retracted_at timestamptz,
  correction_id uuid REFERENCES public.ovb_corrections(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ovb_runs_bundle_matches_provenance CHECK ((provenance = 'vendor_submitted') = (channel = 'bundle'))
);
CREATE INDEX IF NOT EXISTS idx_ovb_runs_suite_vis ON public.ovb_runs (suite_id, visibility);
CREATE INDEX IF NOT EXISTS idx_ovb_runs_agent ON public.ovb_runs (agent_id, published_at DESC);

CREATE TABLE IF NOT EXISTS public.ovb_run_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.ovb_runs(id) ON DELETE RESTRICT,
  scenario_id uuid NOT NULL REFERENCES public.ovb_scenarios(id) ON DELETE RESTRICT,
  scenario_hash text NOT NULL,
  is_held_out boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scoring', 'awaiting_call', 'scored', 'needs_review', 'reviewed', 'failed')),
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  seed integer NOT NULL DEFAULT 0,
  transcript jsonb,
  transcript_sha256 text,
  outcome text,
  outcome_source text CHECK (outcome_source IS NULL OR outcome_source IN ('declared', 'tool', 'judge')),
  recording_path text,
  recording_sha256 text,
  recording_public boolean NOT NULL DEFAULT false,
  call_ref text,
  latency jsonb NOT NULL DEFAULT '{}'::jsonb,
  check_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  auto_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_scores jsonb,
  final_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_score numeric(5, 2),
  critical_failure boolean NOT NULL DEFAULT false,
  review_flags text[] NOT NULL DEFAULT '{}',
  judge_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  scored_at timestamptz,
  UNIQUE (run_id, scenario_id)
);
CREATE INDEX IF NOT EXISTS idx_ovb_run_results_run ON public.ovb_run_results (run_id, status);
CREATE INDEX IF NOT EXISTS idx_ovb_run_results_call ON public.ovb_run_results (call_ref) WHERE call_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ovb_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.ovb_runs(id) ON DELETE RESTRICT,
  seq integer NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 60),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS public.ovb_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES public.ovb_run_results(id) ON DELETE RESTRICT,
  reviewer_id uuid NOT NULL DEFAULT auth.uid(),
  verdict text NOT NULL CHECK (verdict IN ('confirm', 'override')),
  dimension_scores jsonb,
  critical_failure boolean,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_id, reviewer_id)
);

-- 7) Integrity triggers --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ovb_suites_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Published benchmark suites cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version
     OR NEW.rubric IS DISTINCT FROM OLD.rubric
     OR NEW.business_profile IS DISTINCT FROM OLD.business_profile
     OR NEW.public_manifest_hash IS DISTINCT FROM OLD.public_manifest_hash
     OR NEW.held_out_commitment IS DISTINCT FROM OLD.held_out_commitment
     OR NEW.held_out_salt IS DISTINCT FROM OLD.held_out_salt
     OR NEW.held_out_count IS DISTINCT FROM OLD.held_out_count
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'A published suite is immutable; create a new version instead';
  END IF;
  IF NEW.status = 'draft' OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
    RAISE EXCEPTION 'Invalid suite status transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ovb_suites_guard ON public.ovb_suites;
CREATE TRIGGER trg_ovb_suites_guard
  BEFORE UPDATE OR DELETE ON public.ovb_suites
  FOR EACH ROW EXECUTE FUNCTION public.ovb_suites_guard();

CREATE OR REPLACE FUNCTION public.ovb_scenarios_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_status text;
  v_version text;
  v_canon text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT s.status INTO v_status FROM public.ovb_suites s WHERE s.id = OLD.suite_id;
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'Scenarios of a published suite are immutable';
    END IF;
    RETURN OLD;
  END IF;

  SELECT s.status, s.version INTO v_status, v_version FROM public.ovb_suites s WHERE s.id = NEW.suite_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown suite';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Scenarios of a published suite are immutable';
  END IF;

  v_canon := jsonb_build_object(
    'suite', v_version, 'key', NEW.scenario_key, 'category', NEW.category, 'title', NEW.title,
    'difficulty', NEW.difficulty, 'weight', NEW.weight, 'held_out', NEW.is_held_out,
    'persona', NEW.persona, 'acoustic', NEW.acoustic, 'context', NEW.business_context,
    'turns', NEW.turns, 'checks', NEW.checks
  )::text;
  NEW.canonical_text := v_canon;
  NEW.content_hash := public.ovb_sha256_hex(v_canon);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ovb_scenarios_guard ON public.ovb_scenarios;
CREATE TRIGGER trg_ovb_scenarios_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.ovb_scenarios
  FOR EACH ROW EXECUTE FUNCTION public.ovb_scenarios_guard();

-- Hash-chained event log: seq / prev_hash / hash / created_at are always set here.
CREATE OR REPLACE FUNCTION public.ovb_run_events_chain()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_prev text;
  v_seq integer;
  v_vis text;
BEGIN
  SELECT r.visibility INTO v_vis FROM public.ovb_runs r WHERE r.id = NEW.run_id;
  IF v_vis = 'retracted' OR (v_vis = 'public' AND NEW.event_type <> 'run_retracted') THEN
    RAISE EXCEPTION 'The run log of a published run is sealed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ovb_events:' || NEW.run_id::text));
  SELECT e.hash, e.seq INTO v_prev, v_seq
  FROM public.ovb_run_events e WHERE e.run_id = NEW.run_id ORDER BY e.seq DESC LIMIT 1;
  IF v_seq IS NULL THEN
    v_seq := 0;
    v_prev := repeat('0', 64);
  END IF;
  NEW.seq := v_seq + 1;
  NEW.prev_hash := v_prev;
  NEW.created_at := clock_timestamp();
  NEW.hash := public.ovb_sha256_hex(
    public.ovb_event_hash_input(v_prev, NEW.run_id, NEW.seq, NEW.event_type, NEW.payload, NEW.created_at)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ovb_run_events_chain ON public.ovb_run_events;
CREATE TRIGGER trg_ovb_run_events_chain
  BEFORE INSERT ON public.ovb_run_events
  FOR EACH ROW EXECUTE FUNCTION public.ovb_run_events_chain();

CREATE OR REPLACE FUNCTION public.ovb_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_ovb_run_events_immutable ON public.ovb_run_events;
CREATE TRIGGER trg_ovb_run_events_immutable
  BEFORE UPDATE OR DELETE ON public.ovb_run_events
  FOR EACH ROW EXECUTE FUNCTION public.ovb_append_only();

DROP TRIGGER IF EXISTS trg_ovb_corrections_immutable ON public.ovb_corrections;
CREATE TRIGGER trg_ovb_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.ovb_corrections
  FOR EACH ROW EXECUTE FUNCTION public.ovb_append_only();

-- Recompute the whole chain; used by the publish guard and the public run page.
CREATE OR REPLACE FUNCTION public.ovb_verify_run_chain(p_run uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev text := repeat('0', 64);
  v_n integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT e.seq, e.event_type, e.payload, e.prev_hash, e.hash, e.created_at
    FROM public.ovb_run_events e WHERE e.run_id = p_run ORDER BY e.seq
  LOOP
    v_n := v_n + 1;
    IF r.seq <> v_n
       OR r.prev_hash <> v_prev
       OR r.hash <> public.ovb_sha256_hex(public.ovb_event_hash_input(v_prev, p_run, r.seq, r.event_type, r.payload, r.created_at)) THEN
      RETURN jsonb_build_object('ok', false, 'events', v_n, 'broken_at', r.seq, 'head', v_prev);
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN jsonb_build_object('ok', v_n > 0, 'events', v_n, 'broken_at', NULL::integer, 'head', v_prev);
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_runs_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_listing text;
  v_suite_status text;
  v_open integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.visibility <> 'private' THEN
      RAISE EXCEPTION 'New runs must start private';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.visibility = 'retracted' THEN
    RAISE EXCEPTION 'Retracted runs are immutable';
  END IF;

  IF OLD.visibility = 'public' THEN
    IF NEW.visibility = 'retracted' AND NEW.correction_id IS NOT NULL
       AND (to_jsonb(NEW) - 'visibility' - 'retracted_at' - 'correction_id')
           IS NOT DISTINCT FROM (to_jsonb(OLD) - 'visibility' - 'retracted_at' - 'correction_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Published runs are immutable; retract them with a correction instead';
  END IF;

  IF NEW.visibility = 'public' THEN
    IF NEW.status <> 'completed' OR NEW.purpose <> 'certification' THEN
      RAISE EXCEPTION 'Only completed certification runs can be published';
    END IF;
    SELECT a.listing_status INTO v_listing FROM public.ovb_agents a WHERE a.id = NEW.agent_id;
    IF v_listing IS DISTINCT FROM 'listed' THEN
      RAISE EXCEPTION 'The agent is not listed (first-party or vendor consent required)';
    END IF;
    SELECT s.status INTO v_suite_status FROM public.ovb_suites s WHERE s.id = NEW.suite_id;
    IF v_suite_status NOT IN ('published', 'retired') THEN
      RAISE EXCEPTION 'The suite version is not published';
    END IF;
    SELECT count(*) INTO v_open FROM public.ovb_run_results rr
    WHERE rr.run_id = NEW.id AND rr.status IN ('pending', 'scoring', 'awaiting_call', 'needs_review');
    IF v_open > 0 THEN
      RAISE EXCEPTION 'The run still has % unresolved result(s)', v_open;
    END IF;
    IF NOT (public.ovb_verify_run_chain(NEW.id) ->> 'ok')::boolean THEN
      RAISE EXCEPTION 'The run log hash chain is not intact';
    END IF;
    NEW.published_at := coalesce(NEW.published_at, now());
  ELSIF NEW.visibility = 'retracted' THEN
    RAISE EXCEPTION 'Only published runs can be retracted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ovb_runs_guard ON public.ovb_runs;
CREATE TRIGGER trg_ovb_runs_guard
  BEFORE INSERT OR UPDATE ON public.ovb_runs
  FOR EACH ROW EXECUTE FUNCTION public.ovb_runs_guard();

CREATE OR REPLACE FUNCTION public.ovb_run_results_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_vis text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Benchmark results cannot be deleted';
  END IF;
  SELECT r.visibility INTO v_vis FROM public.ovb_runs r WHERE r.id = OLD.run_id;
  IF v_vis IS DISTINCT FROM 'private' THEN
    RAISE EXCEPTION 'Results of a published run are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ovb_run_results_guard ON public.ovb_run_results;
CREATE TRIGGER trg_ovb_run_results_guard
  BEFORE UPDATE OR DELETE ON public.ovb_run_results
  FOR EACH ROW EXECUTE FUNCTION public.ovb_run_results_guard();

-- 8) Row level security (staff read; everything else goes through RPCs / service role) -----------
ALTER TABLE public.ovb_suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_run_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ovb_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ovb_suites_staff_read" ON public.ovb_suites;
CREATE POLICY "ovb_suites_staff_read" ON public.ovb_suites FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_scenarios_staff_read" ON public.ovb_scenarios;
CREATE POLICY "ovb_scenarios_staff_read" ON public.ovb_scenarios FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_agents_staff_read" ON public.ovb_agents;
CREATE POLICY "ovb_agents_staff_read" ON public.ovb_agents FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_submissions_staff_read" ON public.ovb_submissions;
CREATE POLICY "ovb_submissions_staff_read" ON public.ovb_submissions FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_corrections_staff_read" ON public.ovb_corrections;
CREATE POLICY "ovb_corrections_staff_read" ON public.ovb_corrections FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_correction_requests_staff_read" ON public.ovb_correction_requests;
CREATE POLICY "ovb_correction_requests_staff_read" ON public.ovb_correction_requests FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_runs_staff_read" ON public.ovb_runs;
CREATE POLICY "ovb_runs_staff_read" ON public.ovb_runs FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_run_results_staff_read" ON public.ovb_run_results;
CREATE POLICY "ovb_run_results_staff_read" ON public.ovb_run_results FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_run_events_staff_read" ON public.ovb_run_events;
CREATE POLICY "ovb_run_events_staff_read" ON public.ovb_run_events FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "ovb_reviews_staff_read" ON public.ovb_reviews;
CREATE POLICY "ovb_reviews_staff_read" ON public.ovb_reviews FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.ovb_suites, public.ovb_scenarios, public.ovb_agents, public.ovb_submissions,
  public.ovb_corrections, public.ovb_correction_requests, public.ovb_runs, public.ovb_run_results,
  public.ovb_run_events, public.ovb_reviews FROM anon;

-- 9) Public read RPCs (anon + authenticated) ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ovb_public_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_suite public.ovb_suites%ROWTYPE;
  v_board jsonb;
  v_cats jsonb;
  v_suites jsonb;
  v_corrections integer;
BEGIN
  SELECT count(*) INTO v_corrections FROM public.ovb_corrections;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'version', s.version, 'title', s.title, 'status', s.status, 'published_at', s.published_at,
           'manifest_hash', s.public_manifest_hash, 'held_out_commitment', s.held_out_commitment,
           'held_out_count', s.held_out_count, 'held_out_revealed', s.held_out_revealed_at IS NOT NULL
         ) ORDER BY s.published_at DESC), '[]'::jsonb)
  INTO v_suites FROM public.ovb_suites s WHERE s.status IN ('published', 'retired');

  SELECT * INTO v_suite FROM public.ovb_suites s WHERE s.status = 'published' ORDER BY s.published_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('suite', NULL::jsonb, 'leaderboard', '[]'::jsonb, 'categories', '{}'::jsonb,
                              'suites', v_suites, 'corrections_count', v_corrections);
  END IF;

  SELECT coalesce(jsonb_agg(x.item ORDER BY x.sort_score DESC NULLS LAST), '[]'::jsonb) INTO v_board
  FROM (
    SELECT DISTINCT ON (r.agent_id)
      jsonb_build_object(
        'run_id', r.id, 'agent_slug', a.slug, 'agent_name', a.display_name, 'is_first_party', a.is_first_party,
        'provenance', r.provenance, 'channel', r.channel, 'latency_basis', r.latency_basis,
        'agent_version', r.agent_version, 'scores', r.scores, 'scenario_count', r.scenario_count,
        'finished_at', r.finished_at, 'published_at', r.published_at, 'engine_version', r.engine_version
      ) AS item,
      (r.scores -> 'overall' ->> 'score')::numeric AS sort_score
    FROM public.ovb_runs r
    JOIN public.ovb_agents a ON a.id = r.agent_id
    WHERE r.suite_id = v_suite.id AND r.visibility = 'public' AND a.listing_status = 'listed'
    ORDER BY r.agent_id, r.published_at DESC
  ) x;

  SELECT coalesce(jsonb_object_agg(c.category, c.n), '{}'::jsonb) INTO v_cats
  FROM (
    SELECT sc.category, count(*) AS n FROM public.ovb_scenarios sc
    WHERE sc.suite_id = v_suite.id AND NOT sc.is_held_out GROUP BY sc.category
  ) c;

  RETURN jsonb_build_object(
    'suite', jsonb_build_object(
      'version', v_suite.version, 'title', v_suite.title, 'published_at', v_suite.published_at,
      'manifest_hash', v_suite.public_manifest_hash, 'held_out_commitment', v_suite.held_out_commitment,
      'held_out_count', v_suite.held_out_count, 'rubric', v_suite.rubric, 'changelog', v_suite.changelog
    ),
    'leaderboard', v_board,
    'categories', v_cats,
    'suites', v_suites,
    'corrections_count', v_corrections
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_public_catalog(p_version text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_suite public.ovb_suites%ROWTYPE;
BEGIN
  IF p_version IS NULL THEN
    SELECT * INTO v_suite FROM public.ovb_suites s WHERE s.status IN ('published', 'retired') ORDER BY s.published_at DESC LIMIT 1;
  ELSE
    SELECT * INTO v_suite FROM public.ovb_suites s WHERE s.version = p_version AND s.status IN ('published', 'retired');
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('suite', NULL::jsonb, 'scenarios', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'suite', jsonb_build_object(
      'version', v_suite.version, 'title', v_suite.title, 'status', v_suite.status, 'changelog', v_suite.changelog,
      'rubric', v_suite.rubric, 'business_profile', v_suite.business_profile,
      'manifest_hash', v_suite.public_manifest_hash, 'held_out_commitment', v_suite.held_out_commitment,
      'held_out_count', v_suite.held_out_count, 'held_out_revealed_at', v_suite.held_out_revealed_at,
      'held_out_salt', CASE WHEN v_suite.held_out_revealed_at IS NOT NULL THEN v_suite.held_out_salt ELSE NULL END,
      'published_at', v_suite.published_at
    ),
    'scenarios', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'scenario_key', s.scenario_key, 'category', s.category, 'title', s.title, 'summary', s.summary,
        'difficulty', s.difficulty, 'weight', s.weight, 'is_held_out', s.is_held_out, 'acoustic', s.acoustic,
        'business_context', s.business_context, 'turns', s.turns, 'checks', s.checks,
        'content_hash', s.content_hash, 'canonical_text', s.canonical_text
      ) ORDER BY s.category, s.scenario_key)
      FROM public.ovb_scenarios s
      WHERE s.suite_id = v_suite.id AND (NOT s.is_held_out OR v_suite.held_out_revealed_at IS NOT NULL)
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_public_history(p_agent_slug text DEFAULT 'vireek')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'run_id', r.id, 'suite_version', s.version, 'agent_version', r.agent_version, 'provenance', r.provenance,
    'latency_basis', r.latency_basis, 'visibility', r.visibility, 'scores', r.scores,
    'published_at', r.published_at, 'finished_at', r.finished_at, 'engine_version', r.engine_version
  ) ORDER BY r.published_at ASC), '[]'::jsonb)
  FROM public.ovb_runs r
  JOIN public.ovb_agents a ON a.id = r.agent_id
  JOIN public.ovb_suites s ON s.id = r.suite_id
  WHERE a.slug = p_agent_slug AND a.listing_status = 'listed' AND r.visibility IN ('public', 'retracted');
$$;

CREATE OR REPLACE FUNCTION public.ovb_public_run(p_run uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run public.ovb_runs%ROWTYPE;
  v_suite public.ovb_suites%ROWTYPE;
  v_agent public.ovb_agents%ROWTYPE;
  v_revealed boolean;
BEGIN
  SELECT * INTO v_run FROM public.ovb_runs r WHERE r.id = p_run AND r.visibility IN ('public', 'retracted');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_agent FROM public.ovb_agents a WHERE a.id = v_run.agent_id;
  IF v_agent.listing_status IS DISTINCT FROM 'listed' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_suite FROM public.ovb_suites s WHERE s.id = v_run.suite_id;
  v_revealed := v_suite.held_out_revealed_at IS NOT NULL;

  RETURN jsonb_build_object(
    'run', jsonb_build_object(
      'id', v_run.id, 'suite_version', v_suite.version, 'agent_slug', v_agent.slug, 'agent_name', v_agent.display_name,
      'is_first_party', v_agent.is_first_party, 'provenance', v_run.provenance, 'channel', v_run.channel,
      'latency_basis', v_run.latency_basis, 'agent_version', v_run.agent_version, 'agent_config', v_run.agent_config,
      'engine_version', v_run.engine_version, 'rubric_snapshot', v_run.rubric_snapshot, 'seed', v_run.seed,
      'include_held_out', v_run.include_held_out, 'manifest_hash', v_run.manifest_hash,
      'held_out_commitment', v_run.held_out_commitment, 'scenario_count', v_run.scenario_count, 'scores', v_run.scores,
      'visibility', v_run.visibility, 'run_log_head', v_run.run_log_head, 'started_at', v_run.started_at,
      'finished_at', v_run.finished_at, 'published_at', v_run.published_at, 'retracted_at', v_run.retracted_at,
      'correction_id', v_run.correction_id
    ),
    'results', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'scenario_key', CASE WHEN rr.is_held_out AND NOT v_revealed THEN NULL ELSE s2.scenario_key END,
        'title', CASE WHEN rr.is_held_out AND NOT v_revealed THEN 'Held-out scenario' ELSE s2.title END,
        'category', s2.category, 'is_held_out', rr.is_held_out, 'scenario_hash', rr.scenario_hash,
        'final_score', rr.final_score, 'dimensions', rr.final_scores, 'critical_failure', rr.critical_failure,
        'outcome', rr.outcome, 'outcome_source', rr.outcome_source, 'review_flags', rr.review_flags,
        'human_reviewed', (rr.status = 'reviewed'), 'latency', rr.latency,
        'check_results', CASE WHEN rr.is_held_out AND NOT v_revealed THEN NULL ELSE rr.check_results END,
        'transcript', CASE WHEN rr.is_held_out AND NOT v_revealed THEN NULL ELSE rr.transcript END,
        'transcript_sha256', rr.transcript_sha256,
        'has_recording', (rr.recording_public AND rr.recording_path IS NOT NULL AND (NOT rr.is_held_out OR v_revealed))
      ) ORDER BY rr.is_held_out, s2.category, rr.scenario_hash)
      FROM public.ovb_run_results rr
      JOIN public.ovb_scenarios s2 ON s2.id = rr.scenario_id
      WHERE rr.run_id = v_run.id
    ), '[]'::jsonb),
    'events', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'seq', e.seq, 'event_type', e.event_type, 'payload', e.payload, 'prev_hash', e.prev_hash, 'hash', e.hash,
        'at', e.created_at,
        'hash_input', public.ovb_event_hash_input(e.prev_hash, e.run_id, e.seq, e.event_type, e.payload, e.created_at)
      ) ORDER BY e.seq)
      FROM public.ovb_run_events e WHERE e.run_id = v_run.id
    ), '[]'::jsonb),
    'chain', public.ovb_verify_run_chain(v_run.id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_public_corrections()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'title', c.title, 'body', c.body, 'suite_version', c.suite_version,
    'run_id', c.run_id, 'supersedes_id', c.supersedes_id, 'published_at', c.published_at
  ) ORDER BY c.published_at DESC), '[]'::jsonb)
  FROM public.ovb_corrections c;
$$;

-- 10) Public intake RPCs (throttled, honeypot, validated) -----------------------------------------------
CREATE OR REPLACE FUNCTION public.ovb_request_submission(
  p_org_name text, p_contact_name text, p_contact_email text, p_website text, p_interface_kind text,
  p_phone_number text, p_api_base_url text, p_agent_name text, p_agent_version text,
  p_wants_independent_run boolean, p_wants_bundle boolean, p_public_listing_consent boolean,
  p_attest_profile boolean, p_attest_no_retention boolean, p_hp text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_email text := lower(btrim(coalesce(p_contact_email, '')));
BEGIN
  IF coalesce(btrim(p_hp), '') <> '' THEN
    RETURN gen_random_uuid();
  END IF;
  IF char_length(btrim(coalesce(p_org_name, ''))) < 2 OR char_length(btrim(coalesce(p_contact_name, ''))) < 2
     OR char_length(btrim(coalesce(p_agent_name, ''))) < 2 OR char_length(btrim(coalesce(p_agent_version, ''))) < 1 THEN
    RAISE EXCEPTION 'INVALID_INPUT: organisation, contact and agent names are required';
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'INVALID_INPUT: a valid contact email is required';
  END IF;
  IF p_interface_kind NOT IN ('phone', 'api', 'harness') THEN
    RAISE EXCEPTION 'INVALID_INPUT: unknown interface';
  END IF;
  IF NOT (coalesce(p_wants_independent_run, false) OR coalesce(p_wants_bundle, false)) THEN
    RAISE EXCEPTION 'INVALID_INPUT: choose an independent run, a bundle submission, or both';
  END IF;
  IF p_interface_kind = 'phone' AND coalesce(p_phone_number, '') !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'INVALID_INPUT: phone number must be in E.164 format, e.g. +16125550100';
  END IF;
  IF p_interface_kind = 'api' AND coalesce(p_api_base_url, '') !~ '^https://' THEN
    RAISE EXCEPTION 'INVALID_INPUT: the API base URL must start with https://';
  END IF;
  IF NOT (coalesce(p_attest_profile, false) AND coalesce(p_attest_no_retention, false)) THEN
    RAISE EXCEPTION 'INVALID_INPUT: both attestations are required';
  END IF;
  IF (SELECT count(*) FROM public.ovb_submissions s WHERE lower(s.contact_email) = v_email AND s.created_at > now() - interval '24 hours') >= 3
     OR (SELECT count(*) FROM public.ovb_submissions s WHERE s.created_at > now() - interval '1 hour') >= 40 THEN
    RAISE EXCEPTION 'RATE_LIMITED: please try again later';
  END IF;

  INSERT INTO public.ovb_submissions (
    org_name, contact_name, contact_email, website, interface_kind, phone_number, api_base_url,
    agent_name, agent_version, wants_independent_run, wants_bundle, public_listing_consent, attestations
  ) VALUES (
    btrim(p_org_name), btrim(p_contact_name), v_email, nullif(left(btrim(coalesce(p_website, '')), 300), ''), p_interface_kind,
    nullif(p_phone_number, ''), nullif(p_api_base_url, ''), btrim(p_agent_name), btrim(p_agent_version),
    coalesce(p_wants_independent_run, false), coalesce(p_wants_bundle, false), coalesce(p_public_listing_consent, false),
    jsonb_build_object('configured_with_benchmark_profile', true, 'no_retention_of_held_out_content', true, 'attested_at', now())
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_request_correction(
  p_name text, p_email text, p_org text, p_run uuid, p_suite_version text, p_message text, p_hp text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF coalesce(btrim(p_hp), '') <> '' THEN
    RETURN gen_random_uuid();
  END IF;
  IF char_length(btrim(coalesce(p_name, ''))) < 2 OR char_length(btrim(coalesce(p_message, ''))) < 20 THEN
    RAISE EXCEPTION 'INVALID_INPUT: name and a message of at least 20 characters are required';
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'INVALID_INPUT: a valid email is required';
  END IF;
  IF (SELECT count(*) FROM public.ovb_correction_requests c WHERE lower(c.requester_email) = v_email AND c.created_at > now() - interval '24 hours') >= 5
     OR (SELECT count(*) FROM public.ovb_correction_requests c WHERE c.created_at > now() - interval '1 hour') >= 40 THEN
    RAISE EXCEPTION 'RATE_LIMITED: please try again later';
  END IF;
  INSERT INTO public.ovb_correction_requests (requester_name, requester_email, requester_org, run_id, suite_version, message)
  VALUES (btrim(p_name), v_email, nullif(left(btrim(coalesce(p_org, '')), 120), ''), p_run,
          nullif(left(btrim(coalesce(p_suite_version, '')), 20), ''), left(btrim(p_message), 4000))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 11) Staff RPCs -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ovb_staff_create_suite(p_version text, p_title text, p_changelog text, p_copy_from text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_rubric jsonb;
  v_profile jsonb;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  SELECT s.rubric, s.business_profile INTO v_rubric, v_profile
  FROM public.ovb_suites s
  WHERE s.version = coalesce(p_copy_from, (SELECT s2.version FROM public.ovb_suites s2 ORDER BY s2.created_at DESC LIMIT 1));
  INSERT INTO public.ovb_suites (version, title, changelog, rubric, business_profile)
  VALUES (p_version, p_title, coalesce(p_changelog, ''), coalesce(v_rubric, '{}'::jsonb), coalesce(v_profile, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_import_scenarios(p_version text, p_items jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_suite_id uuid;
  v_status text;
  v_item jsonb;
  v_n integer := 0;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'p_items must be a JSON array of 1-200 scenarios';
  END IF;
  SELECT s.id, s.status INTO v_suite_id, v_status FROM public.ovb_suites s WHERE s.version = p_version;
  IF v_suite_id IS NULL THEN
    RAISE EXCEPTION 'Unknown suite version %', p_version;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Suite % is not a draft', p_version;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.ovb_scenarios (
      suite_id, scenario_key, category, title, summary, difficulty, weight, is_held_out,
      persona, acoustic, business_context, turns, checks
    ) VALUES (
      v_suite_id, v_item ->> 'scenario_key', v_item ->> 'category', v_item ->> 'title', coalesce(v_item ->> 'summary', ''),
      coalesce((v_item ->> 'difficulty')::smallint, 2), coalesce((v_item ->> 'weight')::numeric, 1),
      coalesce((v_item ->> 'is_held_out')::boolean, false),
      coalesce(v_item -> 'persona', '{}'::jsonb), coalesce(v_item -> 'acoustic', '{}'::jsonb),
      coalesce(v_item -> 'business_context', '{}'::jsonb), v_item -> 'turns', v_item -> 'checks'
    )
    ON CONFLICT (suite_id, scenario_key) DO UPDATE SET
      category = EXCLUDED.category, title = EXCLUDED.title, summary = EXCLUDED.summary,
      difficulty = EXCLUDED.difficulty, weight = EXCLUDED.weight, is_held_out = EXCLUDED.is_held_out,
      persona = EXCLUDED.persona, acoustic = EXCLUDED.acoustic, business_context = EXCLUDED.business_context,
      turns = EXCLUDED.turns, checks = EXCLUDED.checks;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Publish = freeze. Requires the held-out set (anti-overfitting) and full category coverage.
CREATE OR REPLACE FUNCTION public.ovb_staff_publish_suite(p_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_suite public.ovb_suites%ROWTYPE;
  v_min integer;
  v_held integer;
  v_missing text;
  v_salt text;
  v_commit text;
  v_manifest text;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  SELECT * INTO v_suite FROM public.ovb_suites s WHERE s.version = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown suite version %', p_version;
  END IF;
  IF v_suite.status <> 'draft' THEN
    RAISE EXCEPTION 'Suite % is already %', p_version, v_suite.status;
  END IF;

  v_min := coalesce(nullif(v_suite.rubric ->> 'min_held_out', '')::integer, 10);
  SELECT count(*) INTO v_held FROM public.ovb_scenarios sc WHERE sc.suite_id = v_suite.id AND sc.is_held_out;
  IF v_held < v_min THEN
    RAISE EXCEPTION 'Suite % has % held-out scenario(s); at least % are required before publishing', p_version, v_held, v_min;
  END IF;

  SELECT string_agg(c.category, ', ') INTO v_missing
  FROM (VALUES ('emergency_triage'), ('noisy_job_site'), ('accents'), ('interruptions'), ('price_pushback'),
               ('wrong_number_spam'), ('after_hours_booking'), ('out_of_area'), ('multi_intent'), ('ai_disclosure')) AS c(category)
  WHERE NOT EXISTS (SELECT 1 FROM public.ovb_scenarios sc WHERE sc.suite_id = v_suite.id AND NOT sc.is_held_out AND sc.category = c.category)
     OR (v_min > 0 AND NOT EXISTS (SELECT 1 FROM public.ovb_scenarios sc WHERE sc.suite_id = v_suite.id AND sc.is_held_out AND sc.category = c.category));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Every category needs public and held-out coverage; missing: %', v_missing;
  END IF;

  v_salt := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  SELECT public.ovb_sha256_hex(coalesce(string_agg(sc.content_hash, ',' ORDER BY sc.scenario_key COLLATE "C"), '') || '|' || v_salt)
  INTO v_commit FROM public.ovb_scenarios sc WHERE sc.suite_id = v_suite.id AND sc.is_held_out;
  SELECT public.ovb_sha256_hex(v_suite.version || '|' || v_suite.rubric::text || '|' || v_suite.business_profile::text || '|'
                               || coalesce(string_agg(sc.content_hash, ',' ORDER BY sc.scenario_key COLLATE "C"), ''))
  INTO v_manifest FROM public.ovb_scenarios sc WHERE sc.suite_id = v_suite.id AND NOT sc.is_held_out;

  UPDATE public.ovb_suites SET
    status = 'published', published_at = now(), public_manifest_hash = v_manifest,
    held_out_commitment = v_commit, held_out_salt = v_salt, held_out_count = v_held
  WHERE id = v_suite.id;

  RETURN jsonb_build_object('version', v_suite.version, 'manifest_hash', v_manifest, 'held_out_commitment', v_commit, 'held_out_count', v_held);
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_retire_suite(p_version text, p_reveal boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  UPDATE public.ovb_suites SET
    status = 'retired', retired_at = now(),
    held_out_revealed_at = CASE WHEN p_reveal THEN now() ELSE held_out_revealed_at END
  WHERE version = p_version AND status = 'published';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Suite % is not currently published', p_version;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_submit_review(
  p_result uuid, p_verdict text, p_scores jsonb, p_critical boolean, p_notes text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
  v_run uuid;
  v_kv record;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  IF p_verdict NOT IN ('confirm', 'override') THEN
    RAISE EXCEPTION 'Invalid verdict';
  END IF;
  IF p_verdict = 'override' AND char_length(btrim(coalesce(p_notes, ''))) < 10 THEN
    RAISE EXCEPTION 'An override needs written reasoning (10+ characters)';
  END IF;
  IF p_scores IS NOT NULL THEN
    IF jsonb_typeof(p_scores) <> 'object' THEN
      RAISE EXCEPTION 'Scores must be a JSON object';
    END IF;
    FOR v_kv IN SELECT key, value FROM jsonb_each_text(p_scores) LOOP
      IF v_kv.key NOT IN ('booking', 'safety', 'hallucination', 'latency', 'compliance')
         OR v_kv.value !~ '^[0-9]+(\.[0-9]+)?$' OR v_kv.value::numeric > 100 THEN
        RAISE EXCEPTION 'Invalid score for %', v_kv.key;
      END IF;
    END LOOP;
  END IF;
  SELECT rr.status, rr.run_id INTO v_status, v_run FROM public.ovb_run_results rr WHERE rr.id = p_result;
  IF v_run IS NULL THEN
    RAISE EXCEPTION 'Unknown result';
  END IF;
  IF v_status NOT IN ('needs_review', 'reviewed', 'scored') THEN
    RAISE EXCEPTION 'Result is not reviewable (status %)', v_status;
  END IF;

  INSERT INTO public.ovb_reviews (result_id, reviewer_id, verdict, dimension_scores, critical_failure, notes)
  VALUES (p_result, auth.uid(), p_verdict, p_scores, p_critical, coalesce(btrim(p_notes), ''))
  ON CONFLICT (result_id, reviewer_id) DO UPDATE SET
    verdict = EXCLUDED.verdict, dimension_scores = EXCLUDED.dimension_scores,
    critical_failure = EXCLUDED.critical_failure, notes = EXCLUDED.notes, created_at = now();

  UPDATE public.ovb_run_results SET
    status = 'reviewed',
    human_scores = jsonb_build_object(
      'verdict', p_verdict,
      'dimension_scores', CASE WHEN p_verdict = 'override' THEN p_scores ELSE NULL END,
      'critical_failure', CASE WHEN p_verdict = 'override' THEN p_critical ELSE NULL END
    )
  WHERE id = p_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_set_run_visibility(p_run uuid, p_visibility text, p_correction uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run public.ovb_runs%ROWTYPE;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  SELECT * INTO v_run FROM public.ovb_runs r WHERE r.id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown run';
  END IF;

  IF p_visibility = 'public' THEN
    IF v_run.visibility <> 'private' THEN
      RAISE EXCEPTION 'Run is already %', v_run.visibility;
    END IF;
    INSERT INTO public.ovb_run_events (run_id, event_type, payload)
    VALUES (p_run, 'run_published', jsonb_build_object('by_staff', true, 'scores_overall', v_run.scores -> 'overall' -> 'score'));
    UPDATE public.ovb_runs SET visibility = 'public', published_at = now() WHERE id = p_run;
  ELSIF p_visibility = 'retracted' THEN
    IF v_run.visibility <> 'public' THEN
      RAISE EXCEPTION 'Only published runs can be retracted';
    END IF;
    IF p_correction IS NULL OR NOT EXISTS (SELECT 1 FROM public.ovb_corrections c WHERE c.id = p_correction AND c.kind = 'retraction' AND c.run_id = p_run) THEN
      RAISE EXCEPTION 'A retraction correction for this run must be published first';
    END IF;
    INSERT INTO public.ovb_run_events (run_id, event_type, payload)
    VALUES (p_run, 'run_retracted', jsonb_build_object('correction_id', p_correction));
    UPDATE public.ovb_runs SET visibility = 'retracted', retracted_at = now(), correction_id = p_correction WHERE id = p_run;
  ELSE
    RAISE EXCEPTION 'Unsupported visibility change';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_add_correction(
  p_kind text, p_title text, p_body text, p_suite_version text DEFAULT NULL,
  p_run uuid DEFAULT NULL, p_supersedes uuid DEFAULT NULL, p_request uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  INSERT INTO public.ovb_corrections (kind, title, body, suite_version, run_id, supersedes_id)
  VALUES (p_kind, btrim(p_title), btrim(p_body), p_suite_version, p_run, p_supersedes)
  RETURNING id INTO v_id;
  IF p_request IS NOT NULL THEN
    UPDATE public.ovb_correction_requests SET status = 'resolved', response_correction_id = v_id WHERE id = p_request;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_update_correction_request(p_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  IF p_status NOT IN ('acknowledged', 'declined') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  UPDATE public.ovb_correction_requests SET
    status = p_status,
    acknowledged_at = coalesce(acknowledged_at, now())
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_decide_submission(
  p_id uuid, p_decision text, p_note text, p_token_hash text DEFAULT NULL, p_token_prefix text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub public.ovb_submissions%ROWTYPE;
  v_base text;
  v_slug text;
  v_agent uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  SELECT * INTO v_sub FROM public.ovb_submissions s WHERE s.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown submission';
  END IF;
  IF v_sub.status <> 'pending' THEN
    RAISE EXCEPTION 'Submission was already %', v_sub.status;
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.ovb_submissions SET status = 'rejected', review_note = left(coalesce(p_note, ''), 1000),
      reviewed_by = auth.uid(), reviewed_at = now() WHERE id = p_id;
    RETURN NULL;
  ELSIF p_decision <> 'approve' THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR coalesce(p_token_prefix, '') = '' THEN
    RAISE EXCEPTION 'An approval needs a submission token hash (sha256 hex) and prefix';
  END IF;

  v_base := trim(both '-' from lower(regexp_replace(v_sub.org_name, '[^a-zA-Z0-9]+', '-', 'g')));
  v_base := left(CASE WHEN v_base = '' THEN 'agent' ELSE v_base END, 40);
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.ovb_agents a WHERE a.slug = v_slug) LOOP
    v_slug := v_base || '-' || substr(md5(random()::text), 1, 4);
  END LOOP;

  INSERT INTO public.ovb_agents (slug, display_name, vendor_name, is_first_party, interface_kind, phone_number, api_base_url,
                                 public_listing_consent, listing_status)
  VALUES (v_slug, v_sub.agent_name, v_sub.org_name, false, v_sub.interface_kind, v_sub.phone_number, v_sub.api_base_url,
          v_sub.public_listing_consent, CASE WHEN v_sub.public_listing_consent THEN 'listed' ELSE 'unlisted' END)
  RETURNING id INTO v_agent;

  UPDATE public.ovb_submissions SET
    status = 'approved', agent_id = v_agent, token_hash = p_token_hash, token_prefix = left(p_token_prefix, 12),
    review_note = left(coalesce(p_note, ''), 1000), reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_id;
  RETURN v_agent;
END;
$$;

CREATE OR REPLACE FUNCTION public.ovb_staff_set_agent_listing(p_agent uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  IF p_status NOT IN ('unlisted', 'listed', 'delisted') THEN
    RAISE EXCEPTION 'Invalid listing status';
  END IF;
  UPDATE public.ovb_agents SET listing_status = p_status WHERE id = p_agent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown agent';
  END IF;
END;
$$;

-- 12) Grants --------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ovb_verify_run_chain(uuid) FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.ovb_public_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ovb_public_catalog(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ovb_public_history(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ovb_public_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ovb_public_corrections() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ovb_request_submission(text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ovb_request_correction(text, text, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ovb_public_overview() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_public_catalog(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_public_history(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_public_run(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_public_corrections() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_request_submission(text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, boolean, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_request_correction(text, text, text, uuid, text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.ovb_staff_create_suite(text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_import_scenarios(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_publish_suite(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_retire_suite(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_submit_review(uuid, text, jsonb, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_set_run_visibility(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_add_correction(text, text, text, text, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_update_correction_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_decide_submission(uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ovb_staff_set_agent_listing(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ovb_staff_create_suite(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_import_scenarios(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_publish_suite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_retire_suite(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_submit_review(uuid, text, jsonb, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_set_run_visibility(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_add_correction(text, text, text, text, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_update_correction_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_decide_submission(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ovb_staff_set_agent_listing(uuid, text) TO authenticated;

-- 13) Private recordings bucket (service role only: no storage policies on purpose) ----------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('ovb-recordings', 'ovb-recordings', false, 52428800,
        ARRAY['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg', 'audio/webm'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 14) First-party agent (Vireek) -------------------------------------------------------------------------------------------
INSERT INTO public.ovb_agents (slug, display_name, vendor_name, is_first_party, interface_kind, public_listing_consent, listing_status)
VALUES ('vireek', 'Vireek AI Receptionist', 'Vireek', true, 'internal', true, 'listed')
ON CONFLICT (slug) DO NOTHING;
