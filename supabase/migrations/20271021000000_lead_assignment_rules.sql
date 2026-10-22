/*
  # Lead assignment rules for the CSR team

  Round-robin / load-balanced routing of new leads by service, ZIP/zone,
  language and lead source, with a first-touch SLA timer, auto-reassign when a
  lead is untouched for N minutes, escalation through the EXISTING on-call
  escalation tables, and per-agent conversion reporting.

  ## Reuses (nothing is duplicated)
  - leads                -> `assigned_to` (already there) + a few additive columns
  - team_members         -> agents, their `languages`, `invite_status`
  - service_areas        -> zone matching by ZIP / Canadian FSA
  - on_call_schedules + escalation_events (+ escalation-tick edge function)
                         -> when a lead is still untouched after the last
                            reassignment, an escalation_events row is created
                            (new nullable `lead_id` column) and the existing
                            tier notifier (SMS / call + tap-to-accept link) does
                            the rest. Accepting the link assigns the lead to the
                            person who accepted it.
  - notifications        -> account-level "lead not contacted" alert

  ## New tables
  lead_assignment_settings, lead_assignment_agents, lead_assignment_rules,
  lead_assignment_rule_agents, lead_assignment_events (append-only audit trail)

  ## How it works
  1. BEFORE INSERT/UPDATE trigger on leads stamps postal_code / language,
     assigned_at, sla_due_at and resets the touch/SLA flags whenever
     `assigned_to` changes (so a manual re-assign also gets a fresh SLA).
  2. AFTER INSERT trigger calls lead_assign() when the account enabled the
     engine. Assignment errors NEVER block lead creation (caught + WARNING).
  3. lead_assign() takes a per-account advisory lock, evaluates active rules by
     priority (all non-empty criteria must match; values inside one criterion
     are OR), then falls back to the default pool. Strategy per rule:
       round_robin   -> the agent who was assigned least recently
       load_balanced -> the agent with the fewest open leads (tie: least recent)
     Agents must accept leads, be active and be under `max_open_leads`.
     A lead language prefers agents who speak it; a rule with languages
     REQUIRES it.
  4. pg_cron runs lead_assignment_sweep() every minute: retries unassigned
     leads, marks SLA breaches, auto-reassigns after N minutes (never back to an
     agent who already had the lead) and escalates when nobody is left.
  5. A "touch" = the assigned agent changes stage / notes / quote / follow-up
     on the lead (or lead_mark_touched() is called). System updates (marketplace
     auto-reply, CRM sync) never count as a human touch.

  ## Security
  RLS on every table, scoped by public.get_account_owner_id(). Writes need
  can_manage_lead_assignment() (owner, admin or can_manage_team). Engine
  functions are SECURITY DEFINER with a pinned search_path and are only
  executable by service_role; the three client RPCs re-check tenant + permission.

  ## Scheduling
  A pg_cron job is registered below when pg_cron is installed (skipped with a
  NOTICE otherwise). The existing `escalation-tick` job must keep running.
*/

-- =============================================================
-- HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.lead_assignment_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- A lead counts toward an agent's load while it is in one of these stages.
CREATE OR REPLACE FUNCTION public.lead_stage_is_open(p_stage text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(coalesce(p_stage, 'new')) NOT IN
    ('won', 'lost', 'closed', 'dismissed', 'archived', 'spam', 'disqualified', 'junk', 'not_interested');
$$;

CREATE OR REPLACE FUNCTION public.lead_norm_postal(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN s.n = '' THEN NULL
    WHEN s.n ~ '^[0-9]{9}$' THEN left(s.n, 5)
    ELSE s.n
  END
  FROM (SELECT upper(regexp_replace(coalesce(p, ''), '[\s-]', '', 'g')) AS n) s;
$$;

-- Last US ZIP / Canadian postal code found in free text (same "last match
-- wins" rule as the service-area resolver).
CREATE OR REPLACE FUNCTION public.lead_extract_postal_code(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (SELECT upper((t.m)[1] || (t.m)[2])
       FROM regexp_matches(upper(coalesce(p, '')), '\m([A-Z][0-9][A-Z])[ -]?([0-9][A-Z][0-9])\M', 'g') WITH ORDINALITY AS t(m, ord)
      ORDER BY t.ord DESC LIMIT 1),
    (SELECT (t.m)[1]
       FROM regexp_matches(coalesce(p, ''), '(?<![0-9])([0-9]{5})(?:-[0-9]{4})?(?![0-9])', 'g') WITH ORDINALITY AS t(m, ord)
      ORDER BY t.ord DESC LIMIT 1)
  );
$$;

-- Exact match, or a 3-character Canadian FSA entry that prefixes the postal code.
CREATE OR REPLACE FUNCTION public.lead_postal_matches(p_postal text, p_entry text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN public.lead_norm_postal(p_postal) IS NULL OR public.lead_norm_postal(p_entry) IS NULL THEN false
    WHEN public.lead_norm_postal(p_postal) = public.lead_norm_postal(p_entry) THEN true
    WHEN public.lead_norm_postal(p_entry) ~ '^[A-Z][0-9][A-Z]$'
         AND left(public.lead_norm_postal(p_postal), 3) = public.lead_norm_postal(p_entry) THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_lead_assignment()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.invite_status IN ('active', 'accepted')
        AND (
          tm.role = 'admin'
          OR COALESCE((tm.permissions ->> 'can_manage_team')::boolean, false)
          OR COALESCE((cr.permissions ->> 'can_manage_team')::boolean, false)
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_lead_assignment() TO authenticated;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.lead_assignment_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  fallback_strategy text NOT NULL DEFAULT 'round_robin' CHECK (fallback_strategy IN ('round_robin', 'load_balanced')),
  first_touch_sla_minutes integer NOT NULL DEFAULT 5 CHECK (first_touch_sla_minutes BETWEEN 1 AND 1440),
  reassign_after_minutes integer NOT NULL DEFAULT 15 CHECK (reassign_after_minutes BETWEEN 1 AND 2880),
  max_reassignments integer NOT NULL DEFAULT 3 CHECK (max_reassignments BETWEEN 0 AND 10),
  reassign_manual_assignments boolean NOT NULL DEFAULT false,
  escalate_on_exhausted boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_assignment_settings_window CHECK (reassign_after_minutes >= first_touch_sla_minutes)
);

CREATE TABLE IF NOT EXISTS public.lead_assignment_agents (
  team_member_id uuid PRIMARY KEY REFERENCES public.team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  accepts_leads boolean NOT NULL DEFAULT true,
  max_open_leads integer NOT NULL DEFAULT 25 CHECK (max_open_leads BETWEEN 1 AND 1000),
  last_assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lead_assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  is_active boolean NOT NULL DEFAULT true,
  strategy text NOT NULL DEFAULT 'round_robin' CHECK (strategy IN ('round_robin', 'load_balanced')),
  services text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  postal_codes text[] NOT NULL DEFAULT '{}',
  service_area_ids uuid[] NOT NULL DEFAULT '{}',
  sources text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_assignment_rules_list_sizes CHECK (
    cardinality(services) <= 50 AND cardinality(languages) <= 20 AND cardinality(postal_codes) <= 2000
    AND cardinality(service_area_ids) <= 100 AND cardinality(sources) <= 30
  )
);

-- Rule pool. A rule without rows here uses every agent that accepts leads.
CREATE TABLE IF NOT EXISTS public.lead_assignment_rule_agents (
  rule_id uuid NOT NULL REFERENCES public.lead_assignment_rules(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  last_assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, team_member_id)
);

CREATE TABLE IF NOT EXISTS public.lead_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN
    ('assigned', 'reassigned', 'manual', 'escalation_accepted', 'unassigned', 'sla_breach', 'escalated', 'touched')),
  from_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  to_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES public.lead_assignment_rules(id) ON DELETE SET NULL,
  method text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_laa_user ON public.lead_assignment_agents (user_id);
CREATE INDEX IF NOT EXISTS idx_lar_user_active ON public.lead_assignment_rules (user_id, priority) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_larag_member ON public.lead_assignment_rule_agents (team_member_id);
CREATE INDEX IF NOT EXISTS idx_lae_user_created ON public.lead_assignment_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lae_lead ON public.lead_assignment_events (lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lae_to_member ON public.lead_assignment_events (to_member_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_las_touch ON public.lead_assignment_settings;
CREATE TRIGGER trg_las_touch BEFORE UPDATE ON public.lead_assignment_settings
  FOR EACH ROW EXECUTE FUNCTION public.lead_assignment_touch_updated_at();
DROP TRIGGER IF EXISTS trg_laa_touch ON public.lead_assignment_agents;
CREATE TRIGGER trg_laa_touch BEFORE UPDATE ON public.lead_assignment_agents
  FOR EACH ROW EXECUTE FUNCTION public.lead_assignment_touch_updated_at();
DROP TRIGGER IF EXISTS trg_lar_touch ON public.lead_assignment_rules;
CREATE TRIGGER trg_lar_touch BEFORE UPDATE ON public.lead_assignment_rules
  FOR EACH ROW EXECUTE FUNCTION public.lead_assignment_touch_updated_at();

-- =============================================================
-- ADDITIVE COLUMNS on the reused tables
-- =============================================================

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS assignment_rule_id uuid REFERENCES public.lead_assignment_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignment_method text,
  ADD COLUMN IF NOT EXISTS reassign_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_touched_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_assign_sweep
  ON public.leads (user_id, assigned_at)
  WHERE assigned_to IS NOT NULL AND first_touched_at IS NULL AND escalated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_unassigned
  ON public.leads (user_id, created_at)
  WHERE assigned_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_user_created ON public.leads (user_id, created_at DESC);

ALTER TABLE public.escalation_events
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

-- One live escalation per lead (makes lead_escalate() idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_events_active_lead
  ON public.escalation_events (lead_id)
  WHERE lead_id IS NOT NULL AND status = 'active';

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

ALTER TABLE public.lead_assignment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_rule_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_events ENABLE ROW LEVEL SECURITY;

-- settings
DROP POLICY IF EXISTS las_select ON public.lead_assignment_settings;
CREATE POLICY las_select ON public.lead_assignment_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS las_insert ON public.lead_assignment_settings;
CREATE POLICY las_insert ON public.lead_assignment_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());
DROP POLICY IF EXISTS las_update ON public.lead_assignment_settings;
CREATE POLICY las_update ON public.lead_assignment_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());

-- agents (the team member must belong to the same account)
DROP POLICY IF EXISTS laa_select ON public.lead_assignment_agents;
CREATE POLICY laa_select ON public.lead_assignment_agents FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS laa_insert ON public.lead_assignment_agents;
CREATE POLICY laa_insert ON public.lead_assignment_agents FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment()
    AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.id = team_member_id AND tm.account_owner_id = user_id)
  );
DROP POLICY IF EXISTS laa_update ON public.lead_assignment_agents;
CREATE POLICY laa_update ON public.lead_assignment_agents FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());
DROP POLICY IF EXISTS laa_delete ON public.lead_assignment_agents;
CREATE POLICY laa_delete ON public.lead_assignment_agents FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());

-- rules
DROP POLICY IF EXISTS lar_select ON public.lead_assignment_rules;
CREATE POLICY lar_select ON public.lead_assignment_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS lar_insert ON public.lead_assignment_rules;
CREATE POLICY lar_insert ON public.lead_assignment_rules FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());
DROP POLICY IF EXISTS lar_update ON public.lead_assignment_rules;
CREATE POLICY lar_update ON public.lead_assignment_rules FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());
DROP POLICY IF EXISTS lar_delete ON public.lead_assignment_rules;
CREATE POLICY lar_delete ON public.lead_assignment_rules FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lead_assignment());

-- rule pool
DROP POLICY IF EXISTS larag_select ON public.lead_assignment_rule_agents;
CREATE POLICY larag_select ON public.lead_assignment_rule_agents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.lead_assignment_rules r WHERE r.id = rule_id AND r.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS larag_insert ON public.lead_assignment_rule_agents;
CREATE POLICY larag_insert ON public.lead_assignment_rule_agents FOR INSERT TO authenticated
  WITH CHECK (
    public.can_manage_lead_assignment()
    AND EXISTS (SELECT 1 FROM public.lead_assignment_rules r WHERE r.id = rule_id AND r.user_id = public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.id = team_member_id AND tm.account_owner_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS larag_delete ON public.lead_assignment_rule_agents;
CREATE POLICY larag_delete ON public.lead_assignment_rule_agents FOR DELETE TO authenticated
  USING (
    public.can_manage_lead_assignment()
    AND EXISTS (SELECT 1 FROM public.lead_assignment_rules r WHERE r.id = rule_id AND r.user_id = public.get_account_owner_id())
  );

-- events: read-only for clients; every write goes through SECURITY DEFINER code
DROP POLICY IF EXISTS lae_select ON public.lead_assignment_events;
CREATE POLICY lae_select ON public.lead_assignment_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- ENGINE: pick an agent from a pool
-- =============================================================

-- p_rule_id NULL = default pool (every agent that accepts leads).
CREATE OR REPLACE FUNCTION public.lead_pick_from_pool(
  p_user_id uuid,
  p_rule_id uuid,
  p_strategy text,
  p_lang text,
  p_hard_lang boolean,
  p_exclude uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pick uuid;
BEGIN
  SELECT c.mid INTO v_pick
  FROM (
    SELECT
      a.team_member_id AS mid,
      a.max_open_leads AS cap,
      (SELECT count(*) FROM public.leads l
        WHERE l.user_id = p_user_id AND l.assigned_to = a.team_member_id AND public.lead_stage_is_open(l.stage)) AS open_cnt,
      CASE WHEN ra.team_member_id IS NOT NULL THEN ra.last_assigned_at ELSE a.last_assigned_at END AS last_at,
      (p_lang IS NOT NULL AND EXISTS (
        SELECT 1 FROM unnest(tm.languages) AS lg(val) WHERE lower(btrim(lg.val)) = p_lang
      )) AS speaks
    FROM public.lead_assignment_agents a
    JOIN public.team_members tm ON tm.id = a.team_member_id
    LEFT JOIN public.lead_assignment_rule_agents ra
      ON ra.rule_id = p_rule_id AND ra.team_member_id = a.team_member_id
    WHERE a.user_id = p_user_id
      AND a.accepts_leads
      AND tm.account_owner_id = p_user_id
      AND tm.invite_status IN ('active', 'accepted')
      AND NOT (a.team_member_id = ANY (coalesce(p_exclude, '{}'::uuid[])))
      AND (
        p_rule_id IS NULL
        OR ra.team_member_id IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM public.lead_assignment_rule_agents x WHERE x.rule_id = p_rule_id)
      )
  ) c
  WHERE c.open_cnt < c.cap
    AND (NOT p_hard_lang OR c.speaks)
  ORDER BY
    c.speaks DESC,
    CASE WHEN p_strategy = 'load_balanced' THEN c.open_cnt ELSE 0 END ASC,
    c.last_at ASC NULLS FIRST,
    c.mid
  LIMIT 1;

  RETURN v_pick;
END;
$$;

-- =============================================================
-- ENGINE: evaluate rules, then the default pool (read-only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.lead_pick_assignee(
  p_user_id uuid,
  p_service text,
  p_postal text,
  p_language text,
  p_source text,
  p_exclude uuid[] DEFAULT '{}'::uuid[]
)
RETURNS TABLE (out_member_id uuid, out_rule_id uuid, out_strategy text, out_method text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fallback text;
  v_rule public.lead_assignment_rules%ROWTYPE;
  v_pick uuid;
  v_postal text := public.lead_norm_postal(p_postal);
  v_lang text := nullif(lower(btrim(coalesce(p_language, ''))), '');
  v_service text := nullif(lower(btrim(coalesce(p_service, ''))), '');
  v_source text := nullif(lower(btrim(coalesce(p_source, ''))), '');
BEGIN
  SELECT s.fallback_strategy INTO v_fallback
  FROM public.lead_assignment_settings s WHERE s.user_id = p_user_id;
  v_fallback := coalesce(v_fallback, 'round_robin');

  FOR v_rule IN
    SELECT r.*
    FROM public.lead_assignment_rules r
    WHERE r.user_id = p_user_id
      AND r.is_active
      AND (
        cardinality(r.services) = 0
        OR (v_service IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(r.services) AS sv(val)
          WHERE btrim(sv.val) <> '' AND position(lower(btrim(sv.val)) IN v_service) > 0
        ))
      )
      AND (
        cardinality(r.languages) = 0
        OR (v_lang IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(r.languages) AS lg(val) WHERE lower(btrim(lg.val)) = v_lang
        ))
      )
      AND (
        cardinality(r.sources) = 0
        OR (v_source IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(r.sources) AS so(val) WHERE lower(btrim(so.val)) = v_source
        ))
      )
      AND (
        (cardinality(r.postal_codes) = 0 AND cardinality(r.service_area_ids) = 0)
        OR (v_postal IS NOT NULL AND (
          EXISTS (SELECT 1 FROM unnest(r.postal_codes) AS pc(val) WHERE public.lead_postal_matches(v_postal, pc.val))
          OR EXISTS (
            SELECT 1 FROM public.service_areas sa
            WHERE sa.id = ANY (r.service_area_ids)
              AND sa.user_id = p_user_id
              AND sa.is_active
              AND EXISTS (SELECT 1 FROM unnest(sa.zip_codes) AS z(val) WHERE public.lead_postal_matches(v_postal, z.val))
          )
        ))
      )
    ORDER BY r.priority, r.created_at, r.id
  LOOP
    v_pick := public.lead_pick_from_pool(
      p_user_id, v_rule.id, v_rule.strategy, v_lang, cardinality(v_rule.languages) > 0, p_exclude
    );
    IF v_pick IS NOT NULL THEN
      out_member_id := v_pick;
      out_rule_id := v_rule.id;
      out_strategy := v_rule.strategy;
      out_method := 'rule_' || v_rule.strategy;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;

  v_pick := public.lead_pick_from_pool(p_user_id, NULL, v_fallback, v_lang, false, p_exclude);
  IF v_pick IS NOT NULL THEN
    out_member_id := v_pick;
    out_rule_id := NULL;
    out_strategy := v_fallback;
    out_method := 'default_' || v_fallback;
    RETURN NEXT;
  END IF;
  RETURN;
END;
$$;

-- =============================================================
-- ENGINE: assign / reassign one lead (atomic, race-safe)
-- Returns the chosen team_member id, or NULL when nothing changed.
-- =============================================================

CREATE OR REPLACE FUNCTION public.lead_assign(
  p_lead_id uuid,
  p_event text DEFAULT 'assigned',
  p_extra_exclude uuid[] DEFAULT '{}'::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lead public.leads%ROWTYPE;
  v_enabled boolean;
  v_lang text;
  v_exclude uuid[];
  v_pick record;
BEGIN
  IF p_event NOT IN ('assigned', 'reassigned') THEN
    RAISE EXCEPTION 'lead_assign: invalid event %', p_event;
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT s.enabled INTO v_enabled FROM public.lead_assignment_settings s WHERE s.user_id = v_lead.user_id;
  IF v_enabled IS DISTINCT FROM true THEN RETURN NULL; END IF;

  -- Serialise assignment per account so open-lead counts and the round-robin
  -- cursor are never read stale by two concurrent inserts.
  PERFORM pg_advisory_xact_lock(hashtextextended('lead_assign:' || v_lead.user_id::text, 0));

  v_lang := coalesce(
    nullif(btrim(v_lead.language), ''),
    (SELECT c.detected_language FROM public.calls c WHERE c.id = v_lead.call_id)
  );

  v_exclude := coalesce(p_extra_exclude, '{}'::uuid[]);
  IF p_event = 'reassigned' THEN
    v_exclude := v_exclude || ARRAY(
      SELECT DISTINCT e.to_member_id FROM public.lead_assignment_events e
      WHERE e.lead_id = v_lead.id AND e.to_member_id IS NOT NULL
    );
    IF v_lead.assigned_to IS NOT NULL THEN
      v_exclude := v_exclude || v_lead.assigned_to;
    END IF;
  END IF;

  SELECT p.out_member_id AS member_id, p.out_rule_id AS rule_id, p.out_method AS method
    INTO v_pick
  FROM public.lead_pick_assignee(
    v_lead.user_id,
    v_lead.service_interested,
    coalesce(v_lead.postal_code, public.lead_extract_postal_code(v_lead.notes)),
    v_lang,
    v_lead.source,
    v_exclude
  ) p;

  IF v_pick.member_id IS NULL THEN
    -- Log "nobody available" once per lead, not on every retry.
    IF p_event = 'assigned' AND v_lead.assigned_to IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.lead_assignment_events e
      WHERE e.lead_id = v_lead.id AND e.event_type = 'unassigned'
    ) THEN
      INSERT INTO public.lead_assignment_events (user_id, lead_id, event_type)
      VALUES (v_lead.user_id, v_lead.id, 'unassigned');
    END IF;
    RETURN NULL;
  END IF;

  PERFORM set_config('vireek.lead_event', p_event, true);
  PERFORM set_config('vireek.lead_rule', coalesce(v_pick.rule_id::text, ''), true);
  PERFORM set_config('vireek.lead_method', coalesce(v_pick.method, ''), true);

  UPDATE public.leads SET assigned_to = v_pick.member_id WHERE id = v_lead.id;

  PERFORM set_config('vireek.lead_event', '', true);
  PERFORM set_config('vireek.lead_rule', '', true);
  PERFORM set_config('vireek.lead_method', '', true);

  UPDATE public.lead_assignment_agents SET last_assigned_at = clock_timestamp()
  WHERE team_member_id = v_pick.member_id;
  IF v_pick.rule_id IS NOT NULL THEN
    UPDATE public.lead_assignment_rule_agents SET last_assigned_at = clock_timestamp()
    WHERE rule_id = v_pick.rule_id AND team_member_id = v_pick.member_id;
  END IF;

  RETURN v_pick.member_id;
END;
$$;

-- =============================================================
-- ENGINE: escalate (reuses on_call_schedules / escalation_events)
-- =============================================================

CREATE OR REPLACE FUNCTION public.lead_escalate(p_lead_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lead public.leads%ROWTYPE;
  v_escalate boolean;
  v_schedule uuid;
  v_notif uuid;
BEGIN
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND OR v_lead.escalated_at IS NOT NULL THEN RETURN false; END IF;

  SELECT s.escalate_on_exhausted INTO v_escalate
  FROM public.lead_assignment_settings s WHERE s.user_id = v_lead.user_id;

  UPDATE public.leads SET escalated_at = now() WHERE id = v_lead.id;

  INSERT INTO public.lead_assignment_events (user_id, lead_id, event_type, from_member_id, detail)
  VALUES (v_lead.user_id, v_lead.id, 'escalated', v_lead.assigned_to,
          jsonb_build_object('reassign_count', v_lead.reassign_count));

  BEGIN
    INSERT INTO public.notifications (user_id, type, title, message, action_url)
    VALUES (
      v_lead.user_id,
      'lead_sla_breach',
      left('Lead not contacted: ' || coalesce(nullif(btrim(v_lead.name), ''), 'Unknown'), 80),
      'No agent contacted this lead within the SLA, even after reassignment.',
      '/dashboard/leads/' || v_lead.id::text
    )
    RETURNING id INTO v_notif;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'lead_escalate: notification failed for lead %: %', v_lead.id, SQLERRM;
    v_notif := NULL;
  END;

  IF coalesce(v_escalate, true) THEN
    SELECT s.id INTO v_schedule
    FROM public.on_call_schedules s
    WHERE s.user_id = v_lead.user_id AND s.is_active
    ORDER BY s.created_at LIMIT 1;

    IF v_schedule IS NOT NULL THEN
      BEGIN
        INSERT INTO public.escalation_events (user_id, schedule_id, current_tier, status, lead_id, notification_id, reason)
        VALUES (v_lead.user_id, v_schedule, 1, 'active', v_lead.id, v_notif, 'lead_sla_breach')
        ON CONFLICT (lead_id) WHERE lead_id IS NOT NULL AND status = 'active' DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'lead_escalate: escalation event failed for lead %: %', v_lead.id, SQLERRM;
      END;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- =============================================================
-- ENGINE: sweep (pg_cron, every minute)
-- =============================================================

CREATE OR REPLACE FUNCTION public.lead_assignment_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_assigned integer := 0;
  v_reassigned integer := 0;
  v_breached integer := 0;
  v_escalated integer := 0;
  v_failed integer := 0;
  v_picked uuid;
BEGIN
  FOR r IN
    SELECT l.id, l.user_id, l.assigned_to, l.assigned_at, l.sla_due_at, l.sla_breached_at,
           l.reassign_count, l.assignment_method,
           s.reassign_after_minutes, s.max_reassignments, s.reassign_manual_assignments
    FROM public.leads l
    JOIN public.lead_assignment_settings s ON s.user_id = l.user_id AND s.enabled
    WHERE public.lead_stage_is_open(l.stage)
      AND (
        (l.assigned_to IS NULL AND l.created_at > now() - interval '48 hours')
        OR (
          l.assigned_to IS NOT NULL
          AND l.assigned_at IS NOT NULL
          AND l.first_touched_at IS NULL
          AND l.escalated_at IS NULL
          AND l.assigned_at <= now() - make_interval(mins => s.first_touch_sla_minutes)
        )
      )
    ORDER BY l.created_at
    LIMIT 500
    FOR UPDATE OF l SKIP LOCKED
  LOOP
    BEGIN
      IF r.assigned_to IS NULL THEN
        IF public.lead_assign(r.id, 'assigned') IS NOT NULL THEN
          v_assigned := v_assigned + 1;
        END IF;
        CONTINUE;
      END IF;

      IF r.sla_breached_at IS NULL AND r.sla_due_at IS NOT NULL AND r.sla_due_at <= now() THEN
        UPDATE public.leads SET sla_breached_at = now() WHERE id = r.id;
        INSERT INTO public.lead_assignment_events (user_id, lead_id, event_type, to_member_id, rule_id)
        SELECT r.user_id, r.id, 'sla_breach', r.assigned_to, l2.assignment_rule_id
        FROM public.leads l2 WHERE l2.id = r.id;
        v_breached := v_breached + 1;
      END IF;

      IF r.assigned_at <= now() - make_interval(mins => r.reassign_after_minutes) THEN
        v_picked := NULL;
        IF r.reassign_count < r.max_reassignments
           AND (r.assignment_method IS DISTINCT FROM 'manual' OR r.reassign_manual_assignments) THEN
          v_picked := public.lead_assign(r.id, 'reassigned');
        END IF;
        IF v_picked IS NOT NULL THEN
          v_reassigned := v_reassigned + 1;
        ELSIF public.lead_escalate(r.id) THEN
          v_escalated := v_escalated + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'lead_assignment_sweep: lead % failed: %', r.id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'assigned', v_assigned, 'reassigned', v_reassigned, 'sla_breaches', v_breached,
    'escalated', v_escalated, 'failed', v_failed
  );
END;
$$;

-- =============================================================
-- TRIGGERS on leads
-- =============================================================

CREATE OR REPLACE FUNCTION public.trg_lead_assignment_bookkeeping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sla integer;
  v_event text := nullif(current_setting('vireek.lead_event', true), '');
  v_rule text := nullif(current_setting('vireek.lead_rule', true), '');
  v_method text := nullif(current_setting('vireek.lead_method', true), '');
  v_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.postal_code := coalesce(public.lead_norm_postal(NEW.postal_code), public.lead_extract_postal_code(NEW.notes));
    IF NEW.language IS NULL OR btrim(NEW.language) = '' THEN
      NEW.language := (SELECT c.detected_language FROM public.calls c WHERE c.id = NEW.call_id);
    END IF;
    v_changed := NEW.assigned_to IS NOT NULL;
  ELSE
    v_changed := NEW.assigned_to IS DISTINCT FROM OLD.assigned_to;
  END IF;

  IF v_changed THEN
    IF NEW.assigned_to IS NULL THEN
      NEW.assigned_at := NULL;
      NEW.sla_due_at := NULL;
      NEW.assignment_method := NULL;
      NEW.assignment_rule_id := NULL;
    ELSE
      SELECT s.first_touch_sla_minutes INTO v_sla
      FROM public.lead_assignment_settings s WHERE s.user_id = NEW.user_id;
      NEW.assigned_at := now();
      NEW.sla_due_at := CASE WHEN v_sla IS NULL THEN NULL ELSE now() + make_interval(mins => v_sla) END;
      NEW.assignment_method := coalesce(v_method, 'manual');
      NEW.assignment_rule_id := CASE WHEN v_event IS NULL THEN NULL ELSE v_rule::uuid END;
    END IF;
    NEW.first_touched_at := NULL;
    NEW.sla_breached_at := NULL;
    NEW.escalated_at := NULL;
    IF TG_OP = 'UPDATE' THEN
      IF v_event = 'reassigned' THEN
        NEW.reassign_count := OLD.reassign_count + 1;
      ELSIF v_event IS NULL THEN
        NEW.reassign_count := 0;
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A human touch: the assignee themself changed something meaningful.
    IF OLD.first_touched_at IS NULL
       AND NEW.first_touched_at IS NULL
       AND NEW.assigned_to IS NOT NULL
       AND auth.uid() IS NOT NULL
       AND (
         NEW.stage IS DISTINCT FROM OLD.stage
         OR NEW.notes IS DISTINCT FROM OLD.notes
         OR NEW.quote_amount IS DISTINCT FROM OLD.quote_amount
         OR NEW.quote_sent_at IS DISTINCT FROM OLD.quote_sent_at
         OR NEW.last_follow_up_at IS DISTINCT FROM OLD.last_follow_up_at
       )
       AND EXISTS (
         SELECT 1 FROM public.team_members tm WHERE tm.id = NEW.assigned_to AND tm.user_id = auth.uid()
       ) THEN
      NEW.first_touched_at := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_lead_assignment_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event text := nullif(current_setting('vireek.lead_event', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.lead_assignment_events (user_id, lead_id, event_type, to_member_id, rule_id, method)
    VALUES (NEW.user_id, NEW.id, coalesce(v_event, 'manual'), NEW.assigned_to, NEW.assignment_rule_id, NEW.assignment_method);
  ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO public.lead_assignment_events (user_id, lead_id, event_type, from_member_id, to_member_id, rule_id, method)
    VALUES (NEW.user_id, NEW.id, coalesce(v_event, 'manual'), OLD.assigned_to, NEW.assigned_to, NEW.assignment_rule_id, NEW.assignment_method);
  ELSIF OLD.first_touched_at IS NULL AND NEW.first_touched_at IS NOT NULL THEN
    INSERT INTO public.lead_assignment_events (user_id, lead_id, event_type, to_member_id)
    VALUES (NEW.user_id, NEW.id, 'touched', NEW.assigned_to);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_lead_auto_assign()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.assigned_to IS NULL
     AND EXISTS (SELECT 1 FROM public.lead_assignment_settings s WHERE s.user_id = NEW.user_id AND s.enabled) THEN
    BEGIN
      PERFORM public.lead_assign(NEW.id, 'assigned');
    EXCEPTION WHEN OTHERS THEN
      -- Never block lead creation; the minute sweep retries unassigned leads.
      RAISE WARNING 'lead auto-assign failed for lead %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_assignment_bookkeeping ON public.leads;
CREATE TRIGGER trg_leads_assignment_bookkeeping
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_lead_assignment_bookkeeping();

DROP TRIGGER IF EXISTS trg_leads_assignment_event_ins ON public.leads;
CREATE TRIGGER trg_leads_assignment_event_ins
  AFTER INSERT ON public.leads
  FOR EACH ROW WHEN (NEW.assigned_to IS NOT NULL)
  EXECUTE FUNCTION public.trg_lead_assignment_event();

DROP TRIGGER IF EXISTS trg_leads_assignment_event_upd ON public.leads;
CREATE TRIGGER trg_leads_assignment_event_upd
  AFTER UPDATE ON public.leads
  FOR EACH ROW
  WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
        OR (OLD.first_touched_at IS NULL AND NEW.first_touched_at IS NOT NULL))
  EXECUTE FUNCTION public.trg_lead_assignment_event();

DROP TRIGGER IF EXISTS trg_leads_zz_auto_assign ON public.leads;
CREATE TRIGGER trg_leads_zz_auto_assign
  AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_lead_auto_assign();

-- "Tap to accept" on a lead escalation: the person who accepted owns the lead.
CREATE OR REPLACE FUNCTION public.trg_escalation_lead_ack()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.acknowledged_by IS NOT NULL THEN
    PERFORM set_config('vireek.lead_event', 'escalation_accepted', true);
    PERFORM set_config('vireek.lead_rule', '', true);
    PERFORM set_config('vireek.lead_method', 'escalation', true);
    UPDATE public.leads SET assigned_to = NEW.acknowledged_by
    WHERE id = NEW.lead_id AND assigned_to IS DISTINCT FROM NEW.acknowledged_by;
    PERFORM set_config('vireek.lead_event', '', true);
    PERFORM set_config('vireek.lead_method', '', true);
  END IF;
  UPDATE public.leads SET first_touched_at = coalesce(first_touched_at, now()) WHERE id = NEW.lead_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_escalation_lead_ack ON public.escalation_events;
CREATE TRIGGER trg_escalation_lead_ack
  AFTER UPDATE OF status ON public.escalation_events
  FOR EACH ROW
  WHEN (NEW.lead_id IS NOT NULL AND NEW.status = 'acknowledged' AND OLD.status IS DISTINCT FROM 'acknowledged')
  EXECUTE FUNCTION public.trg_escalation_lead_ack();

-- =============================================================
-- CLIENT RPCs (tenant + permission re-checked inside)
-- =============================================================

-- Dry-run: which agent / rule would a lead with these attributes get right now?
CREATE OR REPLACE FUNCTION public.lead_assignment_preview(
  p_service text DEFAULT NULL,
  p_postal text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_source text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pick record;
  v_member_name text;
  v_rule_name text;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_lead_assignment() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT p.out_member_id AS member_id, p.out_rule_id AS rule_id, p.out_method AS method
    INTO v_pick
  FROM public.lead_pick_assignee(v_owner, p_service, p_postal, p_language, p_source, '{}'::uuid[]) p;

  IF v_pick.member_id IS NULL THEN
    RETURN jsonb_build_object('matched', false);
  END IF;

  SELECT coalesce(nullif(btrim(tm.member_name), ''), tm.member_email) INTO v_member_name
  FROM public.team_members tm WHERE tm.id = v_pick.member_id;
  SELECT r.name INTO v_rule_name FROM public.lead_assignment_rules r WHERE r.id = v_pick.rule_id;

  RETURN jsonb_build_object(
    'matched', true,
    'member_id', v_pick.member_id,
    'member_name', v_member_name,
    'rule_id', v_pick.rule_id,
    'rule_name', v_rule_name,
    'method', v_pick.method
  );
END;
$$;

-- Mark a lead as touched (call / SMS / email logged outside the lead row).
CREATE OR REPLACE FUNCTION public.lead_mark_touched(p_lead_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_lead public.leads%ROWTYPE;
  v_is_assignee boolean;
BEGIN
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_lead.assigned_to IS NULL OR v_lead.first_touched_at IS NOT NULL THEN RETURN false; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.team_members tm WHERE tm.id = v_lead.assigned_to AND tm.user_id = auth.uid()
  ) INTO v_is_assignee;
  IF NOT v_is_assignee AND NOT public.can_manage_lead_assignment() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.leads SET first_touched_at = now() WHERE id = v_lead.id;
  RETURN true;
END;
$$;

-- Per-agent performance for leads CREATED in [p_from, p_to].
CREATE OR REPLACE FUNCTION public.lead_assignment_agent_report(
  p_from timestamptz DEFAULT (now() - interval '30 days'),
  p_to timestamptz DEFAULT now()
)
RETURNS TABLE (
  member_id uuid,
  member_name text,
  leads_assigned bigint,
  leads_touched bigint,
  leads_won bigint,
  conversion_rate numeric,
  avg_first_touch_minutes numeric,
  sla_breaches bigint,
  reassigned_away bigint,
  open_leads bigint,
  won_value numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_lead_assignment() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_to < p_from OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'invalid date range' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT q.member_id, q.member_name, q.leads_assigned, q.leads_touched, q.leads_won, q.conversion_rate,
         q.avg_first_touch_minutes, q.sla_breaches, q.reassigned_away, q.open_leads, q.won_value
  FROM (
    WITH stats AS (
      SELECT l.assigned_to AS mid,
             count(*) AS assigned,
             count(*) FILTER (WHERE l.first_touched_at IS NOT NULL) AS touched,
             count(*) FILTER (WHERE l.stage = 'won') AS won,
             avg(extract(epoch FROM (l.first_touched_at - l.assigned_at)) / 60.0)
               FILTER (WHERE l.first_touched_at IS NOT NULL AND l.assigned_at IS NOT NULL) AS avg_touch,
             coalesce(sum(l.quote_amount) FILTER (WHERE l.stage = 'won'), 0) AS won_val
      FROM public.leads l
      WHERE l.user_id = v_owner AND l.created_at >= p_from AND l.created_at <= p_to
      GROUP BY l.assigned_to
    ),
    breaches AS (
      SELECT e.to_member_id AS mid, count(*) AS c FROM public.lead_assignment_events e
      WHERE e.user_id = v_owner AND e.event_type = 'sla_breach' AND e.created_at >= p_from AND e.created_at <= p_to
      GROUP BY e.to_member_id
    ),
    moved AS (
      SELECT e.from_member_id AS mid, count(*) AS c FROM public.lead_assignment_events e
      WHERE e.user_id = v_owner AND e.event_type = 'reassigned' AND e.created_at >= p_from AND e.created_at <= p_to
      GROUP BY e.from_member_id
    ),
    open_now AS (
      SELECT l.assigned_to AS mid, count(*) AS c FROM public.leads l
      WHERE l.user_id = v_owner AND l.assigned_to IS NOT NULL AND public.lead_stage_is_open(l.stage)
      GROUP BY l.assigned_to
    ),
    agents AS (
      SELECT tm.id AS mid, coalesce(nullif(btrim(tm.member_name), ''), tm.member_email) AS mname
      FROM public.team_members tm
      WHERE tm.account_owner_id = v_owner
        AND (
          EXISTS (SELECT 1 FROM public.lead_assignment_agents a WHERE a.team_member_id = tm.id)
          OR EXISTS (SELECT 1 FROM stats s WHERE s.mid = tm.id)
        )
    )
    SELECT a.mid AS member_id,
           a.mname AS member_name,
           coalesce(s.assigned, 0)::bigint AS leads_assigned,
           coalesce(s.touched, 0)::bigint AS leads_touched,
           coalesce(s.won, 0)::bigint AS leads_won,
           coalesce(round(100.0 * s.won / nullif(s.assigned, 0), 1), 0)::numeric AS conversion_rate,
           round(s.avg_touch::numeric, 1) AS avg_first_touch_minutes,
           coalesce(b.c, 0)::bigint AS sla_breaches,
           coalesce(m.c, 0)::bigint AS reassigned_away,
           coalesce(o.c, 0)::bigint AS open_leads,
           coalesce(s.won_val, 0)::numeric AS won_value
    FROM agents a
    LEFT JOIN stats s ON s.mid = a.mid
    LEFT JOIN breaches b ON b.mid = a.mid
    LEFT JOIN moved m ON m.mid = a.mid
    LEFT JOIN open_now o ON o.mid = a.mid
    UNION ALL
    SELECT NULL::uuid, 'Unassigned', s.assigned::bigint, s.touched::bigint, s.won::bigint, 0::numeric,
           NULL::numeric, 0::bigint, 0::bigint, 0::bigint, s.won_val::numeric
    FROM stats s WHERE s.mid IS NULL
  ) q
  ORDER BY q.leads_won DESC, q.leads_assigned DESC, q.member_name;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.lead_pick_from_pool(uuid, uuid, text, text, boolean, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_pick_assignee(uuid, text, text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_assign(uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_escalate(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_assignment_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_pick_from_pool(uuid, uuid, text, text, boolean, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.lead_pick_assignee(uuid, text, text, text, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.lead_assign(uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.lead_escalate(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lead_assignment_sweep() TO service_role;

REVOKE ALL ON FUNCTION public.lead_assignment_preview(text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lead_mark_touched(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lead_assignment_agent_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_assignment_preview(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lead_mark_touched(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lead_assignment_agent_report(timestamptz, timestamptz) TO authenticated;

-- =============================================================
-- SCHEDULE (skipped with a NOTICE when pg_cron is not installed)
-- =============================================================
DO $$
BEGIN
  PERFORM cron.schedule('vireek-lead-assignment-sweep', '* * * * *', 'select public.lead_assignment_sweep()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END;
$$;
