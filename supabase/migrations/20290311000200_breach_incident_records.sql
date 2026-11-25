/*
  # Breach incident records (staff only) - notification clock

  Vireek's OWN record of suspected/confirmed personal-data breaches, with the
  timestamps that start notification clocks, plus one row per notification sent.
  Process: docs/security/breach-notification.md. Deadlines are NOT stored here;
  they come from counsel-confirmed rules (docs/security/breach-notification-rules.json)
  and are computed by src/lib/breachNotification.ts.

  ## Access model
  - Staff only via public.is_vireek_staff(auth.uid()). Tenants have no access.
  - No DELETE for clients: these rows are evidence. service_role bypasses RLS.

  ## Integrity rules (guard trigger)
  - id, ref, created_at, created_by are immutable.
  - awareness_at may be set once and only moved EARLIER, never later (the clock
    cannot be quietly reset).
  - awareness_at / determination_at cannot be in the future (5 minute skew allowance).
  - Free text must not contain e-mail addresses (defence in depth, not a PII scanner).
    Store identifiers and counts only, never names or personal data.
*/

-- rollback: DROP TABLE public.breach_notifications; DROP TABLE public.breach_incident_records; DROP FUNCTION public.breach_incident_records_guard(); DROP FUNCTION public.breach_notifications_guard(); DROP SEQUENCE public.breach_incident_ref_seq; (destroys the evidence - only before it holds real data)

CREATE SEQUENCE IF NOT EXISTS public.breach_incident_ref_seq;

CREATE TABLE IF NOT EXISTS public.breach_incident_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE
    DEFAULT ('BR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.breach_incident_ref_seq')::text, 5, '0')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'assessing'
    CHECK (status IN ('assessing', 'confirmed_breach', 'not_a_breach', 'closed')),
  personal_data_involved text NOT NULL DEFAULT 'unknown'
    CHECK (personal_data_involved IN ('unknown', 'yes', 'no')),
  data_categories text[] NOT NULL DEFAULT '{}',
  jurisdictions text[] NOT NULL DEFAULT '{}',
  affected_tenant_count integer CHECK (affected_tenant_count IS NULL OR affected_tenant_count >= 0),
  affected_individuals_estimate integer CHECK (affected_individuals_estimate IS NULL OR affected_individuals_estimate >= 0),
  detected_at timestamptz NOT NULL DEFAULT now(),
  awareness_at timestamptz,
  determination_at timestamptz,
  contained_at timestamptz,
  counsel_engaged_at timestamptz,
  postmortem_ref text CHECK (postmortem_ref IS NULL OR char_length(btrim(postmortem_ref)) BETWEEN 3 AND 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT breach_records_timeline_check CHECK (
    (determination_at IS NULL OR awareness_at IS NOT NULL)
    AND (determination_at IS NULL OR determination_at >= awareness_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_breach_records_open
  ON public.breach_incident_records (status, awareness_at) WHERE status IN ('assessing', 'confirmed_breach');

CREATE TABLE IF NOT EXISTS public.breach_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.breach_incident_records(id) ON DELETE CASCADE,
  rule_id text NOT NULL CHECK (char_length(btrim(rule_id)) BETWEEN 1 AND 80),
  audience text NOT NULL CHECK (audience IN ('regulator', 'individuals', 'customers', 'other')),
  sent_at timestamptz NOT NULL,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'portal', 'postal', 'phone', 'other')),
  reference text CHECK (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 200),
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT breach_notifications_once UNIQUE (incident_id, rule_id)
);

-- Guard: breach_incident_records ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.breach_incident_records_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c_email constant text := '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}';
BEGIN
  IF NEW.title ~* c_email OR NEW.summary ~* c_email OR COALESCE(NEW.postmortem_ref, '') ~* c_email THEN
    RAISE EXCEPTION 'Do not store e-mail addresses or other personal data in a breach record.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.awareness_at > now() + interval '5 minutes' OR NEW.determination_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'awareness_at and determination_at cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.ref IS DISTINCT FROM OLD.ref
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'id, ref, created_at and created_by are immutable.' USING ERRCODE = '42501';
    END IF;
    IF OLD.awareness_at IS NOT NULL AND (NEW.awareness_at IS NULL OR NEW.awareness_at > OLD.awareness_at) THEN
      RAISE EXCEPTION 'awareness_at can only be moved earlier, never cleared or delayed.' USING ERRCODE = '22023';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_breach_incident_records_guard ON public.breach_incident_records;
CREATE TRIGGER trg_breach_incident_records_guard
  BEFORE INSERT OR UPDATE ON public.breach_incident_records
  FOR EACH ROW EXECUTE FUNCTION public.breach_incident_records_guard();

-- Guard: breach_notifications -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.breach_notifications_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.sent_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'sent_at cannot be in the future.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(NEW.reference, '') ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' THEN
    RAISE EXCEPTION 'Do not store e-mail addresses in a notification reference.' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.recorded_by := auth.uid();
    NEW.created_at := now();
  ELSIF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
     OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'incident_id, rule_id and audit fields are immutable.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_breach_notifications_guard ON public.breach_notifications;
CREATE TRIGGER trg_breach_notifications_guard
  BEFORE INSERT OR UPDATE ON public.breach_notifications
  FOR EACH ROW EXECUTE FUNCTION public.breach_notifications_guard();

-- RLS: staff only, no client DELETE ---------------------------------------------------

ALTER TABLE public.breach_incident_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breach_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.breach_incident_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.breach_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.breach_incident_records TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.breach_notifications TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.breach_incident_ref_seq TO authenticated;
GRANT ALL ON public.breach_incident_records TO service_role;
GRANT ALL ON public.breach_notifications TO service_role;

DROP POLICY IF EXISTS "staff_select_breach_records" ON public.breach_incident_records;
CREATE POLICY "staff_select_breach_records" ON public.breach_incident_records
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_insert_breach_records" ON public.breach_incident_records;
CREATE POLICY "staff_insert_breach_records" ON public.breach_incident_records
  FOR INSERT TO authenticated
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_update_breach_records" ON public.breach_incident_records;
CREATE POLICY "staff_update_breach_records" ON public.breach_incident_records
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())))
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_select_breach_notifications" ON public.breach_notifications;
CREATE POLICY "staff_select_breach_notifications" ON public.breach_notifications
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_insert_breach_notifications" ON public.breach_notifications;
CREATE POLICY "staff_insert_breach_notifications" ON public.breach_notifications
  FOR INSERT TO authenticated
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_update_breach_notifications" ON public.breach_notifications;
CREATE POLICY "staff_update_breach_notifications" ON public.breach_notifications
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())))
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));
