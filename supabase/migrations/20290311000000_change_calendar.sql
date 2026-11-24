/*
  # Business change calendar (Vireek's OWN pricing / terms / SLA / policy changes) — platform staff ONLY

  ## Why
  Vireek announces changes to its own price, terms, SLA and policies to customers. Nothing tracked who owns such a change,
  who approved it, when customers must be told and when it takes effect. This adds that register plus reminders.

  ## What already existed (and is NOT duplicated)
  - price_change_notices (20290303000000_billing_notices.sql): the plan-level price/limit notice that send-billing-notices
    emails to affected accounts. This calendar does not send customer notices. It can POINT at one
    (price_change_notice_id, FK created only when that table exists).
  - docs/compliance/regulatory-calendar.json: regulation review dates (a different thing: external law, not our own changes).

  ## Objects
    change_calendar_entries        the register (never deleted: cancel instead)
    change_calendar_events         append-only audit trail of every transition (before/after)
    change_calendar_reminder_log   one row per (entry, reminder kind): exactly-once email reminders
    staff_change_calendar_*        staff-only SECURITY DEFINER RPCs (upsert / submit / decide / mark_notice_sent / complete / cancel)
    change_calendar_claim_reminders / _complete_reminder / _release_reminder   service_role only (used by change-calendar-tick)

  ## Lifecycle
    draft -> pending_approval -> approved -> completed          (approved/pending may be edited: that resets to draft)
                              -> rejected  -> (edit) draft
    any non-terminal -> cancelled (note required).  completed / cancelled are terminal.
  - notice_sent_at is recorded by staff AFTER they sent the notice; this system never claims a notice was sent by itself.
  - Once notice_sent_at is set, category/title/summary/audience/dates are LOCKED (what customers were told must stay
    reconstructable). To change course: cancel and create a new entry.
  - Maker-checker: the approver may not be the requester (same rule as docs/security/maker-checker.md), except when
    there is exactly ONE staff account; that self-approval is allowed and written to the audit trail.

  ## Legal
  - min_notice_days is optional and EMPTY by default. No legal notice period is assumed anywhere. [COUNSEL] decides the
    required notice per change (price_change_notices carries its own 30-day minimum, also [COUNSEL]).
  - Nothing here states that any notice is legally sufficient.

  ## Security
  - RLS on all three tables. Staff (profiles.is_staff via is_vireek_staff) may SELECT entries and events.
    No INSERT/UPDATE/DELETE policy for anyone: writes happen only through the RPCs, which re-check staff status inside.
  - anon and authenticated have no table write privileges; the reminder log has no policy at all (service role only).
  - Customers can never read these tables. Free text is staff-authored; keep customer PII out of it.

  ## Time
  Dates are plain `date` values interpreted in UTC (same as the rest of the repo's day-precision logic).

  ## Reminders
  change_calendar_reminder_kind() picks at most ONE kind per entry per run (most urgent first):
    unapproved_past_notice > approval_needed | notice_overdue > notice_1d > notice_7d > completion_due > effective_7d
  Each (entry, kind) is emailed once. Changing notice/effective dates clears the log so new dates remind again.
  The TypeScript twin is src/lib/changeCalendar.ts (reminderKind); both are tested against the same cases.

  Idempotent: safe to run twice. ROLLBACK block at the end of this file.
*/

-- =============================================================
-- 1. Entries
-- =============================================================
CREATE TABLE IF NOT EXISTS public.change_calendar_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category              text NOT NULL CHECK (category IN ('pricing', 'terms', 'sla', 'policy')),
  title                 text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 140),
  summary               text CHECK (summary IS NULL OR char_length(summary) <= 2000),
  audience              text NOT NULL DEFAULT 'all_customers' CHECK (audience IN ('all_customers', 'affected_plans', 'partners', 'internal')),
  owner_id              uuid NOT NULL,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'completed')),
  notice_date           date NOT NULL,
  effective_date        date NOT NULL,
  min_notice_days       integer CHECK (min_notice_days IS NULL OR min_notice_days BETWEEN 0 AND 365),
  reference_url         text CHECK (reference_url IS NULL OR (reference_url ~ '^https://[^[:space:]]+$' AND char_length(reference_url) <= 500)),
  price_change_notice_id uuid,
  notice_sent_at        timestamptz,
  notice_sent_by        uuid,
  decided_by            uuid,
  decided_at            timestamptz,
  decision_note         text CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT change_calendar_dates_order CHECK (effective_date >= notice_date),
  CONSTRAINT change_calendar_min_notice CHECK (min_notice_days IS NULL OR effective_date - notice_date >= min_notice_days),
  CONSTRAINT change_calendar_approved_has_decision CHECK (status NOT IN ('approved', 'completed') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT change_calendar_completed_has_stamp CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT change_calendar_cancelled_has_stamp CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT change_calendar_notice_sent_state CHECK (notice_sent_at IS NULL OR status IN ('approved', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_change_calendar_status_notice ON public.change_calendar_entries (status, notice_date);
CREATE INDEX IF NOT EXISTS idx_change_calendar_status_effective ON public.change_calendar_entries (status, effective_date);
CREATE INDEX IF NOT EXISTS idx_change_calendar_owner ON public.change_calendar_entries (owner_id);

-- Optional pointer to the existing customer-notice record. Created only if that table exists in this database.
DO $$
BEGIN
  IF to_regclass('public.price_change_notices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_calendar_entries_pcn_fk') THEN
    ALTER TABLE public.change_calendar_entries
      ADD CONSTRAINT change_calendar_entries_pcn_fk
      FOREIGN KEY (price_change_notice_id) REFERENCES public.price_change_notices(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =============================================================
-- 2. Audit trail (append-only) and reminder log
-- =============================================================
CREATE TABLE IF NOT EXISTS public.change_calendar_events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id  uuid NOT NULL REFERENCES public.change_calendar_entries(id),
  action    text NOT NULL CHECK (action IN ('created', 'updated', 'reset_to_draft', 'submitted', 'approved', 'rejected', 'notice_sent', 'completed', 'cancelled')),
  actor_id  uuid,
  at        timestamptz NOT NULL DEFAULT now(),
  before    jsonb,
  after     jsonb,
  note      text CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE INDEX IF NOT EXISTS idx_change_calendar_events_entry ON public.change_calendar_events (entry_id, at);

CREATE TABLE IF NOT EXISTS public.change_calendar_reminder_log (
  entry_id   uuid NOT NULL REFERENCES public.change_calendar_entries(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('unapproved_past_notice', 'approval_needed', 'notice_overdue', 'notice_1d', 'notice_7d', 'completion_due', 'effective_7d')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  PRIMARY KEY (entry_id, kind)
);

CREATE OR REPLACE FUNCTION public.change_calendar_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'change_calendar_events is append-only' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS trg_change_calendar_events_append_only ON public.change_calendar_events;
CREATE TRIGGER trg_change_calendar_events_append_only
  BEFORE UPDATE OR DELETE ON public.change_calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.change_calendar_events_append_only();

DROP TRIGGER IF EXISTS trg_change_calendar_events_no_truncate ON public.change_calendar_events;
CREATE TRIGGER trg_change_calendar_events_no_truncate
  BEFORE TRUNCATE ON public.change_calendar_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.change_calendar_events_append_only();

-- Guard on the register itself: terminal states are final, identity columns never change, no direct deletes.
CREATE OR REPLACE FUNCTION public.change_calendar_entries_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'change calendar entries are never deleted: cancel instead' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'a % entry is final', OLD.status USING ERRCODE = '55000';
    END IF;
    NEW.id := OLD.id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_change_calendar_entries_guard ON public.change_calendar_entries;
CREATE TRIGGER trg_change_calendar_entries_guard
  BEFORE UPDATE OR DELETE ON public.change_calendar_entries
  FOR EACH ROW EXECUTE FUNCTION public.change_calendar_entries_guard();

-- =============================================================
-- 3. RLS: staff read only. Writes go through the RPCs below.
-- =============================================================
ALTER TABLE public.change_calendar_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_calendar_reminder_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_change_calendar_entries" ON public.change_calendar_entries;
CREATE POLICY "staff_select_change_calendar_entries" ON public.change_calendar_entries
  FOR SELECT TO authenticated USING (public.is_vireek_staff((SELECT auth.uid())));

DROP POLICY IF EXISTS "staff_select_change_calendar_events" ON public.change_calendar_events;
CREATE POLICY "staff_select_change_calendar_events" ON public.change_calendar_events
  FOR SELECT TO authenticated USING (public.is_vireek_staff((SELECT auth.uid())));

REVOKE ALL ON public.change_calendar_entries, public.change_calendar_events, public.change_calendar_reminder_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.change_calendar_entries, public.change_calendar_events TO authenticated;
GRANT ALL ON public.change_calendar_entries, public.change_calendar_events, public.change_calendar_reminder_log TO service_role;

-- =============================================================
-- 4. Internal helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.change_calendar_assert_staff()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'forbidden: platform staff only' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END $$;

CREATE OR REPLACE FUNCTION public.change_calendar_log(p_entry uuid, p_action text, p_actor uuid, p_before jsonb, p_after jsonb, p_note text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.change_calendar_events (entry_id, action, actor_id, before, after, note)
  VALUES (p_entry, p_action, p_actor, p_before, p_after, left(p_note, 500));
$$;

REVOKE ALL ON FUNCTION public.change_calendar_assert_staff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.change_calendar_log(uuid, text, uuid, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;

-- Which reminder (if any) is due for an entry on p_today. Twin of reminderKind() in src/lib/changeCalendar.ts.
CREATE OR REPLACE FUNCTION public.change_calendar_reminder_kind(p_status text, p_notice date, p_effective date, p_notice_sent boolean, p_today date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_status IN ('draft', 'pending_approval') AND p_notice <= p_today THEN 'unapproved_past_notice'
    WHEN p_status IN ('draft', 'pending_approval') AND p_notice - p_today <= 7 THEN 'approval_needed'
    WHEN p_status = 'approved' AND NOT COALESCE(p_notice_sent, false) AND p_notice < p_today THEN 'notice_overdue'
    WHEN p_status = 'approved' AND NOT COALESCE(p_notice_sent, false) AND p_notice - p_today <= 1 THEN 'notice_1d'
    WHEN p_status = 'approved' AND NOT COALESCE(p_notice_sent, false) AND p_notice - p_today <= 7 THEN 'notice_7d'
    WHEN p_status = 'approved' AND p_effective < p_today THEN 'completion_due'
    WHEN p_status = 'approved' AND p_effective - p_today <= 7 THEN 'effective_7d'
    ELSE NULL
  END;
$$;
GRANT EXECUTE ON FUNCTION public.change_calendar_reminder_kind(text, date, date, boolean, date) TO authenticated, service_role;

-- =============================================================
-- 5. Staff RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_change_calendar_upsert(p_entry jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := public.change_calendar_assert_staff();
  v_allowed text[] := ARRAY['id', 'category', 'title', 'summary', 'audience', 'owner_id', 'notice_date', 'effective_date', 'min_notice_days', 'reference_url', 'price_change_notice_id'];
  v_bad text;
  v_old public.change_calendar_entries;
  v_new public.change_calendar_entries;
  v_id uuid;
  v_owner uuid;
  v_material boolean;
  v_dates boolean;
BEGIN
  IF p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'invalid payload' USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(k, ', ') INTO v_bad FROM jsonb_object_keys(p_entry) AS k WHERE k <> ALL (v_allowed);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'unknown field(s): %', v_bad USING ERRCODE = '22023';
  END IF;

  v_owner := NULLIF(p_entry->>'owner_id', '')::uuid;
  IF v_owner IS NULL OR NOT public.is_vireek_staff(v_owner) THEN
    RAISE EXCEPTION 'owner must be a platform staff account' USING ERRCODE = '22023';
  END IF;
  v_id := NULLIF(p_entry->>'id', '')::uuid;

  IF v_id IS NULL THEN
    INSERT INTO public.change_calendar_entries
      (category, title, summary, audience, owner_id, notice_date, effective_date, min_notice_days, reference_url, price_change_notice_id, created_by)
    VALUES (
      p_entry->>'category', btrim(p_entry->>'title'), NULLIF(btrim(p_entry->>'summary'), ''),
      COALESCE(NULLIF(p_entry->>'audience', ''), 'all_customers'), v_owner,
      (p_entry->>'notice_date')::date, (p_entry->>'effective_date')::date,
      NULLIF(p_entry->>'min_notice_days', '')::integer, NULLIF(btrim(p_entry->>'reference_url'), ''),
      NULLIF(p_entry->>'price_change_notice_id', '')::uuid, v_actor
    ) RETURNING * INTO v_new;
    PERFORM public.change_calendar_log(v_new.id, 'created', v_actor, NULL, to_jsonb(v_new), NULL);
    RETURN to_jsonb(v_new);
  END IF;

  SELECT * INTO v_old FROM public.change_calendar_entries WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'a % entry is final', v_old.status USING ERRCODE = '55000';
  END IF;

  v_material := (v_old.category, v_old.title, v_old.summary, v_old.audience, v_old.notice_date, v_old.effective_date, v_old.min_notice_days)
    IS DISTINCT FROM (
      p_entry->>'category', btrim(p_entry->>'title'), NULLIF(btrim(p_entry->>'summary'), ''),
      COALESCE(NULLIF(p_entry->>'audience', ''), 'all_customers'),
      (p_entry->>'notice_date')::date, (p_entry->>'effective_date')::date, NULLIF(p_entry->>'min_notice_days', '')::integer);
  v_dates := (v_old.notice_date, v_old.effective_date) IS DISTINCT FROM ((p_entry->>'notice_date')::date, (p_entry->>'effective_date')::date);

  IF v_old.notice_sent_at IS NOT NULL AND v_material THEN
    RAISE EXCEPTION 'locked_after_notice: the notice was already sent; cancel this entry and create a new one' USING ERRCODE = '55000';
  END IF;

  UPDATE public.change_calendar_entries SET
    category = p_entry->>'category',
    title = btrim(p_entry->>'title'),
    summary = NULLIF(btrim(p_entry->>'summary'), ''),
    audience = COALESCE(NULLIF(p_entry->>'audience', ''), 'all_customers'),
    owner_id = v_owner,
    notice_date = (p_entry->>'notice_date')::date,
    effective_date = (p_entry->>'effective_date')::date,
    min_notice_days = NULLIF(p_entry->>'min_notice_days', '')::integer,
    reference_url = NULLIF(btrim(p_entry->>'reference_url'), ''),
    price_change_notice_id = NULLIF(p_entry->>'price_change_notice_id', '')::uuid,
    -- A material edit voids any approval; so does any edit of a rejected entry.
    status = CASE WHEN (v_material AND v_old.status IN ('pending_approval', 'approved')) OR v_old.status = 'rejected' THEN 'draft' ELSE v_old.status END,
    decided_by = CASE WHEN (v_material AND v_old.status IN ('pending_approval', 'approved')) OR v_old.status = 'rejected' THEN NULL ELSE v_old.decided_by END,
    decided_at = CASE WHEN (v_material AND v_old.status IN ('pending_approval', 'approved')) OR v_old.status = 'rejected' THEN NULL ELSE v_old.decided_at END,
    decision_note = CASE WHEN (v_material AND v_old.status IN ('pending_approval', 'approved')) OR v_old.status = 'rejected' THEN NULL ELSE v_old.decision_note END
  WHERE id = v_id
  RETURNING * INTO v_new;

  IF v_dates THEN
    DELETE FROM public.change_calendar_reminder_log WHERE entry_id = v_id; -- new dates remind again
  END IF;
  PERFORM public.change_calendar_log(v_id, 'updated', v_actor, to_jsonb(v_old), to_jsonb(v_new), NULL);
  IF v_new.status = 'draft' AND v_old.status <> 'draft' THEN
    PERFORM public.change_calendar_log(v_id, 'reset_to_draft', v_actor, NULL, NULL, 'approval cleared by edit');
  END IF;
  RETURN to_jsonb(v_new);
END $$;

CREATE OR REPLACE FUNCTION public.staff_change_calendar_submit(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := public.change_calendar_assert_staff();
  v_old public.change_calendar_entries;
  v_new public.change_calendar_entries;
BEGIN
  SELECT * INTO v_old FROM public.change_calendar_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old.status = 'pending_approval' THEN RETURN to_jsonb(v_old); END IF; -- double click: no-op
  IF v_old.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be submitted (status: %)', v_old.status USING ERRCODE = '55000';
  END IF;
  IF v_old.effective_date < (now() AT TIME ZONE 'utc')::date THEN
    RAISE EXCEPTION 'effective_date_in_past' USING ERRCODE = '22007';
  END IF;
  UPDATE public.change_calendar_entries SET status = 'pending_approval' WHERE id = p_id RETURNING * INTO v_new;
  PERFORM public.change_calendar_log(p_id, 'submitted', v_actor, to_jsonb(v_old), to_jsonb(v_new), NULL);
  RETURN to_jsonb(v_new);
END $$;

CREATE OR REPLACE FUNCTION public.staff_change_calendar_decide(p_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := public.change_calendar_assert_staff();
  v_old public.change_calendar_entries;
  v_new public.change_calendar_entries;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_solo boolean;
  v_log_note text := v_note;
BEGIN
  IF p_approve IS NULL THEN RAISE EXCEPTION 'p_approve is required' USING ERRCODE = '22023'; END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN RAISE EXCEPTION 'note too long' USING ERRCODE = '22001'; END IF;
  IF NOT p_approve AND (v_note IS NULL OR char_length(v_note) < 3) THEN
    RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.change_calendar_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry not found' USING ERRCODE = 'P0002'; END IF;
  IF (p_approve AND v_old.status = 'approved') OR (NOT p_approve AND v_old.status = 'rejected') THEN
    RETURN to_jsonb(v_old); -- repeated decision: no-op
  END IF;
  IF v_old.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'only a pending entry can be decided (status: %)', v_old.status USING ERRCODE = '55000';
  END IF;

  IF p_approve THEN
    IF v_old.effective_date < (now() AT TIME ZONE 'utc')::date THEN
      RAISE EXCEPTION 'effective_date_in_past' USING ERRCODE = '22007';
    END IF;
    IF v_actor = v_old.created_by THEN
      SELECT count(*) = 1 INTO v_solo FROM public.profiles WHERE is_staff;
      IF NOT COALESCE(v_solo, false) THEN
        RAISE EXCEPTION 'maker_checker_violation: the requester cannot approve their own change' USING ERRCODE = '42501';
      END IF;
      v_log_note := trim(both ' ' FROM 'solo_self_approval ' || COALESCE(v_note, ''));
    END IF;
  END IF;

  UPDATE public.change_calendar_entries
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = v_actor, decided_at = now(), decision_note = v_note
   WHERE id = p_id RETURNING * INTO v_new;
  PERFORM public.change_calendar_log(p_id, CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, v_actor, to_jsonb(v_old), to_jsonb(v_new), v_log_note);
  RETURN to_jsonb(v_new);
END $$;

CREATE OR REPLACE FUNCTION public.staff_change_calendar_mark_notice_sent(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := public.change_calendar_assert_staff();
  v_old public.change_calendar_entries;
  v_new public.change_calendar_entries;
BEGIN
  SELECT * INTO v_old FROM public.change_calendar_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old.notice_sent_at IS NOT NULL THEN RETURN to_jsonb(v_old); END IF; -- already recorded: keep the first timestamp
  IF v_old.status <> 'approved' THEN
    RAISE EXCEPTION 'record a notice only for an approved entry (status: %)', v_old.status USING ERRCODE = '55000';
  END IF;
  UPDATE public.change_calendar_entries SET notice_sent_at = now(), notice_sent_by = v_actor WHERE id = p_id RETURNING * INTO v_new;
  PERFORM public.change_calendar_log(p_id, 'notice_sent', v_actor, to_jsonb(v_old), to_jsonb(v_new), 'recorded by staff; this system did not send it');
  RETURN to_jsonb(v_new);
END $$;

CREATE OR REPLACE FUNCTION public.staff_change_calendar_complete(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := public.change_calendar_assert_staff();
  v_old public.change_calendar_entries;
  v_new public.change_calendar_entries;
BEGIN
  SELECT * INTO v_old FROM public.change_calendar_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old.status = 'completed' THEN RETURN to_jsonb(v_old); END IF;
  IF v_old.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved entry can be completed (status: %)', v_old.status USING ERRCODE = '55000';
  END IF;
  IF v_old.effective_date > (now() AT TIME ZONE 'utc')::date THEN
    RAISE EXCEPTION 'not_yet_effective' USING ERRCODE = '55000';
  END IF;
  IF v_old.notice_sent_at IS NULL AND v_old.audience <> 'internal' THEN
    RAISE EXCEPTION 'notice_not_recorded: record when the notice was sent first' USING ERRCODE = '55000';
  END IF;
  UPDATE public.change_calendar_entries SET status = 'completed', completed_at = now() WHERE id = p_id RETURNING * INTO v_new;
  PERFORM public.change_calendar_log(p_id, 'completed', v_actor, to_jsonb(v_old), to_jsonb(v_new), NULL);
  RETURN to_jsonb(v_new);
END $$;

CREATE OR REPLACE FUNCTION public.staff_change_calendar_cancel(p_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := public.change_calendar_assert_staff();
  v_old public.change_calendar_entries;
  v_new public.change_calendar_entries;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_note IS NULL OR char_length(v_note) < 3 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'a cancellation needs a reason (3 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_old FROM public.change_calendar_entries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entry not found' USING ERRCODE = 'P0002'; END IF;
  IF v_old.status = 'cancelled' THEN RETURN to_jsonb(v_old); END IF;
  IF v_old.status = 'completed' THEN RAISE EXCEPTION 'a completed entry is final' USING ERRCODE = '55000'; END IF;
  UPDATE public.change_calendar_entries SET status = 'cancelled', cancelled_at = now(), decision_note = v_note WHERE id = p_id RETURNING * INTO v_new;
  PERFORM public.change_calendar_log(p_id, 'cancelled', v_actor, to_jsonb(v_old), to_jsonb(v_new), v_note);
  RETURN to_jsonb(v_new);
END $$;

REVOKE ALL ON FUNCTION public.staff_change_calendar_upsert(jsonb), public.staff_change_calendar_submit(uuid),
  public.staff_change_calendar_decide(uuid, boolean, text), public.staff_change_calendar_mark_notice_sent(uuid),
  public.staff_change_calendar_complete(uuid), public.staff_change_calendar_cancel(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_change_calendar_upsert(jsonb), public.staff_change_calendar_submit(uuid),
  public.staff_change_calendar_decide(uuid, boolean, text), public.staff_change_calendar_mark_notice_sent(uuid),
  public.staff_change_calendar_complete(uuid), public.staff_change_calendar_cancel(uuid, text) TO authenticated;

-- =============================================================
-- 6. Reminder claim (service_role only; used by supabase/functions/change-calendar-tick)
-- =============================================================
-- Atomically claims at most one due reminder per entry. A claim that was never completed (crash) can be re-claimed after
-- 15 minutes; a completed one (sent_at set) is never claimed again.
CREATE OR REPLACE FUNCTION public.change_calendar_claim_reminders(p_today date DEFAULT ((now() AT TIME ZONE 'utc')::date), p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  v_rows integer;
  v_out jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT e.id, e.title, e.category, e.status, e.notice_date, e.effective_date, e.owner_id, k.kind,
           (SELECT p.email FROM public.profiles p WHERE p.id = e.owner_id AND p.is_staff) AS owner_email
      FROM public.change_calendar_entries e
      CROSS JOIN LATERAL (SELECT public.change_calendar_reminder_kind(e.status, e.notice_date, e.effective_date, e.notice_sent_at IS NOT NULL, p_today) AS kind) k
     WHERE k.kind IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.change_calendar_reminder_log l WHERE l.entry_id = e.id AND l.kind = k.kind AND l.sent_at IS NOT NULL)
     ORDER BY e.notice_date, e.id
     LIMIT greatest(1, least(COALESCE(p_limit, 100), 500))
  LOOP
    INSERT INTO public.change_calendar_reminder_log (entry_id, kind) VALUES (r.id, r.kind)
    ON CONFLICT (entry_id, kind) DO UPDATE SET claimed_at = now()
      WHERE change_calendar_reminder_log.sent_at IS NULL AND change_calendar_reminder_log.claimed_at < now() - interval '15 minutes';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'entry_id', r.id, 'kind', r.kind, 'title', r.title, 'category', r.category, 'status', r.status,
        'notice_date', r.notice_date, 'effective_date', r.effective_date, 'owner_email', r.owner_email));
    END IF;
  END LOOP;
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION public.change_calendar_complete_reminder(p_entry uuid, p_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.change_calendar_reminder_log SET sent_at = now() WHERE entry_id = p_entry AND kind = p_kind AND sent_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.change_calendar_release_reminder(p_entry uuid, p_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.change_calendar_reminder_log WHERE entry_id = p_entry AND kind = p_kind AND sent_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.change_calendar_claim_reminders(date, integer), public.change_calendar_complete_reminder(uuid, text),
  public.change_calendar_release_reminder(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_calendar_claim_reminders(date, integer), public.change_calendar_complete_reminder(uuid, text),
  public.change_calendar_release_reminder(uuid, text) TO service_role;

/*
  ROLLBACK (manual; destroys the register and its audit trail):
    drop function if exists public.change_calendar_claim_reminders(date, integer), public.change_calendar_complete_reminder(uuid, text),
      public.change_calendar_release_reminder(uuid, text), public.staff_change_calendar_upsert(jsonb), public.staff_change_calendar_submit(uuid),
      public.staff_change_calendar_decide(uuid, boolean, text), public.staff_change_calendar_mark_notice_sent(uuid),
      public.staff_change_calendar_complete(uuid), public.staff_change_calendar_cancel(uuid, text),
      public.change_calendar_reminder_kind(text, date, date, boolean, date), public.change_calendar_log(uuid, text, uuid, jsonb, jsonb, text),
      public.change_calendar_assert_staff();
    drop table if exists public.change_calendar_reminder_log, public.change_calendar_events, public.change_calendar_entries;
    drop function if exists public.change_calendar_events_append_only(), public.change_calendar_entries_guard();
*/
