/*
  # Sanctions screening gate (provider-agnostic)

  Storage + atomic RPCs for the screening gate in supabase/functions/_shared/sanctions/.
  No vendor is referenced here: the screening provider is chosen by edge-function env (see docs/compliance/sanctions-screening.md).

  Tables (all RLS-enabled; staff-read only; ALL writes go through the service role / the RPCs below):
    - sanctions_settings          singleton: mode (shadow | enforce), thresholds, restricted_countries
    - sanctions_screenings        append-only log of every screening decision (PII: name / country / DOB of the screened subject)
    - sanctions_review_cases      the human review queue (open | escalated | cleared | blocked)
    - sanctions_case_events       append-only case history
    - sanctions_subject_overrides reviewer verdict per subject hash (lets a cleared signup retry pass, keeps a blocked subject blocked)
    - sanctions_account_state     per-account gate state used by payout setup / payouts: held | cleared | blocked (no row = unscreened)

  Design notes
    * Owners can NOT read any of these tables (no tipping off) — there is no owner policy on purpose.
    * Rows reference auth.users with ON DELETE SET NULL in the log/queue tables so screening evidence outlives an account
      deletion. Retention periods are a legal decision [COUNSEL]; nothing here deletes anything.
    * A confirmed block ('blocked') is never overwritten by an automatic result; only a staff decision changes it.
    * 'shadow' mode records screenings but never creates holds; 'enforce' creates holds + review cases.
    * The default seeded mode is 'shadow' so deploying this migration cannot stop signups/payouts before a provider is configured.
      The application code resolves a missing/corrupt settings row to 'enforce' (fail closed); see config.ts.

  Rollback: this migration only adds objects. To undo, DROP FUNCTION public.sanctions_decide_case(uuid, uuid, text, text),
  public.sanctions_record_screening(uuid, text, text, jsonb, text, text, text, text, numeric, jsonb, text) and then the six
  sanctions_* tables (child tables first: case_events, then review_cases, overrides, account_state, screenings, settings).
  Do this only after confirming with counsel that the screening records may be discarded [COUNSEL].
*/

-- rollback: additive only; drop the two sanctions_* functions, then the six sanctions_* tables (children first), then sanctions_valid_country_array(text[]) — only after counsel confirms the records may be discarded.

CREATE OR REPLACE FUNCTION public.sanctions_valid_country_array(p_codes text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT p_codes IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest(p_codes) AS c WHERE c IS NULL OR c !~ '^[A-Z]{2}$');
$$;

CREATE TABLE IF NOT EXISTS public.sanctions_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode                 text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
  review_threshold     numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (review_threshold BETWEEN 0.50 AND 1.00),
  provider_timeout_ms  integer NOT NULL DEFAULT 3000 CHECK (provider_timeout_ms BETWEEN 500 AND 10000),
  -- ISO 3166-1 alpha-2, upper-case. Deliberately EMPTY by default: the list is a legal determination [COUNSEL][VERIFY].
  restricted_countries text[] NOT NULL DEFAULT '{}' CHECK (public.sanctions_valid_country_array(restricted_countries)),
  reason               text,
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.sanctions_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sanctions_screenings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  checkpoint       text NOT NULL CHECK (checkpoint IN ('signup', 'payout_setup', 'rescreen')),
  subject_hash     text NOT NULL,
  subject          jsonb NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('clear', 'review', 'error')),
  mode             text NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  provider         text,
  list_version     text,
  top_score        numeric(4,3) CHECK (top_score IS NULL OR top_score BETWEEN 0 AND 1),
  matches          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sanctions_screenings_owner ON public.sanctions_screenings (account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sanctions_screenings_subject ON public.sanctions_screenings (subject_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sanctions_screenings_decision ON public.sanctions_screenings (decision, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sanctions_review_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key       text NOT NULL,
  account_owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  checkpoint       text NOT NULL CHECK (checkpoint IN ('signup', 'payout_setup', 'rescreen')),
  subject_hash     text NOT NULL,
  subject          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'escalated', 'cleared', 'blocked')),
  top_score        numeric(4,3) CHECK (top_score IS NULL OR top_score BETWEEN 0 AND 1),
  matches          jsonb NOT NULL DEFAULT '[]'::jsonb,
  screening_id     uuid REFERENCES public.sanctions_screenings(id) ON DELETE SET NULL,
  resolution       text,
  decided_by       uuid,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- At most one live case per (account | signup) + subject: repeated attempts refresh the case instead of flooding the queue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sanctions_open_case ON public.sanctions_review_cases (dedupe_key) WHERE status IN ('open', 'escalated');
CREATE INDEX IF NOT EXISTS idx_sanctions_cases_status ON public.sanctions_review_cases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sanctions_cases_owner ON public.sanctions_review_cases (account_owner_id);

CREATE TABLE IF NOT EXISTS public.sanctions_case_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES public.sanctions_review_cases(id) ON DELETE CASCADE,
  actor_id   uuid,
  action     text NOT NULL CHECK (action IN ('opened', 'refreshed', 'cleared', 'confirmed_block', 'escalated')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sanctions_case_events_case ON public.sanctions_case_events (case_id, created_at);

CREATE TABLE IF NOT EXISTS public.sanctions_subject_overrides (
  subject_hash text PRIMARY KEY,
  verdict      text NOT NULL CHECK (verdict IN ('cleared', 'blocked')),
  case_id      uuid REFERENCES public.sanctions_review_cases(id) ON DELETE SET NULL,
  decided_by   uuid,
  decided_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sanctions_account_state (
  account_owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('held', 'cleared', 'blocked')),
  subject_hash     text NOT NULL,
  case_id          uuid REFERENCES public.sanctions_review_cases(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sanctions_account_state_status ON public.sanctions_account_state (status);

-- ------------------------------------------------------------------ RLS --
ALTER TABLE public.sanctions_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sanctions_screenings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sanctions_review_cases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sanctions_case_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sanctions_subject_overrides  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sanctions_account_state      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sanctions_settings, public.sanctions_screenings, public.sanctions_review_cases,
              public.sanctions_case_events, public.sanctions_subject_overrides, public.sanctions_account_state
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sanctions_settings, public.sanctions_screenings, public.sanctions_review_cases,
                public.sanctions_case_events, public.sanctions_subject_overrides, public.sanctions_account_state
  TO authenticated;

DROP POLICY IF EXISTS sanctions_settings_staff_select ON public.sanctions_settings;
CREATE POLICY sanctions_settings_staff_select ON public.sanctions_settings FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS sanctions_screenings_staff_select ON public.sanctions_screenings;
CREATE POLICY sanctions_screenings_staff_select ON public.sanctions_screenings FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS sanctions_cases_staff_select ON public.sanctions_review_cases;
CREATE POLICY sanctions_cases_staff_select ON public.sanctions_review_cases FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS sanctions_case_events_staff_select ON public.sanctions_case_events;
CREATE POLICY sanctions_case_events_staff_select ON public.sanctions_case_events FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS sanctions_overrides_staff_select ON public.sanctions_subject_overrides;
CREATE POLICY sanctions_overrides_staff_select ON public.sanctions_subject_overrides FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS sanctions_account_state_staff_select ON public.sanctions_account_state;
CREATE POLICY sanctions_account_state_staff_select ON public.sanctions_account_state FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- ------------------------------------------------------------ RPC: record --
-- One transaction: screening row + (enforce only) review case + account gate state.
CREATE OR REPLACE FUNCTION public.sanctions_record_screening(
  p_owner        uuid,
  p_checkpoint   text,
  p_subject_hash text,
  p_subject      jsonb,
  p_decision     text,
  p_mode         text,
  p_provider     text,
  p_list_version text,
  p_top_score    numeric,
  p_matches      jsonb,
  p_reason       text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_screening uuid;
  v_case      uuid;
  v_inserted  boolean := false;
  v_key       text := COALESCE(p_owner::text, 'signup') || ':' || p_subject_hash;
  v_prev      public.sanctions_account_state%ROWTYPE;
BEGIN
  INSERT INTO public.sanctions_screenings
    (account_owner_id, checkpoint, subject_hash, subject, decision, mode, provider, list_version, top_score, matches, reason)
  VALUES
    (p_owner, p_checkpoint, p_subject_hash, p_subject, p_decision, p_mode, p_provider, p_list_version, p_top_score,
     COALESCE(p_matches, '[]'::jsonb), left(p_reason, 500))
  RETURNING id INTO v_screening;

  IF p_mode = 'enforce' AND p_decision = 'review' THEN
    INSERT INTO public.sanctions_review_cases
      (dedupe_key, account_owner_id, checkpoint, subject_hash, subject, top_score, matches, screening_id)
    VALUES
      (v_key, p_owner, p_checkpoint, p_subject_hash, p_subject, p_top_score, COALESCE(p_matches, '[]'::jsonb), v_screening)
    ON CONFLICT (dedupe_key) WHERE status IN ('open', 'escalated') DO UPDATE
      SET screening_id = EXCLUDED.screening_id,
          top_score    = GREATEST(public.sanctions_review_cases.top_score, EXCLUDED.top_score),
          matches      = EXCLUDED.matches,
          updated_at   = now()
    RETURNING id, (xmax = 0) INTO v_case, v_inserted;

    INSERT INTO public.sanctions_case_events (case_id, actor_id, action, note)
    VALUES (v_case, NULL, CASE WHEN v_inserted THEN 'opened' ELSE 'refreshed' END, p_checkpoint);

    IF p_owner IS NOT NULL THEN
      INSERT INTO public.sanctions_account_state (account_owner_id, status, subject_hash, case_id)
      VALUES (p_owner, 'held', p_subject_hash, v_case)
      ON CONFLICT (account_owner_id) DO UPDATE
        SET status       = CASE WHEN public.sanctions_account_state.status = 'blocked' THEN 'blocked' ELSE 'held' END,
            subject_hash = EXCLUDED.subject_hash,
            case_id      = EXCLUDED.case_id,
            updated_at   = now();
    END IF;

  ELSIF p_mode = 'enforce' AND p_decision = 'clear' AND p_owner IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.sanctions_account_state WHERE account_owner_id = p_owner FOR UPDATE;
    -- Never auto-release a confirmed block, nor a hold on the SAME subject (only a reviewer releases that).
    IF NOT FOUND OR (v_prev.status <> 'blocked' AND NOT (v_prev.status = 'held' AND v_prev.subject_hash = p_subject_hash)) THEN
      INSERT INTO public.sanctions_account_state (account_owner_id, status, subject_hash)
      VALUES (p_owner, 'cleared', p_subject_hash)
      ON CONFLICT (account_owner_id) DO UPDATE
        SET status = 'cleared', subject_hash = EXCLUDED.subject_hash, case_id = NULL, updated_at = now();
    END IF;
  END IF;

  RETURN jsonb_build_object('screening_id', v_screening, 'case_id', v_case);
END;
$$;

-- ------------------------------------------------------------ RPC: decide --
CREATE OR REPLACE FUNCTION public.sanctions_decide_case(
  p_case     uuid,
  p_actor    uuid,
  p_decision text,
  p_note     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case public.sanctions_review_cases%ROWTYPE;
  v_note text := btrim(COALESCE(p_note, ''));
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'actor required' USING ERRCODE = '22023'; END IF;
  IF p_decision NOT IN ('clear', 'confirm_block', 'escalate') THEN RAISE EXCEPTION 'invalid decision' USING ERRCODE = '22023'; END IF;
  IF length(v_note) < 3 OR length(v_note) > 1000 THEN RAISE EXCEPTION 'note must be 3-1000 characters' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_case FROM public.sanctions_review_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case not found' USING ERRCODE = 'P0002'; END IF;
  IF v_case.status NOT IN ('open', 'escalated') THEN RAISE EXCEPTION 'case already closed' USING ERRCODE = '55000'; END IF;
  IF p_decision = 'escalate' AND v_case.status = 'escalated' THEN RAISE EXCEPTION 'case already escalated' USING ERRCODE = '55000'; END IF;

  IF p_decision = 'escalate' THEN
    UPDATE public.sanctions_review_cases SET status = 'escalated', updated_at = now() WHERE id = p_case;
    INSERT INTO public.sanctions_case_events (case_id, actor_id, action, note) VALUES (p_case, p_actor, 'escalated', v_note);
    RETURN jsonb_build_object('case_id', p_case, 'status', 'escalated');
  END IF;

  UPDATE public.sanctions_review_cases
     SET status = CASE WHEN p_decision = 'clear' THEN 'cleared' ELSE 'blocked' END,
         resolution = v_note, decided_by = p_actor, decided_at = now(), updated_at = now()
   WHERE id = p_case;

  INSERT INTO public.sanctions_subject_overrides (subject_hash, verdict, case_id, decided_by, decided_at)
  VALUES (v_case.subject_hash, CASE WHEN p_decision = 'clear' THEN 'cleared' ELSE 'blocked' END, p_case, p_actor, now())
  ON CONFLICT (subject_hash) DO UPDATE
    SET verdict = EXCLUDED.verdict, case_id = EXCLUDED.case_id, decided_by = EXCLUDED.decided_by, decided_at = now();

  IF v_case.account_owner_id IS NOT NULL THEN
    INSERT INTO public.sanctions_account_state (account_owner_id, status, subject_hash, case_id)
    VALUES (v_case.account_owner_id, CASE WHEN p_decision = 'clear' THEN 'cleared' ELSE 'blocked' END, v_case.subject_hash, p_case)
    ON CONFLICT (account_owner_id) DO UPDATE
      SET status = EXCLUDED.status, subject_hash = EXCLUDED.subject_hash, case_id = EXCLUDED.case_id, updated_at = now();
  END IF;

  INSERT INTO public.sanctions_case_events (case_id, actor_id, action, note)
  VALUES (p_case, p_actor, CASE WHEN p_decision = 'clear' THEN 'cleared' ELSE 'confirmed_block' END, v_note);

  RETURN jsonb_build_object('case_id', p_case, 'status', CASE WHEN p_decision = 'clear' THEN 'cleared' ELSE 'blocked' END);
END;
$$;

-- Service role only: these write compliance state, so no end-user session may ever call them.
REVOKE ALL ON FUNCTION public.sanctions_record_screening(uuid, text, text, jsonb, text, text, text, text, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sanctions_decide_case(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sanctions_record_screening(uuid, text, text, jsonb, text, text, text, text, numeric, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sanctions_decide_case(uuid, uuid, text, text) TO service_role;
