/*
  # Rescue Loop timeline + first-response SLA monitor

  ## Why
  Vireek already does the individual pieces of a "rescue": the call.missed
  workflow playbook texts the caller and later calls back
  (workflow_runs / workflow_run_steps), the follow-up agent texts and calls
  (outbound_sms / outbound_calls), the Priority Call Queue logs human
  attempts (call_queue_outcomes), the booking page creates jobs, quotes get
  sent and invoices get paid. But nothing shows ONE caller's journey from
  "call missed" to "paid", and nothing alerts when the first response is
  slower than the business promised.

  ## What this adds (purely additive - no existing table is altered)
  1. rescue_sla_settings   per-account limit (default 60 s), alerts on/off,
                           "excuse quiet hours" switch. Written only through
                           rescue_save_sla_settings() (owner only).
  2. rescue_links          one tracked booking-link token per missed call.
     rescue_link_clicks    one row per real click (recorded by the booking
                           page through JavaScript, so link-preview bots
                           and carrier scanners never count).
  3. rescue_sla_alerts     one verdict row per call (breach / met / excused /
                           closed) - makes the monitor idempotent and
                           auditable.
  4. rescue_loop_events_for()  THE timeline: one UNION over the tables that
                           already exist. No data is copied.
     rescue_loop_events()      owner-scoped RPC wrapper (<= 100 call ids).
     rescue_loop_cases()       owner-scoped RPC: one row per missed /
                           voicemail / abandoned call with its SLA status.
  5. rescue_sla_scan()     called every minute by the rescue-sla-monitor edge
                           function. Writes verdicts and, for breaches,
                           ONE row in `notifications` (type
                           rescue_sla_breach) - which already fans out to push
                           and to notification routing (Slack / SMS / email)
                           through the existing triggers. More than 3 new
                           breaches for one account in one scan become a
                           single digest notification (no alert storms).

  ## What counts as a "case"
  The existing Missed-Revenue Recovery Ledger is the definition: a call whose
  ledger row is missed_call, voicemail or not_booked
  (20260922000000_missed_revenue_recovery_ledger.sql). Nothing is re-defined.

  ## What counts as the "first response"
  The earliest of: an automatic text-back or callback (workflow step), a
  follow-up-agent text/call, a text sent from the inbox, or a team member
  logging an attempt in the Call Queue. Failed, skipped, scheduled and
  test-mode steps do NOT count. A text that was queued because the customer
  is in quiet hours is "deferred": excused when rescue_sla_settings.
  excuse_quiet_hours is true (default), otherwise it counts as a breach.
  The clock starts at the call time (for not_booked: when the call ended).

  ## Security
  Every RPC is SECURITY DEFINER with a pinned search_path and an explicit
  get_account_owner_id() filter - a team member sees their account, never
  another tenant. Only the account owner can change SLA settings. The tokens
  are 80-bit random hex; record_rescue_link_click() is callable by anon but
  silently ignores anything that is not a known token (no oracle) and stores
  no IP address or user agent.

  Deploy: run this migration, deploy rescue-sla-monitor, point your cron at
  it every minute with the same X-Cron-Secret header you already use.
  NOTE: rename the timestamp if it does not sort AFTER your newest migration.
*/

-- =============================================================
-- 1. SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS rescue_sla_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  first_response_limit_seconds integer NOT NULL DEFAULT 60
    CHECK (first_response_limit_seconds BETWEEN 10 AND 86400),
  alerts_enabled boolean NOT NULL DEFAULT true,
  excuse_quiet_hours boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rescue_sla_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rescue_sla_settings" ON rescue_sla_settings;
CREATE POLICY "select_own_rescue_sla_settings" ON rescue_sla_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE policy: writes go through rescue_save_sla_settings().

DROP TRIGGER IF EXISTS trg_rescue_sla_settings_updated_at ON rescue_sla_settings;
CREATE TRIGGER trg_rescue_sla_settings_updated_at
  BEFORE UPDATE ON rescue_sla_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 2. TRACKED BOOKING LINKS + CLICKS
-- =============================================================

CREATE TABLE IF NOT EXISTS rescue_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  -- 20 lowercase hex chars (80 bits) from gen_random_uuid(): no extension needed.
  token text NOT NULL UNIQUE
    DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)
    CHECK (token ~ '^[0-9a-f]{20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS idx_rescue_links_user ON rescue_links(user_id, created_at DESC);

ALTER TABLE rescue_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rescue_links" ON rescue_links;
CREATE POLICY "select_own_rescue_links" ON rescue_links
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS rescue_link_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES rescue_links(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  clicked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rescue_link_clicks_link ON rescue_link_clicks(link_id, clicked_at);

ALTER TABLE rescue_link_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rescue_link_clicks" ON rescue_link_clicks;
CREATE POLICY "select_own_rescue_link_clicks" ON rescue_link_clicks
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. SLA VERDICTS (idempotent monitor + audit trail)
-- =============================================================

CREATE TABLE IF NOT EXISTS rescue_sla_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('breach', 'met', 'excused', 'closed')),
  response_seconds integer CHECK (response_seconds IS NULL OR response_seconds >= 0),
  limit_seconds integer NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS idx_rescue_sla_alerts_user ON rescue_sla_alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rescue_sla_alerts_unnotified
  ON rescue_sla_alerts(user_id) WHERE verdict = 'breach' AND NOT notified;

ALTER TABLE rescue_sla_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rescue_sla_alerts" ON rescue_sla_alerts;
CREATE POLICY "select_own_rescue_sla_alerts" ON rescue_sla_alerts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. SUPPORTING INDEXES (additive; make the timeline joins cheap)
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_workflow_runs_entity
  ON workflow_runs(entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_sms_lead
  ON outbound_sms(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_calls_lead
  ON outbound_calls(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_queue_outcomes_source
  ON call_queue_outcomes(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_call_id_rescue
  ON jobs(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_lead_id_rescue
  ON jobs(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_lead_id_rescue
  ON quotes(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_job_id_rescue
  ON invoices(job_id) WHERE job_id IS NOT NULL;

-- =============================================================
-- 5. SMALL PURE HELPERS (mirrored 1:1 in src/lib/rescueLoop.ts)
-- =============================================================

-- Last 10 digits, so "(555) 123-4567" and "+15551234567" are the same caller.
-- NULL when there are fewer than 7 digits (never match on junk).
CREATE OR REPLACE FUNCTION public.rescue_phone_key(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN length(d.digits) >= 7 THEN right(d.digits, 10) END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') AS digits) d
$fn$;

-- "45s", "3m 05s", "1h 10m", "2d 4h"  (same format as formatDuration() in TS)
CREATE OR REPLACE FUNCTION public.rescue_fmt_seconds(p_seconds integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN p_seconds IS NULL THEN '-'
    WHEN p_seconds < 60 THEN p_seconds::text || 's'
    WHEN p_seconds < 3600 THEN (p_seconds / 60)::text || 'm ' || lpad((p_seconds % 60)::text, 2, '0') || 's'
    WHEN p_seconds < 86400 THEN (p_seconds / 3600)::text || 'h ' || lpad(((p_seconds % 3600) / 60)::text, 2, '0') || 'm'
    ELSE (p_seconds / 86400)::text || 'd ' || ((p_seconds % 86400) / 3600)::text || 'h'
  END
$fn$;

-- The single source of truth for SLA status (mirrored by evaluateSla() in TS).
--   met      first response within the limit
--   late     first response, but after the limit
--   closed   never answered, but the ledger says it no longer needs us:
--            written_off (wrong number etc.) or already recovered
--   excused  only a quiet-hours-deferred text exists and the account excuses it
--   breached no response and the limit has passed
--   pending  no response yet, still inside the limit
CREATE OR REPLACE FUNCTION public.rescue_classify_sla(
  p_clock_start timestamptz,
  p_first_response timestamptz,
  p_deferred boolean,
  p_ledger_status text,
  p_limit_seconds integer,
  p_excuse_quiet_hours boolean,
  p_now timestamptz
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN p_first_response IS NOT NULL THEN
      CASE WHEN extract(epoch FROM (p_first_response - p_clock_start)) <= p_limit_seconds THEN 'met' ELSE 'late' END
    WHEN p_ledger_status IN ('written_off', 'recovered') THEN 'closed'
    WHEN coalesce(p_excuse_quiet_hours, false) AND coalesce(p_deferred, false) THEN 'excused'
    WHEN extract(epoch FROM (p_now - p_clock_start)) > p_limit_seconds THEN 'breached'
    ELSE 'pending'
  END
$fn$;

-- =============================================================
-- 6. THE TIMELINE  (internal: caller must already be owner-scoped)
-- =============================================================
/*
  kind      call_missed | text_sent | callback_attempt | followup_text |
            followup_call | customer_reply | manual_text | human_followup |
            link_click | booked | quote_sent | quote_accepted |
            quote_declined | payment_received | loop_stopped | closed
  outcome   ok | pending | failed | skipped | deferred | no_answer | info
  detail    free text for most kinds; for human_followup it is the raw
            call_queue_outcomes.outcome key; for loop_stopped it is the raw
            workflow_runs.stop_reason (both are prettified in TypeScript).
*/
CREATE OR REPLACE FUNCTION public.rescue_loop_events_for(p_owner uuid, p_call_ids uuid[])
RETURNS TABLE (
  ev_call_id uuid,
  ev_kind text,
  ev_at timestamptz,
  ev_outcome text,
  ev_channel text,
  ev_automated boolean,
  ev_detail text,
  ev_amount_cents integer,
  ev_ref_table text,
  ev_ref_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
WITH cs AS (
  SELECT c.id AS cid,
         c.call_datetime AS cat,
         public.rescue_phone_key(c.caller_phone) AS pkey,
         r.id AS ledger_id,
         r.source_type AS source_type,
         r.status AS ledger_status,
         r.resolved_at AS ledger_resolved_at,
         r.updated_at AS ledger_updated_at
  FROM calls c
  JOIN revenue_recovery_events r
    ON r.source_table = 'calls' AND r.source_id = c.id AND r.user_id = c.user_id
  WHERE c.user_id = p_owner
    AND c.id = ANY (p_call_ids)
    AND r.source_type IN ('missed_call', 'voicemail', 'not_booked')
),
-- Leads that belong to this caller: created from this call, or the same
-- phone number appearing within 14 days after the miss (a self-booked lead).
lds AS (
  SELECT DISTINCT cs.cid AS cid, l.id AS lead_id
  FROM cs
  JOIN leads l
    ON l.user_id = p_owner
   AND (
     l.call_id = cs.cid
     OR (
       cs.pkey IS NOT NULL
       AND public.rescue_phone_key(l.phone) = cs.pkey
       AND l.created_at >= cs.cat
       AND l.created_at < cs.cat + interval '14 days'
     )
   )
),
bj AS (
  SELECT DISTINCT cs.cid AS cid, j.id AS job_id, j.created_at AS job_at,
         j.job_status AS job_status, j.booking_channel AS booking_channel,
         j.invoice_amount AS invoice_amount
  FROM cs
  JOIN jobs j
    ON j.user_id = p_owner
   AND j.created_at >= cs.cat
   AND j.created_at < cs.cat + interval '14 days'
   AND (
     j.call_id = cs.cid
     OR j.lead_id IN (SELECT lds.lead_id FROM lds WHERE lds.cid = cs.cid)
   )
),
convs AS (
  SELECT DISTINCT cs.cid AS cid, sc.id AS conv_id
  FROM cs
  JOIN sms_conversations sc
    ON sc.user_id = p_owner
   AND cs.pkey IS NOT NULL
   AND public.rescue_phone_key(sc.customer_phone) = cs.pkey
)
SELECT u.*
FROM (
  -- 1. the miss itself
  SELECT cs.cid AS ev_call_id,
         'call_missed'::text AS ev_kind,
         cs.cat AS ev_at,
         'info'::text AS ev_outcome,
         'call'::text AS ev_channel,
         false AS ev_automated,
         (CASE cs.source_type
            WHEN 'missed_call' THEN 'Call missed'
            WHEN 'voicemail' THEN 'Caller left a voicemail'
            ELSE 'Call ended without a booking'
          END)::text AS ev_detail,
         NULL::integer AS ev_amount_cents,
         'calls'::text AS ev_ref_table,
         cs.cid AS ev_ref_id
  FROM cs

  UNION ALL
  -- 2. automatic workflow steps (call.missed playbook: text-back, callback)
  SELECT cs.cid,
         CASE s.step_type WHEN 'sms' THEN 'text_sent' ELSE 'callback_attempt' END,
         COALESCE(s.completed_at, s.started_at, s.scheduled_at),
         CASE
           WHEN wr.mode = 'test' THEN 'info'
           WHEN s.status = 'succeeded' AND COALESCE(s.result ->> 'sid', '') LIKE 'deferred:%' THEN 'deferred'
           WHEN s.status = 'succeeded' THEN 'ok'
           WHEN s.status IN ('pending', 'running', 'awaiting_approval') THEN 'pending'
           WHEN s.status = 'failed' THEN 'failed'
           ELSE 'skipped'
         END,
         CASE s.step_type WHEN 'sms' THEN 'sms' ELSE 'call' END,
         true,
         CASE
           WHEN wr.mode = 'test' THEN 'Test mode - nothing was sent'
           WHEN s.status = 'succeeded' AND COALESCE(s.result ->> 'sid', '') LIKE 'deferred:%'
             THEN 'Queued - the customer is in quiet hours'
           WHEN s.status = 'succeeded' AND s.step_type = 'sms' THEN 'Automatic text-back sent'
           WHEN s.status = 'succeeded' THEN 'Automatic callback placed'
           WHEN s.status = 'running' THEN 'In progress'
           WHEN s.status = 'awaiting_approval' THEN 'Waiting for approval'
           WHEN s.status = 'pending' AND COALESCE(s.error, '') <> '' THEN 'Retrying: ' || left(s.error, 160)
           WHEN s.status = 'pending' THEN 'Scheduled'
           WHEN s.status = 'failed' THEN 'Failed: ' || left(COALESCE(s.error, 'unknown error'), 160)
           WHEN s.error IS NOT NULL THEN 'Skipped: ' || left(s.error, 160)
           ELSE 'Skipped'
         END,
         NULL::integer,
         'workflow_run_steps',
         s.id
  FROM cs
  JOIN workflow_runs wr
    ON wr.user_id = p_owner AND wr.entity_type = 'call' AND wr.entity_id = cs.cid
  JOIN workflow_run_steps s
    ON s.run_id = wr.id AND s.step_type IN ('sms', 'call')

  UNION ALL
  -- 3. why the automatic loop ended early (opt-out, condition no longer true, failure)
  SELECT cs.cid,
         'loop_stopped',
         COALESCE(wr.completed_at, wr.started_at),
         'info',
         'none',
         true,
         wr.stop_reason,
         NULL::integer,
         'workflow_runs',
         wr.id
  FROM cs
  JOIN workflow_runs wr
    ON wr.user_id = p_owner AND wr.entity_type = 'call' AND wr.entity_id = cs.cid
  WHERE wr.status IN ('cancelled', 'failed') AND wr.stop_reason IS NOT NULL

  UNION ALL
  -- 4a. follow-up agent texts (existing outbound_sms log)
  SELECT cs.cid,
         'followup_text',
         COALESCE(o.sent_at, o.created_at),
         CASE o.status
           WHEN 'sent' THEN 'ok'
           WHEN 'delivered' THEN 'ok'
           WHEN 'queued' THEN 'pending'
           WHEN 'failed' THEN 'failed'
           ELSE 'skipped'
         END,
         'sms',
         true,
         CASE o.status
           WHEN 'opted_out' THEN 'Customer opted out'
           WHEN 'failed' THEN 'Failed: ' || left(COALESCE(o.outcome_notes, 'unknown error'), 160)
           ELSE 'Follow-up text, step ' || COALESCE(o.step_number::text, '1')
         END,
         NULL::integer,
         'outbound_sms',
         o.id
  FROM cs
  JOIN lds ON lds.cid = cs.cid
  JOIN outbound_sms o
    ON o.user_id = p_owner AND o.lead_id = lds.lead_id AND o.created_at >= cs.cat

  UNION ALL
  -- 4b. follow-up agent calls (existing outbound_calls log)
  SELECT cs.cid,
         'followup_call',
         COALESCE(o.called_at, o.scheduled_for),
         CASE o.status
           WHEN 'connected' THEN 'ok'
           WHEN 'converted' THEN 'ok'
           WHEN 'voicemail_left' THEN 'ok'
           WHEN 'no_answer' THEN 'no_answer'
           WHEN 'queued' THEN 'pending'
           WHEN 'calling' THEN 'pending'
           WHEN 'failed' THEN 'failed'
           ELSE 'skipped'
         END,
         'call',
         true,
         CASE o.status
           WHEN 'connected' THEN 'Customer answered'
           WHEN 'converted' THEN 'Customer answered and converted'
           WHEN 'voicemail_left' THEN 'Voicemail left'
           WHEN 'no_answer' THEN 'No answer'
           WHEN 'opted_out' THEN 'Customer opted out'
           WHEN 'failed' THEN 'Failed: ' || left(COALESCE(o.outcome_notes, 'unknown error'), 160)
           ELSE 'Follow-up call scheduled'
         END,
         NULL::integer,
         'outbound_calls',
         o.id
  FROM cs
  JOIN lds ON lds.cid = cs.cid
  JOIN outbound_calls o
    ON o.user_id = p_owner AND o.lead_id = lds.lead_id AND o.created_at >= cs.cat

  UNION ALL
  -- 5. inbox: customer replies + texts sent from the inbox (manual or AI auto-reply)
  SELECT cs.cid,
         CASE m.direction WHEN 'inbound' THEN 'customer_reply' ELSE 'manual_text' END,
         m.created_at,
         'ok',
         'sms',
         false,
         CASE m.direction
           WHEN 'inbound' THEN 'Customer replied by text'
           ELSE 'Reply sent from the inbox'
         END,
         NULL::integer,
         'sms_messages',
         m.id
  FROM cs
  JOIN convs ON convs.cid = cs.cid
  JOIN sms_messages m
    ON m.conversation_id = convs.conv_id
   AND m.created_at >= cs.cat
   AND m.created_at < cs.cat + interval '14 days'

  UNION ALL
  -- 6. a team member worked the item in the Priority Call Queue
  SELECT cs.cid,
         'human_followup',
         q.created_at,
         CASE
           WHEN q.outcome = 'no_answer' THEN 'no_answer'
           WHEN q.outcome IN ('wrong_number', 'do_not_contact') THEN 'info'
           ELSE 'ok'
         END,
         CASE q.channel WHEN 'sms' THEN 'sms' WHEN 'call' THEN 'call' ELSE 'none' END,
         false,
         q.outcome,
         NULL::integer,
         'call_queue_outcomes',
         q.id
  FROM cs
  JOIN call_queue_outcomes q
    ON q.user_id = p_owner AND q.source_table = 'revenue_recovery_events' AND q.source_id = cs.ledger_id

  UNION ALL
  -- 7. booking-link clicks (tracked link inside the text-back)
  SELECT cs.cid,
         'link_click',
         k.clicked_at,
         'ok',
         'web',
         false,
         'Opened the booking link',
         NULL::integer,
         'rescue_link_clicks',
         k.id
  FROM cs
  JOIN rescue_links rl ON rl.user_id = p_owner AND rl.call_id = cs.cid
  JOIN rescue_link_clicks k ON k.link_id = rl.id

  UNION ALL
  -- 8. booked job
  SELECT bj.cid,
         'booked',
         bj.job_at,
         CASE WHEN bj.job_status = 'cancelled' THEN 'failed' ELSE 'ok' END,
         CASE WHEN bj.booking_channel IS NOT NULL THEN 'web' ELSE 'none' END,
         false,
         CASE
           WHEN bj.job_status = 'cancelled' THEN 'Booking was cancelled'
           WHEN bj.booking_channel IS NOT NULL THEN 'Booked online (' || bj.booking_channel || ')'
           ELSE 'Job booked'
         END,
         NULL::integer,
         'jobs',
         bj.job_id
  FROM bj

  UNION ALL
  -- 9a. quote sent
  SELECT cs.cid,
         'quote_sent',
         q.sent_at,
         'ok',
         'none',
         false,
         'Quote sent to ' || COALESCE(NULLIF(btrim(q.customer_name), ''), 'the customer'),
         NULL::integer,
         'quotes',
         q.id
  FROM cs
  JOIN quotes q
    ON q.user_id = p_owner
   AND q.sent_at IS NOT NULL
   AND q.sent_at >= cs.cat
   AND q.sent_at < cs.cat + interval '14 days'
   AND (
     q.lead_id IN (SELECT lds.lead_id FROM lds WHERE lds.cid = cs.cid)
     OR (cs.pkey IS NOT NULL AND public.rescue_phone_key(q.customer_phone) = cs.pkey)
   )

  UNION ALL
  -- 9b. quote answered
  SELECT cs.cid,
         CASE q.status WHEN 'accepted' THEN 'quote_accepted' ELSE 'quote_declined' END,
         COALESCE(q.responded_at, q.updated_at),
         CASE q.status WHEN 'accepted' THEN 'ok' ELSE 'failed' END,
         'none',
         false,
         CASE q.status WHEN 'accepted' THEN 'Customer accepted the quote' ELSE 'Customer declined the quote' END,
         NULL::integer,
         'quotes',
         q.id
  FROM cs
  JOIN quotes q
    ON q.user_id = p_owner
   AND q.status IN ('accepted', 'declined')
   AND q.sent_at IS NOT NULL
   AND q.sent_at >= cs.cat
   AND q.sent_at < cs.cat + interval '14 days'
   AND (
     q.lead_id IN (SELECT lds.lead_id FROM lds WHERE lds.cid = cs.cid)
     OR (cs.pkey IS NOT NULL AND public.rescue_phone_key(q.customer_phone) = cs.pkey)
   )

  UNION ALL
  -- 10. payment received on an invoice for the booked job
  SELECT bj.cid,
         'payment_received',
         i.paid_at,
         'ok',
         'none',
         false,
         'Invoice ' || COALESCE(NULLIF(btrim(i.invoice_number), ''), '') || ' paid',
         CASE WHEN bj.invoice_amount IS NOT NULL THEN round(bj.invoice_amount * 100)::integer END,
         'invoices',
         i.id
  FROM bj
  JOIN invoices i
    ON i.user_id = p_owner AND i.job_id = bj.job_id AND i.paid_at IS NOT NULL

  UNION ALL
  -- 11. written off in the recovery ledger
  SELECT cs.cid,
         'closed',
         COALESCE(cs.ledger_resolved_at, cs.ledger_updated_at),
         'info',
         'none',
         false,
         'Closed out - no further follow-up needed',
         NULL::integer,
         'revenue_recovery_events',
         cs.ledger_id
  FROM cs
  WHERE cs.ledger_status = 'written_off'
) u
ORDER BY u.ev_call_id, u.ev_at, u.ev_kind
$fn$;

REVOKE ALL ON FUNCTION public.rescue_loop_events_for(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 7. PUBLIC RPCs (owner-scoped)
-- =============================================================

CREATE OR REPLACE FUNCTION public.rescue_loop_events(p_call_ids uuid[])
RETURNS TABLE (
  ev_call_id uuid,
  ev_kind text,
  ev_at timestamptz,
  ev_outcome text,
  ev_channel text,
  ev_automated boolean,
  ev_detail text,
  ev_amount_cents integer,
  ev_ref_table text,
  ev_ref_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_call_ids IS NULL OR cardinality(p_call_ids) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'p_call_ids must contain between 1 and 100 ids' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT * FROM public.rescue_loop_events_for(v_owner, p_call_ids);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rescue_loop_cases(
  p_since timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  rc_call_id uuid,
  rc_ledger_id uuid,
  rc_case_type text,
  rc_call_at timestamptz,
  rc_clock_start timestamptz,
  rc_caller_name text,
  rc_caller_phone text,
  rc_value_cents integer,
  rc_ledger_status text,
  rc_first_response_at timestamptz,
  rc_first_response_kind text,
  rc_response_seconds integer,
  rc_limit_seconds integer,
  rc_sla_status text,
  rc_deferred boolean,
  rc_booked_at timestamptz,
  rc_paid_at timestamptz,
  rc_last_event_at timestamptz,
  rc_event_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_limit integer;
  v_excuse boolean;
  v_since timestamptz;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT s.first_response_limit_seconds, s.excuse_quiet_hours
    INTO v_limit, v_excuse
  FROM rescue_sla_settings s
  WHERE s.user_id = v_owner;

  v_limit := COALESCE(v_limit, 60);
  v_excuse := COALESCE(v_excuse, true);
  v_since := COALESCE(p_since, now() - interval '30 days');

  RETURN QUERY
  WITH base AS (
    SELECT c.id AS call_id,
           r.id AS ledger_id,
           r.source_type AS source_type,
           r.status AS ledger_status,
           r.estimated_value_cents AS value_cents,
           c.call_datetime AS call_at,
           CASE
             WHEN r.source_type = 'not_booked'
               THEN c.call_datetime + make_interval(secs => COALESCE(c.duration_seconds, 0))
             ELSE c.call_datetime
           END AS clock_start,
           COALESCE(NULLIF(btrim(c.caller_name), ''), r.customer_name) AS caller_name,
           c.caller_phone AS caller_phone
    FROM revenue_recovery_events r
    JOIN calls c ON c.id = r.source_id
    WHERE r.source_table = 'calls'
      AND r.user_id = v_owner
      AND c.user_id = v_owner
      AND r.source_type IN ('missed_call', 'voicemail', 'not_booked')
      AND c.call_datetime >= v_since
    ORDER BY c.call_datetime DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
  ),
  ev AS (
    SELECT * FROM public.rescue_loop_events_for(v_owner, (SELECT array_agg(b.call_id) FROM base b))
  ),
  agg AS (
    SELECT e.ev_call_id AS call_id,
           min(e.ev_at) FILTER (
             WHERE e.ev_kind IN ('text_sent', 'callback_attempt', 'followup_text', 'followup_call', 'manual_text', 'human_followup')
               AND e.ev_outcome IN ('ok', 'no_answer')
           ) AS first_resp,
           (array_agg(e.ev_kind ORDER BY e.ev_at) FILTER (
             WHERE e.ev_kind IN ('text_sent', 'callback_attempt', 'followup_text', 'followup_call', 'manual_text', 'human_followup')
               AND e.ev_outcome IN ('ok', 'no_answer')
           ))[1] AS first_kind,
           COALESCE(bool_or(e.ev_outcome = 'deferred'), false) AS deferred,
           min(e.ev_at) FILTER (WHERE e.ev_kind = 'booked' AND e.ev_outcome = 'ok') AS booked_at,
           min(e.ev_at) FILTER (WHERE e.ev_kind = 'payment_received') AS paid_at,
           max(e.ev_at) FILTER (WHERE e.ev_outcome <> 'pending') AS last_at,
           count(*)::integer AS n
    FROM ev e
    GROUP BY e.ev_call_id
  )
  SELECT b.call_id,
         b.ledger_id,
         CASE b.source_type
           WHEN 'missed_call' THEN 'missed'
           WHEN 'voicemail' THEN 'voicemail'
           ELSE 'abandoned'
         END,
         b.call_at,
         b.clock_start,
         b.caller_name,
         b.caller_phone,
         b.value_cents,
         b.ledger_status,
         a.first_resp,
         a.first_kind,
         CASE
           WHEN a.first_resp IS NOT NULL
             THEN GREATEST(0, round(extract(epoch FROM (a.first_resp - b.clock_start)))::integer)
         END,
         v_limit,
         public.rescue_classify_sla(b.clock_start, a.first_resp, COALESCE(a.deferred, false), b.ledger_status, v_limit, v_excuse, now()),
         COALESCE(a.deferred, false),
         a.booked_at,
         a.paid_at,
         a.last_at,
         COALESCE(a.n, 0)
  FROM base b
  LEFT JOIN agg a ON a.call_id = b.call_id
  ORDER BY b.call_at DESC;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rescue_save_sla_settings(
  p_limit_seconds integer,
  p_alerts_enabled boolean,
  p_excuse_quiet_hours boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change SLA settings' USING ERRCODE = '42501';
  END IF;
  IF p_limit_seconds IS NULL OR p_limit_seconds NOT BETWEEN 10 AND 86400 THEN
    RAISE EXCEPTION 'The limit must be between 10 and 86400 seconds' USING ERRCODE = '22023';
  END IF;

  INSERT INTO rescue_sla_settings (user_id, first_response_limit_seconds, alerts_enabled, excuse_quiet_hours)
  VALUES (v_owner, p_limit_seconds, COALESCE(p_alerts_enabled, true), COALESCE(p_excuse_quiet_hours, true))
  ON CONFLICT (user_id) DO UPDATE
    SET first_response_limit_seconds = EXCLUDED.first_response_limit_seconds,
        alerts_enabled = EXCLUDED.alerts_enabled,
        excuse_quiet_hours = EXCLUDED.excuse_quiet_hours;
END
$fn$;

-- =============================================================
-- 8. TRACKED LINK: issue (service role only) + click (public)
-- =============================================================

CREATE OR REPLACE FUNCTION public.rescue_issue_link(p_user_id uuid, p_call_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_token text;
BEGIN
  INSERT INTO rescue_links (user_id, call_id)
  SELECT c.user_id, c.id
  FROM calls c
  WHERE c.id = p_call_id AND c.user_id = p_user_id
  ON CONFLICT (call_id) DO NOTHING;

  SELECT rl.token INTO v_token
  FROM rescue_links rl
  WHERE rl.call_id = p_call_id AND rl.user_id = p_user_id;

  RETURN v_token; -- NULL when the call does not belong to that account
END
$fn$;

CREATE OR REPLACE FUNCTION public.record_rescue_link_click(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_link_id uuid;
  v_user_id uuid;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{20}$' THEN
    RETURN;
  END IF;

  SELECT rl.id, rl.user_id INTO v_link_id, v_user_id
  FROM rescue_links rl
  WHERE rl.token = p_token;

  IF v_link_id IS NULL THEN
    RETURN; -- unknown token: silent, so the endpoint cannot be used to probe tokens
  END IF;

  -- One click per minute per link, at most 50 per link (reloads / abuse).
  IF EXISTS (
    SELECT 1 FROM rescue_link_clicks k
    WHERE k.link_id = v_link_id AND k.clicked_at > now() - interval '60 seconds'
  ) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM rescue_link_clicks k WHERE k.link_id = v_link_id) >= 50 THEN
    RETURN;
  END IF;

  INSERT INTO rescue_link_clicks (link_id, user_id) VALUES (v_link_id, v_user_id);
END
$fn$;

-- =============================================================
-- 9. THE MONITOR  (cron -> rescue-sla-monitor edge function -> this)
-- =============================================================

CREATE OR REPLACE FUNCTION public.rescue_sla_scan(p_lookback interval DEFAULT interval '48 hours')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rec record;
  v_owner uuid;
  v_n integer;
  v_limit integer;
  v_total integer := 0;
  v_who text;
  v_waited integer;
BEGIN
  -- Phase 1: give a verdict to every call that is past its limit and has none yet.
  FOR v_rec IN
    SELECT j.user_id, j.call_id, j.lim, j.status, j.resp_secs
    FROM (
      SELECT cand.user_id AS user_id,
             cand.call_id AS call_id,
             cand.lim AS lim,
             public.rescue_classify_sla(cand.clock_start, ev.first_resp, ev.deferred, cand.ledger_status, cand.lim, cand.excuse, now()) AS status,
             CASE
               WHEN ev.first_resp IS NOT NULL
                 THEN GREATEST(0, round(extract(epoch FROM (ev.first_resp - cand.clock_start)))::integer)
             END AS resp_secs
      FROM (
        SELECT r.user_id AS user_id,
               c.id AS call_id,
               r.status AS ledger_status,
               CASE
                 WHEN r.source_type = 'not_booked'
                   THEN c.call_datetime + make_interval(secs => COALESCE(c.duration_seconds, 0))
                 ELSE c.call_datetime
               END AS clock_start,
               COALESCE(s.first_response_limit_seconds, 60) AS lim,
               COALESCE(s.excuse_quiet_hours, true) AS excuse
        FROM revenue_recovery_events r
        JOIN calls c ON c.id = r.source_id AND c.user_id = r.user_id
        LEFT JOIN rescue_sla_settings s ON s.user_id = r.user_id
        WHERE r.source_table = 'calls'
          AND r.source_type IN ('missed_call', 'voicemail', 'not_booked')
          AND c.call_datetime > now() - p_lookback
          AND COALESCE(s.alerts_enabled, true)
          AND NOT EXISTS (SELECT 1 FROM rescue_sla_alerts a WHERE a.call_id = c.id)
      ) cand
      CROSS JOIN LATERAL (
        SELECT min(e.ev_at) FILTER (
                 WHERE e.ev_kind IN ('text_sent', 'callback_attempt', 'followup_text', 'followup_call', 'manual_text', 'human_followup')
                   AND e.ev_outcome IN ('ok', 'no_answer')
               ) AS first_resp,
               COALESCE(bool_or(e.ev_outcome = 'deferred'), false) AS deferred
        FROM public.rescue_loop_events_for(cand.user_id, ARRAY[cand.call_id]) e
      ) ev
      WHERE now() > cand.clock_start + make_interval(secs => cand.lim)
    ) j
    WHERE j.status <> 'pending'
  LOOP
    INSERT INTO rescue_sla_alerts (user_id, call_id, verdict, response_seconds, limit_seconds, notified)
    VALUES (
      v_rec.user_id,
      v_rec.call_id,
      CASE v_rec.status
        WHEN 'met' THEN 'met'
        WHEN 'excused' THEN 'excused'
        WHEN 'closed' THEN 'closed'
        ELSE 'breach'
      END,
      v_rec.resp_secs,
      v_rec.lim,
      v_rec.status IN ('met', 'excused', 'closed') -- nothing to tell anyone about
    )
    ON CONFLICT (call_id) DO NOTHING;
  END LOOP;

  -- Phase 2: one notification per breach, or one digest when a burst arrives.
  FOR v_owner IN
    SELECT DISTINCT a.user_id FROM rescue_sla_alerts a WHERE a.verdict = 'breach' AND NOT a.notified
  LOOP
    SELECT count(*)::integer, max(a.limit_seconds) INTO v_n, v_limit
    FROM rescue_sla_alerts a
    WHERE a.user_id = v_owner AND a.verdict = 'breach' AND NOT a.notified;

    IF v_n > 3 THEN
      INSERT INTO notifications (user_id, type, title, message, action_url, severity)
      VALUES (
        v_owner,
        'rescue_sla_breach',
        v_n::text || ' callers missed the ' || public.rescue_fmt_seconds(v_limit) || ' response limit',
        'Open the Rescue Loop to see who is still waiting for a response.',
        '/dashboard/rescue-loop?filter=attention',
        'high'
      );
    ELSE
      FOR v_rec IN
        SELECT a.id AS alert_id, a.call_id AS call_id, a.response_seconds AS response_seconds, a.limit_seconds AS limit_seconds,
               COALESCE(NULLIF(btrim(c.caller_name), ''), NULLIF(btrim(c.caller_phone), ''), 'Unknown caller') AS who,
               c.call_datetime AS call_at,
               COALESCE(r.estimated_value_cents, 0) AS value_cents,
               CASE
                 WHEN r.source_type = 'not_booked'
                   THEN c.call_datetime + make_interval(secs => COALESCE(c.duration_seconds, 0))
                 ELSE c.call_datetime
               END AS clock_start
        FROM rescue_sla_alerts a
        JOIN calls c ON c.id = a.call_id
        LEFT JOIN revenue_recovery_events r
          ON r.source_table = 'calls' AND r.source_id = c.id AND r.user_id = a.user_id
        WHERE a.user_id = v_owner AND a.verdict = 'breach' AND NOT a.notified
        ORDER BY c.call_datetime
      LOOP
        v_who := v_rec.who;
        v_waited := GREATEST(0, round(extract(epoch FROM (now() - v_rec.clock_start)))::integer);

        IF v_rec.response_seconds IS NULL THEN
          INSERT INTO notifications (user_id, type, title, message, action_url, severity)
          VALUES (
            v_owner,
            'rescue_sla_breach',
            'Caller still waiting for a response',
            v_who || ' called ' || public.rescue_fmt_seconds(v_waited) || ' ago and has had no response (limit '
              || public.rescue_fmt_seconds(v_rec.limit_seconds) || ').'
              || CASE WHEN v_rec.value_cents > 0
                   THEN ' Estimated value $' || to_char(v_rec.value_cents / 100.0, 'FM999999990.00') || '.'
                   ELSE '' END,
            '/dashboard/rescue-loop?call=' || v_rec.call_id::text,
            'high'
          );
        ELSE
          INSERT INTO notifications (user_id, type, title, message, action_url, severity)
          VALUES (
            v_owner,
            'rescue_sla_breach',
            'Slow response to a missed call',
            v_who || ' waited ' || public.rescue_fmt_seconds(v_rec.response_seconds) || ' for the first response (limit '
              || public.rescue_fmt_seconds(v_rec.limit_seconds) || ').',
            '/dashboard/rescue-loop?call=' || v_rec.call_id::text,
            'warning'
          );
        END IF;
      END LOOP;
    END IF;

    UPDATE rescue_sla_alerts
    SET notified = true
    WHERE user_id = v_owner AND verdict = 'breach' AND NOT notified;

    v_total := v_total + v_n;
  END LOOP;

  RETURN v_total;
END
$fn$;

-- =============================================================
-- 10. PRIVILEGES
-- Supabase grants EXECUTE on new functions to anon + authenticated by
-- default, so each function is revoked explicitly first.
-- =============================================================

REVOKE ALL ON FUNCTION public.rescue_loop_events(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rescue_loop_events(uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.rescue_loop_cases(timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rescue_loop_cases(timestamptz, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.rescue_save_sla_settings(integer, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rescue_save_sla_settings(integer, boolean, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.rescue_issue_link(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rescue_issue_link(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.rescue_sla_scan(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rescue_sla_scan(interval) TO service_role;

REVOKE ALL ON FUNCTION public.record_rescue_link_click(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_rescue_link_click(text) TO anon, authenticated;
