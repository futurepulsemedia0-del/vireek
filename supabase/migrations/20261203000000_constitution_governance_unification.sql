/*
  # Constitution ↔ Agent Governance Unification

  ## چرا
  check_constitution() تا الان فقط داخل run_capacity_demand_control صدا
  زده می‌شد. evaluate_agent_action() — دروازه‌ی مشترک همه‌ی Agentهای
  خودکار پروژه — هیچ ارتباطی با Constitution نداشت. این مایگریشن این دو
  را یکی می‌کند تا Business Constitution واقعاً روی تمام Agentها حاکم
  باشد، نه فقط یک مسیر.

  ## اضافه می‌کند
  1. constitution_articles.risk_tier — سطح شدت هر ماده (نمایشی/طبقه‌بندی)
  2. سه rule_type جدید:
     - block_action_slug            → خط قرمز: یک اکشن مشخص را برای همیشه غیرفعال می‌کند
     - require_human_for_category   → اختیار: کل یک دسته اکشن باید همیشه با تایید انسان اجرا شود
     - max_daily_autonomous_actions → Risk Policy: سقف روزانه‌ی اجرای خودکار per category
  3. check_constitution() عمومی‌تر می‌شود (علاوه‌بر ۴ قانون قبلی، دو قانون بالا را هم چک می‌کند)
  4. evaluate_agent_action() اکنون قبل از هر تصمیمی ابتدا Constitution را
     چک می‌کند (رد قطعی = خط قرمز/سقف روزانه) و سپس در صورت وجود
     require_human_for_category، تایید انسانی را اجباری می‌کند حتی اگر
     auto_approve_max_cents اجازه می‌داد.
  5. get_agent_authority_matrix() — نمای فقط-خواندنی از اختیار هر Agent:
     فعال/غیرفعال، نیاز به تایید، سقف خودکار، و آیا خط قرمز خورده یا نه.

  هیچ رفتار قبلی تغییر نمی‌کند — همه چیز additive است.
*/

-- =============================================================
-- 1) constitution_articles: risk_tier + rule_type های جدید
-- =============================================================
ALTER TABLE constitution_articles
  ADD COLUMN IF NOT EXISTS risk_tier text NOT NULL DEFAULT 'standard'
    CHECK (risk_tier IN ('red_line', 'high_risk', 'standard', 'advisory'));

ALTER TABLE constitution_articles DROP CONSTRAINT IF EXISTS constitution_articles_rule_type_check;
ALTER TABLE constitution_articles ADD CONSTRAINT constitution_articles_rule_type_check
  CHECK (rule_type IN (
    'no_campaign_if_sla_at_risk', 'no_vip_cancel_without_human_contact',
    'protect_margin_floor', 'ai_cannot_handle_unhappy_alone',
    'block_action_slug', 'require_human_for_category', 'max_daily_autonomous_actions',
    'custom'
  ));

-- =============================================================
-- 2) create_constitution_article — نسخه‌ی کامل‌تر (جایگزین کامل تابع قبلی)
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_constitution_article(p_rule_type text, p_parameters jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_title text; v_risk_tier text; v_id uuid;
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
    WHEN 'block_action_slug' THEN
      format('Red line: the "%s" automated action may never run, regardless of dashboard settings.', COALESCE(p_parameters->>'action_slug', '?'))
    WHEN 'require_human_for_category' THEN
      format('Every "%s" automated action must be approved by a human before it runs — no exceptions.', COALESCE(p_parameters->>'category', '?'))
    WHEN 'max_daily_autonomous_actions' THEN
      format('No more than %s autonomous "%s" actions may run per day without a human decision.', COALESCE(p_parameters->>'max_count', '20'), COALESCE(p_parameters->>'category', '?'))
    WHEN 'custom' THEN COALESCE(p_parameters->>'text', 'Custom principle')
    ELSE 'Unknown rule'
  END;

  v_risk_tier := CASE p_rule_type
    WHEN 'block_action_slug' THEN 'red_line'
    WHEN 'protect_margin_floor' THEN 'high_risk'
    WHEN 'no_vip_cancel_without_human_contact' THEN 'high_risk'
    WHEN 'ai_cannot_handle_unhappy_alone' THEN 'high_risk'
    WHEN 'require_human_for_category' THEN 'high_risk'
    WHEN 'custom' THEN 'advisory'
    ELSE 'standard'
  END;

  INSERT INTO constitution_articles (user_id, rule_type, title, parameters, risk_tier)
  VALUES (public.get_account_owner_id(), p_rule_type, v_title, p_parameters, v_risk_tier)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_constitution_article(text, jsonb) TO authenticated;

-- =============================================================
-- 3) check_constitution — نسخه‌ی کامل‌تر (جایگزین کامل تابع قبلی)
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
  v_daily_count integer;
  v_max_count integer;
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
        (rule_type = 'ai_cannot_handle_unhappy_alone' AND p_action_type = 'ai_auto_followup') OR
        (rule_type = 'block_action_slug' AND parameters->>'action_slug' = p_action_type) OR
        (rule_type = 'max_daily_autonomous_actions' AND EXISTS (
          SELECT 1 FROM agent_action_catalog WHERE slug = p_action_type AND category = parameters->>'category'
        ))
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

    ELSIF v_article.rule_type = 'block_action_slug' THEN
      v_blocked := true;
      v_reason := 'This action is permanently disabled by a Business Constitution red line.';

    ELSIF v_article.rule_type = 'max_daily_autonomous_actions' THEN
      v_max_count := COALESCE((v_article.parameters->>'max_count')::integer, 20);
      SELECT count(*) INTO v_daily_count
      FROM agent_action_log al
      JOIN agent_action_catalog ac ON ac.slug = al.action_slug
      WHERE al.user_id = p_user_id
        AND ac.category = (v_article.parameters->>'category')
        AND al.status IN ('auto_approved', 'approved', 'executed')
        AND al.created_at >= date_trunc('day', now());
      IF v_daily_count >= v_max_count THEN
        v_blocked := true;
        v_reason := format('Daily limit of %s autonomous "%s" actions already reached (%s so far today).',
          v_max_count, v_article.parameters->>'category', v_daily_count);
      END IF;
    END IF;

    IF v_blocked THEN
      INSERT INTO constitution_violations (user_id, article_id, action_type, context, reason)
      VALUES (p_user_id, v_article.id, p_action_type, p_context, v_reason);

      allowed := false; article_id := v_article.id; article_title := v_article.title; reason := v_reason;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;

  allowed := true; article_id := NULL; article_title := NULL; reason := NULL;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_constitution(uuid, text, jsonb) TO authenticated, service_role;

-- =============================================================
-- 4) evaluate_agent_action — نسخه‌ی کامل‌تر (جایگزین کامل تابع قبلی)
-- =============================================================
CREATE OR REPLACE FUNCTION public.evaluate_agent_action(
  p_user_id uuid,
  p_action_slug text,
  p_agent_source text,
  p_target_table text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL,
  p_reasoning text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_before_state jsonb DEFAULT NULL,
  p_rollback_patch jsonb DEFAULT NULL,
  p_correlation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_catalog agent_action_catalog;
  v_perm agent_permissions;
  v_existing agent_action_log;
  v_log agent_action_log;
  v_requires_approval boolean;
  v_status text;
  v_over_limit boolean := false;
  v_limit record;
  v_period_start timestamptz;
  v_spent_cents numeric;
  v_constitution record;
  v_forced_by_authority boolean;
BEGIN
  SELECT * INTO v_catalog FROM agent_action_catalog WHERE slug = p_action_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown agent action slug: %', p_action_slug;
  END IF;

  IF p_target_table IS NOT NULL AND p_target_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM agent_action_log
      WHERE user_id = p_user_id AND action_slug = p_action_slug
        AND target_table = p_target_table AND target_id = p_target_id
        AND status IN ('pending_approval', 'approved', 'rejected')
      ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('decision', v_existing.status, 'log_id', v_existing.id, 'existing', true);
    END IF;
  END IF;

  -- =========================================================
  -- NEW: Business Constitution gate — red lines + risk-policy
  -- caps apply to EVERY agent action before anything else runs.
  -- =========================================================
  SELECT * INTO v_constitution FROM public.check_constitution(
    p_user_id, p_action_slug,
    p_payload || jsonb_build_object('agent_source', p_agent_source, 'amount_cents', p_amount_cents)
  ) LIMIT 1;

  IF NOT v_constitution.allowed THEN
    INSERT INTO agent_action_log (
      user_id, action_slug, agent_source, target_table, target_id, amount_cents,
      reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
    ) VALUES (
      p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
      p_reasoning, p_payload, p_before_state, p_rollback_patch, 'rejected', p_correlation_id,
      format('Blocked by Business Constitution — %s: %s', v_constitution.article_title, v_constitution.reason)
    ) RETURNING * INTO v_log;
    RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_log.id, 'reason', 'constitution', 'article_title', v_constitution.article_title);
  END IF;

  SELECT * INTO v_perm FROM agent_permissions WHERE user_id = p_user_id AND action_slug = p_action_slug;

  IF FOUND AND v_perm.enabled = false THEN
    INSERT INTO agent_action_log (
      user_id, action_slug, agent_source, target_table, target_id, amount_cents,
      reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
    ) VALUES (
      p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
      p_reasoning, p_payload, p_before_state, p_rollback_patch, 'rejected', p_correlation_id,
      'Blocked: this action type is disabled in Agent Governance.'
    ) RETURNING * INTO v_log;
    RETURN jsonb_build_object('decision', 'rejected', 'log_id', v_log.id, 'reason', 'disabled');
  END IF;

  v_requires_approval := COALESCE(v_perm.requires_approval, v_catalog.default_requires_approval);

  IF p_amount_cents IS NOT NULL AND p_amount_cents > 0 THEN
    FOR v_limit IN
      SELECT * FROM agent_spending_limits
      WHERE user_id = p_user_id AND (action_slug = p_action_slug OR action_slug IS NULL)
    LOOP
      v_period_start := CASE v_limit.period
        WHEN 'daily' THEN date_trunc('day', now())
        WHEN 'weekly' THEN date_trunc('week', now())
        ELSE date_trunc('month', now())
      END;
      SELECT COALESCE(SUM(amount_cents), 0) INTO v_spent_cents
        FROM agent_action_log
        WHERE user_id = p_user_id
          AND status IN ('auto_approved', 'approved', 'executed')
          AND created_at >= v_period_start
          AND (v_limit.action_slug IS NULL OR action_slug = v_limit.action_slug);
      IF v_spent_cents + p_amount_cents > v_limit.limit_cents THEN
        v_over_limit := true;
      END IF;
    END LOOP;
  END IF;

  IF v_over_limit THEN
    v_requires_approval := true;
  ELSIF v_perm.auto_approve_max_cents IS NOT NULL AND p_amount_cents IS NOT NULL
        AND p_amount_cents <= v_perm.auto_approve_max_cents THEN
    v_requires_approval := false;
  END IF;

  -- =========================================================
  -- NEW: Authority rule — require_human_for_category wins over
  -- everything above, including an auto-approve ceiling.
  -- =========================================================
  SELECT EXISTS (
    SELECT 1 FROM constitution_articles ca
    WHERE ca.user_id = p_user_id AND ca.enabled = true AND ca.rule_type = 'require_human_for_category'
      AND ca.parameters->>'category' = v_catalog.category
  ) INTO v_forced_by_authority;
  IF v_forced_by_authority THEN
    v_requires_approval := true;
  END IF;

  v_status := CASE WHEN v_requires_approval THEN 'pending_approval' ELSE 'auto_approved' END;

  INSERT INTO agent_action_log (
    user_id, action_slug, agent_source, target_table, target_id, amount_cents,
    reasoning, payload, before_state, rollback_patch, status, correlation_id, decision_reason
  ) VALUES (
    p_user_id, p_action_slug, p_agent_source, p_target_table, p_target_id, p_amount_cents,
    p_reasoning, p_payload, p_before_state, p_rollback_patch, v_status, p_correlation_id,
    CASE
      WHEN v_over_limit THEN 'Escalated to human approval: spending limit reached.'
      WHEN v_forced_by_authority THEN 'Escalated to human approval: Business Constitution requires human review for this category.'
      ELSE NULL
    END
  ) RETURNING * INTO v_log;

  RETURN jsonb_build_object('decision', v_status, 'log_id', v_log.id, 'over_limit', v_over_limit);
END;
$$;

GRANT EXECUTE ON FUNCTION public.evaluate_agent_action(uuid, text, text, text, text, integer, text, jsonb, jsonb, jsonb, text) TO authenticated, service_role;

-- =============================================================
-- 5) get_agent_authority_matrix — نمای فقط-خواندنی اختیار هر Agent
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_agent_authority_matrix()
RETURNS TABLE (
  action_slug text, agent_source text, label text, category text,
  enabled boolean, requires_approval boolean, auto_approve_max_cents integer,
  is_red_line boolean, red_line_reason text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.slug, c.agent_source, c.label, c.category,
    COALESCE(p.enabled, true) AS enabled,
    COALESCE(p.requires_approval, c.default_requires_approval) AS requires_approval,
    p.auto_approve_max_cents,
    EXISTS (
      SELECT 1 FROM constitution_articles ca
      WHERE ca.user_id = public.get_account_owner_id() AND ca.enabled = true
        AND ca.rule_type = 'block_action_slug' AND ca.parameters->>'action_slug' = c.slug
    ) AS is_red_line,
    (SELECT ca.title FROM constitution_articles ca
      WHERE ca.user_id = public.get_account_owner_id() AND ca.enabled = true
        AND ca.rule_type = 'block_action_slug' AND ca.parameters->>'action_slug' = c.slug
      LIMIT 1) AS red_line_reason
  FROM agent_action_catalog c
  LEFT JOIN agent_permissions p ON p.action_slug = c.slug AND p.user_id = public.get_account_owner_id()
  ORDER BY c.category, c.slug;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_authority_matrix() TO authenticated;
