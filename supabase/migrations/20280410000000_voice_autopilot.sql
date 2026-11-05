/*
  # Voice Autopilot + Human CSR QA

  Extends Call Scripts (call_scripts / call_script_versions / call_script_assignments) — no parallel assignment
  system. The experiment engine drives the EXISTING challenger fields; this migration adds:
   1. variant metadata on versions (dimension, voice_pace) + a DB-level compliance lock on script text
   2. voice_autopilot_settings (mode off|suggest|auto + limits + pooled-prior opt-in)
   3. voice_experiments (pre-registration frozen at start) + voice_experiment_looks (append-only analyses)
   4. voice_autopilot_audit (append-only, attributable; written by triggers so EVERY path is audited)
   5. voice_prior_contributions + get_voice_pooled_prior() (opt-in, anonymised, k >= 10 accounts)
   6. RPCs: voice_experiment_start / voice_experiment_conclude
   7. Human CSR QA: csr_qa_settings (opt-in, OFF by default), csr_qa_reviews, access + retention

  Execution order: run once, after 20280401000000_voice_brand.sql. Safe to re-run (IF NOT EXISTS / OR REPLACE).
  Rollback: see the "ROLLBACK" block at the bottom (commented out — destructive, run deliberately).
*/

-- =============================================================
-- 1. Variant metadata + compliance lock on script text
-- =============================================================
ALTER TABLE public.call_script_versions
  ADD COLUMN IF NOT EXISTS dimension text
    CHECK (dimension IS NULL OR dimension IN ('greeting','discovery_order','objection_handling','booking_ask','voice_pace')),
  ADD COLUMN IF NOT EXISTS voice_pace text
    CHECK (voice_pace IS NULL OR voice_pace IN ('slower','normal','faster'));

-- Mirrors supabase/functions/_shared/voice-autopilot/locks.ts (a unit test asserts the patterns are identical).
CREATE OR REPLACE FUNCTION public.voice_autopilot_lock_violation(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT r.id
  FROM (VALUES
    ('no_remove_disclosure', $re$\y(skip|omit|drop|remove|bypass|suppress|avoid|hide|don'?t|do not|never|without|stop)\y[^.\n]{0,40}\y(disclos\w*|(that )?(you are|you're|this is) (an? )?(ai|virtual|automated|assistant))$re$),
    ('no_remove_recording_consent', $re$\y(skip|omit|drop|remove|bypass|suppress|avoid|hide|don'?t|do not|never|without|stop)\y[^.\n]{0,40}\y(record\w*|consent)$re$),
    ('no_claim_human', $re$\y(pretend|claim|say|tell|insist|act)\y[^.\n]{0,30}\y(human|real person|live person|not (an? )?(ai|robot|bot))$re$),
    ('no_override_compliance', $re$\y(ignore|override|replace|disregard|bypass)\y[^.\n]{0,40}\y(disclosure|consent|compliance|safety|emergency|911)$re$),
    ('no_skip_emergency_guidance', $re$\y(skip|don'?t|do not|never|avoid)\y[^.\n]{0,30}\y(911|emergency services|evacuat\w*|leave the (area|house|building))$re$)
  ) AS r(id, re)
  WHERE coalesce(p_text, '') ~* r.re
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.call_script_versions_lock_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v text;
BEGIN
  v := public.voice_autopilot_lock_violation(NEW.opening_line || E'\n' || NEW.body);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'Script text may not remove or override locked compliance language (%).', v USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_script_versions_lock_check ON public.call_script_versions;
CREATE TRIGGER trg_call_script_versions_lock_check
  BEFORE INSERT ON public.call_script_versions
  FOR EACH ROW EXECUTE FUNCTION public.call_script_versions_lock_check();

-- =============================================================
-- 2. Settings
-- =============================================================
CREATE TABLE IF NOT EXISTS public.voice_autopilot_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'suggest' CHECK (mode IN ('off','suggest','auto')),
  max_traffic_pct integer NOT NULL DEFAULT 20 CHECK (max_traffic_pct BETWEEN 1 AND 50),
  max_auto_promotions_per_week integer NOT NULL DEFAULT 1 CHECK (max_auto_promotions_per_week BETWEEN 0 AND 7),
  pooled_priors_opt_in boolean NOT NULL DEFAULT false,
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 3. Experiments (pre-registration) + looks
-- =============================================================
CREATE TABLE IF NOT EXISTS public.voice_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  script_id uuid NOT NULL REFERENCES public.call_scripts(id) ON DELETE CASCADE,
  scenario text NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  hypothesis text CHECK (hypothesis IS NULL OR char_length(hypothesis) <= 400),
  dimension text NOT NULL CHECK (dimension IN ('greeting','discovery_order','objection_handling','booking_ask','voice_pace')),
  control_version_id uuid NOT NULL REFERENCES public.call_script_versions(id) ON DELETE RESTRICT,
  challenger_version_id uuid NOT NULL REFERENCES public.call_script_versions(id) ON DELETE RESTRICT,
  traffic_pct integer NOT NULL CHECK (traffic_pct BETWEEN 1 AND 50),
  -- Frozen at start; see guard trigger. {primaryMetric,nMaxPerArm,minEffect,guardrailMargins,waivedGuardrails}
  prereg jsonb NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','awaiting_approval','promoted','rolled_back','stopped','inconclusive')),
  last_look_done smallint NOT NULL DEFAULT 0 CHECK (last_look_done BETWEEN 0 AND 4),
  started_at timestamptz NOT NULL DEFAULT now(),
  concluded_at timestamptz,
  conclusion jsonb,
  created_by uuid DEFAULT auth.uid(),
  CHECK (control_version_id <> challenger_version_id)
);
-- at most ONE live experiment per script
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_experiments_live
  ON public.voice_experiments (script_id) WHERE status IN ('running','awaiting_approval');
CREATE INDEX IF NOT EXISTS idx_voice_experiments_user ON public.voice_experiments (user_id, started_at DESC);

CREATE OR REPLACE FUNCTION public.voice_experiments_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prereg IS DISTINCT FROM OLD.prereg
       OR NEW.control_version_id <> OLD.control_version_id
       OR NEW.challenger_version_id <> OLD.challenger_version_id
       OR NEW.dimension <> OLD.dimension OR NEW.script_id <> OLD.script_id OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'A started experiment is pre-registered and cannot be edited' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('promoted','rolled_back','stopped','inconclusive') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'A concluded experiment cannot be reopened' USING ERRCODE = '23514';
    END IF;
    IF NEW.last_look_done < OLD.last_look_done THEN
      RAISE EXCEPTION 'Looks cannot be undone' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_voice_experiments_guard ON public.voice_experiments;
CREATE TRIGGER trg_voice_experiments_guard BEFORE INSERT OR UPDATE ON public.voice_experiments
  FOR EACH ROW EXECUTE FUNCTION public.voice_experiments_guard();

CREATE TABLE IF NOT EXISTS public.voice_experiment_looks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES public.voice_experiments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  look smallint NOT NULL CHECK (look BETWEEN 1 AND 4),
  n_control integer NOT NULL, n_challenger integer NOT NULL,
  result jsonb NOT NULL,           -- the full Evaluation object that drove the decision
  decision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, look)     -- a look is analysed exactly once (no re-rolling the dice)
);

-- =============================================================
-- 4. Audit log (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.voice_autopilot_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','system')),
  event text NOT NULL CHECK (char_length(event) BETWEEN 1 AND 60),
  script_id uuid, experiment_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_autopilot_audit_user ON public.voice_autopilot_audit (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.voice_autopilot_audit_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'voice_autopilot_audit is append-only' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS trg_voice_autopilot_audit_immutable ON public.voice_autopilot_audit;
CREATE TRIGGER trg_voice_autopilot_audit_immutable BEFORE UPDATE OR DELETE ON public.voice_autopilot_audit
  FOR EACH ROW EXECUTE FUNCTION public.voice_autopilot_audit_immutable();

CREATE OR REPLACE FUNCTION public.voice_autopilot_write_audit(
  p_user uuid, p_event text, p_script uuid, p_experiment uuid, p_payload jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.voice_autopilot_audit (user_id, actor_id, actor_kind, event, script_id, experiment_id, payload)
  VALUES (p_user, auth.uid(), CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'user' END, p_event, p_script, p_experiment, coalesce(p_payload, '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.voice_autopilot_write_audit(uuid, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Every change to what is LIVE or to the traffic split is audited, whichever code path made it
-- (dashboard, autopilot, SQL console). Versions themselves are immutable, so "diffable" = compare version rows.
CREATE OR REPLACE FUNCTION public.call_scripts_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.active_version_id IS DISTINCT FROM OLD.active_version_id
     OR NEW.challenger_version_id IS DISTINCT FROM OLD.challenger_version_id
     OR NEW.challenger_traffic_pct IS DISTINCT FROM OLD.challenger_traffic_pct THEN
    PERFORM public.voice_autopilot_write_audit(NEW.user_id, 'script_pointer_changed', NEW.id, NULL, jsonb_build_object(
      'scenario', NEW.scenario,
      'active_before', OLD.active_version_id, 'active_after', NEW.active_version_id,
      'challenger_before', OLD.challenger_version_id, 'challenger_after', NEW.challenger_version_id,
      'pct_before', OLD.challenger_traffic_pct, 'pct_after', NEW.challenger_traffic_pct));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_call_scripts_audit ON public.call_scripts;
CREATE TRIGGER trg_call_scripts_audit AFTER UPDATE ON public.call_scripts
  FOR EACH ROW EXECUTE FUNCTION public.call_scripts_audit();

-- Every A/B must be pre-registered: a challenger can only be SET while a live experiment names it.
CREATE OR REPLACE FUNCTION public.call_scripts_require_registration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.challenger_version_id IS NOT NULL
     AND NEW.challenger_version_id IS DISTINCT FROM OLD.challenger_version_id
     AND NOT EXISTS (SELECT 1 FROM public.voice_experiments e
                     WHERE e.script_id = NEW.id AND e.challenger_version_id = NEW.challenger_version_id
                       AND e.status IN ('running','awaiting_approval')) THEN
    RAISE EXCEPTION 'Start A/B tests through voice_experiment_start so they are pre-registered' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_call_scripts_require_registration ON public.call_scripts;
CREATE TRIGGER trg_call_scripts_require_registration BEFORE UPDATE ON public.call_scripts
  FOR EACH ROW EXECUTE FUNCTION public.call_scripts_require_registration();

-- Legacy/manual paths (Stop / Promote buttons that update call_scripts directly) must not leave a zombie experiment.
CREATE OR REPLACE FUNCTION public.call_scripts_sync_experiments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.challenger_version_id IS NOT NULL AND NEW.challenger_version_id IS DISTINCT FROM OLD.challenger_version_id THEN
    UPDATE public.voice_experiments e
       SET status = CASE WHEN NEW.active_version_id = e.challenger_version_id THEN 'promoted' ELSE 'stopped' END,
           concluded_at = now(),
           conclusion = jsonb_build_object('manual', true)
     WHERE e.script_id = NEW.id AND e.challenger_version_id = OLD.challenger_version_id AND e.status IN ('running','awaiting_approval');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_call_scripts_sync_experiments ON public.call_scripts;
CREATE TRIGGER trg_call_scripts_sync_experiments AFTER UPDATE ON public.call_scripts
  FOR EACH ROW EXECUTE FUNCTION public.call_scripts_sync_experiments();

-- =============================================================
-- 5. Pooled priors (opt-in, anonymised)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.voice_prior_contributions (
  experiment_id uuid PRIMARY KEY REFERENCES public.voice_experiments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  scenario text NOT NULL, metric text NOT NULL,
  successes integer NOT NULL CHECK (successes >= 0), trials integer NOT NULL CHECK (trials >= 0 AND successes <= trials),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Returns ONLY sums over OTHER accounts, and only when >= 10 distinct accounts contributed. No ids ever leave.
CREATE OR REPLACE FUNCTION public.get_voice_pooled_prior(p_scenario text, p_metric text)
RETURNS TABLE (successes bigint, trials bigint, accounts bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (SELECT public.get_account_owner_id() AS uid),
  opted AS (SELECT 1 FROM public.voice_autopilot_settings s, me WHERE s.user_id = me.uid AND s.pooled_priors_opt_in),
  agg AS (
    SELECT coalesce(sum(c.successes),0)::bigint AS s, coalesce(sum(c.trials),0)::bigint AS t, count(DISTINCT c.user_id)::bigint AS a
    FROM public.voice_prior_contributions c, me
    WHERE c.scenario = p_scenario AND c.metric = p_metric AND c.user_id <> me.uid
  )
  SELECT agg.s, agg.t, agg.a FROM agg WHERE EXISTS (SELECT 1 FROM opted) AND agg.a >= 10;
$$;
GRANT EXECUTE ON FUNCTION public.get_voice_pooled_prior(text, text) TO authenticated;

-- =============================================================
-- 6. RLS
-- =============================================================
ALTER TABLE public.voice_autopilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_experiment_looks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_autopilot_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_prior_contributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_autopilot_settings_select ON public.voice_autopilot_settings;
DROP POLICY IF EXISTS voice_autopilot_settings_insert ON public.voice_autopilot_settings;
DROP POLICY IF EXISTS voice_autopilot_settings_update ON public.voice_autopilot_settings;
CREATE POLICY voice_autopilot_settings_select ON public.voice_autopilot_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY voice_autopilot_settings_insert ON public.voice_autopilot_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
CREATE POLICY voice_autopilot_settings_update ON public.voice_autopilot_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());

-- experiments / looks / audit: SELECT only. Writes go through the RPCs below or the service-role Edge Function.
DROP POLICY IF EXISTS voice_experiments_select ON public.voice_experiments;
CREATE POLICY voice_experiments_select ON public.voice_experiments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
DROP POLICY IF EXISTS voice_experiment_looks_select ON public.voice_experiment_looks;
CREATE POLICY voice_experiment_looks_select ON public.voice_experiment_looks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
DROP POLICY IF EXISTS voice_autopilot_audit_select ON public.voice_autopilot_audit;
CREATE POLICY voice_autopilot_audit_select ON public.voice_autopilot_audit FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_edit_call_scripts());
-- voice_prior_contributions: no policy for authenticated => invisible to browsers.

REVOKE ALL ON public.voice_experiments, public.voice_experiment_looks, public.voice_autopilot_audit, public.voice_prior_contributions FROM anon, authenticated;
GRANT SELECT ON public.voice_experiments, public.voice_experiment_looks, public.voice_autopilot_audit TO authenticated;
REVOKE ALL ON public.voice_autopilot_settings FROM anon;

-- =============================================================
-- 7. RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.voice_experiment_start(
  p_script_id uuid, p_challenger_version_id uuid, p_dimension text, p_name text, p_hypothesis text,
  p_primary_metric text, p_n_max integer, p_min_effect numeric, p_traffic_pct integer, p_waived text[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.call_scripts; cap integer; v_id uuid; v_body text; lock_id text; v_dim text;
BEGIN
  IF NOT public.can_edit_call_scripts() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM public.call_scripts WHERE id = p_script_id AND user_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Script not found' USING ERRCODE = '42501'; END IF;
  IF s.active_version_id IS NULL THEN RAISE EXCEPTION 'Publish a live version first' USING ERRCODE = '23514'; END IF;
  IF p_challenger_version_id = s.active_version_id THEN RAISE EXCEPTION 'Challenger must differ from live' USING ERRCODE = '23514'; END IF;
  IF p_primary_metric NOT IN ('qualified_booking_rate','abandon_rate','time_to_book_seconds','emergency_detection_accuracy','customer_sentiment') THEN
    RAISE EXCEPTION 'Unknown primary metric' USING ERRCODE = '23514';
  END IF;
  IF p_n_max < 120 OR p_n_max > 100000 THEN RAISE EXCEPTION 'Maximum sample per arm must be between 120 and 100000' USING ERRCODE = '23514'; END IF;
  IF p_waived && ARRAY['complaint_rate','compliance_flag_rate'] THEN RAISE EXCEPTION 'Complaint and compliance guardrails cannot be waived' USING ERRCODE = '23514'; END IF;

  SELECT v.opening_line || E'\n' || v.body, v.dimension INTO v_body, v_dim
    FROM public.call_script_versions v WHERE v.id = p_challenger_version_id AND v.script_id = s.id;
  IF v_body IS NULL THEN RAISE EXCEPTION 'Challenger version not found' USING ERRCODE = '23514'; END IF;
  lock_id := public.voice_autopilot_lock_violation(v_body);
  IF lock_id IS NOT NULL THEN RAISE EXCEPTION 'Locked compliance language cannot be experimented away (%).', lock_id USING ERRCODE = '23514'; END IF;
  IF v_dim IS DISTINCT FROM p_dimension THEN RAISE EXCEPTION 'The challenger version is not tagged with dimension %', p_dimension USING ERRCODE = '23514'; END IF;

  SELECT coalesce((SELECT max_traffic_pct FROM public.voice_autopilot_settings WHERE user_id = s.user_id), 20) INTO cap;
  IF p_traffic_pct < 1 OR p_traffic_pct > cap THEN RAISE EXCEPTION 'Traffic must be between 1 and % percent', cap USING ERRCODE = '23514'; END IF;

  INSERT INTO public.voice_experiments (user_id, script_id, scenario, name, hypothesis, dimension, control_version_id, challenger_version_id, traffic_pct, prereg)
  VALUES (s.user_id, s.id, s.scenario, btrim(p_name), p_hypothesis, p_dimension, s.active_version_id, p_challenger_version_id, p_traffic_pct,
    jsonb_build_object('primaryMetric', p_primary_metric, 'nMaxPerArm', p_n_max, 'minEffect', p_min_effect,
                       'guardrailMargins', '{}'::jsonb, 'waivedGuardrails', to_jsonb(coalesce(p_waived, '{}'))))
  RETURNING id INTO v_id;

  UPDATE public.call_scripts SET challenger_version_id = p_challenger_version_id, challenger_traffic_pct = p_traffic_pct WHERE id = s.id;
  PERFORM public.voice_autopilot_write_audit(s.user_id, 'experiment_started', s.id, v_id, jsonb_build_object('dimension', p_dimension, 'traffic_pct', p_traffic_pct, 'n_max', p_n_max));
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION public.voice_experiment_start(uuid, uuid, text, text, text, text, integer, numeric, integer, text[]) TO authenticated;

-- action: promote | rollback | stop | inconclusive | await_approval.  Idempotent + race-safe (row lock).
CREATE OR REPLACE FUNCTION public.voice_experiment_conclude(p_experiment_id uuid, p_action text, p_conclusion jsonb DEFAULT '{}'::jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.voice_experiments; is_service boolean := (auth.role() = 'service_role'); new_status text; lock_id text; v_text text;
BEGIN
  SELECT * INTO e FROM public.voice_experiments WHERE id = p_experiment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Experiment not found' USING ERRCODE = '42501'; END IF;
  IF NOT is_service AND (e.user_id <> public.get_account_owner_id() OR NOT public.can_edit_call_scripts()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  -- Humans may stop/rollback/promote; only the system may flag "await_approval" / "inconclusive".
  IF NOT is_service AND p_action IN ('await_approval','inconclusive') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF e.status IN ('promoted','rolled_back','stopped','inconclusive') THEN RETURN e.status; END IF; -- idempotent

  IF p_action = 'await_approval' THEN
    UPDATE public.voice_experiments SET status = 'awaiting_approval', conclusion = p_conclusion WHERE id = e.id;
    PERFORM public.voice_autopilot_write_audit(e.user_id, 'promotion_requested', e.script_id, e.id, p_conclusion);
    RETURN 'awaiting_approval';
  END IF;

  IF p_action = 'promote' THEN
    SELECT v.opening_line || E'\n' || v.body INTO v_text FROM public.call_script_versions v WHERE v.id = e.challenger_version_id;
    lock_id := public.voice_autopilot_lock_violation(v_text);
    IF lock_id IS NOT NULL THEN RAISE EXCEPTION 'Locked compliance language cannot be promoted away (%).', lock_id USING ERRCODE = '23514'; END IF;
    IF NOT is_service AND e.status <> 'awaiting_approval' AND (e.conclusion IS NULL) THEN
      -- a human may promote manually, but it is recorded as manual (no statistical clearance)
      p_conclusion := coalesce(p_conclusion, '{}'::jsonb) || jsonb_build_object('manual_override', true);
    END IF;
    new_status := 'promoted';
  ELSE
    new_status := CASE p_action WHEN 'rollback' THEN 'rolled_back' WHEN 'inconclusive' THEN 'inconclusive' ELSE 'stopped' END;
  END IF;

  -- Experiment row FIRST (the call_scripts sync trigger only touches still-live experiments), then the live pointers.
  UPDATE public.voice_experiments SET status = new_status, concluded_at = now(), conclusion = coalesce(p_conclusion, '{}'::jsonb) WHERE id = e.id;
  IF new_status = 'promoted' THEN
    UPDATE public.call_scripts SET active_version_id = e.challenger_version_id, challenger_version_id = NULL, challenger_traffic_pct = 0 WHERE id = e.script_id;
  ELSE
    UPDATE public.call_scripts SET challenger_version_id = NULL, challenger_traffic_pct = 0 WHERE id = e.script_id AND challenger_version_id = e.challenger_version_id;
  END IF;
  PERFORM public.voice_autopilot_write_audit(e.user_id, 'experiment_' || new_status, e.script_id, e.id, coalesce(p_conclusion, '{}'::jsonb));
  RETURN new_status;
END $$;
GRANT EXECUTE ON FUNCTION public.voice_experiment_conclude(uuid, text, jsonb) TO authenticated, service_role;

-- =============================================================
-- 8. Human CSR QA (OFF by default; owner opt-in)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.csr_qa_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  employee_transparency boolean NOT NULL DEFAULT false,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 30 AND 365),
  policy_ack_at timestamptz,
  policy_ack_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.csr_qa_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES public.calls(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  call_at timestamptz NOT NULL,
  scenario text, after_hours boolean NOT NULL DEFAULT false, language text,
  rubric text NOT NULL,
  scores jsonb NOT NULL,
  overall smallint CHECK (overall BETWEEN 0 AND 100),
  clips jsonb NOT NULL DEFAULT '[]'::jsonb,
  coaching text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'auto' CHECK (status IN ('auto','human_reviewed')),
  reviewed_by uuid, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_csr_qa_reviews_user_at ON public.csr_qa_reviews (user_id, call_at DESC);
CREATE INDEX IF NOT EXISTS idx_csr_qa_reviews_agent ON public.csr_qa_reviews (agent_id, call_at DESC);

CREATE OR REPLACE FUNCTION public.can_view_csr_qa()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1 FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (COALESCE(tm.permissions ->> 'can_view_csr_qa', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_csr_qa', 'false') = 'true'));
$$;
GRANT EXECUTE ON FUNCTION public.can_view_csr_qa() TO authenticated;

-- An employee sees ONLY their own reviews, and only when the owner turned transparency on.
CREATE OR REPLACE FUNCTION public.csr_qa_is_own_visible(p_user uuid, p_agent uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_agent IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.csr_qa_settings s WHERE s.user_id = p_user AND s.enabled AND s.employee_transparency)
    AND EXISTS (SELECT 1 FROM public.team_members tm
                WHERE tm.id = p_agent AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()));
$$;
GRANT EXECUTE ON FUNCTION public.csr_qa_is_own_visible(uuid, uuid) TO authenticated;

ALTER TABLE public.csr_qa_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.csr_qa_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS csr_qa_settings_select ON public.csr_qa_settings;
DROP POLICY IF EXISTS csr_qa_settings_write ON public.csr_qa_settings;
CREATE POLICY csr_qa_settings_select ON public.csr_qa_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());   -- everyone on the account can SEE the policy that applies to them
CREATE POLICY csr_qa_settings_write ON public.csr_qa_settings FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner'))
  WITH CHECK (user_id = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner'));

DROP POLICY IF EXISTS csr_qa_reviews_select ON public.csr_qa_reviews;
CREATE POLICY csr_qa_reviews_select ON public.csr_qa_reviews FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id()
         AND (public.can_view_csr_qa() OR public.csr_qa_is_own_visible(user_id, agent_id)));
-- no INSERT/UPDATE/DELETE policy: scores are written by the service-role Edge Function only.

REVOKE ALL ON public.csr_qa_reviews FROM anon, authenticated;
GRANT SELECT ON public.csr_qa_reviews TO authenticated;

-- A human reviewer confirms a review. Until then it must not be used for discipline (policy note shown in the UI).
CREATE OR REPLACE FUNCTION public.csr_qa_mark_reviewed(p_review_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.can_view_csr_qa() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE public.csr_qa_reviews SET status = 'human_reviewed', reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = p_review_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Review not found' USING ERRCODE = '42501'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.csr_qa_mark_reviewed(uuid) TO authenticated;

-- Retention: deletes reviews older than each account's retention_days. SCHEDULE DAILY (pg_cron or the existing
-- data-retention-sweep function calling this RPC with the service role).
CREATE OR REPLACE FUNCTION public.purge_csr_qa_expired()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.csr_qa_reviews r USING public.csr_qa_settings s
   WHERE r.user_id = s.user_id AND r.call_at < now() - make_interval(days => s.retention_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.purge_csr_qa_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_csr_qa_expired() TO service_role;

/* ROLLBACK (deliberate, destructive — run manually; lint:allow-destructive)
DROP TABLE IF EXISTS public.csr_qa_reviews, public.csr_qa_settings, public.voice_prior_contributions,
  public.voice_experiment_looks, public.voice_experiments, public.voice_autopilot_audit, public.voice_autopilot_settings CASCADE;
DROP TRIGGER IF EXISTS trg_call_scripts_audit ON public.call_scripts;
DROP TRIGGER IF EXISTS trg_call_script_versions_lock_check ON public.call_script_versions;
ALTER TABLE public.call_script_versions DROP COLUMN IF EXISTS dimension, DROP COLUMN IF EXISTS voice_pace;
*/
