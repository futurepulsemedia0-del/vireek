/*
  # Business Constitution Simulator

  The owner picks from a small set of rule templates (matching real
  automation surfaces already in this codebase: capacity/demand
  campaigns, VIP cancellation, discounting, AI-only follow-up) and fills
  in one threshold each. Under the hood this is fully structured, so
  check_constitution() can mechanically approve/block an action BEFORE
  it runs — no LLM interpretation needed, consistent with the rest of
  this project.

  A 'custom' article type also exists for principles that can't be
  mechanically checked (e.g. genuinely open-ended values statements) —
  those are advisory only, shown on the page, never block anything.

  Every block is logged to constitution_violations so it's auditable,
  and an owner can override a block with a required, logged reason —
  this is a constitution, not a cage.
*/

CREATE TABLE IF NOT EXISTS constitution_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  rule_type text NOT NULL CHECK (rule_type IN (
    'no_campaign_if_sla_at_risk', 'no_vip_cancel_without_human_contact',
    'protect_margin_floor', 'ai_cannot_handle_unhappy_alone', 'custom'
  )),
  title text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ca_user ON constitution_articles(user_id, enabled);
ALTER TABLE constitution_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_constitution_articles" ON constitution_articles;
CREATE POLICY "manage_own_constitution_articles" ON constitution_articles FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS constitution_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  article_id uuid NOT NULL REFERENCES constitution_articles(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  overridden boolean NOT NULL DEFAULT false,
  override_reason text,
  overridden_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cv_user ON constitution_violations(user_id, blocked_at DESC);
ALTER TABLE constitution_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_constitution_violations" ON constitution_violations;
CREATE POLICY "select_own_constitution_violations" ON constitution_violations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy — writes only via check_constitution() /
-- override_constitution_violation() below.

-- =============================================================
-- Create an article, auto-writing its plain-language title
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_constitution_article(p_rule_type text, p_parameters jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_title text; v_id uuid;
BEGIN
  v_title := CASE p_rule_type
    WHEN 'no_campaign_if_sla_at_risk' THEN
      'Never increase outbound demand campaigns while an SLA is at risk.'
    WHEN 'no_vip_cancel_without_human_contact' THEN
      format('Never cancel a VIP customer without human contact in the last %s hours.', COALESCE(p_parameters->>'contact_window_hours', '48'))
    WHEN 'protect_margin_floor' THEN
      format('Never discount a quote more than %s%%, even to grow revenue.', COALESCE(p_parameters->>'max_discount_pct', '15'))
    WHEN 'ai_cannot_handle_unhappy_alone' THEN
      'AI may not handle an unhappy customer with automated messages alone — a human must be involved.'
    WHEN 'custom' THEN COALESCE(p_parameters->>'text', 'Custom principle')
    ELSE 'Unknown rule'
  END;

  INSERT INTO constitution_articles (user_id, rule_type, title, parameters)
  VALUES (public.get_account_owner_id(), p_rule_type, v_title, p_parameters)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_constitution_article(text, jsonb) TO authenticated;

-- =============================================================
-- THE CHECK: call this before any gated action executes
-- =============================================================
CREATE OR REPLACE FUNCTION public.check_constitution(p_user_id uuid, p_action_type text, p_context jsonb DEFAULT '{}')
RETURNS TABLE (allowed boolean, article_id uuid, article_title text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_article record;
  v_blocked boolean;
  v_reason text;

  v_sla_breach_count integer;
  v_customer record;
  v_hours numeric;
  v_discount numeric;
  v_max_discount numeric;
  v_recent_sentiment text;
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  FOR v_article IN
    SELECT * FROM constitution_articles
    WHERE user_id = p_user_id AND enabled = true AND rule_type <> 'custom'
      AND (
        (rule_type = 'no_campaign_if_sla_at_risk' AND p_action_type = 'launch_campaign') OR
        (rule_type = 'no_vip_cancel_without_human_contact' AND p_action_type = 'cancel_customer') OR
        (rule_type = 'protect_margin_floor' AND p_action_type = 'apply_discount') OR
        (rule_type = 'ai_cannot_handle_unhappy_alone' AND p_action_type = 'ai_auto_followup')
      )
  LOOP
    v_blocked := false; v_reason := NULL;

    IF v_article.rule_type = 'no_campaign_if_sla_at_risk' THEN
      SELECT count(*) INTO v_sla_breach_count FROM contract_sla_breaches
      WHERE user_id = p_user_id AND resolved = false AND created_at > now() - interval '7 days';
      IF v_sla_breach_count > 0 THEN
        v_blocked := true;
        v_reason := format('%s unresolved SLA breach(es) in the last 7 days.', v_sla_breach_count);
      END IF;

    ELSIF v_article.rule_type = 'no_vip_cancel_without_human_contact' THEN
      SELECT lifecycle_stage, last_contacted_at INTO v_customer
      FROM customers WHERE user_id = p_user_id AND phone = (p_context->>'customer_phone') LIMIT 1;
      IF v_customer.lifecycle_stage = 'vip' THEN
        v_hours := COALESCE((v_article.parameters->>'contact_window_hours')::numeric, 48);
        IF v_customer.last_contacted_at IS NULL OR v_customer.last_contacted_at < now() - (v_hours || ' hours')::interval THEN
          v_blocked := true;
          v_reason := format('VIP customer has had no logged human contact in the last %s hours.', v_hours);
        END IF;
      END IF;

    ELSIF v_article.rule_type = 'protect_margin_floor' THEN
      v_discount := COALESCE((p_context->>'discount_percent')::numeric, 0);
      v_max_discount := COALESCE((v_article.parameters->>'max_discount_pct')::numeric, 15);
      IF v_discount > v_max_discount THEN
        v_blocked := true;
        v_reason := format('Requested discount %s%% exceeds the %s%% floor.', v_discount, v_max_discount);
      END IF;

    ELSIF v_article.rule_type = 'ai_cannot_handle_unhappy_alone' THEN
      IF COALESCE((p_context->>'human_involved')::boolean, false) = false THEN
        SELECT sentiment INTO v_recent_sentiment FROM calls
        WHERE user_id = p_user_id AND caller_phone = (p_context->>'customer_phone')
        ORDER BY call_datetime DESC LIMIT 1;
        IF v_recent_sentiment IN ('negative', 'frustrated', 'angry') THEN
          v_blocked := true;
          v_reason := format('Customer''s most recent call sentiment was "%s" and no human has been involved yet.', v_recent_sentiment);
        END IF;
      END IF;
    END IF;

    IF v_blocked THEN
      INSERT INTO constitution_violations (user_id, article_id, action_type, context, reason)
      VALUES (p_user_id, v_article.id, p_action_type, p_context, v_reason);

      allowed := false; article_id := v_article.id; article_title := v_article.title; reason := v_reason;
      RETURN NEXT;
      RETURN; -- first violated article stops the action; that's enough to block it
    END IF;
  END LOOP;

  allowed := true; article_id := NULL; article_title := NULL; reason := NULL;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_constitution(uuid, text, jsonb) TO authenticated, service_role;

-- =============================================================
-- Human override (always logged, reason required)
-- =============================================================
CREATE OR REPLACE FUNCTION public.override_constitution_violation(p_violation_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF trim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'An override reason is required'; END IF;
  UPDATE constitution_violations SET overridden = true, override_reason = p_reason, overridden_at = now()
  WHERE id = p_violation_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Violation not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.override_constitution_violation(uuid, text) TO authenticated;

-- =============================================================
-- WIRING (confirmed, live): Rule 1 inside run_capacity_demand_control
-- =============================================================
CREATE OR REPLACE FUNCTION public.run_capacity_demand_control(p_date date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status jsonb;
  v_action text;
  v_constitution_check record;
BEGIN
  v_status := public.get_capacity_status(p_date);

  v_action := CASE v_status->>'status'
    WHEN 'low' THEN
      CASE WHEN (v_status->'policy'->>'auto_demand_campaigns_enabled')::boolean
        THEN 'demand_campaign_recommended' ELSE 'none_campaigns_disabled' END
    WHEN 'full' THEN
      CASE WHEN (v_status->'policy'->>'waitlist_enabled')::boolean
        THEN 'waitlist_mode_enabled' ELSE 'campaigns_paused_recommended' END
    WHEN 'no_capacity' THEN 'no_technicians_configured'
    ELSE 'none'
  END;

  IF v_action = 'demand_campaign_recommended' THEN
    SELECT * INTO v_constitution_check FROM public.check_constitution(v_owner, 'launch_campaign', '{}'::jsonb) LIMIT 1;
    IF NOT v_constitution_check.allowed THEN
      v_action := 'demand_campaign_blocked_by_constitution';
    END IF;
  END IF;

  INSERT INTO capacity_demand_events (user_id, event_date, status, day_load, day_capacity, load_pct, action_taken, detail)
  VALUES (
    v_owner, p_date, v_status->>'status',
    (v_status->>'day_load')::integer, (v_status->>'day_capacity')::integer,
    NULLIF(v_status->>'load_pct', '')::numeric, v_action, v_status
  );

  RETURN v_status || jsonb_build_object('action_taken', v_action);
END;
$$;
