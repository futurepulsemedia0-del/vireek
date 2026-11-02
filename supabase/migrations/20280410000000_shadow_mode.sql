/*
  # Shadow Mode — 7-day risk-free trial where Sarah observes and never acts

  ## What this adds
  - shadow_trials   one trial per account (7 days), consent attestation, retention, setup checklist
  - shadow_cards    one "Shadow Card" per observed call: REDACTED transcript, would-be actions, diff vs actual
  - shadow_reviews  owner Approve/Correct decisions + reviewable correction proposals (no silent training)
  - shadow_reports  Day-7 Proof-of-Value payload (aggregates, estimate range, readiness)
  - shadow_events   append-only audit trail (attestation, report, go-live, deletion)

  ## Safety properties enforced IN THE DATABASE
  - shadow_cards.actions may never contain {"executed": true}  (CHECK) -> a shadow card cannot record a side effect.
  - Shadow tables are separate from calls / ROI ledgers: nothing here writes to them, so shadow numbers
    cannot reach ROI dashboards.
  - Authenticated users have SELECT only. Every write goes through a SECURITY DEFINER RPC that re-checks
    tenant (get_account_owner_id) and permission (can_edit_call_scripts), or through the service role
    (edge functions). Users therefore cannot extend the trial, edit cards, mark digests sent, or self-clear
    legal gates (counsel_cleared_states, telephony_supports_fork are platform-set only).
  - Composite FKs (id, user_id) keep child rows in the same tenant as their parent.

  ## Decisions
  - One trial per account, ever (unique user_id) — prevents repeated free trials.
  - mode is 'replay' only. Live-listen is NOT implemented: no one-way audio fork exists in the current
    telephony code (verified by inspection of _shared/pbx/twilio.ts, pbx-voice, _shared/pbx/runtime.ts).
  - Phone numbers are never stored on cards — only the last 4 digits.

  Requires: public.get_account_owner_id(), public.can_edit_call_scripts(), public.set_updated_at(),
  public.profiles, public.business_profile (faqs jsonb).

  Rollback (manual): see docs/SHADOW_MODE.md -> "Rollback". It is kept out of this file on purpose so the
  migration linter's destructive-SQL check has nothing to flag.
*/

-- =============================================================
-- 1. shadow_trials
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled', 'went_live')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  mode text NOT NULL DEFAULT 'replay' CHECK (mode = 'replay'),
  replay_attested boolean NOT NULL DEFAULT false,
  replay_attested_at timestamptz,
  replay_attested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  caller_disclosure_configured boolean NOT NULL DEFAULT false,
  staff_notified boolean NOT NULL DEFAULT false,
  -- platform-set only (no RPC writes these): legal / telephony facts the owner cannot self-declare
  telephony_supports_fork boolean NOT NULL DEFAULT false,
  counsel_cleared_states text[] NOT NULL DEFAULT '{}',
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 90),
  avg_ticket_cents_override integer CHECK (avg_ticket_cents_override IS NULL OR avg_ticket_cents_override BETWEEN 1 AND 100000000),
  close_rate_override numeric(4, 3) CHECK (close_rate_override IS NULL OR (close_rate_override > 0 AND close_rate_override <= 0.5)),
  setup_items jsonb NOT NULL DEFAULT '{"forwarding": false, "hours": false, "emergency_rules": false, "test_call": false}'::jsonb,
  digests_sent integer[] NOT NULL DEFAULT '{}',
  last_replay_at timestamptz,
  went_live_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_trials_window CHECK (ends_at > started_at),
  CONSTRAINT shadow_trials_id_user UNIQUE (id, user_id)
);

-- one trial per account, ever
CREATE UNIQUE INDEX IF NOT EXISTS shadow_trials_one_per_account ON public.shadow_trials (user_id);

DROP TRIGGER IF EXISTS shadow_trials_set_updated_at ON public.shadow_trials;
CREATE TRIGGER shadow_trials_set_updated_at
  BEFORE UPDATE ON public.shadow_trials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- 2. shadow_cards
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  trial_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('pbx_call', 'voicemail', 'call_row')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL,
  pipeline_version text NOT NULL CHECK (char_length(pipeline_version) BETWEEN 1 AND 40),
  call_started_at timestamptz NOT NULL,
  caller_last4 text CHECK (caller_last4 IS NULL OR caller_last4 ~ '^[0-9]{1,4}$'),
  status text NOT NULL
    CHECK (status IN ('ready', 'no_transcript', 'analysis_failed', 'blocked_consent')),
  block_reason text CHECK (block_reason IS NULL OR char_length(block_reason) <= 64),
  intent text CHECK (intent IS NULL OR char_length(intent) <= 40),
  emergency boolean NOT NULL DEFAULT false,
  would_book boolean NOT NULL DEFAULT false,
  capturable boolean NOT NULL DEFAULT false,
  transcript_redacted text CHECK (transcript_redacted IS NULL OR char_length(transcript_redacted) <= 20000),
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  purge_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_cards_idempotency UNIQUE (idempotency_key),
  CONSTRAINT shadow_cards_id_user UNIQUE (id, user_id),
  CONSTRAINT shadow_cards_trial_fk FOREIGN KEY (trial_id, user_id)
    REFERENCES public.shadow_trials (id, user_id) ON DELETE CASCADE,
  -- a shadow card can never record an executed side effect
  CONSTRAINT shadow_cards_actions_never_executed CHECK (
    jsonb_typeof(actions) = 'array' AND NOT (actions @> '[{"executed": true}]'::jsonb)
  )
);

CREATE INDEX IF NOT EXISTS idx_shadow_cards_trial_recent ON public.shadow_cards (trial_id, call_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_cards_purge ON public.shadow_cards (purge_after);

-- =============================================================
-- 3. shadow_reviews (Approve / Correct + reviewable proposals)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  trial_id uuid NOT NULL,
  card_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('good', 'bad')),
  severity text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'critical')),
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('greeting', 'triage', 'emergency', 'booking', 'pricing', 'tone', 'other')),
  corrected_text text CHECK (corrected_text IS NULL OR char_length(corrected_text) <= 2000),
  proposal_target text NOT NULL DEFAULT 'none' CHECK (proposal_target IN ('none', 'faq', 'script')),
  proposal_question text CHECK (proposal_question IS NULL OR char_length(proposal_question) <= 300),
  proposal_status text NOT NULL DEFAULT 'none'
    CHECK (proposal_status IN ('none', 'pending', 'accepted', 'rejected', 'applied')),
  mistake_resolved boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_reviews_one_per_card UNIQUE (card_id),
  CONSTRAINT shadow_reviews_card_fk FOREIGN KEY (card_id, user_id)
    REFERENCES public.shadow_cards (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shadow_reviews_trial_fk FOREIGN KEY (trial_id, user_id)
    REFERENCES public.shadow_trials (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shadow_reviews_proposal_shape CHECK ((proposal_target = 'none') = (proposal_status = 'none')),
  CONSTRAINT shadow_reviews_proposal_needs_text CHECK (
    proposal_target = 'none'
    OR (corrected_text IS NOT NULL AND char_length(btrim(corrected_text)) > 0)
  ),
  CONSTRAINT shadow_reviews_faq_needs_question CHECK (
    proposal_target <> 'faq'
    OR (proposal_question IS NOT NULL AND char_length(btrim(proposal_question)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_shadow_reviews_trial ON public.shadow_reviews (trial_id, verdict);
CREATE INDEX IF NOT EXISTS idx_shadow_reviews_pending ON public.shadow_reviews (trial_id) WHERE proposal_status = 'pending';

DROP TRIGGER IF EXISTS shadow_reviews_set_updated_at ON public.shadow_reviews;
CREATE TRIGGER shadow_reviews_set_updated_at
  BEFORE UPDATE ON public.shadow_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- 4. shadow_reports (Day-7 Proof of Value)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  trial_id uuid NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  readiness_score integer CHECK (readiness_score IS NULL OR readiness_score BETWEEN 0 AND 100),
  readiness_band text CHECK (readiness_band IS NULL OR readiness_band IN ('not_ready', 'almost', 'ready')),
  purge_after timestamptz NOT NULL,
  CONSTRAINT shadow_reports_one_per_trial UNIQUE (trial_id),
  CONSTRAINT shadow_reports_trial_fk FOREIGN KEY (trial_id, user_id)
    REFERENCES public.shadow_trials (id, user_id) ON DELETE CASCADE
);

-- =============================================================
-- 5. shadow_events (append-only audit)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.shadow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  trial_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'trial_started', 'attestation_changed', 'settings_changed', 'setup_item_changed', 'replay_run',
    'digest_sent', 'report_generated', 'proposal_decided', 'faq_applied', 'data_deleted', 'went_live', 'purge'
  )),
  actor uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shadow_events_trial_fk FOREIGN KEY (trial_id, user_id)
    REFERENCES public.shadow_trials (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shadow_events_trial ON public.shadow_events (trial_id, created_at DESC);

-- =============================================================
-- 6. RLS + grants: members read, nobody writes directly
-- =============================================================
ALTER TABLE public.shadow_trials  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_cards   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_events  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shadow_trials_select ON public.shadow_trials;
CREATE POLICY shadow_trials_select ON public.shadow_trials
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS shadow_cards_select ON public.shadow_cards;
CREATE POLICY shadow_cards_select ON public.shadow_cards
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS shadow_reviews_select ON public.shadow_reviews;
CREATE POLICY shadow_reviews_select ON public.shadow_reviews
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS shadow_reports_select ON public.shadow_reports;
CREATE POLICY shadow_reports_select ON public.shadow_reports
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS shadow_events_select ON public.shadow_events;
CREATE POLICY shadow_events_select ON public.shadow_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE ALL ON public.shadow_trials, public.shadow_cards, public.shadow_reviews, public.shadow_reports, public.shadow_events
  FROM anon, authenticated;
GRANT SELECT ON public.shadow_trials, public.shadow_cards, public.shadow_reviews, public.shadow_reports, public.shadow_events
  TO authenticated;

-- =============================================================
-- 7. RPCs (SECURITY DEFINER, each re-checks tenant + permission)
-- =============================================================

-- Guard used by every write RPC. Returns the caller's account owner id or raises.
CREATE OR REPLACE FUNCTION public.shadow_assert_editor()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.can_edit_call_scripts() IS NOT TRUE THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public.shadow_assert_editor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shadow_assert_editor() TO authenticated;

-- Start the (single) 7-day trial.
CREATE OR REPLACE FUNCTION public.shadow_start_trial(p_timezone text DEFAULT 'UTC')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
  v_tz text := COALESCE(NULLIF(btrim(p_timezone), ''), 'UTC');
  v_id uuid;
BEGIN
  IF char_length(v_tz) > 64 OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'UTC';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shadow_trials WHERE user_id = v_owner) THEN
    RAISE EXCEPTION 'a Shadow Mode trial already exists for this account' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.shadow_trials (user_id, timezone) VALUES (v_owner, v_tz) RETURNING id INTO v_id;
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor) VALUES (v_owner, v_id, 'trial_started', auth.uid());
  RETURN v_id;
END;
$$;

-- Update owner-controlled settings. NULL = leave unchanged (except the overrides, which use -1 / -1 to clear).
CREATE OR REPLACE FUNCTION public.shadow_update_settings(
  p_trial_id uuid,
  p_timezone text DEFAULT NULL,
  p_replay_attested boolean DEFAULT NULL,
  p_caller_disclosure boolean DEFAULT NULL,
  p_staff_notified boolean DEFAULT NULL,
  p_retention_days integer DEFAULT NULL,
  p_avg_ticket_cents integer DEFAULT NULL,
  p_close_rate numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
  t public.shadow_trials%ROWTYPE;
  v_tz text;
BEGIN
  SELECT * INTO t FROM public.shadow_trials WHERE id = p_trial_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trial not found' USING ERRCODE = 'P0002'; END IF;
  IF t.status <> 'active' THEN RAISE EXCEPTION 'trial is not active' USING ERRCODE = '55000'; END IF;

  v_tz := t.timezone;
  IF p_timezone IS NOT NULL THEN
    IF char_length(btrim(p_timezone)) BETWEEN 1 AND 64
       AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = btrim(p_timezone)) THEN
      v_tz := btrim(p_timezone);
    ELSE
      RAISE EXCEPTION 'invalid time zone' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_retention_days IS NOT NULL AND p_retention_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'retention must be 1-90 days' USING ERRCODE = '22023';
  END IF;
  IF p_avg_ticket_cents IS NOT NULL AND p_avg_ticket_cents <> -1 AND p_avg_ticket_cents NOT BETWEEN 1 AND 100000000 THEN
    RAISE EXCEPTION 'invalid average ticket' USING ERRCODE = '22023';
  END IF;
  IF p_close_rate IS NOT NULL AND p_close_rate <> -1 AND (p_close_rate <= 0 OR p_close_rate > 0.5) THEN
    RAISE EXCEPTION 'close rate must be between 0 and 0.5' USING ERRCODE = '22023';
  END IF;

  UPDATE public.shadow_trials SET
    timezone = v_tz,
    replay_attested = COALESCE(p_replay_attested, replay_attested),
    replay_attested_at = CASE
      WHEN p_replay_attested IS TRUE AND NOT replay_attested THEN now()
      WHEN p_replay_attested IS FALSE THEN NULL
      ELSE replay_attested_at END,
    replay_attested_by = CASE
      WHEN p_replay_attested IS TRUE AND NOT replay_attested THEN auth.uid()
      WHEN p_replay_attested IS FALSE THEN NULL
      ELSE replay_attested_by END,
    caller_disclosure_configured = COALESCE(p_caller_disclosure, caller_disclosure_configured),
    staff_notified = COALESCE(p_staff_notified, staff_notified),
    retention_days = COALESCE(p_retention_days, retention_days),
    avg_ticket_cents_override = CASE
      WHEN p_avg_ticket_cents IS NULL THEN avg_ticket_cents_override
      WHEN p_avg_ticket_cents = -1 THEN NULL
      ELSE p_avg_ticket_cents END,
    close_rate_override = CASE
      WHEN p_close_rate IS NULL THEN close_rate_override
      WHEN p_close_rate = -1 THEN NULL
      ELSE p_close_rate END
  WHERE id = p_trial_id AND user_id = v_owner;

  IF p_replay_attested IS NOT NULL OR p_caller_disclosure IS NOT NULL OR p_staff_notified IS NOT NULL THEN
    INSERT INTO public.shadow_events (user_id, trial_id, kind, actor, detail)
    VALUES (v_owner, p_trial_id, 'attestation_changed', auth.uid(),
      jsonb_build_object('replay_attested', p_replay_attested, 'caller_disclosure', p_caller_disclosure, 'staff_notified', p_staff_notified));
  END IF;
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor, detail)
  VALUES (v_owner, p_trial_id, 'settings_changed', auth.uid(),
    jsonb_build_object('timezone', p_timezone, 'retention_days', p_retention_days));
END;
$$;

CREATE OR REPLACE FUNCTION public.shadow_set_setup_item(p_trial_id uuid, p_key text, p_done boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
BEGIN
  IF p_key NOT IN ('forwarding', 'hours', 'emergency_rules', 'test_call') THEN
    RAISE EXCEPTION 'unknown setup item' USING ERRCODE = '22023';
  END IF;
  UPDATE public.shadow_trials
     SET setup_items = jsonb_set(setup_items, ARRAY[p_key], to_jsonb(COALESCE(p_done, false)), true)
   WHERE id = p_trial_id AND user_id = v_owner AND status IN ('active', 'completed');
  IF NOT FOUND THEN RAISE EXCEPTION 'trial not found or closed' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor, detail)
  VALUES (v_owner, p_trial_id, 'setup_item_changed', auth.uid(), jsonb_build_object('item', p_key, 'done', COALESCE(p_done, false)));
END;
$$;

-- Approve / Correct a card. A correction with text may create a PENDING proposal (never applied silently).
CREATE OR REPLACE FUNCTION public.shadow_submit_review(
  p_card_id uuid,
  p_verdict text,
  p_severity text DEFAULT 'minor',
  p_category text DEFAULT 'other',
  p_corrected_text text DEFAULT NULL,
  p_proposal_target text DEFAULT 'none',
  p_proposal_question text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
  c public.shadow_cards%ROWTYPE;
  t public.shadow_trials%ROWTYPE;
  v_text text := NULLIF(btrim(COALESCE(p_corrected_text, '')), '');
  v_q text := NULLIF(btrim(COALESCE(p_proposal_question, '')), '');
  v_target text := COALESCE(p_proposal_target, 'none');
  v_id uuid;
BEGIN
  SELECT * INTO c FROM public.shadow_cards WHERE id = p_card_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'card not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO t FROM public.shadow_trials WHERE id = c.trial_id AND user_id = v_owner;
  IF t.status NOT IN ('active', 'completed') THEN RAISE EXCEPTION 'trial is closed' USING ERRCODE = '55000'; END IF;
  IF p_verdict NOT IN ('good', 'bad') THEN RAISE EXCEPTION 'invalid verdict' USING ERRCODE = '22023'; END IF;
  IF v_target NOT IN ('none', 'faq', 'script') THEN RAISE EXCEPTION 'invalid proposal target' USING ERRCODE = '22023'; END IF;
  IF p_verdict = 'good' THEN
    v_target := 'none'; v_text := NULL; v_q := NULL;
  END IF;
  IF v_target <> 'none' AND v_text IS NULL THEN
    RAISE EXCEPTION 'a correction proposal needs the corrected text' USING ERRCODE = '22023';
  END IF;
  IF v_target = 'faq' AND v_q IS NULL THEN
    RAISE EXCEPTION 'an FAQ proposal needs a question' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.shadow_reviews AS r
    (user_id, trial_id, card_id, verdict, severity, category, corrected_text,
     proposal_target, proposal_question, proposal_status, reviewed_by)
  VALUES
    (v_owner, c.trial_id, c.id, p_verdict, COALESCE(p_severity, 'minor'), COALESCE(p_category, 'other'), v_text,
     v_target, v_q, CASE WHEN v_target = 'none' THEN 'none' ELSE 'pending' END, auth.uid())
  ON CONFLICT (card_id) DO UPDATE SET
    verdict = EXCLUDED.verdict,
    severity = EXCLUDED.severity,
    category = EXCLUDED.category,
    -- an already accepted/applied proposal is frozen: a re-review never rewrites or resets it
    corrected_text = CASE WHEN r.proposal_status IN ('accepted', 'applied') THEN r.corrected_text ELSE EXCLUDED.corrected_text END,
    proposal_target = CASE WHEN r.proposal_status IN ('accepted', 'applied') THEN r.proposal_target ELSE EXCLUDED.proposal_target END,
    proposal_question = CASE WHEN r.proposal_status IN ('accepted', 'applied') THEN r.proposal_question ELSE EXCLUDED.proposal_question END,
    proposal_status = CASE
      WHEN r.proposal_status IN ('accepted', 'applied') THEN r.proposal_status
      WHEN EXCLUDED.proposal_target = 'none' THEN 'none'
      ELSE 'pending' END,
    reviewed_by = auth.uid()
  RETURNING r.id INTO v_id;
  RETURN v_id;
END;
$$;

-- Owner decision on a correction proposal. Accepting does NOT change any script or FAQ by itself.
CREATE OR REPLACE FUNCTION public.shadow_decide_proposal(p_review_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
BEGIN
  UPDATE public.shadow_reviews
     SET proposal_status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END,
         mistake_resolved = CASE WHEN p_accept THEN true ELSE mistake_resolved END,
         decided_by = auth.uid(),
         decided_at = now()
   WHERE id = p_review_id AND user_id = v_owner AND proposal_status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'no pending proposal found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor, detail)
  SELECT user_id, trial_id, 'proposal_decided', auth.uid(), jsonb_build_object('review_id', id, 'accepted', p_accept)
    FROM public.shadow_reviews WHERE id = p_review_id;
END;
$$;

-- Apply an ACCEPTED faq proposal to business_profile.faqs (append-only, capped, idempotent).
CREATE OR REPLACE FUNCTION public.shadow_apply_faq(p_review_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
  r public.shadow_reviews%ROWTYPE;
  v_faqs jsonb;
BEGIN
  SELECT * INTO r FROM public.shadow_reviews
   WHERE id = p_review_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'review not found' USING ERRCODE = 'P0002'; END IF;
  IF r.proposal_target <> 'faq' OR r.proposal_status <> 'accepted' THEN
    RAISE EXCEPTION 'only an accepted FAQ proposal can be applied' USING ERRCODE = '55000';
  END IF;

  SELECT faqs INTO v_faqs FROM public.business_profile WHERE user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'business profile not found' USING ERRCODE = 'P0002'; END IF;
  IF v_faqs IS NULL THEN v_faqs := '[]'::jsonb; END IF;
  IF jsonb_typeof(v_faqs) <> 'array' THEN
    RAISE EXCEPTION 'business_profile.faqs is not an array; refusing to overwrite' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v_faqs) >= 100 THEN
    RAISE EXCEPTION 'FAQ list is full (100)' USING ERRCODE = '54000';
  END IF;

  UPDATE public.business_profile
     SET faqs = v_faqs || jsonb_build_array(jsonb_build_object('question', r.proposal_question, 'answer', r.corrected_text))
   WHERE user_id = v_owner;

  UPDATE public.shadow_reviews SET proposal_status = 'applied' WHERE id = r.id;
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor, detail)
  VALUES (v_owner, r.trial_id, 'faq_applied', auth.uid(), jsonb_build_object('review_id', r.id));
END;
$$;

-- Live counter / report inputs. SECURITY INVOKER: RLS applies.
CREATE OR REPLACE FUNCTION public.shadow_trial_stats(p_trial_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'calls_seen',        count(*),
    'analyzed',          count(*) FILTER (WHERE c.status = 'ready'),
    'blocked_consent',   count(*) FILTER (WHERE c.status = 'blocked_consent'),
    'no_transcript',     count(*) FILTER (WHERE c.status = 'no_transcript'),
    'analysis_failed',   count(*) FILTER (WHERE c.status = 'analysis_failed'),
    'unanswered',        count(*) FILTER (WHERE c.diff->>'outcome' IN ('missed', 'voicemail', 'abandoned')),
    'slow_answers',      count(*) FILTER (WHERE c.diff->>'outcome' = 'answered_slow'),
    'after_hours',       count(*) FILTER (WHERE c.diff->>'afterHours' = 'true'),
    'emergencies',       count(*) FILTER (WHERE c.emergency),
    'capturable',        count(*) FILTER (WHERE c.capturable),
    'reviewed',          count(r.id),
    'approved',          count(r.id) FILTER (WHERE r.verdict = 'good'),
    'emergency_cards_reviewed',  count(r.id) FILTER (WHERE c.emergency),
    'emergency_cards_approved',  count(r.id) FILTER (WHERE c.emergency AND r.verdict = 'good'),
    'open_critical',     count(r.id) FILTER (WHERE r.verdict = 'bad' AND r.severity = 'critical' AND NOT r.mistake_resolved),
    'pending_proposals', count(r.id) FILTER (WHERE r.proposal_status = 'pending')
  )
  FROM public.shadow_cards c
  LEFT JOIN public.shadow_reviews r ON r.card_id = c.id
  WHERE c.trial_id = p_trial_id;
$$;

-- Delete-on-request: removes all cards/reviews/report for the trial and cancels it. Audit row is kept.
CREATE OR REPLACE FUNCTION public.shadow_delete_data(p_trial_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
  v_cards integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shadow_trials WHERE id = p_trial_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'trial not found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM public.shadow_reports WHERE trial_id = p_trial_id AND user_id = v_owner;
  DELETE FROM public.shadow_cards   WHERE trial_id = p_trial_id AND user_id = v_owner;  -- reviews cascade
  GET DIAGNOSTICS v_cards = ROW_COUNT;
  UPDATE public.shadow_trials SET status = 'cancelled'
   WHERE id = p_trial_id AND user_id = v_owner AND status <> 'went_live';
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor, detail)
  VALUES (v_owner, p_trial_id, 'data_deleted', auth.uid(), jsonb_build_object('cards_deleted', v_cards));
END;
$$;

-- Go live: records the decision only. It changes NO telephony; the guided checklist does that in existing phone settings.
CREATE OR REPLACE FUNCTION public.shadow_go_live(p_trial_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.shadow_assert_editor();
  t public.shadow_trials%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.shadow_trials WHERE id = p_trial_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trial not found' USING ERRCODE = 'P0002'; END IF;
  IF t.status NOT IN ('active', 'completed') THEN RAISE EXCEPTION 'trial is closed' USING ERRCODE = '55000'; END IF;
  IF NOT (
    COALESCE((t.setup_items->>'forwarding')::boolean, false)
    AND COALESCE((t.setup_items->>'hours')::boolean, false)
    AND COALESCE((t.setup_items->>'emergency_rules')::boolean, false)
    AND COALESCE((t.setup_items->>'test_call')::boolean, false)
  ) THEN
    RAISE EXCEPTION 'finish the go-live checklist first' USING ERRCODE = '55000';
  END IF;
  UPDATE public.shadow_trials SET status = 'went_live', went_live_at = now() WHERE id = t.id;
  INSERT INTO public.shadow_events (user_id, trial_id, kind, actor) VALUES (v_owner, t.id, 'went_live', auth.uid());
END;
$$;

-- Retention sweep. Service role / cron only.
CREATE OR REPLACE FUNCTION public.shadow_purge_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cards integer;
BEGIN
  DELETE FROM public.shadow_cards WHERE purge_after < now();
  GET DIAGNOSTICS v_cards = ROW_COUNT;
  DELETE FROM public.shadow_reports WHERE purge_after < now();
  RETURN v_cards;
END;
$$;

-- Grants: authenticated may call the owner-facing RPCs; purge is service-role only.
REVOKE ALL ON FUNCTION public.shadow_start_trial(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_update_settings(uuid, text, boolean, boolean, boolean, integer, integer, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_set_setup_item(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_submit_review(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_decide_proposal(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_apply_faq(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_trial_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_delete_data(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_go_live(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shadow_purge_expired() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.shadow_start_trial(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_update_settings(uuid, text, boolean, boolean, boolean, integer, integer, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_set_setup_item(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_submit_review(uuid, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_decide_proposal(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_apply_faq(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_trial_stats(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shadow_delete_data(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_go_live(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shadow_purge_expired() TO service_role;
