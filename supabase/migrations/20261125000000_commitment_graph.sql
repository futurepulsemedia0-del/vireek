/*
  # Commitment Graph

  Extracts promises/expectations from free text (call transcripts, quote
  notes, job notes, outbound SMS) using rule-based phrase matching — no
  external LLM call, consistent with the rest of this codebase (see
  technician_scorecards.ai_coaching_notes: "rule-based, not an LLM call").

  Every commitment is linked to: who made it (owner), who it's for
  (customer/job/lead), what was promised, when it's due, and — once
  someone resolves it — whether it was kept or broken. That kept/broken
  history is what turns this into a measurable trust ledger over time.

  ## New columns
  - jobs.notes / quotes.notes — didn't exist before; needed as a text
    source for extraction. If your live project already has a notes
    field under a different name/table, point the triggers at that
    instead of these.

  ## Pipeline
  extract_commitments(...) is called by triggers on calls / jobs.notes /
  quotes.notes / outbound_sms, and can also be called directly (e.g. from
  an edge function that ingests a two-way SMS thread you may already have).
*/

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS notes text;

-- =============================================================
-- COMMITMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  source_type text NOT NULL CHECK (source_type IN ('call', 'sms', 'quote', 'job_note', 'manual')),
  source_id uuid,
  source_excerpt text NOT NULL,

  owner_type text NOT NULL DEFAULT 'csr' CHECK (owner_type IN ('csr', 'technician', 'system', 'customer', 'unknown')),
  owner_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  owner_name text,

  customer_name text,
  customer_phone text,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,

  commitment_text text NOT NULL,
  deadline_text text,
  deadline_at timestamptz,

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'broken', 'unclear')),
  resolution_note text,
  resolved_at timestamptz,

  confidence text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low', 'medium', 'high')),
  detected_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_type, source_id, source_excerpt)
);

CREATE INDEX IF NOT EXISTS idx_commitments_user_status ON commitments(user_id, status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_commitments_owner ON commitments(owner_team_member_id);
CREATE INDEX IF NOT EXISTS idx_commitments_job ON commitments(job_id);

ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_commitments" ON commitments;
CREATE POLICY "select_own_commitments" ON commitments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_commitments" ON commitments;
CREATE POLICY "update_own_commitments" ON commitments FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
-- No client INSERT policy — rows are only created by extract_commitments()
-- (via triggers) or create_manual_commitment() below, so dedupe/ownership
-- checks can never be bypassed by a hand-crafted insert.

-- =============================================================
-- Deadline resolver: "today" / "tomorrow" / weekday names / "in N days/hours"
-- Anything else is left unresolved (deadline_text still captured for a human to read).
-- =============================================================
CREATE OR REPLACE FUNCTION public.resolve_deadline_phrase(p_sentence text, p_reference_time timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_text text := lower(p_sentence);
  v_hours_match text;
  v_days_match text;
  v_day_names text[] := ARRAY['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  v_target_dow integer;
  v_current_dow integer;
  v_offset integer;
  i integer;
BEGIN
  IF v_text ~ '(today|end of day|eod|tonight|this afternoon|this morning)' THEN
    RETURN date_trunc('day', p_reference_time) + interval '18 hours';
  END IF;

  IF v_text ~ 'tomorrow' THEN
    RETURN date_trunc('day', p_reference_time) + interval '1 day' + interval '18 hours';
  END IF;

  v_hours_match := substring(v_text FROM 'in (\d+)\s*hours?');
  IF v_hours_match IS NOT NULL THEN
    RETURN p_reference_time + (v_hours_match::int || ' hours')::interval;
  END IF;

  v_days_match := substring(v_text FROM 'in (\d+)\s*days?');
  IF v_days_match IS NOT NULL THEN
    RETURN date_trunc('day', p_reference_time) + (v_days_match::int || ' days')::interval + interval '18 hours';
  END IF;

  FOR i IN 1..7 LOOP
    IF v_text ~ v_day_names[i] THEN
      v_target_dow := i; -- 1=monday .. 7=sunday, matches ISODOW
      v_current_dow := extract(isodow FROM p_reference_time);
      v_offset := v_target_dow - v_current_dow;
      IF v_offset <= 0 THEN v_offset := v_offset + 7; END IF;
      RETURN date_trunc('day', p_reference_time) + (v_offset || ' days')::interval + interval '18 hours';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

-- =============================================================
-- Extraction: scans free text for promise-shaped sentences
-- =============================================================
CREATE OR REPLACE FUNCTION public.extract_commitments(
  p_user_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_text text,
  p_reference_time timestamptz,
  p_owner_type text DEFAULT 'unknown',
  p_owner_team_member_id uuid DEFAULT NULL,
  p_owner_name text DEFAULT NULL,
  p_customer_name text DEFAULT NULL,
  p_customer_phone text DEFAULT NULL,
  p_job_id uuid DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sentence text;
  v_deadline timestamptz;
  v_count integer := 0;
  -- promise-shaped phrases: first-person future commitments, explicit
  -- promise verbs, and "X will Y" statements about parts/quotes/arrivals.
  v_promise_regex text := '(i''ll |i will |we will |we''ll |will send|will call|will arrive|will be there|will get (you|it)|will follow up|will have (it|the)|promised|promise to|going to send|going to call|part will|quote will|technician will|expect(ed)? (it |the )?to (arrive|be here))';
BEGIN
  IF p_text IS NULL OR length(trim(p_text)) = 0 THEN RETURN 0; END IF;

  FOR v_sentence IN SELECT trim(s) FROM regexp_split_to_table(p_text, '[.!?\n]+') AS s
  LOOP
    IF length(v_sentence) < 5 THEN CONTINUE; END IF;
    IF lower(v_sentence) ~ v_promise_regex THEN
      v_deadline := public.resolve_deadline_phrase(v_sentence, p_reference_time);

      INSERT INTO commitments (
        user_id, source_type, source_id, source_excerpt,
        owner_type, owner_team_member_id, owner_name,
        customer_name, customer_phone, job_id, lead_id,
        commitment_text, deadline_text, deadline_at, confidence
      )
      VALUES (
        p_user_id, p_source_type, p_source_id, v_sentence,
        p_owner_type, p_owner_team_member_id, p_owner_name,
        p_customer_name, p_customer_phone, p_job_id, p_lead_id,
        v_sentence,
        CASE WHEN v_deadline IS NOT NULL THEN trim(substring(lower(v_sentence) FROM '(today|tomorrow|tonight|end of day|eod|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in \d+\s*(hours?|days?))')) ELSE NULL END,
        v_deadline,
        CASE WHEN v_deadline IS NOT NULL THEN 'high' ELSE 'low' END
      )
      ON CONFLICT (source_type, source_id, source_excerpt) DO NOTHING;

      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.extract_commitments(uuid, text, uuid, text, timestamptz, text, uuid, text, text, text, uuid, uuid) TO authenticated, service_role;

-- =============================================================
-- Manual logging (for a verbal promise nothing captured in text)
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_manual_commitment(
  p_commitment_text text,
  p_owner_team_member_id uuid,
  p_customer_name text,
  p_job_id uuid DEFAULT NULL,
  p_deadline_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid; v_owner_name text;
BEGIN
  SELECT member_name INTO v_owner_name FROM team_members WHERE id = p_owner_team_member_id AND account_owner_id = public.get_account_owner_id();
  INSERT INTO commitments (user_id, source_type, source_excerpt, owner_type, owner_team_member_id, owner_name, customer_name, job_id, commitment_text, deadline_at, confidence)
  VALUES (public.get_account_owner_id(), 'manual', p_commitment_text, 'technician', p_owner_team_member_id, v_owner_name, p_customer_name, p_job_id, p_commitment_text, p_deadline_at, 'high')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_manual_commitment(text, uuid, text, uuid, timestamptz) TO authenticated;

-- =============================================================
-- Resolve: mark kept / broken / unclear
-- =============================================================
CREATE OR REPLACE FUNCTION public.resolve_commitment(p_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('kept', 'broken', 'unclear', 'open') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE commitments SET status = p_status, resolution_note = p_note, resolved_at = CASE WHEN p_status IN ('kept','broken') THEN now() ELSE NULL END
  WHERE id = p_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_commitment(uuid, text, text) TO authenticated;

-- =============================================================
-- Trust score per owner (the measurable-trust payoff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_commitment_trust_scores(p_user_id uuid)
RETURNS TABLE (owner_team_member_id uuid, owner_name text, total_resolved bigint, kept_count bigint, broken_count bigint, trust_pct numeric, open_overdue bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  RETURN QUERY
  SELECT
    c.owner_team_member_id, COALESCE(max(c.owner_name), 'Unassigned'),
    count(*) FILTER (WHERE c.status IN ('kept', 'broken')),
    count(*) FILTER (WHERE c.status = 'kept'),
    count(*) FILTER (WHERE c.status = 'broken'),
    CASE WHEN count(*) FILTER (WHERE c.status IN ('kept', 'broken')) = 0 THEN NULL
      ELSE round(100.0 * count(*) FILTER (WHERE c.status = 'kept') / count(*) FILTER (WHERE c.status IN ('kept', 'broken')), 1) END,
    count(*) FILTER (WHERE c.status = 'open' AND c.deadline_at IS NOT NULL AND c.deadline_at < now())
  FROM commitments c
  WHERE c.user_id = p_user_id
  GROUP BY c.owner_team_member_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_commitment_trust_scores(uuid) TO authenticated;

-- =============================================================
-- Triggers: automatic extraction from confirmed existing text sources
-- =============================================================
CREATE OR REPLACE FUNCTION public.trg_extract_from_call()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.transcript IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.transcript IS DISTINCT FROM OLD.transcript) THEN
    PERFORM public.extract_commitments(NEW.user_id, 'call', NEW.id, NEW.transcript, NEW.call_datetime, 'csr', NULL, 'Call agent', NEW.caller_name, NEW.caller_phone, NULL, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commitments_from_calls ON calls;
CREATE TRIGGER trg_commitments_from_calls AFTER INSERT OR UPDATE OF transcript ON calls
  FOR EACH ROW EXECUTE FUNCTION public.trg_extract_from_call();

CREATE OR REPLACE FUNCTION public.trg_extract_from_job_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.notes IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.notes IS DISTINCT FROM OLD.notes) THEN
    PERFORM public.extract_commitments(NEW.user_id, 'job_note', NEW.id, NEW.notes, now(), 'technician', NEW.assigned_technician_id, NULL, NEW.customer_name, NULL, NEW.id, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commitments_from_job_notes ON jobs;
CREATE TRIGGER trg_commitments_from_job_notes AFTER INSERT OR UPDATE OF notes ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.trg_extract_from_job_note();

CREATE OR REPLACE FUNCTION public.trg_extract_from_quote_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.notes IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.notes IS DISTINCT FROM OLD.notes) THEN
    PERFORM public.extract_commitments(NEW.user_id, 'quote', NEW.id, NEW.notes, now(), 'csr', NULL, NULL, NEW.customer_name, NEW.customer_phone, NULL, NEW.lead_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commitments_from_quote_notes ON quotes;
CREATE TRIGGER trg_commitments_from_quote_notes AFTER INSERT OR UPDATE OF notes ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.trg_extract_from_quote_note();

CREATE OR REPLACE FUNCTION public.trg_extract_from_outbound_sms()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.extract_commitments(NEW.user_id, 'sms', NEW.id, NEW.body, now(), 'system', NULL, 'Automated message', NEW.customer_name, NEW.customer_phone, NEW.job_id, NEW.lead_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commitments_from_outbound_sms ON outbound_sms;
CREATE TRIGGER trg_commitments_from_outbound_sms AFTER INSERT ON outbound_sms
  FOR EACH ROW EXECUTE FUNCTION public.trg_extract_from_outbound_sms();
