/*
  # Power dialer (human agents, call lists, dispositions, pacing)

  An agent works a campaign's call list one contact at a time. The server hands out
  the next dialable contact (atomic claim), rings the agent's phone and bridges the
  contact, then the agent picks ONE disposition. The disposition decides what happens
  to the contact (retry later, callback at a time, finished, do-not-call).

  ## Objects
  - dialer_campaigns      : list settings + pacing (preview/power, wrap-up, attempts, hourly cap)
  - dialer_contacts       : the call list (unique phone per campaign)
  - dialer_attempts       : one row per dial (open until a disposition is saved)
  - dialer_campaign_stats : per-campaign counters (security_invoker view)
  - RPCs: dialer_claim_next, dialer_begin_attempt, dialer_complete_attempt, dialer_defer_contact,
          dialer_import_contacts, dialer_import_from_crm (authenticated);
          dialer_attach_call, dialer_record_call_status (service_role only)

  ## Disposition rules (single source of truth, mirrored in src/lib/powerDialer.ts and pinned by a test)
    no_answer / voicemail / busy -> counts an attempt, retry after retry_minutes (done when max_attempts is reached)
    failed                       -> does NOT count, retry in min(retry_minutes, 15) minutes
    callback_requested           -> does NOT count, retry at the time the agent entered (required)
    interested / booked / not_interested / wrong_number -> counts, contact is done
    do_not_call                  -> counts, contact + every other pending copy becomes dnc and the
                                    number is added to dnc_suppressions (never dialed again)
    abandoned                    -> system only (agent vanished mid-call), counts, retry later

  ## Pacing (enforced on the server, not only in the UI)
  - wrap_up_seconds     : minimum pause between two contacts for the same agent
  - max_calls_per_hour  : per agent, per campaign
  - claim lease         : 10 minutes, a vanished agent's contact returns to the list automatically

  ## Compliance
  - Suppressed numbers (dnc_suppressions) are skipped at claim time and at import time.
  - A campaign cannot be activated without a caller ID (phone_numbers row owned by the account).

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, team_members, customers,
  leads, phone_numbers, dnc_suppressions
*/

-- 0) Helpers --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_phone_e164(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_digits text;
BEGIN
  IF p_raw IS NULL THEN RETURN NULL; END IF;
  v_digits := regexp_replace(p_raw, '\D', '', 'g');
  IF left(btrim(p_raw), 1) = '+' THEN
    IF v_digits ~ '^[1-9][0-9]{7,14}$' THEN RETURN '+' || v_digits; END IF;
    RETURN NULL;
  END IF;
  IF v_digits ~ '^[2-9][0-9]{9}$' THEN RETURN '+1' || v_digits; END IF;
  IF v_digits ~ '^1[2-9][0-9]{9}$' THEN RETURN '+' || v_digits; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dialer_can_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.identity_is_manager(), false)
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND (COALESCE((m.permissions ->> 'can_view_all_jobs')::boolean, false)
             OR COALESCE((m.permissions ->> 'can_manage_numbers')::boolean, false))
    );
$$;

CREATE OR REPLACE FUNCTION public.dialer_can_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.identity_is_manager(), false)
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND COALESCE((m.permissions ->> 'can_manage_numbers')::boolean, false)
    );
$$;

CREATE OR REPLACE FUNCTION public.dialer_valid_disposition(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_value IN (
    'no_answer', 'voicemail', 'busy', 'failed', 'callback_requested',
    'interested', 'booked', 'not_interested', 'wrong_number', 'do_not_call', 'abandoned'
  );
$$;

REVOKE ALL ON FUNCTION public.dialer_can_work() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_can_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dialer_can_work() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dialer_can_admin() TO authenticated, service_role;

-- 1) Campaigns ------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dialer_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  pacing_mode text NOT NULL DEFAULT 'power',
  preview_seconds integer NOT NULL DEFAULT 5,
  wrap_up_seconds integer NOT NULL DEFAULT 15,
  max_attempts integer NOT NULL DEFAULT 3,
  retry_minutes integer NOT NULL DEFAULT 240,
  max_calls_per_hour integer NOT NULL DEFAULT 60,
  phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  script text,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT dc_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT dc_text_check CHECK (
    (description IS NULL OR char_length(description) <= 500)
    AND (script IS NULL OR char_length(script) <= 4000)
  ),
  CONSTRAINT dc_status_check CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  CONSTRAINT dc_pacing_check CHECK (pacing_mode IN ('preview', 'power')),
  CONSTRAINT dc_preview_check CHECK (preview_seconds BETWEEN 0 AND 60),
  CONSTRAINT dc_wrap_check CHECK (wrap_up_seconds BETWEEN 0 AND 300),
  CONSTRAINT dc_attempts_check CHECK (max_attempts BETWEEN 1 AND 10),
  CONSTRAINT dc_retry_check CHECK (retry_minutes BETWEEN 5 AND 10080),
  CONSTRAINT dc_hourly_check CHECK (max_calls_per_hour BETWEEN 1 AND 600)
);

CREATE INDEX IF NOT EXISTS idx_dc_owner_status ON public.dialer_campaigns(account_owner_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_active_name
  ON public.dialer_campaigns(account_owner_id, lower(btrim(name))) WHERE status <> 'archived';

-- 2) Contacts ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dialer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.dialer_campaigns(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone_e164 text NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_disposition text,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dk_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT dk_phone_check CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT dk_notes_check CHECK (notes IS NULL OR char_length(notes) <= 1000),
  CONSTRAINT dk_status_check CHECK (status IN ('pending', 'claimed', 'done', 'dnc')),
  CONSTRAINT dk_attempts_check CHECK (attempts >= 0),
  CONSTRAINT dk_disposition_check CHECK (last_disposition IS NULL OR public.dialer_valid_disposition(last_disposition)),
  CONSTRAINT dk_unique_phone UNIQUE (campaign_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_dk_queue
  ON public.dialer_contacts(campaign_id, next_attempt_at, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dk_claimed ON public.dialer_contacts(campaign_id, claimed_by) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS idx_dk_owner_phone ON public.dialer_contacts(account_owner_id, phone_e164);

-- 3) Attempts -------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dialer_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.dialer_campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.dialer_contacts(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  disposition text,
  note text,
  callback_at timestamptz,
  call_sid text,
  call_status text,
  talk_seconds integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT da_disposition_check CHECK (disposition IS NULL OR public.dialer_valid_disposition(disposition)),
  CONSTRAINT da_note_check CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT da_status_check CHECK (
    call_status IS NULL OR call_status IN
      ('queued', 'ringing_agent', 'connected', 'completed', 'busy', 'no_answer', 'failed', 'canceled', 'agent_unreachable')
  ),
  CONSTRAINT da_talk_check CHECK (talk_seconds IS NULL OR talk_seconds BETWEEN 0 AND 86400)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_da_open_per_contact ON public.dialer_attempts(contact_id) WHERE disposition IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_da_call_sid ON public.dialer_attempts(call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_da_agent ON public.dialer_attempts(campaign_id, agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_da_contact ON public.dialer_attempts(contact_id, started_at DESC);

-- 4) Guard trigger for campaigns --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_campaigns_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.description := NULLIF(btrim(COALESCE(NEW.description, '')), '');
  NEW.script := NULLIF(btrim(COALESCE(NEW.script, '')), '');

  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'owner and creation time of a campaign are immutable' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
  END IF;

  IF NEW.phone_number_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM phone_numbers p
     WHERE p.id = NEW.phone_number_id
       AND p.account_id = NEW.account_owner_id
       AND p.status = 'active'
       AND p.voice_enabled
  ) THEN
    RAISE EXCEPTION 'invalid_caller_id' USING ERRCODE = '22023';
  END IF;

  IF NEW.status = 'active' AND NEW.phone_number_id IS NULL THEN
    RAISE EXCEPTION 'caller_id_required' USING ERRCODE = '22023';
  END IF;

  IF NEW.status = 'archived' AND (TG_OP = 'INSERT' OR OLD.status <> 'archived') THEN
    NEW.archived_at := now();
  ELSIF NEW.status <> 'archived' THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dialer_campaigns_guard ON public.dialer_campaigns;
CREATE TRIGGER trg_dialer_campaigns_guard
  BEFORE INSERT OR UPDATE ON public.dialer_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.dialer_campaigns_guard();

-- 5) RLS -------------------------------------------------------------------------------------------------------------
ALTER TABLE public.dialer_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dialer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dialer_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dc_select" ON public.dialer_campaigns;
CREATE POLICY "dc_select" ON public.dialer_campaigns FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dialer_can_work());

DROP POLICY IF EXISTS "dc_insert" ON public.dialer_campaigns;
CREATE POLICY "dc_insert" ON public.dialer_campaigns FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dialer_can_admin());

DROP POLICY IF EXISTS "dc_update" ON public.dialer_campaigns;
CREATE POLICY "dc_update" ON public.dialer_campaigns FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dialer_can_admin())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.dialer_can_admin());

DROP POLICY IF EXISTS "dc_delete" ON public.dialer_campaigns;
CREATE POLICY "dc_delete" ON public.dialer_campaigns FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dialer_can_admin());

DROP POLICY IF EXISTS "dk_select" ON public.dialer_contacts;
CREATE POLICY "dk_select" ON public.dialer_contacts FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dialer_can_work());

DROP POLICY IF EXISTS "dk_delete" ON public.dialer_contacts;
CREATE POLICY "dk_delete" ON public.dialer_contacts FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dialer_can_admin());

DROP POLICY IF EXISTS "da_select" ON public.dialer_attempts;
CREATE POLICY "da_select" ON public.dialer_attempts FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.dialer_can_work());

REVOKE INSERT, UPDATE ON public.dialer_contacts FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.dialer_attempts FROM anon, authenticated;

-- 6) Stats view (caller's RLS applies) -------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.dialer_campaign_stats WITH (security_invoker = true) AS
SELECT
  c.id AS campaign_id,
  c.account_owner_id,
  count(k.id) AS total_contacts,
  count(k.id) FILTER (
    WHERE k.status = 'pending' AND k.attempts < c.max_attempts AND k.next_attempt_at <= now()
  ) AS ready_now,
  count(k.id) FILTER (WHERE k.status = 'pending') AS pending,
  count(k.id) FILTER (WHERE k.status = 'claimed') AS claimed,
  count(k.id) FILTER (WHERE k.status = 'done') AS done,
  count(k.id) FILTER (WHERE k.status = 'dnc') AS dnc,
  COALESCE(sum(k.attempts), 0)::bigint AS total_attempts,
  count(k.id) FILTER (WHERE k.last_disposition = 'booked') AS booked,
  count(k.id) FILTER (WHERE k.last_disposition = 'interested') AS interested
FROM public.dialer_campaigns c
LEFT JOIN public.dialer_contacts k ON k.campaign_id = c.id
GROUP BY c.id;

GRANT SELECT ON public.dialer_campaign_stats TO authenticated;

-- 7) Internal: return contacts whose agent vanished ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_release_expired_claims(p_campaign_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_camp dialer_campaigns%ROWTYPE;
  v_row record;
  v_dialed boolean;
  v_released integer := 0;
BEGIN
  SELECT * INTO v_camp FROM dialer_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR v_row IN
    SELECT k.id FROM dialer_contacts k
     WHERE k.campaign_id = p_campaign_id AND k.status = 'claimed' AND k.claim_expires_at < now()
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE dialer_attempts
       SET disposition = 'abandoned', completed_at = now()
     WHERE contact_id = v_row.id AND disposition IS NULL AND call_sid IS NOT NULL;
    v_dialed := FOUND;

    DELETE FROM dialer_attempts
     WHERE contact_id = v_row.id AND disposition IS NULL AND call_sid IS NULL;

    IF v_dialed THEN
      UPDATE dialer_contacts
         SET status = CASE WHEN attempts + 1 >= v_camp.max_attempts THEN 'done' ELSE 'pending' END,
             attempts = attempts + 1,
             last_disposition = 'abandoned',
             last_attempt_at = now(),
             next_attempt_at = now() + make_interval(mins => v_camp.retry_minutes),
             claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
             updated_at = now()
       WHERE id = v_row.id;
    ELSE
      UPDATE dialer_contacts
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
             updated_at = now()
       WHERE id = v_row.id;
    END IF;
    v_released := v_released + 1;
  END LOOP;
  RETURN v_released;
END;
$$;

REVOKE ALL ON FUNCTION public.dialer_release_expired_claims(uuid) FROM PUBLIC, anon, authenticated;

-- 8) RPC: claim the next contact ------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_claim_next(p_campaign_id uuid)
RETURNS SETOF public.dialer_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_camp dialer_campaigns%ROWTYPE;
  v_contact dialer_contacts%ROWTYPE;
  v_last timestamptz;
  v_remaining integer;
  v_recent integer;
  v_tries integer := 0;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.dialer_can_work() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_camp FROM dialer_campaigns WHERE id = p_campaign_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_camp.status <> 'active' THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = '22023';
  END IF;

  PERFORM public.dialer_release_expired_claims(p_campaign_id);

  -- Refreshing the page must not burn a contact: hand back the one this agent already holds.
  SELECT * INTO v_contact FROM dialer_contacts
   WHERE campaign_id = p_campaign_id AND status = 'claimed' AND claimed_by = v_uid
   ORDER BY claimed_at
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE dialer_contacts
       SET claim_expires_at = now() + interval '10 minutes', updated_at = now()
     WHERE id = v_contact.id
    RETURNING * INTO v_contact;
    RETURN NEXT v_contact;
    RETURN;
  END IF;

  -- Pacing: wrap-up pause and hourly cap, per agent.
  SELECT max(completed_at) INTO v_last FROM dialer_attempts
   WHERE campaign_id = p_campaign_id AND agent_id = v_uid;
  IF v_last IS NOT NULL THEN
    v_remaining := ceil(extract(epoch FROM (v_last + make_interval(secs => v_camp.wrap_up_seconds) - now())))::integer;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'wrap_up_active' USING ERRCODE = 'P0001', DETAIL = v_remaining::text;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent FROM dialer_attempts
   WHERE campaign_id = p_campaign_id AND agent_id = v_uid AND started_at > now() - interval '1 hour';
  IF v_recent >= v_camp.max_calls_per_hour THEN
    RAISE EXCEPTION 'hourly_cap_reached' USING ERRCODE = 'P0001';
  END IF;

  LOOP
    v_tries := v_tries + 1;
    EXIT WHEN v_tries > 25;

    SELECT k.* INTO v_contact FROM dialer_contacts k
     WHERE k.campaign_id = p_campaign_id
       AND k.status = 'pending'
       AND k.attempts < v_camp.max_attempts
       AND k.next_attempt_at <= now()
     ORDER BY k.next_attempt_at, k.created_at, k.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND;

    IF EXISTS (
      SELECT 1 FROM dnc_suppressions d
       WHERE d.user_id = v_owner AND d.phone_number = v_contact.phone_e164
    ) THEN
      UPDATE dialer_contacts SET status = 'dnc', updated_at = now() WHERE id = v_contact.id;
      CONTINUE;
    END IF;

    UPDATE dialer_contacts
       SET status = 'claimed', claimed_by = v_uid, claimed_at = now(),
           claim_expires_at = now() + interval '10 minutes', updated_at = now()
     WHERE id = v_contact.id
    RETURNING * INTO v_contact;
    RETURN NEXT v_contact;
    RETURN;
  END LOOP;

  RETURN;
END;
$$;

-- 9) RPC: open an attempt right before dialing ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_begin_attempt(p_contact_id uuid)
RETURNS public.dialer_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_contact dialer_contacts%ROWTYPE;
  v_camp dialer_campaigns%ROWTYPE;
  v_open dialer_attempts%ROWTYPE;
  v_recent integer;
  v_row dialer_attempts%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.dialer_can_work() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM dialer_contacts
   WHERE id = p_contact_id AND account_owner_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_contact.status <> 'claimed' OR v_contact.claimed_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_claimed_by_you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_camp FROM dialer_campaigns WHERE id = v_contact.campaign_id;
  IF v_camp.status <> 'active' THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_open FROM dialer_attempts WHERE contact_id = p_contact_id AND disposition IS NULL;
  IF FOUND THEN
    IF v_open.call_sid IS NOT NULL
       AND COALESCE(v_open.call_status, 'queued') NOT IN
           ('completed', 'busy', 'no_answer', 'failed', 'canceled', 'agent_unreachable') THEN
      RAISE EXCEPTION 'call_in_progress' USING ERRCODE = '22023';
    END IF;
    UPDATE dialer_attempts
       SET call_sid = NULL, call_status = NULL, talk_seconds = NULL, started_at = now()
     WHERE id = v_open.id
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  SELECT count(*) INTO v_recent FROM dialer_attempts
   WHERE campaign_id = v_camp.id AND agent_id = v_uid AND started_at > now() - interval '1 hour';
  IF v_recent >= v_camp.max_calls_per_hour THEN
    RAISE EXCEPTION 'hourly_cap_reached' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO dialer_attempts (account_owner_id, campaign_id, contact_id, agent_id)
  VALUES (v_owner, v_camp.id, v_contact.id, v_uid)
  RETURNING * INTO v_row;

  UPDATE dialer_contacts
     SET claim_expires_at = now() + interval '10 minutes', updated_at = now()
   WHERE id = v_contact.id;
  RETURN v_row;
END;
$$;

-- 10) RPC: save the disposition ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_complete_attempt(
  p_contact_id uuid,
  p_disposition text,
  p_note text DEFAULT NULL,
  p_callback_at timestamptz DEFAULT NULL
)
RETURNS public.dialer_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_contact dialer_contacts%ROWTYPE;
  v_camp dialer_campaigns%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_counts boolean;
  v_attempts integer;
  v_status text;
  v_next timestamptz;
  v_updated integer;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.dialer_can_work() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_disposition IS NULL OR p_disposition = 'abandoned' OR NOT public.dialer_valid_disposition(p_disposition) THEN
    RAISE EXCEPTION 'invalid_disposition' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'note_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_disposition = 'callback_requested'
     AND (p_callback_at IS NULL OR p_callback_at <= now() OR p_callback_at > now() + interval '1 year') THEN
    RAISE EXCEPTION 'callback_time_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_contact FROM dialer_contacts
   WHERE id = p_contact_id AND account_owner_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_contact.status = 'dnc' THEN
    RAISE EXCEPTION 'contact_suppressed' USING ERRCODE = '22023';
  END IF;
  IF v_contact.status <> 'claimed' OR v_contact.claimed_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_claimed_by_you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_camp FROM dialer_campaigns WHERE id = v_contact.campaign_id;

  UPDATE dialer_attempts
     SET disposition = p_disposition,
         note = v_note,
         callback_at = CASE WHEN p_disposition = 'callback_requested' THEN p_callback_at ELSE NULL END,
         completed_at = now()
   WHERE contact_id = p_contact_id AND disposition IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    -- Manual / fallback dial (for example a tel: link): still record the attempt.
    INSERT INTO dialer_attempts (
      account_owner_id, campaign_id, contact_id, agent_id, disposition, note, callback_at, started_at, completed_at
    ) VALUES (
      v_owner, v_camp.id, v_contact.id, v_uid, p_disposition, v_note,
      CASE WHEN p_disposition = 'callback_requested' THEN p_callback_at ELSE NULL END,
      COALESCE(v_contact.claimed_at, now()), now()
    );
  END IF;

  v_counts := p_disposition NOT IN ('failed', 'callback_requested');
  v_attempts := v_contact.attempts + CASE WHEN v_counts THEN 1 ELSE 0 END;
  v_next := v_contact.next_attempt_at;

  IF p_disposition IN ('interested', 'booked', 'not_interested', 'wrong_number') THEN
    v_status := 'done';
  ELSIF p_disposition = 'do_not_call' THEN
    v_status := 'dnc';
  ELSIF p_disposition = 'callback_requested' THEN
    v_status := 'pending';
    v_next := p_callback_at;
  ELSIF p_disposition = 'failed' THEN
    v_status := 'pending';
    v_next := now() + make_interval(mins => LEAST(v_camp.retry_minutes, 15));
  ELSE
    IF v_attempts >= v_camp.max_attempts THEN
      v_status := 'done';
    ELSE
      v_status := 'pending';
      v_next := now() + make_interval(mins => v_camp.retry_minutes);
    END IF;
  END IF;

  UPDATE dialer_contacts
     SET status = v_status,
         attempts = v_attempts,
         last_disposition = p_disposition,
         last_attempt_at = now(),
         next_attempt_at = v_next,
         notes = COALESCE(v_note, notes),
         claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
         updated_at = now()
   WHERE id = v_contact.id
  RETURNING * INTO v_contact;

  IF p_disposition = 'do_not_call' THEN
    INSERT INTO dnc_suppressions (user_id, phone_number, reason)
    VALUES (v_owner, v_contact.phone_e164, 'customer_opt_out')
    ON CONFLICT (user_id, phone_number) DO NOTHING;

    UPDATE dialer_contacts
       SET status = 'dnc', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = now()
     WHERE account_owner_id = v_owner AND phone_e164 = v_contact.phone_e164
       AND id <> v_contact.id AND status IN ('pending', 'claimed');
  END IF;

  RETURN v_contact;
END;
$$;

-- 11) RPC: put a contact back (skip, quiet hours, ...) ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_defer_contact(p_contact_id uuid, p_until timestamptz)
RETURNS public.dialer_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_contact dialer_contacts%ROWTYPE;
  v_until timestamptz;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.dialer_can_work() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM dialer_contacts
   WHERE id = p_contact_id AND account_owner_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_contact.status <> 'claimed' OR v_contact.claimed_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_claimed_by_you' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dialer_attempts WHERE contact_id = p_contact_id AND disposition IS NULL AND call_sid IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'call_already_placed' USING ERRCODE = '22023';
  END IF;

  v_until := LEAST(GREATEST(COALESCE(p_until, now()), now()), now() + interval '30 days');

  DELETE FROM dialer_attempts WHERE contact_id = p_contact_id AND disposition IS NULL AND call_sid IS NULL;

  UPDATE dialer_contacts
     SET status = 'pending', next_attempt_at = v_until,
         claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = now()
   WHERE id = v_contact.id
  RETURNING * INTO v_contact;
  RETURN v_contact;
END;
$$;

-- 12) RPC: import a pasted / uploaded list -------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_import_contacts(p_campaign_id uuid, p_contacts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_total integer;
  v_valid integer;
  v_unique integer;
  v_suppressed integer;
  v_inserted integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.dialer_can_admin() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_contacts IS NULL OR jsonb_typeof(p_contacts) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_contacts);
  IF v_total = 0 OR v_total > 5000 THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM dialer_campaigns
     WHERE id = p_campaign_id AND account_owner_id = v_owner AND status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;

  WITH src AS (
    SELECT btrim(COALESCE(e ->> 'name', '')) AS name,
           public.normalize_phone_e164(e ->> 'phone') AS phone,
           NULLIF(left(btrim(COALESCE(e ->> 'notes', '')), 1000), '') AS notes
      FROM jsonb_array_elements(p_contacts) AS e
     WHERE jsonb_typeof(e) = 'object'
  ),
  valid AS (
    SELECT * FROM src WHERE phone IS NOT NULL AND char_length(name) BETWEEN 1 AND 120
  ),
  uniq AS (
    SELECT DISTINCT ON (phone) * FROM valid ORDER BY phone, name
  ),
  supp AS (
    SELECT u.phone FROM uniq u
     WHERE EXISTS (SELECT 1 FROM dnc_suppressions d WHERE d.user_id = v_owner AND d.phone_number = u.phone)
  ),
  ins AS (
    INSERT INTO dialer_contacts (account_owner_id, campaign_id, name, phone_e164, notes)
    SELECT v_owner, p_campaign_id, u.name, u.phone, u.notes
      FROM uniq u
     WHERE u.phone NOT IN (SELECT phone FROM supp)
    ON CONFLICT (campaign_id, phone_e164) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM valid),
         (SELECT count(*) FROM uniq),
         (SELECT count(*) FROM supp),
         (SELECT count(*) FROM ins)
    INTO v_valid, v_unique, v_suppressed, v_inserted;

  RETURN jsonb_build_object(
    'received', v_total,
    'inserted', v_inserted,
    'invalid', v_total - v_valid,
    'suppressed', v_suppressed,
    'duplicates', (v_valid - v_unique) + (v_unique - v_suppressed - v_inserted)
  );
END;
$$;

-- 13) RPC: import from the CRM --------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_import_from_crm(
  p_campaign_id uuid,
  p_source text,
  p_filter text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inserted integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.dialer_can_admin() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('customers', 'leads') THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM dialer_campaigns
     WHERE id = p_campaign_id AND account_owner_id = v_owner AND status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_source = 'customers' THEN
    INSERT INTO dialer_contacts (account_owner_id, campaign_id, name, phone_e164, customer_id)
    SELECT v_owner, p_campaign_id, left(btrim(c.name), 120), public.normalize_phone_e164(c.phone), c.id
      FROM customers c
     WHERE c.user_id = v_owner
       AND c.phone IS NOT NULL
       AND char_length(btrim(c.name)) > 0
       AND public.normalize_phone_e164(c.phone) IS NOT NULL
       AND (p_filter IS NULL OR c.lifecycle_stage = p_filter)
       AND NOT EXISTS (
         SELECT 1 FROM dnc_suppressions d
          WHERE d.user_id = v_owner AND d.phone_number = public.normalize_phone_e164(c.phone)
       )
     ORDER BY c.created_at DESC
     LIMIT 5000
    ON CONFLICT (campaign_id, phone_e164) DO NOTHING;
  ELSE
    INSERT INTO dialer_contacts (account_owner_id, campaign_id, name, phone_e164, lead_id)
    SELECT v_owner, p_campaign_id, left(btrim(l.name), 120), public.normalize_phone_e164(l.phone), l.id
      FROM leads l
     WHERE l.user_id = v_owner
       AND l.phone IS NOT NULL
       AND char_length(btrim(l.name)) > 0
       AND public.normalize_phone_e164(l.phone) IS NOT NULL
       AND (p_filter IS NULL OR l.stage = p_filter)
       AND NOT EXISTS (
         SELECT 1 FROM dnc_suppressions d
          WHERE d.user_id = v_owner AND d.phone_number = public.normalize_phone_e164(l.phone)
       )
     ORDER BY l.created_at DESC
     LIMIT 5000
    ON CONFLICT (campaign_id, phone_e164) DO NOTHING;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$;

-- 14) Service-role RPCs used by the dialer edge functions ----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dialer_attach_call(p_attempt_id uuid, p_call_sid text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE dialer_attempts
     SET call_sid = p_call_sid, call_status = 'queued'
   WHERE id = p_attempt_id AND disposition IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.dialer_record_call_status(
  p_call_sid text,
  p_call_status text,
  p_talk_seconds integer DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE dialer_attempts
     SET call_status = p_call_status,
         talk_seconds = COALESCE(p_talk_seconds, talk_seconds)
   WHERE call_sid = p_call_sid
     AND (
       call_status IS NULL
       OR call_status NOT IN ('completed', 'busy', 'no_answer', 'failed', 'canceled', 'agent_unreachable')
       OR p_call_status IN ('completed', 'busy', 'no_answer', 'failed', 'canceled', 'agent_unreachable')
     );
$$;

-- 15) Grants ----------------------------------------------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.dialer_claim_next(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_begin_attempt(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_complete_attempt(uuid, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_defer_contact(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_import_contacts(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_import_from_crm(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dialer_attach_call(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dialer_record_call_status(text, text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.dialer_claim_next(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dialer_begin_attempt(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dialer_complete_attempt(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dialer_defer_contact(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dialer_import_contacts(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dialer_import_from_crm(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dialer_attach_call(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dialer_record_call_status(text, text, integer) TO service_role;
