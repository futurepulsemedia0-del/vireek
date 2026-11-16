/*
  # AI incident register (staff only)

  Vireek's OWN register of incidents involving its AI agents (wrong diagnosis, wrong price
  commitment, PII leak on a call, discriminatory behavior, prompt injection). It is the
  system of record for the process in docs/compliance/policies/ai-incident-response.md.

  ## Access model
  - Staff only: profiles.is_staff via is_vireek_staff(auth.uid())
    (20260913020000_live_chat_and_academy.sql). Tenants have NO access of any kind, so a
    tenant can never read another tenant's incident, nor its own.
  - No DELETE for clients: incident records are evidence. service_role bypasses RLS.
  - The optional tenant_id is only a pointer ("which account was affected"); it is set to
    NULL if that account is erased, the incident itself is kept.

  ## What it must never hold
  Raw prompts, transcripts, names, phone numbers, e-mail addresses. Store identifiers
  (call_id, ai_security_events.id) and short factual descriptions only. A guard trigger
  rejects obvious e-mail addresses in free text as defence in depth (it is NOT a PII scanner).

  ## Integrity rules enforced by the guard trigger
  - id, ref, created_at, reported_by are immutable; reported_by is always the caller.
  - contained_at / resolved_at are maintained from status, never client-supplied.
  - A high or critical incident cannot move to 'closed' without a postmortem reference.
  - detected_at cannot be in the future (5 minute clock-skew allowance).

  ## Rollback (manual, destroys the register — only before it holds real data)
  DROP TABLE public.ai_incidents; DROP FUNCTION public.ai_incidents_guard(); DROP SEQUENCE public.ai_incidents_ref_seq;
*/

-- rollback: DROP TABLE public.ai_incidents; DROP FUNCTION public.ai_incidents_guard(); DROP SEQUENCE public.ai_incidents_ref_seq; (destroys the register - only before it holds real data)

CREATE SEQUENCE IF NOT EXISTS public.ai_incidents_ref_seq;

CREATE TABLE IF NOT EXISTS public.ai_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE
    DEFAULT ('AI-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.ai_incidents_ref_seq')::text, 5, '0')),
  incident_type text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  title text NOT NULL,
  summary text NOT NULL,
  source text NOT NULL DEFAULT 'staff_review',
  owner_role text NOT NULL DEFAULT 'ai_safety_lead',
  tenant_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  related_security_event_id uuid REFERENCES public.ai_security_events(id) ON DELETE SET NULL,
  call_id text,
  customer_notification text NOT NULL DEFAULT 'not_assessed',
  regulator_notification text NOT NULL DEFAULT 'not_assessed',
  postmortem_ref text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  contained_at timestamptz,
  resolved_at timestamptz,
  reported_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_incidents_type_check CHECK (incident_type IN (
    'wrong_diagnosis', 'wrong_price_commitment', 'pii_leak_on_call',
    'discriminatory_behavior', 'prompt_injection', 'other'
  )),
  CONSTRAINT ai_incidents_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT ai_incidents_status_check CHECK (status IN ('open', 'investigating', 'contained', 'resolved', 'closed')),
  CONSTRAINT ai_incidents_source_check CHECK (source IN (
    'ai_security_event', 'customer_report', 'staff_review', 'vdp_report', 'monitoring', 'other'
  )),
  CONSTRAINT ai_incidents_owner_role_check CHECK (owner_role IN (
    'ai_safety_lead', 'security_lead', 'engineering_lead', 'support_lead', 'legal_counsel'
  )),
  CONSTRAINT ai_incidents_customer_notification_check CHECK (customer_notification IN (
    'not_assessed', 'not_required', 'counsel_review', 'sent'
  )),
  CONSTRAINT ai_incidents_regulator_notification_check CHECK (regulator_notification IN (
    'not_assessed', 'not_required', 'counsel_review', 'sent'
  )),
  CONSTRAINT ai_incidents_title_check CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  CONSTRAINT ai_incidents_summary_check CHECK (char_length(btrim(summary)) BETWEEN 10 AND 4000),
  CONSTRAINT ai_incidents_call_id_check CHECK (call_id IS NULL OR char_length(call_id) BETWEEN 1 AND 128),
  CONSTRAINT ai_incidents_postmortem_check CHECK (postmortem_ref IS NULL OR char_length(btrim(postmortem_ref)) BETWEEN 3 AND 500),
  CONSTRAINT ai_incidents_timeline_check CHECK (
    (contained_at IS NULL OR contained_at >= detected_at)
    AND (resolved_at IS NULL OR resolved_at >= detected_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_incidents_created ON public.ai_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_incidents_open
  ON public.ai_incidents (severity, detected_at DESC) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_ai_incidents_tenant
  ON public.ai_incidents (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_incidents_event
  ON public.ai_incidents (related_security_event_id) WHERE related_security_event_id IS NOT NULL;

-- =============================================================
-- GUARD TRIGGER (validation, immutability, derived timestamps)
-- =============================================================

CREATE OR REPLACE FUNCTION public.ai_incidents_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c_email constant text := '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}';
BEGIN
  IF NEW.title ~* c_email OR NEW.summary ~* c_email OR COALESCE(NEW.postmortem_ref, '') ~* c_email THEN
    RAISE EXCEPTION 'Do not store e-mail addresses or other personal data in an incident record. Use identifiers (call id, event id) instead.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.detected_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'detected_at cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.reported_by := auth.uid();
    NEW.created_at := now();
    NEW.contained_at := NULL;
    NEW.resolved_at := NULL;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.ref IS DISTINCT FROM OLD.ref
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.reported_by IS DISTINCT FROM OLD.reported_by THEN
      RAISE EXCEPTION 'id, ref, created_at and reported_by are immutable.' USING ERRCODE = '42501';
    END IF;
    NEW.contained_at := OLD.contained_at;
    NEW.resolved_at := OLD.resolved_at;
  END IF;

  IF NEW.status IN ('contained', 'resolved', 'closed') THEN
    NEW.contained_at := COALESCE(NEW.contained_at, GREATEST(now(), NEW.detected_at));
  END IF;
  IF NEW.status IN ('resolved', 'closed') THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, GREATEST(now(), NEW.detected_at));
  ELSE
    NEW.resolved_at := NULL; -- re-opened
  END IF;
  IF NEW.status IN ('open', 'investigating') THEN
    NEW.contained_at := NULL;
  END IF;

  IF NEW.status = 'closed' AND NEW.severity IN ('high', 'critical') AND NEW.postmortem_ref IS NULL THEN
    RAISE EXCEPTION 'A high or critical incident needs a postmortem reference before it can be closed.'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_incidents_guard ON public.ai_incidents;
CREATE TRIGGER trg_ai_incidents_guard
  BEFORE INSERT OR UPDATE ON public.ai_incidents
  FOR EACH ROW EXECUTE FUNCTION public.ai_incidents_guard();

-- =============================================================
-- RLS: staff only. No DELETE policy and no DELETE grant.
-- =============================================================

ALTER TABLE public.ai_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_incidents TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ai_incidents_ref_seq TO authenticated;

DROP POLICY IF EXISTS "staff_select_ai_incidents" ON public.ai_incidents;
CREATE POLICY "staff_select_ai_incidents" ON public.ai_incidents
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_insert_ai_incidents" ON public.ai_incidents;
CREATE POLICY "staff_insert_ai_incidents" ON public.ai_incidents
  FOR INSERT TO authenticated
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_update_ai_incidents" ON public.ai_incidents;
CREATE POLICY "staff_update_ai_incidents" ON public.ai_incidents
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((SELECT auth.uid())))
  WITH CHECK (public.is_vireek_staff((SELECT auth.uid())));
