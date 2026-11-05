/*
  # Chief of Staff — the unifying layer over Vireek's agents and engines

  Additive. Wraps what already exists (agent_action_log / evaluate_agent_action / decide_agent_action /
  rollback_agent_action, next_best_actions, business_decisions, opportunity_cost_entries,
  get_capacity_status, strategic_goals). It does NOT rebuild them.

  ## New objects
   1. cos_settings          per-account: kill switch, autonomy by risk level, account message cap
   2. cos_agent_dials       per-agent autonomy dial (suggest | approve | auto) + per-agent message cap
   3. company_events        the shared "company brain" event log (append-only). Filled automatically by a
                            trigger on agent_action_log and by service-role publishers.
   4. cos_recommendations   ranked insights: evidence (>=1 citation required), impact range, confidence,
                            owner role, one-click action, atomic claim (double-action guard)
   5. cos_conflicts         detected conflicts between recommendations / agent actions + arbitration result
   6. cos_goal_targets      structured goal targets (revenue, booked_jobs, answer_rate, gross_margin)
   7. cos_gate()            kill switch + autonomy + message-cap decision (per recipient, business-timezone day) used by evaluate_agent_action
   8. evaluate_agent_action REPLACED (superset of the 20261203000000 version): now consults cos_gate() and
                            refuses callers who pass another tenant's p_user_id (see SECURITY FIX below)

  ## SECURITY FIX (important)
  evaluate_agent_action is SECURITY DEFINER, takes p_user_id from the caller and is granted to `authenticated`.
  In the previous version any signed-in user could therefore write governance rows for ANY tenant.
  The new version rejects an authenticated caller whose p_user_id is not their own account owner.
  Service-role callers (edge functions; auth.uid() IS NULL) are unchanged.

  ## Rollback
  See the commented block at the very end of this file.
*/

-- =============================================================
-- 0. Helpers
-- =============================================================

-- May the current user act on recommendations (claim / dismiss / resolve)? Owner or any non-technician member.
CREATE OR REPLACE FUNCTION public.cos_can_act()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.get_account_owner_id() IS NOT NULL
    AND (
      auth.uid() = public.get_account_owner_id()
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.account_owner_id = public.get_account_owner_id()
          AND tm.user_id = auth.uid()
          AND tm.role <> 'technician'
      )
    );
$$;
REVOKE ALL ON FUNCTION public.cos_can_act() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cos_can_act() TO authenticated, service_role;

-- =============================================================
-- 1. cos_settings
-- =============================================================

CREATE TABLE IF NOT EXISTS public.cos_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kill_switch_active boolean NOT NULL DEFAULT false,
  kill_switch_reason text CHECK (kill_switch_reason IS NULL OR char_length(kill_switch_reason) <= 300),
  kill_switch_changed_at timestamptz,
  kill_switch_changed_by uuid,
  -- { "low": "auto", "medium": "approve", "high": "suggest", "critical": "suggest" } — any subset.
  autonomy_by_risk jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(autonomy_by_risk) = 'object'),
  max_messages_per_day integer CHECK (max_messages_per_day IS NULL OR max_messages_per_day >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cos_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_cos_settings" ON public.cos_settings;
CREATE POLICY "select_own_cos_settings" ON public.cos_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. cos_agent_dials
-- =============================================================

CREATE TABLE IF NOT EXISTS public.cos_agent_dials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_source text NOT NULL CHECK (char_length(agent_source) BETWEEN 1 AND 100),
  mode text NOT NULL CHECK (mode IN ('suggest', 'approve', 'auto')),
  max_messages_per_day integer CHECK (max_messages_per_day IS NULL OR max_messages_per_day >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_source)
);
ALTER TABLE public.cos_agent_dials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_cos_agent_dials" ON public.cos_agent_dials;
CREATE POLICY "select_own_cos_agent_dials" ON public.cos_agent_dials
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. company_events — shared event model ("company brain")
-- =============================================================

CREATE TABLE IF NOT EXISTS public.company_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 100),
  subject_type text CHECK (subject_type IS NULL OR char_length(subject_type) <= 60),
  subject_id text CHECK (subject_id IS NULL OR char_length(subject_id) <= 120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 8192),
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_events_dedupe
  ON public.company_events (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_events_user_time
  ON public.company_events (user_id, occurred_at DESC);
ALTER TABLE public.company_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_company_events" ON public.company_events;
CREATE POLICY "select_own_company_events" ON public.company_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.cos_publish_event(
  p_user_id uuid, p_event_type text, p_source text,
  p_subject_type text DEFAULT NULL, p_subject_id text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb, p_dedupe_key text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.company_events (user_id, event_type, source, subject_type, subject_id, payload, dedupe_key)
  VALUES (p_user_id, p_event_type, p_source, p_subject_type, p_subject_id, COALESCE(p_payload, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.cos_publish_event(uuid, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_publish_event(uuid, text, text, text, text, jsonb, text) TO service_role;

-- Retention helper (call from a scheduled job; NOT scheduled by this migration).
CREATE OR REPLACE FUNCTION public.cos_prune_events(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.company_events WHERE occurred_at < now() - make_interval(days => GREATEST(p_days, 7));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.cos_prune_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_prune_events(integer) TO service_role;

-- Every governed agent action automatically becomes a company event. Never blocks the underlying write.
CREATE OR REPLACE FUNCTION public.cos_mirror_agent_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.company_events (user_id, event_type, source, subject_type, subject_id, payload, dedupe_key)
    VALUES (
      NEW.user_id,
      'agent_action_' || NEW.status,
      NEW.agent_source,
      'agent_action',
      NEW.id::text,
      jsonb_build_object(
        'action_slug', NEW.action_slug,
        'amount_cents', NEW.amount_cents,
        'target_table', NEW.target_table,
        'target_id', NEW.target_id
      ),
      NEW.id::text || ':' || NEW.status
    )
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.agent_action_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_cos_mirror_agent_action ON public.agent_action_log;
    CREATE TRIGGER trg_cos_mirror_agent_action
      AFTER INSERT OR UPDATE OF status ON public.agent_action_log
      FOR EACH ROW EXECUTE FUNCTION public.cos_mirror_agent_action();
  END IF;
END $$;

-- =============================================================
-- 4. cos_goal_targets
-- =============================================================

CREATE TABLE IF NOT EXISTS public.cos_goal_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_id uuid REFERENCES public.strategic_goals(id) ON DELETE SET NULL,
  metric text NOT NULL CHECK (metric IN ('revenue', 'booked_jobs', 'answer_rate', 'gross_margin')),
  target_value numeric(14, 2) NOT NULL CHECK (target_value > 0),
  unit text NOT NULL CHECK (unit IN ('usd', 'count', 'pct')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  source text NOT NULL CHECK (source IN ('typed', 'spreadsheet', 'manual')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK ((metric IN ('answer_rate', 'gross_margin') AND unit = 'pct' AND target_value <= 100)
      OR (metric = 'revenue' AND unit = 'usd')
      OR (metric = 'booked_jobs' AND unit = 'count' AND target_value = trunc(target_value)))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cos_goal_targets_active
  ON public.cos_goal_targets (user_id, metric, period_start, period_end) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_cos_goal_targets_user ON public.cos_goal_targets (user_id, status, period_end DESC);
ALTER TABLE public.cos_goal_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_cos_goal_targets" ON public.cos_goal_targets;
CREATE POLICY "select_own_cos_goal_targets" ON public.cos_goal_targets
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 5. cos_recommendations
-- =============================================================

CREATE TABLE IF NOT EXISTS public.cos_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('capacity_gap', 'leak', 'risk', 'opportunity')),
  domain text NOT NULL CHECK (domain IN ('capacity', 'marketing', 'finance', 'customer', 'operations', 'compliance')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  why_it_matters text NOT NULL CHECK (char_length(why_it_matters) BETWEEN 1 AND 1200),
  -- [{ "source_table": "jobs", "ref": "<id or query label>", "metric": "...", "value": "...", "as_of": "..." }]
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 12),
  impact_low_cents bigint CHECK (impact_low_cents IS NULL OR impact_low_cents >= 0),
  impact_high_cents bigint CHECK (impact_high_cents IS NULL OR impact_high_cents >= 0),
  impact_basis text CHECK (impact_basis IS NULL OR char_length(impact_basis) <= 300),
  confidence smallint CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  confidence_basis text CHECK (confidence_basis IS NULL OR char_length(confidence_basis) <= 300),
  owner_role text NOT NULL DEFAULT 'owner' CHECK (owner_role IN ('owner', 'manager', 'dispatcher', 'csr', 'any')),
  action_kind text NOT NULL DEFAULT 'navigate' CHECK (action_kind IN ('navigate', 'operator_command', 'none')),
  action_label text CHECK (action_label IS NULL OR char_length(action_label) <= 80),
  action_href text CHECK (action_href IS NULL OR (action_href ~ '^/dashboard(/[A-Za-z0-9_\-./?=&%#]*)?$' AND char_length(action_href) <= 300)),
  action_command text CHECK (action_command IS NULL OR char_length(action_command) <= 500),
  works_with text[] NOT NULL DEFAULT '{}',
  effects text[] NOT NULL DEFAULT '{}',
  subject_key text CHECK (subject_key IS NULL OR char_length(subject_key) <= 160),
  priority_score integer NOT NULL DEFAULT 50 CHECK (priority_score BETWEEN 0 AND 100),
  source_engine text NOT NULL CHECK (source_engine IN (
    'next-best-actions', 'business-decision-engine', 'opportunity-cost-scan',
    'capacity-demand-control', 'goal-pace', 'agent-governance'
  )),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 120),
  goal_target_id uuid REFERENCES public.cos_goal_targets(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'executed', 'dismissed', 'suppressed', 'expired', 'failed')),
  suppressed_reason text CHECK (suppressed_reason IS NULL OR char_length(suppressed_reason) <= 400),
  claimed_by uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (impact_low_cents IS NULL AND impact_high_cents IS NULL)
    OR (impact_low_cents IS NOT NULL AND impact_high_cents IS NOT NULL AND impact_low_cents <= impact_high_cents)
  ),
  CHECK (action_kind <> 'navigate' OR action_href IS NOT NULL),
  CHECK (action_kind <> 'operator_command' OR action_command IS NOT NULL)
);
-- One live row per (account, dedupe_key). Re-surfacing the same insight updates it instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cos_recommendations_live
  ON public.cos_recommendations (user_id, dedupe_key) WHERE status IN ('open', 'claimed', 'suppressed');
CREATE INDEX IF NOT EXISTS idx_cos_recommendations_rank
  ON public.cos_recommendations (user_id, status, priority_score DESC, created_at DESC);
ALTER TABLE public.cos_recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_cos_recommendations" ON public.cos_recommendations;
CREATE POLICY "select_own_cos_recommendations" ON public.cos_recommendations
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 6. cos_conflicts
-- =============================================================

CREATE TABLE IF NOT EXISTS public.cos_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_key text NOT NULL CHECK (char_length(rule_key) BETWEEN 1 AND 80),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 300),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  dedupe_keys text[] NOT NULL DEFAULT '{}',
  winner_dedupe_key text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cos_conflicts_open
  ON public.cos_conflicts (user_id, fingerprint) WHERE status = 'open';
ALTER TABLE public.cos_conflicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_cos_conflicts" ON public.cos_conflicts;
CREATE POLICY "select_own_cos_conflicts" ON public.cos_conflicts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 7. Settings RPCs (owner / security managers only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.cos_get_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_row public.cos_settings;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_row FROM public.cos_settings WHERE user_id = v_owner;
  RETURN jsonb_build_object(
    'kill_switch_active', COALESCE(v_row.kill_switch_active, false),
    'kill_switch_reason', v_row.kill_switch_reason,
    'kill_switch_changed_at', v_row.kill_switch_changed_at,
    'autonomy_by_risk', COALESCE(v_row.autonomy_by_risk, '{}'::jsonb),
    'max_messages_per_day', v_row.max_messages_per_day,
    'can_manage', public.ai_gov_can_manage(),
    'can_act', public.cos_can_act()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_set_kill_switch(p_active boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 300 THEN RAISE EXCEPTION 'reason_too_long'; END IF;

  INSERT INTO public.cos_settings (user_id, kill_switch_active, kill_switch_reason, kill_switch_changed_at, kill_switch_changed_by, updated_at)
  VALUES (v_owner, p_active, CASE WHEN p_active THEN NULLIF(btrim(p_reason), '') ELSE NULL END, now(), auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE SET
    kill_switch_active = EXCLUDED.kill_switch_active,
    kill_switch_reason = EXCLUDED.kill_switch_reason,
    kill_switch_changed_at = now(),
    kill_switch_changed_by = auth.uid(),
    updated_at = now();

  INSERT INTO public.company_events (user_id, event_type, source, subject_type, payload)
  VALUES (v_owner, CASE WHEN p_active THEN 'kill_switch_on' ELSE 'kill_switch_off' END, 'chief-of-staff', 'account',
          jsonb_build_object('by', auth.uid(), 'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')));

  RETURN jsonb_build_object('kill_switch_active', p_active);
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_set_autonomy_by_risk(p_map jsonb, p_max_messages_per_day integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_key text; v_val text;
BEGIN
  IF v_owner IS NULL OR NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  IF p_map IS NULL OR jsonb_typeof(p_map) <> 'object' THEN RAISE EXCEPTION 'invalid_map'; END IF;
  IF p_max_messages_per_day IS NOT NULL AND p_max_messages_per_day < 0 THEN RAISE EXCEPTION 'invalid_cap'; END IF;
  FOR v_key, v_val IN SELECT key, value #>> '{}' FROM jsonb_each(p_map) LOOP
    IF v_key NOT IN ('low', 'medium', 'high', 'critical') THEN RAISE EXCEPTION 'invalid_risk_level: %', v_key; END IF;
    IF v_val NOT IN ('suggest', 'approve', 'auto') THEN RAISE EXCEPTION 'invalid_mode: %', v_val; END IF;
    IF v_key = 'critical' AND v_val = 'auto' THEN RAISE EXCEPTION 'critical_risk_can_never_be_auto'; END IF;
  END LOOP;

  INSERT INTO public.cos_settings (user_id, autonomy_by_risk, max_messages_per_day, updated_at)
  VALUES (v_owner, p_map, p_max_messages_per_day, now())
  ON CONFLICT (user_id) DO UPDATE SET
    autonomy_by_risk = EXCLUDED.autonomy_by_risk,
    max_messages_per_day = EXCLUDED.max_messages_per_day,
    updated_at = now();

  INSERT INTO public.company_events (user_id, event_type, source, subject_type, payload)
  VALUES (v_owner, 'autonomy_changed', 'chief-of-staff', 'account',
          jsonb_build_object('by', auth.uid(), 'autonomy_by_risk', p_map, 'max_messages_per_day', p_max_messages_per_day));
  RETURN jsonb_build_object('autonomy_by_risk', p_map, 'max_messages_per_day', p_max_messages_per_day);
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_set_agent_dial(p_agent_source text, p_mode text, p_max_messages_per_day integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('suggest', 'approve', 'auto') THEN RAISE EXCEPTION 'invalid_mode'; END IF;
  IF p_agent_source IS NULL OR char_length(p_agent_source) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_agent'; END IF;
  IF p_max_messages_per_day IS NOT NULL AND p_max_messages_per_day < 0 THEN RAISE EXCEPTION 'invalid_cap'; END IF;
  -- Only agents that actually exist in the action catalog can be dialled (no typo-created phantom rows).
  IF NOT EXISTS (SELECT 1 FROM public.agent_action_catalog WHERE agent_source = p_agent_source) THEN
    RAISE EXCEPTION 'unknown_agent';
  END IF;
  -- Critical-risk agents can never be dialled to auto.
  IF p_mode = 'auto' AND EXISTS (
    SELECT 1 FROM public.agent_autonomy_budgets b
    WHERE b.user_id = v_owner AND b.agent_source = p_agent_source AND b.risk_level = 'critical'
  ) THEN RAISE EXCEPTION 'critical_risk_can_never_be_auto'; END IF;

  INSERT INTO public.cos_agent_dials (user_id, agent_source, mode, max_messages_per_day, updated_by, updated_at)
  VALUES (v_owner, p_agent_source, p_mode, p_max_messages_per_day, auth.uid(), now())
  ON CONFLICT (user_id, agent_source) DO UPDATE SET
    mode = EXCLUDED.mode, max_messages_per_day = EXCLUDED.max_messages_per_day,
    updated_by = auth.uid(), updated_at = now();

  INSERT INTO public.company_events (user_id, event_type, source, subject_type, subject_id, payload)
  VALUES (v_owner, 'agent_dial_changed', 'chief-of-staff', 'agent', p_agent_source,
          jsonb_build_object('by', auth.uid(), 'mode', p_mode, 'max_messages_per_day', p_max_messages_per_day));
  RETURN jsonb_build_object('agent_source', p_agent_source, 'mode', p_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_list_agent_dials()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agent_source', a.agent_source,
      'labels', a.labels,
      'has_messaging', a.has_messaging,
      'mode', d.mode,
      'max_messages_per_day', d.max_messages_per_day
    ) ORDER BY a.agent_source)
    FROM (
      SELECT c.agent_source,
             array_agg(c.label ORDER BY c.label) AS labels,
             bool_or(c.category IN ('messaging', 'calling')) AS has_messaging
      FROM public.agent_action_catalog c GROUP BY c.agent_source
    ) a
    LEFT JOIN public.cos_agent_dials d ON d.user_id = v_owner AND d.agent_source = a.agent_source
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 8. Recommendation lifecycle RPCs (double-action guard)
-- =============================================================

CREATE OR REPLACE FUNCTION public.cos_claim_recommendation(p_id uuid, p_ttl_minutes integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_row public.cos_recommendations;
BEGIN
  IF NOT public.cos_can_act() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;

  -- One atomic statement: of two simultaneous callers exactly one gets a row back.
  UPDATE public.cos_recommendations
  SET status = 'claimed', claimed_by = auth.uid(), claimed_at = now(),
      claim_expires_at = now() + make_interval(mins => LEAST(GREATEST(COALESCE(p_ttl_minutes, 10), 1), 30)),
      updated_at = now()
  WHERE id = p_id AND user_id = v_owner
    AND (status = 'open'
         OR (status = 'claimed' AND (claimed_by = auth.uid() OR claim_expires_at < now())))
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'status', v_row.status, 'expires_at', v_row.claim_expires_at);
  END IF;

  SELECT * INTO v_row FROM public.cos_recommendations WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  RETURN jsonb_build_object(
    'claimed', false, 'status', v_row.status,
    'claimed_by_other', (v_row.status = 'claimed' AND v_row.claimed_by IS DISTINCT FROM auth.uid()),
    'expires_at', v_row.claim_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_resolve_recommendation(p_id uuid, p_outcome text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_row public.cos_recommendations;
BEGIN
  IF NOT public.cos_can_act() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  IF p_outcome NOT IN ('executed', 'dismissed', 'failed', 'released') THEN RAISE EXCEPTION 'invalid_outcome'; END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN RAISE EXCEPTION 'note_too_long'; END IF;

  IF p_outcome = 'released' THEN
    UPDATE public.cos_recommendations
    SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = now()
    WHERE id = p_id AND user_id = v_owner AND status = 'claimed' AND claimed_by = auth.uid()
    RETURNING * INTO v_row;
  ELSIF p_outcome = 'dismissed' THEN
    UPDATE public.cos_recommendations
    SET status = 'dismissed', resolved_by = auth.uid(), resolved_at = now(), resolution_note = p_note, updated_at = now()
    WHERE id = p_id AND user_id = v_owner
      AND (status = 'open' OR (status = 'claimed' AND claimed_by = auth.uid()))
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.cos_recommendations
    SET status = p_outcome, resolved_by = auth.uid(), resolved_at = now(), resolution_note = p_note, updated_at = now()
    WHERE id = p_id AND user_id = v_owner AND status = 'claimed' AND claimed_by = auth.uid()
    RETURNING * INTO v_row;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_claimed_by_you_or_already_resolved');
  END IF;

  INSERT INTO public.company_events (user_id, event_type, source, subject_type, subject_id, payload, dedupe_key)
  VALUES (v_owner, 'recommendation_' || p_outcome, 'chief-of-staff', 'recommendation', p_id::text,
          jsonb_build_object('by', auth.uid(), 'engine', v_row.source_engine, 'kind', v_row.kind),
          'rec:' || p_id::text || ':' || p_outcome)
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'status', v_row.status);
END;
$$;

-- Acceptance / dismissal metrics per source engine. Rates are NULL until >= 5 decisions exist (no invented numbers).
CREATE OR REPLACE FUNCTION public.cos_usefulness_metrics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(m)) FROM (
      SELECT source_engine,
             count(*) FILTER (WHERE status = 'executed') AS accepted,
             count(*) FILTER (WHERE status = 'dismissed') AS dismissed,
             count(*) FILTER (WHERE status = 'expired') AS expired,
             count(*) AS total,
             CASE WHEN count(*) FILTER (WHERE status IN ('executed', 'dismissed')) >= 5
                  THEN round(100.0 * count(*) FILTER (WHERE status = 'executed')
                             / count(*) FILTER (WHERE status IN ('executed', 'dismissed')), 1)
                  ELSE NULL END AS accept_rate_pct
      FROM public.cos_recommendations
      WHERE user_id = v_owner AND created_at >= now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365))
      GROUP BY source_engine ORDER BY source_engine
    ) m
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 9. Goal target RPC
-- =============================================================

CREATE OR REPLACE FUNCTION public.cos_confirm_goal_targets(p_targets jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_t jsonb; v_n integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.cos_can_act() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'invalid_targets';
  END IF;
  FOR v_t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    -- Replace any confirmed target for the same metric + period atomically.
    UPDATE public.cos_goal_targets SET status = 'archived'
    WHERE user_id = v_owner AND status = 'confirmed' AND metric = v_t ->> 'metric'
      AND period_start = (v_t ->> 'period_start')::date AND period_end = (v_t ->> 'period_end')::date;
    INSERT INTO public.cos_goal_targets (user_id, metric, target_value, unit, period_start, period_end, source, source_ref, created_by)
    VALUES (v_owner, v_t ->> 'metric', (v_t ->> 'target_value')::numeric, v_t ->> 'unit',
            (v_t ->> 'period_start')::date, (v_t ->> 'period_end')::date,
            v_t ->> 'source', left(v_t ->> 'source_ref', 200), auth.uid());
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO public.company_events (user_id, event_type, source, subject_type, payload)
  VALUES (v_owner, 'goals_confirmed', 'chief-of-staff', 'goal_target', jsonb_build_object('by', auth.uid(), 'count', v_n));
  RETURN jsonb_build_object('saved', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_archive_goal_target(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.cos_can_act() THEN RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501'; END IF;
  UPDATE public.cos_goal_targets SET status = 'archived' WHERE id = p_id AND user_id = v_owner AND status = 'confirmed';
  RETURN FOUND;
END;
$$;

-- =============================================================
-- 10. cos_apply_refresh — service role only. One transaction: upsert, suppress, expire, record conflicts.
-- =============================================================

CREATE OR REPLACE FUNCTION public.cos_apply_refresh(
  p_user_id uuid, p_recs jsonb, p_conflicts jsonb, p_engines text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys text[];
  v_upserted integer := 0;
  v_expired integer := 0;
  v_conflicts integer := 0;
  v_fps text[];
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_required'; END IF;
  IF jsonb_typeof(p_recs) <> 'array' OR jsonb_array_length(p_recs) > 100 THEN RAISE EXCEPTION 'invalid_recs'; END IF;
  IF jsonb_typeof(p_conflicts) <> 'array' OR jsonb_array_length(p_conflicts) > 100 THEN RAISE EXCEPTION 'invalid_conflicts'; END IF;

  -- Serialise concurrent refreshes for one account.
  PERFORM pg_advisory_xact_lock(hashtextextended('cos_refresh:' || p_user_id::text, 0));

  INSERT INTO public.cos_recommendations AS r (
    user_id, dedupe_key, kind, domain, title, why_it_matters, evidence,
    impact_low_cents, impact_high_cents, impact_basis, confidence, confidence_basis,
    owner_role, action_kind, action_label, action_href, action_command,
    works_with, effects, subject_key, priority_score, source_engine, source_ref, status, suppressed_reason
  )
  SELECT p_user_id, x.dedupe_key, x.kind, x.domain, x.title, x.why_it_matters, x.evidence,
         x.impact_low_cents, x.impact_high_cents, x.impact_basis, x.confidence, x.confidence_basis,
         COALESCE(x.owner_role, 'owner'), COALESCE(x.action_kind, 'navigate'), x.action_label, x.action_href, x.action_command,
         COALESCE(x.works_with, '{}'), COALESCE(x.effects, '{}'), x.subject_key,
         COALESCE(x.priority_score, 50), x.source_engine, x.source_ref,
         COALESCE(x.status, 'open'), x.suppressed_reason
  FROM jsonb_to_recordset(p_recs) AS x(
    dedupe_key text, kind text, domain text, title text, why_it_matters text, evidence jsonb,
    impact_low_cents bigint, impact_high_cents bigint, impact_basis text, confidence smallint, confidence_basis text,
    owner_role text, action_kind text, action_label text, action_href text, action_command text,
    works_with text[], effects text[], subject_key text, priority_score integer,
    source_engine text, source_ref text, status text, suppressed_reason text
  )
  WHERE COALESCE(x.status, 'open') IN ('open', 'suppressed')
  ON CONFLICT (user_id, dedupe_key) WHERE status IN ('open', 'claimed', 'suppressed')
  DO UPDATE SET
    title = EXCLUDED.title, why_it_matters = EXCLUDED.why_it_matters, evidence = EXCLUDED.evidence,
    impact_low_cents = EXCLUDED.impact_low_cents, impact_high_cents = EXCLUDED.impact_high_cents,
    impact_basis = EXCLUDED.impact_basis, confidence = EXCLUDED.confidence, confidence_basis = EXCLUDED.confidence_basis,
    owner_role = EXCLUDED.owner_role, action_kind = EXCLUDED.action_kind, action_label = EXCLUDED.action_label,
    action_href = EXCLUDED.action_href, action_command = EXCLUDED.action_command,
    works_with = EXCLUDED.works_with, effects = EXCLUDED.effects, subject_key = EXCLUDED.subject_key,
    priority_score = EXCLUDED.priority_score,
    status = EXCLUDED.status, suppressed_reason = EXCLUDED.suppressed_reason, updated_at = now()
  -- A claimed row is being worked on by a person: never change it underneath them.
  WHERE r.status IN ('open', 'suppressed');
  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  SELECT COALESCE(array_agg(e ->> 'dedupe_key'), '{}') INTO v_keys FROM jsonb_array_elements(p_recs) e;

  UPDATE public.cos_recommendations
  SET status = 'expired', updated_at = now()
  WHERE user_id = p_user_id AND status IN ('open', 'suppressed')
    AND source_engine = ANY (p_engines)
    AND dedupe_key <> ALL (v_keys);
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  SELECT COALESCE(array_agg(c ->> 'fingerprint'), '{}') INTO v_fps FROM jsonb_array_elements(p_conflicts) c;

  UPDATE public.cos_conflicts SET status = 'resolved', resolved_at = now()
  WHERE user_id = p_user_id AND status = 'open' AND fingerprint <> ALL (v_fps);

  INSERT INTO public.cos_conflicts (user_id, rule_key, fingerprint, severity, summary, dedupe_keys, winner_dedupe_key, detail)
  SELECT p_user_id, c.rule_key, c.fingerprint, c.severity, c.summary, COALESCE(c.dedupe_keys, '{}'), c.winner_dedupe_key,
         COALESCE(c.detail, '{}'::jsonb)
  FROM jsonb_to_recordset(p_conflicts) AS c(
    rule_key text, fingerprint text, severity text, summary text, dedupe_keys text[], winner_dedupe_key text, detail jsonb
  )
  ON CONFLICT (user_id, fingerprint) WHERE status = 'open' DO NOTHING;
  GET DIAGNOSTICS v_conflicts = ROW_COUNT;

  RETURN jsonb_build_object('upserted', v_upserted, 'expired', v_expired, 'new_conflicts', v_conflicts);
END;
$$;
REVOKE ALL ON FUNCTION public.cos_apply_refresh(uuid, jsonb, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_apply_refresh(uuid, jsonb, jsonb, text[]) TO service_role;

-- Number of recipients one governed messaging action represents. Reads an explicit payload.recipient_count
-- (any agent may set it), else the Operator's payload.operator.affected, else 1. Never raises on bad input.
CREATE OR REPLACE FUNCTION public.cos_action_units(p_payload jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT GREATEST(1, LEAST(100000, CASE
    WHEN p_payload ->> 'recipient_count' ~ '^[0-9]{1,6}$' THEN (p_payload ->> 'recipient_count')::integer
    WHEN p_payload -> 'operator' ->> 'affected' ~ '^[0-9]{1,6}$' THEN (p_payload -> 'operator' ->> 'affected')::integer
    ELSE 1 END));
$$;

-- =============================================================
-- 11. cos_gate — kill switch, autonomy dial / risk level, message caps
-- =============================================================

CREATE OR REPLACE FUNCTION public.cos_gate(p_user_id uuid, p_action_slug text, p_agent_source text, p_units integer DEFAULT 1)
RETURNS TABLE (verdict text, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s public.cos_settings;
  v_cat public.agent_action_catalog;
  v_risk text;
  v_dial public.cos_agent_dials;
  v_mode text;
  v_cap integer;
  v_used integer;
  v_tz text;
  v_day_start timestamptz;
BEGIN
  SELECT * INTO v_s FROM public.cos_settings WHERE user_id = p_user_id;
  IF FOUND AND v_s.kill_switch_active THEN
    RETURN QUERY SELECT 'kill_switch'::text, COALESCE(v_s.kill_switch_reason, 'The kill switch is on. All agent actions are paused.');
    RETURN;
  END IF;

  SELECT * INTO v_cat FROM public.agent_action_catalog WHERE slug = p_action_slug;

  SELECT b.risk_level INTO v_risk FROM public.agent_autonomy_budgets b
  WHERE b.user_id = p_user_id AND b.agent_source = p_agent_source AND b.enabled = true;
  IF v_risk IS NULL THEN
    v_risk := CASE
      WHEN v_cat.category = 'financial' OR COALESCE(v_cat.has_cost, false) THEN 'high'
      WHEN v_cat.category IN ('messaging', 'calling', 'marketing') THEN 'medium'
      ELSE 'low' END;
  END IF;

  SELECT * INTO v_dial FROM public.cos_agent_dials WHERE user_id = p_user_id AND agent_source = p_agent_source;
  IF FOUND THEN
    v_mode := v_dial.mode;
  ELSIF v_s.user_id IS NOT NULL THEN
    v_mode := v_s.autonomy_by_risk ->> v_risk;
  END IF;

  IF v_mode = 'suggest' THEN
    RETURN QUERY SELECT 'suggest_only'::text, format('Autonomy is set to "suggest only" for this agent (risk level: %s).', v_risk);
    RETURN;
  END IF;

  IF v_cat.category IN ('messaging', 'calling') THEN
    v_cap := LEAST(COALESCE(v_dial.max_messages_per_day, 2147483647), COALESCE(v_s.max_messages_per_day, 2147483647));
    IF v_cap < 2147483647 THEN
      -- "Today" is the business's own calendar day, not the database server's.
      SELECT COALESCE(NULLIF(btrim(bp.timezone), ''), 'UTC') INTO v_tz FROM public.business_profile bp WHERE bp.user_id = p_user_id;
      IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = v_tz) THEN v_tz := 'UTC'; END IF;
      v_day_start := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

      -- Count RECIPIENTS, not proposals: a bulk action of 40 texts uses 40 of the cap.
      SELECT COALESCE(SUM(public.cos_action_units(l.payload)), 0) INTO v_used
      FROM public.agent_action_log l
      JOIN public.agent_action_catalog c ON c.slug = l.action_slug
      WHERE l.user_id = p_user_id AND c.category IN ('messaging', 'calling')
        AND l.status IN ('auto_approved', 'approved', 'executed')
        AND l.created_at >= v_day_start
        AND (v_dial.max_messages_per_day IS NULL OR l.agent_source = p_agent_source);
      IF v_used + GREATEST(COALESCE(p_units, 1), 1) > v_cap THEN
        RETURN QUERY SELECT 'require_approval'::text,
          format('Daily message cap would be exceeded (%s already used + %s planned, cap %s).', v_used, GREATEST(COALESCE(p_units, 1), 1), v_cap);
        RETURN;
      END IF;
    END IF;
  END IF;

  IF v_mode = 'approve' THEN
    RETURN QUERY SELECT 'require_approval'::text, format('Autonomy is set to "ask first" for this agent (risk level: %s).', v_risk);
    RETURN;
  END IF;
  IF v_mode = 'auto' AND v_risk <> 'critical' THEN
    RETURN QUERY SELECT 'auto'::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'none'::text, NULL::text;
END;
$$;
REVOKE ALL ON FUNCTION public.cos_gate(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_gate(uuid, text, text, integer) TO service_role;

-- =============================================================
-- 12. evaluate_agent_action — superset of 20261203000000 + cos_gate + tenant guard
--     Everything between the markers "UNCHANGED" is copied verbatim from the previous definition.
-- =============================================================

CREATE OR REPLACE FUNCTION public.evaluate_agent_action(
  p_user_id uuid,
  p_action_slug text,
  p_agent_source text,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL,
  p_reasoning text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_before_state jsonb DEFAULT NULL,
  p_rollback_patch jsonb DEFAULT NULL,
  p_correlation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_catalog agent_action_catalog;
  v_perm agent_permissions;
  v_existing agent_action_log;
  v_log agent_action_log;
  v_requires_approval boolean;
  v_status text;
  v_over_limit boolean := false;
  v_limit record;
  v_period_start timestamptz;
  v_spent_cents numeric;
  v_constitution record;
  v_forced_by_authority boolean;
  v_gate record;
  v_gate_reason text;
BEGIN
  -- NEW: tenant guard. A signed-in caller may only evaluate actions for their own account.
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not allowed to evaluate actions for another account.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_catalog FROM agent_action_catalog WHERE slug = p_action_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown agent action slug: %', p_action_slug;
  END IF;

  -- NEW: kill switch / autonomy dial. Blocked attempts are logged WITHOUT target_table/target_id so
  -- they never poison the idempotency lookup below once the owner turns the switch off again.
  SELECT * INTO v_gate FROM public.cos_gate(p_user_id, p_action_slug, p_agent_source, public.cos_action_units(COALESCE(p_payload, '{}'::jsonb))) LIMIT 1;
  IF v_gate.verdict IN ('kill_switch', 'suggest_only') THEN
    SELECT * INTO v_existing FROM agent_action_log
      WHERE user_id = p_user_id AND action_slug = p_action_slug AND status = 'rejected'
        AND payload ->> 'cos_block' = v_gate.verdict
        AND payload ->> 'blocked_target' IS NOT DISTINCT FROM (p_target_table || ':' || p_target_id)
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_existing.id, 'reason', v_gate.verdict, 'existing', true);
    END IF;
    INSERT INTO agent_action_log (
      user_id, action_slug, agent_source, target_table, target_id, amount_cents,
      reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
    ) VALUES (
      p_user_id, p_action_slug, p_agent_source, NULL, NULL, p_amount_cents,
      p_reasoning,
      COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
        'cos_block', v_gate.verdict, 'blocked_target', p_target_table || ':' || p_target_id),
      p_before_state, p_rollback_patch, 'rejected', p_correlation_id, v_gate.reason
    ) RETURNING * INTO v_log;
    RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_log.id, 'reason', v_gate.verdict);
  END IF;

  -- ===== UNCHANGED from 20261203000000 (idempotency) =====
  IF p_target_table IS NOT NULL AND p_target_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM agent_action_log
      WHERE user_id = p_user_id AND action_slug = p_action_slug
        AND target_table = p_target_table AND target_id = p_target_id
        AND status IN ('pending_approval', 'approved', 'rejected')
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('decision', v_existing.status, 'log_id', v_existing.id, 'existing', true);
    END IF;
  END IF;

  -- ===== UNCHANGED (Business Constitution gate) =====
  SELECT * INTO v_constitution FROM public.check_constitution(
    p_user_id, p_action_slug,
    p_payload || jsonb_build_object('agent_source', p_agent_source, 'amount_cents', p_amount_cents)
  ) LIMIT 1;

  IF NOT v_constitution.allowed THEN
    INSERT INTO agent_action_log (
      user_id, action_slug, agent_source, target_table, target_id, amount_cents,
      reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
    ) VALUES (
      p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
      p_reasoning, p_payload, p_before_state, p_rollback_patch, 'rejected', p_correlation_id,
      format('Blocked by Business Constitution — %s: %s', v_constitution.article_title, v_constitution.reason)
    ) RETURNING * INTO v_log;
    RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_log.id, 'reason', 'constitution', 'article_title', v_constitution.article_title);
  END IF;

  SELECT * INTO v_perm FROM agent_permissions WHERE user_id = p_user_id AND action_slug = p_action_slug;

  IF FOUND AND v_perm.enabled = false THEN
    INSERT INTO agent_action_log (
      user_id, action_slug, agent_source, target_table, target_id, amount_cents,
      reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
    ) VALUES (
      p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
      p_reasoning, p_payload, p_before_state, p_rollback_patch, 'rejected', p_correlation_id,
      'Blocked: this action type is disabled in Agent Governance.'
    ) RETURNING * INTO v_log;
    RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_log.id, 'reason', 'disabled');
  END IF;

  v_requires_approval := COALESCE(v_perm.requires_approval, v_catalog.default_requires_approval);

  IF p_amount_cents IS NOT NULL AND p_amount_cents > 0 THEN
    FOR v_limit IN
      SELECT * FROM agent_spending_limits
      WHERE user_id = p_user_id AND (action_slug = p_action_slug OR action_slug IS NULL)
    LOOP
      v_period_start := CASE v_limit.period
        WHEN 'daily' THEN date_trunc('day', now())
        WHEN 'weekly' THEN date_trunc('week', now())
        ELSE date_trunc('month', now())
      END;
      SELECT COALESCE(SUM(amount_cents), 0) INTO v_spent_cents
        FROM agent_action_log
        WHERE user_id = p_user_id
          AND status IN ('auto_approved', 'approved', 'executed')
          AND created_at >= v_period_start
          AND (v_limit.action_slug IS NULL OR action_slug = v_limit.action_slug);
      IF v_spent_cents + p_amount_cents > v_limit.limit_cents THEN
        v_over_limit := true;
      END IF;
    END LOOP;
  END IF;

  IF v_over_limit THEN
    v_requires_approval := true;
  ELSIF v_perm.auto_approve_max_cents IS NOT NULL AND p_amount_cents IS NOT NULL
        AND p_amount_cents <= v_perm.auto_approve_max_cents THEN
    v_requires_approval := false;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM constitution_articles ca
    WHERE ca.user_id = p_user_id AND ca.enabled = true AND ca.rule_type = 'require_human_for_category'
      AND ca.parameters->>'category' = v_catalog.category
  ) INTO v_forced_by_authority;
  IF v_forced_by_authority THEN
    v_requires_approval := true;
  END IF;

  -- ===== NEW: autonomy dial / risk level / message caps (applied last so it can only tighten,
  --       or relax ONLY when nothing else forces a human: no spend-limit hit, no constitution authority rule) =====
  IF v_gate.verdict = 'require_approval' THEN
    v_requires_approval := true;
    v_gate_reason := v_gate.reason;
  ELSIF v_gate.verdict = 'auto' AND NOT v_over_limit AND NOT v_forced_by_authority THEN
    v_requires_approval := false;
  END IF;

  v_status := CASE WHEN v_requires_approval THEN 'pending_approval' ELSE 'auto_approved' END;

  INSERT INTO agent_action_log (
    user_id, action_slug, agent_source, target_table, target_id, amount_cents,
    reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
  ) VALUES (
    p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
    p_reasoning, p_payload, p_before_state, p_rollback_patch, v_status, p_correlation_id,
    CASE
      WHEN v_over_limit THEN 'Escalated to human approval: spending limit reached.'
      WHEN v_forced_by_authority THEN 'Escalated to human approval: Business Constitution requires human review for this category.'
      WHEN v_gate_reason IS NOT NULL THEN 'Escalated to human approval: ' || v_gate_reason
      ELSE NULL
    END
  ) RETURNING * INTO v_log;

  RETURN jsonb_build_object('decision', v_status, 'log_id', v_log.id, 'over_limit', v_over_limit);
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_agent_action(uuid, text, text, text, text, integer, text, jsonb, jsonb, jsonb, text) TO authenticated, service_role;

-- =============================================================
-- 13. Grants for the UI RPCs
-- =============================================================

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'cos_get_settings()', 'cos_set_kill_switch(boolean, text)', 'cos_set_autonomy_by_risk(jsonb, integer)',
    'cos_set_agent_dial(text, text, integer)', 'cos_list_agent_dials()',
    'cos_claim_recommendation(uuid, integer)', 'cos_resolve_recommendation(uuid, text, text)',
    'cos_usefulness_metrics(integer)', 'cos_confirm_goal_targets(jsonb)', 'cos_archive_goal_target(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;

-- =============================================================
-- 14. Background refresh + retention (service role only)
-- =============================================================

-- Runs the REAL get_capacity_status() for a given account owner. The function derives the account from
-- auth.uid(), so we set the transaction-local JWT subject for this one call (a service-role caller has none).
CREATE OR REPLACE FUNCTION public.cos_capacity_status_for(p_owner uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_owner IS NULL OR p_date IS NULL THEN RAISE EXCEPTION 'owner_and_date_required'; END IF;
  PERFORM set_config('request.jwt.claim.sub', p_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_owner, 'role', 'authenticated')::text, true);
  RETURN public.get_capacity_status(p_date);
END;
$$;
REVOKE ALL ON FUNCTION public.cos_capacity_status_for(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_capacity_status_for(uuid, date) TO service_role;

-- Accounts worth refreshing in the background: a live goal, a recent recommendation, or explicit settings.
CREATE OR REPLACE FUNCTION public.cos_active_owners(p_limit integer DEFAULT 25)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(u), '{}'::uuid[]) FROM (
    SELECT u FROM (
      SELECT user_id AS u FROM public.cos_goal_targets WHERE status = 'confirmed' AND period_end >= current_date - 7
      UNION
      SELECT user_id FROM public.cos_recommendations WHERE updated_at > now() - interval '30 days'
      UNION
      SELECT user_id FROM public.cos_settings
    ) x
    LEFT JOIN LATERAL (
      SELECT max(e.occurred_at) AS last_at FROM public.company_events e WHERE e.user_id = x.u AND e.event_type = 'cos_refreshed'
    ) l ON true
    ORDER BY l.last_at NULLS FIRST          -- least recently refreshed first
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100))
  ) y;
$$;
REVOKE ALL ON FUNCTION public.cos_active_owners(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_active_owners(integer) TO service_role;

-- Calls the chief-of-staff edge function with the shared cron secret. Silent no-op until both settings exist:
--   alter database postgres set "app.settings.edge_function_base_url" = 'https://<ref>.supabase.co/functions/v1';
--   alter database postgres set "app.settings.cos_cron_secret" = '<same value as the CRON_SECRET function secret>';
CREATE OR REPLACE FUNCTION public.cos_dispatch_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_url text := current_setting('app.settings.edge_function_base_url', true);
        v_secret text := current_setting('app.settings.cos_cron_secret', true);
BEGIN
  IF COALESCE(v_url, '') = '' OR COALESCE(v_secret, '') = '' THEN RETURN; END IF;
  PERFORM net.http_post(
    url := v_url || '/chief-of-staff',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    body := jsonb_build_object('action', 'refresh_all')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.cos_dispatch_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_dispatch_refresh() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('vireek-cos-prune'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('vireek-cos-prune', '17 3 * * 0', 'select public.cos_prune_events(90)');
    BEGIN PERFORM cron.unschedule('vireek-cos-refresh'); EXCEPTION WHEN OTHERS THEN NULL; END;
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
      PERFORM cron.schedule('vireek-cos-refresh', '*/15 * * * *', 'select public.cos_dispatch_refresh()');
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

/* ROLLBACK (manual, in this order):
   DROP TRIGGER IF EXISTS trg_cos_mirror_agent_action ON public.agent_action_log;
   -- re-run the evaluate_agent_action definition from 20261203000000_constitution_governance_unification.sql
   DROP FUNCTION IF EXISTS public.cos_gate(uuid, text, text, integer);
   DROP FUNCTION IF EXISTS public.cos_action_units(jsonb);
   DROP FUNCTION IF EXISTS public.cos_apply_refresh(uuid, jsonb, jsonb, text[]);
   SELECT cron.unschedule('vireek-cos-prune'); SELECT cron.unschedule('vireek-cos-refresh');
   DROP FUNCTION IF EXISTS public.cos_dispatch_refresh(), public.cos_active_owners(integer), public.cos_capacity_status_for(uuid, date);
   -- then the cos_* RPCs above, then tables: cos_conflicts, cos_recommendations, cos_goal_targets,
   -- company_events, cos_agent_dials, cos_settings.
*/
