/*
  # Recall & Safety-Alert Matching + Outreach Campaigns

  ## Why
  When a manufacturer recall or service bulletin is published, the contractor must find
  every customer unit it touches, contact those customers in a sensible order, and be able
  to PROVE what was done. Until now `oem_recalls` / `oem_service_bulletins` were only shown
  per unit; nothing matched them to the fleet or tracked follow-through.

  ## What this adds (reuses oem_recalls, oem_service_bulletins, equipment, customers,
  ##                   equipment_oem_alerts, notifications, oem_match_equipment, oem_decode_serial)
  1. Optional scoping columns on the shared reference rows (additive, nullable):
       equipment_type, manufactured_from, manufactured_to  (+ severity on bulletins)
  2. `recall_match_queue`      closed work queue. A trigger enqueues every new / re-scoped
                               recall or bulletin, and every new / changed equipment row.
  3. `recall_campaigns`        one per (account, recall|bulletin) that affects >= 1 unit.
  4. `recall_outreach`         one row per affected unit: priority score + reasons, status,
                               attempts, follow-up date, linked job, resolution note.
  5. `recall_outreach_events`  immutable audit trail (who / when / channel / what).

  ## Matching (honest by design — nothing is invented)
  - Unit -> manufacturer/model through the EXISTING public.oem_match_equipment().
  - applicability = 'applies'  : model scope matched by link/exact model, or a typed
                                 manufacturer-wide scope, and the serial date (if the recall has
                                 a manufacture range) is inside it.
  - applicability = 'possible' : family/manufacturer-only match, untyped manufacturer-wide
                                 scope, or a manufacture range that the serial cannot confirm.
  - A unit whose decoded serial date is OUTSIDE the range is never listed.

  ## Priority (0-100, deterministic, explained by `priority_reasons`)
  severity (10/25/40/55) + confirmed match 20 + fire/CO hazard 15 | electrical hazard 10
  + commercial site 5 + past expected lifespan 5.  >= 80 is "urgent" in the UI.

  ## Completion
  pending -> contacted -> scheduled -> completed, or declined / unreachable / not_affected.
  Evidence rules: declined + not_affected need a note, unreachable needs >= 3 logged attempts.
  A campaign completes automatically when every unit is closed, and re-opens if one is re-opened
  or a newly matched unit appears.

  ## Security
  - Every table is tenant-scoped with public.get_account_owner_id() AND requires
    public.can_manage_recalls() (owner or team member with can_view_all_jobs).
  - Clients can only SELECT. All writes go through SECURITY DEFINER functions that re-check
    tenant + permission, so statuses can never be forged and the audit trail cannot be edited.
  - The matching / queue functions that take an explicit owner are service_role only.
*/

-- =============================================================
-- 0. Permission helper (same shape as can_edit_call_scripts)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_recalls()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_view_all_jobs', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_all_jobs', 'false') = 'true'
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_recalls() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_recalls() TO authenticated, service_role;

-- =============================================================
-- 1. Scoping columns on the shared reference rows (additive)
-- =============================================================

ALTER TABLE public.oem_recalls
  ADD COLUMN IF NOT EXISTS equipment_type text,
  ADD COLUMN IF NOT EXISTS manufactured_from date,
  ADD COLUMN IF NOT EXISTS manufactured_to date;

ALTER TABLE public.oem_service_bulletins
  ADD COLUMN IF NOT EXISTS equipment_type text,
  ADD COLUMN IF NOT EXISTS manufactured_from date,
  ADD COLUMN IF NOT EXISTS manufactured_to date,
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'medium';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oem_recalls_mfg_order') THEN
    ALTER TABLE public.oem_recalls ADD CONSTRAINT oem_recalls_mfg_order
      CHECK (manufactured_from IS NULL OR manufactured_to IS NULL OR manufactured_to >= manufactured_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oem_bulletins_mfg_order') THEN
    ALTER TABLE public.oem_service_bulletins ADD CONSTRAINT oem_bulletins_mfg_order
      CHECK (manufactured_from IS NULL OR manufactured_to IS NULL OR manufactured_to >= manufactured_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oem_bulletins_severity_check') THEN
    ALTER TABLE public.oem_service_bulletins ADD CONSTRAINT oem_bulletins_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'critical'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_oem_recalls_manufacturer ON public.oem_recalls (manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_oem_bulletins_manufacturer ON public.oem_service_bulletins (manufacturer_id);

-- =============================================================
-- 2. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public.recall_match_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('recall', 'bulletin', 'equipment')),
  source_id uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recall_match_queue_pending
  ON public.recall_match_queue (source_kind, source_id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.recall_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('recall', 'bulletin')),
  recall_id uuid REFERENCES public.oem_recalls(id) ON DELETE CASCADE,
  bulletin_id uuid REFERENCES public.oem_service_bulletins(id) ON DELETE CASCADE,
  source_number text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  auto_created boolean NOT NULL DEFAULT false,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recall_campaigns_one_source CHECK (
    (source_kind = 'recall' AND recall_id IS NOT NULL AND bulletin_id IS NULL)
    OR (source_kind = 'bulletin' AND bulletin_id IS NOT NULL AND recall_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recall_campaigns_recall
  ON public.recall_campaigns (user_id, recall_id) WHERE recall_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recall_campaigns_bulletin
  ON public.recall_campaigns (user_id, bulletin_id) WHERE bulletin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recall_campaigns_user_status ON public.recall_campaigns (user_id, status);

DROP TRIGGER IF EXISTS trg_recall_campaigns_updated_at ON public.recall_campaigns;
CREATE TRIGGER trg_recall_campaigns_updated_at
  BEFORE UPDATE ON public.recall_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.recall_outreach (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.recall_campaigns(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  match_method text NOT NULL CHECK (match_method IN ('linked', 'exact', 'family', 'manufacturer')),
  applicability text NOT NULL CHECK (applicability IN ('applies', 'possible')),
  priority_score integer NOT NULL CHECK (priority_score BETWEEN 0 AND 100),
  priority_reasons text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'contacted', 'scheduled', 'completed', 'declined', 'unreachable', 'not_affected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_recall_outreach_campaign ON public.recall_outreach (campaign_id, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_recall_outreach_user_status ON public.recall_outreach (user_id, status);
CREATE INDEX IF NOT EXISTS idx_recall_outreach_equipment ON public.recall_outreach (equipment_id);
CREATE INDEX IF NOT EXISTS idx_recall_outreach_followup
  ON public.recall_outreach (user_id, next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_recall_outreach_updated_at ON public.recall_outreach;
CREATE TRIGGER trg_recall_outreach_updated_at
  BEFORE UPDATE ON public.recall_outreach
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.recall_outreach_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  outreach_id uuid NOT NULL REFERENCES public.recall_outreach(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.recall_campaigns(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN ('created', 'attempt', 'contacted', 'scheduled', 'completed', 'declined',
                          'unreachable', 'not_affected', 'reopened', 'note')),
  channel text CHECK (channel IS NULL OR channel IN ('phone', 'sms', 'email', 'in_person', 'mail')),
  from_status text,
  to_status text,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recall_outreach_events_outreach ON public.recall_outreach_events (outreach_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recall_outreach_events_user ON public.recall_outreach_events (user_id, created_at DESC);

-- =============================================================
-- 3. RLS: read-only for clients; every write goes through the functions below
-- =============================================================

ALTER TABLE public.recall_match_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recall_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recall_outreach ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recall_outreach_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_recall_campaigns" ON public.recall_campaigns;
CREATE POLICY "select_recall_campaigns" ON public.recall_campaigns FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_recalls());

DROP POLICY IF EXISTS "select_recall_outreach" ON public.recall_outreach;
CREATE POLICY "select_recall_outreach" ON public.recall_outreach FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_recalls());

DROP POLICY IF EXISTS "select_recall_outreach_events" ON public.recall_outreach_events;
CREATE POLICY "select_recall_outreach_events" ON public.recall_outreach_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_recalls());

REVOKE ALL ON public.recall_match_queue FROM anon, authenticated;
REVOKE ALL ON public.recall_campaigns FROM anon, authenticated;
REVOKE ALL ON public.recall_outreach FROM anon, authenticated;
REVOKE ALL ON public.recall_outreach_events FROM anon, authenticated;
GRANT SELECT ON public.recall_campaigns, public.recall_outreach, public.recall_outreach_events TO authenticated;
GRANT ALL ON public.recall_match_queue, public.recall_campaigns, public.recall_outreach, public.recall_outreach_events TO service_role;

-- =============================================================
-- 4. Priority score (pure, deterministic)
-- =============================================================

CREATE OR REPLACE FUNCTION public.recall_priority(
  p_severity text,
  p_applicability text,
  p_equipment_type text,
  p_customer_type text,
  p_age_years numeric,
  p_lifespan_years integer,
  p_has_contact boolean,
  OUT score integer,
  OUT reasons text[]
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_type text := lower(coalesce(p_equipment_type, ''));
  v_sev text := CASE WHEN p_severity IN ('low', 'medium', 'high', 'critical') THEN p_severity ELSE 'medium' END;
  v_s integer;
BEGIN
  v_s := CASE v_sev WHEN 'critical' THEN 55 WHEN 'high' THEN 40 WHEN 'medium' THEN 25 ELSE 10 END;
  reasons := ARRAY['severity_' || v_sev];

  IF p_applicability = 'applies' THEN
    v_s := v_s + 20;
    reasons := array_append(reasons, 'confirmed_match');
  ELSE
    reasons := array_append(reasons, 'needs_verification');
  END IF;

  IF v_type ~ '(furnace|boiler|heater|fireplace|stove|range|oven|generator|gas|propane|fuel|chimney|flue)' THEN
    v_s := v_s + 15;
    reasons := array_append(reasons, 'fire_or_co_risk');
  ELSIF v_type ~ '(panel|breaker|electrical|battery|inverter|transformer|charger|solar)' THEN
    v_s := v_s + 10;
    reasons := array_append(reasons, 'electrical_risk');
  END IF;

  IF p_customer_type = 'commercial' THEN
    v_s := v_s + 5;
    reasons := array_append(reasons, 'commercial_site');
  END IF;

  IF p_age_years IS NOT NULL AND p_lifespan_years IS NOT NULL AND p_lifespan_years > 0
     AND p_age_years > p_lifespan_years THEN
    v_s := v_s + 5;
    reasons := array_append(reasons, 'past_lifespan');
  END IF;

  IF NOT coalesce(p_has_contact, false) THEN
    reasons := array_append(reasons, 'no_contact_info');
  END IF;

  score := least(100, greatest(0, v_s));
END;
$$;

-- =============================================================
-- 5. Matching (explicit owner -> NOT callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public.recall_match_candidates(
  p_owner uuid,
  p_kind text,
  p_source_id uuid,
  p_equipment_id uuid DEFAULT NULL
)
RETURNS TABLE (
  o_equipment_id uuid,
  o_customer_id uuid,
  o_match_method text,
  o_applicability text,
  o_priority_score integer,
  o_priority_reasons text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  e record;
  v_match jsonb;
  v_mfr uuid;
  v_model uuid;
  v_method text;
  v_decoded jsonb;
  v_date_app text;
  v_app text;
  v_model_type text;
  v_pri record;
BEGIN
  IF p_kind = 'recall' THEN
    SELECT r.manufacturer_id, r.model_id, lower(nullif(btrim(r.equipment_type), '')) AS equipment_type,
           r.manufactured_from, r.manufactured_to, r.severity
    INTO s FROM public.oem_recalls r WHERE r.id = p_source_id;
  ELSIF p_kind = 'bulletin' THEN
    SELECT b.manufacturer_id, b.model_id, lower(nullif(btrim(b.equipment_type), '')) AS equipment_type,
           b.manufactured_from, b.manufactured_to, b.severity
    INTO s FROM public.oem_service_bulletins b WHERE b.id = p_source_id;
  ELSE
    RAISE EXCEPTION 'RECALL_INVALID_SOURCE' USING ERRCODE = 'P0001';
  END IF;

  IF NOT FOUND OR p_owner IS NULL THEN RETURN; END IF;

  FOR e IN
    SELECT eq.id, eq.customer_id, eq.equipment_type, eq.make, eq.model, eq.serial_number,
           eq.install_date, eq.expected_lifespan_years, c.customer_type,
           (nullif(btrim(coalesce(c.phone, '')), '') IS NOT NULL
            OR nullif(btrim(coalesce(c.email, '')), '') IS NOT NULL) AS has_contact
    FROM public.equipment eq
    JOIN public.customers c ON c.id = eq.customer_id AND c.user_id = p_owner
    WHERE eq.user_id = p_owner
      AND eq.status = 'active'
      AND (p_equipment_id IS NULL OR eq.id = p_equipment_id)
  LOOP
    v_match := public.oem_match_equipment(e.id, e.make, e.model);
    v_mfr := nullif(v_match->>'manufacturer_id', '')::uuid;
    IF v_mfr IS DISTINCT FROM s.manufacturer_id THEN CONTINUE; END IF;

    v_method := v_match->>'method';
    v_model := nullif(v_match->>'model_id', '')::uuid;
    v_app := 'applies';

    IF s.model_id IS NOT NULL THEN
      IF v_model IS NOT NULL THEN
        IF v_model <> s.model_id THEN CONTINUE; END IF;
        IF v_method NOT IN ('linked', 'exact') THEN v_app := 'possible'; END IF;
      ELSE
        -- Only the brand is known: possible, but only for the same kind of equipment.
        SELECT lower(m.equipment_type) INTO v_model_type FROM public.oem_equipment_models m WHERE m.id = s.model_id;
        IF v_model_type IS DISTINCT FROM lower(btrim(coalesce(e.equipment_type, ''))) THEN CONTINUE; END IF;
        v_app := 'possible';
      END IF;
    ELSIF s.equipment_type IS NOT NULL THEN
      IF lower(btrim(coalesce(e.equipment_type, ''))) <> s.equipment_type THEN CONTINUE; END IF;
    ELSE
      -- Manufacturer-wide with no model and no equipment type never proves a unit is affected.
      v_app := 'possible';
    END IF;

    v_decoded := public.oem_decode_serial(v_mfr, e.equipment_type, e.serial_number);
    v_date_app := public.oem_issue_applicability(s.manufactured_from, s.manufactured_to, v_decoded);
    IF v_date_app = 'outside' THEN CONTINUE; END IF;
    IF v_date_app = 'possible' THEN v_app := 'possible'; END IF;

    SELECT * INTO v_pri FROM public.recall_priority(
      s.severity, v_app, e.equipment_type, e.customer_type,
      CASE WHEN e.install_date IS NOT NULL THEN (current_date - e.install_date)::numeric / 365.25 END,
      e.expected_lifespan_years, e.has_contact);

    o_equipment_id := e.id;
    o_customer_id := e.customer_id;
    o_match_method := CASE WHEN v_method IN ('linked', 'exact', 'family', 'manufacturer') THEN v_method ELSE 'manufacturer' END;
    o_applicability := v_app;
    o_priority_score := v_pri.score;
    o_priority_reasons := v_pri.reasons;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- =============================================================
-- 6. Sync: matches -> campaign + outreach + per-unit alerts + notification
-- =============================================================

CREATE OR REPLACE FUNCTION public.recall_sync_for_owner(
  p_owner uuid,
  p_kind text,
  p_source_id uuid,
  p_actor uuid DEFAULT NULL,
  p_equipment_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  cand record;
  v_camp uuid;
  v_camp_status text;
  v_oid uuid;
  v_ins boolean;
  v_matched integer := 0;
  v_new integer := 0;
  v_url text;
  v_label text;
BEGIN
  IF p_owner IS NULL THEN RAISE EXCEPTION 'RECALL_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  IF p_kind = 'recall' THEN
    SELECT r.recall_number AS number, r.title, r.severity, coalesce(r.remedy, r.description) AS detail
    INTO s FROM public.oem_recalls r WHERE r.id = p_source_id;
    v_label := 'Recall';
  ELSIF p_kind = 'bulletin' THEN
    SELECT b.bulletin_number AS number, b.title, b.severity, b.description AS detail
    INTO s FROM public.oem_service_bulletins b WHERE b.id = p_source_id;
    v_label := 'Service bulletin';
  ELSE
    RAISE EXCEPTION 'RECALL_INVALID_SOURCE' USING ERRCODE = 'P0001';
  END IF;

  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'source_not_found'); END IF;

  SELECT c.id, c.status INTO v_camp, v_camp_status
  FROM public.recall_campaigns c
  WHERE c.user_id = p_owner
    AND ((p_kind = 'recall' AND c.recall_id = p_source_id) OR (p_kind = 'bulletin' AND c.bulletin_id = p_source_id));

  IF v_camp_status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled', 'campaign_id', v_camp, 'matched', 0, 'created', 0);
  END IF;

  FOR cand IN SELECT * FROM public.recall_match_candidates(p_owner, p_kind, p_source_id, p_equipment_id) LOOP
    v_matched := v_matched + 1;

    IF v_camp IS NULL THEN
      IF p_kind = 'recall' THEN
        INSERT INTO public.recall_campaigns (user_id, source_kind, recall_id, source_number, title, severity, auto_created, created_by)
        VALUES (p_owner, 'recall', p_source_id, s.number, s.title, s.severity, p_actor IS NULL, p_actor)
        ON CONFLICT (user_id, recall_id) WHERE recall_id IS NOT NULL DO NOTHING
        RETURNING id INTO v_camp;
        IF v_camp IS NULL THEN
          SELECT c.id INTO v_camp FROM public.recall_campaigns c WHERE c.user_id = p_owner AND c.recall_id = p_source_id;
        END IF;
      ELSE
        INSERT INTO public.recall_campaigns (user_id, source_kind, bulletin_id, source_number, title, severity, auto_created, created_by)
        VALUES (p_owner, 'bulletin', p_source_id, s.number, s.title, s.severity, p_actor IS NULL, p_actor)
        ON CONFLICT (user_id, bulletin_id) WHERE bulletin_id IS NOT NULL DO NOTHING
        RETURNING id INTO v_camp;
        IF v_camp IS NULL THEN
          SELECT c.id INTO v_camp FROM public.recall_campaigns c WHERE c.user_id = p_owner AND c.bulletin_id = p_source_id;
        END IF;
      END IF;
    END IF;

    v_oid := NULL;
    v_ins := NULL;
    INSERT INTO public.recall_outreach
      (user_id, campaign_id, equipment_id, customer_id, match_method, applicability, priority_score, priority_reasons)
    VALUES
      (p_owner, v_camp, cand.o_equipment_id, cand.o_customer_id, cand.o_match_method, cand.o_applicability,
       cand.o_priority_score, cand.o_priority_reasons)
    ON CONFLICT (campaign_id, equipment_id) DO UPDATE
      SET match_method = EXCLUDED.match_method,
          applicability = EXCLUDED.applicability,
          priority_score = EXCLUDED.priority_score,
          priority_reasons = EXCLUDED.priority_reasons,
          customer_id = EXCLUDED.customer_id
      WHERE public.recall_outreach.status = 'pending'
        AND (public.recall_outreach.match_method, public.recall_outreach.applicability,
             public.recall_outreach.priority_score, public.recall_outreach.priority_reasons,
             public.recall_outreach.customer_id)
            IS DISTINCT FROM
            (EXCLUDED.match_method, EXCLUDED.applicability, EXCLUDED.priority_score,
             EXCLUDED.priority_reasons, EXCLUDED.customer_id)
    RETURNING id, (xmax = 0) INTO v_oid, v_ins;

    IF v_ins IS TRUE THEN
      v_new := v_new + 1;
      INSERT INTO public.recall_outreach_events (user_id, outreach_id, campaign_id, event_type, to_status, note, actor_id)
      VALUES (p_owner, v_oid, v_camp, 'created', 'pending',
              CASE WHEN cand.o_applicability = 'possible' THEN 'Match needs verification (serial / model not confirmed).' END,
              p_actor);

      INSERT INTO public.equipment_oem_alerts (user_id, equipment_id, alert_type, reference_id, title, message, severity)
      VALUES (p_owner, cand.o_equipment_id, p_kind, p_source_id,
              left(v_label || ' ' || s.number || ': ' || s.title, 200),
              left(coalesce(nullif(btrim(s.detail), ''), 'Contact the customer and follow the manufacturer instructions.'), 1000),
              s.severity)
      ON CONFLICT (equipment_id, alert_type, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;
    END IF;
  END LOOP;

  IF v_camp IS NOT NULL THEN
    UPDATE public.recall_campaigns c
    SET title = s.title,
        severity = s.severity,
        status = CASE WHEN v_new > 0 AND c.status = 'completed' THEN 'active' ELSE c.status END,
        completed_at = CASE WHEN v_new > 0 AND c.status = 'completed' THEN NULL ELSE c.completed_at END
    WHERE c.id = v_camp
      AND (c.title IS DISTINCT FROM s.title OR c.severity IS DISTINCT FROM s.severity
           OR (v_new > 0 AND c.status = 'completed'));

    IF v_new > 0 AND s.severity IN ('high', 'critical') THEN
      v_url := '/dashboard/recalls?campaign=' || v_camp::text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.notifications n
                       WHERE n.user_id = p_owner AND n.type = 'recall_alert' AND n.action_url = v_url AND n.is_read = false) THEN
          INSERT INTO public.notifications (user_id, type, title, message, action_url)
          VALUES (p_owner, 'recall_alert',
                  left(v_label || ' ' || s.number || ' affects your customers', 200),
                  format('%s unit%s need outreach: %s', v_new, CASE WHEN v_new = 1 THEN '' ELSE 's' END, left(s.title, 160)),
                  v_url);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'recall notification skipped: %', SQLERRM;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'campaign_id', v_camp, 'matched', v_matched, 'created', v_new);
END;
$$;

-- =============================================================
-- 7. Queue: triggers + processor (service_role / pg_cron)
-- =============================================================

CREATE OR REPLACE FUNCTION public.recall_enqueue_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.recall_match_queue (source_kind, source_id)
  VALUES (TG_ARGV[0], NEW.id)
  ON CONFLICT (source_kind, source_id) WHERE processed_at IS NULL DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'recall enqueue skipped: %', SQLERRM;  -- never block an import / equipment save
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oem_recalls_enqueue ON public.oem_recalls;
CREATE TRIGGER trg_oem_recalls_enqueue
  AFTER INSERT OR UPDATE OF model_id, equipment_type, manufactured_from, manufactured_to, severity
  ON public.oem_recalls
  FOR EACH ROW EXECUTE FUNCTION public.recall_enqueue_source('recall');

DROP TRIGGER IF EXISTS trg_oem_bulletins_enqueue ON public.oem_service_bulletins;
CREATE TRIGGER trg_oem_bulletins_enqueue
  AFTER INSERT OR UPDATE OF model_id, equipment_type, manufactured_from, manufactured_to, severity
  ON public.oem_service_bulletins
  FOR EACH ROW EXECUTE FUNCTION public.recall_enqueue_source('bulletin');

DROP TRIGGER IF EXISTS trg_equipment_recall_enqueue ON public.equipment;
CREATE TRIGGER trg_equipment_recall_enqueue
  AFTER INSERT OR UPDATE OF make, model, serial_number, equipment_type, status, customer_id
  ON public.equipment
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.recall_enqueue_source('equipment');

CREATE OR REPLACE FUNCTION public.recall_enqueue_full_rescan()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n1 integer;
  n2 integer;
BEGIN
  INSERT INTO public.recall_match_queue (source_kind, source_id)
  SELECT 'recall', r.id FROM public.oem_recalls r
  ON CONFLICT (source_kind, source_id) WHERE processed_at IS NULL DO NOTHING;
  GET DIAGNOSTICS n1 = ROW_COUNT;

  INSERT INTO public.recall_match_queue (source_kind, source_id)
  SELECT 'bulletin', b.id FROM public.oem_service_bulletins b
  ON CONFLICT (source_kind, source_id) WHERE processed_at IS NULL DO NOTHING;
  GET DIAGNOSTICS n2 = ROW_COUNT;

  RETURN n1 + n2;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_recall_match_queue(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q record;
  v_owner uuid;
  v_mfr uuid;
  v_src record;
  v_fail integer;
  v_done integer := 0;
  v_failed integer := 0;
  v_err text;
BEGIN
  FOR q IN
    SELECT * FROM public.recall_match_queue
    WHERE processed_at IS NULL AND attempts < 5
    ORDER BY id
    LIMIT greatest(1, least(coalesce(p_limit, 25), 200))
    FOR UPDATE SKIP LOCKED
  LOOP
    v_fail := 0;
    v_err := NULL;

    IF q.source_kind IN ('recall', 'bulletin') THEN
      IF q.source_kind = 'recall' THEN
        SELECT r.manufacturer_id INTO v_mfr FROM public.oem_recalls r WHERE r.id = q.source_id;
      ELSE
        SELECT b.manufacturer_id INTO v_mfr FROM public.oem_service_bulletins b WHERE b.id = q.source_id;
      END IF;

      IF v_mfr IS NOT NULL THEN
        FOR v_owner IN
          SELECT DISTINCT e.user_id
          FROM public.equipment e
          WHERE e.status = 'active'
            AND e.user_id IS NOT NULL
            AND (
              EXISTS (SELECT 1 FROM public.oem_manufacturers m
                      WHERE m.id = v_mfr AND length(public.atlas_norm(m.name)) >= 3
                        AND (public.atlas_norm(e.make) = public.atlas_norm(m.slug)
                             OR public.atlas_norm(e.make) = public.atlas_norm(m.name)
                             OR public.atlas_norm(e.make) LIKE public.atlas_norm(m.name) || '%'))
              OR EXISTS (SELECT 1 FROM public.equipment_oem_link l
                         JOIN public.oem_equipment_models md ON md.id = l.model_id
                         WHERE l.equipment_id = e.id AND l.enrichment_status = 'matched' AND md.manufacturer_id = v_mfr)
            )
        LOOP
          BEGIN
            PERFORM public.recall_sync_for_owner(v_owner, q.source_kind, q.source_id, NULL);
          EXCEPTION WHEN OTHERS THEN
            v_fail := v_fail + 1;
            v_err := left(SQLERRM, 500);
          END;
        END LOOP;
      END IF;

    ELSE
      -- one equipment row: check it against every recall / bulletin of its manufacturer
      SELECT e.user_id,
             nullif(public.oem_match_equipment(e.id, e.make, e.model)->>'manufacturer_id', '')::uuid
      INTO v_owner, v_mfr
      FROM public.equipment e WHERE e.id = q.source_id AND e.status = 'active';

      IF v_owner IS NOT NULL AND v_mfr IS NOT NULL THEN
        FOR v_src IN
          SELECT 'recall'::text AS kind, r.id FROM public.oem_recalls r WHERE r.manufacturer_id = v_mfr
          UNION ALL
          SELECT 'bulletin'::text, b.id FROM public.oem_service_bulletins b WHERE b.manufacturer_id = v_mfr
        LOOP
          BEGIN
            PERFORM public.recall_sync_for_owner(v_owner, v_src.kind, v_src.id, NULL, q.source_id);
          EXCEPTION WHEN OTHERS THEN
            v_fail := v_fail + 1;
            v_err := left(SQLERRM, 500);
          END;
        END LOOP;
      END IF;
    END IF;

    IF v_fail = 0 THEN
      UPDATE public.recall_match_queue SET processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = q.id;
      v_done := v_done + 1;
    ELSE
      UPDATE public.recall_match_queue SET attempts = attempts + 1, last_error = v_err WHERE id = q.id;
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('processed', v_done, 'failed', v_failed);
END;
$$;

-- =============================================================
-- 8. Client API
-- =============================================================

-- Re-check every manufacturer relevant to THIS account against all recalls + bulletins. Idempotent.
CREATE OR REPLACE FUNCTION public.recall_scan_my_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_mfrs uuid[];
  src record;
  r jsonb;
  n_campaigns integer := 0;
  n_matched integer := 0;
  n_created integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'RECALL_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT public.can_manage_recalls() THEN RAISE EXCEPTION 'RECALL_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;

  SELECT array_agg(DISTINCT x.m) INTO v_mfrs
  FROM (
    SELECT nullif(public.oem_match_equipment(e.id, e.make, e.model)->>'manufacturer_id', '')::uuid AS m
    FROM public.equipment e WHERE e.user_id = v_owner AND e.status = 'active'
  ) x WHERE x.m IS NOT NULL;

  IF v_mfrs IS NULL THEN
    RETURN jsonb_build_object('campaigns', 0, 'matched', 0, 'created', 0);
  END IF;

  FOR src IN
    SELECT 'recall'::text AS kind, r2.id FROM public.oem_recalls r2 WHERE r2.manufacturer_id = ANY (v_mfrs)
    UNION ALL
    SELECT 'bulletin'::text, b.id FROM public.oem_service_bulletins b WHERE b.manufacturer_id = ANY (v_mfrs)
  LOOP
    r := public.recall_sync_for_owner(v_owner, src.kind, src.id, auth.uid());
    IF r->>'status' = 'ok' AND r->>'campaign_id' IS NOT NULL THEN
      n_campaigns := n_campaigns + 1;
      n_matched := n_matched + (r->>'matched')::integer;
      n_created := n_created + (r->>'created')::integer;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('campaigns', n_campaigns, 'matched', n_matched, 'created', n_created);
END;
$$;

CREATE OR REPLACE FUNCTION public.recall_log_outreach(
  p_outreach_id uuid,
  p_action text,
  p_channel text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_follow_up_at timestamptz DEFAULT NULL,
  p_job_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_terminal text[] := ARRAY['completed', 'declined', 'unreachable', 'not_affected'];
  o record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status text;
  v_attempts integer;
  v_follow timestamptz;
  v_open integer;
  v_camp_status text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'RECALL_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT public.can_manage_recalls() THEN RAISE EXCEPTION 'RECALL_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;

  IF p_action IS NULL OR p_action NOT IN ('attempt', 'contacted', 'scheduled', 'completed', 'declined',
                                          'unreachable', 'not_affected', 'reopened', 'note') THEN
    RAISE EXCEPTION 'RECALL_INVALID_ACTION' USING ERRCODE = 'P0001';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('phone', 'sms', 'email', 'in_person', 'mail') THEN
    RAISE EXCEPTION 'RECALL_INVALID_CHANNEL' USING ERRCODE = 'P0001';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'RECALL_NOTE_TOO_LONG' USING ERRCODE = 'P0001';
  END IF;
  IF p_follow_up_at IS NOT NULL AND p_follow_up_at < now() - interval '1 hour' THEN
    RAISE EXCEPTION 'RECALL_INVALID_FOLLOW_UP' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM public.recall_outreach WHERE id = p_outreach_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECALL_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  IF o.status = ANY (v_terminal) AND p_action NOT IN ('reopened', 'note') THEN
    RAISE EXCEPTION 'RECALL_INVALID_TRANSITION' USING ERRCODE = 'P0001';
  END IF;
  IF p_action = 'reopened' AND NOT (o.status = ANY (v_terminal)) THEN
    RAISE EXCEPTION 'RECALL_INVALID_TRANSITION' USING ERRCODE = 'P0001';
  END IF;
  IF p_action IN ('attempt', 'contacted') AND p_channel IS NULL THEN
    RAISE EXCEPTION 'RECALL_CHANNEL_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_action IN ('declined', 'not_affected', 'note') AND v_note IS NULL THEN
    RAISE EXCEPTION 'RECALL_NOTE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_action = 'unreachable' AND o.attempts < 3 THEN
    RAISE EXCEPTION 'RECALL_MIN_ATTEMPTS' USING ERRCODE = 'P0001';
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'RECALL_JOB_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_attempts := o.attempts + CASE WHEN p_action IN ('attempt', 'contacted') THEN 1 ELSE 0 END;
  v_status := CASE p_action
    WHEN 'attempt' THEN o.status
    WHEN 'note' THEN o.status
    WHEN 'reopened' THEN 'pending'
    WHEN 'contacted' THEN CASE WHEN o.status = 'scheduled' THEN 'scheduled' ELSE 'contacted' END
    ELSE p_action
  END;

  v_follow := CASE
    WHEN v_status = ANY (v_terminal) THEN NULL
    WHEN p_action = 'reopened' THEN NULL
    WHEN p_follow_up_at IS NOT NULL THEN p_follow_up_at
    WHEN p_action = 'attempt' THEN now() + interval '2 days'
    WHEN p_action = 'contacted' THEN now() + interval '3 days'
    WHEN p_action = 'scheduled' THEN NULL
    ELSE o.next_follow_up_at
  END;

  UPDATE public.recall_outreach
  SET status = v_status,
      attempts = v_attempts,
      last_contacted_at = CASE WHEN p_action IN ('attempt', 'contacted') THEN now() ELSE o.last_contacted_at END,
      next_follow_up_at = v_follow,
      job_id = coalesce(p_job_id, o.job_id),
      resolution_note = CASE
        WHEN p_action IN ('completed', 'declined', 'unreachable', 'not_affected') THEN coalesce(v_note, o.resolution_note)
        WHEN p_action = 'reopened' THEN NULL
        ELSE o.resolution_note END,
      resolved_at = CASE
        WHEN v_status = ANY (v_terminal) AND NOT (o.status = ANY (v_terminal)) THEN now()
        WHEN p_action = 'reopened' THEN NULL
        ELSE o.resolved_at END
  WHERE id = o.id;

  INSERT INTO public.recall_outreach_events (user_id, outreach_id, campaign_id, event_type, channel, from_status, to_status, note, actor_id)
  VALUES (v_owner, o.id, o.campaign_id, p_action, p_channel, o.status, v_status, v_note, auth.uid());

  IF p_action = 'contacted' AND o.customer_id IS NOT NULL THEN
    UPDATE public.customers SET last_contacted_at = now() WHERE id = o.customer_id AND user_id = v_owner;
  END IF;

  SELECT count(*) INTO v_open FROM public.recall_outreach r
  WHERE r.campaign_id = o.campaign_id AND NOT (r.status = ANY (v_terminal));

  IF v_open = 0 THEN
    UPDATE public.recall_campaigns SET status = 'completed', completed_at = now()
    WHERE id = o.campaign_id AND status IN ('active', 'paused');
  ELSE
    UPDATE public.recall_campaigns SET status = 'active', completed_at = NULL
    WHERE id = o.campaign_id AND status = 'completed';
  END IF;

  SELECT c.status INTO v_camp_status FROM public.recall_campaigns c WHERE c.id = o.campaign_id;

  RETURN jsonb_build_object('status', v_status, 'attempts', v_attempts, 'next_follow_up_at', v_follow,
                            'campaign_status', v_camp_status, 'open_units', v_open);
END;
$$;

CREATE OR REPLACE FUNCTION public.recall_set_campaign_status(p_campaign_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'RECALL_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT public.can_manage_recalls() THEN RAISE EXCEPTION 'RECALL_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'paused', 'cancelled') THEN
    RAISE EXCEPTION 'RECALL_INVALID_ACTION' USING ERRCODE = 'P0001';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'RECALL_NOTE_TOO_LONG' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM public.recall_campaigns WHERE id = p_campaign_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECALL_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'completed' THEN RAISE EXCEPTION 'RECALL_INVALID_TRANSITION' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.recall_campaigns SET status = p_status, notes = coalesce(v_note, notes) WHERE id = c.id;
  RETURN jsonb_build_object('status', p_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_recall_campaigns()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_terminal text[] := ARRAY['completed', 'declined', 'unreachable', 'not_affected'];
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'RECALL_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.rank, x.created_at DESC), '[]'::jsonb) INTO v_out
  FROM (
    SELECT c.created_at,
           CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END AS rank,
           jsonb_build_object(
             'id', c.id, 'source_kind', c.source_kind, 'source_id', coalesce(c.recall_id, c.bulletin_id),
             'number', c.source_number, 'title', c.title, 'severity', c.severity, 'status', c.status,
             'auto_created', c.auto_created, 'notes', c.notes,
             'created_at', c.created_at, 'completed_at', c.completed_at,
             'issued_date', coalesce(r.issued_date, b.issued_date),
             'remedy', r.remedy,
             'description', coalesce(r.description, b.description),
             'source_url', coalesce(r.source_url, b.source_url),
             'counts', jsonb_build_object(
               'total', k.total, 'pending', k.pending, 'contacted', k.contacted, 'scheduled', k.scheduled,
               'completed', k.completed, 'declined', k.declined, 'unreachable', k.unreachable,
               'not_affected', k.not_affected),
             'urgent_open', k.urgent_open, 'overdue', k.overdue
           ) AS j
    FROM public.recall_campaigns c
    LEFT JOIN public.oem_recalls r ON r.id = c.recall_id
    LEFT JOIN public.oem_service_bulletins b ON b.id = c.bulletin_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS total,
             count(*) FILTER (WHERE o.status = 'pending') AS pending,
             count(*) FILTER (WHERE o.status = 'contacted') AS contacted,
             count(*) FILTER (WHERE o.status = 'scheduled') AS scheduled,
             count(*) FILTER (WHERE o.status = 'completed') AS completed,
             count(*) FILTER (WHERE o.status = 'declined') AS declined,
             count(*) FILTER (WHERE o.status = 'unreachable') AS unreachable,
             count(*) FILTER (WHERE o.status = 'not_affected') AS not_affected,
             count(*) FILTER (WHERE NOT (o.status = ANY (v_terminal)) AND o.priority_score >= 80) AS urgent_open,
             count(*) FILTER (WHERE NOT (o.status = ANY (v_terminal))
                                AND o.next_follow_up_at IS NOT NULL AND o.next_follow_up_at < now()) AS overdue
      FROM public.recall_outreach o WHERE o.campaign_id = c.id
    ) k
    WHERE c.user_id = v_owner
  ) x;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_recall_outreach(p_campaign_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_terminal text[] := ARRAY['completed', 'declined', 'unreachable', 'not_affected'];
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'RECALL_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT coalesce(jsonb_agg(x.j ORDER BY x.closed, x.score DESC, x.created_at), '[]'::jsonb) INTO v_out
  FROM (
    SELECT o.created_at, o.priority_score AS score,
           CASE WHEN o.status = ANY (v_terminal) THEN 1 ELSE 0 END AS closed,
           jsonb_build_object(
             'id', o.id, 'campaign_id', o.campaign_id, 'equipment_id', o.equipment_id, 'customer_id', o.customer_id,
             'status', o.status, 'applicability', o.applicability, 'match_method', o.match_method,
             'priority_score', o.priority_score, 'priority_reasons', to_jsonb(o.priority_reasons),
             'attempts', o.attempts, 'last_contacted_at', o.last_contacted_at,
             'next_follow_up_at', o.next_follow_up_at, 'job_id', o.job_id,
             'resolution_note', o.resolution_note, 'resolved_at', o.resolved_at, 'created_at', o.created_at,
             'equipment', jsonb_build_object(
               'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
               'serial_number', e.serial_number, 'install_date', e.install_date),
             'customer', jsonb_build_object(
               'name', cu.name, 'phone', cu.phone, 'email', cu.email, 'address', cu.address,
               'customer_type', cu.customer_type)
           ) AS j
    FROM public.recall_outreach o
    JOIN public.equipment e ON e.id = o.equipment_id
    LEFT JOIN public.customers cu ON cu.id = o.customer_id
    WHERE o.campaign_id = p_campaign_id AND o.user_id = v_owner
    ORDER BY (CASE WHEN o.status = ANY (v_terminal) THEN 1 ELSE 0 END), o.priority_score DESC, o.created_at
    LIMIT 2000
  ) x;

  RETURN v_out;
END;
$$;

-- =============================================================
-- 9. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.recall_priority(text, text, text, text, numeric, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recall_match_candidates(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recall_sync_for_owner(uuid, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recall_enqueue_source() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recall_enqueue_full_rescan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_recall_match_queue(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recall_priority(text, text, text, text, numeric, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.recall_match_candidates(uuid, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recall_sync_for_owner(uuid, text, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recall_enqueue_full_rescan() TO service_role;
GRANT EXECUTE ON FUNCTION public.process_recall_match_queue(integer) TO service_role;

REVOKE ALL ON FUNCTION public.recall_scan_my_account() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recall_log_outreach(uuid, text, text, text, timestamptz, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recall_set_campaign_status(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_recall_campaigns() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_recall_outreach(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recall_scan_my_account() TO authenticated;
GRANT EXECUTE ON FUNCTION public.recall_log_outreach(uuid, text, text, text, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recall_set_campaign_status(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_recall_campaigns() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_recall_outreach(uuid) TO authenticated;

-- =============================================================
-- 10. Schedule + first run (best effort: never fails the migration)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('vireek-recall-match-queue'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('vireek-recall-rescan'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('vireek-recall-match-queue', '*/5 * * * *', 'select public.process_recall_match_queue(25)');
    PERFORM cron.schedule('vireek-recall-rescan', '40 3 * * *', 'select public.recall_enqueue_full_rescan()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END;
$$;

DO $$
BEGIN
  PERFORM public.recall_enqueue_full_rescan();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'initial recall rescan enqueue skipped: %', SQLERRM;
END;
$$;
