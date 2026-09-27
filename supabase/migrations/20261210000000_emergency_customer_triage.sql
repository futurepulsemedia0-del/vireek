/*
  # Emergency Customer Self-Triage (before the phone call)

  ## Why
  Emergency Operations Mode (20261121000000) already triages OPEN JOBS that
  already exist. It has nothing for the moment before a job exists at all —
  a customer who just noticed a gas smell or a burst pipe and hasn't called
  yet. This adds that front door.

  ## Design decisions worth knowing
  1. **Reuses the existing portal token**, not a new token type. Any
     customer who already has a portal link (/portal/:token) can reach
     /emergency/:token. No new column, no new link to hand out.
  2. **Gated by the two flags that already exist and already mean exactly
     this**: `business_profile.allow_customer_portal` (customer-facing
     surface is on) AND `business_profile.emergency_ops_enabled` (this
     business wants AI-driven emergency handling). A business with either
     off gets the same indistinguishable NULL as an invalid token — same
     privacy posture as get_customer_portal_bundle.
  3. **Severity reuses `emergency_priority_for_job()`** (from
     20261121000000) instead of a second, parallel scoring function. Hazard
     checkboxes are translated into the same keyword vocabulary that
     function already understands, so a customer-reported "gas" hazard and
     a dispatcher-typed "gas leak" service type land on identical tiers.
  4. **Immediate safety instructions are NOT generated here.** They ship as
     a fixed, reviewed lookup table in the client (see
     src/lib/emergencyTriage.ts) so "turn off the gas and leave the house"
     never depends on a network round trip, an AI provider being up, or a
     model choosing its own wording for a life-safety instruction. This
     function's job is severity + trade + dispatch, not safety copy.
  5. **Auto-dispatch is intentionally narrow**: only critical/high tiers,
     only when a dispatch-enabled technician is actually free today, and
     only ever assigns — never cancels or reassigns an existing job. A
     standard-tier report is logged into the existing triage queue for a
     human to actioned, same as everything else that lands there today.
  6. **Media (photo/voice) is optional and stored per-submission**, in a
     token-namespaced storage path so the SELECT policy can scope reads to
     the owning business without adding a new customer_id join.
*/

-- =============================================================
-- 1. Submission log (append-only from the customer's side)
-- =============================================================

CREATE TABLE IF NOT EXISTS emergency_triage_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,

  what_happened text,
  hazards text[] NOT NULL DEFAULT '{}',
  started_at_label text,
  photo_path text,
  audio_path text,

  priority_tier text NOT NULL CHECK (priority_tier IN ('critical', 'high', 'standard')),
  priority_score int NOT NULL DEFAULT 0,
  reason text,
  required_trade text,

  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  assigned_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ets_user_created ON emergency_triage_submissions(user_id, created_at DESC);

ALTER TABLE emergency_triage_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_emergency_triage_submissions" ON emergency_triage_submissions;
CREATE POLICY "select_own_emergency_triage_submissions" ON emergency_triage_submissions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Deliberately no INSERT/UPDATE/DELETE policy for authenticated or anon —
-- every row is written only by submit_emergency_triage() below (SECURITY
-- DEFINER, runs as postgres), same pattern as portal_requests.

-- =============================================================
-- 2. Storage for optional photo / voice-note evidence
-- =============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('emergency-triage-media', 'emergency-triage-media', false)
ON CONFLICT (id) DO NOTHING;

-- Anyone can upload — the "secret" is knowing the portal token that forms
-- the folder prefix (emergency-triage-media/<token>/<filename>), same
-- trust model as the token itself. Nothing is readable without it.
DROP POLICY IF EXISTS "anon_upload_emergency_triage_media" ON storage.objects;
CREATE POLICY "anon_upload_emergency_triage_media"
ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket_id = 'emergency-triage-media');

-- The owning business can read back exactly what it received, and nothing
-- from any other tenant's customers.
DROP POLICY IF EXISTS "business_read_own_emergency_triage_media" ON storage.objects;
CREATE POLICY "business_read_own_emergency_triage_media"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'emergency-triage-media'
  AND EXISTS (
    SELECT 1 FROM customers c
    WHERE c.portal_token::text = (storage.foldername(name))[1]
      AND c.user_id = public.get_account_owner_id()
  )
);

-- =============================================================
-- 3. Write: customer submits a triage report
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_emergency_triage(
  p_token uuid,
  p_what_happened text,
  p_hazards text[],
  p_started_at text,
  p_photo_path text DEFAULT NULL,
  p_audio_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_portal_enabled boolean;
  v_emergency_enabled boolean;
  v_signal text;
  v_required_trade text;
  v_priority record;
  v_submission_id uuid;
  v_job_id uuid;
  v_tech record;
  v_assigned boolean := false;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(bp.allow_customer_portal, false), COALESCE(bp.emergency_ops_enabled, false)
  INTO v_portal_enabled, v_emergency_enabled
  FROM business_profile bp WHERE bp.user_id = v_customer.user_id;

  IF NOT COALESCE(v_portal_enabled, false) OR NOT COALESCE(v_emergency_enabled, false) THEN
    RETURN NULL;
  END IF;

  -- Translate hazard checkboxes into the keyword vocabulary
  -- emergency_priority_for_job() already scores, so both paths (customer
  -- self-report and dispatcher-typed service type) share one scorer.
  v_signal := COALESCE(p_what_happened, '');
  IF 'gas' = ANY(p_hazards) THEN
    v_signal := v_signal || ' gas leak';
    v_required_trade := 'plumbing';
  END IF;
  IF 'water' = ANY(p_hazards) THEN
    v_signal := v_signal || ' active leak flooding';
    v_required_trade := COALESCE(v_required_trade, 'plumbing');
  END IF;
  IF 'electric' = ANY(p_hazards) THEN
    v_signal := v_signal || ' no power';
    v_required_trade := COALESCE(v_required_trade, 'electrical');
  END IF;
  IF 'smoke' = ANY(p_hazards) THEN
    v_signal := v_signal || ' electrical fire';
    v_required_trade := 'electrical';
  END IF;

  SELECT * INTO v_priority FROM public.emergency_priority_for_job(v_signal, now());

  INSERT INTO emergency_triage_submissions (
    user_id, customer_id, what_happened, hazards, started_at_label,
    photo_path, audio_path, priority_tier, priority_score, reason, required_trade
  ) VALUES (
    v_customer.user_id, v_customer.id, NULLIF(trim(p_what_happened), ''), COALESCE(p_hazards, '{}'),
    NULLIF(trim(p_started_at), ''), p_photo_path, p_audio_path,
    v_priority.tier, v_priority.score, v_priority.reason, v_required_trade
  )
  RETURNING id INTO v_submission_id;

  -- Auto-dispatch: only for critical/high, only a technician who is
  -- actually free today, and only skill-matched when we have a required
  -- trade to match against. Never touches an existing job.
  IF v_priority.tier IN ('critical', 'high') THEN
    SELECT tm.id, tm.member_name INTO v_tech
    FROM team_members tm
    WHERE tm.account_owner_id = v_customer.user_id
      AND tm.role = 'technician'
      AND tm.dispatch_enabled = true
      AND (
        v_required_trade IS NULL
        OR EXISTS (SELECT 1 FROM unnest(tm.skills) s WHERE s ILIKE '%' || v_required_trade || '%')
      )
      AND (
        SELECT count(*) FROM jobs j
        WHERE j.assigned_technician_id = tm.id
          AND j.job_status NOT IN ('completed', 'cancelled')
          AND j.scheduled_datetime::date = now()::date
      ) < tm.max_jobs_per_day
    ORDER BY (
      SELECT count(*) FROM jobs j
      WHERE j.assigned_technician_id = tm.id
        AND j.job_status NOT IN ('completed', 'cancelled')
        AND j.scheduled_datetime::date = now()::date
    ) ASC
    LIMIT 1;

    IF v_tech.id IS NOT NULL THEN
      INSERT INTO jobs (
        user_id, customer_id, customer_name, customer_phone, service_type,
        address, scheduled_datetime, assigned_technician_id, job_status, dispatch_note
      ) VALUES (
        v_customer.user_id, v_customer.id, v_customer.name, v_customer.phone,
        COALESCE(v_required_trade, 'Emergency service'), v_customer.address, now(), v_tech.id, 'scheduled',
        'Customer emergency self-triage: ' || COALESCE(NULLIF(trim(p_what_happened), ''), v_priority.reason)
      )
      RETURNING id INTO v_job_id;

      UPDATE emergency_triage_submissions
      SET job_id = v_job_id, assigned_technician_id = v_tech.id
      WHERE id = v_submission_id;

      v_assigned := true;
    END IF;
  END IF;

  -- Always visible to the business in the existing triage queue, dispatched
  -- or not — 'manual' source marks it as customer-initiated, not the
  -- overnight auto-scan. (Not de-duplicated across repeat submissions from
  -- the same customer — acceptable for now since a human reviews the
  -- queue; tighten with a recent-pending-row check if that becomes noisy.)
  INSERT INTO emergency_triage_queue (user_id, job_id, customer_name, phone, priority_tier, priority_score, reason, status, source)
  VALUES (
    v_customer.user_id, v_job_id, v_customer.name, v_customer.phone,
    v_priority.tier, v_priority.score,
    trim(COALESCE(v_priority.reason, '') || ' — customer self-triage'), 'pending', 'manual'
  );

  RETURN jsonb_build_object(
    'tier', v_priority.tier,
    'required_trade', v_required_trade,
    'assigned', v_assigned,
    'technician_name', v_tech.member_name,
    'submission_id', v_submission_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_emergency_triage(uuid, text, text[], text, text, text) TO anon, authenticated;
