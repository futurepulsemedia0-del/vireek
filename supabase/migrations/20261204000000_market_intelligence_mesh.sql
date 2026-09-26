/*
  # Market Intelligence Mesh

  ## چرا
  سه منبع سیگنال بازار از قبل در پروژه وجود دارد اما هیچ‌کدام به هم یا به
  business_decisions وصل نیستند:
    - regional_demand_snapshots  (20260930000000) — تقاضای منطقه‌ای/صنفی،
      ناشناس‌سازی‌شده بین چند تننت (k-anonymity)
    - benchmark_cohort_stats     (20260923000000) — جایگاه این کسب‌وکار
      نسبت به هم‌صنف‌ها (p10..p90)، هم ناشناس‌سازی‌شده
    - weather_surge_events       (20260929000000) — شوک بیرونی هواشناسی

  این مایگریشن این سه را با وضعیت ظرفیت خود تننت (capacity_demand_events)
  ترکیب می‌کند و در market_intelligence_signals می‌نویسد — قطعی و
  قانون‌محور، دقیقاً مثل check_constitution، بدون نیاز به LLM.

  ## جدول
  market_intelligence_signals — یک ردیف به‌ازای هر سیگنال شناسایی‌شده،
  با dedupe_key منحصربه‌فرد تا اسکن‌های تکراری، سیگنال تکراری نسازند.

  ## توابع
  - compute_market_intelligence(p_user_id)  → برای یک تننت (service_role)
  - refresh_market_intelligence()           → حلقه روی همه‌ی تننت‌ها + expire
  - expire_old_market_signals()             → سیگنال‌های منقضی را می‌بندد
  - acknowledge_market_signal / dismiss_market_signal → اکشن مالک
  - promote_signal_to_decision              → پل مستقیم به business_decisions

  ## استقرار
  مثل weather-surge-check: یک Edge Function جدید (مثلاً
  market-intelligence-refresh) که فقط public.refresh_market_intelligence()
  را صدا می‌زند، و هر ۳۰-۶۰ دقیقه کرون می‌شود. به کلید بیرونی نیاز ندارد
  چون فقط داده‌های داخلی موجود را ترکیب می‌کند.
*/

CREATE TABLE IF NOT EXISTS market_intelligence_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('trend', 'opportunity', 'risk', 'demand_shift')),
  domain text NOT NULL CHECK (domain IN ('demand', 'weather', 'competitive', 'marketing', 'financial')),
  title text NOT NULL,
  narrative text NOT NULL,
  confidence_score numeric(5,2) NOT NULL DEFAULT 60 CHECK (confidence_score BETWEEN 0 AND 100),
  estimated_impact_cents bigint,
  source_refs jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'acknowledged', 'dismissed', 'expired')),
  dedupe_key text NOT NULL,
  acknowledged_at timestamptz,
  dismissed_at timestamptz,
  dismiss_reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_mis_user_status ON market_intelligence_signals(user_id, status, created_at DESC);

ALTER TABLE market_intelligence_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_market_intelligence_signals" ON market_intelligence_signals;
CREATE POLICY "select_own_market_intelligence_signals" ON market_intelligence_signals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- بدون INSERT/UPDATE برای کلاینت — فقط از طریق توابع زیر.

-- =============================================================
-- CORE: compute_market_intelligence — یک تننت، قطعی، بدون LLM
-- =============================================================
CREATE OR REPLACE FUNCTION public.compute_market_intelligence(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_industry text;
  v_region_key text;
  v_regional record;
  v_capacity_status text;
  v_weather record;
  v_metric record;
  v_cohort record;
  v_bucket text;
  v_before integer;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before FROM market_intelligence_signals WHERE user_id = p_user_id;

  SELECT NULLIF(trim(primary_industry), ''), NULLIF(lower(trim(service_area)), '')
  INTO v_industry, v_region_key
  FROM business_profile WHERE user_id = p_user_id;

  -- ===== 1) تقاضای منطقه‌ای: demand_shift + opportunity =====
  IF v_industry IS NOT NULL AND v_region_key IS NOT NULL THEN
    SELECT * INTO v_regional FROM regional_demand_snapshots
    WHERE industry = v_industry AND region_key = v_region_key
    ORDER BY computed_at DESC LIMIT 1;

    IF FOUND AND v_regional.call_volume_change_pct IS NOT NULL THEN
      IF v_regional.call_volume_change_pct >= 25 THEN
        INSERT INTO market_intelligence_signals (user_id, signal_type, domain, title, narrative, confidence_score, source_refs, dedupe_key, expires_at)
        VALUES (
          p_user_id, 'demand_shift', 'demand',
          format('%s demand is up %s%% in %s', v_regional.industry, v_regional.call_volume_change_pct, v_regional.region_label),
          format('Across %s businesses in %s, weekly call volume for %s rose from %s to %s calls (%s%%). This is a market-wide signal from anonymized regional data, not just your own numbers.',
            v_regional.sample_size, v_regional.region_label, v_regional.industry, v_regional.prior_week_calls, v_regional.current_week_calls, v_regional.call_volume_change_pct),
          LEAST(60 + v_regional.sample_size * 2, 95)::numeric,
          jsonb_build_object('regional_demand_snapshot_id', v_regional.id),
          format('demand_shift_up:%s:%s:%s', v_region_key, v_industry, v_regional.period_end),
          now() + interval '7 days'
        ) ON CONFLICT (user_id, dedupe_key) DO NOTHING;

      ELSIF v_regional.call_volume_change_pct <= -25 THEN
        INSERT INTO market_intelligence_signals (user_id, signal_type, domain, title, narrative, confidence_score, source_refs, dedupe_key, expires_at)
        VALUES (
          p_user_id, 'risk', 'demand',
          format('%s demand is cooling %s%% in %s', v_regional.industry, v_regional.call_volume_change_pct, v_regional.region_label),
          format('Across %s businesses in %s, weekly call volume for %s fell from %s to %s calls (%s%%). Consider tightening marketing spend or reviewing pricing before this shows up in your own numbers.',
            v_regional.sample_size, v_regional.region_label, v_regional.industry, v_regional.prior_week_calls, v_regional.current_week_calls, v_regional.call_volume_change_pct),
          LEAST(60 + v_regional.sample_size * 2, 95)::numeric,
          jsonb_build_object('regional_demand_snapshot_id', v_regional.id),
          format('demand_shift_down:%s:%s:%s', v_region_key, v_industry, v_regional.period_end),
          now() + interval '7 days'
        ) ON CONFLICT (user_id, dedupe_key) DO NOTHING;
      END IF;

      IF v_regional.call_volume_change_pct >= 15 THEN
        SELECT status INTO v_capacity_status FROM capacity_demand_events
        WHERE user_id = p_user_id ORDER BY event_date DESC LIMIT 1;

        IF v_capacity_status = 'low' THEN
          INSERT INTO market_intelligence_signals (user_id, signal_type, domain, title, narrative, confidence_score, source_refs, dedupe_key, expires_at)
          VALUES (
            p_user_id, 'opportunity', 'demand',
            'Rising regional demand meets your open capacity',
            format('Regional demand for %s is up %s%% while your own capacity status is "low" (room to take more work). This is a window to run a demand campaign before competitors absorb the extra calls.',
              v_regional.industry, v_regional.call_volume_change_pct),
            70,
            jsonb_build_object('regional_demand_snapshot_id', v_regional.id),
            format('demand_opportunity:%s:%s:%s', v_region_key, v_industry, v_regional.period_end),
            now() + interval '5 days'
          ) ON CONFLICT (user_id, dedupe_key) DO NOTHING;
        END IF;
      END IF;
    END IF;
  END IF;

  -- ===== 2) ریسک هواشناسی =====
  FOR v_weather IN
    SELECT * FROM weather_surge_events
    WHERE user_id = p_user_id AND resolved_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND created_at > now() - interval '3 days'
  LOOP
    INSERT INTO market_intelligence_signals (user_id, signal_type, domain, title, narrative, confidence_score, source_refs, dedupe_key, expires_at)
    VALUES (
      p_user_id, 'risk', 'weather',
      format('Active weather alert: %s', COALESCE(v_weather.headline, v_weather.event_type)),
      format('A %s alert (%s) covering %s is active. If this historically drives call volume up for your trade, make sure staffing and the AI receptionist are ready; if it can disrupt fieldwork, plan around it.',
        COALESCE(v_weather.severity, 'weather'), v_weather.event_type, COALESCE(v_weather.area_desc, 'your service area')),
      70,
      jsonb_build_object('weather_surge_event_id', v_weather.id),
      format('weather:%s', v_weather.nws_alert_id),
      v_weather.expires_at
    ) ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  END LOOP;

  -- ===== 3) روند رقابتی از بنچمارک‌های ناشناس =====
  FOR v_metric IN
    SELECT * FROM public.compute_tenant_metrics(p_user_id, current_date - 29, current_date)
  LOOP
    SELECT * INTO v_cohort FROM benchmark_cohort_stats
    WHERE metric = v_metric.metric AND industry IN (COALESCE(v_industry, 'all'), 'all')
    ORDER BY (industry = COALESCE(v_industry, 'all')) DESC, period_end DESC
    LIMIT 1;

    IF FOUND THEN
      v_bucket := CASE
        WHEN v_metric.direction = 'higher_is_better' THEN
          CASE WHEN v_metric.value >= v_cohort.p90 THEN 'top10' WHEN v_metric.value <= v_cohort.p25 THEN 'bottom25' ELSE NULL END
        ELSE
          CASE WHEN v_metric.value <= v_cohort.p10 THEN 'top10' WHEN v_metric.value >= v_cohort.p75 THEN 'bottom25' ELSE NULL END
      END;

      IF v_bucket = 'bottom25' THEN
        INSERT INTO market_intelligence_signals (user_id, signal_type, domain, title, narrative, confidence_score, source_refs, dedupe_key, expires_at)
        VALUES (
          p_user_id, 'risk', 'competitive',
          format('%s is trailing the industry', v_metric.metric),
          format('Your %s is %s, in the bottom quartile of %s businesses (%s cohort) over the last 30 days. Peers in the top half are meaningfully ahead here.',
            v_metric.metric, v_metric.value, v_cohort.contributor_count, v_cohort.industry),
          65,
          jsonb_build_object('metric', v_metric.metric, 'my_value', v_metric.value, 'cohort_p50', v_cohort.p50),
          format('competitive_risk:%s:%s', v_metric.metric, v_cohort.period_end),
          now() + interval '14 days'
        ) ON CONFLICT (user_id, dedupe_key) DO NOTHING;
      ELSIF v_bucket = 'top10' THEN
        INSERT INTO market_intelligence_signals (user_id, signal_type, domain, title, narrative, confidence_score, source_refs, dedupe_key, expires_at)
        VALUES (
          p_user_id, 'opportunity', 'competitive',
          format('%s leads the industry', v_metric.metric),
          format('Your %s is %s, in the top 10%% of %s businesses (%s cohort) over the last 30 days. This is a defensible edge worth highlighting in marketing or pricing.',
            v_metric.metric, v_metric.value, v_cohort.contributor_count, v_cohort.industry),
          65,
          jsonb_build_object('metric', v_metric.metric, 'my_value', v_metric.value, 'cohort_p50', v_cohort.p50),
          format('competitive_opportunity:%s:%s', v_metric.metric, v_cohort.period_end),
          now() + interval '14 days'
        ) ON CONFLICT (user_id, dedupe_key) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_after FROM market_intelligence_signals WHERE user_id = p_user_id;
  RETURN v_after - v_before;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_market_intelligence(uuid) TO service_role;

-- =============================================================
-- expire_old_market_signals + refresh_market_intelligence (sweep همه‌ی تننت‌ها)
-- =============================================================
CREATE OR REPLACE FUNCTION public.expire_old_market_signals()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE market_intelligence_signals
    SET status = 'expired'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING 1
  ) SELECT count(*)::integer FROM updated;
$$;

GRANT EXECUTE ON FUNCTION public.expire_old_market_signals() TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_market_intelligence()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant record;
  v_total integer := 0;
BEGIN
  PERFORM public.expire_old_market_signals();
  FOR v_tenant IN SELECT user_id FROM business_profile LOOP
    v_total := v_total + COALESCE(public.compute_market_intelligence(v_tenant.user_id), 0);
  END LOOP;
  RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_market_intelligence() TO service_role;

-- =============================================================
-- اکشن مالک: acknowledge / dismiss
-- =============================================================
CREATE OR REPLACE FUNCTION public.acknowledge_market_signal(p_id uuid)
RETURNS market_intelligence_signals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row market_intelligence_signals;
BEGIN
  UPDATE market_intelligence_signals SET status = 'acknowledged', acknowledged_at = now()
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'active'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Signal not found or not active.'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_market_signal(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.dismiss_market_signal(p_id uuid, p_reason text DEFAULT NULL)
RETURNS market_intelligence_signals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row market_intelligence_signals;
BEGIN
  UPDATE market_intelligence_signals SET status = 'dismissed', dismissed_at = now(), dismiss_reason = p_reason
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'active'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Signal not found or not active.'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dismiss_market_signal(uuid, text) TO authenticated;

-- =============================================================
-- پل به Decision Engine: یک سیگنال را به یک تصمیم قابل‌تصویب تبدیل می‌کند
-- =============================================================
CREATE OR REPLACE FUNCTION public.promote_signal_to_decision(p_id uuid)
RETURNS business_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signal market_intelligence_signals;
  v_decision business_decisions;
  v_category text;
BEGIN
  SELECT * INTO v_signal FROM market_intelligence_signals
  WHERE id = p_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Signal not found.'; END IF;

  v_category := CASE v_signal.domain
    WHEN 'demand' THEN 'marketing'
    WHEN 'weather' THEN 'operations'
    WHEN 'competitive' THEN 'pricing'
    WHEN 'marketing' THEN 'marketing'
    WHEN 'financial' THEN 'collections'
    ELSE 'operations'
  END;

  INSERT INTO business_decisions (
    user_id, category, title, reasoning, recommended_action,
    confidence_score, status, is_auto_executable, metric_snapshot
  ) VALUES (
    v_signal.user_id, v_category, v_signal.title, v_signal.narrative,
    format('Review the "%s" market intelligence signal and decide whether to act.', v_signal.title),
    v_signal.confidence_score, 'pending', false,
    jsonb_build_object('source', 'market_intelligence_mesh', 'signal_id', v_signal.id, 'source_refs', v_signal.source_refs)
  ) RETURNING * INTO v_decision;

  UPDATE market_intelligence_signals SET status = 'acknowledged', acknowledged_at = now() WHERE id = p_id;

  RETURN v_decision;
END;
$$;

GRANT EXECUTE ON FUNCTION public.promote_signal_to_decision(uuid) TO authenticated;
