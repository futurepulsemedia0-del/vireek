/*
  # Vireek Verified Service — Service Outcome Guarantee (post-completion)

  ## Why
  Outcome Assurance (20270105000000) predicts BEFORE dispatch whether a job will be
  fixed on the first visit. This migration closes the loop AFTER the job is
  completed: "Was the problem actually solved?"

    job completed -> 48h check -> 7-day check -> 30-day check -> Verified
                                       |
                              failure detected / reported
                                       |
        notify customer -> check warranty + parts -> attach root cause
                -> owner approves re-dispatch -> recovery visit -> Recovered

  ## Honesty rules (same philosophy as the rest of Vireek)
  - A checkpoint passes ONLY with recorded evidence:
      customer_confirmed  = the customer answered "solved"
      no_failure_signal   = customer was asked, stayed silent for 24h, and no
                            rework / dispute / low rating exists for the job
    The two are never merged: the public page shows which one it was.
  - Nothing is re-dispatched automatically. The owner approves the recovery visit.
  - Events are append-only evidence (UPDATE blocked).

  ## Tables
  service_guarantee_settings     per-account switch + coverage window (opt-in, default OFF)
  service_guarantees             one per completed job
  service_guarantee_checkpoints  h48 / d7 / d30 per guarantee
  service_guarantee_claims       failures (customer, staff, rework job, dispute, low rating)
  service_guarantee_events       append-only ledger
  service_guarantee_messages     outbox for customer SMS (sent by the edge function)

  ## Access
  Reads: RLS (account scope). Writes: only SECURITY DEFINER functions below.
  Customer: token-gated (jobs.reschedule_token) RPCs, display-safe fields only.
  Cron: run_service_guarantee_tick() + message outbox, service_role only.

  Depends on: jobs (completed_at, customer_phone, customer_id, site_id, duration_minutes,
  notes, is_rework, rework_of_job_id, customer_disputed, reschedule_token), team_members,
  profiles, notifications, equipment, warranty_claims, job_outcomes, review_requests,
  public.get_account_owner_id().

  Additive only: no existing table, column or policy is modified or dropped.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS service_guarantee_settings (
  user_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  coverage_days integer NOT NULL DEFAULT 30 CHECK (coverage_days BETWEEN 30 AND 365),
  notify_customer boolean NOT NULL DEFAULT true,
  notify_owner_on_failure boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_guarantees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  customer_name text NOT NULL DEFAULT '',
  customer_phone text,
  service_type text,
  status text NOT NULL DEFAULT 'verifying'
    CHECK (status IN ('verifying', 'verified', 'claim_open', 'recovering', 'recovered', 'expired', 'voided')),
  evidence_level text NOT NULL DEFAULT 'none'
    CHECK (evidence_level IN ('none', 'no_failure_signal', 'customer_confirmed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  last_checkpoint text CHECK (last_checkpoint IS NULL OR last_checkpoint IN ('h48', 'd7', 'd30')),
  recovered_by_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  /* Forward hook for warranty / insurance / financing products. Unused today. */
  coverage_cap_cents integer CHECK (coverage_cap_cents IS NULL OR coverage_cap_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_guarantees_user ON service_guarantees(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_guarantees_status ON service_guarantees(status, expires_at);

CREATE TABLE IF NOT EXISTS service_guarantee_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  guarantee_id uuid NOT NULL REFERENCES service_guarantees(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('h48', 'd7', 'd30')),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'voided')),
  evidence text CHECK (evidence IS NULL OR evidence IN ('customer_confirmed', 'no_failure_signal', 'failure_reported')),
  prompted_at timestamptz,
  customer_response text CHECK (customer_response IS NULL OR customer_response IN ('solved', 'not_solved')),
  customer_note text CHECK (customer_note IS NULL OR char_length(customer_note) <= 500),
  responded_at timestamptz,
  checked_at timestamptz,
  UNIQUE (guarantee_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_service_guarantee_checkpoints_due
  ON service_guarantee_checkpoints(due_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS service_guarantee_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  guarantee_id uuid NOT NULL REFERENCES service_guarantees(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('customer', 'staff', 'callback_job', 'dispute', 'low_rating')),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'redispatched', 'resolved', 'rejected')),
  warranty_check jsonb NOT NULL DEFAULT '{}'::jsonb,
  parts_check jsonb NOT NULL DEFAULT '{}'::jsonb,
  root_cause_key text,
  proposed_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  redispatch_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  escalated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- At most one live claim per guarantee: makes concurrent triggers / double clicks idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_guarantee_one_live_claim
  ON service_guarantee_claims(guarantee_id) WHERE status IN ('open', 'redispatched');
CREATE INDEX IF NOT EXISTS idx_service_guarantee_claims_user ON service_guarantee_claims(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_guarantee_claims_redispatch ON service_guarantee_claims(redispatch_job_id)
  WHERE redispatch_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_guarantee_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  guarantee_id uuid NOT NULL REFERENCES service_guarantees(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'checkpoint_prompted', 'checkpoint_passed', 'checkpoint_failed', 'claim_opened',
    'warranty_checked', 'claim_escalated', 'redispatch_created', 'claim_rejected', 'claim_resolved',
    'recovered', 'verified', 'expired', 'voided'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 500),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system', 'customer', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_guarantee_events_guarantee
  ON service_guarantee_events(guarantee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS service_guarantee_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  guarantee_id uuid NOT NULL REFERENCES service_guarantees(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('checkpoint_prompt', 'claim_received', 'recovery_scheduled', 'recovery_done', 'verified')),
  stage text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (guarantee_id, kind, stage)
);

CREATE INDEX IF NOT EXISTS idx_service_guarantee_messages_pending
  ON service_guarantee_messages(created_at) WHERE status IN ('pending', 'sending');

-- =============================================================
-- RLS — read-only for clients
-- =============================================================

ALTER TABLE service_guarantee_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_guarantees ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_guarantee_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_guarantee_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_guarantee_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_guarantee_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_guarantee_settings" ON service_guarantee_settings;
CREATE POLICY "select_own_service_guarantee_settings" ON service_guarantee_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_service_guarantees" ON service_guarantees;
CREATE POLICY "select_own_service_guarantees" ON service_guarantees
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_service_guarantee_checkpoints" ON service_guarantee_checkpoints;
CREATE POLICY "select_own_service_guarantee_checkpoints" ON service_guarantee_checkpoints
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_service_guarantee_claims" ON service_guarantee_claims;
CREATE POLICY "select_own_service_guarantee_claims" ON service_guarantee_claims
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_service_guarantee_events" ON service_guarantee_events;
CREATE POLICY "select_own_service_guarantee_events" ON service_guarantee_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_service_guarantee_messages" ON service_guarantee_messages;
CREATE POLICY "select_own_service_guarantee_messages" ON service_guarantee_messages
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Evidence ledger: rows can only be appended.
CREATE OR REPLACE FUNCTION public._sg_prevent_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_guarantee_events_immutable ON service_guarantee_events;
CREATE TRIGGER trg_service_guarantee_events_immutable
  BEFORE UPDATE ON service_guarantee_events
  FOR EACH ROW EXECUTE FUNCTION public._sg_prevent_update();

-- =============================================================
-- INTERNAL HELPERS (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._sg_log(
  p_guarantee uuid, p_user uuid, p_type text, p_detail text,
  p_data jsonb DEFAULT '{}'::jsonb, p_actor text DEFAULT 'system'
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO service_guarantee_events (user_id, guarantee_id, event_type, detail, data, actor_type)
  VALUES (p_user, p_guarantee, p_type, left(p_detail, 500), COALESCE(p_data, '{}'::jsonb), p_actor);
$$;

/* Queue a customer SMS. Skipped silently when the account turned messaging off or no phone exists. */
CREATE OR REPLACE FUNCTION public._sg_enqueue(p_guarantee uuid, p_user uuid, p_kind text, p_stage text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notify boolean;
  v_phone text;
BEGIN
  SELECT COALESCE((SELECT s.notify_customer FROM service_guarantee_settings s WHERE s.user_id = p_user), true)
  INTO v_notify;
  IF NOT v_notify THEN
    RETURN;
  END IF;
  SELECT g.customer_phone INTO v_phone FROM service_guarantees g WHERE g.id = p_guarantee;
  IF v_phone IS NULL OR btrim(v_phone) = '' THEN
    RETURN;
  END IF;
  INSERT INTO service_guarantee_messages (user_id, guarantee_id, kind, stage)
  VALUES (p_user, p_guarantee, p_kind, COALESCE(p_stage, ''))
  ON CONFLICT (guarantee_id, kind, stage) DO NOTHING;
END;
$$;

/* When every checkpoint passed, the guarantee becomes Verified (once). */
CREATE OR REPLACE FUNCTION public._sg_recompute(p_guarantee uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g service_guarantees%ROWTYPE;
BEGIN
  SELECT * INTO g FROM service_guarantees WHERE id = p_guarantee FOR UPDATE;
  IF NOT FOUND OR g.status <> 'verifying' THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM service_guarantee_checkpoints c WHERE c.guarantee_id = p_guarantee AND c.status <> 'passed') THEN
    RETURN;
  END IF;
  UPDATE service_guarantees SET status = 'verified', verified_at = now(), updated_at = now() WHERE id = p_guarantee;
  PERFORM public._sg_log(p_guarantee, g.user_id, 'verified', 'All checkpoints passed. Outcome verified.');
  PERFORM public._sg_enqueue(p_guarantee, g.user_id, 'verified', '');
END;
$$;

/*
  Opens (or returns) the live claim for a guarantee and performs the automatic response:
  warranty + parts check, root cause carried from the recorded outcome, owner alert,
  customer acknowledgement. Returns NULL when the guarantee cannot take a claim.
*/
CREATE OR REPLACE FUNCTION public._sg_open_claim(p_guarantee uuid, p_source text, p_description text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g service_guarantees%ROWTYPE;
  v_claim uuid;
  v_parts jsonb;
  v_root text;
  v_warranty jsonb;
  v_notify_owner boolean;
BEGIN
  SELECT * INTO g FROM service_guarantees WHERE id = p_guarantee FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT c.id INTO v_claim FROM service_guarantee_claims c
  WHERE c.guarantee_id = p_guarantee AND c.status IN ('open', 'redispatched') LIMIT 1;
  IF v_claim IS NOT NULL THEN
    RETURN v_claim;
  END IF;

  IF g.status NOT IN ('verifying', 'verified') OR now() >= g.expires_at THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object('parts_used', to_jsonb(o.parts_used), 'resolution', o.resolution), o.root_cause_key
  INTO v_parts, v_root
  FROM job_outcomes o WHERE o.job_id = g.job_id;
  v_parts := COALESCE(v_parts, '{}'::jsonb);

  SELECT jsonb_build_object(
    'workmanship_days_left', GREATEST(0, ceil(extract(epoch FROM (g.expires_at - now())) / 86400))::int,
    'manufacturer_claims', (SELECT count(*) FROM warranty_claims w WHERE w.job_id = g.job_id),
    'equipment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'type', e.equipment_type, 'make', e.make, 'model', e.model,
        'warranty_expires_at', e.warranty_expires_at,
        'in_warranty', (e.warranty_expires_at IS NOT NULL AND e.warranty_expires_at >= current_date)
      ))
      FROM (
        SELECT * FROM equipment q
        WHERE q.customer_id = j.customer_id AND q.status = 'active'
        ORDER BY q.created_at DESC LIMIT 10
      ) e
    ), '[]'::jsonb)
  )
  INTO v_warranty
  FROM jobs j WHERE j.id = g.job_id;
  v_warranty := COALESCE(v_warranty, '{}'::jsonb);

  INSERT INTO service_guarantee_claims (user_id, guarantee_id, job_id, source, description, warranty_check, parts_check, root_cause_key)
  VALUES (g.user_id, g.id, g.job_id, p_source, left(NULLIF(btrim(p_description), ''), 1000), v_warranty, v_parts, v_root)
  RETURNING id INTO v_claim;

  UPDATE service_guarantees SET status = 'claim_open', updated_at = now() WHERE id = g.id;

  PERFORM public._sg_log(g.id, g.user_id, 'claim_opened', 'Failure reported (' || p_source || ').',
    jsonb_build_object('claim_id', v_claim, 'source', p_source),
    CASE WHEN p_source = 'customer' THEN 'customer' WHEN p_source = 'staff' THEN 'staff' ELSE 'system' END);
  PERFORM public._sg_log(g.id, g.user_id, 'warranty_checked', 'Warranty and parts checked automatically.',
    jsonb_build_object('warranty', v_warranty, 'parts', v_parts));

  SELECT COALESCE((SELECT s.notify_owner_on_failure FROM service_guarantee_settings s WHERE s.user_id = g.user_id), true)
  INTO v_notify_owner;
  IF v_notify_owner THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      g.user_id, 'service_guarantee',
      'Guarantee claim: ' || COALESCE(NULLIF(g.customer_name, ''), 'customer'),
      'The fix for ' || COALESCE(NULLIF(g.service_type, ''), 'this job') || ' may have failed. Vireek checked warranty and parts; approve a recovery visit.',
      '/dashboard/service-guarantee'
    );
  END IF;

  PERFORM public._sg_enqueue(g.id, g.user_id, 'claim_received', '');
  RETURN v_claim;
END;
$$;

-- =============================================================
-- TRIGGERS
-- =============================================================

/* Job completed: (1) finish a recovery visit if this job is one, (2) start a guarantee. Never blocks the job update. */
CREATE OR REPLACE FUNCTION public.trg_service_guarantee_on_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_set service_guarantee_settings%ROWTYPE;
  v_claim service_guarantee_claims%ROWTYPE;
  v_started timestamptz;
  v_gid uuid;
BEGIN
  BEGIN
    FOR v_claim IN
      SELECT * FROM service_guarantee_claims c WHERE c.redispatch_job_id = NEW.id AND c.status = 'redispatched'
    LOOP
      UPDATE service_guarantee_claims
      SET status = 'resolved', resolved_at = now(), resolution_note = COALESCE(resolution_note, 'Recovery visit completed')
      WHERE id = v_claim.id;
      UPDATE service_guarantees
      SET status = 'recovered', recovered_by_job_id = NEW.id, updated_at = now()
      WHERE id = v_claim.guarantee_id;
      UPDATE service_guarantee_checkpoints SET status = 'voided'
      WHERE guarantee_id = v_claim.guarantee_id AND status = 'pending';
      PERFORM public._sg_log(v_claim.guarantee_id, v_claim.user_id, 'recovered', 'Recovery visit completed.',
        jsonb_build_object('claim_id', v_claim.id, 'recovery_job_id', NEW.id));
      PERFORM public._sg_enqueue(v_claim.guarantee_id, v_claim.user_id, 'recovery_done', '');
    END LOOP;

    SELECT * INTO v_set FROM service_guarantee_settings WHERE user_id = NEW.user_id;
    IF FOUND AND v_set.enabled THEN
      v_started := CASE
        WHEN NEW.completed_at IS NOT NULL AND NEW.completed_at <= now() AND NEW.completed_at > now() - interval '1 day'
        THEN NEW.completed_at ELSE now() END;

      INSERT INTO service_guarantees (user_id, job_id, technician_id, customer_name, customer_phone, service_type, started_at, expires_at)
      VALUES (NEW.user_id, NEW.id, NEW.assigned_technician_id, COALESCE(NEW.customer_name, ''), NEW.customer_phone,
              NEW.service_type, v_started, v_started + make_interval(days => v_set.coverage_days))
      ON CONFLICT (job_id) DO NOTHING
      RETURNING id INTO v_gid;

      IF v_gid IS NOT NULL THEN
        INSERT INTO service_guarantee_checkpoints (user_id, guarantee_id, stage, due_at) VALUES
          (NEW.user_id, v_gid, 'h48', v_started + interval '48 hours'),
          (NEW.user_id, v_gid, 'd7', v_started + interval '7 days'),
          (NEW.user_id, v_gid, 'd30', v_started + interval '30 days');
        PERFORM public._sg_log(v_gid, NEW.user_id, 'created', 'Guarantee started. Verification at 48 hours, 7 days and 30 days.');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'service guarantee (complete) failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_guarantee_complete ON jobs;
CREATE TRIGGER trg_service_guarantee_complete
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW
  WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.trg_service_guarantee_on_complete();

/* A rework job linked to a guaranteed job is a failure signal, whoever created it. */
CREATE OR REPLACE FUNCTION public.trg_service_guarantee_on_rework()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gid uuid;
BEGIN
  BEGIN
    SELECT g.id INTO v_gid FROM service_guarantees g
    WHERE g.job_id = NEW.rework_of_job_id AND g.status IN ('verifying', 'verified') AND g.expires_at > now();
    IF v_gid IS NOT NULL THEN
      PERFORM public._sg_open_claim(v_gid, 'callback_job', 'A rework visit was booked for this job.');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'service guarantee (rework) failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_guarantee_rework ON jobs;
CREATE TRIGGER trg_service_guarantee_rework
  AFTER INSERT ON jobs
  FOR EACH ROW
  WHEN (NEW.rework_of_job_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_service_guarantee_on_rework();

-- =============================================================
-- OWNER / STAFF ACTIONS
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_service_guarantee_settings(
  p_enabled boolean, p_coverage_days integer, p_notify_customer boolean, p_notify_owner boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change Verified Service settings';
  END IF;
  IF p_coverage_days IS NULL OR p_coverage_days NOT BETWEEN 30 AND 365 THEN
    RAISE EXCEPTION 'Coverage must be between 30 and 365 days';
  END IF;
  INSERT INTO service_guarantee_settings (user_id, enabled, coverage_days, notify_customer, notify_owner_on_failure, updated_at)
  VALUES (v_owner, COALESCE(p_enabled, false), p_coverage_days, COALESCE(p_notify_customer, true), COALESCE(p_notify_owner, true), now())
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    coverage_days = EXCLUDED.coverage_days,
    notify_customer = EXCLUDED.notify_customer,
    notify_owner_on_failure = EXCLUDED.notify_owner_on_failure,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.open_staff_guarantee_claim(p_guarantee_id uuid, p_description text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_claim uuid;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM service_guarantees WHERE id = p_guarantee_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Guarantee not found';
  END IF;
  IF char_length(btrim(COALESCE(p_description, ''))) < 3 THEN
    RAISE EXCEPTION 'Describe what went wrong (at least 3 characters)';
  END IF;
  v_claim := public._sg_open_claim(p_guarantee_id, 'staff', p_description);
  IF v_claim IS NULL THEN
    RAISE EXCEPTION 'This guarantee can no longer take a claim (expired, closed or already recovering)';
  END IF;
  RETURN v_claim;
END;
$$;

/* Owner-approved recovery visit: creates the rework job and links everything. */
CREATE OR REPLACE FUNCTION public.create_guarantee_redispatch(
  p_claim_id uuid, p_technician_id uuid, p_scheduled_at timestamptz, p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c service_guarantee_claims%ROWTYPE;
  j jobs%ROWTYPE;
  v_new uuid;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO c FROM service_guarantee_claims WHERE id = p_claim_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  IF c.status <> 'open' THEN
    RAISE EXCEPTION 'This claim already has a recovery visit or is closed';
  END IF;
  IF p_scheduled_at IS NULL OR p_scheduled_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'Pick a recovery time in the future';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE id = p_technician_id AND account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Technician not found';
  END IF;

  SELECT * INTO j FROM jobs WHERE id = c.job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original job not found';
  END IF;

  INSERT INTO jobs (
    user_id, lead_id, customer_id, site_id, customer_name, customer_phone, service_type, address,
    scheduled_datetime, duration_minutes, assigned_technician_id, job_status, is_rework, rework_of_job_id, notes
  ) VALUES (
    v_owner, j.lead_id, j.customer_id, j.site_id, j.customer_name, j.customer_phone, j.service_type, j.address,
    p_scheduled_at, j.duration_minutes, p_technician_id, 'scheduled', true, j.id,
    left('Guarantee recovery visit. ' || COALESCE(NULLIF(btrim(p_note), ''), COALESCE(c.description, '')), 900)
  )
  RETURNING id INTO v_new;

  UPDATE service_guarantee_claims
  SET status = 'redispatched', redispatch_job_id = v_new, proposed_technician_id = p_technician_id
  WHERE id = c.id;

  UPDATE service_guarantees SET status = 'recovering', updated_at = now() WHERE id = c.guarantee_id;

  UPDATE service_guarantee_checkpoints
  SET status = 'failed', evidence = 'failure_reported', checked_at = now()
  WHERE id = (
    SELECT k.id FROM service_guarantee_checkpoints k
    WHERE k.guarantee_id = c.guarantee_id AND k.status = 'pending' ORDER BY k.due_at LIMIT 1
  );

  PERFORM public._sg_log(c.guarantee_id, v_owner, 'redispatch_created', 'Recovery visit approved and scheduled.',
    jsonb_build_object('claim_id', c.id, 'recovery_job_id', v_new, 'technician_id', p_technician_id, 'scheduled_at', p_scheduled_at), 'staff');
  PERFORM public._sg_enqueue(c.guarantee_id, v_owner, 'recovery_scheduled', '');
  RETURN v_new;
END;
$$;

/* 'rejected' = not covered / unrelated (guarantee resumes). 'resolved' = fixed without a new visit. */
CREATE OR REPLACE FUNCTION public.resolve_guarantee_claim(p_claim_id uuid, p_resolution text, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c service_guarantee_claims%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF p_resolution NOT IN ('rejected', 'resolved') THEN
    RAISE EXCEPTION 'Invalid resolution';
  END IF;
  IF char_length(btrim(COALESCE(p_note, ''))) < 3 THEN
    RAISE EXCEPTION 'A short note is required for the audit trail';
  END IF;

  SELECT * INTO c FROM service_guarantee_claims WHERE id = p_claim_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;

  IF p_resolution = 'rejected' THEN
    IF c.status <> 'open' THEN
      RAISE EXCEPTION 'Only an open claim can be rejected';
    END IF;
    UPDATE service_guarantee_claims
    SET status = 'rejected', resolved_at = now(), resolution_note = left(btrim(p_note), 500) WHERE id = c.id;
    UPDATE service_guarantees
    SET status = CASE
          WHEN expires_at <= now() THEN 'expired'
          WHEN EXISTS (SELECT 1 FROM service_guarantee_checkpoints k WHERE k.guarantee_id = c.guarantee_id AND k.status = 'pending') THEN 'verifying'
          ELSE 'verified' END,
        updated_at = now()
    WHERE id = c.guarantee_id;
    PERFORM public._sg_log(c.guarantee_id, v_owner, 'claim_rejected', left(btrim(p_note), 500), jsonb_build_object('claim_id', c.id), 'staff');
  ELSE
    IF c.status NOT IN ('open', 'redispatched') THEN
      RAISE EXCEPTION 'This claim is already closed';
    END IF;
    UPDATE service_guarantee_claims
    SET status = 'resolved', resolved_at = now(), resolution_note = left(btrim(p_note), 500) WHERE id = c.id;
    UPDATE service_guarantees SET status = 'recovered', updated_at = now() WHERE id = c.guarantee_id;
    UPDATE service_guarantee_checkpoints SET status = 'voided' WHERE guarantee_id = c.guarantee_id AND status = 'pending';
    PERFORM public._sg_log(c.guarantee_id, v_owner, 'claim_resolved', left(btrim(p_note), 500), jsonb_build_object('claim_id', c.id), 'staff');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_service_guarantee(p_guarantee_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  g service_guarantees%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can void a guarantee';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'A reason is required (for example: damage caused by the customer)';
  END IF;
  SELECT * INTO g FROM service_guarantees WHERE id = p_guarantee_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Guarantee not found';
  END IF;
  IF g.status IN ('voided', 'expired', 'recovered') THEN
    RAISE EXCEPTION 'This guarantee is already closed';
  END IF;
  UPDATE service_guarantees SET status = 'voided', void_reason = left(btrim(p_reason), 500), updated_at = now() WHERE id = g.id;
  UPDATE service_guarantee_checkpoints SET status = 'voided' WHERE guarantee_id = g.id AND status = 'pending';
  UPDATE service_guarantee_claims SET status = 'rejected', resolved_at = now(), resolution_note = 'Guarantee voided'
  WHERE guarantee_id = g.id AND status IN ('open', 'redispatched');
  PERFORM public._sg_log(g.id, v_owner, 'voided', left(btrim(p_reason), 500), '{}'::jsonb, 'staff');
END;
$$;

-- =============================================================
-- CUSTOMER (token-gated; token = jobs.reschedule_token)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_public_service_guarantee(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g service_guarantees%ROWTYPE;
  v_business text;
  v_tech text;
  v_await text;
BEGIN
  SELECT sg.* INTO g
  FROM service_guarantees sg JOIN jobs j ON j.id = sg.job_id
  WHERE j.reschedule_token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name INTO v_business FROM profiles p WHERE p.id = g.user_id;
  SELECT t.member_name INTO v_tech FROM team_members t WHERE t.id = g.technician_id;

  SELECT k.stage INTO v_await FROM service_guarantee_checkpoints k
  WHERE k.guarantee_id = g.id AND k.status = 'pending' AND k.prompted_at IS NOT NULL
    AND k.customer_response IS NULL AND k.due_at <= now()
  ORDER BY k.due_at LIMIT 1;

  RETURN jsonb_build_object(
    'business_name', v_business,
    'service_type', g.service_type,
    'technician_name', v_tech,
    'status', g.status,
    'evidence_level', g.evidence_level,
    'started_at', g.started_at,
    'expires_at', g.expires_at,
    'verified_at', g.verified_at,
    'can_report', (g.status IN ('verifying', 'verified') AND g.expires_at > now()),
    'awaiting_stage', v_await,
    'checkpoints', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'stage', k.stage, 'due_at', k.due_at, 'status', k.status, 'evidence', k.evidence
      ) ORDER BY k.due_at)
      FROM service_guarantee_checkpoints k WHERE k.guarantee_id = g.id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.report_service_guarantee_issue(p_token uuid, p_description text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gid uuid;
  v_desc text := btrim(COALESCE(p_description, ''));
  v_claim uuid;
BEGIN
  SELECT sg.id INTO v_gid
  FROM service_guarantees sg JOIN jobs j ON j.id = sg.job_id
  WHERE j.reschedule_token = p_token;
  IF v_gid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF char_length(v_desc) < 3 OR char_length(v_desc) > 1000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_description');
  END IF;
  v_claim := public._sg_open_claim(v_gid, 'customer', v_desc);
  IF v_claim IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_covered');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_service_guarantee_checkpoint(
  p_token uuid, p_stage text, p_solved boolean, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g service_guarantees%ROWTYPE;
  k service_guarantee_checkpoints%ROWTYPE;
  v_note text := left(NULLIF(btrim(COALESCE(p_note, '')), ''), 500);
  v_claim uuid;
BEGIN
  IF p_stage NOT IN ('h48', 'd7', 'd30') OR p_solved IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  SELECT sg.* INTO g
  FROM service_guarantees sg JOIN jobs j ON j.id = sg.job_id
  WHERE j.reschedule_token = p_token FOR UPDATE OF sg;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF g.status <> 'verifying' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_verifying');
  END IF;

  SELECT * INTO k FROM service_guarantee_checkpoints WHERE guarantee_id = g.id AND stage = p_stage FOR UPDATE;
  IF NOT FOUND OR k.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
  END IF;
  IF k.due_at > now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_early');
  END IF;
  IF EXISTS (SELECT 1 FROM service_guarantee_checkpoints e WHERE e.guarantee_id = g.id AND e.status = 'pending' AND e.due_at < k.due_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'out_of_order');
  END IF;

  IF p_solved THEN
    UPDATE service_guarantee_checkpoints
    SET status = 'passed', evidence = 'customer_confirmed', customer_response = 'solved',
        customer_note = v_note, responded_at = now(), checked_at = now()
    WHERE id = k.id;
    UPDATE service_guarantees SET evidence_level = 'customer_confirmed', last_checkpoint = p_stage, updated_at = now() WHERE id = g.id;
    PERFORM public._sg_log(g.id, g.user_id, 'checkpoint_passed', 'Customer confirmed the problem is solved (' || p_stage || ').',
      jsonb_build_object('stage', p_stage, 'evidence', 'customer_confirmed'), 'customer');
    PERFORM public._sg_recompute(g.id);
    RETURN jsonb_build_object('ok', true, 'result', 'confirmed');
  END IF;

  UPDATE service_guarantee_checkpoints
  SET customer_response = 'not_solved', customer_note = v_note, responded_at = now()
  WHERE id = k.id;
  v_claim := public._sg_open_claim(g.id, 'customer',
    COALESCE(v_note, 'Customer reported the problem is not solved at the ' || p_stage || ' check.'));
  IF v_claim IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_covered');
  END IF;
  RETURN jsonb_build_object('ok', true, 'result', 'claim_opened');
END;
$$;

-- =============================================================
-- CRON (service_role only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_service_guarantee_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_signal text;
  v_desc text;
  v_notify boolean;
  v_passed integer := 0;
  v_prompted integer := 0;
  v_claims integer := 0;
  v_expired integer := 0;
  v_escalated integer := 0;
BEGIN
  -- 1) Earliest due checkpoint of every verifying guarantee.
  FOR r IN
    SELECT c.id AS cp_id, c.stage, c.prompted_at, c.guarantee_id, g.user_id, g.job_id, g.customer_phone
    FROM service_guarantee_checkpoints c
    JOIN service_guarantees g ON g.id = c.guarantee_id
    WHERE c.status = 'pending' AND c.due_at <= now() AND g.status = 'verifying'
      AND NOT EXISTS (
        SELECT 1 FROM service_guarantee_checkpoints e
        WHERE e.guarantee_id = c.guarantee_id AND e.status = 'pending' AND e.due_at < c.due_at
      )
    ORDER BY c.due_at
    LIMIT 500
    FOR UPDATE OF c SKIP LOCKED
  LOOP
    BEGIN
      v_signal := NULL;
      v_desc := NULL;

      IF EXISTS (SELECT 1 FROM jobs jb WHERE jb.id = r.job_id AND jb.customer_disputed) THEN
        v_signal := 'dispute'; v_desc := 'The job was flagged as disputed.';
      ELSIF EXISTS (SELECT 1 FROM review_requests rr WHERE rr.job_id = r.job_id AND rr.rating IS NOT NULL AND rr.rating <= 2) THEN
        v_signal := 'low_rating'; v_desc := 'The customer left a rating of 2 stars or lower.';
      ELSIF EXISTS (SELECT 1 FROM jobs w WHERE w.rework_of_job_id = r.job_id) THEN
        v_signal := 'callback_job'; v_desc := 'A rework visit exists for this job.';
      END IF;

      -- An owner who already rejected this kind of signal is not asked again.
      IF v_signal IS NOT NULL AND EXISTS (
        SELECT 1 FROM service_guarantee_claims x WHERE x.guarantee_id = r.guarantee_id AND x.source = v_signal AND x.status = 'rejected'
      ) THEN
        v_signal := NULL;
      END IF;

      IF v_signal IS NOT NULL THEN
        IF public._sg_open_claim(r.guarantee_id, v_signal, v_desc) IS NOT NULL THEN
          v_claims := v_claims + 1;
        END IF;
        CONTINUE;
      END IF;

      SELECT COALESCE((SELECT s.notify_customer FROM service_guarantee_settings s WHERE s.user_id = r.user_id), true) INTO v_notify;
      IF v_notify AND r.customer_phone IS NOT NULL AND btrim(r.customer_phone) <> '' THEN
        IF r.prompted_at IS NULL THEN
          UPDATE service_guarantee_checkpoints SET prompted_at = now() WHERE id = r.cp_id;
          PERFORM public._sg_enqueue(r.guarantee_id, r.user_id, 'checkpoint_prompt', r.stage);
          PERFORM public._sg_log(r.guarantee_id, r.user_id, 'checkpoint_prompted', 'Asked the customer to confirm (' || r.stage || ').',
            jsonb_build_object('stage', r.stage));
          v_prompted := v_prompted + 1;
          CONTINUE;
        ELSIF r.prompted_at > now() - interval '24 hours' THEN
          CONTINUE; -- still waiting for the customer
        END IF;
      END IF;

      UPDATE service_guarantee_checkpoints
      SET status = 'passed', evidence = 'no_failure_signal', checked_at = now() WHERE id = r.cp_id;
      UPDATE service_guarantees
      SET last_checkpoint = r.stage,
          evidence_level = CASE WHEN evidence_level = 'customer_confirmed' THEN evidence_level ELSE 'no_failure_signal' END,
          updated_at = now()
      WHERE id = r.guarantee_id;
      PERFORM public._sg_log(r.guarantee_id, r.user_id, 'checkpoint_passed',
        'No failure signal found at the ' || r.stage || ' check.', jsonb_build_object('stage', r.stage, 'evidence', 'no_failure_signal'));
      PERFORM public._sg_recompute(r.guarantee_id);
      v_passed := v_passed + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'guarantee tick failed for guarantee %: %', r.guarantee_id, SQLERRM;
    END;
  END LOOP;

  -- 2) Coverage ended.
  FOR r IN
    SELECT sg.id, sg.user_id FROM service_guarantees sg
    WHERE sg.status = 'verified' AND sg.expires_at <= now()
    LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE service_guarantees SET status = 'expired', updated_at = now() WHERE id = r.id;
    PERFORM public._sg_log(r.id, r.user_id, 'expired', 'Coverage period ended with the outcome verified.');
    v_expired := v_expired + 1;
  END LOOP;

  -- 3) Claims nobody acted on for 24h: escalate once.
  FOR r IN
    SELECT c.id, c.user_id, c.guarantee_id FROM service_guarantee_claims c
    WHERE c.status = 'open' AND c.escalated_at IS NULL AND c.created_at < now() - interval '24 hours'
    LIMIT 200 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE service_guarantee_claims SET escalated_at = now() WHERE id = r.id;
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (r.user_id, 'service_guarantee', 'Guarantee claim waiting 24 hours',
            'A customer is waiting for a recovery visit. Approve one or close the claim.', '/dashboard/service-guarantee');
    PERFORM public._sg_log(r.guarantee_id, r.user_id, 'claim_escalated', 'Claim unanswered for 24 hours.', jsonb_build_object('claim_id', r.id));
    v_escalated := v_escalated + 1;
  END LOOP;

  RETURN jsonb_build_object('passed', v_passed, 'prompted', v_prompted, 'claims', v_claims, 'expired', v_expired, 'escalated', v_escalated);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_service_guarantee_messages(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  -- Rows stuck in 'sending' (crashed worker) go back to the queue.
  UPDATE service_guarantee_messages SET status = 'pending', updated_at = now()
  WHERE status = 'sending' AND updated_at < now() - interval '15 minutes';

  WITH picked AS (
    UPDATE service_guarantee_messages m
    SET status = 'sending', attempts = m.attempts + 1, updated_at = now()
    WHERE m.id IN (
      SELECT m2.id FROM service_guarantee_messages m2
      WHERE m2.status = 'pending' AND m2.attempts < 3
      ORDER BY m2.created_at
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING m.id, m.user_id, m.guarantee_id, m.kind, m.stage
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'user_id', p.user_id, 'guarantee_id', p.guarantee_id, 'kind', p.kind, 'stage', p.stage,
    'customer_name', g.customer_name, 'customer_phone', g.customer_phone, 'service_type', g.service_type,
    'token', j.reschedule_token, 'business_name', pr.company_name
  )), '[]'::jsonb)
  INTO v_out
  FROM picked p
  JOIN service_guarantees g ON g.id = p.guarantee_id
  JOIN jobs j ON j.id = g.job_id
  LEFT JOIN profiles pr ON pr.id = p.user_id;

  RETURN v_out;
END;
$$;

/* p_status: sent | skipped | failed | retry (retry -> failed automatically after 3 attempts). */
CREATE OR REPLACE FUNCTION public.complete_service_guarantee_message(p_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  UPDATE service_guarantee_messages
  SET status = CASE
        WHEN p_status = 'retry' THEN (CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END)
        ELSE p_status END,
      error = left(p_error, 300),
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      updated_at = now()
  WHERE id = p_id AND status = 'sending';
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public._sg_log(uuid, uuid, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._sg_enqueue(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._sg_recompute(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._sg_open_claim(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_service_guarantee_on_complete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_service_guarantee_on_rework() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_service_guarantee_settings(boolean, integer, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_staff_guarantee_claim(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_guarantee_redispatch(uuid, uuid, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_guarantee_claim(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_service_guarantee(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_service_guarantee_settings(boolean, integer, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_staff_guarantee_claim(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_guarantee_redispatch(uuid, uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_guarantee_claim(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_service_guarantee(uuid, text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_service_guarantee(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_service_guarantee_issue(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_service_guarantee_checkpoint(uuid, text, boolean, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.run_service_guarantee_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_service_guarantee_messages(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_service_guarantee_message(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_service_guarantee_tick() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_service_guarantee_messages(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_service_guarantee_message(uuid, text, text) TO service_role;
