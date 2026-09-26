/*
  # Public Template Library

  ## Why
  This codebase already has FIVE separate, ad-hoc "browse a catalog, click
  install" systems, each hardcoded in its own TS file with its own tracking
  table: automation_installs (src/lib/automationMarketplace.ts),
  trade_playbook_installs (src/lib/tradePlaybookCatalog.ts),
  workflow_definitions.source_template_slug (src/lib/workflowPlaybooks.ts),
  plus src/lib/playbooks.ts and src/lib/tradePlaybooks.ts. None of them
  cover "AI Agent" configuration as an installable template, and none of
  them share a single browse/search/install experience.

  This migration adds ONE unified, content-managed Template Library that
  covers exactly the three template kinds asked for — Workflow Template,
  AI Agent, Playbook — without touching or breaking any of the five
  existing systems:
    - Workflow templates REUSE install_workflow_playbook() from
      20261005000000_call_to_cash_workflow_engine.sql verbatim (same
      proven path workflowPlaybooks.ts already uses), so a library
      "install" produces a completely normal, editable workflow_definitions
      + workflow_versions row.
    - AI Agent templates are a GOVERNANCE PRESET: a bundle of
      agent_permissions + agent_spending_limits rows, applied through the
      existing upsert_agent_permission() / upsert_agent_spending_limit()
      RPCs from 20261121000000_ai_agent_governance.sql. Nothing new is
      invented for "running" an agent template — it configures the
      governance layer that already gates every autonomous agent, and its
      real-world performance feeds the Outcome-Based Learning Loop from
      20261203000000_agent_outcome_learning_loop.sql.
    - Playbook templates are a lightweight, generic step-by-step guide
      (title + sections of checklist items) — deliberately NOT the same
      as the trade-specific price/article playbooks in
      trade_playbook_installs, which stay exactly as they are.

  Model:
    template_library_items            — the public catalog (reference
                                         data, seeded below; not per-tenant).
    template_library_installs         — per-account record of what was
                                         copied from the catalog, pointing
                                         at whatever it actually created.
    template_library_playbook_installs — the account's own editable copy,
                                         for type = 'playbook' installs only.

  "Copy, customize, run": install_template_library_item() is the copy step
  (idempotent — clicking it twice never double-creates anything); after
  that the business owns and edits the result exactly like any
  hand-built workflow/permission/playbook — this table set never gets
  touched again by the template it came from.

  RLS: template_library_items is public reference data (SELECT true for
  authenticated, same idiom as agent_action_catalog). The two per-tenant
  tables are account-scoped via get_account_owner_id(); side-effecting
  writes go through install_template_library_item() (SECURITY DEFINER).
*/

-- =============================================================
-- TEMPLATE_LIBRARY_ITEMS — the public catalog (reference data)
-- =============================================================

CREATE TABLE IF NOT EXISTS template_library_items (
  slug text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('workflow', 'agent', 'playbook')),
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  -- NULL = works for every trade/vertical.
  industry text,
  tags text[] NOT NULL DEFAULT '{}',
  is_featured boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  install_count integer NOT NULL DEFAULT 0,
  -- Shape depends on type:
  --   workflow: { trigger_event, trigger_conditions, steps: WorkflowStepDefinition[] }
  --   agent:    { permissions: [{action_slug, enabled, requires_approval, auto_approve_max_cents}],
  --               spending_limits: [{action_slug|null, period, limit_cents}] }
  --   playbook: { sections: [{ title, items: string[] }] }
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_library_items_type
  ON template_library_items(type, category) WHERE is_active = true;

ALTER TABLE template_library_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_select_template_library_items" ON template_library_items;
CREATE POLICY "authenticated_select_template_library_items" ON template_library_items FOR SELECT TO authenticated
  USING (is_active = true);

-- No client write policy — catalog is shipped via migration; a future
-- admin tool would write through a service-role-only RPC, not directly.

-- =============================================================
-- TEMPLATE_LIBRARY_INSTALLS — per-account install record
-- =============================================================

CREATE TABLE IF NOT EXISTS template_library_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  template_slug text NOT NULL REFERENCES template_library_items(slug),
  template_version_installed integer NOT NULL,
  type text NOT NULL CHECK (type IN ('workflow', 'agent', 'playbook')),
  -- Where the actual, editable result lives. NULL result_table for
  -- type='agent': its effect is spread across agent_permissions /
  -- agent_spending_limits rows, which already track their own history.
  result_table text,
  result_id uuid,
  installed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_slug)
);

CREATE INDEX IF NOT EXISTS idx_template_library_installs_user
  ON template_library_installs(user_id, installed_at DESC);

ALTER TABLE template_library_installs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_template_library_installs" ON template_library_installs;
CREATE POLICY "select_own_template_library_installs" ON template_library_installs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_template_library_installs" ON template_library_installs;
CREATE POLICY "delete_own_template_library_installs" ON template_library_installs FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Removing this row only removes the "installed from library" tracking —
-- for type='workflow' the workflow itself is managed from the Workflows
-- page afterward (pause/archive/delete there), exactly like a hand-built one.

-- No client INSERT/UPDATE policy — only install_template_library_item() writes.

-- =============================================================
-- TEMPLATE_LIBRARY_PLAYBOOK_INSTALLS — the account's own editable copy
-- =============================================================

CREATE TABLE IF NOT EXISTS template_library_playbook_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  install_id uuid NOT NULL REFERENCES template_library_installs(id) ON DELETE CASCADE,
  template_slug text NOT NULL,
  title text NOT NULL,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (install_id)
);

ALTER TABLE template_library_playbook_installs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_template_library_playbook_installs" ON template_library_playbook_installs;
CREATE POLICY "select_own_template_library_playbook_installs" ON template_library_playbook_installs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_template_library_playbook_installs" ON template_library_playbook_installs;
CREATE POLICY "update_own_template_library_playbook_installs" ON template_library_playbook_installs FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
-- Free-form "customize" step: once installed, the owner edits title/sections
-- directly, same idiom as trade_playbook_tuning. No client INSERT policy —
-- the initial row is always cloned from the catalog by the RPC below.

CREATE OR REPLACE FUNCTION public.set_template_library_playbook_installs_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_template_library_playbook_installs_updated_at ON template_library_playbook_installs;
CREATE TRIGGER trg_template_library_playbook_installs_updated_at
  BEFORE UPDATE ON template_library_playbook_installs
  FOR EACH ROW EXECUTE FUNCTION public.set_template_library_playbook_installs_updated_at();

-- =============================================================
-- RPC: install_template_library_item — the "copy" button
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_template_library_item(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item template_library_items;
  v_existing template_library_installs;
  v_install_id uuid;
  v_result_table text;
  v_result_id uuid;
  v_wf workflow_definitions;
  v_perm jsonb;
  v_limit jsonb;
  v_playbook_id uuid;
BEGIN
  SELECT * INTO v_item FROM template_library_items WHERE slug = p_slug AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found or no longer available.', p_slug;
  END IF;

  -- Idempotent: a second click on "Install" never double-creates anything.
  SELECT * INTO v_existing FROM template_library_installs WHERE user_id = v_owner AND template_slug = p_slug;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_installed', 'install_id', v_existing.id, 'type', v_existing.type,
      'result_table', v_existing.result_table, 'result_id', v_existing.result_id
    );
  END IF;

  IF v_item.type = 'workflow' THEN
    v_wf := public.install_workflow_playbook(
      v_item.slug, v_item.title, v_item.description, v_item.industry,
      v_item.definition->>'trigger_event',
      COALESCE(v_item.definition->'trigger_conditions', '{}'::jsonb),
      v_item.definition->'steps'
    );
    v_result_table := 'workflow_definitions';
    v_result_id := v_wf.id;

  ELSIF v_item.type = 'agent' THEN
    FOR v_perm IN SELECT * FROM jsonb_array_elements(COALESCE(v_item.definition->'permissions', '[]'::jsonb))
    LOOP
      PERFORM public.upsert_agent_permission(
        v_perm->>'action_slug',
        (v_perm->>'enabled')::boolean,
        (v_perm->>'requires_approval')::boolean,
        false,
        NULLIF(v_perm->>'auto_approve_max_cents', '')::integer,
        false
      );
    END LOOP;
    FOR v_limit IN SELECT * FROM jsonb_array_elements(COALESCE(v_item.definition->'spending_limits', '[]'::jsonb))
    LOOP
      PERFORM public.upsert_agent_spending_limit(
        NULLIF(v_limit->>'action_slug', ''),
        COALESCE(v_limit->>'period', 'monthly'),
        (v_limit->>'limit_cents')::integer
      );
    END LOOP;
    v_result_table := NULL;
    v_result_id := NULL;

  ELSIF v_item.type = 'playbook' THEN
    v_result_table := 'template_library_playbook_installs';
    v_result_id := NULL; -- filled in below, once the install row exists to reference

  ELSE
    RAISE EXCEPTION 'Unknown template type: %', v_item.type;
  END IF;

  INSERT INTO template_library_installs (
    user_id, template_slug, template_version_installed, type, result_table, result_id
  ) VALUES (
    v_owner, p_slug, v_item.version, v_item.type, v_result_table, v_result_id
  ) RETURNING id INTO v_install_id;

  IF v_item.type = 'playbook' THEN
    INSERT INTO template_library_playbook_installs (user_id, install_id, template_slug, title, sections)
    VALUES (v_owner, v_install_id, p_slug, v_item.title, COALESCE(v_item.definition->'sections', '[]'::jsonb))
    RETURNING id INTO v_playbook_id;

    UPDATE template_library_installs SET result_id = v_playbook_id WHERE id = v_install_id;
    v_result_id := v_playbook_id;
  END IF;

  UPDATE template_library_items SET install_count = install_count + 1 WHERE slug = p_slug;

  RETURN jsonb_build_object(
    'status', 'installed', 'install_id', v_install_id, 'type', v_item.type,
    'result_table', v_result_table, 'result_id', v_result_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.install_template_library_item(text) TO authenticated;

-- =============================================================
-- SEED DATA — a real starter library, not an empty shelf
-- =============================================================

INSERT INTO template_library_items (slug, type, title, description, category, industry, tags, is_featured, definition) VALUES

  -- Workflow templates — reuse install_workflow_playbook() exactly as
  -- workflowPlaybooks.ts does; config.body matches what
  -- workflow-engine-executor's sms step actually reads.
  (
    'missed-call-text-back', 'workflow', 'Missed Call Text-Back',
    'The instant a call is missed, the caller gets an SMS so you never lose a lead to voicemail.',
    'Lead Response', NULL, ARRAY['calls', 'sms', 'lead-response'], true,
    jsonb_build_object(
      'trigger_event', 'call.missed',
      'trigger_conditions', '{}'::jsonb,
      'steps', jsonb_build_array(
        jsonb_build_object('step_number', 1, 'type', 'sms', 'delay_minutes', 1, 'on_failure', 'stop',
          'config', jsonb_build_object('body', 'Sorry we missed your call! This is {{business_name}} — reply here or call back and we''ll get you booked in.'))
      )
    )
  ),
  (
    'quote-follow-up-3-touch', 'workflow', 'Quote Follow-Up (3-Touch)',
    'A sent-but-not-yet-accepted quote gets a friendly nudge at 1 day, 3 days, and 7 days.',
    'Sales', NULL, ARRAY['quotes', 'sms', 'follow-up'], true,
    jsonb_build_object(
      'trigger_event', 'quote.sent',
      'trigger_conditions', '{}'::jsonb,
      'steps', jsonb_build_array(
        jsonb_build_object('step_number', 1, 'type', 'sms', 'delay_minutes', 1440, 'on_failure', 'continue',
          'config', jsonb_build_object('body', 'Hi {{customer_name}}, just checking you received our quote — happy to answer any questions!')),
        jsonb_build_object('step_number', 2, 'type', 'sms', 'delay_minutes', 4320, 'on_failure', 'continue',
          'config', jsonb_build_object('body', 'Following up on your quote from {{business_name}} — want us to get you on the schedule?')),
        jsonb_build_object('step_number', 3, 'type', 'sms', 'delay_minutes', 10080, 'on_failure', 'stop',
          'config', jsonb_build_object('body', 'Last check-in — this quote is still available if you''d like to move forward. Just reply here!'))
      )
    )
  ),
  (
    'review-request-after-job', 'workflow', 'Review Request After Job',
    'One hour after a job is completed, the customer gets a friendly request to leave a review.',
    'Reputation', NULL, ARRAY['reviews', 'sms', 'reputation'], false,
    jsonb_build_object(
      'trigger_event', 'job.completed',
      'trigger_conditions', '{}'::jsonb,
      'steps', jsonb_build_array(
        jsonb_build_object('step_number', 1, 'type', 'sms', 'delay_minutes', 60, 'on_failure', 'stop',
          'config', jsonb_build_object('body', 'Thanks for choosing {{business_name}}, {{customer_name}}! Mind leaving us a quick review? It really helps.'))
      )
    )
  ),

  -- AI Agent templates — governance presets, applied via
  -- upsert_agent_permission() / upsert_agent_spending_limit(). Every
  -- action_slug below already exists in agent_action_catalog.
  (
    'conservative-financing-agent', 'agent', 'Conservative Financing Agent',
    'Financing offers always need a human''s sign-off, and can never exceed $5,000/month unattended.',
    'Financial', NULL, ARRAY['financing', 'governance', 'conservative'], true,
    jsonb_build_object(
      'permissions', jsonb_build_array(
        jsonb_build_object('action_slug', 'financing_offer', 'enabled', true, 'requires_approval', true)
      ),
      'spending_limits', jsonb_build_array(
        jsonb_build_object('action_slug', 'financing_offer', 'period', 'monthly', 'limit_cents', 500000)
      )
    )
  ),
  (
    'always-on-followup-agent', 'agent', 'Always-On Follow-Up Agent',
    'Follow-up SMS/call steps run without waiting for approval — the lowest-risk, highest-volume autonomous action.',
    'Lead Response', NULL, ARRAY['follow-up', 'governance', 'automation'], true,
    jsonb_build_object(
      'permissions', jsonb_build_array(
        jsonb_build_object('action_slug', 'followup_dispatch', 'enabled', true, 'requires_approval', false)
      ),
      'spending_limits', '[]'::jsonb
    )
  ),
  (
    'guarded-marketing-agent', 'agent', 'Guarded Marketing Agent',
    'Marketing campaign sends are allowed to run on their own, capped at $1,000/week so a bad list never gets expensive.',
    'Marketing', NULL, ARRAY['marketing', 'governance', 'spend-cap'], false,
    jsonb_build_object(
      'permissions', jsonb_build_array(
        jsonb_build_object('action_slug', 'marketing_campaign_send', 'enabled', true, 'requires_approval', false, 'auto_approve_max_cents', 100000)
      ),
      'spending_limits', jsonb_build_array(
        jsonb_build_object('action_slug', 'marketing_campaign_send', 'period', 'weekly', 'limit_cents', 100000)
      )
    )
  ),

  -- Playbook templates — generic step-by-step guides, cloned into the
  -- account's own editable copy on install.
  (
    'new-technician-onboarding', 'playbook', 'New Technician Onboarding',
    'A two-week checklist for bringing a new field technician up to speed safely and consistently.',
    'Operations', NULL, ARRAY['onboarding', 'hr', 'field-ops'], true,
    jsonb_build_object('sections', jsonb_build_array(
      jsonb_build_object('title', 'Week 1', 'items', jsonb_build_array(
        'Ride along with a senior tech on 3 jobs', 'Review the truck stock checklist',
        'Complete safety orientation', 'Shadow one emergency dispatch call'
      )),
      jsonb_build_object('title', 'Week 2', 'items', jsonb_build_array(
        'Run first solo job with phone support available', 'Review pricing book walkthrough',
        'Confirm uniform, badge, and app access', 'Check in with manager on first-week feedback'
      ))
    ))
  ),
  (
    'emergency-dispatch-checklist', 'playbook', 'Emergency Dispatch Checklist',
    'What the dispatcher confirms before sending a technician to an emergency call.',
    'Operations', NULL, ARRAY['dispatch', 'emergency', 'checklist'], false,
    jsonb_build_object('sections', jsonb_build_array(
      jsonb_build_object('title', 'Before Dispatch', 'items', jsonb_build_array(
        'Confirm exact address and access instructions', 'Ask about any safety hazards on-site',
        'Verify the nearest available technician''s ETA', 'Set customer expectations on arrival time'
      )),
      jsonb_build_object('title', 'After Dispatch', 'items', jsonb_build_array(
        'Send the live ETA tracking link to the customer', 'Log the emergency in the on-call notes',
        'Confirm technician arrival with a check-in text'
      ))
    ))
  )

ON CONFLICT (slug) DO NOTHING;
