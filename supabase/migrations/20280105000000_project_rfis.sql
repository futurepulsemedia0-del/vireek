/*
  # Project RFIs — requests for information, with change orders

  Purely additive on top of Install Projects (no existing table is changed):
  - install_project_rfis: question, to/from (direction + party), due date, status,
    answer, optional phase and linked change order, cost/schedule impact flags.
    Lifecycle is enforced in the database: draft -> open -> answered -> closed,
    reopen, or void. "Overdue" is derived (open + due_date in the past), never stored.
  - install_project_rfi_attachments: files on the private `project-rfi-files` bucket.
  - install_project_change_orders: minimal change orders an RFI can be linked to.
  - install_project_counters: per-project RFI-001 / CO-001 numbering (race-free).
  - Notifications REUSE the existing `notifications` table (type 'job_update', so the
    bell, the page and the notify_job_update preference keep working unchanged).
  - rfi_run_overdue_sweep(): notifies once per overdue RFI (hourly pg_cron if available).
  Access: same rule as Install Projects (can_manage_install_projects()), account-scoped,
  owner forced by the existing install_projects_force_owner() trigger.
*/

-- =============================================================
-- COUNTERS (only SECURITY DEFINER code touches this table)
-- =============================================================

CREATE TABLE IF NOT EXISTS install_project_counters (
  project_id uuid PRIMARY KEY REFERENCES install_projects(id) ON DELETE CASCADE,
  rfi_seq integer NOT NULL DEFAULT 0,
  change_order_seq integer NOT NULL DEFAULT 0
);
ALTER TABLE install_project_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON install_project_counters FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.install_next_number(p_project uuid, p_kind text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF p_kind = 'rfi' THEN
    INSERT INTO install_project_counters AS c (project_id, rfi_seq) VALUES (p_project, 1)
    ON CONFLICT (project_id) DO UPDATE SET rfi_seq = c.rfi_seq + 1
    RETURNING c.rfi_seq INTO v;
  ELSIF p_kind = 'change_order' THEN
    INSERT INTO install_project_counters AS c (project_id, change_order_seq) VALUES (p_project, 1)
    ON CONFLICT (project_id) DO UPDATE SET change_order_seq = c.change_order_seq + 1
    RETURNING c.change_order_seq INTO v;
  ELSE
    RAISE EXCEPTION 'invalid_counter';
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.install_next_number(uuid, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS install_project_change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  co_number text NOT NULL DEFAULT '',
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 5000),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents BETWEEN -100000000000 AND 100000000000),
  schedule_days integer NOT NULL DEFAULT 0 CHECK (schedule_days BETWEEN -365 AND 3650),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'void')),
  decided_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_install_cos_number ON install_project_change_orders(project_id, co_number);
CREATE INDEX IF NOT EXISTS idx_install_cos_project ON install_project_change_orders(project_id, status);

CREATE TABLE IF NOT EXISTS install_project_rfis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES install_project_phases(id) ON DELETE SET NULL,
  change_order_id uuid REFERENCES install_project_change_orders(id) ON DELETE SET NULL,
  rfi_number text NOT NULL DEFAULT '',
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 160),
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 5000),
  direction text NOT NULL DEFAULT 'outgoing' CHECK (direction IN ('outgoing', 'incoming')),
  party_name text NOT NULL CHECK (length(btrim(party_name)) BETWEEN 1 AND 120),
  party_role text NOT NULL DEFAULT 'other'
    CHECK (party_role IN ('customer', 'general_contractor', 'architect', 'engineer', 'inspector', 'supplier', 'subcontractor', 'other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'answered', 'closed', 'void')),
  due_date date,
  impacts_cost boolean NOT NULL DEFAULT false,
  impacts_schedule boolean NOT NULL DEFAULT false,
  answer text CHECK (answer IS NULL OR length(answer) <= 5000),
  answered_at timestamptz,
  answered_by uuid,
  sent_at timestamptz,
  closed_at timestamptz,
  overdue_notified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_install_rfis_number ON install_project_rfis(project_id, rfi_number);
CREATE INDEX IF NOT EXISTS idx_install_rfis_project ON install_project_rfis(project_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_install_rfis_change_order ON install_project_rfis(change_order_id) WHERE change_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_rfis_overdue_scan ON install_project_rfis(due_date) WHERE status = 'open' AND overdue_notified_at IS NULL;

CREATE TABLE IF NOT EXISTS install_project_rfi_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES install_projects(id) ON DELETE CASCADE,
  rfi_id uuid NOT NULL REFERENCES install_project_rfis(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'answer')),
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
  storage_path text NOT NULL UNIQUE,
  mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_install_rfi_files_rfi ON install_project_rfi_attachments(rfi_id);

-- =============================================================
-- LIFECYCLE RULES
-- =============================================================

CREATE OR REPLACE FUNCTION public.rfi_status_transition_ok(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT p_from = p_to OR (p_from, p_to) IN (
    ('draft', 'open'), ('draft', 'void'),
    ('open', 'answered'), ('open', 'void'),
    ('answered', 'closed'), ('answered', 'open'), ('answered', 'void'),
    ('closed', 'open')
  );
$$;

CREATE OR REPLACE FUNCTION public.change_order_status_transition_ok(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT p_from = p_to OR (p_from, p_to) IN (
    ('draft', 'pending'), ('draft', 'void'),
    ('pending', 'approved'), ('pending', 'rejected'), ('pending', 'draft'), ('pending', 'void'),
    ('rejected', 'draft'), ('rejected', 'void'),
    ('approved', 'void')
  );
$$;

CREATE OR REPLACE FUNCTION public.rfi_enforce_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_status text;
  v_content_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_project_status FROM install_projects WHERE id = NEW.project_id;
    IF v_project_status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
    IF NEW.status NOT IN ('draft', 'open') THEN RAISE EXCEPTION 'invalid_rfi_status'; END IF;
    NEW.rfi_number := 'RFI-' || lpad(public.install_next_number(NEW.project_id, 'rfi')::text, 3, '0');
    NEW.created_by := auth.uid();
    NEW.answered_at := NULL;
    NEW.answered_by := NULL;
    NEW.closed_at := NULL;
    NEW.overdue_notified_at := NULL;
    NEW.sent_at := CASE WHEN NEW.status = 'open' THEN now() ELSE NULL END;
  ELSE
    IF NEW.rfi_number IS DISTINCT FROM OLD.rfi_number THEN RAISE EXCEPTION 'immutable_number'; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT public.rfi_status_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'invalid_rfi_transition';
    END IF;

    v_content_changed := ROW(NEW.subject, NEW.question, NEW.direction, NEW.party_name, NEW.party_role, NEW.priority,
                             NEW.due_date, NEW.impacts_cost, NEW.impacts_schedule, NEW.phase_id)
                         IS DISTINCT FROM
                         ROW(OLD.subject, OLD.question, OLD.direction, OLD.party_name, OLD.party_role, OLD.priority,
                             OLD.due_date, OLD.impacts_cost, OLD.impacts_schedule, OLD.phase_id);
    IF NEW.status = OLD.status THEN
      IF OLD.status IN ('answered', 'closed', 'void') AND v_content_changed THEN RAISE EXCEPTION 'rfi_locked'; END IF;
      IF OLD.status IN ('closed', 'void')
         AND (NEW.answer IS DISTINCT FROM OLD.answer OR NEW.change_order_id IS DISTINCT FROM OLD.change_order_id) THEN
        RAISE EXCEPTION 'rfi_locked';
      END IF;
    ELSE
      IF NEW.status = 'open' THEN
        NEW.sent_at := COALESCE(OLD.sent_at, now());
        NEW.answered_at := NULL;
        NEW.answered_by := NULL;
        NEW.closed_at := NULL;
        NEW.overdue_notified_at := NULL;
      ELSIF NEW.status = 'answered' THEN
        IF NEW.answer IS NULL OR btrim(NEW.answer) = '' THEN RAISE EXCEPTION 'answer_required'; END IF;
        NEW.answer := btrim(NEW.answer);
        NEW.answered_at := now();
        NEW.answered_by := auth.uid();
        NEW.closed_at := NULL;
      ELSIF NEW.status = 'closed' THEN
        NEW.closed_at := now();
      END IF;
    END IF;
    IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN NEW.overdue_notified_at := NULL; END IF;
  END IF;

  IF NEW.change_order_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.change_order_id IS DISTINCT FROM OLD.change_order_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM install_project_change_orders
       WHERE id = NEW.change_order_id AND project_id = NEW.project_id AND user_id = NEW.user_id AND status <> 'void') THEN
      RAISE EXCEPTION 'invalid_change_order';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.change_order_enforce_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_project_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_project_status FROM install_projects WHERE id = NEW.project_id;
    IF v_project_status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
    IF NEW.status NOT IN ('draft', 'pending') THEN RAISE EXCEPTION 'invalid_change_order_status'; END IF;
    NEW.co_number := 'CO-' || lpad(public.install_next_number(NEW.project_id, 'change_order')::text, 3, '0');
    NEW.created_by := auth.uid();
    NEW.decided_at := NULL;
  ELSE
    IF NEW.co_number IS DISTINCT FROM OLD.co_number THEN RAISE EXCEPTION 'immutable_number'; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT public.change_order_status_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'invalid_change_order_transition';
    END IF;
    IF NEW.status = OLD.status AND OLD.status IN ('approved', 'rejected', 'void')
       AND ROW(NEW.title, NEW.description, NEW.amount_cents, NEW.schedule_days)
           IS DISTINCT FROM ROW(OLD.title, OLD.description, OLD.amount_cents, OLD.schedule_days) THEN
      RAISE EXCEPTION 'change_order_locked';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status IN ('approved', 'rejected') THEN NEW.decided_at := now();
      ELSIF NEW.status IN ('draft', 'pending') THEN NEW.decided_at := NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.rfi_attachment_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r_status text;
  v_prefix text;
  v_count integer;
BEGIN
  SELECT status INTO r_status FROM install_project_rfis
   WHERE id = NEW.rfi_id AND project_id = NEW.project_id AND user_id = NEW.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_rfi'; END IF;
  IF r_status IN ('closed', 'void') THEN RAISE EXCEPTION 'rfi_locked'; END IF;
  v_prefix := NEW.user_id::text || '/' || NEW.project_id::text || '/' || NEW.rfi_id::text || '/';
  IF left(NEW.storage_path, length(v_prefix)) <> v_prefix THEN RAISE EXCEPTION 'invalid_attachment_path'; END IF;
  SELECT count(*) INTO v_count FROM install_project_rfi_attachments WHERE rfi_id = NEW.rfi_id;
  IF v_count >= 20 THEN RAISE EXCEPTION 'too_many_attachments'; END IF;
  NEW.created_by := auth.uid();
  RETURN NEW;
END $$;

-- Reuses the Install Projects notification channel; never blocks the write.
CREATE OR REPLACE FUNCTION public.rfi_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_notify boolean;
  v_proj text;
  v_title text;
  v_msg text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'answered' THEN
    v_title := 'RFI answered: ' || NEW.rfi_number || ' · ' || left(NEW.subject, 80);
  ELSIF NEW.status = 'open' AND NEW.direction = 'incoming' THEN
    v_title := 'RFI needs your response: ' || NEW.rfi_number || ' · ' || left(NEW.subject, 80);
  ELSE
    RETURN NEW;
  END IF;
  SELECT COALESCE(project_number || ' · ', '') || name INTO v_proj FROM install_projects WHERE id = NEW.project_id;
  v_msg := v_proj || ' — ' || CASE WHEN NEW.direction = 'incoming' THEN 'from ' ELSE 'to ' END || NEW.party_name
        || CASE WHEN NEW.status = 'open' AND NEW.due_date IS NOT NULL THEN '. Due ' || to_char(NEW.due_date, 'YYYY-MM-DD') || '.' ELSE '.' END;
  SELECT notify_job_update INTO v_notify FROM profiles WHERE id = NEW.user_id;
  IF COALESCE(v_notify, true) THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (NEW.user_id, 'job_update', v_title, v_msg, '/dashboard/projects/' || NEW.project_id || '?tab=rfis&rfi=' || NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'rfi_notify skipped for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

DO $$
BEGIN
  -- Same shared triggers as every other Install Projects table.
  DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_project_rfis;
  CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_project_rfis FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
  DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_project_rfis;
  CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_project_rfis FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
  DROP TRIGGER IF EXISTS trg_ip_03_stamp ON install_project_rfis;
  CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON install_project_rfis FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp();
  DROP TRIGGER IF EXISTS trg_rfi_04_rules ON install_project_rfis;
  CREATE TRIGGER trg_rfi_04_rules BEFORE INSERT OR UPDATE ON install_project_rfis FOR EACH ROW EXECUTE FUNCTION public.rfi_enforce_rules();
  DROP TRIGGER IF EXISTS trg_rfi_05_notify ON install_project_rfis;
  CREATE TRIGGER trg_rfi_05_notify AFTER INSERT OR UPDATE OF status ON install_project_rfis FOR EACH ROW EXECUTE FUNCTION public.rfi_notify();

  DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_project_change_orders;
  CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_project_change_orders FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
  DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_project_change_orders;
  CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_project_change_orders FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
  DROP TRIGGER IF EXISTS trg_ip_03_stamp ON install_project_change_orders;
  CREATE TRIGGER trg_ip_03_stamp BEFORE INSERT OR UPDATE ON install_project_change_orders FOR EACH ROW EXECUTE FUNCTION public.install_projects_stamp();
  DROP TRIGGER IF EXISTS trg_co_04_rules ON install_project_change_orders;
  CREATE TRIGGER trg_co_04_rules BEFORE INSERT OR UPDATE ON install_project_change_orders FOR EACH ROW EXECUTE FUNCTION public.change_order_enforce_rules();

  DROP TRIGGER IF EXISTS trg_ip_01_owner ON install_project_rfi_attachments;
  CREATE TRIGGER trg_ip_01_owner BEFORE INSERT ON install_project_rfi_attachments FOR EACH ROW EXECUTE FUNCTION public.install_projects_force_owner();
  DROP TRIGGER IF EXISTS trg_ip_02_validate ON install_project_rfi_attachments;
  CREATE TRIGGER trg_ip_02_validate BEFORE INSERT OR UPDATE ON install_project_rfi_attachments FOR EACH ROW EXECUTE FUNCTION public.install_projects_validate_child();
  DROP TRIGGER IF EXISTS trg_rfi_04_rules ON install_project_rfi_attachments;
  CREATE TRIGGER trg_rfi_04_rules BEFORE INSERT ON install_project_rfi_attachments FOR EACH ROW EXECUTE FUNCTION public.rfi_attachment_rules();
END $$;

-- =============================================================
-- ROW LEVEL SECURITY — account-scoped + billing permission
-- (RFIs, change orders and attachments are records: delete only while unused.)
-- =============================================================

DO $$
DECLARE
  t text;
  scope text := 'user_id = public.get_account_owner_id() AND public.can_manage_install_projects()';
  del text;
BEGIN
  FOREACH t IN ARRAY ARRAY['install_project_rfis', 'install_project_change_orders', 'install_project_rfi_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (%s)', t || '_select', t, scope);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (%s)', t || '_insert', t, scope);
    IF t <> 'install_project_rfi_attachments' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', t || '_update', t, scope, scope);
    END IF;
    del := CASE t
      WHEN 'install_project_rfis' THEN scope || ' AND status IN (''draft'', ''void'')'
      WHEN 'install_project_change_orders' THEN scope || ' AND status IN (''draft'', ''rejected'', ''void'')'
      ELSE scope || ' AND EXISTS (SELECT 1 FROM install_project_rfis r WHERE r.id = rfi_id AND r.status NOT IN (''closed'', ''void''))'
    END;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (%s)', t || '_delete', t, del);
  END LOOP;
END $$;

-- =============================================================
-- STORAGE: private bucket, first folder = account owner id
--   Path: <owner_id>/<project_id>/<rfi_id>/<uuid>-<safe_name>
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-rfi-files', 'project-rfi-files', false, 26214400, -- 25 MB
  ARRAY[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "project_rfi_files_select" ON storage.objects;
CREATE POLICY "project_rfi_files_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'project-rfi-files' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
         AND public.can_manage_install_projects());

DROP POLICY IF EXISTS "project_rfi_files_insert" ON storage.objects;
CREATE POLICY "project_rfi_files_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'project-rfi-files' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
              AND public.can_manage_install_projects());

DROP POLICY IF EXISTS "project_rfi_files_delete" ON storage.objects;
CREATE POLICY "project_rfi_files_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'project-rfi-files' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
         AND public.can_manage_install_projects());

-- =============================================================
-- OVERDUE SWEEP — one notification per overdue RFI (until its due date or status changes)
-- =============================================================

CREATE OR REPLACE FUNCTION public.rfi_run_overdue_sweep(p_user_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_count integer := 0;
  v_notify boolean;
  v_days integer;
BEGIN
  FOR r IN
    SELECT f.id, f.user_id, f.project_id, f.rfi_number, f.subject, f.party_name, f.direction, f.due_date,
           COALESCE(p.project_number || ' · ', '') || p.name AS project_label
      FROM install_project_rfis f
      JOIN install_projects p ON p.id = f.project_id
     WHERE f.status = 'open'
       AND f.due_date IS NOT NULL
       AND f.due_date < current_date
       AND f.overdue_notified_at IS NULL
       AND (p_user_id IS NULL OR f.user_id = p_user_id)
     ORDER BY f.due_date
     LIMIT 500
  LOOP
    BEGIN
      UPDATE install_project_rfis SET overdue_notified_at = now() WHERE id = r.id AND overdue_notified_at IS NULL;
      IF FOUND THEN
        v_days := current_date - r.due_date;
        SELECT notify_job_update INTO v_notify FROM profiles WHERE id = r.user_id;
        IF COALESCE(v_notify, true) THEN
          INSERT INTO notifications (user_id, type, title, message, action_url)
          VALUES (
            r.user_id, 'job_update',
            'RFI overdue: ' || r.rfi_number || ' · ' || left(r.subject, 80),
            r.project_label || ' — ' || CASE WHEN r.direction = 'incoming' THEN 'response owed to ' ELSE 'waiting on ' END
              || r.party_name || ', ' || v_days || ' day' || CASE WHEN v_days = 1 THEN '' ELSE 's' END || ' past due.',
            '/dashboard/projects/' || r.project_id || '?tab=rfis&rfi=' || r.id);
        END IF;
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'rfi overdue sweep skipped %: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.rfi_run_overdue_sweep(uuid) FROM PUBLIC, anon, authenticated;

-- Owner/office "run now" for their own account (called when the RFIs tab opens).
CREATE OR REPLACE FUNCTION public.rfi_refresh_overdue()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_install_projects() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN public.rfi_run_overdue_sweep(v_owner);
END $$;
REVOKE ALL ON FUNCTION public.rfi_refresh_overdue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfi_refresh_overdue() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-rfi-overdue-sweep');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-rfi-overdue-sweep', '5 * * * *', 'select public.rfi_run_overdue_sweep()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

COMMENT ON TABLE install_project_rfis IS 'Project RFIs. Overdue = status open and due_date in the past (derived, never stored).';
COMMENT ON TABLE install_project_change_orders IS 'Minimal change orders an RFI can be linked to. Does not alter the contract value.';
