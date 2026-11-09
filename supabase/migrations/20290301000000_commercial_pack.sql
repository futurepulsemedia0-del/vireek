/*
  # Commercial Services Pack (entitlement `packs:commercial`, flag `commercial_pack`, default OFF)

  ## What already exists and is REUSED (nothing below duplicates it)
    customers > customer_sites > buildings > floors > rooms, equipment.room_id   (20261112000000)  -> hierarchy + assets
    work_orders / work_order_visits: PO number, NTE cap, approval_status          (20270410000000)  -> PO / NTE / approval gate
    commercial_contracts, contract_sla_breaches                                   (20261002000000)  -> contract + breach ledger
    agreement_assets / agreement_entitlements / agreement_pm_plans / agreement_visits (20270410000000) -> coverage, PM per asset
    trade_packs + trade_pack_installs + install_trade_pack()                      (20271201000000)  -> per-account entitlement
    feature_flags + flag_evaluate()                                               (20280501000000)  -> release flag
    audit_log + log_audit_event(), notifications                                  -> audit trail / alerts

  ## What is NEW (all additive, IF NOT EXISTS)
    commercial_calendars, commercial_sla_policies, commercial_sla_timers, commercial_sla_pauses,
    commercial_sla_events (append-only), commercial_settings, commercial_customer_billing,
    commercial_statements + items, commercial_approval_requests + decisions (append-only),
    commercial_site_access; RPCs for timers, approvals, statements, coverage inputs, PM-due list,
    portal site history, and a service-role-only sweep pair used by the commercial-sla-sweep edge function.

  ## Gate (zero behaviour change while OFF)
    commercial_pack_enabled() = flag `commercial_pack` ON for the account AND an enabled
    trade_pack_installs row (pack_key = 'commercial'). Every new table policy and RPC checks it.
    Existing tables / policies / triggers are NOT modified.

  ## Time math lives in ONE place
    Business-hours / holiday / time-zone / pause arithmetic is src/lib/commercial/slaClock.ts (pure, tested).
    The database stores facts (timers, pauses, calendars) and records results; it does not re-implement the clock.

  ## Rollback (manual, in this order; data loss is intended)
    DROP FUNCTION ... (every function named below);  DROP TABLE commercial_statement_items, commercial_statements,
    commercial_customer_billing, commercial_settings, commercial_approval_decisions, commercial_approval_requests,
    commercial_sla_events, commercial_sla_pauses, commercial_sla_timers, commercial_sla_policies,
    commercial_calendars, commercial_site_access;  DELETE FROM trade_pack_installs WHERE pack_key='commercial';
    DELETE FROM trade_packs WHERE pack_key='commercial'.  Disabling the flag alone is the safe, non-destructive off-switch.
*/

-- =============================================================
-- 0. PACK ROW (entitlement target of install_trade_pack('commercial','[]','[]'))
-- =============================================================
INSERT INTO trade_packs (pack_key, name, industry_slug)
VALUES ('commercial', 'Commercial Services', 'commercial-services')
ON CONFLICT (pack_key) DO UPDATE SET name = EXCLUDED.name;

-- =============================================================
-- 1. HELPERS
-- =============================================================

-- Internal: entitlement for an explicit account (service role / definer functions only).
CREATE OR REPLACE FUNCTION public.commercial_pack_enabled_for(p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_owner IS NOT NULL
     AND public.flag_evaluate('commercial_pack', p_owner)
     AND EXISTS (SELECT 1 FROM trade_pack_installs i WHERE i.user_id = p_owner AND i.pack_key = 'commercial' AND i.enabled);
$$;
REVOKE ALL ON FUNCTION public.commercial_pack_enabled_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_pack_enabled_for(uuid) TO service_role;

-- Caller's own account.
CREATE OR REPLACE FUNCTION public.commercial_pack_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.commercial_pack_enabled_for(public.get_account_owner_id()); $$;
REVOKE ALL ON FUNCTION public.commercial_pack_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commercial_pack_enabled() TO authenticated, service_role;

-- Who may configure calendars / SLA policies / billing terms: owner, admin, business-profile editor, or billing permission.
CREATE OR REPLACE FUNCTION public.commercial_can_manage()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.commercial_pack_enabled() AND (public.can_manage_trade_packs() OR public.can_manage_work_orders()); $$;
REVOKE ALL ON FUNCTION public.commercial_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commercial_can_manage() TO authenticated;

-- 'owner' | 'manager' | NULL. Managers = active admins or members allowed to manage the team.
CREATE OR REPLACE FUNCTION public.commercial_approver_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE
    WHEN public.is_account_owner() THEN 'owner'
    WHEN EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND tm.invite_status = 'active'
        AND (tm.role = 'admin' OR COALESCE(tm.permissions ->> 'can_manage_team', 'false') = 'true')
    ) THEN 'manager'
    ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.commercial_approver_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commercial_approver_role() TO authenticated;

-- =============================================================
-- 2. PER-SITE PERMISSIONS (opt-in restriction; no rows = unrestricted, so nothing changes by default)
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_site_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_member_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_site_access_member ON commercial_site_access (team_member_id);
CREATE INDEX IF NOT EXISTS idx_commercial_site_access_site ON commercial_site_access (site_id);

CREATE OR REPLACE FUNCTION public.commercial_site_access_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = NEW.team_member_id AND tm.account_owner_id = NEW.user_id)
     OR NOT EXISTS (SELECT 1 FROM customer_sites s WHERE s.id = NEW.site_id AND s.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Team member and site must belong to this account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_site_access_guard ON commercial_site_access;
CREATE TRIGGER trg_commercial_site_access_guard BEFORE INSERT OR UPDATE ON commercial_site_access
  FOR EACH ROW EXECUTE FUNCTION public.commercial_site_access_guard();

-- TRUE when the caller may see rows tied to p_site_id.
-- Owner: always. Team member with NO access rows: always (default = unchanged behaviour). Otherwise only listed sites.
CREATE OR REPLACE FUNCTION public.commercial_site_visible(p_site_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_member uuid;
BEGIN
  IF p_site_id IS NULL OR public.is_account_owner() THEN RETURN true; END IF;
  SELECT tm.id INTO v_member FROM team_members tm
   WHERE tm.account_owner_id = public.get_account_owner_id()
     AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
   LIMIT 1;
  IF v_member IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM commercial_site_access a WHERE a.team_member_id = v_member) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM commercial_site_access a WHERE a.team_member_id = v_member AND a.site_id = p_site_id);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_site_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commercial_site_visible(uuid) TO authenticated;

ALTER TABLE commercial_site_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "commercial_site_access_select" ON commercial_site_access;
CREATE POLICY "commercial_site_access_select" ON commercial_site_access FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND (SELECT public.commercial_can_manage()));
DROP POLICY IF EXISTS "commercial_site_access_insert" ON commercial_site_access;
CREATE POLICY "commercial_site_access_insert" ON commercial_site_access FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()));
DROP POLICY IF EXISTS "commercial_site_access_delete" ON commercial_site_access;
CREATE POLICY "commercial_site_access_delete" ON commercial_site_access FOR DELETE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()));

-- =============================================================
-- 3. CALENDARS + SLA POLICIES
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  time_zone text NOT NULL,
  -- [{"days":[1,2,3,4,5],"startMin":480,"endMin":1020}] — same shape as BusinessWindow in slaClock.ts
  windows jsonb NOT NULL DEFAULT '[{"days":[1,2,3,4,5],"startMin":480,"endMin":1020}]'::jsonb
    CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) BETWEEN 1 AND 14),
  holidays text[] NOT NULL DEFAULT '{}' CHECK (cardinality(holidays) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE OR REPLACE FUNCTION public.commercial_calendar_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  w jsonb;
  h text;
  d jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'A calendar cannot move to another account' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown time zone "%"', NEW.time_zone USING ERRCODE = '22023';
  END IF;
  FOR w IN SELECT * FROM jsonb_array_elements(NEW.windows) LOOP
    IF jsonb_typeof(w -> 'days') <> 'array' OR jsonb_array_length(w -> 'days') = 0
       OR (w ->> 'startMin') IS NULL OR (w ->> 'endMin') IS NULL
       OR (w ->> 'startMin') !~ '^\d+$' OR (w ->> 'endMin') !~ '^\d+$'
       OR (w ->> 'startMin')::int >= (w ->> 'endMin')::int OR (w ->> 'endMin')::int > 1440 THEN
      RAISE EXCEPTION 'Each business window needs days and a start before its end (0-1440 minutes)' USING ERRCODE = '23514';
    END IF;
    FOR d IN SELECT * FROM jsonb_array_elements(w -> 'days') LOOP
      IF jsonb_typeof(d) <> 'number' OR (d #>> '{}') !~ '^[0-6]$' THEN
        RAISE EXCEPTION 'Window days must be 0 (Sunday) to 6 (Saturday)' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH h IN ARRAY NEW.holidays LOOP
    IF h !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'Holiday "%" must be YYYY-MM-DD', h USING ERRCODE = '23514';
    END IF;
    BEGIN
      IF to_char(h::date, 'YYYY-MM-DD') <> h THEN RAISE EXCEPTION 'bad date'; END IF;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Holiday "%" is not a real date', h USING ERRCODE = '23514';
    END;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_calendar_guard ON commercial_calendars;
CREATE TRIGGER trg_commercial_calendar_guard BEFORE INSERT OR UPDATE ON commercial_calendars
  FOR EACH ROW EXECUTE FUNCTION public.commercial_calendar_guard();

CREATE TABLE IF NOT EXISTS commercial_sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES commercial_calendars(id) ON DELETE RESTRICT,
  priority text NOT NULL CHECK (priority IN ('standard', 'urgent', 'emergency')),
  kind text NOT NULL CHECK (kind IN ('response', 'resolution')),
  target_minutes integer NOT NULL CHECK (target_minutes BETWEEN 1 AND 525600),
  warn_at_pct integer NOT NULL DEFAULT 80 CHECK (warn_at_pct BETWEEN 1 AND 99),
  -- Job statuses (jobs.job_status) that stop the clock, e.g. {awaiting_customer,awaiting_parts}
  pause_statuses text[] NOT NULL DEFAULT '{}' CHECK (cardinality(pause_statuses) <= 20),
  max_pause_minutes integer CHECK (max_pause_minutes IS NULL OR max_pause_minutes > 0),
  -- [{"key":"warn80","atPct":80,"notify":"dispatcher"},{"key":"breach","atPct":100,"notify":"manager"}]
  escalation jsonb NOT NULL DEFAULT '[{"key":"warn","atPct":80,"notify":"dispatcher"},{"key":"breach","atPct":100,"notify":"manager"},{"key":"late50","atPct":150,"notify":"owner"}]'::jsonb
    CHECK (jsonb_typeof(escalation) = 'array' AND jsonb_array_length(escalation) <= 10),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, priority, kind)
);
CREATE INDEX IF NOT EXISTS idx_commercial_sla_policies_user ON commercial_sla_policies (user_id);
CREATE INDEX IF NOT EXISTS idx_commercial_sla_policies_calendar ON commercial_sla_policies (calendar_id);

CREATE OR REPLACE FUNCTION public.commercial_policy_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  s jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM commercial_contracts c WHERE c.id = NEW.contract_id AND c.user_id = NEW.user_id)
     OR NOT EXISTS (SELECT 1 FROM commercial_calendars k WHERE k.id = NEW.calendar_id AND k.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Contract and calendar must belong to this account' USING ERRCODE = '42501';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(NEW.escalation) LOOP
    IF (s ->> 'key') IS NULL OR (s ->> 'key') !~ '^[a-z][a-z0-9_]{0,30}$'
       OR (s ->> 'atPct') IS NULL OR (s ->> 'atPct') !~ '^\d{1,3}$' OR (s ->> 'atPct')::int > 500
       OR (s ->> 'notify') NOT IN ('dispatcher', 'manager', 'owner') THEN
      RAISE EXCEPTION 'Each escalation step needs key, atPct (0-500) and notify (dispatcher|manager|owner)' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_policy_guard ON commercial_sla_policies;
CREATE TRIGGER trg_commercial_policy_guard BEFORE INSERT OR UPDATE ON commercial_sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.commercial_policy_guard();

-- Config tables: reads for anyone on the account (pack enabled); writes for managers.
ALTER TABLE commercial_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_sla_policies ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_calendars', 'commercial_sla_policies'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON %1$s FOR SELECT TO authenticated USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()))', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()))', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE TO authenticated USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage())) WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()))', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_delete" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON %1$s FOR DELETE TO authenticated USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()))', t);
  END LOOP;
END $$;

-- =============================================================
-- 4. TIMERS, PAUSES, EVENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_sla_timers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES commercial_sla_policies(id) ON DELETE RESTRICT,
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  -- Cached result of the last sweep (display + indexing only; the pure clock is the source of truth)
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'at_risk', 'paused', 'breached', 'met', 'missed')),
  due_at timestamptz,
  pct_elapsed numeric(8,2),
  last_evaluated_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, policy_id),
  CONSTRAINT commercial_timer_stop_order CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);
-- Sweep + dashboard access paths (keyset by id keeps 1k+ active timers cheap).
CREATE INDEX IF NOT EXISTS idx_commercial_timers_active ON commercial_sla_timers (id) WHERE stopped_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_commercial_timers_user_state ON commercial_sla_timers (user_id, state) WHERE stopped_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_commercial_timers_contract ON commercial_sla_timers (contract_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_timers_site ON commercial_sla_timers (site_id) WHERE site_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commercial_sla_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  timer_id uuid NOT NULL REFERENCES commercial_sla_timers(id) ON DELETE CASCADE,
  paused_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 200),
  created_by uuid DEFAULT auth.uid(),
  CONSTRAINT commercial_pause_order CHECK (resumed_at IS NULL OR resumed_at > paused_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_pause_open ON commercial_sla_pauses (timer_id) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_commercial_pauses_timer ON commercial_sla_pauses (timer_id, paused_at);

CREATE TABLE IF NOT EXISTS commercial_sla_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  timer_id uuid NOT NULL REFERENCES commercial_sla_timers(id) ON DELETE CASCADE,
  site_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('started', 'paused', 'resumed', 'stopped', 'escalation', 'breach')),
  -- Set for escalation/breach: (timer, step) fires at most once, even if two sweeps overlap.
  step_key text CHECK (step_key IS NULL OR char_length(step_key) <= 40),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 4000),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_events_step ON commercial_sla_events (timer_id, step_key) WHERE step_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commercial_events_timer ON commercial_sla_events (timer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commercial_events_user ON commercial_sla_events (user_id, created_at DESC);

-- Append-only: nobody (including service role) may UPDATE an event. Rows go away only by cascade with their timer.
CREATE OR REPLACE FUNCTION public.commercial_block_update()
RETURNS trigger LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501'; END; $$;
DROP TRIGGER IF EXISTS trg_commercial_events_no_update ON commercial_sla_events;
CREATE TRIGGER trg_commercial_events_no_update BEFORE UPDATE ON commercial_sla_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_block_update();

ALTER TABLE commercial_sla_timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_sla_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_sla_events ENABLE ROW LEVEL SECURITY;
-- Reads only (writes go through the RPCs below). Site restrictions apply to every row tied to a site.
DROP POLICY IF EXISTS "commercial_timers_select" ON commercial_sla_timers;
CREATE POLICY "commercial_timers_select" ON commercial_sla_timers FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND ((SELECT public.is_account_owner()) OR public.commercial_site_visible(site_id)));
DROP POLICY IF EXISTS "commercial_pauses_select" ON commercial_sla_pauses;
CREATE POLICY "commercial_pauses_select" ON commercial_sla_pauses FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled())
         AND EXISTS (SELECT 1 FROM commercial_sla_timers t WHERE t.id = timer_id AND ((SELECT public.is_account_owner()) OR public.commercial_site_visible(t.site_id))));
DROP POLICY IF EXISTS "commercial_events_select" ON commercial_sla_events;
CREATE POLICY "commercial_events_select" ON commercial_sla_events FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND ((SELECT public.is_account_owner()) OR public.commercial_site_visible(site_id)));

-- ---- start (idempotent) ----
CREATE OR REPLACE FUNCTION public.commercial_timer_start(p_job_id uuid, p_policy_id uuid, p_started_at timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_policy commercial_sla_policies%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() THEN RAISE EXCEPTION 'pack_disabled' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.commercial_site_visible(v_job.site_id) THEN RAISE EXCEPTION 'site_not_permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_policy FROM commercial_sla_policies WHERE id = p_policy_id AND user_id = v_owner AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'policy_not_found' USING ERRCODE = 'P0002'; END IF;
  -- The job's customer must be the contract's customer (blocks attaching another customer's job).
  IF NOT EXISTS (SELECT 1 FROM commercial_contracts c WHERE c.id = v_policy.contract_id AND c.user_id = v_owner
                 AND (c.customer_id IS NULL OR c.customer_id = v_job.customer_id)) THEN
    RAISE EXCEPTION 'job_not_covered_by_contract' USING ERRCODE = '23514';
  END IF;

  INSERT INTO commercial_sla_timers (user_id, job_id, contract_id, policy_id, site_id, started_at)
  VALUES (v_owner, p_job_id, v_policy.contract_id, p_policy_id, v_job.site_id, COALESCE(p_started_at, now()))
  ON CONFLICT (job_id, policy_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM commercial_sla_timers WHERE job_id = p_job_id AND policy_id = p_policy_id;
    RETURN v_id;
  END IF;
  INSERT INTO commercial_sla_events (user_id, timer_id, site_id, event_type, actor_id) VALUES (v_owner, v_id, v_job.site_id, 'started', auth.uid());
  PERFORM public.log_audit_event(v_owner, 'commercial.sla_timer.start', 'commercial_sla_timers', v_id::text);
  RETURN v_id;
END;
$$;

-- ---- pause / resume / stop ----
CREATE OR REPLACE FUNCTION public.commercial_timer_transition(p_timer_id uuid, p_action text, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  t commercial_sla_timers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() THEN RAISE EXCEPTION 'pack_disabled' USING ERRCODE = '42501'; END IF;
  IF p_action NOT IN ('pause', 'resume', 'stop') THEN RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023'; END IF;
  SELECT * INTO t FROM commercial_sla_timers WHERE id = p_timer_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'timer_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.commercial_site_visible(t.site_id) THEN RAISE EXCEPTION 'site_not_permitted' USING ERRCODE = '42501'; END IF;
  IF t.stopped_at IS NOT NULL THEN RETURN; END IF; -- already stopped: idempotent no-op

  IF p_action = 'pause' THEN
    INSERT INTO commercial_sla_pauses (user_id, timer_id, reason) VALUES (v_owner, t.id, left(p_reason, 200))
    ON CONFLICT DO NOTHING; -- one open pause per timer (partial unique index)
    IF FOUND THEN
      INSERT INTO commercial_sla_events (user_id, timer_id, site_id, event_type, detail, actor_id)
      VALUES (v_owner, t.id, t.site_id, 'paused', jsonb_build_object('reason', left(p_reason, 200)), auth.uid());
    END IF;
  ELSIF p_action = 'resume' THEN
    UPDATE commercial_sla_pauses SET resumed_at = GREATEST(now(), paused_at + interval '1 millisecond')
     WHERE timer_id = t.id AND resumed_at IS NULL;
    IF FOUND THEN
      INSERT INTO commercial_sla_events (user_id, timer_id, site_id, event_type, actor_id) VALUES (v_owner, t.id, t.site_id, 'resumed', auth.uid());
    END IF;
  ELSE
    UPDATE commercial_sla_pauses SET resumed_at = GREATEST(now(), paused_at + interval '1 millisecond') WHERE timer_id = t.id AND resumed_at IS NULL;
    UPDATE commercial_sla_timers SET stopped_at = GREATEST(now(), started_at) WHERE id = t.id;
    INSERT INTO commercial_sla_events (user_id, timer_id, site_id, event_type, actor_id) VALUES (v_owner, t.id, t.site_id, 'stopped', auth.uid());
  END IF;
  PERFORM public.log_audit_event(v_owner, 'commercial.sla_timer.' || p_action, 'commercial_sla_timers', t.id::text);
END;
$$;

-- ---- sweep: read batch (service role only) ----
CREATE OR REPLACE FUNCTION public.commercial_sla_sweep_batch(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.timer_id), '[]'::jsonb) INTO v_out
  FROM (
    SELECT t.id AS timer_id, t.user_id, t.job_id, t.contract_id, t.site_id, t.started_at,
           p.kind, p.target_minutes, p.warn_at_pct, p.max_pause_minutes, p.escalation,
           jsonb_build_object('timeZone', k.time_zone, 'windows', k.windows, 'holidays', to_jsonb(k.holidays)) AS calendar,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('from', pa.paused_at, 'to', pa.resumed_at, 'reason', pa.reason) ORDER BY pa.paused_at)
                       FROM commercial_sla_pauses pa WHERE pa.timer_id = t.id), '[]'::jsonb) AS pauses,
           COALESCE((SELECT jsonb_agg(e.step_key) FROM commercial_sla_events e WHERE e.timer_id = t.id AND e.step_key IS NOT NULL), '[]'::jsonb) AS fired_keys
    FROM commercial_sla_timers t
    JOIN commercial_sla_policies p ON p.id = t.policy_id
    JOIN commercial_calendars k ON k.id = p.calendar_id
    WHERE t.stopped_at IS NULL
      AND (p_after IS NULL OR t.id > p_after)
      AND public.commercial_pack_enabled_for(t.user_id)
    ORDER BY t.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
  ) x;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_sla_sweep_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_sla_sweep_batch(uuid, integer) TO service_role;

-- ---- sweep: apply results (service role only; idempotent) ----
-- p_results: [{timer_id, state, due_at, pct_elapsed, over_minutes, fired:[{key, notify, at_pct}]}]
CREATE OR REPLACE FUNCTION public.commercial_sla_apply(p_results jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r jsonb;
  f jsonb;
  t commercial_sla_timers%ROWTYPE;
  v_kind text;
  v_inserted uuid;
  v_updated integer := 0;
  v_events integer := 0;
  v_breaches integer := 0;
BEGIN
  IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 500 THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    SELECT * INTO t FROM commercial_sla_timers WHERE id = (r ->> 'timer_id')::uuid FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR t.stopped_at IS NOT NULL OR NOT public.commercial_pack_enabled_for(t.user_id);
    IF (r ->> 'state') NOT IN ('running', 'at_risk', 'paused', 'breached') THEN CONTINUE; END IF;

    UPDATE commercial_sla_timers
       SET state = r ->> 'state', due_at = NULLIF(r ->> 'due_at', '')::timestamptz,
           pct_elapsed = LEAST(NULLIF(r ->> 'pct_elapsed', '')::numeric, 999999), last_evaluated_at = now()
     WHERE id = t.id;
    v_updated := v_updated + 1;

    SELECT p.kind INTO v_kind FROM commercial_sla_policies p WHERE p.id = t.policy_id;

    FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(r -> 'fired', '[]'::jsonb)) LOOP
      v_inserted := NULL;
      INSERT INTO commercial_sla_events (user_id, timer_id, site_id, event_type, step_key, detail)
      VALUES (t.user_id, t.id, t.site_id, 'escalation', left(f ->> 'key', 40),
              jsonb_build_object('notify', f ->> 'notify', 'at_pct', f ->> 'at_pct', 'pct_elapsed', r ->> 'pct_elapsed'))
      ON CONFLICT (timer_id, step_key) WHERE step_key IS NOT NULL DO NOTHING
      RETURNING id INTO v_inserted;
      CONTINUE WHEN v_inserted IS NULL; -- already fired by an earlier / overlapping sweep
      v_events := v_events + 1;
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (t.user_id, 'sla_escalation',
              CASE WHEN (f ->> 'at_pct')::numeric >= 100 THEN 'SLA breached' ELSE 'SLA at risk' END,
              format('A %s SLA timer reached %s%% (notify %s).', v_kind, round((r ->> 'pct_elapsed')::numeric), f ->> 'notify'),
              '/dashboard/commercial');
    END LOOP;

    -- One breach row per timer, written exactly once (guarded by the unique step 'breach').
    IF (r ->> 'state') = 'breached' THEN
      v_inserted := NULL;
      INSERT INTO commercial_sla_events (user_id, timer_id, site_id, event_type, step_key, detail)
      VALUES (t.user_id, t.id, t.site_id, 'breach', 'breach_record', jsonb_build_object('over_minutes', r ->> 'over_minutes'))
      ON CONFLICT (timer_id, step_key) WHERE step_key IS NOT NULL DO NOTHING
      RETURNING id INTO v_inserted;
      IF v_inserted IS NOT NULL THEN
        INSERT INTO contract_sla_breaches (user_id, contract_id, job_id, breach_type, severity, expected_at, actual_at, minutes_over, notes)
        VALUES (t.user_id, t.contract_id, t.job_id,
                CASE WHEN v_kind = 'resolution' THEN 'resolution_time' ELSE 'response_time' END,
                CASE WHEN COALESCE((r ->> 'over_minutes')::numeric, 0) >= 480 THEN 'critical' WHEN COALESCE((r ->> 'over_minutes')::numeric, 0) >= 60 THEN 'major' ELSE 'minor' END,
                NULLIF(r ->> 'due_at', '')::timestamptz, now(), LEAST(round(COALESCE((r ->> 'over_minutes')::numeric, 0)), 2000000000)::int,
                'Recorded by the commercial SLA clock (business-hours basis).');
        v_breaches := v_breaches + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('updated', v_updated, 'events', v_events, 'breaches', v_breaches);
END;
$$;
REVOKE ALL ON FUNCTION public.commercial_sla_apply(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_sla_apply(jsonb) TO service_role;

-- =============================================================
-- 5. SETTINGS, NET TERMS, CONSOLIDATED STATEMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  approval_tiers jsonb NOT NULL DEFAULT '[{"upToCents":250000,"steps":["manager"]},{"upToCents":null,"steps":["manager","owner"]}]'::jsonb
    CHECK (jsonb_typeof(approval_tiers) = 'array' AND jsonb_array_length(approval_tiers) BETWEEN 1 AND 6),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commercial_customer_billing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  terms_kind text NOT NULL DEFAULT 'net' CHECK (terms_kind IN ('due_on_receipt', 'net', 'net_eom')),
  terms_days integer NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 180),
  cadence text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('per_invoice', 'weekly', 'monthly')),
  split_by_site boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id)
);

CREATE TABLE IF NOT EXISTS commercial_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  -- Deterministic: customer|period_start|site — re-running a period can never create a second statement.
  key text NOT NULL CHECK (char_length(key) <= 200),
  period_start date NOT NULL,
  period_end date NOT NULL,
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  issue_on date NOT NULL,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued')),
  issued_at timestamptz,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key),
  CONSTRAINT commercial_statement_period CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_commercial_statements_customer ON commercial_statements (user_id, customer_id, period_start DESC);

CREATE TABLE IF NOT EXISTS commercial_statement_items (
  statement_id uuid NOT NULL REFERENCES commercial_statements(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  PRIMARY KEY (statement_id, invoice_id),
  UNIQUE (invoice_id) -- an invoice can sit on one statement only
);

-- Issued statements are immutable.
CREATE OR REPLACE FUNCTION public.commercial_statement_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE v_status text;
BEGIN
  IF TG_TABLE_NAME = 'commercial_statements' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status = 'issued' THEN RAISE EXCEPTION 'An issued statement cannot be deleted' USING ERRCODE = '42501'; END IF;
      RETURN OLD;
    END IF;
    IF OLD.status = 'issued' AND (NEW.total_cents <> OLD.total_cents OR NEW.status <> 'issued' OR NEW.due_on <> OLD.due_on OR NEW.key <> OLD.key) THEN
      RAISE EXCEPTION 'An issued statement cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO v_status FROM commercial_statements WHERE id = OLD.statement_id;
    IF v_status = 'issued' THEN RAISE EXCEPTION 'An issued statement cannot be changed' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO v_status FROM commercial_statements WHERE id = NEW.statement_id;
  IF v_status = 'issued' THEN RAISE EXCEPTION 'An issued statement cannot be changed' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_commercial_statements_immutable ON commercial_statements;
CREATE TRIGGER trg_commercial_statements_immutable BEFORE UPDATE OR DELETE ON commercial_statements
  FOR EACH ROW EXECUTE FUNCTION public.commercial_statement_immutable();
DROP TRIGGER IF EXISTS trg_commercial_statement_items_immutable ON commercial_statement_items;
CREATE TRIGGER trg_commercial_statement_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON commercial_statement_items
  FOR EACH ROW EXECUTE FUNCTION public.commercial_statement_immutable();

ALTER TABLE commercial_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_customer_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_statement_items ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_settings', 'commercial_customer_billing'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON %1$s FOR SELECT TO authenticated USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()))', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()))', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON %1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE TO authenticated USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage())) WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_can_manage()))', t);
  END LOOP;
END $$;

-- Billing data: same gate as work orders / invoices (billing permission), read-only from the client.
DROP POLICY IF EXISTS "commercial_statements_select" ON commercial_statements;
CREATE POLICY "commercial_statements_select" ON commercial_statements FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND (SELECT public.can_manage_work_orders()));
DROP POLICY IF EXISTS "commercial_statement_items_select" ON commercial_statement_items;
CREATE POLICY "commercial_statement_items_select" ON commercial_statement_items FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND (SELECT public.can_manage_work_orders()));

CREATE OR REPLACE FUNCTION public.commercial_generate_statements(p_customer_id uuid, p_period_start date, p_period_end date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_bill commercial_customer_billing%ROWTYPE;
  v_stmt commercial_statements%ROWTYPE;
  v_key text;
  v_due date;
  inv record;
  v_total bigint;
  v_attached integer := 0;
  v_skipped integer := 0;
  v_statements integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() THEN RAISE EXCEPTION 'pack_disabled' USING ERRCODE = '42501'; END IF;
  IF NOT public.can_manage_work_orders() THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  IF p_period_end < p_period_start OR p_period_end - p_period_start > 366 THEN RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = p_customer_id AND c.user_id = v_owner) THEN
    RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':stmt:' || p_customer_id::text, 0));
  SELECT * INTO v_bill FROM commercial_customer_billing WHERE user_id = v_owner AND customer_id = p_customer_id;
  IF NOT FOUND THEN v_bill.terms_kind := 'net'; v_bill.terms_days := 30; v_bill.split_by_site := false; END IF;

  FOR inv IN
    SELECT i.id, i.line_items, i.tax_percent, j.site_id
      FROM invoices i
      JOIN jobs j ON j.id = i.job_id AND j.user_id = v_owner
     WHERE i.user_id = v_owner AND j.customer_id = p_customer_id
       AND i.status IN ('sent', 'viewed')
       AND COALESCE(i.sent_at::date, i.created_at::date) BETWEEN p_period_start AND p_period_end
       AND NOT EXISTS (SELECT 1 FROM commercial_statement_items si WHERE si.invoice_id = i.id)
       AND (public.commercial_site_visible(j.site_id))
     ORDER BY i.created_at, i.id
  LOOP
    v_total := public.portal_invoice_total_cents(inv.line_items, inv.tax_percent);
    IF v_total IS NULL OR v_total < 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
    v_key := p_customer_id::text || '|' || p_period_start::text || '|' || CASE WHEN v_bill.split_by_site THEN COALESCE(inv.site_id::text, '-') ELSE '-' END;
    v_due := CASE v_bill.terms_kind
      WHEN 'due_on_receipt' THEN p_period_end
      WHEN 'net' THEN p_period_end + v_bill.terms_days
      ELSE ((date_trunc('month', p_period_end)::date + interval '1 month')::date - 1) + v_bill.terms_days END;

    SELECT * INTO v_stmt FROM commercial_statements WHERE user_id = v_owner AND key = v_key FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO commercial_statements (user_id, customer_id, site_id, key, period_start, period_end, issue_on, due_on)
      VALUES (v_owner, p_customer_id, CASE WHEN v_bill.split_by_site THEN inv.site_id END, v_key, p_period_start, p_period_end, p_period_end, v_due)
      RETURNING * INTO v_stmt;
      v_statements := v_statements + 1;
    ELSIF v_stmt.status = 'issued' THEN
      v_skipped := v_skipped + 1; -- issued statements are immutable; this invoice waits for the next period
      CONTINUE;
    END IF;
    INSERT INTO commercial_statement_items (statement_id, invoice_id, user_id, total_cents) VALUES (v_stmt.id, inv.id, v_owner, v_total);
    UPDATE commercial_statements SET total_cents = total_cents + v_total WHERE id = v_stmt.id;
    v_attached := v_attached + 1;
  END LOOP;

  IF v_attached > 0 THEN
    PERFORM public.log_audit_event(v_owner, 'commercial.statements.generate', 'customers', p_customer_id::text,
      jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'invoices', v_attached));
  END IF;
  RETURN jsonb_build_object('statements_created', v_statements, 'invoices_attached', v_attached, 'invoices_skipped', v_skipped);
END;
$$;

CREATE OR REPLACE FUNCTION public.commercial_issue_statement(p_statement_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() OR NOT public.can_manage_work_orders() THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  UPDATE commercial_statements SET status = 'issued', issued_at = now(), issued_by = auth.uid()
   WHERE id = p_statement_id AND user_id = v_owner AND status = 'draft';
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM commercial_statements WHERE id = p_statement_id AND user_id = v_owner AND status = 'issued') THEN RETURN; END IF;
    RAISE EXCEPTION 'statement_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'commercial.statement.issue', 'commercial_statements', p_statement_id::text);
END;
$$;

-- =============================================================
-- 6. WORK-ORDER APPROVAL WORKFLOW (PO / NTE aware)
-- =============================================================
CREATE TABLE IF NOT EXISTS commercial_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  required_steps text[] NOT NULL CHECK (cardinality(required_steps) BETWEEN 1 AND 3 AND required_steps <@ ARRAY['manager', 'owner']::text[]),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_approval_open ON commercial_approval_requests (work_order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_commercial_approvals_user ON commercial_approval_requests (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS commercial_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES commercial_approval_requests(id) ON DELETE CASCADE,
  step_index integer NOT NULL CHECK (step_index >= 0),
  role text NOT NULL CHECK (role IN ('manager', 'owner')),
  decided_by uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, step_index) -- two people can never decide the same step
);
DROP TRIGGER IF EXISTS trg_commercial_decisions_no_update ON commercial_approval_decisions;
CREATE TRIGGER trg_commercial_decisions_no_update BEFORE UPDATE ON commercial_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION public.commercial_block_update();

ALTER TABLE commercial_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_approval_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "commercial_approvals_select" ON commercial_approval_requests;
CREATE POLICY "commercial_approvals_select" ON commercial_approval_requests FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND (SELECT public.can_manage_work_orders()));
DROP POLICY IF EXISTS "commercial_decisions_select" ON commercial_approval_decisions;
CREATE POLICY "commercial_decisions_select" ON commercial_approval_decisions FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.commercial_pack_enabled()) AND (SELECT public.can_manage_work_orders()));

CREATE OR REPLACE FUNCTION public.commercial_request_approval(p_work_order_id uuid, p_amount_cents integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  wo work_orders%ROWTYPE;
  v_tiers jsonb;
  v_steps text[];
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() OR NOT public.can_manage_work_orders() THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  IF p_amount_cents IS NULL OR p_amount_cents < 0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023'; END IF;
  SELECT * INTO wo FROM work_orders WHERE id = p_work_order_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work_order_not_found' USING ERRCODE = 'P0002'; END IF;
  IF wo.status IN ('in_progress', 'completed') THEN RAISE EXCEPTION 'work_order_already_started' USING ERRCODE = '23514'; END IF;
  IF wo.not_to_exceed_cents IS NOT NULL AND p_amount_cents > wo.not_to_exceed_cents THEN
    RAISE EXCEPTION 'amount_exceeds_nte' USING ERRCODE = '23514';
  END IF;

  SELECT id INTO v_id FROM commercial_approval_requests WHERE work_order_id = wo.id AND status = 'pending';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF; -- idempotent

  SELECT COALESCE((SELECT approval_tiers FROM commercial_settings WHERE user_id = v_owner),
                  '[{"upToCents":250000,"steps":["manager"]},{"upToCents":null,"steps":["manager","owner"]}]'::jsonb)
    INTO v_tiers;
  SELECT ARRAY(SELECT jsonb_array_elements_text(t.value -> 'steps')) INTO v_steps
    FROM jsonb_array_elements(v_tiers) WITH ORDINALITY AS t(value, ord)
   WHERE (t.value ->> 'upToCents') IS NULL OR p_amount_cents <= (t.value ->> 'upToCents')::bigint
   ORDER BY t.ord LIMIT 1;
  IF v_steps IS NULL OR cardinality(v_steps) = 0 THEN RAISE EXCEPTION 'no_approval_tier' USING ERRCODE = '22023'; END IF;

  INSERT INTO commercial_approval_requests (user_id, work_order_id, amount_cents, required_steps)
  VALUES (v_owner, wo.id, p_amount_cents, v_steps) RETURNING id INTO v_id;
  UPDATE work_orders SET approval_status = 'pending' WHERE id = wo.id AND approval_status <> 'pending';
  PERFORM public.log_audit_event(v_owner, 'commercial.approval.request', 'work_orders', wo.id::text,
    jsonb_build_object('amount_cents', p_amount_cents, 'steps', v_steps, 'po_number', wo.po_number));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.commercial_decide_approval(p_request_id uuid, p_decision text, p_comment text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public.commercial_approver_role();
  rq commercial_approval_requests%ROWTYPE;
  v_step integer;
  v_need text;
  v_email text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() OR v_role IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'invalid_decision' USING ERRCODE = '22023'; END IF;
  SELECT * INTO rq FROM commercial_approval_requests WHERE id = p_request_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF rq.status <> 'pending' THEN RAISE EXCEPTION 'not_pending' USING ERRCODE = '23514'; END IF;
  IF rq.requested_by = auth.uid() THEN RAISE EXCEPTION 'self_approval_not_allowed' USING ERRCODE = '42501'; END IF;

  SELECT count(*)::int INTO v_step FROM commercial_approval_decisions WHERE request_id = rq.id;
  v_need := rq.required_steps[v_step + 1];
  IF v_need = 'owner' AND v_role <> 'owner' THEN RAISE EXCEPTION 'insufficient_role' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM commercial_approval_decisions WHERE request_id = rq.id AND decided_by = auth.uid()) THEN
    RAISE EXCEPTION 'already_decided' USING ERRCODE = '23514';
  END IF;

  INSERT INTO commercial_approval_decisions (user_id, request_id, step_index, role, decided_by, decision, comment)
  VALUES (v_owner, rq.id, v_step, v_need, auth.uid(), p_decision, left(p_comment, 1000));
  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

  IF p_decision = 'reject' THEN
    UPDATE commercial_approval_requests SET status = 'rejected', decided_at = now() WHERE id = rq.id;
    UPDATE work_orders SET approval_status = 'rejected', approver_name = v_email, approval_notes = left(p_comment, 1000) WHERE id = rq.work_order_id AND user_id = v_owner;
    PERFORM public.log_audit_event(v_owner, 'commercial.approval.reject', 'work_orders', rq.work_order_id::text);
    RETURN 'rejected';
  END IF;
  IF v_step + 1 >= cardinality(rq.required_steps) THEN
    UPDATE commercial_approval_requests SET status = 'approved', decided_at = now() WHERE id = rq.id;
    UPDATE work_orders SET approval_status = 'approved', approver_name = v_email, approval_notes = left(p_comment, 1000) WHERE id = rq.work_order_id AND user_id = v_owner;
    PERFORM public.log_audit_event(v_owner, 'commercial.approval.approve', 'work_orders', rq.work_order_id::text);
    RETURN 'approved';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'commercial.approval.step', 'work_orders', rq.work_order_id::text);
  RETURN 'pending';
END;
$$;

-- =============================================================
-- 7. COVERAGE INPUTS + PM DUE LIST (verdict = coverage.ts, single source of truth)
-- =============================================================
CREATE OR REPLACE FUNCTION public.commercial_coverage_inputs(p_contract_id uuid, p_on_date date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c commercial_contracts%ROWTYPE;
  v_start date;
  v_ent jsonb := '[]'::jsonb;
  e record;
  v_step integer;
  v_months integer;
  v_ws date;
  v_we date;
  v_used numeric;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.commercial_pack_enabled() OR NOT public.can_manage_work_orders() THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM commercial_contracts WHERE id = p_contract_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found' USING ERRCODE = 'P0002'; END IF;
  v_start := COALESCE(c.start_date, date_trunc('year', p_on_date)::date);

  FOR e IN SELECT * FROM agreement_entitlements WHERE contract_id = c.id AND user_id = v_owner LOOP
    IF e.period = 'term' THEN
      v_ws := v_start; v_we := COALESCE(c.end_date + 1, (v_start + interval '12 months')::date);
    ELSE
      v_step := CASE e.period WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 ELSE 12 END;
      -- Anniversary-based windows (restart on the contract start date), as serviceAgreement.periodWindow().
      v_months := GREATEST(0, (extract(year FROM age(p_on_date, v_start)) * 12 + extract(month FROM age(p_on_date, v_start)))::int);
      v_months := (v_months / v_step) * v_step;
      v_ws := (v_start + make_interval(months => v_months))::date;
      v_we := (v_start + make_interval(months => v_months + v_step))::date;
    END IF;
    SELECT COALESCE(sum(v.quantity), 0) INTO v_used FROM agreement_visits v
     WHERE v.contract_id = c.id AND v.user_id = v_owner AND v.entitlement_kind = e.kind AND v.status = 'completed'
       AND v.visit_date >= v_ws AND v.visit_date < v_we;
    v_ent := v_ent || jsonb_build_array(jsonb_build_object('kind', e.kind, 'included', e.included_quantity, 'used', v_used, 'overageRateCents', e.overage_rate_cents));
  END LOOP;

  RETURN jsonb_build_object(
    'contract', jsonb_build_object('status', c.status, 'startDate', c.start_date, 'endDate', c.end_date),
    'assets', COALESCE((SELECT jsonb_agg(jsonb_build_object('siteId', a.site_id, 'equipmentId', a.equipment_id, 'level', a.coverage_level))
                          FROM agreement_assets a WHERE a.contract_id = c.id AND a.user_id = v_owner), '[]'::jsonb),
    'entitlements', v_ent);
END;
$$;

-- PM plans due soon (keyset pagination; uses idx_agreement_pm_plans_due). Per-asset PM is agreement_pm_plans.equipment_id.
CREATE OR REPLACE FUNCTION public.commercial_pm_due(p_within_days integer DEFAULT 30, p_limit integer DEFAULT 100, p_after_date date DEFAULT NULL, p_after_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, contract_id uuid, name text, site_id uuid, equipment_id uuid, next_due_date date, days_until integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.contract_id, p.name, p.site_id, p.equipment_id, p.next_due_date, (p.next_due_date - current_date)::int
    FROM agreement_pm_plans p
   WHERE p.user_id = public.get_account_owner_id() AND public.commercial_pack_enabled() AND p.active
     AND p.next_due_date IS NOT NULL AND p.next_due_date <= current_date + LEAST(GREATEST(COALESCE(p_within_days, 30), 0), 365)
     AND public.commercial_site_visible(p.site_id)
     AND (p_after_date IS NULL OR (p.next_due_date, p.id) > (p_after_date, p_after_id))
   ORDER BY p.next_due_date, p.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

-- =============================================================
-- 8. CUSTOMER PORTAL: SITE + ASSET HISTORY (token auth, same model as get_customer_portal_history)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_commercial_portal_site_history(p_token uuid, p_site_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_enabled boolean;
  v_sites jsonb;
  v_assets jsonb;
  v_jobs jsonb;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(bp.allow_customer_portal, false) INTO v_enabled FROM profiles p LEFT JOIN business_profile bp ON bp.user_id = p.id WHERE p.id = v_customer.user_id;
  -- Same NULL for bad token, portal off, or pack off: callers cannot tell them apart.
  IF NOT COALESCE(v_enabled, false) OR NOT public.commercial_pack_enabled_for(v_customer.user_id) THEN RETURN NULL; END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_sites s WHERE s.id = p_site_id AND s.customer_id = v_customer.id AND s.user_id = v_customer.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'address', s.address, 'city', s.city, 'state', s.state) ORDER BY s.name), '[]'::jsonb)
    INTO v_sites FROM customer_sites s WHERE s.customer_id = v_customer.id AND s.user_id = v_customer.user_id;

  IF p_site_id IS NULL THEN
    RETURN jsonb_build_object('sites', v_sites, 'assets', '[]'::jsonb, 'jobs', '[]'::jsonb);
  END IF;

  -- Assets located inside the site's buildings/floors/rooms. Serial numbers, costs and internal notes are NOT exposed.
  SELECT COALESCE(jsonb_agg(a ORDER BY a.equipment_type, a.id), '[]'::jsonb) INTO v_assets FROM (
    SELECT e.id, e.equipment_type, e.make, e.model, e.install_date, e.status,
           (SELECT max(v.visit_date) FROM agreement_visits v JOIN agreement_pm_plans pp ON pp.id = v.pm_plan_id WHERE pp.equipment_id = e.id AND v.status = 'completed') AS last_pm_visit
      FROM equipment e
      JOIN customer_site_rooms r ON r.id = e.room_id
      JOIN customer_site_floors f ON f.id = r.floor_id
      JOIN customer_site_buildings b ON b.id = f.building_id
     WHERE e.customer_id = v_customer.id AND e.user_id = v_customer.user_id AND e.status <> 'removed' AND b.site_id = p_site_id
     ORDER BY e.equipment_type, e.id LIMIT 500
  ) a;

  SELECT COALESCE(jsonb_agg(jj ORDER BY jj.scheduled_datetime DESC NULLS LAST), '[]'::jsonb) INTO v_jobs FROM (
    SELECT j.id, j.service_type, j.scheduled_datetime, j.job_status
      FROM jobs j WHERE j.user_id = v_customer.user_id AND j.customer_id = v_customer.id AND j.site_id = p_site_id
     ORDER BY j.scheduled_datetime DESC NULLS LAST, j.id LIMIT 50
  ) jj;

  RETURN jsonb_build_object('sites', v_sites, 'assets', v_assets, 'jobs', v_jobs);
END;
$$;

-- =============================================================
-- 9. GRANTS (authenticated RPCs; everything else stays service-role only)
-- =============================================================
REVOKE ALL ON FUNCTION public.commercial_timer_start(uuid, uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_timer_transition(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_generate_statements(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_issue_statement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_request_approval(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_decide_approval(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_coverage_inputs(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commercial_pm_due(integer, integer, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commercial_timer_start(uuid, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_timer_transition(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_generate_statements(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_issue_statement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_request_approval(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_decide_approval(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_coverage_inputs(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commercial_pm_due(integer, integer, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_commercial_portal_site_history(uuid, uuid) TO anon, authenticated;
