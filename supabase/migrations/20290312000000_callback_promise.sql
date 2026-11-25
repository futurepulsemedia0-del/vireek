/*
  # Callback Promise - "every missed / unresolved call gets a callback within X"

  ## Why
  Rescue Loop (20271011000000_rescue_loop_sla.sql) already answers "how fast was the FIRST response"
  (a text-back counts). It does not promise anything about a real CALLBACK, and nothing turns the
  business's own rule into a tracked promise with a deadline, a human escalation and numbers an owner
  can trust. Promise Tracker (promises, 20260927000000) already holds promises with a due time and
  a human resolve flow, but its rows come only from AI extraction of call transcripts.

  This migration connects the two. It adds NO parallel timeline and NO new promise table:
    - the rule lives in one small settings table (callback_promise_settings)
    - each missed / voicemail / abandoned call (same definition as Rescue Loop: the Missed-Revenue
      Recovery Ledger) becomes ONE row in the existing `promises` table (category 'callback',
      origin 'callback_policy'), so it shows up in the existing Promise Tracker page
    - "was the callback made?" is answered by the existing rescue_loop_events_for() timeline
    - overdue / escalation alerts are rows in `notifications` (existing push + routing fan-out)

  ## The rule (X is the OWNER'S decision - there is no default)
  window_minutes is NULL until the owner sets it. While it is NULL the rule is off and nothing is
  created, alerted or counted. TODO(owner): choose X per business; do not publish a default.
  escalate_after_minutes is optional: NULL = overdue alert only, no human escalation step.
  public_stat_min_cases is optional: NULL = the public stat can never be published.

  ## What counts as "the callback was made"
  The earliest recorded VOICE attempt after the miss: an automatic callback step that succeeded
  (callback_attempt), a follow-up-agent call that connected / left a voicemail / got no answer
  (followup_call), or a team member logging a call outcome in the Priority Call Queue
  (human_followup, channel = call). Texts do NOT count (that is Rescue Loop's first-response SLA).
  A no-answer ATTEMPT counts as a made callback; reaching the person is not required.
  TODO(owner): confirm that "attempted" (not "reached") is the product rule.

  ## Verdicts and honesty rules
  - No machine "broken". A promise past its deadline stays `pending` and is alerted/escalated; only a
    human marks it broken or cancelled (same rule as promises: never a false machine verdict).
  - Evidence-based `fulfilled` is written by the sweep with resolved_at = the time of the recorded
    attempt and evidence_source = 'system'. On time = resolved_at <= due_at.
  - A human resolving a policy promise gets evidence_source = 'manual' and resolved_at = now()
    (enforced by a trigger, so it cannot be back-dated). Manual rows count in the owner's numbers but
    never in the numerator of anything published.
  - Calls from before the rule was turned on are never back-filled (enabled_at).
  - Turning the rule off cancels the still-pending policy promises (nothing turns into a silent breach).
  - due_at / origin / call_id / evidence / escalation columns of policy promises cannot be edited by
    clients (trigger), so a published number cannot be forged through the existing UPDATE policy.

  ## Requires
  profiles, calls, promises, revenue_recovery_events, notifications (+ severity), trust_badge_settings,
  rescue_loop_events_for(), update_updated_at(), get_account_owner_id().
  Deploy: run this migration, deploy edge function callback-promise-sweep, call it every minute with
  the same X-Cron-Secret header the other cron functions use.
  NOTE: rename the timestamp if it does not sort AFTER your newest migration.

  ## Rollback (loses the rule + escalation state; the promises rows stay unless you delete them)
  DROP FUNCTION IF EXISTS public.callback_promise_public_stat(text), public.callback_promise_stats(timestamptz, timestamptz),
    public.callback_promise_stats_for(uuid, timestamptz, timestamptz), public.callback_promise_sweep(interval, integer),
    public.callback_promise_save_settings(boolean, integer, integer, boolean, integer), public.callback_promise_fmt_minutes(integer),
    public.promises_callback_policy_guard();
  DROP TRIGGER IF EXISTS trg_promises_callback_policy_guard ON promises;
  DROP TABLE IF EXISTS public.callback_promise_settings;
  -- optional: DELETE FROM promises WHERE origin = 'callback_policy'; then drop the added promises columns.
*/

-- =============================================================
-- 1. SETTINGS (one row per account; writes only through the RPC)
-- =============================================================

CREATE TABLE IF NOT EXISTS callback_promise_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  window_minutes integer CHECK (window_minutes IS NULL OR window_minutes BETWEEN 5 AND 10080),
  escalate_after_minutes integer CHECK (escalate_after_minutes IS NULL OR escalate_after_minutes BETWEEN 5 AND 10080),
  public_stat_opt_in boolean NOT NULL DEFAULT false,
  public_stat_min_cases integer CHECK (public_stat_min_cases IS NULL OR public_stat_min_cases BETWEEN 1 AND 100000),
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT callback_promise_enabled_needs_window CHECK (NOT enabled OR window_minutes IS NOT NULL)
);

ALTER TABLE callback_promise_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_callback_promise_settings" ON callback_promise_settings;
CREATE POLICY "select_own_callback_promise_settings" ON callback_promise_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE policy: writes go through callback_promise_save_settings().

DROP TRIGGER IF EXISTS trg_callback_promise_settings_updated_at ON callback_promise_settings;
CREATE TRIGGER trg_callback_promise_settings_updated_at
  BEFORE UPDATE ON callback_promise_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 2. PROMISES: additive columns for policy-created promises
-- =============================================================

ALTER TABLE promises
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS evidence_source text,
  ADD COLUMN IF NOT EXISTS policy_window_minutes integer,
  ADD COLUMN IF NOT EXISTS escalation_stage text,
  ADD COLUMN IF NOT EXISTS escalation_alert_sent_at timestamptz;

ALTER TABLE promises DROP CONSTRAINT IF EXISTS promises_origin_check;
ALTER TABLE promises ADD CONSTRAINT promises_origin_check
  CHECK (origin IN ('extracted', 'callback_policy'));
ALTER TABLE promises DROP CONSTRAINT IF EXISTS promises_evidence_source_check;
ALTER TABLE promises ADD CONSTRAINT promises_evidence_source_check
  CHECK (evidence_source IS NULL OR evidence_source IN ('system', 'manual'));
ALTER TABLE promises DROP CONSTRAINT IF EXISTS promises_escalation_stage_check;
ALTER TABLE promises ADD CONSTRAINT promises_escalation_stage_check
  CHECK (escalation_stage IS NULL OR escalation_stage IN ('overdue', 'escalated'));
ALTER TABLE promises DROP CONSTRAINT IF EXISTS promises_policy_window_check;
ALTER TABLE promises ADD CONSTRAINT promises_policy_window_check
  CHECK (policy_window_minutes IS NULL OR policy_window_minutes BETWEEN 5 AND 10080);

-- One policy promise per call (idempotent creation).
CREATE UNIQUE INDEX IF NOT EXISTS uq_promises_callback_policy_call
  ON promises (call_id) WHERE origin = 'callback_policy';
CREATE INDEX IF NOT EXISTS idx_promises_callback_policy_due
  ON promises (user_id, due_at) WHERE origin = 'callback_policy';

-- Clients may keep resolving / reopening promises (existing UPDATE policy), but must not be able to
-- forge the evidence a metric is built from. current_user is the EXECUTING role: 'authenticated' for a
-- direct client UPDATE, the function owner inside the SECURITY DEFINER sweep/RPCs below.
CREATE OR REPLACE FUNCTION public.promises_callback_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND OLD.origin = 'callback_policy' THEN
    IF NEW.origin IS DISTINCT FROM OLD.origin
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.call_id IS DISTINCT FROM OLD.call_id
       OR NEW.due_at IS DISTINCT FROM OLD.due_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.policy_window_minutes IS DISTINCT FROM OLD.policy_window_minutes
       OR NEW.evidence_source IS DISTINCT FROM OLD.evidence_source
       OR NEW.escalation_stage IS DISTINCT FROM OLD.escalation_stage
       OR NEW.escalation_alert_sent_at IS DISTINCT FROM OLD.escalation_alert_sent_at THEN
      RAISE EXCEPTION 'Callback promise records are system-managed; only the outcome can be changed'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'pending' THEN
        -- reopened: re-evaluate from scratch (same idea as commitments.escalation_stage reset)
        NEW.evidence_source := NULL;
        NEW.escalation_stage := NULL;
        NEW.escalation_alert_sent_at := NULL;
      ELSE
        NEW.evidence_source := 'manual';
        NEW.resolved_at := now(); -- a human cannot back-date a resolution
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.promises_callback_policy_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_promises_callback_policy_guard ON promises;
CREATE TRIGGER trg_promises_callback_policy_guard
  BEFORE UPDATE ON promises
  FOR EACH ROW EXECUTE FUNCTION public.promises_callback_policy_guard();

-- =============================================================
-- 3. SMALL HELPER (mirrored by formatWindow() in src/lib/callbackPromise.ts)
-- =============================================================

-- 45 -> "45 min", 60 -> "1 h", 90 -> "90 min", 1440 -> "24 h"
CREATE OR REPLACE FUNCTION public.callback_promise_fmt_minutes(p_minutes integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN p_minutes IS NULL THEN '-'
    WHEN p_minutes >= 60 AND p_minutes % 60 = 0 THEN (p_minutes / 60)::text || ' h'
    ELSE p_minutes::text || ' min'
  END
$fn$;

-- =============================================================
-- 4. SETTINGS RPC (account owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.callback_promise_save_settings(
  p_enabled boolean,
  p_window_minutes integer,
  p_escalate_after_minutes integer,
  p_public_stat_opt_in boolean,
  p_public_stat_min_cases integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_enabled boolean := COALESCE(p_enabled, false);
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change the callback promise' USING ERRCODE = '42501';
  END IF;
  IF p_window_minutes IS NOT NULL AND p_window_minutes NOT BETWEEN 5 AND 10080 THEN
    RAISE EXCEPTION 'The callback window must be between 5 and 10080 minutes' USING ERRCODE = '22023';
  END IF;
  IF p_escalate_after_minutes IS NOT NULL AND p_escalate_after_minutes NOT BETWEEN 5 AND 10080 THEN
    RAISE EXCEPTION 'The escalation delay must be between 5 and 10080 minutes' USING ERRCODE = '22023';
  END IF;
  IF p_public_stat_min_cases IS NOT NULL AND p_public_stat_min_cases NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'The minimum sample must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;
  IF v_enabled AND p_window_minutes IS NULL THEN
    RAISE EXCEPTION 'Choose the callback window before turning the promise on' USING ERRCODE = '22023';
  END IF;

  INSERT INTO callback_promise_settings AS s
    (user_id, enabled, window_minutes, escalate_after_minutes, public_stat_opt_in, public_stat_min_cases, enabled_at)
  VALUES
    (v_owner, v_enabled, p_window_minutes, p_escalate_after_minutes,
     COALESCE(p_public_stat_opt_in, false), p_public_stat_min_cases,
     CASE WHEN v_enabled THEN now() END)
  ON CONFLICT (user_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        window_minutes = EXCLUDED.window_minutes,
        escalate_after_minutes = EXCLUDED.escalate_after_minutes,
        public_stat_opt_in = EXCLUDED.public_stat_opt_in,
        public_stat_min_cases = EXCLUDED.public_stat_min_cases,
        -- start of a new "on" period: only calls from here on are ever judged
        enabled_at = CASE
          WHEN EXCLUDED.enabled AND (s.enabled IS NOT TRUE OR s.enabled_at IS NULL) THEN now()
          WHEN EXCLUDED.enabled THEN s.enabled_at
          ELSE s.enabled_at
        END;

  IF NOT v_enabled THEN
    UPDATE promises
       SET status = 'cancelled',
           resolved_at = now(),
           evidence_source = 'system',
           resolution_note = 'Callback promise rule was turned off'
     WHERE user_id = v_owner AND origin = 'callback_policy' AND status = 'pending';
  END IF;
END
$fn$;

-- =============================================================
-- 5. THE SWEEP  (cron -> callback-promise-sweep edge function -> this)
--    create -> resolve from evidence -> alert/escalate. Idempotent.
-- =============================================================

CREATE OR REPLACE FUNCTION public.callback_promise_sweep(
  p_lookback interval DEFAULT interval '14 days',
  p_batch integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 500), 1), 2000);
  v_created integer := 0;
  v_fulfilled integer := 0;
  v_cancelled integer := 0;
  v_overdue integer := 0;
  v_escalated integer := 0;
  v_rec record;
  v_evidence timestamptz;
  v_kind text;
BEGIN
  -- One sweep at a time: a slow run must never overlap the next minute's run.
  IF NOT pg_try_advisory_xact_lock(hashtext('callback_promise_sweep')) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  -- Phase 1: one promise per missed / voicemail / abandoned call that is still open for recovery.
  INSERT INTO promises (
    user_id, call_id, customer_name, customer_phone, promise_text, category,
    due_description, due_at, status, origin, policy_window_minutes
  )
  SELECT s.user_id,
         c.id,
         COALESCE(NULLIF(btrim(c.caller_name), ''), NULLIF(btrim(r.customer_name), '')),
         c.caller_phone,
         'Call back ' || COALESCE(NULLIF(btrim(c.caller_name), ''), NULLIF(btrim(c.caller_phone), ''), 'the caller')
           || ' within ' || public.callback_promise_fmt_minutes(s.window_minutes),
         'callback',
         'within ' || public.callback_promise_fmt_minutes(s.window_minutes),
         (CASE WHEN r.source_type = 'not_booked'
               THEN c.call_datetime + make_interval(secs => COALESCE(c.duration_seconds, 0))
               ELSE c.call_datetime END) + make_interval(mins => s.window_minutes),
         'pending',
         'callback_policy',
         s.window_minutes
  FROM callback_promise_settings s
  JOIN revenue_recovery_events r
    ON r.user_id = s.user_id AND r.source_table = 'calls'
  JOIN calls c
    ON c.id = r.source_id AND c.user_id = s.user_id
  WHERE s.enabled
    AND s.window_minutes IS NOT NULL
    AND s.enabled_at IS NOT NULL
    AND r.source_type IN ('missed_call', 'voicemail', 'not_booked')
    AND r.status NOT IN ('recovered', 'written_off')
    AND c.call_datetime >= s.enabled_at
    AND c.call_datetime > now() - p_lookback
    -- already promised: keep them out of the batch so the LIMIT never starves new calls
    AND NOT EXISTS (SELECT 1 FROM promises x WHERE x.call_id = c.id AND x.origin = 'callback_policy')
  ORDER BY c.call_datetime
  LIMIT v_batch
  ON CONFLICT (call_id) WHERE origin = 'callback_policy' DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- Phase 2: close pending policy promises that have evidence (or no longer apply).
  FOR v_rec IN
    SELECT p.id AS promise_id, p.user_id AS user_id, p.call_id AS call_id, r.status AS ledger_status
    FROM promises p
    LEFT JOIN revenue_recovery_events r
      ON r.source_table = 'calls' AND r.source_id = p.call_id AND r.user_id = p.user_id
    WHERE p.origin = 'callback_policy'
      AND p.status = 'pending'
      AND p.call_id IS NOT NULL
      AND p.due_at > now() - p_lookback -- older ones wait for a human (Promise Tracker)
    ORDER BY p.due_at
    LIMIT v_batch
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    SELECT min(e.ev_at), (array_agg(e.ev_kind ORDER BY e.ev_at))[1]
      INTO v_evidence, v_kind
    FROM public.rescue_loop_events_for(v_rec.user_id, ARRAY[v_rec.call_id]) e
    WHERE e.ev_channel = 'call'
      AND e.ev_kind IN ('callback_attempt', 'followup_call', 'human_followup')
      AND e.ev_outcome IN ('ok', 'no_answer');

    IF v_evidence IS NOT NULL THEN
      UPDATE promises
         SET status = 'fulfilled',
             resolved_at = v_evidence,
             evidence_source = 'system',
             resolution_note = 'Callback attempt recorded automatically ('
               || CASE v_kind
                    WHEN 'callback_attempt' THEN 'automatic callback'
                    WHEN 'followup_call' THEN 'follow-up call'
                    ELSE 'team member call'
                  END || ')'
       WHERE id = v_rec.promise_id AND status = 'pending';
      v_fulfilled := v_fulfilled + 1;
    ELSIF v_rec.ledger_status IN ('recovered', 'written_off') THEN
      UPDATE promises
         SET status = 'cancelled',
             resolved_at = now(),
             evidence_source = 'system',
             resolution_note = CASE v_rec.ledger_status
               WHEN 'recovered' THEN 'No callback needed - the caller was recovered another way'
               ELSE 'No callback needed - closed out in the recovery ledger'
             END
       WHERE id = v_rec.promise_id AND status = 'pending';
      v_cancelled := v_cancelled + 1;
    END IF;
  END LOOP;

  -- Phase 3: alert once per stage; escalate to a human after the owner's delay. A burst for one account
  -- becomes ONE notification per stage (no alert storms). The row update and the notification are one
  -- statement, so a promise can never be alerted without being marked, or marked without being alerted.
  WITH due AS (
    SELECT p.id, p.user_id, p.customer_name, p.customer_phone, p.due_at,
           CASE
             WHEN s.escalate_after_minutes IS NOT NULL
                  AND now() >= p.due_at + make_interval(mins => s.escalate_after_minutes)
               THEN 'escalated' ELSE 'overdue'
           END AS new_stage
    FROM promises p
    JOIN callback_promise_settings s ON s.user_id = p.user_id AND s.enabled
    WHERE p.origin = 'callback_policy'
      AND p.status = 'pending'
      AND p.due_at <= now()
      AND p.due_at > now() - p_lookback
      AND (p.escalation_stage IS NULL OR p.escalation_stage = 'overdue')
    ORDER BY p.due_at
    LIMIT v_batch
    FOR UPDATE OF p SKIP LOCKED
  ),
  upd AS (
    UPDATE promises p
       SET escalation_stage = d.new_stage,
           escalation_alert_sent_at = now()
      FROM due d
     WHERE p.id = d.id
       AND p.escalation_stage IS DISTINCT FROM d.new_stage
    RETURNING p.id, p.user_id, p.customer_name, p.customer_phone, p.due_at, d.new_stage AS stage
  ),
  grp AS (
    SELECT u.user_id, u.stage,
           count(*)::integer AS n,
           min(u.due_at) AS oldest_due,
           min(COALESCE(NULLIF(btrim(u.customer_name), ''), NULLIF(btrim(u.customer_phone), ''), 'a caller')) AS who
    FROM upd u
    GROUP BY u.user_id, u.stage
  ),
  ins AS (
    INSERT INTO notifications (user_id, type, title, message, action_url, severity)
    SELECT g.user_id,
           CASE g.stage WHEN 'escalated' THEN 'callback_promise_escalated' ELSE 'callback_promise_overdue' END,
           CASE
             WHEN g.stage = 'escalated' AND g.n = 1 THEN 'Promised callback still not made - needs a person'
             WHEN g.stage = 'escalated' THEN g.n::text || ' promised callbacks still not made - need a person'
             WHEN g.n = 1 THEN 'Promised callback is overdue'
             ELSE g.n::text || ' promised callbacks are overdue'
           END,
           CASE
             WHEN g.n = 1 THEN 'The callback promised to ' || g.who || ' is ' ||
               public.rescue_fmt_seconds(GREATEST(0, round(extract(epoch FROM (now() - g.oldest_due)))::integer))
               || ' overdue.'
             ELSE 'The oldest is ' ||
               public.rescue_fmt_seconds(GREATEST(0, round(extract(epoch FROM (now() - g.oldest_due)))::integer))
               || ' overdue. Open Promise Tracker to see who is still waiting.'
           END,
           '/dashboard/promises',
           CASE g.stage WHEN 'escalated' THEN 'critical' ELSE 'high' END
    FROM grp g
    RETURNING 1
  )
  SELECT COALESCE(sum(g.n) FILTER (WHERE g.stage = 'overdue'), 0)::integer,
         COALESCE(sum(g.n) FILTER (WHERE g.stage = 'escalated'), 0)::integer
    INTO v_overdue, v_escalated
  FROM grp g;

  RETURN jsonb_build_object(
    'created', v_created,
    'fulfilled', v_fulfilled,
    'cancelled', v_cancelled,
    'overdue_alerted', v_overdue,
    'escalated', v_escalated
  );
END
$fn$;

-- =============================================================
-- 6. NUMBERS (owner dashboard + the one publishable stat)
--    Cases are judged by their DUE time inside [since, until). Cancelled cases are excluded.
--    A pending case counts only once it is past due.
-- =============================================================

CREATE OR REPLACE FUNCTION public.callback_promise_stats_for(p_owner uuid, p_since timestamptz, p_until timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH base AS (
    SELECT p.status, p.evidence_source, p.due_at, p.resolved_at, p.policy_window_minutes,
           extract(epoch FROM (p.resolved_at - (p.due_at - make_interval(mins => p.policy_window_minutes)))) / 60.0 AS minutes_to_callback
    FROM promises p
    WHERE p.user_id = p_owner
      AND p.origin = 'callback_policy'
      AND p.status <> 'cancelled'
      AND p.due_at >= p_since
      AND p.due_at < p_until
      AND (p.status <> 'pending' OR p.due_at <= now())
  )
  SELECT jsonb_build_object(
    'decided', count(*),
    'kept_system', count(*) FILTER (WHERE status = 'fulfilled' AND evidence_source = 'system' AND resolved_at <= due_at),
    'kept_manual', count(*) FILTER (WHERE status = 'fulfilled' AND evidence_source IS DISTINCT FROM 'system' AND resolved_at <= due_at),
    'late', count(*) FILTER (WHERE status = 'fulfilled' AND resolved_at > due_at),
    'broken', count(*) FILTER (WHERE status = 'broken'),
    'open_overdue', count(*) FILTER (WHERE status = 'pending'),
    'median_minutes_to_callback',
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes_to_callback)
             FILTER (WHERE status = 'fulfilled' AND evidence_source = 'system' AND minutes_to_callback IS NOT NULL))::numeric, 1),
    'window_min', min(policy_window_minutes),
    'window_max', max(policy_window_minutes)
  )
  FROM base
$fn$;

CREATE OR REPLACE FUNCTION public.callback_promise_stats(
  p_since timestamptz DEFAULT NULL,
  p_until timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_since timestamptz := COALESCE(p_since, now() - interval '30 days');
  v_until timestamptz := COALESCE(p_until, now() + interval '1 second');
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_until <= v_since OR v_until - v_since > interval '400 days' THEN
    RAISE EXCEPTION 'Invalid period' USING ERRCODE = '22023';
  END IF;
  RETURN public.callback_promise_stats_for(v_owner, v_since, v_until);
END
$fn$;

-- The only number meant for outside eyes. Keyed by the account's existing Trust Badge slug.
-- Returns NULL (no information) unless the badge is on AND the owner opted in AND set a window AND set a minimum
-- sample. Below the minimum, or if the window was changed inside the period, it returns publishable=false and
-- NO counts. The numerator is system evidence only; owner-attested outcomes never raise a published rate.
CREATE OR REPLACE FUNCTION public.callback_promise_public_stat(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner uuid;
  s callback_promise_settings%ROWTYPE;
  v jsonb;
  v_decided integer;
  v_kept integer;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' THEN
    RETURN NULL;
  END IF;

  SELECT t.account_owner_id INTO v_owner
  FROM trust_badge_settings t
  WHERE t.public_slug = p_slug AND t.enabled;
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO s FROM callback_promise_settings WHERE user_id = v_owner;
  IF NOT FOUND
     OR NOT s.enabled
     OR NOT s.public_stat_opt_in
     OR s.window_minutes IS NULL
     OR s.public_stat_min_cases IS NULL THEN
    RETURN NULL;
  END IF;

  v := public.callback_promise_stats_for(v_owner, now() - interval '30 days', now());
  v_decided := (v ->> 'decided')::integer;
  v_kept := (v ->> 'kept_system')::integer;

  IF v_decided < s.public_stat_min_cases THEN
    RETURN jsonb_build_object('publishable', false, 'reason', 'insufficient_sample');
  END IF;
  IF (v ->> 'window_min') IS DISTINCT FROM (v ->> 'window_max') THEN
    RETURN jsonb_build_object('publishable', false, 'reason', 'window_changed');
  END IF;

  RETURN jsonb_build_object(
    'publishable', true,
    'window_minutes', (v ->> 'window_min')::integer,
    'period_days', 30,
    'cases', v_decided,
    'kept_on_time', v_kept,
    'rate_pct', round(100.0 * v_kept / v_decided, 1),
    'basis', 'system_evidence_only',
    'as_of', now()
  );
END
$fn$;

-- =============================================================
-- 7. PRIVILEGES (Supabase grants EXECUTE to anon + authenticated by default; revoke explicitly)
-- =============================================================

REVOKE ALL ON FUNCTION public.callback_promise_fmt_minutes(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.callback_promise_fmt_minutes(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.callback_promise_save_settings(boolean, integer, integer, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.callback_promise_save_settings(boolean, integer, integer, boolean, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.callback_promise_stats(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.callback_promise_stats(timestamptz, timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.callback_promise_stats_for(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.callback_promise_stats_for(uuid, timestamptz, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.callback_promise_sweep(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.callback_promise_sweep(interval, integer) TO service_role;

REVOKE ALL ON FUNCTION public.callback_promise_public_stat(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.callback_promise_public_stat(text) TO service_role;

REVOKE ALL ON public.callback_promise_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.callback_promise_settings TO authenticated;
