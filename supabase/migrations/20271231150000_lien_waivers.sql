/*
  # Lien Waivers — conditional / unconditional waivers tied to pay apps, e-sign and status tracking

  A lien waiver is a signed release of mechanic's-lien rights in exchange for (or on receipt of) payment.
  Two directions are supported:
    - given    : OUR company is the claimant and waives rights to the customer / GC (we sign).
    - received : a subcontractor / supplier waives rights to US (they sign) — collect before releasing their money.

  ## What it reuses (nothing is duplicated)
  - install_projects / install_project_billing -> a "pay app" is a progress-billing draw. A waiver links to the draw,
    its project and (when invoiced) its invoice. Amount, customer, address and through-date are pre-filled from them.
  - invoices                                    -> unconditional waivers (given) are gated on the linked invoice being PAID,
    so a contractor can never release rights before the money is in.
  - business_profile                            -> per-account counter LW-0001 ... (same pattern as invoices / projects / COs)

  ## State forms are DATA (lien_waiver_templates)
  - user_id IS NULL  = Vireek library (seeded below, read-only for everyone).
  - user_id = owner  = an account's own wording; it overrides the library for that (state, type).
  - Resolution order: state-specific (account, then library) -> generic 'US' (account, then library).
  - Body text uses {{placeholders}}; rendering is mirrored 1:1 in src/lib/lienWaivers.ts (change one, change the other).
  - Library text is a standard-structure starting point, NOT legal advice. Statutory-form states are flagged
    (is_statutory_form) because they require the exact statutory wording — counsel must verify before use.

  ## Lifecycle  (draft -> sent -> signed | declined | void ; draft -> signed for in-person/paper ; signed -> void)
  - Content is LOCKED once a waiver leaves draft. The rendered text and a SHA-256 fingerprint are frozen at that moment,
    and echoed in the signature event, so "exactly what was signed?" always has a provable answer.
  - A sent link expires (default 14 days, 1-90). Expiry is derived (status = 'sent' AND expires_at <= now()); no cron.
  - lien_waiver_events is an append-only audit trail (IP + user agent captured for online signatures).

  ## Safety
  - lien_waivers / lien_waiver_events / lien_waiver_templates are written ONLY by SECURITY DEFINER RPCs/triggers.
  - Every staff RPC re-checks the account owner and the billing permission (same rule as Install Projects).
  - Public RPCs are token-gated and expose customer-safe fields only.

  ## Deploy
    1. Run this migration (idempotent, additive, no destructive statements).
    2. Deploy edge function: supabase functions deploy lien-waiver-email   (optional — "Copy link" works without it).
    3. Apply the code edits delivered with it.
*/

-- =============================================================
-- 0. Permission helper (owner, or team member with can_view_billing — same rule as Install Projects)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_lien_waivers()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_lien_waivers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_lien_waivers() TO authenticated;

ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS lien_waiver_seq integer NOT NULL DEFAULT 0;

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS lien_waiver_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  state_code text NOT NULL CHECK (state_code ~ '^(US|[A-Z]{2})$'),
  waiver_type text NOT NULL
    CHECK (waiver_type IN ('conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  statute_ref text CHECK (statute_ref IS NULL OR length(statute_ref) <= 200),
  is_statutory_form boolean NOT NULL DEFAULT false,
  requires_notary boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lien_waiver_templates_scope
  ON lien_waiver_templates ((COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)), state_code, waiver_type);

CREATE TABLE IF NOT EXISTS lien_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  waiver_number text,
  project_id uuid REFERENCES install_projects(id) ON DELETE SET NULL,
  billing_id uuid REFERENCES install_project_billing(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  direction text NOT NULL DEFAULT 'given' CHECK (direction IN ('given', 'received')),
  waiver_type text NOT NULL
    CHECK (waiver_type IN ('conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final')),
  state_code text NOT NULL DEFAULT 'US' CHECK (state_code ~ '^(US|[A-Z]{2})$'),
  claimant_name text NOT NULL CHECK (length(btrim(claimant_name)) BETWEEN 1 AND 200),
  claimant_email text CHECK (claimant_email IS NULL OR length(claimant_email) <= 254),
  claimant_phone text CHECK (claimant_phone IS NULL OR length(claimant_phone) <= 40),
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 200),
  property_address text CHECK (property_address IS NULL OR length(property_address) <= 300),
  project_name text CHECK (project_name IS NULL OR length(project_name) <= 200),
  through_date date NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0 AND amount_cents <= 100000000000),
  exceptions text CHECK (exceptions IS NULL OR length(exceptions) <= 2000),
  template_id uuid REFERENCES lien_waiver_templates(id) ON DELETE SET NULL,
  template_version integer,
  title text,
  rendered_body text,
  content_hash text,
  statute_ref text,
  requires_notary boolean NOT NULL DEFAULT false,
  payment_confirmed_by text CHECK (payment_confirmed_by IS NULL OR payment_confirmed_by IN ('invoice', 'staff')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'void')),
  sign_token uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at timestamptz,
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  signer_name text,
  signer_title text,
  signature_method text CHECK (signature_method IS NULL OR signature_method IN ('online', 'in_app', 'paper', 'email', 'other')),
  decline_reason text,
  void_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lien_waivers_token ON lien_waivers(sign_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lien_waivers_number ON lien_waivers(user_id, waiver_number) WHERE waiver_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lien_waivers_pay_app
  ON lien_waivers(billing_id, waiver_type, direction, lower(claimant_name))
  WHERE billing_id IS NOT NULL AND status <> 'void';
CREATE INDEX IF NOT EXISTS idx_lien_waivers_user_status ON lien_waivers(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lien_waivers_project ON lien_waivers(project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lien_waivers_billing ON lien_waivers(billing_id) WHERE billing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lien_waivers_invoice ON lien_waivers(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lien_waiver_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  waiver_id uuid NOT NULL REFERENCES lien_waivers(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 40),
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'signer', 'system')),
  actor_id uuid,
  actor_name text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lien_waiver_events_waiver ON lien_waiver_events(waiver_id, created_at);

-- =============================================================
-- 2. Guard trigger (owner, number, integrity, status machine, content lock)
-- =============================================================

CREATE OR REPLACE FUNCTION public.lien_waivers_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.user_id := public.get_account_owner_id();
    IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
    NEW.created_by := auth.uid();
    NEW.status := 'draft';
    IF NEW.waiver_number IS NULL OR NEW.waiver_number = '' THEN
      INSERT INTO business_profile (user_id, lien_waiver_seq) VALUES (NEW.user_id, 1)
      ON CONFLICT (user_id) DO UPDATE SET lien_waiver_seq = business_profile.lien_waiver_seq + 1
      RETURNING lien_waiver_seq INTO v_seq;
      NEW.waiver_number := 'LW-' || lpad(v_seq::text, 4, '0');
    END IF;
  ELSE
    IF NEW.user_id <> OLD.user_id THEN RAISE EXCEPTION 'immutable_owner'; END IF;
    IF NEW.sign_token <> OLD.sign_token OR NEW.waiver_number IS DISTINCT FROM OLD.waiver_number THEN
      RAISE EXCEPTION 'waiver_locked';
    END IF;

    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('sent', 'signed', 'void'))
      OR (OLD.status = 'sent' AND NEW.status IN ('signed', 'declined', 'void'))
      OR (OLD.status = 'signed' AND NEW.status = 'void')
    ) THEN
      RAISE EXCEPTION 'invalid_status_change';
    END IF;

    IF OLD.status <> 'draft' THEN
      IF (NEW.direction, NEW.waiver_type, NEW.state_code, NEW.claimant_name, NEW.customer_name, NEW.property_address,
          NEW.project_name, NEW.through_date, NEW.amount_cents, NEW.exceptions, NEW.title, NEW.rendered_body, NEW.content_hash)
         IS DISTINCT FROM
         (OLD.direction, OLD.waiver_type, OLD.state_code, OLD.claimant_name, OLD.customer_name, OLD.property_address,
          OLD.project_name, OLD.through_date, OLD.amount_cents, OLD.exceptions, OLD.title, OLD.rendered_body, OLD.content_hash) THEN
        RAISE EXCEPTION 'waiver_locked';
      END IF;
      IF OLD.status IN ('signed', 'declined', 'void') AND
         (NEW.signer_name, NEW.signer_title, NEW.signed_at, NEW.signature_method, NEW.declined_at, NEW.decline_reason)
         IS DISTINCT FROM
         (OLD.signer_name, OLD.signer_title, OLD.signed_at, OLD.signature_method, OLD.declined_at, OLD.decline_reason) THEN
        RAISE EXCEPTION 'waiver_locked';
      END IF;
    END IF;
  END IF;

  -- Placeholders can never be smuggled into user-entered values.
  IF (COALESCE(NEW.claimant_name, '') || COALESCE(NEW.customer_name, '') || COALESCE(NEW.property_address, '')
      || COALESCE(NEW.project_name, '') || COALESCE(NEW.exceptions, '')) ~ '(\{\{|\}\})' THEN
    RAISE EXCEPTION 'invalid_characters';
  END IF;

  -- Parents must belong to the same account (only checked when written, so FK SET NULL never trips).
  IF NEW.project_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'project_not_found';
    END IF;
  END IF;
  IF NEW.billing_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.billing_id IS DISTINCT FROM OLD.billing_id) THEN
    IF NOT EXISTS (SELECT 1 FROM install_project_billing
                    WHERE id = NEW.billing_id AND user_id = NEW.user_id AND project_id IS NOT DISTINCT FROM NEW.project_id) THEN
      RAISE EXCEPTION 'billing_not_found';
    END IF;
  END IF;
  IF NEW.invoice_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id) THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invoice_not_found';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lien_waivers_guard ON public.lien_waivers;
CREATE TRIGGER trg_lien_waivers_guard
  BEFORE INSERT OR UPDATE ON public.lien_waivers
  FOR EACH ROW EXECUTE FUNCTION public.lien_waivers_guard();

CREATE OR REPLACE FUNCTION public.lien_waiver_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'lien_waiver_events_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_lien_waiver_events_no_update ON public.lien_waiver_events;
CREATE TRIGGER trg_lien_waiver_events_no_update
  BEFORE UPDATE ON public.lien_waiver_events
  FOR EACH ROW EXECUTE FUNCTION public.lien_waiver_events_append_only();

-- =============================================================
-- 3. Row level security — read-only from the client; drafts may be deleted; all other writes go through RPCs
-- =============================================================

ALTER TABLE public.lien_waiver_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lien_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lien_waiver_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_lien_waiver_templates" ON public.lien_waiver_templates;
CREATE POLICY "select_lien_waiver_templates" ON public.lien_waiver_templates FOR SELECT TO authenticated
  USING (public.can_manage_lien_waivers() AND (user_id IS NULL OR user_id = public.get_account_owner_id()));

DROP POLICY IF EXISTS "select_lien_waivers" ON public.lien_waivers;
CREATE POLICY "select_lien_waivers" ON public.lien_waivers FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lien_waivers());

DROP POLICY IF EXISTS "delete_draft_lien_waivers" ON public.lien_waivers;
CREATE POLICY "delete_draft_lien_waivers" ON public.lien_waivers FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lien_waivers() AND status = 'draft');

DROP POLICY IF EXISTS "select_lien_waiver_events" ON public.lien_waiver_events;
CREATE POLICY "select_lien_waiver_events" ON public.lien_waiver_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_lien_waivers());

REVOKE ALL ON public.lien_waiver_templates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.lien_waivers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.lien_waiver_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lien_waiver_templates TO authenticated;
GRANT SELECT, DELETE ON public.lien_waivers TO authenticated;
GRANT SELECT ON public.lien_waiver_events TO authenticated;

-- =============================================================
-- 4. Internal helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.lien_waiver_request_meta()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  h jsonb;
BEGIN
  BEGIN
    h := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    h := NULL;
  END;
  IF h IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ip', NULLIF(btrim(split_part(COALESCE(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
    'user_agent', NULLIF(left(COALESCE(h ->> 'user-agent', ''), 300), '')
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.lien_waiver_actor_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT u.email::text FROM auth.users u WHERE u.id = auth.uid()), 'Staff');
$$;

CREATE OR REPLACE FUNCTION public.lien_waiver_log(
  p_waiver_id uuid,
  p_type text,
  p_actor_type text,
  p_actor_name text,
  p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO lien_waiver_events (user_id, waiver_id, event_type, actor_type, actor_id, actor_name, detail)
  SELECT w.user_id, w.id, p_type, p_actor_type,
         CASE WHEN p_actor_type = 'staff' THEN auth.uid() ELSE NULL END,
         left(p_actor_name, 200), COALESCE(p_detail, '{}'::jsonb)
    FROM lien_waivers w WHERE w.id = p_waiver_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lien_waiver_money(p_cents bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '$' || to_char(COALESCE(p_cents, 0) / 100.0, 'FM999,999,999,990.00');
$$;

-- Mirrors renderLienWaiver() in src/lib/lienWaivers.ts.
CREATE OR REPLACE FUNCTION public.lien_waiver_render(p_body text, w public.lien_waivers, p_statute text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(p_body,
    '{{waiver_number}}', COALESCE(w.waiver_number, '')),
    '{{claimant_name}}', w.claimant_name),
    '{{customer_name}}', w.customer_name),
    '{{property_address}}', COALESCE(w.property_address, 'Not specified')),
    '{{project_name}}', COALESCE(w.project_name, 'Not specified')),
    '{{through_date}}', to_char(w.through_date, 'FMMonth FMDD, YYYY')),
    '{{amount}}', public.lien_waiver_money(w.amount_cents)),
    '{{exceptions}}', COALESCE(NULLIF(btrim(w.exceptions), ''), 'None')),
    '{{state}}', w.state_code),
    '{{statute_ref}}', COALESCE(NULLIF(btrim(p_statute), ''), 'Not specified'));
$$;

CREATE OR REPLACE FUNCTION public.lien_waiver_fingerprint(w public.lien_waivers)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    w.waiver_number, w.direction, w.waiver_type, w.state_code, w.claimant_name, w.customer_name,
    COALESCE(w.property_address, ''), COALESCE(w.project_name, ''), w.through_date::text, w.amount_cents::text,
    COALESCE(w.exceptions, ''), COALESCE(w.rendered_body, '')
  ), 'UTF8')), 'hex');
$$;

-- Freezes the wording of a DRAFT: resolves the template (state-specific first, then generic; account first, then
-- library), renders it, stores title / body / statute / notary flag / fingerprint. No-op when already frozen.
CREATE OR REPLACE FUNCTION public.lien_waiver_freeze(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w lien_waivers%ROWTYPE;
  t lien_waiver_templates%ROWTYPE;
  v_body text;
BEGIN
  SELECT * INTO w FROM lien_waivers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_not_found'; END IF;
  IF w.rendered_body IS NOT NULL THEN RETURN; END IF;

  SELECT * INTO t FROM lien_waiver_templates
   WHERE waiver_type = w.waiver_type
     AND state_code IN (w.state_code, 'US')
     AND (user_id = w.user_id OR user_id IS NULL)
   ORDER BY (state_code = w.state_code) DESC, (user_id IS NOT NULL) DESC
   LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;

  v_body := public.lien_waiver_render(t.body, w, t.statute_ref);
  IF position('{{' IN v_body) > 0 THEN RAISE EXCEPTION 'unresolved_placeholder'; END IF;

  w.rendered_body := v_body;
  UPDATE lien_waivers SET
    template_id = t.id,
    template_version = t.version,
    title = t.title,
    rendered_body = v_body,
    statute_ref = t.statute_ref,
    requires_notary = t.requires_notary,
    content_hash = public.lien_waiver_fingerprint(w)
  WHERE id = w.id;
END;
$$;

REVOKE ALL ON FUNCTION public.lien_waiver_request_meta() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lien_waiver_actor_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lien_waiver_log(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lien_waiver_money(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lien_waiver_render(text, public.lien_waivers, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lien_waiver_fingerprint(public.lien_waivers) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lien_waiver_freeze(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. Staff RPCs
-- =============================================================

-- Create (p_id NULL) or update a DRAFT. Payload keys (all optional on update):
--   project_id, billing_id (create only; they pre-fill customer, address, amount, invoice, through date),
--   direction, waiver_type, state_code, claimant_name, claimant_email, claimant_phone, customer_name,
--   property_address, project_name, through_date, amount_cents, exceptions
CREATE OR REPLACE FUNCTION public.save_lien_waiver(p_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  p jsonb := COALESCE(p_payload, '{}'::jsonb);
  w lien_waivers%ROWTYPE;
  pr install_projects%ROWTYPE;
  b install_project_billing%ROWTYPE;
  v_id uuid;
  v_project uuid;
  v_billing uuid;
  v_invoice uuid;
  v_dir text;
  v_type text;
  v_state text;
  v_claimant text;
  v_email text;
  v_phone text;
  v_customer text;
  v_address text;
  v_pname text;
  v_through date;
  v_amount bigint;
  v_exc text;
  v_gross bigint;
  v_ret bigint;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO w FROM lien_waivers WHERE id = p_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'waiver_not_found'; END IF;
    IF w.status <> 'draft' THEN RAISE EXCEPTION 'waiver_locked'; END IF;
    v_dir := w.direction; v_type := w.waiver_type; v_state := w.state_code; v_claimant := w.claimant_name;
    v_email := w.claimant_email; v_phone := w.claimant_phone; v_customer := w.customer_name;
    v_address := w.property_address; v_pname := w.project_name; v_through := w.through_date;
    v_amount := w.amount_cents; v_exc := w.exceptions;
  ELSE
    v_dir := 'given'; v_state := 'US'; v_through := current_date; v_amount := 0;
    v_project := NULLIF(p ->> 'project_id', '')::uuid;
    v_billing := NULLIF(p ->> 'billing_id', '')::uuid;
    IF v_billing IS NOT NULL THEN
      SELECT * INTO b FROM install_project_billing WHERE id = v_billing AND user_id = v_owner;
      IF NOT FOUND THEN RAISE EXCEPTION 'billing_not_found'; END IF;
      IF v_project IS NOT NULL AND v_project <> b.project_id THEN RAISE EXCEPTION 'billing_not_found'; END IF;
      v_project := b.project_id;
    END IF;
    IF v_project IS NOT NULL THEN
      SELECT * INTO pr FROM install_projects WHERE id = v_project AND user_id = v_owner;
      IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
      v_customer := pr.customer_name; v_address := pr.site_address; v_pname := pr.name;
    END IF;
    IF v_billing IS NOT NULL THEN
      IF b.invoice_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM invoices WHERE id = b.invoice_id AND user_id = v_owner AND status <> 'void') THEN
        v_invoice := b.invoice_id;
        v_amount := GREATEST(COALESCE(b.invoiced_gross_cents, 0) - b.retainage_withheld_cents, 0);
        v_through := COALESCE(b.invoiced_at::date, current_date);
      ELSE
        v_gross := round(pr.contract_value_cents * b.percent_of_contract / 100.0)::bigint;
        v_ret := round(v_gross * pr.retainage_percent / 100.0)::bigint;
        v_amount := GREATEST(v_gross - v_ret, 0);
      END IF;
    END IF;
  END IF;

  IF p ? 'direction' THEN v_dir := p ->> 'direction'; END IF;
  IF p ? 'waiver_type' THEN v_type := p ->> 'waiver_type'; END IF;
  IF p ? 'state_code' THEN v_state := upper(btrim(COALESCE(p ->> 'state_code', ''))); END IF;
  IF p ? 'claimant_name' THEN v_claimant := NULLIF(btrim(COALESCE(p ->> 'claimant_name', '')), ''); END IF;
  IF p ? 'claimant_email' THEN v_email := NULLIF(lower(btrim(COALESCE(p ->> 'claimant_email', ''))), ''); END IF;
  IF p ? 'claimant_phone' THEN v_phone := NULLIF(btrim(COALESCE(p ->> 'claimant_phone', '')), ''); END IF;
  IF p ? 'customer_name' THEN v_customer := NULLIF(btrim(COALESCE(p ->> 'customer_name', '')), ''); END IF;
  IF p ? 'property_address' THEN v_address := NULLIF(btrim(COALESCE(p ->> 'property_address', '')), ''); END IF;
  IF p ? 'project_name' THEN v_pname := NULLIF(btrim(COALESCE(p ->> 'project_name', '')), ''); END IF;
  IF p ? 'exceptions' THEN v_exc := NULLIF(btrim(COALESCE(p ->> 'exceptions', '')), ''); END IF;
  IF p ? 'through_date' THEN v_through := NULLIF(p ->> 'through_date', '')::date; END IF;
  IF p ? 'amount_cents' THEN v_amount := NULLIF(p ->> 'amount_cents', '')::bigint; END IF;

  IF v_dir IS NULL OR v_dir NOT IN ('given', 'received') THEN RAISE EXCEPTION 'invalid_direction'; END IF;
  IF v_type IS NULL OR v_type NOT IN ('conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final') THEN
    RAISE EXCEPTION 'invalid_type';
  END IF;
  IF v_state IS NULL OR v_state !~ '^(US|[A-Z]{2})$' THEN RAISE EXCEPTION 'invalid_state'; END IF;
  IF v_claimant IS NULL THEN RAISE EXCEPTION 'claimant_required'; END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'customer_required'; END IF;
  IF v_through IS NULL THEN RAISE EXCEPTION 'date_required'; END IF;
  IF v_amount IS NULL OR v_amount < 0 OR v_amount > 100000000000 THEN RAISE EXCEPTION 'invalid_amount'; END IF;
  IF length(v_claimant) > 200 OR length(v_customer) > 200 OR length(COALESCE(v_address, '')) > 300
     OR length(COALESCE(v_pname, '')) > 200 OR length(COALESCE(v_exc, '')) > 2000
     OR length(COALESCE(v_email, '')) > 254 OR length(COALESCE(v_phone, '')) > 40 THEN
    RAISE EXCEPTION 'text_too_long';
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE lien_waivers SET
      direction = v_dir, waiver_type = v_type, state_code = v_state, claimant_name = v_claimant,
      claimant_email = v_email, claimant_phone = v_phone, customer_name = v_customer,
      property_address = v_address, project_name = v_pname, through_date = v_through,
      amount_cents = v_amount, exceptions = v_exc
    WHERE id = w.id;
    v_id := w.id;
  ELSE
    BEGIN
      INSERT INTO lien_waivers (
        user_id, project_id, billing_id, invoice_id, direction, waiver_type, state_code, claimant_name,
        claimant_email, claimant_phone, customer_name, property_address, project_name, through_date,
        amount_cents, exceptions)
      VALUES (
        v_owner, v_project, v_billing, v_invoice, v_dir, v_type, v_state, v_claimant,
        v_email, v_phone, v_customer, v_address, v_pname, v_through, v_amount, v_exc)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate_waiver';
    END;
    PERFORM public.lien_waiver_log(v_id, 'created', 'staff', public.lien_waiver_actor_name(),
      jsonb_build_object('type', v_type, 'direction', v_dir, 'billing_id', v_billing));
  END IF;
  RETURN v_id;
END;
$$;

-- Request a signature: freezes the wording, issues the link. Re-sending a SENT waiver only refreshes the expiry window.
-- Unconditional waivers GIVEN by us need proof of payment: the linked invoice is paid, or staff confirm it explicitly.
CREATE OR REPLACE FUNCTION public.send_lien_waiver(p_id uuid, p_expires_in_days integer DEFAULT 14, p_payment_confirmed boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w lien_waivers%ROWTYPE;
  v_days integer := COALESCE(p_expires_in_days, 14);
  v_paid boolean;
  v_confirmed_by text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_days < 1 OR v_days > 90 THEN RAISE EXCEPTION 'invalid_expiry'; END IF;

  SELECT * INTO w FROM lien_waivers WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_not_found'; END IF;
  IF w.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'waiver_closed'; END IF;

  v_confirmed_by := w.payment_confirmed_by;
  IF w.status = 'draft' THEN
    IF w.direction = 'given' AND w.waiver_type LIKE 'unconditional%' THEN
      v_paid := w.invoice_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoices WHERE id = w.invoice_id AND user_id = v_owner AND status = 'paid');
      IF NOT v_paid AND NOT COALESCE(p_payment_confirmed, false) THEN RAISE EXCEPTION 'payment_not_confirmed'; END IF;
      v_confirmed_by := CASE WHEN v_paid THEN 'invoice' ELSE 'staff' END;
    END IF;
    PERFORM public.lien_waiver_freeze(w.id);
  END IF;

  UPDATE lien_waivers SET
    status = 'sent',
    sent_at = COALESCE(sent_at, now()),
    expires_at = now() + make_interval(days => v_days),
    payment_confirmed_by = v_confirmed_by
  WHERE id = w.id
  RETURNING * INTO w;

  PERFORM public.lien_waiver_log(w.id, 'sent', 'staff', public.lien_waiver_actor_name(),
    jsonb_build_object('expires_at', w.expires_at, 'content_hash', w.content_hash, 'payment_confirmed_by', v_confirmed_by));
  RETURN jsonb_build_object('token', w.sign_token, 'expires_at', w.expires_at);
END;
$$;

-- Staff records a signature given in person / on paper / by email (also how WE sign our own waiver in-app).
CREATE OR REPLACE FUNCTION public.sign_lien_waiver_staff(
  p_id uuid,
  p_signer_name text,
  p_signer_title text,
  p_method text,
  p_payment_confirmed boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w lien_waivers%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_signer_name, '')), '');
  v_title text := NULLIF(btrim(COALESCE(p_signer_title, '')), '');
  v_paid boolean;
  v_confirmed_by text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('in_app', 'paper', 'email', 'other') THEN RAISE EXCEPTION 'invalid_method'; END IF;
  IF v_name IS NULL OR length(v_name) < 2 THEN RAISE EXCEPTION 'name_required'; END IF;
  IF length(v_name) > 160 OR length(COALESCE(v_title, '')) > 160 THEN RAISE EXCEPTION 'text_too_long'; END IF;

  SELECT * INTO w FROM lien_waivers WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_not_found'; END IF;
  IF w.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'waiver_closed'; END IF;

  v_confirmed_by := w.payment_confirmed_by;
  IF w.direction = 'given' AND w.waiver_type LIKE 'unconditional%' AND v_confirmed_by IS NULL THEN
    v_paid := w.invoice_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices WHERE id = w.invoice_id AND user_id = v_owner AND status = 'paid');
    IF NOT v_paid AND NOT COALESCE(p_payment_confirmed, false) THEN RAISE EXCEPTION 'payment_not_confirmed'; END IF;
    v_confirmed_by := CASE WHEN v_paid THEN 'invoice' ELSE 'staff' END;
  END IF;

  PERFORM public.lien_waiver_freeze(w.id);

  UPDATE lien_waivers SET
    status = 'signed',
    sent_at = COALESCE(sent_at, now()),
    signed_at = now(),
    signer_name = v_name,
    signer_title = v_title,
    signature_method = p_method,
    payment_confirmed_by = v_confirmed_by
  WHERE id = w.id
  RETURNING * INTO w;

  PERFORM public.lien_waiver_log(w.id, 'signed', 'staff', public.lien_waiver_actor_name(),
    jsonb_build_object('method', p_method, 'signer_name', v_name, 'content_hash', w.content_hash,
                       'payment_confirmed_by', v_confirmed_by));
END;
$$;

CREATE OR REPLACE FUNCTION public.void_lien_waiver(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w lien_waivers%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;
  IF length(v_reason) > 2000 THEN RAISE EXCEPTION 'text_too_long'; END IF;

  SELECT * INTO w FROM lien_waivers WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_not_found'; END IF;
  IF w.status NOT IN ('draft', 'sent', 'signed') THEN RAISE EXCEPTION 'waiver_closed'; END IF;

  UPDATE lien_waivers SET status = 'void', voided_at = now(), void_reason = v_reason WHERE id = w.id;
  PERFORM public.lien_waiver_log(w.id, 'voided', 'staff', public.lien_waiver_actor_name(),
    jsonb_build_object('reason', v_reason, 'was', w.status));
END;
$$;

-- Used by the lien-waiver-email edge function (runs as the caller) to record that an email went out.
CREATE OR REPLACE FUNCTION public.log_lien_waiver_email(p_id uuid, p_recipient text, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('request', 'copy') THEN RAISE EXCEPTION 'invalid_method'; END IF;
  IF NOT EXISTS (SELECT 1 FROM lien_waivers WHERE id = p_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'waiver_not_found';
  END IF;
  PERFORM public.lien_waiver_log(p_id, 'emailed', 'staff', public.lien_waiver_actor_name(),
    jsonb_build_object('kind', p_kind, 'recipient', left(COALESCE(p_recipient, ''), 254)));
END;
$$;

-- Account-owned wording for a (state, type). Updates bump the version; the library row is never touched.
CREATE OR REPLACE FUNCTION public.save_lien_waiver_template(
  p_state text,
  p_type text,
  p_title text,
  p_body text,
  p_statute_ref text DEFAULT NULL,
  p_requires_notary boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_state text := upper(btrim(COALESCE(p_state, '')));
  v_title text := NULLIF(btrim(COALESCE(p_title, '')), '');
  v_body text := NULLIF(btrim(COALESCE(p_body, '')), '');
  v_ref text := NULLIF(btrim(COALESCE(p_statute_ref, '')), '');
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_state !~ '^(US|[A-Z]{2})$' THEN RAISE EXCEPTION 'invalid_state'; END IF;
  IF p_type IS NULL OR p_type NOT IN ('conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final') THEN
    RAISE EXCEPTION 'invalid_type';
  END IF;
  IF v_title IS NULL OR v_body IS NULL THEN RAISE EXCEPTION 'template_required'; END IF;
  IF length(v_title) > 200 OR length(v_body) > 20000 OR length(COALESCE(v_ref, '')) > 200 THEN
    RAISE EXCEPTION 'text_too_long';
  END IF;

  UPDATE lien_waiver_templates SET
    title = v_title, body = v_body, statute_ref = v_ref, requires_notary = COALESCE(p_requires_notary, false),
    version = version + 1, updated_at = now()
  WHERE user_id = v_owner AND state_code = v_state AND waiver_type = p_type
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    INSERT INTO lien_waiver_templates (user_id, state_code, waiver_type, title, body, statute_ref, is_statutory_form, requires_notary)
    VALUES (v_owner, v_state, p_type, v_title, v_body, v_ref,
            COALESCE((SELECT t.is_statutory_form FROM lien_waiver_templates t
                       WHERE t.user_id IS NULL AND t.state_code = v_state AND t.waiver_type = p_type), false),
            COALESCE(p_requires_notary, false))
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_lien_waiver_template(p_state text, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_lien_waivers() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  DELETE FROM lien_waiver_templates
   WHERE user_id = v_owner AND state_code = upper(btrim(COALESCE(p_state, ''))) AND waiver_type = p_type;
END;
$$;

-- =============================================================
-- 6. Public (token-gated) RPCs — customer/claimant-safe fields only
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_lien_waiver_for_token(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w lien_waivers%ROWTYPE;
  v_business text;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO w FROM lien_waivers WHERE sign_token = p_token AND status <> 'draft' AND rendered_body IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT company_name INTO v_business FROM profiles WHERE id = w.user_id;

  RETURN jsonb_build_object(
    'number', w.waiver_number,
    'title', w.title,
    'body', w.rendered_body,
    'direction', w.direction,
    'waiver_type', w.waiver_type,
    'state_code', w.state_code,
    'statute_ref', w.statute_ref,
    'requires_notary', w.requires_notary,
    'claimant_name', w.claimant_name,
    'customer_name', w.customer_name,
    'property_address', w.property_address,
    'project_name', w.project_name,
    'through_date', w.through_date,
    'amount_cents', w.amount_cents,
    'status', CASE WHEN w.status = 'sent' AND w.expires_at IS NOT NULL AND w.expires_at <= now() THEN 'expired' ELSE w.status END,
    'sent_at', w.sent_at,
    'expires_at', w.expires_at,
    'signed_at', w.signed_at,
    'signer_name', w.signer_name,
    'signer_title', w.signer_title,
    'content_hash', w.content_hash,
    'business_name', v_business
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_lien_waiver_view(p_token uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_token IS NULL THEN RETURN; END IF;
  UPDATE lien_waivers SET viewed_at = now()
   WHERE sign_token = p_token AND status = 'sent' AND viewed_at IS NULL
   RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    PERFORM public.lien_waiver_log(v_id, 'viewed', 'signer', NULL, public.lien_waiver_request_meta());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_lien_waiver_by_token(
  p_token uuid,
  p_decision text,
  p_name text,
  p_title text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w lien_waivers%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_title text := NULLIF(btrim(COALESCE(p_title, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF p_token IS NULL OR p_decision IS NULL OR p_decision NOT IN ('signed', 'declined') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;
  IF p_decision = 'signed' AND (v_name IS NULL OR length(v_name) < 2) THEN RAISE EXCEPTION 'name_required'; END IF;
  IF length(COALESCE(v_name, '')) > 160 OR length(COALESCE(v_title, '')) > 160 OR length(COALESCE(v_note, '')) > 2000 THEN
    RAISE EXCEPTION 'text_too_long';
  END IF;

  SELECT * INTO w FROM lien_waivers WHERE sign_token = p_token AND status <> 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_not_found'; END IF;
  IF w.status <> 'sent' THEN RAISE EXCEPTION 'waiver_closed'; END IF;
  IF w.expires_at IS NOT NULL AND w.expires_at <= now() THEN RAISE EXCEPTION 'waiver_expired'; END IF;

  IF p_decision = 'signed' THEN
    IF w.direction = 'given' AND w.waiver_type LIKE 'unconditional%' AND w.payment_confirmed_by IS NULL THEN
      RAISE EXCEPTION 'payment_not_confirmed';
    END IF;
    UPDATE lien_waivers SET
      status = 'signed', signed_at = now(), signer_name = v_name, signer_title = v_title,
      signature_method = 'online', viewed_at = COALESCE(viewed_at, now())
    WHERE id = w.id;
    PERFORM public.lien_waiver_log(w.id, 'signed', 'signer', v_name,
      public.lien_waiver_request_meta() || jsonb_build_object('method', 'online', 'content_hash', w.content_hash,
                                                             'signer_title', v_title));
  ELSE
    UPDATE lien_waivers SET
      status = 'declined', declined_at = now(), decline_reason = v_note, signer_name = v_name,
      viewed_at = COALESCE(viewed_at, now())
    WHERE id = w.id;
    PERFORM public.lien_waiver_log(w.id, 'declined', 'signer', COALESCE(v_name, 'Signer'),
      public.lien_waiver_request_meta() || jsonb_build_object('reason', v_note));
  END IF;

  RETURN jsonb_build_object('status', p_decision);
END;
$$;

-- =============================================================
-- 7. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.save_lien_waiver(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_lien_waiver(uuid, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sign_lien_waiver_staff(uuid, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_lien_waiver(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.log_lien_waiver_email(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_lien_waiver_template(text, text, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reset_lien_waiver_template(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_lien_waiver(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_lien_waiver(uuid, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sign_lien_waiver_staff(uuid, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_lien_waiver(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_lien_waiver_email(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_lien_waiver_template(text, text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_lien_waiver_template(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_lien_waiver_for_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_lien_waiver_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_lien_waiver_by_token(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_lien_waiver_for_token(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_lien_waiver_view(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_lien_waiver_by_token(uuid, text, text, text, text) TO anon, authenticated;

COMMENT ON TABLE public.lien_waivers IS
  'Conditional/unconditional lien waivers tied to install-project pay apps. Written only by RPCs; content locks once sent.';
COMMENT ON TABLE public.lien_waiver_templates IS
  'State lien-waiver forms as data. user_id NULL = Vireek library (not legal advice); user_id = owner overrides it.';
COMMENT ON TABLE public.lien_waiver_events IS
  'Append-only audit trail for lien waivers (created, sent, viewed, signed, declined, voided, emailed).';

-- =============================================================
-- 8. Library seed — standard structure, per state and type. NOT LEGAL ADVICE.
--    Statutory-form states are flagged: the exact statutory wording must be verified by counsel before use.
-- =============================================================

DO $seed$
DECLARE
  s record;
  t record;
BEGIN
  FOR s IN
    SELECT * FROM (VALUES
      ('US', 'Applicable state lien law',            false),
      ('AZ', 'A.R.S. § 33-1008',                     true),
      ('CA', 'Cal. Civ. Code §§ 8132–8138',          true),
      ('FL', 'Fla. Stat. § 713.20',                  true),
      ('GA', 'O.C.G.A. § 44-14-366',                 true),
      ('MI', 'MCL 570.1115',                         true),
      ('MO', 'RSMo § 429.005',                       true),
      ('MS', 'Miss. Code Ann. § 85-7-433',           true),
      ('NV', 'NRS 108.2457',                         true),
      ('TX', 'Tex. Prop. Code §§ 53.281–53.287',     true),
      ('UT', 'Utah Code Ann. § 38-1a-802',           true),
      ('WY', 'Wyo. Stat. § 29-1-311',                true)
    ) AS x(code, ref, statutory)
  LOOP
    FOR t IN
      SELECT * FROM (VALUES
        ('conditional_progress',   'Conditional Waiver and Release on Progress Payment',
$b1$CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT

Waiver no.: {{waiver_number}}
Project: {{project_name}}
Property: {{property_address}}
Owner / customer: {{customer_name}}
Claimant: {{claimant_name}}
Through date: {{through_date}}
Progress payment amount: {{amount}}

Upon receipt by the Claimant of a check, wire transfer or other payment in the amount of {{amount}} payable to the Claimant, and once that payment has been properly endorsed (where applicable) and has cleared the institution on which it is drawn, this document becomes effective and the Claimant waives and releases any mechanic's lien, stop payment notice, bond claim and other lien right the Claimant has against the property and project described above for labor, services, equipment or materials furnished through {{through_date}}.

This waiver and release covers a progress payment only. It does not cover retainage, labor, services, equipment or materials furnished after {{through_date}}, or any extras, change orders or claims that are not included in this payment.

Exceptions (disputed claims or items not covered): {{exceptions}}

The Claimant represents that it has paid, or will promptly pay from the proceeds of this payment, its laborers, subcontractors, suppliers and equipment lessors for the work covered by this waiver.

State: {{state}}. Form reference: {{statute_ref}}.$b1$),
        ('unconditional_progress', 'Unconditional Waiver and Release on Progress Payment',
$b2$UNCONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT

Waiver no.: {{waiver_number}}
Project: {{project_name}}
Property: {{property_address}}
Owner / customer: {{customer_name}}
Claimant: {{claimant_name}}
Through date: {{through_date}}
Progress payment received: {{amount}}

The Claimant has been paid and has received a progress payment in the amount of {{amount}} for labor, services, equipment or materials furnished to the project described above through {{through_date}}, and unconditionally waives and releases any mechanic's lien, stop payment notice, bond claim and other lien right the Claimant has against the property and project for that work.

This waiver and release covers a progress payment only. It does not cover retainage, labor, services, equipment or materials furnished after {{through_date}}, or any extras, change orders or claims that are not included in this payment.

Exceptions (disputed claims or items not covered): {{exceptions}}

The Claimant represents that it has paid, or will promptly pay from the proceeds of this payment, its laborers, subcontractors, suppliers and equipment lessors for the work covered by this waiver.

NOTICE: This document waives rights unconditionally and states that you have been paid for giving up those rights. Do not sign it unless you have actually received the payment. If you have not been paid, use a conditional waiver and release instead.

State: {{state}}. Form reference: {{statute_ref}}.$b2$),
        ('conditional_final',      'Conditional Waiver and Release on Final Payment',
$b3$CONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT

Waiver no.: {{waiver_number}}
Project: {{project_name}}
Property: {{property_address}}
Owner / customer: {{customer_name}}
Claimant: {{claimant_name}}
Final through date: {{through_date}}
Final payment amount: {{amount}}

Upon receipt by the Claimant of a check, wire transfer or other payment in the amount of {{amount}} payable to the Claimant, and once that payment has been properly endorsed (where applicable) and has cleared the institution on which it is drawn, this document becomes effective and the Claimant waives and releases any mechanic's lien, stop payment notice, bond claim and other lien right the Claimant has against the property and project described above for all labor, services, equipment or materials furnished through {{through_date}}.

This is a final waiver and release. Upon its effectiveness the Claimant has been paid in full for all work on the project, except for the exceptions listed below.

Exceptions (disputed claims or items not covered): {{exceptions}}

The Claimant represents that it has paid, or will promptly pay from the proceeds of this payment, its laborers, subcontractors, suppliers and equipment lessors for all work covered by this waiver.

State: {{state}}. Form reference: {{statute_ref}}.$b3$),
        ('unconditional_final',    'Unconditional Waiver and Release on Final Payment',
$b4$UNCONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT

Waiver no.: {{waiver_number}}
Project: {{project_name}}
Property: {{property_address}}
Owner / customer: {{customer_name}}
Claimant: {{claimant_name}}
Final through date: {{through_date}}
Final payment received: {{amount}}

The Claimant has been paid in full and has received the final payment in the amount of {{amount}} for all labor, services, equipment or materials furnished to the project described above through {{through_date}}, and unconditionally waives and releases any mechanic's lien, stop payment notice, bond claim and other lien right the Claimant has against the property and project, except for the exceptions listed below.

Exceptions (disputed claims or items not covered): {{exceptions}}

The Claimant represents that it has paid, or will promptly pay from the proceeds of this payment, its laborers, subcontractors, suppliers and equipment lessors for all work covered by this waiver.

NOTICE: This document waives rights unconditionally and states that you have been paid in full for giving up those rights. Do not sign it unless you have actually received the final payment. If you have not been paid, use a conditional waiver and release instead.

State: {{state}}. Form reference: {{statute_ref}}.$b4$)
      ) AS y(wtype, wtitle, wbody)
    LOOP
      INSERT INTO lien_waiver_templates (user_id, state_code, waiver_type, title, body, statute_ref, is_statutory_form, requires_notary, notes)
      SELECT NULL, s.code, t.wtype, t.wtitle, t.wbody, s.ref, s.statutory,
             (s.code = 'TX' AND t.wtype LIKE 'unconditional%'),
             CASE WHEN s.statutory
                  THEN 'Standard-structure starting point, not legal advice. This state has a statutory form: verify the exact wording, notary and witness rules with counsel, then save your own copy.'
                  ELSE 'Generic starting point, not legal advice. Pick a state for a state-flagged form, or save your own wording.' END
      WHERE NOT EXISTS (
        SELECT 1 FROM lien_waiver_templates x
         WHERE x.user_id IS NULL AND x.state_code = s.code AND x.waiver_type = t.wtype);
    END LOOP;
  END LOOP;
END
$seed$;
