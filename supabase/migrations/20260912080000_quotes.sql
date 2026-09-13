/*
  # Quotes / Estimates

  A real estimates workflow: build a line-item quote, send a link, let the
  customer accept or decline it themselves — same token-based public-access
  pattern as customer self-reschedule (SECURITY DEFINER functions, RLS stays
  closed to the public).
*/

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  line_items jsonb NOT NULL DEFAULT '[]',
  tax_percent numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  quote_token uuid NOT NULL DEFAULT gen_random_uuid(),
  valid_until date,
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_token ON quotes(quote_token);
CREATE INDEX IF NOT EXISTS idx_quotes_user_id ON quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_quotes" ON quotes;
CREATE POLICY "select_own_quotes" ON quotes FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_quotes" ON quotes;
CREATE POLICY "insert_own_quotes" ON quotes FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_quotes" ON quotes;
CREATE POLICY "update_own_quotes" ON quotes FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_quotes" ON quotes;
CREATE POLICY "delete_own_quotes" ON quotes FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Public, token-gated lookup — no other quotes, no other customers, and
-- never exposes a quote that's still a draft.
CREATE OR REPLACE FUNCTION public.get_quote_for_token(p_token uuid)
RETURNS TABLE (
  quote_id uuid,
  customer_name text,
  line_items jsonb,
  tax_percent numeric,
  status text,
  valid_until date,
  business_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.id, q.customer_name, q.line_items, q.tax_percent, q.status, q.valid_until, p.company_name
  FROM quotes q
  JOIN profiles p ON p.id = q.user_id
  WHERE q.quote_token = p_token AND q.status <> 'draft'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_quote_for_token(uuid) TO anon, authenticated;

-- The only write path a customer gets: token-scoped, status-checked.
CREATE OR REPLACE FUNCTION public.respond_to_quote_by_token(p_token uuid, p_response text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote_id uuid;
  v_status text;
  v_lead_id uuid;
BEGIN
  IF p_response NOT IN ('accepted', 'declined') THEN
    RETURN false;
  END IF;

  SELECT id, status, lead_id INTO v_quote_id, v_status, v_lead_id
  FROM quotes WHERE quote_token = p_token;

  IF v_quote_id IS NULL OR v_status <> 'sent' THEN
    RETURN false;
  END IF;

  UPDATE quotes
  SET status = p_response, responded_at = now()
  WHERE id = v_quote_id;

  IF p_response = 'accepted' AND v_lead_id IS NOT NULL THEN
    UPDATE leads SET stage = 'won' WHERE id = v_lead_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_quote_by_token(uuid, text) TO anon, authenticated;
