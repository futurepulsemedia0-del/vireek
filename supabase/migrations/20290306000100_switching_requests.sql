/*
  # Switching-request workflow (leaving Vireek for another provider)

  A tenant owner/admin files ONE switching request; staff move it through a fixed status path while the
  database records every step and three deadlines. Self-serve export (tenant-export, part=core and
  part=supplement) keeps working at all times: this workflow adds the assisted process, the deadlines and
  the audit trail around it.

  Status path (enforced by switching_transition_allowed(), mirrored in _shared/switching/requests.ts):
    requested -> acknowledged -> exporting -> export_ready -> in_transition -> completed
    any open status -> cancelled (by the tenant) ; requested | acknowledged -> rejected (staff, reason required)

  Deadlines are calendar days from the request, stored per row so a contract can override them later.
  DEFAULTS ARE PLACEHOLDERS [COUNSEL]: acknowledge 3 days, export ready 30 days, retrieval window 30 days
  after completion. See docs/compliance/switching-process.md.

  ## New tables
  - switching_requests        one row per request; tenant reads own, staff read all; writes only via RPC.
  - switching_request_events  append-only step log (no write policies, no UPDATE/DELETE grants).
  ## New functions
  - switching_transition_allowed(from, to)
  - switching_request_create(target_provider, notes) / switching_request_cancel(id, note)   tenant owner/admin
  - switching_request_advance(id, to_status, note) / switching_requests_overdue()            staff only
  Additive and idempotent. Requires profiles.is_staff, public.get_account_owner_id(),
  public.agent_network_is_admin(), public.set_updated_at().
*/

CREATE TABLE IF NOT EXISTS public.switching_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE
    DEFAULT ('SW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by uuid DEFAULT auth.uid(),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'acknowledged', 'exporting', 'export_ready', 'in_transition', 'completed', 'cancelled', 'rejected')),
  target_provider text CHECK (target_provider IS NULL OR char_length(target_provider) <= 120),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  staff_note text CHECK (staff_note IS NULL OR char_length(staff_note) <= 1000),
  ack_days integer NOT NULL DEFAULT 3 CHECK (ack_days BETWEEN 1 AND 60),
  export_days integer NOT NULL DEFAULT 30 CHECK (export_days BETWEEN 1 AND 180),
  retrieval_days integer NOT NULL DEFAULT 30 CHECK (retrieval_days BETWEEN 0 AND 365),
  requested_at timestamptz NOT NULL DEFAULT now(),
  acknowledge_due_at timestamptz,
  export_due_at timestamptz,
  acknowledged_at timestamptz,
  export_ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  retrieval_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Deadlines derive from requested_at and the per-row day counts unless explicitly set.
CREATE OR REPLACE FUNCTION public.switching_requests_set_deadlines()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.acknowledge_due_at := COALESCE(NEW.acknowledge_due_at, NEW.requested_at + make_interval(days => NEW.ack_days));
    NEW.export_due_at := COALESCE(NEW.export_due_at, NEW.requested_at + make_interval(days => NEW.export_days));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_switching_requests_deadlines ON public.switching_requests;
CREATE TRIGGER trg_switching_requests_deadlines
  BEFORE INSERT ON public.switching_requests
  FOR EACH ROW EXECUTE FUNCTION public.switching_requests_set_deadlines();

DROP TRIGGER IF EXISTS trg_switching_requests_updated ON public.switching_requests;
CREATE TRIGGER trg_switching_requests_updated
  BEFORE UPDATE ON public.switching_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One open request per account.
CREATE UNIQUE INDEX IF NOT EXISTS switching_requests_one_open_idx
  ON public.switching_requests (user_id)
  WHERE status IN ('requested', 'acknowledged', 'exporting', 'export_ready', 'in_transition');
CREATE INDEX IF NOT EXISTS switching_requests_due_idx
  ON public.switching_requests (status, acknowledge_due_at, export_due_at);

CREATE TABLE IF NOT EXISTS public.switching_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.switching_requests(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('tenant', 'staff')),
  from_status text,
  to_status text NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS switching_request_events_req_idx ON public.switching_request_events (request_id, created_at);

ALTER TABLE public.switching_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.switching_request_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_select_switching_requests" ON public.switching_requests;
CREATE POLICY "tenant_select_switching_requests" ON public.switching_requests FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_select_switching_requests" ON public.switching_requests;
CREATE POLICY "staff_select_switching_requests" ON public.switching_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

DROP POLICY IF EXISTS "tenant_select_switching_events" ON public.switching_request_events;
CREATE POLICY "tenant_select_switching_events" ON public.switching_request_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.switching_requests r WHERE r.id = request_id AND r.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS "staff_select_switching_events" ON public.switching_request_events;
CREATE POLICY "staff_select_switching_events" ON public.switching_request_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

-- No INSERT/UPDATE/DELETE policies: all writes go through the SECURITY DEFINER functions below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.switching_requests, public.switching_request_events FROM anon, authenticated;

-- ---------------------------------------------------------------- transitions
-- Keep each WHEN line in this exact shape: the unit test parses it to prove TypeScript and SQL agree.
CREATE OR REPLACE FUNCTION public.switching_transition_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = 'requested' AND p_to IN ('acknowledged', 'rejected', 'cancelled') THEN true
    WHEN p_from = 'acknowledged' AND p_to IN ('exporting', 'rejected', 'cancelled') THEN true
    WHEN p_from = 'exporting' AND p_to IN ('export_ready', 'cancelled') THEN true
    WHEN p_from = 'export_ready' AND p_to IN ('in_transition', 'completed', 'cancelled') THEN true
    WHEN p_from = 'in_transition' AND p_to IN ('completed', 'cancelled') THEN true
    ELSE false
  END;
$$;

-- ---------------------------------------------------------------- tenant: create / cancel
CREATE OR REPLACE FUNCTION public.switching_request_create(p_target_provider text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT COALESCE(public.agent_network_is_admin(), false) THEN
    RAISE EXCEPTION 'SWITCHING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.switching_requests (user_id, requested_by, target_provider, notes)
    VALUES (v_owner, auth.uid(), NULLIF(btrim(left(coalesce(p_target_provider, ''), 120)), ''), NULLIF(btrim(left(coalesce(p_notes, ''), 2000)), ''))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'SWITCHING_ALREADY_OPEN' USING ERRCODE = 'P0001';
  END;
  INSERT INTO public.switching_request_events (request_id, actor_id, actor_kind, from_status, to_status, note)
  VALUES (v_id, auth.uid(), 'tenant', NULL, 'requested', NULL);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.switching_request_create(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switching_request_create(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.switching_request_cancel(p_id uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r public.switching_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT COALESCE(public.agent_network_is_admin(), false) THEN
    RAISE EXCEPTION 'SWITCHING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.switching_requests WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR NOT public.switching_transition_allowed(r.status, 'cancelled') THEN RETURN false; END IF;
  UPDATE public.switching_requests SET status = 'cancelled', cancelled_at = now() WHERE id = r.id;
  INSERT INTO public.switching_request_events (request_id, actor_id, actor_kind, from_status, to_status, note)
  VALUES (r.id, auth.uid(), 'tenant', r.status, 'cancelled', left(btrim(coalesce(p_note, '')), 1000));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.switching_request_cancel(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switching_request_cancel(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- staff: advance / overdue
CREATE OR REPLACE FUNCTION public.switching_request_advance(p_id uuid, p_to text, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.switching_requests%ROWTYPE;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff) THEN
    RAISE EXCEPTION 'SWITCHING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Tenants cancel through switching_request_cancel; staff move the request forward or reject it.
  IF p_to = 'cancelled' THEN RAISE EXCEPTION 'SWITCHING_USE_CANCEL' USING ERRCODE = 'P0001'; END IF;
  IF p_to = 'rejected' AND char_length(v_note) < 10 THEN
    RAISE EXCEPTION 'SWITCHING_REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM public.switching_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT public.switching_transition_allowed(r.status, p_to) THEN
    RAISE EXCEPTION 'SWITCHING_BAD_TRANSITION: % -> %', r.status, p_to USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.switching_requests SET
    status = p_to,
    staff_note = CASE WHEN v_note <> '' THEN v_note ELSE staff_note END,
    acknowledged_at = CASE WHEN p_to = 'acknowledged' THEN now() ELSE acknowledged_at END,
    export_ready_at = CASE WHEN p_to = 'export_ready' THEN now() ELSE export_ready_at END,
    completed_at = CASE WHEN p_to = 'completed' THEN now() ELSE completed_at END,
    retrieval_ends_at = CASE WHEN p_to = 'completed' THEN now() + make_interval(days => retrieval_days) ELSE retrieval_ends_at END
  WHERE id = r.id;
  INSERT INTO public.switching_request_events (request_id, actor_id, actor_kind, from_status, to_status, note)
  VALUES (r.id, auth.uid(), 'staff', r.status, p_to, NULLIF(v_note, ''));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.switching_request_advance(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switching_request_advance(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.switching_requests_overdue()
RETURNS TABLE (id uuid, reference text, user_id uuid, status text, due_kind text, due_at timestamptz, days_overdue integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff) THEN
    RAISE EXCEPTION 'SWITCHING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT s.id, s.reference, s.user_id, s.status, 'acknowledge'::text, s.acknowledge_due_at,
           GREATEST(0, floor(extract(epoch FROM (now() - s.acknowledge_due_at)) / 86400))::integer
      FROM public.switching_requests s
     WHERE s.status = 'requested' AND s.acknowledge_due_at < now()
    UNION ALL
    SELECT s.id, s.reference, s.user_id, s.status, 'export'::text, s.export_due_at,
           GREATEST(0, floor(extract(epoch FROM (now() - s.export_due_at)) / 86400))::integer
      FROM public.switching_requests s
     WHERE s.status IN ('acknowledged', 'exporting') AND s.export_due_at < now()
    ORDER BY 6;
END;
$$;
REVOKE ALL ON FUNCTION public.switching_requests_overdue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switching_requests_overdue() TO authenticated;
