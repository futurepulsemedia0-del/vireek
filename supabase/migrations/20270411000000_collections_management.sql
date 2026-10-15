/*
  # Collections — AR aging, dunning sequences, promise-to-pay, escalation

  ## Scope
  Works only on ledger invoices (ar_invoices / ar_payments from
  20261203000001_accounting_general_ledger.sql). It never touches the legacy
  `invoices` / `payment_requests` tables and never posts journal entries.

  ## Model
  - collection_sequences / collection_sequence_steps: per-account dunning
    playbooks (e.g. "-3d email, +7d SMS, +14d call, +30d escalate L1").
  - invoice_collection_state: per-invoice hold flag and escalation level.
  - collection_actions: the work queue. run_collections_cycle() turns steps
    that have come due into PENDING actions with the message already
    rendered. Staff send/do them and mark them done. If an invoice is first
    seen late (e.g. 60 days overdue) only its LATEST due step becomes
    pending; earlier ones are recorded as skipped so a customer is never hit
    with a backlog of reminders at once.
  - collection_promises: promise-to-pay. One OPEN promise per invoice; a new
    one supersedes the old. The cycle marks a promise KEPT when payments
    recorded after it cover the promised amount (or the invoice is settled)
    and BROKEN when the date passes unpaid — a broken promise escalates the
    invoice to level 1 automatically.

  ## What this does NOT do
  It does not send email/SMS by itself. Delivery stays with the existing
  compliant channels (inbox email-send / sms-send); this module prepares the
  exact message and tracks the outcome.

  ## Access
  Owner, or team member with can_view_billing (same rule as receivables
  intelligence). Every write goes through a SECURITY DEFINER RPC scoped by
  get_account_owner_id(); tables are SELECT-only for clients.
*/

-- =============================================================
-- ACCESS HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_collections()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_collections() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_collections() TO authenticated;

CREATE OR REPLACE FUNCTION public._col_require_manager()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_collections() THEN
    RAISE EXCEPTION 'You do not have permission to manage collections' USING ERRCODE = '42501';
  END IF;
  v_user := public.get_account_owner_id();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No account found for this user' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public._col_require_manager() FROM PUBLIC, anon, authenticated;

-- Template renderer. Unknown {{tokens}} are left as-is.
CREATE OR REPLACE FUNCTION public._col_render(
  p_tpl text, p_name text, p_invoice text, p_balance_cents integer,
  p_due date, p_days_overdue integer, p_company text
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT replace(replace(replace(replace(replace(replace(
    COALESCE(p_tpl, ''),
    '{{customer_name}}', COALESCE(p_name, 'there')),
    '{{invoice_number}}', COALESCE(p_invoice, '')),
    '{{balance}}', '$' || to_char(COALESCE(p_balance_cents, 0) / 100.0, 'FM999,999,999,990.00')),
    '{{due_date}}', to_char(p_due, 'Mon DD, YYYY')),
    '{{days_overdue}}', GREATEST(COALESCE(p_days_overdue, 0), 0)::text),
    '{{company_name}}', COALESCE(NULLIF(btrim(p_company), ''), 'our team'));
$$;

REVOKE ALL ON FUNCTION public._col_render(text, text, text, integer, date, integer, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS collection_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_sequences_name ON collection_sequences (user_id, (lower(btrim(name))));
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_sequences_default ON collection_sequences (user_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS collection_sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id uuid NOT NULL REFERENCES collection_sequences(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order >= 1),
  days_after_due integer NOT NULL CHECK (days_after_due BETWEEN -30 AND 365),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'call', 'letter', 'escalate')),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 120),
  template text NOT NULL DEFAULT '' CHECK (char_length(template) <= 1000),
  escalation_level smallint CHECK (escalation_level IS NULL OR escalation_level BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((channel = 'escalate') = (escalation_level IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_collection_steps_seq ON collection_sequence_steps (sequence_id, step_order);

CREATE TABLE IF NOT EXISTS invoice_collection_state (
  invoice_id uuid PRIMARY KEY REFERENCES ar_invoices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  sequence_id uuid REFERENCES collection_sequences(id) ON DELETE SET NULL,
  on_hold boolean NOT NULL DEFAULT false,
  hold_reason text CHECK (hold_reason IS NULL OR char_length(hold_reason) <= 200),
  escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_collection_state_user ON invoice_collection_state (user_id);

CREATE TABLE IF NOT EXISTS collection_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE,
  step_id uuid REFERENCES collection_sequence_steps(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'call', 'letter', 'escalate', 'note')),
  escalation_level smallint CHECK (escalation_level IS NULL OR escalation_level BETWEEN 1 AND 3),
  due_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  subject text,
  body text,
  outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 300),
  created_by uuid,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_actions_step ON collection_actions (invoice_id, step_id) WHERE step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collection_actions_queue ON collection_actions (user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_collection_actions_invoice ON collection_actions (invoice_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collection_promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE,
  promised_amount_cents integer NOT NULL CHECK (promised_amount_cents > 0),
  promised_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'broken', 'cancelled')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_promises_open ON collection_promises (invoice_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_collection_promises_user ON collection_promises (user_id, status, promised_date);

-- RLS: read-only for clients, scoped to the account owner + permission.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['collection_sequences', 'collection_sequence_steps', 'invoice_collection_state', 'collection_actions', 'collection_promises']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'select_own_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.can_manage_collections())',
      'select_own_' || t, t
    );
  END LOOP;
END $$;

-- Internal: append a completed note to an invoice's timeline.
CREATE OR REPLACE FUNCTION public._col_note(p_user uuid, p_invoice uuid, p_subject text, p_outcome text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO collection_actions (user_id, invoice_id, channel, due_date, status, subject, outcome, created_by, completed_by, completed_at)
  VALUES (p_user, p_invoice, 'note', current_date, 'done', p_subject, left(p_outcome, 300), auth.uid(), auth.uid(), now());
$$;

REVOKE ALL ON FUNCTION public._col_note(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- SEQUENCES
-- =============================================================

CREATE OR REPLACE FUNCTION public.ensure_default_collection_sequence()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_id uuid;
BEGIN
  v_user := public._col_require_manager();

  SELECT id INTO v_id FROM collection_sequences WHERE user_id = v_user ORDER BY is_default DESC, created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO collection_sequences (user_id, name, is_default) VALUES (v_user, 'Standard home-service sequence', true) RETURNING id INTO v_id;

  INSERT INTO collection_sequence_steps (sequence_id, user_id, step_order, days_after_due, channel, subject, template, escalation_level) VALUES
    (v_id, v_user, 1, -3, 'email', 'Invoice {{invoice_number}} is due soon',
      'Hi {{customer_name}}, a friendly reminder that invoice {{invoice_number}} for {{balance}} is due on {{due_date}}. Thank you for choosing {{company_name}}.', NULL),
    (v_id, v_user, 2, 1, 'email', 'Invoice {{invoice_number}} is past due',
      'Hi {{customer_name}}, invoice {{invoice_number}} for {{balance}} was due on {{due_date}}. If you have already paid, thank you and please disregard this note. Otherwise we would appreciate payment today. — {{company_name}}', NULL),
    (v_id, v_user, 3, 7, 'sms', NULL,
      '{{company_name}}: invoice {{invoice_number}} ({{balance}}) is {{days_overdue}} days past due. Please reply or call us to arrange payment.', NULL),
    (v_id, v_user, 4, 14, 'call', 'Collections call',
      'Call {{customer_name}} about invoice {{invoice_number}} ({{balance}}, {{days_overdue}} days overdue). Ask for a payment date and record a promise to pay.', NULL),
    (v_id, v_user, 5, 21, 'email', 'Second notice: invoice {{invoice_number}}',
      'Hi {{customer_name}}, invoice {{invoice_number}} for {{balance}} is now {{days_overdue}} days past due. Please pay today or contact us so we can arrange a plan. — {{company_name}}', NULL),
    (v_id, v_user, 6, 30, 'escalate', 'Manager review',
      'Manager review: {{customer_name}} owes {{balance}} on invoice {{invoice_number}}, {{days_overdue}} days overdue.', 1),
    (v_id, v_user, 7, 45, 'letter', 'Final notice',
      'Final notice: invoice {{invoice_number}} for {{balance}} is {{days_overdue}} days past due. Payment is required within 10 days to avoid further collection action. — {{company_name}}', NULL),
    (v_id, v_user, 8, 60, 'escalate', 'Final demand',
      'Send a final demand to {{customer_name}} for {{balance}} (invoice {{invoice_number}}, {{days_overdue}} days overdue).', 2),
    (v_id, v_user, 9, 90, 'escalate', 'External collections review',
      'Decide on external collections or legal action for {{customer_name}}: {{balance}} on invoice {{invoice_number}}, {{days_overdue}} days overdue.', 3);

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_default_collection_sequence() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_default_collection_sequence() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_collection_sequences()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._col_require_manager();

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', q.id, 'name', q.name, 'is_default', q.is_default, 'is_active', q.is_active,
      'steps', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', s.id, 'days_after_due', s.days_after_due, 'channel', s.channel,
          'subject', s.subject, 'template', s.template, 'escalation_level', s.escalation_level
        ) ORDER BY s.step_order)
        FROM collection_sequence_steps s WHERE s.sequence_id = q.id
      ), '[]'::jsonb)
    ) ORDER BY q.is_default DESC, q.name)
    FROM collection_sequences q WHERE q.user_id = v_user
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_collection_sequences() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collection_sequences() TO authenticated;

-- Create (p_id NULL) or update a sequence together with its steps.
-- Steps passed with an existing id keep their identity, so already-generated
-- actions are never duplicated by an edit.
CREATE OR REPLACE FUNCTION public.save_collection_sequence(
  p_id uuid, p_name text, p_is_default boolean, p_is_active boolean, p_steps jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_id uuid := p_id;
  v_name text := btrim(p_name);
  v_default boolean := COALESCE(p_is_default, false);
  v_active boolean := COALESCE(p_is_active, true);
  v_step jsonb;
  v_count integer;
  v_ids uuid[];
  v_known integer;
  v_was_default boolean := false;
BEGIN
  v_user := public._col_require_manager();

  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Sequence name is required (max 80 characters)';
  END IF;
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'Steps must be a list';
  END IF;
  v_count := jsonb_array_length(p_steps);
  IF v_count NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'A sequence needs between 1 and 12 steps';
  END IF;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_steps) LOOP
    IF CASE WHEN (v_step ->> 'days_after_due') ~ '^-?[0-9]{1,3}$'
            THEN (v_step ->> 'days_after_due')::integer NOT BETWEEN -30 AND 365
            ELSE true END THEN
      RAISE EXCEPTION 'Each step needs a timing between 30 days before and 365 days after the due date';
    END IF;
    IF COALESCE(v_step ->> 'channel', '') NOT IN ('email', 'sms', 'call', 'letter', 'escalate') THEN
      RAISE EXCEPTION 'Each step needs a valid channel';
    END IF;
    IF char_length(COALESCE(v_step ->> 'template', '')) > 1000 THEN
      RAISE EXCEPTION 'Step messages are limited to 1000 characters';
    END IF;
    IF char_length(COALESCE(v_step ->> 'subject', '')) > 120 THEN
      RAISE EXCEPTION 'Step subjects are limited to 120 characters';
    END IF;
    IF v_step ->> 'channel' = 'escalate' AND COALESCE(v_step ->> 'escalation_level', '') NOT IN ('1', '2', '3') THEN
      RAISE EXCEPTION 'Escalation steps need a level from 1 to 3';
    END IF;
    IF v_step ->> 'channel' <> 'escalate' AND COALESCE(v_step ->> 'escalation_level', '') <> '' THEN
      RAISE EXCEPTION 'Only escalation steps have a level';
    END IF;
    IF v_step ->> 'channel' <> 'call' AND v_step ->> 'channel' <> 'escalate'
       AND btrim(COALESCE(v_step ->> 'template', '')) = '' THEN
      RAISE EXCEPTION 'Email, SMS and letter steps need a message';
    END IF;
  END LOOP;

  SELECT array_agg((e ->> 'id')::uuid) INTO v_ids
  FROM jsonb_array_elements(p_steps) e WHERE COALESCE(e ->> 'id', '') <> '';

  IF v_id IS NULL AND v_ids IS NOT NULL THEN
    RAISE EXCEPTION 'A new sequence cannot reuse existing step ids';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT is_default INTO v_was_default FROM collection_sequences WHERE id = v_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sequence not found'; END IF;

    IF v_ids IS NOT NULL THEN
      SELECT count(*) INTO v_known FROM collection_sequence_steps WHERE sequence_id = v_id AND id = ANY (v_ids);
      IF v_known <> cardinality(v_ids) THEN RAISE EXCEPTION 'One of the steps does not belong to this sequence'; END IF;
    END IF;
  END IF;

  -- Exactly one default. The first sequence an account creates becomes it.
  IF v_was_default AND NOT v_default THEN
    RAISE EXCEPTION 'Make another sequence the default instead of unsetting this one';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM collection_sequences WHERE user_id = v_user AND is_default AND id IS DISTINCT FROM v_id) THEN
    v_default := true;
  END IF;
  IF v_default AND NOT v_active THEN
    RAISE EXCEPTION 'The default sequence must stay active';
  END IF;

  BEGIN
    IF v_default THEN
      UPDATE collection_sequences SET is_default = false, updated_at = now()
      WHERE user_id = v_user AND is_default AND id IS DISTINCT FROM v_id;
    END IF;

    IF v_id IS NULL THEN
      INSERT INTO collection_sequences (user_id, name, is_default, is_active)
      VALUES (v_user, v_name, v_default, v_active) RETURNING id INTO v_id;
    ELSE
      UPDATE collection_sequences SET name = v_name, is_default = v_default, is_active = v_active, updated_at = now()
      WHERE id = v_id AND user_id = v_user;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A sequence named "%" already exists', v_name;
  END;

  DELETE FROM collection_sequence_steps
  WHERE sequence_id = v_id
    AND id NOT IN (SELECT (e ->> 'id')::uuid FROM jsonb_array_elements(p_steps) e WHERE COALESCE(e ->> 'id', '') <> '');

  INSERT INTO collection_sequence_steps (id, sequence_id, user_id, step_order, days_after_due, channel, subject, template, escalation_level)
  SELECT
    COALESCE(NULLIF(e.value ->> 'id', '')::uuid, gen_random_uuid()),
    v_id, v_user,
    (row_number() OVER (ORDER BY (e.value ->> 'days_after_due')::integer, e.ord))::integer,
    (e.value ->> 'days_after_due')::integer,
    e.value ->> 'channel',
    NULLIF(btrim(COALESCE(e.value ->> 'subject', '')), ''),
    COALESCE(e.value ->> 'template', ''),
    NULLIF(e.value ->> 'escalation_level', '')::smallint
  FROM jsonb_array_elements(p_steps) WITH ORDINALITY AS e(value, ord)
  ON CONFLICT (id) DO UPDATE SET
    step_order = EXCLUDED.step_order, days_after_due = EXCLUDED.days_after_due, channel = EXCLUDED.channel,
    subject = EXCLUDED.subject, template = EXCLUDED.template, escalation_level = EXCLUDED.escalation_level
  WHERE collection_sequence_steps.sequence_id = EXCLUDED.sequence_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_collection_sequence(uuid, text, boolean, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_collection_sequence(uuid, text, boolean, boolean, jsonb) TO authenticated;

-- =============================================================
-- CYCLE: settle, evaluate promises, generate due actions (idempotent)
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_collections_cycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_today date := current_date;
  v_company text;
  v_default_seq uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_kept integer := 0;
  v_broken integer := 0;
BEGIN
  v_user := public._col_require_manager();
  SELECT company_name INTO v_company FROM profiles WHERE id = v_user;
  SELECT id INTO v_default_seq FROM collection_sequences WHERE user_id = v_user AND is_default AND is_active;

  -- 1. Pending work for invoices that no longer need collecting.
  UPDATE collection_actions a
  SET status = 'skipped', outcome = 'Invoice settled or voided', completed_at = now()
  FROM ar_invoices i
  WHERE a.invoice_id = i.id AND a.user_id = v_user AND a.status = 'pending'
    AND (i.status IN ('paid', 'void', 'draft') OR i.total_cents <= i.amount_paid_cents);

  -- 2. Promises: void/draft -> cancelled; covered by later payments -> kept.
  UPDATE collection_promises p
  SET status = 'cancelled', resolved_at = now()
  FROM ar_invoices i
  WHERE p.invoice_id = i.id AND p.user_id = v_user AND p.status = 'open' AND i.status IN ('void', 'draft');

  UPDATE collection_promises p
  SET status = 'kept', resolved_at = now()
  FROM ar_invoices i
  WHERE p.invoice_id = i.id AND p.user_id = v_user AND p.status = 'open'
    AND (
      i.total_cents <= i.amount_paid_cents
      OR COALESCE((SELECT sum(ap.amount_cents) FROM ar_payments ap
                   WHERE ap.invoice_id = i.id AND ap.created_at >= p.created_at), 0) >= p.promised_amount_cents
    );
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  -- 3. Still open and the date has passed -> broken, and escalate to level 1.
  WITH b AS (
    UPDATE collection_promises
    SET status = 'broken', resolved_at = now()
    WHERE user_id = v_user AND status = 'open' AND promised_date < v_today
    RETURNING invoice_id, promised_date
  ), n AS (
    INSERT INTO collection_actions (user_id, invoice_id, channel, due_date, status, subject, outcome, completed_at)
    SELECT v_user, b.invoice_id, 'note', v_today, 'done', 'Promise to pay broken',
           'The promise for ' || to_char(b.promised_date, 'Mon DD, YYYY') || ' was not kept. Escalated to level 1.', now()
    FROM b
    RETURNING 1
  ), s AS (
    INSERT INTO invoice_collection_state (invoice_id, user_id, escalation_level)
    SELECT DISTINCT b.invoice_id, v_user, 1 FROM b
    ON CONFLICT (invoice_id) DO UPDATE
      SET escalation_level = GREATEST(invoice_collection_state.escalation_level, 1), updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_broken FROM b;

  -- 4. Generate due steps. Per invoice, only the latest missing due step
  --    becomes pending; earlier missing ones are recorded as skipped.
  WITH inv AS (
    SELECT i.id AS invoice_id, i.invoice_number AS inv_no, i.due_date AS due, (i.total_cents - i.amount_paid_cents) AS bal,
           cu.name AS cname, COALESCE(st.sequence_id, v_default_seq) AS seq, (v_today - i.due_date) AS dover
    FROM ar_invoices i
    LEFT JOIN customers cu ON cu.id = i.customer_id
    LEFT JOIN invoice_collection_state st ON st.invoice_id = i.id
    WHERE i.user_id = v_user
      AND i.status IN ('sent', 'partially_paid', 'overdue')
      AND i.total_cents > i.amount_paid_cents
      AND COALESCE(st.on_hold, false) = false
  ), cand AS (
    SELECT inv.*, s.id AS step_id, s.channel AS ch, s.subject AS subj, s.template AS tpl, s.escalation_level AS lvl,
           row_number() OVER (PARTITION BY inv.invoice_id ORDER BY s.days_after_due DESC, s.step_order DESC) AS rn
    FROM inv
    JOIN collection_sequences q ON q.id = inv.seq AND q.is_active
    JOIN collection_sequence_steps s ON s.sequence_id = q.id AND s.days_after_due <= inv.dover
    WHERE NOT EXISTS (SELECT 1 FROM collection_actions a WHERE a.invoice_id = inv.invoice_id AND a.step_id = s.id)
  ), ins AS (
    INSERT INTO collection_actions (user_id, invoice_id, step_id, channel, escalation_level, due_date, status, subject, body, outcome, completed_at)
    SELECT v_user, c.invoice_id, c.step_id, c.ch, c.lvl, v_today,
           CASE WHEN c.rn = 1 THEN 'pending' ELSE 'skipped' END,
           public._col_render(c.subj, c.cname, c.inv_no, c.bal, c.due, c.dover, v_company),
           public._col_render(c.tpl, c.cname, c.inv_no, c.bal, c.due, c.dover, v_company),
           CASE WHEN c.rn = 1 THEN NULL ELSE 'Superseded by a later step' END,
           CASE WHEN c.rn = 1 THEN NULL ELSE now() END
    FROM cand c
    ON CONFLICT (invoice_id, step_id) WHERE step_id IS NOT NULL DO NOTHING
    RETURNING status
  )
  SELECT count(*) FILTER (WHERE status = 'pending'), count(*) FILTER (WHERE status = 'skipped')
  INTO v_created, v_skipped FROM ins;

  RETURN jsonb_build_object(
    'actions_created', v_created, 'actions_skipped', v_skipped,
    'promises_kept', v_kept, 'promises_broken', v_broken
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_collections_cycle() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_collections_cycle() TO authenticated;

-- =============================================================
-- READ MODELS
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_collections_overview(p_as_of date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_buckets jsonb;
  v_totals jsonb;
  v_promises jsonb;
BEGIN
  v_user := public._col_require_manager();

  WITH open_inv AS (
    SELECT i.id, (i.total_cents - i.amount_paid_cents) AS bal, (p_as_of - i.due_date) AS dover,
           COALESCE(st.on_hold, false) AS held, COALESCE(st.escalation_level, 0) AS esc
    FROM ar_invoices i
    LEFT JOIN invoice_collection_state st ON st.invoice_id = i.id
    WHERE i.user_id = v_user AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.total_cents > i.amount_paid_cents
  ), b AS (
    SELECT CASE WHEN dover <= 0 THEN 'current' WHEN dover <= 30 THEN '1-30' WHEN dover <= 60 THEN '31-60'
                WHEN dover <= 90 THEN '61-90' ELSE '90+' END AS bucket, bal
    FROM open_inv
  )
  SELECT
    (SELECT jsonb_agg(jsonb_build_object(
        'bucket', k.bucket, 'count', COALESCE(x.n, 0), 'balance_cents', COALESCE(x.total, 0)) ORDER BY k.ord)
     FROM (VALUES ('current', 1), ('1-30', 2), ('31-60', 3), ('61-90', 4), ('90+', 5)) AS k(bucket, ord)
     LEFT JOIN (SELECT bucket, count(*) AS n, sum(bal) AS total FROM b GROUP BY bucket) x ON x.bucket = k.bucket),
    jsonb_build_object(
      'open_invoices', (SELECT count(*) FROM open_inv),
      'open_balance_cents', COALESCE((SELECT sum(bal) FROM open_inv), 0),
      'overdue_invoices', (SELECT count(*) FROM open_inv WHERE dover > 0),
      'overdue_balance_cents', COALESCE((SELECT sum(bal) FROM open_inv WHERE dover > 0), 0),
      'on_hold', (SELECT count(*) FROM open_inv WHERE held),
      'escalated', (SELECT count(*) FROM open_inv WHERE esc > 0),
      'pending_actions', (SELECT count(*) FROM collection_actions a
                          LEFT JOIN invoice_collection_state s2 ON s2.invoice_id = a.invoice_id
                          WHERE a.user_id = v_user AND a.status = 'pending' AND COALESCE(s2.on_hold, false) = false),
      'collected_30d_cents', COALESCE((SELECT sum(ap.amount_cents) FROM ar_payments ap
                                       WHERE ap.user_id = v_user AND ap.payment_date > p_as_of - 30 AND ap.payment_date <= p_as_of), 0)
    ),
    jsonb_build_object(
      'open', (SELECT count(*) FROM collection_promises WHERE user_id = v_user AND status = 'open'),
      'open_amount_cents', COALESCE((SELECT sum(promised_amount_cents) FROM collection_promises WHERE user_id = v_user AND status = 'open'), 0),
      'kept_90d', (SELECT count(*) FROM collection_promises WHERE user_id = v_user AND status = 'kept' AND resolved_at >= now() - interval '90 days'),
      'broken_90d', (SELECT count(*) FROM collection_promises WHERE user_id = v_user AND status = 'broken' AND resolved_at >= now() - interval '90 days')
    )
  INTO v_buckets, v_totals, v_promises;

  RETURN jsonb_build_object('as_of', p_as_of, 'buckets', v_buckets, 'totals', v_totals, 'promises', v_promises);
END;
$$;

REVOKE ALL ON FUNCTION public.get_collections_overview(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collections_overview(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_collection_cases(
  p_as_of date DEFAULT current_date,
  p_bucket text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  invoice_id uuid, invoice_number text, customer_id uuid, customer_name text, customer_email text, customer_phone text,
  due_date date, days_overdue integer, bucket text, balance_cents integer,
  on_hold boolean, hold_reason text, escalation_level smallint, sequence_name text,
  pending_actions bigint, promise_id uuid, promise_amount_cents integer, promise_date date,
  broken_promises bigint, last_contact_at timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._col_require_manager();
  IF p_bucket IS NOT NULL AND p_bucket NOT IN ('current', '1-30', '31-60', '61-90', '90+') THEN
    RAISE EXCEPTION 'Unknown aging bucket';
  END IF;
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);

  RETURN QUERY
  WITH base AS (
    SELECT i.id AS iid, i.invoice_number AS inum, i.customer_id AS cid, cu.name AS cname, cu.email AS cemail, cu.phone AS cphone,
           i.due_date AS ddate, GREATEST(0, p_as_of - i.due_date)::integer AS dover,
           CASE WHEN p_as_of <= i.due_date THEN 'current' WHEN p_as_of - i.due_date <= 30 THEN '1-30'
                WHEN p_as_of - i.due_date <= 60 THEN '31-60' WHEN p_as_of - i.due_date <= 90 THEN '61-90' ELSE '90+' END AS bkt,
           (i.total_cents - i.amount_paid_cents) AS bal,
           COALESCE(st.on_hold, false) AS hold, st.hold_reason AS hreason, COALESCE(st.escalation_level, 0)::smallint AS esc,
           COALESCE(sq.name, dsq.name) AS sqname
    FROM ar_invoices i
    LEFT JOIN customers cu ON cu.id = i.customer_id
    LEFT JOIN invoice_collection_state st ON st.invoice_id = i.id
    LEFT JOIN collection_sequences sq ON sq.id = st.sequence_id
    LEFT JOIN collection_sequences dsq ON dsq.user_id = v_user AND dsq.is_default
    WHERE i.user_id = v_user AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.total_cents > i.amount_paid_cents
  ), f AS (
    SELECT * FROM base WHERE p_bucket IS NULL OR base.bkt = p_bucket
  )
  SELECT
    f.iid, f.inum, f.cid, COALESCE(f.cname, 'Unknown customer'), f.cemail, f.cphone,
    f.ddate, f.dover, f.bkt, f.bal, f.hold, f.hreason, f.esc, f.sqname,
    (SELECT count(*) FROM collection_actions a WHERE a.invoice_id = f.iid AND a.status = 'pending'),
    pr.id, pr.promised_amount_cents, pr.promised_date,
    (SELECT count(*) FROM collection_promises bp WHERE bp.invoice_id = f.iid AND bp.status = 'broken'),
    (SELECT max(a.completed_at) FROM collection_actions a
       WHERE a.invoice_id = f.iid AND a.status = 'done' AND a.channel IN ('email', 'sms', 'call', 'letter')),
    count(*) OVER ()
  FROM f
  LEFT JOIN collection_promises pr ON pr.invoice_id = f.iid AND pr.status = 'open'
  ORDER BY f.dover DESC, f.bal DESC, f.inum
  LIMIT p_limit OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_collection_cases(date, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collection_cases(date, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_collection_actions(p_status text DEFAULT 'pending', p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid, invoice_id uuid, invoice_number text, customer_name text, customer_email text, customer_phone text,
  channel text, escalation_level smallint, due_date date, status text, subject text, body text, outcome text,
  completed_at timestamptz, balance_cents integer, days_overdue integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._col_require_manager();
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'done', 'skipped') THEN
    RAISE EXCEPTION 'Unknown action status';
  END IF;
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  RETURN QUERY
  SELECT a.id, a.invoice_id, i.invoice_number, COALESCE(cu.name, 'Unknown customer'), cu.email, cu.phone,
         a.channel, a.escalation_level, a.due_date, a.status, a.subject, a.body, a.outcome, a.completed_at,
         (i.total_cents - i.amount_paid_cents), GREATEST(0, current_date - i.due_date)::integer
  FROM collection_actions a
  JOIN ar_invoices i ON i.id = a.invoice_id
  LEFT JOIN customers cu ON cu.id = i.customer_id
  LEFT JOIN invoice_collection_state st ON st.invoice_id = a.invoice_id
  WHERE a.user_id = v_user
    AND a.channel <> 'note'
    AND (p_status IS NULL OR a.status = p_status)
    AND (a.status <> 'pending' OR COALESCE(st.on_hold, false) = false)
  ORDER BY CASE WHEN a.status = 'pending' THEN a.due_date END ASC NULLS LAST,
           GREATEST(0, current_date - i.due_date) DESC,
           a.completed_at DESC NULLS LAST, a.created_at DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_collection_actions(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collection_actions(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_collection_promises(p_status text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid, invoice_id uuid, invoice_number text, customer_name text, customer_phone text,
  promised_amount_cents integer, promised_date date, status text, notes text,
  created_at timestamptz, resolved_at timestamptz, balance_cents integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._col_require_manager();
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'kept', 'broken', 'cancelled') THEN
    RAISE EXCEPTION 'Unknown promise status';
  END IF;
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  RETURN QUERY
  SELECT p.id, p.invoice_id, i.invoice_number, COALESCE(cu.name, 'Unknown customer'), cu.phone,
         p.promised_amount_cents, p.promised_date, p.status, p.notes, p.created_at, p.resolved_at,
         GREATEST(0, i.total_cents - i.amount_paid_cents)
  FROM collection_promises p
  JOIN ar_invoices i ON i.id = p.invoice_id
  LEFT JOIN customers cu ON cu.id = i.customer_id
  WHERE p.user_id = v_user AND (p_status IS NULL OR p.status = p_status)
  ORDER BY (p.status = 'open') DESC, p.promised_date ASC, p.created_at DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_collection_promises(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_collection_promises(text, integer) TO authenticated;

-- =============================================================
-- WRITES
-- =============================================================

CREATE OR REPLACE FUNCTION public.complete_collection_action(p_action_id uuid, p_status text, p_outcome text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_act collection_actions%ROWTYPE;
  v_outcome text := NULLIF(btrim(COALESCE(p_outcome, '')), '');
BEGIN
  v_user := public._col_require_manager();
  IF p_status NOT IN ('done', 'skipped') THEN RAISE EXCEPTION 'Status must be done or skipped'; END IF;
  IF v_outcome IS NOT NULL AND char_length(v_outcome) > 300 THEN RAISE EXCEPTION 'Outcome is limited to 300 characters'; END IF;

  SELECT * INTO v_act FROM collection_actions WHERE id = p_action_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action not found'; END IF;
  IF v_act.status <> 'pending' THEN RAISE EXCEPTION 'This action was already completed'; END IF;

  UPDATE collection_actions
  SET status = p_status, outcome = v_outcome, completed_by = auth.uid(), completed_at = now()
  WHERE id = p_action_id;

  IF p_status = 'done' AND v_act.channel = 'escalate' AND v_act.escalation_level IS NOT NULL THEN
    INSERT INTO invoice_collection_state (invoice_id, user_id, escalation_level)
    VALUES (v_act.invoice_id, v_user, v_act.escalation_level)
    ON CONFLICT (invoice_id) DO UPDATE
      SET escalation_level = GREATEST(invoice_collection_state.escalation_level, EXCLUDED.escalation_level), updated_at = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_collection_action(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_collection_action(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.log_collection_contact(p_invoice_id uuid, p_channel text, p_outcome text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_outcome text := btrim(COALESCE(p_outcome, ''));
BEGIN
  v_user := public._col_require_manager();
  IF p_channel NOT IN ('email', 'sms', 'call', 'letter', 'note') THEN RAISE EXCEPTION 'Invalid contact channel'; END IF;
  IF char_length(v_outcome) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'Describe the contact in 3-300 characters'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ar_invoices WHERE id = p_invoice_id AND user_id = v_user) THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  INSERT INTO collection_actions (user_id, invoice_id, channel, due_date, status, subject, outcome, created_by, completed_by, completed_at)
  VALUES (v_user, p_invoice_id, p_channel, current_date, 'done', 'Logged contact', v_outcome, auth.uid(), auth.uid(), now());
END;
$$;

REVOKE ALL ON FUNCTION public.log_collection_contact(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_collection_contact(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_collection_promise(
  p_invoice_id uuid, p_amount_cents integer, p_promised_date date, p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_inv ar_invoices%ROWTYPE;
  v_balance integer;
  v_id uuid;
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  v_user := public._col_require_manager();
  IF v_notes IS NOT NULL AND char_length(v_notes) > 300 THEN RAISE EXCEPTION 'Notes are limited to 300 characters'; END IF;

  SELECT * INTO v_inv FROM ar_invoices WHERE id = p_invoice_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status NOT IN ('sent', 'partially_paid', 'overdue') THEN RAISE EXCEPTION 'This invoice is not open'; END IF;
  v_balance := v_inv.total_cents - v_inv.amount_paid_cents;
  IF v_balance <= 0 THEN RAISE EXCEPTION 'This invoice has no balance'; END IF;

  IF p_amount_cents IS NULL OR p_amount_cents < 1 OR p_amount_cents > v_balance THEN
    RAISE EXCEPTION 'The promised amount must be between $0.01 and the open balance';
  END IF;
  IF p_promised_date IS NULL OR p_promised_date < current_date OR p_promised_date > current_date + 180 THEN
    RAISE EXCEPTION 'The promised date must be within the next 180 days';
  END IF;

  UPDATE collection_promises SET status = 'cancelled', resolved_at = now()
  WHERE invoice_id = p_invoice_id AND status = 'open';

  INSERT INTO collection_promises (user_id, invoice_id, promised_amount_cents, promised_date, notes, created_by)
  VALUES (v_user, p_invoice_id, p_amount_cents, p_promised_date, v_notes, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public._col_note(v_user, p_invoice_id, 'Promise to pay recorded',
    '$' || to_char(p_amount_cents / 100.0, 'FM999,999,999,990.00') || ' promised by ' || to_char(p_promised_date, 'Mon DD, YYYY'));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_collection_promise(uuid, integer, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_collection_promise(uuid, integer, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_collection_promise(p_promise_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_invoice uuid;
BEGIN
  v_user := public._col_require_manager();
  UPDATE collection_promises SET status = 'cancelled', resolved_at = now(), notes = COALESCE(left(NULLIF(btrim(COALESCE(p_reason, '')), ''), 300), notes)
  WHERE id = p_promise_id AND user_id = v_user AND status = 'open'
  RETURNING invoice_id INTO v_invoice;
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'Open promise not found'; END IF;
  PERFORM public._col_note(v_user, v_invoice, 'Promise to pay cancelled', COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'Cancelled by staff'));
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_collection_promise(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_collection_promise(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_invoice_collection_hold(p_invoice_id uuid, p_hold boolean, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  v_user := public._col_require_manager();
  IF NOT EXISTS (SELECT 1 FROM ar_invoices WHERE id = p_invoice_id AND user_id = v_user) THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF p_hold THEN
    IF v_reason IS NULL OR char_length(v_reason) NOT BETWEEN 3 AND 200 THEN
      RAISE EXCEPTION 'Give a reason for the hold (3-200 characters), e.g. billing dispute';
    END IF;
    INSERT INTO invoice_collection_state (invoice_id, user_id, on_hold, hold_reason)
    VALUES (p_invoice_id, v_user, true, v_reason)
    ON CONFLICT (invoice_id) DO UPDATE SET on_hold = true, hold_reason = v_reason, updated_at = now();
    PERFORM public._col_note(v_user, p_invoice_id, 'Collections paused', v_reason);
  ELSE
    UPDATE invoice_collection_state SET on_hold = false, hold_reason = NULL, updated_at = now()
    WHERE invoice_id = p_invoice_id AND user_id = v_user AND on_hold;
    IF FOUND THEN PERFORM public._col_note(v_user, p_invoice_id, 'Collections resumed', 'Hold released'); END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_invoice_collection_hold(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_invoice_collection_hold(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.escalate_collection_invoice(p_invoice_id uuid, p_level smallint, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_prev smallint;
BEGIN
  v_user := public._col_require_manager();
  IF p_level IS NULL OR p_level NOT BETWEEN 0 AND 3 THEN RAISE EXCEPTION 'Escalation level must be 0-3'; END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 200 THEN RAISE EXCEPTION 'Note is limited to 200 characters'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ar_invoices WHERE id = p_invoice_id AND user_id = v_user) THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  SELECT escalation_level INTO v_prev FROM invoice_collection_state WHERE invoice_id = p_invoice_id;
  v_prev := COALESCE(v_prev, 0);
  IF v_prev = p_level THEN RETURN; END IF;

  INSERT INTO invoice_collection_state (invoice_id, user_id, escalation_level)
  VALUES (p_invoice_id, v_user, p_level)
  ON CONFLICT (invoice_id) DO UPDATE SET escalation_level = p_level, updated_at = now();

  PERFORM public._col_note(v_user, p_invoice_id,
    CASE WHEN p_level > v_prev THEN 'Escalated' ELSE 'De-escalated' END,
    'Level ' || v_prev || ' to ' || p_level || COALESCE(' — ' || v_note, ''));
END;
$$;

REVOKE ALL ON FUNCTION public.escalate_collection_invoice(uuid, smallint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.escalate_collection_invoice(uuid, smallint, text) TO authenticated;
