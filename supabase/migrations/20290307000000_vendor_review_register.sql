/*
# Vendor review register + scheduled reminders (admin-only)

## Why
docs/compliance/policies/vendor-management.md lists "annual review process" as a gap the owner must close.
This adds the durable register that process needs: one row per vendor with its criticality, when it was last
reviewed, the evidence for that review, and when the next review is due. A daily job opens reminders; a
cron-secret edge function (vendor-review-reminders) e-mails Vireek staff.
Vendors are seeded from code (scripts/compliance/gen-vendor-review-seed.mjs), not typed by hand.

## What this adds (purely additive, idempotent)
- vendor_reviews                   one row per vendor (platform / supplier / tenant-chosen connector / public API).
- vendor_review_evidence_valid()   CHECK helper: evidence_links must be [{label, url}] with https URLs or docs/ paths.
- vendor_review_state()            single definition of retired / never_reviewed / overdue / due_soon / current.
- vendor_reviews_before_write()    BEFORE INSERT/UPDATE: trims text, computes next_due_on from last_reviewed_on +
                                   review_interval_months (unless staff set it), marks manual criticality edits,
                                   handles retire/reactivate, immutable created_at/created_by.
- vendor_reviews_audit()           AFTER INSERT/UPDATE: staff_audit_log row (ids and criticality only, never notes/evidence).
- vendor_review_status_v           status view (security_invoker): state + days until due.
- vendor_review_reminders          one OPEN reminder per vendor; closed automatically when the state clears.
- vendor_review_evaluate_reminders()  idempotent evaluator (service role / pg_cron, daily when pg_cron is enabled).
- vendor_review_claim_notifications() / vendor_review_release_notifications()
                                   atomic claim for the e-mail job (FOR UPDATE SKIP LOCKED; release on total failure).
- Seed block at the end: every vendor found in code. Criticality is a PROPOSAL from the vendor-exit tier. [VERIFY]

## Security model
- Vireek-internal compliance data, NOT tenant data. No customer role can read it. Every policy requires
  is_vireek_staff((select auth.uid())); anon has no privileges.
- NO DELETE privilege and NO DELETE policy: vendors are retired (status = 'retired'), never deleted, so the
  review history survives. Retention is a counsel decision. [COUNSEL]
- Reminder rows are written only by SECURITY DEFINER functions granted to service_role. Staff can read them.
- Evidence is a LINK (https URL or a repository path under docs/), never the document itself. URLs with embedded
  credentials and path traversal are rejected. Do not put secrets, contract text or personal data in notes.
- A recorded review MUST carry an outcome and at least one evidence link: the register cannot claim a review
  without pointing at what was reviewed. The register itself proves nothing about the vendor. [VERIFY]

## Policy values that are proposals, not decisions
- review_interval_months defaults to 12 ("annual review", per the draft policy). Management decides per criticality.
- Reminder lead time is 30 days; overdue reminders repeat every 7 days. Management decides.

## Requires
is_vireek_staff(uuid), staff_audit_log, auth.users, profiles. pg_cron is optional (see the scheduling block).

## Rollback (manual, destructive; run only on purpose, in this order)
SELECT cron.unschedule('vireek-vendor-review-evaluate');   -- only if pg_cron is installed
DROP FUNCTION public.vendor_review_release_notifications(uuid[]), public.vendor_review_claim_notifications(integer, integer),
  public.vendor_review_evaluate_reminders(integer);
DROP VIEW public.vendor_review_status_v;
DROP TABLE public.vendor_review_reminders, public.vendor_reviews;
DROP FUNCTION public.vendor_reviews_audit(), public.vendor_reviews_before_write(),
  public.vendor_review_state(text, date, date, integer, date), public.vendor_review_evidence_valid(jsonb);
*/

-- rollback: see the commented block above (unschedule the job, drop 3 functions, the view, the two tables, then the helper functions). Review records may be audit evidence: do NOT run without the compliance owner's sign-off. [COUNSEL]

DO $$
BEGIN
  IF to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regclass('public.staff_audit_log') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'vendor_review_register: prerequisites missing (is_vireek_staff, staff_audit_log, profiles)';
  END IF;
END $$;

-- 1. Helpers --------------------------------------------------------------------------------------
-- evidence_links = [{"label": "...", "url": "https://..." | "docs/..."}], at most 20, nothing else per element.
CREATE OR REPLACE FUNCTION public.vendor_review_evidence_valid(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN false
    WHEN jsonb_array_length(p) > 20 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p) AS e
       WHERE NOT coalesce(
         CASE WHEN jsonb_typeof(e) = 'object' THEN
                (e - 'label' - 'url') = '{}'::jsonb
            AND jsonb_typeof(e -> 'label') = 'string'
            AND jsonb_typeof(e -> 'url') = 'string'
            AND char_length(btrim(e ->> 'label')) BETWEEN 1 AND 120
            AND (e ->> 'url') ~ '^(https://[^[:space:]]{1,500}|docs/[A-Za-z0-9_./-]{1,300})$'
            AND (e ->> 'url') !~ '\.\.'
            AND (e ->> 'url') !~ '^https://[^/]*@'
              ELSE false END,
         false)
    )
  END;
$$;

-- One definition of "where is this vendor in its review cycle", used by the view and the evaluator.
CREATE OR REPLACE FUNCTION public.vendor_review_state(
  p_status text, p_last_reviewed_on date, p_next_due_on date, p_lead_days integer, p_today date
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_status IS DISTINCT FROM 'active' THEN 'retired'
    WHEN p_next_due_on IS NOT NULL AND p_next_due_on < p_today THEN 'overdue'
    WHEN p_last_reviewed_on IS NULL AND p_next_due_on IS NULL THEN 'never_reviewed'
    WHEN p_next_due_on IS NOT NULL AND p_next_due_on <= p_today + greatest(coalesce(p_lead_days, 0), 0) THEN 'due_soon'
    ELSE 'current'
  END;
$$;

-- 2. Register ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable slug: the vendor-exit provider slug (docs/vendor-exit/<slug>.md) where one exists.
  vendor_key text NOT NULL UNIQUE CHECK (vendor_key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  vendor_name text NOT NULL CHECK (char_length(vendor_name) BETWEEN 1 AND 200),
  vendor_kind text NOT NULL CHECK (vendor_kind IN ('platform', 'supplier', 'customer', 'public')),
  criticality text NOT NULL CHECK (criticality IN ('critical', 'high', 'medium', 'low')),
  criticality_source text NOT NULL DEFAULT 'manual' CHECK (criticality_source IN ('vendor_exit_tier', 'proposed', 'manual')),
  -- Listed on the published sub-processor list (src/lib/subprocessors.ts). Counsel owns that list. [COUNSEL]
  is_subprocessor boolean NOT NULL DEFAULT false,
  -- A role or team (e.g. "Head of Engineering"), not a person's name or contact data.
  owner_role text CHECK (owner_role IS NULL OR char_length(owner_role) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_on date,
  review_interval_months integer NOT NULL DEFAULT 12 CHECK (review_interval_months BETWEEN 1 AND 36),
  last_reviewed_on date CHECK (last_reviewed_on IS NULL OR last_reviewed_on >= DATE '2020-01-01'),
  last_review_outcome text CHECK (last_review_outcome IS NULL OR last_review_outcome IN
    ('satisfactory', 'satisfactory_with_conditions', 'unsatisfactory')),
  evidence_links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (public.vendor_review_evidence_valid(evidence_links)),
  next_due_on date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A review is date + outcome + at least one evidence link, or none of them.
  CONSTRAINT vendor_reviews_review_complete CHECK (
    (last_reviewed_on IS NULL AND last_review_outcome IS NULL)
    OR (last_reviewed_on IS NOT NULL AND last_review_outcome IS NOT NULL AND jsonb_array_length(evidence_links) >= 1)
  ),
  CONSTRAINT vendor_reviews_due_after_review CHECK (
    next_due_on IS NULL OR last_reviewed_on IS NULL OR next_due_on >= last_reviewed_on
  ),
  CONSTRAINT vendor_reviews_retired_matches_status CHECK (
    (status = 'active' AND retired_on IS NULL) OR (status = 'retired' AND retired_on IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vendor_reviews_next_due
  ON public.vendor_reviews (next_due_on) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_criticality
  ON public.vendor_reviews (criticality, vendor_name);

COMMENT ON TABLE public.vendor_reviews IS 'Vireek vendor review register. Staff only (RLS). No delete: retire instead. Evidence is a link, never the document. Proves nothing about the vendor by itself.';
COMMENT ON COLUMN public.vendor_reviews.criticality IS 'Proposed from the vendor-exit tier (1 critical, 2 high, 3 medium; tenant-chosen connectors and public APIs low). Management decides. [VERIFY]';
COMMENT ON COLUMN public.vendor_reviews.evidence_links IS 'Array of {label, url}; url is https or a repo path under docs/. No credentials in URLs, no secrets.';

-- 3. Write-time normalisation -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vendor_reviews_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_recompute boolean := false;
BEGIN
  NEW.vendor_key := lower(btrim(NEW.vendor_key));
  NEW.vendor_name := btrim(NEW.vendor_name);
  NEW.owner_role := nullif(btrim(coalesce(NEW.owner_role, '')), '');
  NEW.notes := nullif(btrim(coalesce(NEW.notes, '')), '');

  IF NEW.last_reviewed_on IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.last_reviewed_on IS DISTINCT FROM OLD.last_reviewed_on)
     AND NEW.last_reviewed_on > current_date + 1 THEN
    RAISE EXCEPTION 'last_reviewed_on_in_future' USING ERRCODE = '22023';
  END IF;

  -- A criticality change that leaves criticality_source untouched is a manual staff decision.
  IF TG_OP = 'UPDATE'
     AND NEW.criticality IS DISTINCT FROM OLD.criticality
     AND NEW.criticality_source IS NOT DISTINCT FROM OLD.criticality_source THEN
    NEW.criticality_source := 'manual';
  END IF;

  -- Retire / reactivate.
  IF NEW.status = 'retired' AND NEW.retired_on IS NULL THEN
    NEW.retired_on := current_date;
  ELSIF NEW.status = 'active' THEN
    NEW.retired_on := NULL;
  END IF;

  -- next_due_on follows the review unless staff set it explicitly in the same write.
  IF NEW.last_reviewed_on IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_recompute := NEW.next_due_on IS NULL;
    ELSE
      v_recompute := NEW.next_due_on IS NULL
        OR ((NEW.last_reviewed_on IS DISTINCT FROM OLD.last_reviewed_on
             OR NEW.review_interval_months IS DISTINCT FROM OLD.review_interval_months)
            AND NEW.next_due_on IS NOT DISTINCT FROM OLD.next_due_on);
    END IF;
    IF v_recompute THEN
      NEW.next_due_on := (NEW.last_reviewed_on + make_interval(months => NEW.review_interval_months))::date;
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

DROP TRIGGER IF EXISTS trg_vendor_reviews_before_write ON public.vendor_reviews;
CREATE TRIGGER trg_vendor_reviews_before_write
  BEFORE INSERT OR UPDATE ON public.vendor_reviews
  FOR EACH ROW EXECUTE FUNCTION public.vendor_reviews_before_write();

-- 4. Audit trail (ids and criticality only; never notes or evidence) ---------------------------------
CREATE OR REPLACE FUNCTION public.vendor_reviews_audit()
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
          jsonb_build_object('view', 'vendor_review_change', 'op', TG_OP, 'vendor_id', NEW.id,
                             'vendor_key', NEW.vendor_key, 'criticality', NEW.criticality, 'status', NEW.status));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_reviews_audit ON public.vendor_reviews;
CREATE TRIGGER trg_vendor_reviews_audit
  AFTER INSERT OR UPDATE ON public.vendor_reviews
  FOR EACH ROW EXECUTE FUNCTION public.vendor_reviews_audit();

-- 5. Reminders --------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_review_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendor_reviews(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initial_review', 'due_soon', 'overdue')),
  due_on date,
  opened_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  notification_count integer NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR resolution IN ('cleared', 'retired', 'superseded')),
  CONSTRAINT vendor_review_reminders_resolved_matches CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

-- At most one OPEN reminder per vendor; the kind changes by superseding the old row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_review_reminders_open
  ON public.vendor_review_reminders (vendor_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_review_reminders_pending
  ON public.vendor_review_reminders (opened_at) WHERE resolved_at IS NULL;

COMMENT ON TABLE public.vendor_review_reminders IS 'Open/closed review reminders. Written only by vendor_review_* functions (service role); staff read.';

-- 6. Status view ----------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vendor_review_status_v
WITH (security_invoker = true) AS
SELECT
  v.id,
  v.vendor_key,
  v.vendor_name,
  v.vendor_kind,
  v.criticality,
  v.is_subprocessor,
  v.owner_role,
  v.status,
  v.review_interval_months,
  v.last_reviewed_on,
  v.last_review_outcome,
  jsonb_array_length(v.evidence_links) AS evidence_count,
  v.next_due_on,
  public.vendor_review_state(v.status, v.last_reviewed_on, v.next_due_on, 30, current_date) AS review_state,
  (v.next_due_on - current_date) AS days_until_due
FROM public.vendor_reviews v;

COMMENT ON VIEW public.vendor_review_status_v IS 'Review state per vendor (30-day lead). security_invoker: staff only through the table RLS.';

-- 7. Evaluator (service role / pg_cron) --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vendor_review_evaluate_reminders(p_lead_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_opened integer := 0;
  v_resolved integer := 0;
BEGIN
  IF p_lead_days IS NULL OR p_lead_days < 0 OR p_lead_days > 180 THEN
    RAISE EXCEPTION 'invalid_lead_days' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('vendor_review_evaluate_reminders')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already_running');
  END IF;

  -- Close first: vendor retired, state cleared, or the kind changed (superseded by a new row below).
  WITH want AS (
    SELECT v.id AS vendor_id, v.status,
           CASE public.vendor_review_state(v.status, v.last_reviewed_on, v.next_due_on, p_lead_days, v_today)
             WHEN 'never_reviewed' THEN 'initial_review'
             WHEN 'overdue' THEN 'overdue'
             WHEN 'due_soon' THEN 'due_soon'
             ELSE NULL
           END AS kind
      FROM public.vendor_reviews v
  ), closing AS (
    SELECT o.id,
           CASE WHEN w.status = 'retired' THEN 'retired'
                WHEN w.kind IS NULL THEN 'cleared'
                ELSE 'superseded' END AS resolution
      FROM public.vendor_review_reminders o
      JOIN want w ON w.vendor_id = o.vendor_id
     WHERE o.resolved_at IS NULL
       AND w.kind IS DISTINCT FROM o.kind
  )
  UPDATE public.vendor_review_reminders t
     SET resolved_at = now(), resolution = closing.resolution
    FROM closing
   WHERE t.id = closing.id;
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  INSERT INTO public.vendor_review_reminders (vendor_id, kind, due_on)
  SELECT v.id,
         CASE public.vendor_review_state(v.status, v.last_reviewed_on, v.next_due_on, p_lead_days, v_today)
           WHEN 'never_reviewed' THEN 'initial_review'
           WHEN 'overdue' THEN 'overdue'
           ELSE 'due_soon'
         END,
         v.next_due_on
    FROM public.vendor_reviews v
   WHERE public.vendor_review_state(v.status, v.last_reviewed_on, v.next_due_on, p_lead_days, v_today)
         IN ('never_reviewed', 'overdue', 'due_soon')
  ON CONFLICT (vendor_id) WHERE resolved_at IS NULL DO NOTHING;
  GET DIAGNOSTICS v_opened = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'opened', v_opened,
    'resolved', v_resolved,
    'open_total', (SELECT count(*) FROM public.vendor_review_reminders WHERE resolved_at IS NULL)
  );
END;
$$;

-- 8. Notification claim (atomic; used by the vendor-review-reminders edge function) -------------------
-- Picks open reminders never notified, plus overdue ones last notified more than p_renotify_days ago, marks
-- them notified in the same statement, and returns them. Concurrent callers never get the same row.
CREATE OR REPLACE FUNCTION public.vendor_review_claim_notifications(p_limit integer DEFAULT 200, p_renotify_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  IF p_renotify_days IS NULL OR p_renotify_days < 1 OR p_renotify_days > 90 THEN
    RAISE EXCEPTION 'invalid_renotify_days' USING ERRCODE = '22023';
  END IF;

  WITH picked AS (
    SELECT o.id, (o.notified_at IS NOT NULL) AS was_notified
      FROM public.vendor_review_reminders o
     WHERE o.resolved_at IS NULL
       AND (o.notified_at IS NULL
            OR (o.kind = 'overdue' AND o.notified_at < now() - make_interval(days => p_renotify_days)))
     ORDER BY o.opened_at, o.id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.vendor_review_reminders o
       SET notified_at = now(), notification_count = o.notification_count + 1
      FROM picked p
     WHERE o.id = p.id
    RETURNING o.id, o.vendor_id, o.kind, o.due_on, p.was_notified
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reminder_id', u.id,
           'vendor_key', v.vendor_key,
           'vendor_name', v.vendor_name,
           'criticality', v.criticality,
           'kind', u.kind,
           'due_on', u.due_on,
           'last_reviewed_on', v.last_reviewed_on,
           'is_subprocessor', v.is_subprocessor,
           'renotified', u.was_notified
         ) ORDER BY u.due_on NULLS FIRST, v.vendor_name), '[]'::jsonb)
    INTO v_result
    FROM upd u
    JOIN public.vendor_reviews v ON v.id = u.vendor_id;

  RETURN v_result;
END;
$$;

-- If NOTHING could be delivered, give the claim back so the next run retries.
CREATE OR REPLACE FUNCTION public.vendor_review_release_notifications(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN
    RETURN 0;
  END IF;
  UPDATE public.vendor_review_reminders
     SET notified_at = NULL, notification_count = greatest(notification_count - 1, 0)
   WHERE id = ANY (p_ids) AND resolved_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- 9. RLS and privileges: Vireek staff only, no delete --------------------------------------------------
ALTER TABLE public.vendor_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_review_reminders ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.vendor_review_reminders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vendor_review_status_v FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.vendor_reviews TO authenticated;
GRANT SELECT ON TABLE public.vendor_review_reminders TO authenticated;
GRANT SELECT ON public.vendor_review_status_v TO authenticated;

REVOKE ALL ON FUNCTION public.vendor_reviews_before_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_reviews_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_review_evaluate_reminders(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_review_claim_notifications(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_review_release_notifications(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_review_evaluate_reminders(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendor_review_claim_notifications(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendor_review_release_notifications(uuid[]) TO service_role;

DROP POLICY IF EXISTS vendor_reviews_staff_select ON public.vendor_reviews;
CREATE POLICY vendor_reviews_staff_select ON public.vendor_reviews
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS vendor_reviews_staff_insert ON public.vendor_reviews;
CREATE POLICY vendor_reviews_staff_insert ON public.vendor_reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_vireek_staff((select auth.uid()))
    AND created_by IS NOT DISTINCT FROM (select auth.uid())
  );

DROP POLICY IF EXISTS vendor_reviews_staff_update ON public.vendor_reviews;
CREATE POLICY vendor_reviews_staff_update ON public.vendor_reviews
  FOR UPDATE TO authenticated
  USING (public.is_vireek_staff((select auth.uid())))
  WITH CHECK (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS vendor_review_reminders_staff_select ON public.vendor_review_reminders;
CREATE POLICY vendor_review_reminders_staff_select ON public.vendor_review_reminders
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff((select auth.uid())));

-- Deliberately NO delete policy and NO delete privilege. Reminders have no client write policy at all.

-- 10. Daily schedule (pg_cron when available) -------------------------------------------------------
-- The e-mail itself is sent by the vendor-review-reminders edge function (header X-Cron-Secret =
-- TRUST_CRON_SECRET); schedule it once a day from your external scheduler, after this job.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-vendor-review-evaluate', '23 6 * * *', 'select public.vendor_review_evaluate_reminders()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled: call public.vendor_review_evaluate_reminders() daily from an external scheduler (service role), or just call the vendor-review-reminders function, which runs it first.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'vendor_review: could not schedule vireek-vendor-review-evaluate (%). Schedule vendor_review_evaluate_reminders() externally.', SQLERRM;
END $$;

-- 11. Seed: every vendor found in code. Criticality = proposal from the vendor-exit tier. [VERIFY] ----
-- Existing rows are never touched (ON CONFLICT DO NOTHING), so re-running cannot overwrite a staff decision.
-- BEGIN GENERATED:vendor_seed
INSERT INTO public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality, criticality_source, is_subprocessor)
VALUES
  ('supabase', 'Supabase', 'platform', 'critical', 'vendor_exit_tier', true),
  ('vercel', 'Vercel', 'supplier', 'high', 'vendor_exit_tier', true),
  ('cloudflare', 'Cloudflare', 'supplier', 'high', 'vendor_exit_tier', true),
  ('pagerduty', 'PagerDuty', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('package-cdns', 'Package and script CDNs (esm.sh, jsDelivr)', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('gemini', 'Google Gemini API', 'supplier', 'critical', 'vendor_exit_tier', true),
  ('groq', 'Groq', 'supplier', 'medium', 'vendor_exit_tier', true),
  ('cerebras', 'Cerebras', 'supplier', 'medium', 'vendor_exit_tier', true),
  ('openrouter', 'OpenRouter', 'supplier', 'medium', 'vendor_exit_tier', true),
  ('anthropic', 'Anthropic', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('cohere', 'Cohere', 'supplier', 'high', 'vendor_exit_tier', false),
  ('vapi', 'Vapi', 'supplier', 'critical', 'vendor_exit_tier', true),
  ('twilio', 'Twilio', 'supplier', 'critical', 'vendor_exit_tier', false),
  ('telnyx', 'Telnyx', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('sinch', 'Sinch (RCS / Apple Messages for Business)', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('elevenlabs', 'ElevenLabs', 'supplier', 'high', 'vendor_exit_tier', false),
  ('daily', 'Daily.co', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('resend', 'Resend', 'supplier', 'critical', 'vendor_exit_tier', true),
  ('lob', 'Lob', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('meta', 'Meta (WhatsApp, Messenger, Facebook)', 'supplier', 'high', 'vendor_exit_tier', false),
  ('telegram', 'Telegram', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('slack', 'Slack', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('microsoft', 'Microsoft (Graph, Teams, Calendar)', 'supplier', 'high', 'vendor_exit_tier', false),
  ('apple', 'Apple (APNs, Wallet pass push)', 'supplier', 'high', 'vendor_exit_tier', false),
  ('google', 'Google (OAuth, Calendar, Business Profile, Ads, Maps/Places, Sheets/BigQuery/Storage, Wallet, FCM)', 'supplier', 'high', 'vendor_exit_tier', true),
  ('stripe', 'Stripe', 'supplier', 'critical', 'vendor_exit_tier', true),
  ('plaid', 'Plaid', 'supplier', 'high', 'vendor_exit_tier', false),
  ('wisetack', 'Wisetack', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('taxjar', 'TaxJar', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('checkr', 'Checkr', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('quickbooks', 'QuickBooks Online (Intuit)', 'customer', 'low', 'vendor_exit_tier', true),
  ('xero', 'Xero', 'customer', 'low', 'vendor_exit_tier', false),
  ('intacct', 'Sage Intacct', 'customer', 'low', 'vendor_exit_tier', false),
  ('netsuite', 'NetSuite (Oracle)', 'customer', 'low', 'vendor_exit_tier', false),
  ('zoho', 'Zoho (CRM and Books)', 'customer', 'low', 'vendor_exit_tier', false),
  ('gusto', 'Gusto (payroll connector)', 'customer', 'low', 'vendor_exit_tier', false),
  ('hubspot', 'HubSpot', 'customer', 'low', 'vendor_exit_tier', false),
  ('crm-connectors', 'CRM connectors (Salesforce, Pipedrive)', 'customer', 'low', 'vendor_exit_tier', false),
  ('jobber', 'Jobber', 'customer', 'low', 'vendor_exit_tier', false),
  ('housecall-pro', 'Housecall Pro', 'customer', 'low', 'vendor_exit_tier', false),
  ('servicetitan', 'ServiceTitan', 'customer', 'low', 'vendor_exit_tier', false),
  ('pm-suites', 'Property-management suites (Buildium, Propertyware, Rentvine, AppFolio, Yardi)', 'customer', 'low', 'vendor_exit_tier', false),
  ('samsara', 'Samsara (telematics)', 'customer', 'low', 'vendor_exit_tier', false),
  ('yelp', 'Yelp', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('property-data-providers', 'Property data providers (RentCast, ATTOM)', 'supplier', 'medium', 'vendor_exit_tier', false),
  ('customer-data-destinations', 'Customer-chosen data destinations (Splunk, Datadog, Snowflake, Klaviyo)', 'customer', 'low', 'vendor_exit_tier', false),
  ('public-data-apis', 'Public and open data APIs (NWS, Census, FEMA, NASA, EIA, USGS, Open-Meteo, OSM, OSRM, FX)', 'public', 'low', 'vendor_exit_tier', false),
  ('sentry', 'Sentry (Functional Software, Inc.)', 'supplier', 'medium', 'proposed', true),
  ('zapier', 'Zapier', 'customer', 'low', 'proposed', true)
ON CONFLICT (vendor_key) DO NOTHING;
-- END GENERATED:vendor_seed
