/*
# Bulk actions support
Additive only: tags on quotes/invoices(/customers if missing), assigned_to on
leads/customers/quotes/invoices/calls, audit_log.metadata, log_bulk_audit_event().
*/

ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_customers_tags ON customers USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_quotes_tags    ON quotes    USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_invoices_tags  ON invoices  USING GIN (tags);

ALTER TABLE leads     ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL;
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL;
ALTER TABLE calls     ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_assigned_to     ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_customers_assigned_to ON customers(assigned_to);
CREATE INDEX IF NOT EXISTS idx_quotes_assigned_to    ON quotes(assigned_to);
CREATE INDEX IF NOT EXISTS idx_invoices_assigned_to  ON invoices(assigned_to);
CREATE INDEX IF NOT EXISTS idx_calls_assigned_to     ON calls(assigned_to);

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.log_bulk_audit_event(
  p_action text,
  p_target_table text,
  p_target_ids text[],
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_email text;
  v_ids text[] := p_target_ids[1:500];
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_action NOT IN ('bulk_delete','bulk_status_change','bulk_assign','bulk_tag_add','bulk_tag_remove','bulk_export') THEN
    RAISE EXCEPTION 'invalid bulk audit action';
  END IF;
  IF p_target_table NOT IN ('jobs','leads','customers','quotes','invoices','calls') THEN
    RAISE EXCEPTION 'invalid bulk audit table';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id, metadata)
  VALUES (
    v_owner, auth.uid(), v_email, p_action, p_target_table,
    left(array_to_string(v_ids[1:20], ','), 1000)
      || CASE WHEN coalesce(array_length(p_target_ids, 1), 0) > 20
           THEN ' (+' || (array_length(p_target_ids, 1) - 20) || ' more)' ELSE '' END,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('target_ids', to_jsonb(v_ids))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_bulk_audit_event(text, text, text[], jsonb) TO authenticated;
