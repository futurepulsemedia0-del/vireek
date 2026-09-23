/*
  # Emergency / Disaster Operations Mode

  یک لایه‌ی سنگین‌تر روی Weather Surge موجود (20260929000000) و
  On-Call Rotation موجود (20261002000000) می‌سازد. وقتی فعال می‌شود:

    1. surge (پیش‌بینی) از قبل توسط weather-surge-check انجام می‌شود؛
       این migration فقط لایه‌ی «حالت اضطراری» را روی همان زیرساخت می‌سازد.
    2. emergency_triage_queue را با اسکن jobs بازِ حساب پر می‌کند و بر اساس
       کلیدواژه‌های نوع سرویس + عقب‌افتادگی، اولویت‌بندی می‌کند
       (critical / high / standard).
    3. on-call فعلی (از on_call_schedules) را — در ادج‌فانکشن، نه اینجا —
       با پیامک مطلع می‌کند.
    4. یک لاگ append-only از مخابرات جمعی (emergency_broadcasts) نگه
       می‌دارد؛ ارسال واقعی پیامک‌ها فقط از طریق Edge Function با
       service_role انجام می‌شود (هیچ INSERT مستقیمی از کلاینت مجاز نیست).

  فعال‌سازی خودکار (source='weather') فقط وقتی اجرا می‌شود که صاحب کسب‌وکار
  ستون emergency_ops_enabled را روشن کرده باشد — یک اعلام دستی انسان
  (source='manual') هرگز توسط اتوماسیون خاموش/بازنویسی نمی‌شود.
*/

-- =============================================================
-- BUSINESS_PROFILE: پرچم‌های حالت اضطراری
-- =============================================================

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS emergency_ops_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS emergency_mode_active boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS emergency_mode_source text CHECK (emergency_mode_source IS NULL OR emergency_mode_source IN ('manual', 'weather')),
ADD COLUMN IF NOT EXISTS emergency_mode_activated_at timestamptz,
ADD COLUMN IF NOT EXISTS emergency_mode_headline text;

-- =============================================================
-- EMERGENCY_TRIAGE_QUEUE
-- =============================================================

CREATE TABLE IF NOT EXISTS emergency_triage_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  phone text,
  priority_tier text NOT NULL DEFAULT 'standard' CHECK (priority_tier IN ('critical', 'high', 'standard')),
  priority_score int NOT NULL DEFAULT 0,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'resolved', 'dismissed')),
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_etq_unique_job ON emergency_triage_queue(user_id, job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_etq_queue ON emergency_triage_queue(user_id, status, priority_score DESC);

ALTER TABLE emergency_triage_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_triage_queue" ON emergency_triage_queue;
CREATE POLICY "select_own_triage_queue" ON emergency_triage_queue FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_triage_queue" ON emergency_triage_queue;
CREATE POLICY "insert_own_triage_queue" ON emergency_triage_queue FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_triage_queue" ON emergency_triage_queue;
CREATE POLICY "update_own_triage_queue" ON emergency_triage_queue FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_triage_queue" ON emergency_triage_queue;
CREATE POLICY "delete_own_triage_queue" ON emergency_triage_queue FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- EMERGENCY_BROADCASTS: لاگ append-only پیام‌های جمعی؛ فقط سرویس‌رول
-- می‌نویسد (مثل business_activity_events / escalation_events).
-- =============================================================

CREATE TABLE IF NOT EXISTS emergency_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('customers', 'team', 'on_call')),
  recipients_targeted int NOT NULL DEFAULT 0,
  recipients_sent int NOT NULL DEFAULT 0,
  triggered_by text NOT NULL DEFAULT 'manual' CHECK (triggered_by IN ('manual', 'auto')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eb_user ON emergency_broadcasts(user_id, created_at DESC);

ALTER TABLE emergency_broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_broadcasts" ON emergency_broadcasts;
CREATE POLICY "select_own_broadcasts" ON emergency_broadcasts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- PRIORITY SCORING: کلیدواژه‌های نوع سرویس + عقب‌افتادگی زمانی
-- =============================================================

CREATE OR REPLACE FUNCTION public.emergency_priority_for_job(
  p_service_type text,
  p_scheduled_datetime timestamptz
)
RETURNS TABLE(tier text, score int, reason text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_text text := lower(coalesce(p_service_type, ''));
  v_tier text;
  v_score int;
  v_reason text;
  v_overdue boolean := p_scheduled_datetime IS NOT NULL AND p_scheduled_datetime < now();
BEGIN
  IF v_text ~ '(no heat|burst pipe|gas leak|no power|flooding|flood|sewage|no ac|no cooling|carbon monoxide|electrical fire|downed line|active leak)' THEN
    v_tier := 'critical'; v_score := 100; v_reason := 'Critical keyword match in service type';
  ELSIF v_text ~ '(no hot water|leak|storm damage|roof damage|tree|power outage|water damage|no cool)' THEN
    v_tier := 'high'; v_score := 60; v_reason := 'High-priority keyword match in service type';
  ELSE
    v_tier := 'standard'; v_score := 20; v_reason := 'No emergency keyword match';
  END IF;

  IF v_overdue THEN
    v_score := v_score + 15;
    v_reason := v_reason || ' + overdue';
    IF v_tier = 'standard' THEN v_tier := 'high'; END IF;
    IF v_tier = 'high' AND v_text ~ '(leak|no heat|no ac|no cool)' THEN v_tier := 'critical'; END IF;
  END IF;

  RETURN QUERY SELECT v_tier, v_score, v_reason;
END;
$$;

-- =============================================================
-- REBUILD QUEUE: اسکن jobs باز و آپدیت صف تریاژ
-- =============================================================

CREATE OR REPLACE FUNCTION public.rebuild_emergency_triage_queue(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job record;
  v_priority record;
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  -- حذف ردیف‌های auto که دیگر باز نیستند
  DELETE FROM emergency_triage_queue etq
  WHERE etq.user_id = p_user_id AND etq.source = 'auto' AND etq.status = 'pending'
    AND (etq.job_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM jobs j WHERE j.id = etq.job_id AND j.job_status NOT IN ('completed', 'cancelled')
    ));

  FOR v_job IN
    SELECT id, customer_name, service_type, scheduled_datetime
    FROM jobs
    WHERE user_id = p_user_id
      AND job_status NOT IN ('completed', 'cancelled')
      AND (scheduled_datetime IS NULL OR scheduled_datetime < now() + interval '72 hours')
  LOOP
    SELECT * INTO v_priority FROM public.emergency_priority_for_job(v_job.service_type, v_job.scheduled_datetime);

    INSERT INTO emergency_triage_queue (user_id, job_id, customer_name, priority_tier, priority_score, reason, status, source)
    VALUES (p_user_id, v_job.id, v_job.customer_name, v_priority.tier, v_priority.score, v_priority.reason, 'pending', 'auto')
    ON CONFLICT (user_id, job_id) WHERE job_id IS NOT NULL
    DO UPDATE SET priority_tier = EXCLUDED.priority_tier, priority_score = EXCLUDED.priority_score, reason = EXCLUDED.reason
    WHERE emergency_triage_queue.status = 'pending';

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebuild_emergency_triage_queue(uuid) TO authenticated, service_role;

-- =============================================================
-- ACTIVATE / DEACTIVATE: دستی همیشه بر خودکار (weather) اولویت دارد
-- =============================================================

CREATE OR REPLACE FUNCTION public.activate_emergency_mode(
  p_user_id uuid,
  p_source text,
  p_headline text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_fresh boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  SELECT id, emergency_mode_active, emergency_mode_source, emergency_ops_enabled
  INTO v_profile FROM business_profile WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_source = 'weather' AND NOT v_profile.emergency_ops_enabled THEN
    RETURN false;
  END IF;

  IF v_profile.emergency_mode_active AND v_profile.emergency_mode_source = 'manual' AND p_source <> 'manual' THEN
    RETURN false;
  END IF;

  v_fresh := NOT v_profile.emergency_mode_active;

  UPDATE business_profile SET
    emergency_mode_active = true,
    emergency_mode_source = p_source,
    emergency_mode_headline = p_headline,
    emergency_mode_activated_at = CASE WHEN v_fresh THEN now() ELSE emergency_mode_activated_at END
  WHERE user_id = p_user_id;

  IF v_fresh THEN
    PERFORM public.append_activity_event(
      p_aggregate_type := 'business_profile',
      p_aggregate_id := v_profile.id,
      p_event_type := 'emergency.activated',
      p_event_data := jsonb_build_object('source', p_source, 'headline', p_headline),
      p_actor_type := CASE WHEN p_source = 'manual' THEN 'user' ELSE 'system' END,
      p_user_id := p_user_id
    );
  END IF;

  RETURN v_fresh;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activate_emergency_mode(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.deactivate_emergency_mode(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  SELECT id, emergency_mode_active INTO v_profile FROM business_profile WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT v_profile.emergency_mode_active THEN RETURN; END IF;

  UPDATE business_profile SET emergency_mode_active = false, emergency_mode_source = NULL WHERE user_id = p_user_id;

  PERFORM public.append_activity_event(
    p_aggregate_type := 'business_profile',
    p_aggregate_id := v_profile.id,
    p_event_type := 'emergency.deactivated',
    p_event_data := '{}'::jsonb,
    p_actor_type := 'user',
    p_user_id := p_user_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.deactivate_emergency_mode(uuid) TO authenticated, service_role;
