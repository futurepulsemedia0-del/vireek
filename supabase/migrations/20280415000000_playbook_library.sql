/*
  # Playbook Library — one-click, trade-specific operating modes

  ## Why
  Surge mode, call scripts, escalation rules, booking capacity, message templates and holidays are each
  configured on their own page. During a heatwave, freeze or storm an owner has to change eight
  things in eight places while the phone is ringing. A playbook is a typed, versioned bundle that
  changes them together, shows exactly what will change first, expires on its own and rolls back.

  ## What this adds (purely additive; nothing changes for an account until someone activates a playbook)
  1. playbook_settings           per-account switches: suggestions on/off, owner-approved auto-activation list.
  2. playbook_custom             owner-authored playbooks; HQ can share one to their franchise group.
  3. playbook_activations        one row per activation: definition SNAPSHOT, window, status lifecycle.
  4. playbook_activation_items   per-item before/after values (the rollback source of truth).
  5. playbook_surface_locks      DB-enforced conflict detection: one live item per surface (PK per tenant).
  6. playbook_audit_log          append-only audit trail (also mirrored into business_activity_events).
  7. RPCs: create / confirm / approve_item / rollback (user), system_* (scheduler, service_role only),
     current_state, banner, settings, custom save/share/delete.

  ## Security model
  - Every table is tenant-scoped with get_account_owner_id(); reads additionally need can_manage_playbooks()
    (owner, or team member with can_edit_business_profile). The banner RPC exposes only name/end time to all members.
  - Clients can NEVER write these tables directly (no INSERT/UPDATE/DELETE policies). All writes go through
    SECURITY DEFINER functions that re-validate the whole definition (playbook_validate_definition) — a
    hand-built or shared definition cannot skip a guardrail.
  - Guardrails enforced here: no prices in text, price changes (after-hours fee) and ad changes need OWNER
    approval and ads are never executed, no text that weakens AI disclosure / recording notice / opt-out /
    emergency handling, no item kind can disable emergency detection, the emergency reserve can only be RAISED,
    capacity / fee / automation items need the account OWNER (matches update_booking_capacity_policy),
    message templates are created as DRAFTS and still pass the existing review workflow.
  - Rollback restores only values that still equal what the playbook wrote; anything edited by hand since is kept.

  ## Rollback of this migration (manual)
  Roll back live activations first (SELECT public.playbook_rollback(id) for each active one), then drop the
  tables/functions created here. Only additive objects were created; no existing column or policy was altered.
*/

-- =============================================================
-- 0. Permission helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_playbooks()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE(
          CASE WHEN cr.permissions ? 'can_edit_business_profile' THEN (cr.permissions -> 'can_edit_business_profile') = 'true'::jsonb END,
          (tm.permissions -> 'can_edit_business_profile') = 'true'::jsonb,
          false
        )
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.playbook_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND auth.uid() = public.get_account_owner_id();
$$;

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public.playbook_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  suggestions_enabled boolean NOT NULL DEFAULT true,
  -- Owner-approved playbook keys that may start automatically when a real signal fires.
  auto_apply_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(auto_apply_keys) <= 12),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.playbook_custom (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^custom-[a-z0-9-]{2,50}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  definition jsonb NOT NULL,
  shared_group_id uuid REFERENCES public.franchise_groups(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_playbook_custom_group ON public.playbook_custom (shared_group_id) WHERE shared_group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.playbook_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  playbook_key text NOT NULL CHECK (playbook_key ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  playbook_version integer NOT NULL DEFAULT 1 CHECK (playbook_version >= 1),
  playbook_name text NOT NULL CHECK (char_length(btrim(playbook_name)) BETWEEN 1 AND 120),
  source text NOT NULL DEFAULT 'library' CHECK (source IN ('library', 'custom')),
  custom_id uuid REFERENCES public.playbook_custom(id) ON DELETE SET NULL,
  trigger_source text NOT NULL DEFAULT 'manual' CHECK (trigger_source IN ('manual', 'scheduled', 'signal')),
  signal jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('suggested', 'scheduled', 'pending_approval', 'active', 'expired', 'rolled_back', 'dismissed', 'failed')),
  definition jsonb NOT NULL,
  enabled_item_ids text[] NOT NULL CHECK (cardinality(enabled_item_ids) BETWEEN 1 AND 20),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  suggest_expires_at timestamptz,
  created_by uuid,
  confirmed_by uuid,
  applied_at timestamptz,
  rolled_back_at timestamptz,
  rollback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id),
  CONSTRAINT playbook_window_valid CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '60 days')
);

-- One live activation per playbook per account (suggestion, schedule or running).
CREATE UNIQUE INDEX IF NOT EXISTS uq_playbook_activations_live
  ON public.playbook_activations (user_id, playbook_key)
  WHERE status IN ('suggested', 'scheduled', 'pending_approval', 'active');
CREATE INDEX IF NOT EXISTS idx_playbook_activations_user ON public.playbook_activations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbook_activations_due ON public.playbook_activations (starts_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_playbook_activations_expiring ON public.playbook_activations (ends_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_playbook_activations_stale ON public.playbook_activations (suggest_expires_at) WHERE status = 'suggested';

CREATE TABLE IF NOT EXISTS public.playbook_activation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activation_id uuid NOT NULL REFERENCES public.playbook_activations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  position integer NOT NULL,
  item_id text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('planned', 'applied', 'pending_approval', 'advisory', 'skipped', 'rolled_back', 'rollback_skipped')),
  surfaces text[] NOT NULL DEFAULT '{}',
  before jsonb NOT NULL DEFAULT '{}'::jsonb,
  after jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activation_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_playbook_items_activation ON public.playbook_activation_items (activation_id, position);

CREATE TABLE IF NOT EXISTS public.playbook_surface_locks (
  user_id uuid NOT NULL,
  surface text NOT NULL,
  activation_id uuid NOT NULL REFERENCES public.playbook_activations(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface)
);
CREATE INDEX IF NOT EXISTS idx_playbook_locks_activation ON public.playbook_surface_locks (activation_id);

CREATE TABLE IF NOT EXISTS public.playbook_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  activation_id uuid,
  playbook_key text,
  event text NOT NULL,
  actor_id uuid,
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_playbook_audit_user ON public.playbook_audit_log (user_id, created_at DESC);

-- =============================================================
-- 2. Row Level Security (read-only for clients; writes only via the functions below)
-- =============================================================

ALTER TABLE public.playbook_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_custom ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_activation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_surface_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playbook_settings_select" ON public.playbook_settings;
CREATE POLICY "playbook_settings_select" ON public.playbook_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_playbooks());

DROP POLICY IF EXISTS "playbook_custom_select" ON public.playbook_custom;
CREATE POLICY "playbook_custom_select" ON public.playbook_custom FOR SELECT TO authenticated
  USING (
    public.can_manage_playbooks()
    AND (
      user_id = public.get_account_owner_id()
      OR shared_group_id IN (
        SELECT fl.franchise_group_id FROM public.franchise_locations fl
        WHERE fl.location_profile_id = public.get_account_owner_id() AND fl.status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS "playbook_activations_select" ON public.playbook_activations;
CREATE POLICY "playbook_activations_select" ON public.playbook_activations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_playbooks());

DROP POLICY IF EXISTS "playbook_items_select" ON public.playbook_activation_items;
CREATE POLICY "playbook_items_select" ON public.playbook_activation_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_playbooks());

DROP POLICY IF EXISTS "playbook_locks_select" ON public.playbook_surface_locks;
CREATE POLICY "playbook_locks_select" ON public.playbook_surface_locks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_playbooks());

DROP POLICY IF EXISTS "playbook_audit_select" ON public.playbook_audit_log;
CREATE POLICY "playbook_audit_select" ON public.playbook_audit_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_playbooks());

-- =============================================================
-- 3. Validation (the database is the authority; engine.ts mirrors these rules for the UI)
-- =============================================================

CREATE OR REPLACE FUNCTION public.playbook_text_issue(
  p_text text, p_label text, p_min integer, p_max integer, p_allow_vars boolean
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_compliance text[] := ARRAY[
    $re$\mignore\M[^.]{0,20}\m(previous|prior|above|earlier|system)\M[^.]{0,20}\m(instructions?|rules?|prompt)\M$re$,
    $re$\m(do not|don't|never|avoid|skip|without)\M[^.]{0,30}\m(disclos\w*|mention|say|tell)\M[^.]{0,60}\m(ai|recorded|recording|automated|virtual assistant|assistant)\M$re$,
    $re$\m(disable|turn off|switch off|bypass|suppress)\M[^.]{0,30}\m(emergency|recording|disclosure|opt-?out|stop keyword)$re$,
    $re$\mskip\M[^.]{0,15}\m(the )?(disclosure|recording notice|opt-?out)$re$,
    $re$\m(pretend|claim|say|tell)\M[^.]{0,40}\m(you are|you're|to be)\M[^.]{0,20}\m(human|real person|not an ai)$re$
  ];
  v_re text;
BEGIN
  IF p_text IS NULL THEN
    IF p_min > 0 THEN RETURN p_label || ' is required.'; END IF;
    RETURN NULL;
  END IF;
  IF char_length(btrim(p_text)) < p_min OR char_length(p_text) > p_max THEN
    RETURN p_label || ' must be between ' || p_min::text || ' and ' || p_max::text || ' characters.';
  END IF;
  IF p_text ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' THEN
    RETURN p_label || ' contains control characters.';
  END IF;
  IF NOT p_allow_vars AND (position('{{' IN p_text) > 0 OR position('}}' IN p_text) > 0) THEN
    RETURN p_label || ' cannot contain {{ }} variables.';
  END IF;
  FOREACH v_re IN ARRAY v_compliance LOOP
    IF p_text ~* v_re THEN
      RETURN p_label || ' must not weaken AI disclosure, recording notices, opt-out language or emergency handling.';
    END IF;
  END LOOP;
  IF p_text ~* $re$[$€£]\s?[0-9]|\m[0-9][0-9,.]*\s?(dollars|usd|bucks)\M$re$ THEN
    RETURN p_label || ' contains a price. Playbooks never publish prices in text.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_item_surfaces(p_item jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_p jsonb := COALESCE(p_item -> 'params', '{}'::jsonb);
  v_out text[] := '{}';
BEGIN
  CASE p_item ->> 'kind'
    WHEN 'call_script' THEN v_out := ARRAY['call_script:' || (v_p ->> 'scenario')];
    WHEN 'surge' THEN v_out := ARRAY['surge'];
    WHEN 'escalation_rule' THEN v_out := ARRAY['escalation:' || (v_p ->> 'trigger') || ':' || (v_p ->> 'action')];
    WHEN 'capacity' THEN
      IF v_p ? 'maxSlotsScalePct' OR v_p ? 'overbookJobsPerTech' THEN v_out := v_out || 'capacity:booking'; END IF;
      IF v_p ? 'emergencyReserveAdd' THEN v_out := v_out || 'capacity:reserve'; END IF;
      IF v_p ? 'waitlistEnabled' THEN v_out := v_out || 'capacity:waitlist'; END IF;
    WHEN 'message_template' THEN v_out := ARRAY['template:' || (v_p ->> 'channel') || ':' || lower(btrim(v_p ->> 'name'))];
    WHEN 'closure' THEN v_out := ARRAY['closure'];
    WHEN 'after_hours_fee' THEN v_out := ARRAY['after_hours_fee'];
    WHEN 'automation' THEN v_out := ARRAY['automation:' || (v_p ->> 'slug')];
    ELSE v_out := '{}';
  END CASE;
  RETURN v_out;
END;
$$;

-- Returns NULL when the definition is acceptable, otherwise a human-readable reason.
CREATE OR REPLACE FUNCTION public.playbook_validate_definition(p_def jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_p jsonb;
  v_id text;
  v_kind text;
  v_err text;
  v_ids text[] := '{}';
  v_seen text[] := '{}';
  v_s text;
  v_n numeric;
BEGIN
  IF p_def IS NULL OR jsonb_typeof(p_def) <> 'object' THEN RETURN 'Definition must be an object.'; END IF;
  IF jsonb_typeof(p_def -> 'items') <> 'array' OR jsonb_array_length(p_def -> 'items') NOT BETWEEN 1 AND 20 THEN
    RETURN 'A playbook needs between 1 and 20 items.';
  END IF;
  v_err := public.playbook_text_issue(p_def ->> 'name', 'Playbook name', 1, 120, true);
  IF v_err IS NOT NULL THEN RETURN v_err; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_def -> 'items') LOOP
    v_id := v_item ->> 'id';
    v_kind := v_item ->> 'kind';
    v_p := COALESCE(v_item -> 'params', '{}'::jsonb);
    IF v_id IS NULL OR v_id !~ '^[a-z0-9][a-z0-9-]{1,59}$' THEN RETURN 'Every item needs a lowercase id.'; END IF;
    IF v_id = ANY (v_ids) THEN RETURN 'Duplicate item id ' || v_id || '.'; END IF;
    v_ids := v_ids || v_id;
    IF jsonb_typeof(v_p) <> 'object' THEN RETURN v_id || ': params must be an object.'; END IF;

    v_err := public.playbook_text_issue(v_item ->> 'title', 'Title', 1, 120, true);
    IF v_err IS NULL THEN v_err := public.playbook_text_issue(COALESCE(v_item ->> 'why', ''), 'Description', 0, 300, true); END IF;

    IF v_err IS NULL THEN
      CASE v_kind
        WHEN 'call_script' THEN
          IF (v_p ->> 'scenario') IS NULL OR NOT ((v_p ->> 'scenario') = ANY (ARRAY['emergency','after_hours','new_inquiry','price_quote','reschedule_cancel','existing_customer','complaint'])) THEN
            v_err := 'Unknown call-script scenario.';
          END IF;
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(COALESCE(v_p ->> 'opening_line', ''), 'Opening line', 0, 300, false); END IF;
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(v_p ->> 'body', 'Script body', 20, 2500, false); END IF;
        WHEN 'surge' THEN
          v_err := public.playbook_text_issue(v_p ->> 'message', 'Surge message', 1, 500, false);
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(v_p ->> 'priority', 'Surge priority', 1, 500, false); END IF;
          IF v_err IS NULL AND v_p ? 'maxBookingsPerDay' THEN
            IF jsonb_typeof(v_p -> 'maxBookingsPerDay') <> 'number' OR (v_p ->> 'maxBookingsPerDay') !~ '^[0-9]{1,3}$'
               OR (v_p ->> 'maxBookingsPerDay')::int NOT BETWEEN 1 AND 200 THEN
              v_err := 'Max bookings per day is out of range.';
            END IF;
          END IF;
        WHEN 'escalation_rule' THEN
          IF (v_p ->> 'trigger') IS NULL OR NOT ((v_p ->> 'trigger') = ANY (ARRAY['emergency','after_hours','no_answer'])) THEN v_err := 'Unknown escalation trigger.'; END IF;
          IF v_err IS NULL AND ((v_p ->> 'action') IS NULL OR NOT ((v_p ->> 'action') = ANY (ARRAY['sms','transfer']))) THEN v_err := 'Unknown escalation action.'; END IF;
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(COALESCE(v_p ->> 'note', ''), 'Note', 0, 200, false); END IF;
        WHEN 'capacity' THEN
          IF v_p ? 'maxSlotsScalePct' THEN
            IF jsonb_typeof(v_p -> 'maxSlotsScalePct') <> 'number' OR (v_p ->> 'maxSlotsScalePct') !~ '^-?[0-9]{1,3}$'
               OR (v_p ->> 'maxSlotsScalePct')::int NOT BETWEEN -60 AND 50 THEN
              v_err := 'Slot change must be between -60% and +50%.';
            END IF;
          END IF;
          IF v_err IS NULL AND v_p ? 'emergencyReserveAdd' THEN
            IF jsonb_typeof(v_p -> 'emergencyReserveAdd') <> 'number' OR (v_p ->> 'emergencyReserveAdd') !~ '^-?[0-9]{1,3}$' THEN
              v_err := 'Emergency reserve change must be a whole number.';
            ELSIF (v_p ->> 'emergencyReserveAdd')::int < 0 THEN
              v_err := 'Playbooks can raise the emergency reserve but never lower it.';
            ELSIF (v_p ->> 'emergencyReserveAdd')::int > 5 THEN
              v_err := 'Emergency reserve change must be 0 to 5.';
            END IF;
          END IF;
          IF v_err IS NULL AND v_p ? 'overbookJobsPerTech' THEN
            IF jsonb_typeof(v_p -> 'overbookJobsPerTech') <> 'number' OR (v_p ->> 'overbookJobsPerTech') !~ '^[0-9]$'
               OR (v_p ->> 'overbookJobsPerTech')::int > 3 THEN
              v_err := 'Overbooking must be 0 to 3.';
            END IF;
          END IF;
          IF v_err IS NULL AND v_p ? 'waitlistEnabled' AND jsonb_typeof(v_p -> 'waitlistEnabled') <> 'boolean' THEN v_err := 'Waitlist must be true or false.'; END IF;
          IF v_err IS NULL AND cardinality(public.playbook_item_surfaces(v_item)) = 0 THEN v_err := 'Capacity item changes nothing.'; END IF;
        WHEN 'message_template' THEN
          IF (v_p ->> 'channel') IS NULL OR NOT ((v_p ->> 'channel') = ANY (ARRAY['sms','email'])) THEN v_err := 'Unknown channel.'; END IF;
          IF v_err IS NULL AND ((v_p ->> 'category') IS NULL OR NOT ((v_p ->> 'category') = ANY (ARRAY['appointment','service_update','payment','review_request','follow_up','marketing']))) THEN
            v_err := 'Unknown template category.';
          END IF;
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(v_p ->> 'name', 'Template name', 1, 120, true); END IF;
          IF v_err IS NULL THEN
            v_err := public.playbook_text_issue(v_p ->> 'body', 'Template body', 1, CASE WHEN (v_p ->> 'channel') = 'sms' THEN 1600 ELSE 10000 END, true);
          END IF;
          IF v_err IS NULL AND (v_p ->> 'channel') = 'email' THEN v_err := public.playbook_text_issue(v_p ->> 'subject', 'Subject', 1, 200, true); END IF;
          IF v_err IS NULL AND (v_p ->> 'channel') = 'sms' AND (v_p ->> 'category') = 'marketing' AND (v_p ->> 'body') !~* '\mstop\M' THEN
            v_err := 'Marketing texts must include opt-out language such as "Reply STOP to opt out."';
          END IF;
          IF v_err IS NULL AND (v_p ->> 'channel') = 'email' AND (v_p ->> 'category') = 'marketing' AND position('{{unsubscribe_link}}' IN (v_p ->> 'body')) = 0 THEN
            v_err := 'Marketing emails must include {{unsubscribe_link}}.';
          END IF;
        WHEN 'closure' THEN
          v_err := public.playbook_text_issue(v_p ->> 'label', 'Closure label', 1, 60, false);
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(v_p ->> 'message', 'Closure message', 1, 300, false); END IF;
        WHEN 'after_hours_fee' THEN
          IF jsonb_typeof(v_p -> 'amountCents') <> 'number' OR (v_p ->> 'amountCents') !~ '^[0-9]{1,6}$' OR (v_p ->> 'amountCents')::int > 50000 THEN
            v_err := 'Fee out of range.';
          END IF;
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(COALESCE(v_p ->> 'note', ''), 'Fee note', 0, 500, false); END IF;
        WHEN 'automation' THEN
          IF (v_p ->> 'slug') IS NULL OR (v_p ->> 'slug') !~ '^[a-z0-9][a-z0-9-]{1,59}$' THEN v_err := 'Invalid automation slug.'; END IF;
        WHEN 'advisory' THEN
          IF (v_p ->> 'area') IS NULL OR NOT ((v_p ->> 'area') = ANY (ARRAY['staffing','ads','followup','marketing','hiring','operations'])) THEN v_err := 'Unknown advisory area.'; END IF;
          IF v_err IS NULL AND v_p ? 'action' AND NOT ((v_p ->> 'action') = ANY (ARRAY['pause','boost','none'])) THEN v_err := 'Unknown advisory action.'; END IF;
          IF v_err IS NULL THEN v_err := public.playbook_text_issue(v_p ->> 'detail', 'Advisory', 1, 1200, false); END IF;
        ELSE
          v_err := 'Unknown item kind.';
      END CASE;
    END IF;

    IF v_err IS NOT NULL THEN RETURN v_id || ': ' || v_err; END IF;

    FOREACH v_s IN ARRAY public.playbook_item_surfaces(v_item) LOOP
      IF v_s = ANY (v_seen) THEN RETURN v_id || ': two items write to ' || v_s || '.'; END IF;
      v_seen := v_seen || v_s;
    END LOOP;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._playbook_tokens(p_text text, p_starts timestamptz, p_ends timestamptz, p_tz text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT replace(
           replace(COALESCE(p_text, ''), '%START_DATE%', to_char(p_starts AT TIME ZONE p_tz, 'FMMonth FMDD')),
           '%END_DATE%', to_char(p_ends AT TIME ZONE p_tz, 'FMMonth FMDD'));
$$;

CREATE OR REPLACE FUNCTION public._playbook_audit(
  p_user uuid, p_activation uuid, p_key text, p_event text, p_actor uuid, p_actor_type text, p_detail jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.playbook_audit_log (user_id, activation_id, playbook_key, event, actor_id, actor_type, detail)
  VALUES (p_user, p_activation, p_key, p_event, p_actor, p_actor_type, COALESCE(p_detail, '{}'::jsonb));
  -- Mirror into the replayable business ledger. Best-effort: a ledger problem must never block an operator.
  BEGIN
    IF p_activation IS NOT NULL THEN
      PERFORM public.append_activity_event(
        p_aggregate_type := 'playbook_activation',
        p_aggregate_id := p_activation,
        p_event_type := 'playbook.' || p_event,
        p_event_data := jsonb_build_object('playbook_key', p_key) || COALESCE(p_detail, '{}'::jsonb),
        p_actor_type := p_actor_type,
        p_user_id := p_user
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'playbook ledger mirror failed: %', SQLERRM;
  END;
END;
$$;

-- =============================================================
-- 4. Per-item apply / rollback (internal; no grants)
-- =============================================================

CREATE OR REPLACE FUNCTION public._playbook_apply_item(p_act public.playbook_activations, p_item jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := p_act.user_id;
  v_kind text := p_item ->> 'kind';
  v_p jsonb := COALESCE(p_item -> 'params', '{}'::jsonb);
  v_tz text;
  v_script record;
  v_ver uuid;
  v_bp record;
  v_msg text;
  v_prio text;
  v_phone text;
  v_rules jsonb;
  v_rule_id text;
  v_bk record;
  v_dm record;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_new_slots integer;
  v_new_over integer;
  v_new_reserve integer;
  v_new_wait boolean;
  v_name text;
  v_tid uuid;
  v_hol jsonb;
  v_d date;
  v_added text[] := '{}';
  v_st text;
BEGIN
  SELECT COALESCE(NULLIF(btrim(timezone), ''), 'UTC') INTO v_tz FROM public.business_profile WHERE user_id = v_owner;
  v_tz := COALESCE(v_tz, 'UTC');

  CASE v_kind
    WHEN 'call_script' THEN
      SELECT id, active_version_id, challenger_version_id, challenger_traffic_pct INTO v_script
        FROM public.call_scripts WHERE user_id = v_owner AND scenario = v_p ->> 'scenario' FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.call_scripts (user_id, scenario) VALUES (v_owner, v_p ->> 'scenario')
        RETURNING id, active_version_id, challenger_version_id, challenger_traffic_pct INTO v_script;
      END IF;
      INSERT INTO public.call_script_versions (script_id, user_id, opening_line, body, change_note, created_by)
      VALUES (
        v_script.id, v_owner,
        left(public._playbook_tokens(COALESCE(v_p ->> 'opening_line', ''), p_act.starts_at, p_act.ends_at, v_tz), 300),
        left(public._playbook_tokens(v_p ->> 'body', p_act.starts_at, p_act.ends_at, v_tz), 2500),
        left('Playbook: ' || p_act.playbook_name, 200), p_actor
      ) RETURNING id INTO v_ver;
      -- A playbook script supersedes a running A/B test; rollback restores the challenger.
      UPDATE public.call_scripts SET active_version_id = v_ver, challenger_version_id = NULL, challenger_traffic_pct = 0
        WHERE id = v_script.id;
      RETURN jsonb_build_object('status', 'applied',
        'before', jsonb_build_object('script_id', v_script.id, 'active_version_id', v_script.active_version_id,
                                     'challenger_version_id', v_script.challenger_version_id, 'challenger_traffic_pct', v_script.challenger_traffic_pct),
        'after', jsonb_build_object('script_id', v_script.id, 'active_version_id', v_ver));

    WHEN 'surge' THEN
      SELECT surge_mode_active, surge_mode_enabled, surge_mode_note, surge_mode_message, surge_mode_priority,
             surge_max_bookings_per_day, surge_mode_activated_at, surge_mode_source
        INTO v_bp FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'skipped', 'note', 'No business profile found.'); END IF;
      v_msg := left(public._playbook_tokens(v_p ->> 'message', p_act.starts_at, p_act.ends_at, v_tz), 500);
      v_prio := left(public._playbook_tokens(v_p ->> 'priority', p_act.starts_at, p_act.ends_at, v_tz), 500);
      UPDATE public.business_profile SET
        surge_mode_active = true, surge_mode_enabled = true,
        surge_mode_note = v_msg, surge_mode_message = v_msg, surge_mode_priority = v_prio,
        surge_max_bookings_per_day = COALESCE(NULLIF(v_p ->> 'maxBookingsPerDay', '')::integer, surge_max_bookings_per_day),
        surge_mode_activated_at = CASE WHEN COALESCE(v_bp.surge_mode_active, false) THEN surge_mode_activated_at ELSE now() END,
        -- 'manual' so the weather checker never overrides a playbook the owner chose.
        surge_mode_source = 'manual'
      WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'applied', 'before', to_jsonb(v_bp),
        'after', jsonb_build_object('message', v_msg, 'priority', v_prio));

    WHEN 'escalation_rule' THEN
      SELECT phone INTO v_phone FROM public.profiles WHERE id = v_owner;
      IF v_phone IS NULL OR btrim(v_phone) = '' THEN
        RETURN jsonb_build_object('status', 'skipped', 'note', 'Add a phone number to your profile so alerts have somewhere to go.');
      END IF;
      SELECT escalation_rules INTO v_rules FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF v_rules IS NULL OR jsonb_typeof(v_rules) <> 'array' THEN v_rules := '[]'::jsonb; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rules) r
                 WHERE r ->> 'trigger' = v_p ->> 'trigger' AND r ->> 'action' = v_p ->> 'action' AND r ->> 'target' = v_phone) THEN
        RETURN jsonb_build_object('status', 'applied', 'note', 'An identical rule already exists.', 'after', jsonb_build_object('added', false));
      END IF;
      v_rule_id := 'pb-' || left(p_act.id::text, 8) || '-' || (p_item ->> 'id');
      UPDATE public.business_profile
        SET escalation_rules = v_rules || jsonb_build_array(jsonb_build_object(
          'id', v_rule_id, 'trigger', v_p ->> 'trigger', 'action', v_p ->> 'action', 'target', v_phone,
          'note', left(COALESCE(v_p ->> 'note', ''), 200)))
        WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'applied', 'after', jsonb_build_object('added', true, 'rule_id', v_rule_id));

    WHEN 'capacity' THEN
      IF v_p ? 'maxSlotsScalePct' OR v_p ? 'overbookJobsPerTech' THEN
        INSERT INTO public.booking_capacity_policies (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
        SELECT max_slots_per_day, overbook_jobs_per_tech INTO v_bk FROM public.booking_capacity_policies WHERE user_id = v_owner FOR UPDATE;
        v_new_slots := v_bk.max_slots_per_day;
        IF v_p ? 'maxSlotsScalePct' THEN
          v_new_slots := LEAST(48, GREATEST(1, round(v_bk.max_slots_per_day * (1 + (v_p ->> 'maxSlotsScalePct')::numeric / 100))::integer));
        END IF;
        v_new_over := v_bk.overbook_jobs_per_tech;
        IF v_p ? 'overbookJobsPerTech' THEN v_new_over := (v_p ->> 'overbookJobsPerTech')::integer; END IF;
        UPDATE public.booking_capacity_policies SET max_slots_per_day = v_new_slots, overbook_jobs_per_tech = v_new_over, updated_at = now()
          WHERE user_id = v_owner;
        v_before := v_before || jsonb_build_object('max_slots_per_day', v_bk.max_slots_per_day, 'overbook_jobs_per_tech', v_bk.overbook_jobs_per_tech);
        v_after := v_after || jsonb_build_object('max_slots_per_day', v_new_slots, 'overbook_jobs_per_tech', v_new_over);
      END IF;
      IF v_p ? 'emergencyReserveAdd' OR v_p ? 'waitlistEnabled' THEN
        INSERT INTO public.capacity_demand_policies (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
        SELECT emergency_reserve_slots, waitlist_enabled INTO v_dm FROM public.capacity_demand_policies WHERE user_id = v_owner FOR UPDATE;
        v_new_reserve := v_dm.emergency_reserve_slots + COALESCE((v_p ->> 'emergencyReserveAdd')::integer, 0);
        v_new_wait := COALESCE((v_p ->> 'waitlistEnabled')::boolean, v_dm.waitlist_enabled);
        UPDATE public.capacity_demand_policies SET emergency_reserve_slots = v_new_reserve, waitlist_enabled = v_new_wait, updated_at = now()
          WHERE user_id = v_owner;
        v_before := v_before || jsonb_build_object('emergency_reserve_slots', v_dm.emergency_reserve_slots, 'waitlist_enabled', v_dm.waitlist_enabled);
        v_after := v_after || jsonb_build_object('emergency_reserve_slots', v_new_reserve, 'waitlist_enabled', v_new_wait);
      END IF;
      RETURN jsonb_build_object('status', 'applied', 'before', v_before, 'after', v_after);

    WHEN 'message_template' THEN
      v_name := btrim(v_p ->> 'name');
      IF EXISTS (SELECT 1 FROM public.message_templates
                 WHERE user_id = v_owner AND channel = v_p ->> 'channel' AND lower(btrim(name)) = lower(v_name) AND status <> 'archived') THEN
        RETURN jsonb_build_object('status', 'skipped', 'note', 'A template with this name already exists and was left unchanged.');
      END IF;
      INSERT INTO public.message_templates (user_id, name, channel, category, subject, body, created_by)
      VALUES (
        v_owner, left(v_name, 120), v_p ->> 'channel', v_p ->> 'category',
        CASE WHEN v_p ->> 'channel' = 'email' THEN left(public._playbook_tokens(v_p ->> 'subject', p_act.starts_at, p_act.ends_at, v_tz), 200) END,
        left(public._playbook_tokens(v_p ->> 'body', p_act.starts_at, p_act.ends_at, v_tz), CASE WHEN v_p ->> 'channel' = 'sms' THEN 1600 ELSE 10000 END),
        COALESCE(p_actor, v_owner)
      ) RETURNING id INTO v_tid;
      RETURN jsonb_build_object('status', 'applied', 'note', 'Created as a draft. It still needs your review before it can be sent.',
        'after', jsonb_build_object('template_id', v_tid));

    WHEN 'closure' THEN
      SELECT holidays INTO v_hol FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF v_hol IS NULL OR jsonb_typeof(v_hol) <> 'array' THEN v_hol := '[]'::jsonb; END IF;
      FOR v_d IN
        SELECT g.d::date FROM generate_series((p_act.starts_at AT TIME ZONE v_tz)::date,
                                              ((p_act.ends_at - interval '1 second') AT TIME ZONE v_tz)::date, interval '1 day') AS g(d)
        LIMIT 60
      LOOP
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_hol) h WHERE h ->> 'date' = v_d::text) THEN
          v_rule_id := 'pb-' || left(p_act.id::text, 8) || '-' || v_d::text;
          v_hol := v_hol || jsonb_build_array(jsonb_build_object(
            'id', v_rule_id, 'date', v_d::text, 'label', v_p ->> 'label',
            'message', left(public._playbook_tokens(v_p ->> 'message', p_act.starts_at, p_act.ends_at, v_tz), 300)));
          v_added := v_added || v_rule_id;
        END IF;
      END LOOP;
      UPDATE public.business_profile SET holidays = v_hol WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'applied', 'after', jsonb_build_object('added_ids', to_jsonb(v_added)));

    WHEN 'automation' THEN
      SELECT status INTO v_st FROM public.automation_installs WHERE user_id = v_owner AND template_slug = v_p ->> 'slug' FOR UPDATE;
      IF NOT FOUND OR v_st = 'active' THEN
        RETURN jsonb_build_object('status', 'applied', 'note', 'Already running (automations run unless paused).', 'after', jsonb_build_object('changed', false));
      END IF;
      UPDATE public.automation_installs SET status = 'active', updated_at = now() WHERE user_id = v_owner AND template_slug = v_p ->> 'slug';
      RETURN jsonb_build_object('status', 'applied', 'before', jsonb_build_object('status', v_st), 'after', jsonb_build_object('changed', true, 'status', 'active', 'slug', v_p ->> 'slug'));

    ELSE
      RETURN jsonb_build_object('status', 'skipped', 'note', 'Unsupported item kind.');
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public._playbook_rollback_item(p_act public.playbook_activations, p_row public.playbook_activation_items)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := p_act.user_id;
  v_b jsonb := p_row.before;
  v_a jsonb := p_row.after;
  v_cur uuid;
  v_bp record;
  v_rules jsonb;
  v_hol jsonb;
  v_ids text[];
  v_st text;
  v_bk record;
  v_dm record;
  v_skipped boolean := false;
BEGIN
  CASE p_row.kind
    WHEN 'call_script' THEN
      SELECT active_version_id INTO v_cur FROM public.call_scripts WHERE id = (v_b ->> 'script_id')::uuid FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'The script no longer exists.'); END IF;
      IF v_cur IS DISTINCT FROM (v_a ->> 'active_version_id')::uuid THEN
        RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'The script was changed after the playbook; your newer version was kept.');
      END IF;
      UPDATE public.call_scripts SET active_version_id = (v_b ->> 'active_version_id')::uuid,
        challenger_version_id = CASE WHEN (v_b ->> 'challenger_version_id') IS NOT NULL
          AND (v_b ->> 'active_version_id') IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.call_script_versions v WHERE v.id = (v_b ->> 'challenger_version_id')::uuid)
          THEN (v_b ->> 'challenger_version_id')::uuid END,
        challenger_traffic_pct = CASE WHEN (v_b ->> 'challenger_version_id') IS NOT NULL AND (v_b ->> 'active_version_id') IS NOT NULL
          THEN COALESCE((v_b ->> 'challenger_traffic_pct')::integer, 0) ELSE 0 END
        WHERE id = (v_b ->> 'script_id')::uuid;
      RETURN jsonb_build_object('status', 'rolled_back');

    WHEN 'surge' THEN
      SELECT surge_mode_message INTO v_bp FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'No business profile found.'); END IF;
      IF v_bp.surge_mode_message IS DISTINCT FROM (v_a ->> 'message') THEN
        RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'Surge settings were changed after the playbook; your newer settings were kept.');
      END IF;
      UPDATE public.business_profile SET
        surge_mode_active = COALESCE((v_b ->> 'surge_mode_active')::boolean, false),
        surge_mode_enabled = COALESCE((v_b ->> 'surge_mode_enabled')::boolean, false),
        surge_mode_note = v_b ->> 'surge_mode_note',
        surge_mode_message = v_b ->> 'surge_mode_message',
        surge_mode_priority = v_b ->> 'surge_mode_priority',
        surge_max_bookings_per_day = (v_b ->> 'surge_max_bookings_per_day')::integer,
        surge_mode_activated_at = (v_b ->> 'surge_mode_activated_at')::timestamptz,
        surge_mode_source = v_b ->> 'surge_mode_source'
      WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'rolled_back');

    WHEN 'escalation_rule' THEN
      IF COALESCE((v_a ->> 'added')::boolean, false) IS NOT TRUE THEN RETURN jsonb_build_object('status', 'rolled_back', 'note', 'Nothing was added.'); END IF;
      SELECT escalation_rules INTO v_rules FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF v_rules IS NULL OR jsonb_typeof(v_rules) <> 'array' THEN RETURN jsonb_build_object('status', 'rolled_back'); END IF;
      UPDATE public.business_profile
        SET escalation_rules = (SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) FROM jsonb_array_elements(v_rules) r WHERE r ->> 'id' IS DISTINCT FROM (v_a ->> 'rule_id'))
        WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'rolled_back');

    WHEN 'capacity' THEN
      IF v_b ? 'max_slots_per_day' THEN
        SELECT max_slots_per_day, overbook_jobs_per_tech INTO v_bk FROM public.booking_capacity_policies WHERE user_id = v_owner FOR UPDATE;
        IF FOUND THEN
          IF v_bk.max_slots_per_day = (v_a ->> 'max_slots_per_day')::integer THEN
            UPDATE public.booking_capacity_policies SET max_slots_per_day = (v_b ->> 'max_slots_per_day')::integer, updated_at = now() WHERE user_id = v_owner;
          ELSE v_skipped := true; END IF;
          IF v_bk.overbook_jobs_per_tech = (v_a ->> 'overbook_jobs_per_tech')::integer THEN
            UPDATE public.booking_capacity_policies SET overbook_jobs_per_tech = (v_b ->> 'overbook_jobs_per_tech')::integer, updated_at = now() WHERE user_id = v_owner;
          ELSE v_skipped := true; END IF;
        END IF;
      END IF;
      IF v_b ? 'emergency_reserve_slots' THEN
        SELECT emergency_reserve_slots, waitlist_enabled INTO v_dm FROM public.capacity_demand_policies WHERE user_id = v_owner FOR UPDATE;
        IF FOUND THEN
          IF v_dm.emergency_reserve_slots = (v_a ->> 'emergency_reserve_slots')::integer THEN
            UPDATE public.capacity_demand_policies SET emergency_reserve_slots = (v_b ->> 'emergency_reserve_slots')::integer, updated_at = now() WHERE user_id = v_owner;
          ELSE v_skipped := true; END IF;
          IF v_dm.waitlist_enabled = (v_a ->> 'waitlist_enabled')::boolean THEN
            UPDATE public.capacity_demand_policies SET waitlist_enabled = (v_b ->> 'waitlist_enabled')::boolean, updated_at = now() WHERE user_id = v_owner;
          ELSE v_skipped := true; END IF;
        END IF;
      END IF;
      IF v_skipped THEN
        RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'Some capacity values were changed after the playbook; those were kept, the rest were restored.');
      END IF;
      RETURN jsonb_build_object('status', 'rolled_back');

    WHEN 'message_template' THEN
      SELECT status INTO v_st FROM public.message_templates WHERE id = (v_a ->> 'template_id')::uuid FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'rolled_back'); END IF;
      IF v_st IN ('draft', 'pending_review', 'rejected') THEN
        PERFORM set_config('vireek.template_rpc', 'on', true);
        UPDATE public.message_templates SET status = 'archived' WHERE id = (v_a ->> 'template_id')::uuid;
        PERFORM set_config('vireek.template_rpc', 'off', true);
        RETURN jsonb_build_object('status', 'rolled_back', 'note', 'Template archived.');
      END IF;
      RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'The template was approved or is in use, so it was kept.');

    WHEN 'closure' THEN
      SELECT holidays INTO v_hol FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF v_hol IS NULL OR jsonb_typeof(v_hol) <> 'array' THEN RETURN jsonb_build_object('status', 'rolled_back'); END IF;
      v_ids := ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_a -> 'added_ids', '[]'::jsonb)));
      UPDATE public.business_profile
        SET holidays = (SELECT COALESCE(jsonb_agg(h), '[]'::jsonb) FROM jsonb_array_elements(v_hol) h WHERE NOT ((h ->> 'id') = ANY (v_ids)))
        WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'rolled_back');

    WHEN 'after_hours_fee' THEN
      SELECT after_hours_fee::text AS fee INTO v_bp FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'rollback_skipped'); END IF;
      IF v_bp.fee::numeric IS DISTINCT FROM (v_a ->> 'fee')::numeric THEN
        RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'The fee was changed after the playbook; your newer value was kept.');
      END IF;
      UPDATE public.business_profile SET after_hours_fee = (v_b ->> 'fee')::numeric, after_hours_fee_note = v_b ->> 'note' WHERE user_id = v_owner;
      RETURN jsonb_build_object('status', 'rolled_back');

    WHEN 'automation' THEN
      IF COALESCE((v_a ->> 'changed')::boolean, false) IS NOT TRUE THEN RETURN jsonb_build_object('status', 'rolled_back'); END IF;
      SELECT status INTO v_st FROM public.automation_installs WHERE user_id = v_owner AND template_slug = v_a ->> 'slug' FOR UPDATE;
      IF FOUND AND v_st = 'active' THEN
        UPDATE public.automation_installs SET status = COALESCE(v_b ->> 'status', 'paused'), updated_at = now()
          WHERE user_id = v_owner AND template_slug = v_a ->> 'slug';
        RETURN jsonb_build_object('status', 'rolled_back');
      END IF;
      RETURN jsonb_build_object('status', 'rollback_skipped', 'note', 'The automation was changed after the playbook; it was left as is.');

    ELSE
      RETURN jsonb_build_object('status', 'rolled_back');
  END CASE;
END;
$$;

-- =============================================================
-- 5. Core apply / rollback (internal; no grants)
-- =============================================================

CREATE OR REPLACE FUNCTION public._playbook_needs_approval(p_item jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (p_item ->> 'kind') = 'after_hours_fee'
      OR ((p_item ->> 'kind') = 'advisory'
          AND (p_item -> 'params' ->> 'area') = 'ads'
          AND COALESCE(p_item -> 'params' ->> 'action', 'none') IN ('pause', 'boost'));
$$;

-- Kinds that mirror existing owner-only controls (update_booking_capacity_policy, fee, automations).
CREATE OR REPLACE FUNCTION public._playbook_owner_only(p_item jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (p_item ->> 'kind') IN ('capacity', 'after_hours_fee', 'automation');
$$;

CREATE OR REPLACE FUNCTION public._playbook_apply_core(p_activation_id uuid, p_actor uuid, p_actor_type text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_act public.playbook_activations;
  v_item jsonb;
  v_res jsonb;
  v_err text;
  v_surfaces text[];
  v_conf jsonb := '[]'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_owner_items jsonb := '[]'::jsonb;
  v_pos integer := 0;
  v_status text;
  v_lock record;
BEGIN
  SELECT * INTO v_act FROM public.playbook_activations WHERE id = p_activation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_act.status = 'active' THEN
    RETURN jsonb_build_object('status', 'active', 'idempotent', true, 'activation_id', v_act.id);
  END IF;
  IF v_act.status NOT IN ('suggested', 'scheduled', 'pending_approval') THEN
    RETURN jsonb_build_object('status', 'invalid_status', 'current', v_act.status);
  END IF;
  IF now() >= v_act.ends_at THEN
    UPDATE public.playbook_activations SET status = 'expired', updated_at = now() WHERE id = v_act.id;
    PERFORM public._playbook_audit(v_act.user_id, v_act.id, v_act.playbook_key, 'missed_window', p_actor, p_actor_type, '{}'::jsonb);
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  v_err := public.playbook_validate_definition(v_act.definition);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('status', 'invalid', 'error', v_err); END IF;

  PERFORM 1 FROM public.business_profile WHERE user_id = v_act.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_profile'); END IF;

  -- Owner-only items need the account owner (system path is pre-authorised by the owner who scheduled it).
  IF p_actor_type = 'user' AND p_actor IS DISTINCT FROM v_act.user_id THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_act.definition -> 'items') LOOP
      IF (v_item ->> 'id') = ANY (v_act.enabled_item_ids) AND public._playbook_owner_only(v_item) THEN
        v_owner_items := v_owner_items || to_jsonb(v_item ->> 'id');
      END IF;
    END LOOP;
    IF jsonb_array_length(v_owner_items) > 0 THEN
      UPDATE public.playbook_activations SET status = 'pending_approval', updated_at = now() WHERE id = v_act.id;
      PERFORM public._playbook_audit(v_act.user_id, v_act.id, v_act.playbook_key, 'owner_required', p_actor, p_actor_type,
        jsonb_build_object('items', v_owner_items));
      RETURN jsonb_build_object('status', 'owner_required', 'items', v_owner_items);
    END IF;
  END IF;

  -- Conflict detection (all-or-nothing): any enabled item whose surface another live playbook holds.
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_act.definition -> 'items') LOOP
    CONTINUE WHEN NOT ((v_item ->> 'id') = ANY (v_act.enabled_item_ids));
    v_surfaces := public.playbook_item_surfaces(v_item);
    FOR v_lock IN
      SELECT l.surface, l.activation_id, a.playbook_key, a.playbook_name
      FROM public.playbook_surface_locks l
      JOIN public.playbook_activations a ON a.id = l.activation_id
      WHERE l.user_id = v_act.user_id AND l.surface = ANY (v_surfaces) AND l.activation_id <> v_act.id
    LOOP
      v_conf := v_conf || jsonb_build_array(jsonb_build_object(
        'item_id', v_item ->> 'id', 'surface', v_lock.surface, 'activation_id', v_lock.activation_id,
        'playbook_key', v_lock.playbook_key, 'playbook_name', v_lock.playbook_name));
    END LOOP;
  END LOOP;
  IF jsonb_array_length(v_conf) > 0 THEN
    PERFORM public._playbook_audit(v_act.user_id, v_act.id, v_act.playbook_key, 'conflict', p_actor, p_actor_type,
      jsonb_build_object('conflicts', v_conf));
    RETURN jsonb_build_object('status', 'conflict', 'conflicts', v_conf);
  END IF;

  BEGIN
    DELETE FROM public.playbook_activation_items WHERE activation_id = v_act.id;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_act.definition -> 'items') LOOP
      CONTINUE WHEN NOT ((v_item ->> 'id') = ANY (v_act.enabled_item_ids));
      v_pos := v_pos + 1;
      v_surfaces := public.playbook_item_surfaces(v_item);
      IF v_item ->> 'kind' = 'advisory' AND NOT public._playbook_needs_approval(v_item) THEN
        v_res := jsonb_build_object('status', 'advisory', 'note', 'Recommendation only. Nothing was changed.');
      ELSIF public._playbook_needs_approval(v_item) THEN
        v_res := jsonb_build_object('status', 'pending_approval', 'note', 'Waiting for the account owner to approve. Nothing was changed.');
      ELSE
        v_res := public._playbook_apply_item(v_act, v_item, p_actor);
      END IF;
      v_status := v_res ->> 'status';

      INSERT INTO public.playbook_activation_items (activation_id, user_id, position, item_id, kind, title, status, surfaces, before, after, note)
      VALUES (v_act.id, v_act.user_id, v_pos, v_item ->> 'id', v_item ->> 'kind', left(v_item ->> 'title', 120), v_status,
              CASE WHEN v_status IN ('applied', 'pending_approval') THEN v_surfaces ELSE '{}' END,
              COALESCE(v_res -> 'before', '{}'::jsonb), COALESCE(v_res -> 'after', '{}'::jsonb), v_res ->> 'note');

      IF v_status IN ('applied', 'pending_approval') AND cardinality(v_surfaces) > 0 THEN
        INSERT INTO public.playbook_surface_locks (user_id, surface, activation_id, item_id)
        SELECT v_act.user_id, s, v_act.id, v_item ->> 'id' FROM unnest(v_surfaces) AS s;
      END IF;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item ->> 'id', 'kind', v_item ->> 'kind', 'status', v_status,
        'before', COALESCE(v_res -> 'before', '{}'::jsonb), 'after', COALESCE(v_res -> 'after', '{}'::jsonb), 'note', v_res ->> 'note'));
    END LOOP;

    UPDATE public.playbook_activations
      SET status = 'active', applied_at = now(), confirmed_by = p_actor, updated_at = now()
      WHERE id = v_act.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'conflict', 'race', true, 'conflicts', '[]'::jsonb);
  END;

  PERFORM public._playbook_audit(v_act.user_id, v_act.id, v_act.playbook_key, 'applied', p_actor, p_actor_type,
    jsonb_build_object('items', v_out, 'ends_at', v_act.ends_at));
  RETURN jsonb_build_object('status', 'active', 'activation_id', v_act.id, 'items', v_out, 'ends_at', v_act.ends_at);
END;
$$;

CREATE OR REPLACE FUNCTION public._playbook_rollback_core(p_activation_id uuid, p_actor uuid, p_actor_type text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_act public.playbook_activations;
  v_row public.playbook_activation_items;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
  v_final text;
BEGIN
  SELECT * INTO v_act FROM public.playbook_activations WHERE id = p_activation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_act.status IN ('rolled_back', 'expired', 'dismissed', 'failed') THEN
    RETURN jsonb_build_object('status', v_act.status, 'idempotent', true);
  END IF;
  IF v_act.status IN ('suggested', 'scheduled', 'pending_approval') THEN
    UPDATE public.playbook_activations SET status = 'dismissed', rolled_back_at = now(), rollback_reason = p_reason, updated_at = now() WHERE id = v_act.id;
    PERFORM public._playbook_audit(v_act.user_id, v_act.id, v_act.playbook_key, 'dismissed', p_actor, p_actor_type, jsonb_build_object('reason', p_reason));
    RETURN jsonb_build_object('status', 'dismissed');
  END IF;

  PERFORM 1 FROM public.business_profile WHERE user_id = v_act.user_id FOR UPDATE;
  FOR v_row IN SELECT * FROM public.playbook_activation_items WHERE activation_id = v_act.id ORDER BY position DESC LOOP
    IF v_row.status = 'applied' THEN
      v_res := public._playbook_rollback_item(v_act, v_row);
      UPDATE public.playbook_activation_items SET status = v_res ->> 'status', note = COALESCE(v_res ->> 'note', note) WHERE id = v_row.id;
    ELSIF v_row.status = 'pending_approval' THEN
      v_res := jsonb_build_object('status', 'skipped');
      UPDATE public.playbook_activation_items SET status = 'skipped', note = 'Never approved.' WHERE id = v_row.id;
    ELSE
      v_res := jsonb_build_object('status', v_row.status);
    END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object('item_id', v_row.item_id, 'status', v_res ->> 'status', 'note', v_res ->> 'note'));
  END LOOP;

  DELETE FROM public.playbook_surface_locks WHERE activation_id = v_act.id;
  v_final := CASE WHEN p_reason = 'expired' THEN 'expired' ELSE 'rolled_back' END;
  UPDATE public.playbook_activations
    SET status = v_final, rolled_back_at = now(), rollback_reason = p_reason, updated_at = now()
    WHERE id = v_act.id;
  PERFORM public._playbook_audit(v_act.user_id, v_act.id, v_act.playbook_key, v_final, p_actor, p_actor_type,
    jsonb_build_object('reason', p_reason, 'items', v_out));
  RETURN jsonb_build_object('status', v_final, 'items', v_out);
END;
$$;

-- =============================================================
-- 6. User-facing RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public._playbook_require_manager()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.can_manage_playbooks() THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501'; END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_create_activation(
  p_request_id uuid,
  p_playbook_key text,
  p_playbook_version integer,
  p_source text,
  p_custom_id uuid,
  p_definition jsonb,
  p_enabled_items text[],
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._playbook_require_manager();
  v_def jsonb := p_definition;
  v_custom public.playbook_custom;
  v_existing public.playbook_activations;
  v_err text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_dur integer;
  v_max integer;
  v_id uuid;
  v_status text := 'scheduled';
  v_res jsonb;
  v_item jsonb;
  v_needs_owner boolean := false;
  v_ids text[];
BEGIN
  IF p_request_id IS NULL THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'request_id is required.'); END IF;
  IF p_mode NOT IN ('now', 'schedule', 'dry_run') THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'Unknown mode.'); END IF;
  IF p_source NOT IN ('library', 'custom') THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'Unknown source.'); END IF;

  IF p_mode <> 'dry_run' THEN
    SELECT * INTO v_existing FROM public.playbook_activations WHERE user_id = v_owner AND request_id = p_request_id;
    IF FOUND THEN
      RETURN jsonb_build_object('status', v_existing.status, 'activation_id', v_existing.id, 'idempotent', true);
    END IF;
  END IF;

  IF p_source = 'custom' THEN
    SELECT c.* INTO v_custom FROM public.playbook_custom c
      WHERE c.id = p_custom_id AND (
        c.user_id = v_owner
        OR c.shared_group_id IN (SELECT fl.franchise_group_id FROM public.franchise_locations fl
                                 WHERE fl.location_profile_id = v_owner AND fl.status = 'active'));
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'Custom playbook not found.'); END IF;
    v_def := v_custom.definition;
  END IF;

  v_err := public.playbook_validate_definition(v_def);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('status', 'invalid', 'error', v_err); END IF;
  IF p_playbook_key IS NULL OR p_playbook_key !~ '^[a-z0-9][a-z0-9-]{1,59}$' THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'Invalid playbook key.');
  END IF;

  v_ids := ARRAY(SELECT i ->> 'id' FROM jsonb_array_elements(v_def -> 'items') i);
  IF p_enabled_items IS NULL OR cardinality(p_enabled_items) = 0 OR NOT (p_enabled_items <@ v_ids) THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'Select at least one valid item.');
  END IF;

  v_dur := LEAST(1440, GREATEST(1, COALESCE((v_def ->> 'defaultDurationHours')::integer, 72)));
  v_max := LEAST(1440, GREATEST(1, COALESCE((v_def ->> 'maxDurationHours')::integer, 1440)));
  v_starts := CASE WHEN p_mode IN ('now', 'dry_run') THEN now() ELSE COALESCE(p_starts_at, now()) END;
  v_ends := COALESCE(p_ends_at, v_starts + make_interval(hours => v_dur));
  IF v_ends <= v_starts THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'The end must be after the start.'); END IF;
  IF v_ends - v_starts > make_interval(hours => v_max) THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'This playbook cannot run that long.');
  END IF;
  IF p_mode = 'schedule' AND v_starts < now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'The start time is in the past.');
  END IF;

  IF NOT public.playbook_is_owner() THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_def -> 'items') LOOP
      IF (v_item ->> 'id') = ANY (p_enabled_items) AND public._playbook_owner_only(v_item) THEN v_needs_owner := true; END IF;
    END LOOP;
  END IF;
  IF v_needs_owner AND p_mode = 'schedule' THEN v_status := 'pending_approval'; END IF;

  IF p_mode = 'dry_run' THEN
    BEGIN
      INSERT INTO public.playbook_activations (user_id, request_id, playbook_key, playbook_version, playbook_name, source, custom_id,
        trigger_source, status, definition, enabled_item_ids, starts_at, ends_at, created_by)
      VALUES (v_owner, p_request_id, p_playbook_key, COALESCE(p_playbook_version, 1), left(v_def ->> 'name', 120), p_source, v_custom.id,
        'manual', 'scheduled', v_def, p_enabled_items, v_starts, v_ends, auth.uid())
      RETURNING id INTO v_id;
      v_res := public._playbook_apply_core(v_id, auth.uid(), 'user');
      RAISE EXCEPTION USING ERRCODE = 'PB001', MESSAGE = (v_res || '{"dry_run": true}'::jsonb)::text;
    EXCEPTION
      WHEN SQLSTATE 'PB001' THEN RETURN SQLERRM::jsonb;
      WHEN unique_violation THEN RETURN jsonb_build_object('status', 'already_live', 'dry_run', true);
    END;
  END IF;

  BEGIN
    INSERT INTO public.playbook_activations (user_id, request_id, playbook_key, playbook_version, playbook_name, source, custom_id,
      trigger_source, status, definition, enabled_item_ids, starts_at, ends_at, created_by)
    VALUES (v_owner, p_request_id, p_playbook_key, COALESCE(p_playbook_version, 1), left(v_def ->> 'name', 120), p_source, v_custom.id,
      CASE WHEN p_mode = 'schedule' THEN 'scheduled' ELSE 'manual' END,
      CASE WHEN p_mode = 'now' THEN 'scheduled' ELSE v_status END, v_def, p_enabled_items, v_starts, v_ends, auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already_live', 'error', 'This playbook is already suggested, scheduled or active.');
  END;
  PERFORM public._playbook_audit(v_owner, v_id, p_playbook_key, CASE WHEN p_mode = 'schedule' THEN 'scheduled' ELSE 'created' END,
    auth.uid(), 'user', jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends, 'enabled_items', p_enabled_items));

  IF p_mode = 'now' THEN
    v_res := public._playbook_apply_core(v_id, auth.uid(), 'user');
    IF v_res ->> 'status' IN ('conflict', 'invalid', 'no_profile', 'expired') THEN
      -- Do not leave a dangling "scheduled" row that blocks a retry.
      UPDATE public.playbook_activations SET status = 'dismissed', rollback_reason = 'apply_' || (v_res ->> 'status'), updated_at = now() WHERE id = v_id;
    END IF;
    RETURN v_res || jsonb_build_object('activation_id', v_id);
  END IF;
  RETURN jsonb_build_object('status', v_status, 'activation_id', v_id, 'starts_at', v_starts, 'ends_at', v_ends);
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_confirm(p_activation_id uuid, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._playbook_require_manager();
  v_act public.playbook_activations;
  v_res jsonb;
  v_len interval;
BEGIN
  SELECT * INTO v_act FROM public.playbook_activations WHERE id = p_activation_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_act.status = 'active' THEN RETURN jsonb_build_object('status', 'active', 'idempotent', true, 'activation_id', v_act.id); END IF;
  IF v_act.status NOT IN ('suggested', 'scheduled', 'pending_approval') THEN
    RETURN jsonb_build_object('status', 'invalid_status', 'current', v_act.status);
  END IF;

  IF p_dry_run THEN
    BEGIN
      IF v_act.status = 'suggested' THEN
        v_len := v_act.ends_at - v_act.starts_at;
        UPDATE public.playbook_activations SET starts_at = now(), ends_at = now() + v_len WHERE id = v_act.id;
      END IF;
      v_res := public._playbook_apply_core(v_act.id, auth.uid(), 'user');
      RAISE EXCEPTION USING ERRCODE = 'PB001', MESSAGE = (v_res || '{"dry_run": true}'::jsonb)::text;
    EXCEPTION WHEN SQLSTATE 'PB001' THEN
      RETURN SQLERRM::jsonb;
    END;
  END IF;

  IF v_act.status = 'suggested' THEN
    v_len := v_act.ends_at - v_act.starts_at;
    UPDATE public.playbook_activations SET starts_at = now(), ends_at = now() + v_len, updated_at = now() WHERE id = v_act.id;
  ELSIF v_act.starts_at > now() + interval '1 minute' THEN
    -- Confirmed for a future start: hand over to the scheduler.
    IF v_act.status = 'pending_approval' AND NOT public.playbook_is_owner() THEN
      RETURN jsonb_build_object('status', 'owner_required');
    END IF;
    UPDATE public.playbook_activations SET status = 'scheduled', updated_at = now() WHERE id = v_act.id;
    PERFORM public._playbook_audit(v_owner, v_act.id, v_act.playbook_key, 'scheduled', auth.uid(), 'user', jsonb_build_object('starts_at', v_act.starts_at));
    RETURN jsonb_build_object('status', 'scheduled', 'activation_id', v_act.id, 'starts_at', v_act.starts_at);
  END IF;

  v_res := public._playbook_apply_core(v_act.id, auth.uid(), 'user');
  RETURN v_res || jsonb_build_object('activation_id', v_act.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_rollback(p_activation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public._playbook_require_manager();
BEGIN
  PERFORM 1 FROM public.playbook_activations WHERE id = p_activation_id AND user_id = v_owner;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  RETURN public._playbook_rollback_core(p_activation_id, auth.uid(), 'user', 'manual');
END;
$$;

-- Owner approval of a held item: price (after-hours fee) is applied; ad changes are only acknowledged (never executed).
CREATE OR REPLACE FUNCTION public.playbook_approve_item(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._playbook_require_manager();
  v_row public.playbook_activation_items;
  v_act public.playbook_activations;
  v_def jsonb;
  v_p jsonb;
  v_cur record;
  v_fee numeric;
  v_note text;
BEGIN
  IF NOT public.playbook_is_owner() THEN RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_row FROM public.playbook_activation_items WHERE id = p_item_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_row.status <> 'pending_approval' THEN RETURN jsonb_build_object('status', v_row.status, 'idempotent', true); END IF;
  SELECT * INTO v_act FROM public.playbook_activations WHERE id = v_row.activation_id FOR UPDATE;
  IF v_act.status <> 'active' THEN RETURN jsonb_build_object('status', 'invalid_status', 'current', v_act.status); END IF;
  SELECT i INTO v_def FROM jsonb_array_elements(v_act.definition -> 'items') i WHERE i ->> 'id' = v_row.item_id;
  v_p := COALESCE(v_def -> 'params', '{}'::jsonb);

  IF v_row.kind = 'after_hours_fee' THEN
    SELECT after_hours_fee, after_hours_fee_note INTO v_cur FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
    v_fee := (v_p ->> 'amountCents')::numeric / 100.0;
    v_note := left(NULLIF(v_p ->> 'note', ''), 500);
    UPDATE public.business_profile SET after_hours_fee = v_fee, after_hours_fee_note = COALESCE(v_note, after_hours_fee_note) WHERE user_id = v_owner;
    UPDATE public.playbook_activation_items
      SET status = 'applied', approved_by = auth.uid(), approved_at = now(),
          before = jsonb_build_object('fee', v_cur.after_hours_fee, 'note', v_cur.after_hours_fee_note),
          after = jsonb_build_object('fee', v_fee, 'note', COALESCE(v_note, v_cur.after_hours_fee_note))
      WHERE id = v_row.id;
  ELSE
    UPDATE public.playbook_activation_items
      SET status = 'advisory', approved_by = auth.uid(), approved_at = now(), note = 'Approved. Apply this change yourself in your ads account.'
      WHERE id = v_row.id;
    DELETE FROM public.playbook_surface_locks WHERE activation_id = v_row.activation_id AND item_id = v_row.item_id;
  END IF;
  PERFORM public._playbook_audit(v_owner, v_act.id, v_act.playbook_key, 'item_approved', auth.uid(), 'user', jsonb_build_object('item_id', v_row.item_id));
  RETURN jsonb_build_object('status', CASE WHEN v_row.kind = 'after_hours_fee' THEN 'applied' ELSE 'advisory' END);
END;
$$;

-- Everything the preview needs, in one scoped read (no cross-tenant data, no secrets).
CREATE OR REPLACE FUNCTION public.playbook_current_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._playbook_require_manager();
  v_bp record;
  v_bk record;
  v_dm record;
  v_phone text;
BEGIN
  SELECT surge_mode_active, surge_mode_source, surge_mode_message, surge_mode_priority, surge_max_bookings_per_day,
         escalation_rules, holidays, after_hours_fee, timezone, primary_industry, emergency_ops_enabled
    INTO v_bp FROM public.business_profile WHERE user_id = v_owner;
  SELECT phone INTO v_phone FROM public.profiles WHERE id = v_owner;
  SELECT enabled, max_slots_per_day, overbook_jobs_per_tech INTO v_bk FROM public.booking_capacity_policies WHERE user_id = v_owner;
  SELECT emergency_reserve_slots, waitlist_enabled INTO v_dm FROM public.capacity_demand_policies WHERE user_id = v_owner;
  RETURN jsonb_build_object(
    'trade', v_bp.primary_industry,
    'surge', jsonb_build_object('active', COALESCE(v_bp.surge_mode_active, false), 'source', v_bp.surge_mode_source,
      'message', v_bp.surge_mode_message, 'priority', v_bp.surge_mode_priority, 'maxBookingsPerDay', v_bp.surge_max_bookings_per_day),
    'escalationRules', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r ->> 'id', 'trigger', r ->> 'trigger', 'action', r ->> 'action', 'target', r ->> 'target'))
                                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_bp.escalation_rules) = 'array' THEN v_bp.escalation_rules ELSE '[]'::jsonb END) r), '[]'::jsonb),
    'holidays', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', h ->> 'id', 'date', h ->> 'date'))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_bp.holidays) = 'array' THEN v_bp.holidays ELSE '[]'::jsonb END) h), '[]'::jsonb),
    'afterHoursFeeCents', CASE WHEN v_bp.after_hours_fee IS NULL THEN NULL ELSE round(v_bp.after_hours_fee * 100)::integer END,
    'ownerPhone', NULLIF(btrim(COALESCE(v_phone, '')), ''),
    'timezone', v_bp.timezone,
    'bookingPolicy', CASE WHEN v_bk IS NULL THEN NULL ELSE jsonb_build_object('enabled', v_bk.enabled, 'maxSlotsPerDay', v_bk.max_slots_per_day, 'overbookJobsPerTech', v_bk.overbook_jobs_per_tech) END,
    'demandPolicy', CASE WHEN v_dm IS NULL THEN NULL ELSE jsonb_build_object('emergencyReserveSlots', v_dm.emergency_reserve_slots, 'waitlistEnabled', v_dm.waitlist_enabled) END,
    'templateNames', COALESCE((SELECT jsonb_agg(lower(btrim(name))) FROM public.message_templates WHERE user_id = v_owner AND status <> 'archived'), '[]'::jsonb),
    'automations', COALESCE((SELECT jsonb_object_agg(template_slug, status) FROM public.automation_installs WHERE user_id = v_owner), '{}'::jsonb),
    'scriptActive', COALESCE((SELECT jsonb_object_agg(scenario, active_version_id IS NOT NULL) FROM public.call_scripts WHERE user_id = v_owner), '{}'::jsonb),
    'emergencyOpsEnabled', COALESCE(v_bp.emergency_ops_enabled, false),
    'liveSurfaces', COALESCE((SELECT jsonb_object_agg(l.surface, jsonb_build_object('activationId', l.activation_id, 'playbookKey', a.playbook_key, 'playbookName', a.playbook_name))
                              FROM public.playbook_surface_locks l JOIN public.playbook_activations a ON a.id = l.activation_id
                              WHERE l.user_id = v_owner), '{}'::jsonb)
  );
END;
$$;

-- Minimal, non-sensitive payload for the app-wide banner (any account member).
CREATE OR REPLACE FUNCTION public.playbook_banner()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_a record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RETURN NULL; END IF;
  SELECT id, playbook_key, playbook_name, ends_at, applied_at INTO v_a
    FROM public.playbook_activations WHERE user_id = v_owner AND status = 'active' ORDER BY applied_at DESC NULLS LAST LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', v_a.id, 'playbookKey', v_a.playbook_key, 'name', v_a.playbook_name, 'endsAt', v_a.ends_at,
    'activeCount', (SELECT count(*) FROM public.playbook_activations WHERE user_id = v_owner AND status = 'active'),
    'canManage', public.can_manage_playbooks());
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_update_settings(p_suggestions_enabled boolean, p_auto_apply_keys text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public._playbook_require_manager(); v_k text;
BEGIN
  IF NOT public.playbook_is_owner() THEN RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501'; END IF;
  FOREACH v_k IN ARRAY COALESCE(p_auto_apply_keys, '{}') LOOP
    IF v_k !~ '^[a-z0-9][a-z0-9-]{1,59}$' THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'Invalid playbook key.'); END IF;
  END LOOP;
  INSERT INTO public.playbook_settings (user_id, suggestions_enabled, auto_apply_keys)
  VALUES (v_owner, COALESCE(p_suggestions_enabled, true), COALESCE(p_auto_apply_keys, '{}'))
  ON CONFLICT (user_id) DO UPDATE SET suggestions_enabled = EXCLUDED.suggestions_enabled, auto_apply_keys = EXCLUDED.auto_apply_keys, updated_at = now();
  PERFORM public._playbook_audit(v_owner, NULL, NULL, 'settings_changed', auth.uid(), 'user',
    jsonb_build_object('suggestions_enabled', p_suggestions_enabled, 'auto_apply_keys', p_auto_apply_keys));
  RETURN jsonb_build_object('status', 'ok');
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_custom_save(p_key text, p_definition jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public._playbook_require_manager(); v_err text; v_row public.playbook_custom;
BEGIN
  IF p_key IS NULL OR p_key !~ '^custom-[a-z0-9-]{2,50}$' THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'Key must look like custom-my-playbook.'); END IF;
  v_err := public.playbook_validate_definition(p_definition);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('status', 'invalid', 'error', v_err); END IF;
  INSERT INTO public.playbook_custom (user_id, key, name, definition, created_by)
  VALUES (v_owner, p_key, left(p_definition ->> 'name', 120), p_definition, auth.uid())
  ON CONFLICT (user_id, key) DO UPDATE
    SET name = EXCLUDED.name, definition = EXCLUDED.definition, version = public.playbook_custom.version + 1, updated_at = now()
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('status', 'ok', 'id', v_row.id, 'version', v_row.version);
END;
$$;

-- HQ-only: share to / unshare from the franchise group the account owns.
CREATE OR REPLACE FUNCTION public.playbook_custom_share(p_id uuid, p_share boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public._playbook_require_manager(); v_group uuid;
BEGIN
  IF NOT public.playbook_is_owner() THEN RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_group FROM public.franchise_groups WHERE owner_id = v_owner;
  IF p_share AND v_group IS NULL THEN RETURN jsonb_build_object('status', 'no_group', 'error', 'Only a franchise HQ account can share playbooks.'); END IF;
  UPDATE public.playbook_custom SET shared_group_id = CASE WHEN p_share THEN v_group ELSE NULL END, updated_at = now()
    WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM public._playbook_audit(v_owner, NULL, NULL, CASE WHEN p_share THEN 'custom_shared' ELSE 'custom_unshared' END, auth.uid(), 'user', jsonb_build_object('custom_id', p_id));
  RETURN jsonb_build_object('status', 'ok');
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_custom_delete(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public._playbook_require_manager();
BEGIN
  DELETE FROM public.playbook_custom WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  RETURN jsonb_build_object('status', 'ok');
END;
$$;

-- =============================================================
-- 7. System RPCs (scheduler / signal checker; service_role only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.playbook_system_apply(p_activation_id uuid, p_allow_suggested boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_act public.playbook_activations; v_len interval;
BEGIN
  SELECT * INTO v_act FROM public.playbook_activations WHERE id = p_activation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_act.status = 'active' THEN RETURN jsonb_build_object('status', 'active', 'idempotent', true); END IF;
  IF v_act.status = 'suggested' AND p_allow_suggested THEN
    v_len := v_act.ends_at - v_act.starts_at;
    UPDATE public.playbook_activations SET starts_at = now(), ends_at = now() + v_len, trigger_source = 'signal' WHERE id = v_act.id;
  ELSIF v_act.status <> 'scheduled' OR v_act.starts_at > now() THEN
    RETURN jsonb_build_object('status', 'not_due', 'current', v_act.status);
  END IF;
  RETURN public._playbook_apply_core(p_activation_id, NULL, 'system');
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_system_rollback(p_activation_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_act public.playbook_activations;
BEGIN
  IF p_reason NOT IN ('expired', 'stale') THEN RETURN jsonb_build_object('status', 'invalid', 'error', 'Unknown reason.'); END IF;
  SELECT * INTO v_act FROM public.playbook_activations WHERE id = p_activation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  -- Never end something that is still inside its window, or expire a still-fresh suggestion/schedule.
  IF v_act.status = 'active' AND (p_reason <> 'expired' OR v_act.ends_at > now()) THEN RETURN jsonb_build_object('status', 'not_due'); END IF;
  IF v_act.status = 'suggested' AND (p_reason <> 'stale' OR COALESCE(v_act.suggest_expires_at, v_act.ends_at) > now()) THEN RETURN jsonb_build_object('status', 'not_due'); END IF;
  IF v_act.status = 'scheduled' AND (p_reason <> 'expired' OR v_act.ends_at > now()) THEN RETURN jsonb_build_object('status', 'not_due'); END IF;
  RETURN public._playbook_rollback_core(p_activation_id, NULL, 'system', p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_system_suggest(
  p_user_id uuid, p_key text, p_version integer, p_definition jsonb, p_enabled_items text[],
  p_signal jsonb, p_suggest_ttl_hours integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid; v_dur integer; v_ids text[];
BEGIN
  IF public.playbook_validate_definition(p_definition) IS NOT NULL THEN RETURN NULL; END IF;
  v_ids := ARRAY(SELECT i ->> 'id' FROM jsonb_array_elements(p_definition -> 'items') i);
  IF p_enabled_items IS NULL OR cardinality(p_enabled_items) = 0 OR NOT (p_enabled_items <@ v_ids) THEN RETURN NULL; END IF;
  v_dur := LEAST(1440, GREATEST(1, COALESCE((p_definition ->> 'defaultDurationHours')::integer, 72)));
  INSERT INTO public.playbook_activations (user_id, request_id, playbook_key, playbook_version, playbook_name, source, trigger_source,
    signal, status, definition, enabled_item_ids, starts_at, ends_at, suggest_expires_at)
  VALUES (p_user_id, gen_random_uuid(), p_key, COALESCE(p_version, 1), left(p_definition ->> 'name', 120), 'library', 'signal',
    COALESCE(p_signal, '{}'::jsonb), 'suggested', p_definition, p_enabled_items, now(), now() + make_interval(hours => v_dur),
    now() + make_interval(hours => LEAST(168, GREATEST(1, COALESCE(p_suggest_ttl_hours, 48)))))
  RETURNING id INTO v_id;
  PERFORM public._playbook_audit(p_user_id, v_id, p_key, 'suggested', NULL, 'system', COALESCE(p_signal, '{}'::jsonb));
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;  -- already suggested/scheduled/active
END;
$$;

CREATE OR REPLACE FUNCTION public.playbook_signal_snapshot(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'weather', COALESCE((SELECT jsonb_agg(jsonb_build_object('eventType', event_type, 'headline', headline, 'expiresAt', expires_at))
                         FROM public.weather_surge_events
                         WHERE user_id = p_user_id AND created_at > now() - interval '3 days' AND (expires_at IS NULL OR expires_at > now())), '[]'::jsonb),
    'calls24h', (SELECT count(*) FROM public.calls WHERE user_id = p_user_id AND call_datetime >= now() - interval '24 hours'),
    'callsTrailing', (SELECT count(*) FROM public.calls WHERE user_id = p_user_id AND call_datetime >= now() - interval '8 days' AND call_datetime < now() - interval '24 hours'),
    'liveKeys', COALESCE((SELECT jsonb_agg(playbook_key) FROM public.playbook_activations
                          WHERE user_id = p_user_id AND status IN ('suggested', 'scheduled', 'pending_approval', 'active')), '[]'::jsonb),
    'dismissedKeys', COALESCE((SELECT jsonb_agg(DISTINCT playbook_key) FROM public.playbook_activations
                               WHERE user_id = p_user_id AND status = 'dismissed' AND updated_at > now() - interval '3 days'), '[]'::jsonb),
    'autoApplyKeys', COALESCE((SELECT to_jsonb(auto_apply_keys) FROM public.playbook_settings WHERE user_id = p_user_id), '[]'::jsonb),
    'suggestionsEnabled', COALESCE((SELECT suggestions_enabled FROM public.playbook_settings WHERE user_id = p_user_id), true)
  );
$$;

-- =============================================================
-- 8. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public._playbook_apply_item(public.playbook_activations, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._playbook_rollback_item(public.playbook_activations, public.playbook_activation_items) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._playbook_apply_core(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._playbook_rollback_core(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._playbook_audit(uuid, uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._playbook_require_manager() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.playbook_create_activation(uuid, text, integer, text, uuid, jsonb, text[], timestamptz, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_confirm(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_rollback(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_approve_item(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_current_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_banner() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_update_settings(boolean, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_custom_save(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_custom_share(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_custom_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_playbooks() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.playbook_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playbook_create_activation(uuid, text, integer, text, uuid, jsonb, text[], timestamptz, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_confirm(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_rollback(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_approve_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_current_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_banner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_update_settings(boolean, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_custom_save(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_custom_share(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_custom_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_playbooks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_is_owner() TO authenticated;

REVOKE ALL ON FUNCTION public.playbook_system_apply(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.playbook_system_rollback(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.playbook_system_suggest(uuid, text, integer, jsonb, text[], jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.playbook_signal_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.playbook_system_apply(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.playbook_system_rollback(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.playbook_system_suggest(uuid, text, integer, jsonb, text[], jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.playbook_signal_snapshot(uuid) TO service_role;
