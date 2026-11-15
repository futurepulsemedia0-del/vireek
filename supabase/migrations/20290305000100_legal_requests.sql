/*
# Legal request log (admin-only)

## Why
Vireek may receive legal process about customer data (subpoenas, court orders, warrants, preservation or
emergency-disclosure requests, regulator inquiries). Each one needs a durable, counted, auditable record so the
company can answer "how many, from where, what did we do" and publish a transparency report
(docs/compliance/transparency-report-template.md). Handling steps: docs/compliance/legal-request-process.md.
Copyright takedowns stay in dmca_notices (20270502000000); they are NOT duplicated here.

## What this adds (purely additive)
- legal_requests            one row per request: type, jurisdiction, dates, scope summary, outcome, counts.
- legal_requests_before_write()  BEFORE INSERT/UPDATE: trims text, de-duplicates data categories, makes
                            created_at / created_by immutable, stamps updated_at / updated_by.
- legal_requests_audit()    AFTER INSERT/UPDATE: writes a staff_audit_log row (existing action 'explorer_list',
                            metadata.view = 'legal_request_change'). Metadata holds ids and outcome only,
                            never scope text.
- legal_requests_counts     counts view by half-year / type / country / outcome. security_invoker = true.

## Security model
- Vireek-internal legal data, NOT tenant data. No customer role can read it. Every policy requires
  is_vireek_staff((select auth.uid())); anon has no privileges.
- NO DELETE privilege and NO DELETE policy: legal records are closed, never deleted. Retention and any
  deletion are a counsel decision. [COUNSEL]
- Do not store the content of requests, customer data or privileged advice here. scope_summary describes
  WHAT KIND of data was requested (categories), not the data. Keep the documents in the counsel-controlled
  repository and reference them by `reference`.
- Process guardrail (configurable policy, [COUNSEL] to confirm): an outcome that discloses data
  (complied_in_full / complied_in_part) requires counsel_reviewed_on, except for emergency_disclosure
  requests, which may be reviewed after the fact.

## Requires
is_vireek_staff(uuid), staff_audit_log, auth.users, profiles.

## Rollback (manual, destructive; run only on purpose)
DROP VIEW public.legal_requests_counts;
DROP TABLE public.legal_requests;
DROP FUNCTION public.legal_requests_audit();
DROP FUNCTION public.legal_requests_before_write();
*/

-- rollback: see the commented block above (drop the view, the table, then the two trigger functions). Legal records may be subject to a legal hold: do NOT run without counsel sign-off. [COUNSEL]

DO $$
BEGIN
  IF to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regclass('public.staff_audit_log') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'legal_requests: prerequisites missing (is_vireek_staff, staff_audit_log, profiles)';
  END IF;
END $$;

-- 1. Table ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Internal case number or the counsel-repository reference. Not the requester's personal data.
  reference text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 80),
  request_type text NOT NULL CHECK (request_type IN (
    'subpoena', 'court_order', 'search_warrant', 'preservation_request', 'emergency_disclosure',
    'regulator_inquiry', 'civil_discovery', 'other'
  )),
  jurisdiction_country text NOT NULL CHECK (jurisdiction_country ~ '^[A-Z]{2}$'),
  jurisdiction_region text CHECK (jurisdiction_region IS NULL OR char_length(jurisdiction_region) BETWEEN 1 AND 80),
  -- Agency or court (an organisation, not an individual officer).
  requesting_authority text NOT NULL CHECK (char_length(requesting_authority) BETWEEN 1 AND 200),
  received_on date NOT NULL CHECK (received_on >= DATE '2020-01-01'),
  due_on date,
  responded_on date,
  closed_on date,
  scope_summary text NOT NULL CHECK (char_length(scope_summary) BETWEEN 1 AND 2000),
  data_categories text[] NOT NULL DEFAULT '{}'::text[],
  accounts_affected integer NOT NULL DEFAULT 0 CHECK (accounts_affected BETWEEN 0 AND 1000000),
  nondisclosure_order boolean NOT NULL DEFAULT false,
  customer_notice text NOT NULL DEFAULT 'pending_counsel'
    CHECK (customer_notice IN ('not_applicable', 'pending_counsel', 'notified', 'delayed_by_order', 'prohibited_by_order')),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN (
    'pending', 'complied_in_full', 'complied_in_part', 'objected', 'challenged',
    'rejected_invalid', 'no_data_found', 'withdrawn_by_requester'
  )),
  counsel_reviewed_on date,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_requests_categories_valid CHECK (
    data_categories <@ ARRAY[
      'subscriber_info', 'call_metadata', 'call_recordings', 'transcripts', 'messages',
      'account_records', 'billing_records', 'location_data', 'other'
    ]::text[]
  ),
  CONSTRAINT legal_requests_dates_ordered CHECK (
    (due_on IS NULL OR due_on >= received_on)
    AND (responded_on IS NULL OR responded_on >= received_on)
    AND (closed_on IS NULL OR closed_on >= received_on)
    AND (counsel_reviewed_on IS NULL OR counsel_reviewed_on >= received_on)
  ),
  -- A pending request is open; any other outcome means it was closed on a date.
  CONSTRAINT legal_requests_closed_matches_outcome CHECK (
    (outcome = 'pending' AND closed_on IS NULL) OR (outcome <> 'pending' AND closed_on IS NOT NULL)
  ),
  -- [COUNSEL] confirm this guardrail: disclosure needs a recorded counsel review (emergencies may follow after).
  CONSTRAINT legal_requests_disclosure_needs_review CHECK (
    outcome NOT IN ('complied_in_full', 'complied_in_part')
    OR counsel_reviewed_on IS NOT NULL
    OR request_type = 'emergency_disclosure'
  ),
  -- Only disclosing outcomes can carry affected accounts.
  CONSTRAINT legal_requests_accounts_need_disclosure CHECK (
    accounts_affected = 0 OR outcome IN ('pending', 'complied_in_full', 'complied_in_part')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_legal_requests_reference
  ON public.legal_requests (lower(reference)) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legal_requests_received
  ON public.legal_requests (received_on DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_requests_open_due
  ON public.legal_requests (due_on) WHERE outcome = 'pending';

COMMENT ON TABLE public.legal_requests IS 'Vireek-internal legal request log. Staff only (RLS). No delete. Never store request content or customer data here.';

-- 2. Write-time normalisation ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_requests_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.reference := nullif(btrim(coalesce(NEW.reference, '')), '');
  NEW.jurisdiction_country := upper(btrim(NEW.jurisdiction_country));
  NEW.jurisdiction_region := nullif(btrim(coalesce(NEW.jurisdiction_region, '')), '');
  NEW.requesting_authority := btrim(NEW.requesting_authority);
  NEW.scope_summary := btrim(NEW.scope_summary);
  NEW.data_categories := ARRAY(SELECT DISTINCT c FROM unnest(NEW.data_categories) AS c ORDER BY c);

  IF TG_OP = 'INSERT' OR NEW.received_on IS DISTINCT FROM OLD.received_on THEN
    IF NEW.received_on > current_date + 1 THEN
      RAISE EXCEPTION 'received_on_in_future' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_by := auth.uid();
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_requests_before_write ON public.legal_requests;
CREATE TRIGGER trg_legal_requests_before_write
  BEFORE INSERT OR UPDATE ON public.legal_requests
  FOR EACH ROW EXECUTE FUNCTION public.legal_requests_before_write();

-- 3. Audit trail (ids and outcome only; never scope text) ---------------------------------------
CREATE OR REPLACE FUNCTION public.legal_requests_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO public.staff_audit_log (staff_id, staff_email, action, metadata)
  VALUES (auth.uid(), v_email, 'explorer_list',
          jsonb_build_object('view', 'legal_request_change', 'op', TG_OP, 'request_id', NEW.id, 'outcome', NEW.outcome));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_requests_audit ON public.legal_requests;
CREATE TRIGGER trg_legal_requests_audit
  AFTER INSERT OR UPDATE ON public.legal_requests
  FOR EACH ROW EXECUTE FUNCTION public.legal_requests_audit();

-- 4. RLS: Vireek staff only, no delete ---------------------------------------------------------
ALTER TABLE public.legal_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.legal_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.legal_requests TO authenticated;
REVOKE ALL ON FUNCTION public.legal_requests_before_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.legal_requests_audit() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS legal_requests_staff_select ON public.legal_requests;
CREATE POLICY legal_requests_staff_select ON public.legal_requests
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS legal_requests_staff_insert ON public.legal_requests;
CREATE POLICY legal_requests_staff_insert ON public.legal_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_vireek_staff((select auth.uid()))
    AND created_by IS NOT DISTINCT FROM (select auth.uid())
  );

DROP POLICY IF EXISTS legal_requests_staff_update ON public.legal_requests;
CREATE POLICY legal_requests_staff_update ON public.legal_requests
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((select auth.uid())))
  WITH CHECK (public.is_vireek_staff((select auth.uid())));

-- Deliberately NO delete policy and NO delete privilege.

-- 5. Counts view -----------------------------------------------------------------------------------
-- One row per half-year / type / country / outcome. Counts are exact: any small-number bucketing or
-- suppression for PUBLICATION is a counsel decision and is applied in the report, not here. [COUNSEL]
CREATE OR REPLACE VIEW public.legal_requests_counts
WITH (security_invoker = true) AS
SELECT
  to_char(l.received_on, 'YYYY') || '-H' || (CASE WHEN extract(month FROM l.received_on) <= 6 THEN '1' ELSE '2' END) AS period,
  l.request_type,
  l.jurisdiction_country,
  l.outcome,
  count(*)::int AS requests,
  coalesce(sum(l.accounts_affected), 0)::bigint AS accounts_affected,
  (count(*) FILTER (WHERE l.nondisclosure_order))::int AS nondisclosure_orders
FROM public.legal_requests l
GROUP BY 1, l.request_type, l.jurisdiction_country, l.outcome;

REVOKE ALL ON public.legal_requests_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.legal_requests_counts TO authenticated;

COMMENT ON VIEW public.legal_requests_counts IS 'Legal request counts by half-year, type, country and outcome. security_invoker: staff only through the table RLS.';
