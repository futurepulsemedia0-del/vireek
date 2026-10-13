-- =============================================================
-- GLOBAL SEARCH (Cmd+K)
-- One ranked, permission-aware RPC across customers, jobs, quotes,
-- invoices, equipment, team members, knowledge articles, leads and calls.
--
-- Design:
--   * SECURITY INVOKER  -> every table's existing RLS still applies. The
--     RPC can never return a row the caller could not already SELECT.
--   * Explicit account scoping (get_account_owner_id) so the planner can use
--     the user_id indexes, in addition to RLS.
--   * pg_trgm GIN indexes for substring / typo-tolerant matching and a
--     'simple'-config full-text index for knowledge articles (language
--     neutral, so it works for English, Persian, Arabic, Spanish...).
--   * Invoices are only returned to users who may view billing.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- -------------------------------------------------------------
-- 1. Indexes (expressions MUST match the RPC predicates exactly)
-- -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_gs_customers_name_trgm
  ON customers USING gin (lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_customers_email_trgm
  ON customers USING gin (lower(coalesce(email, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_customers_address_trgm
  ON customers USING gin (lower(coalesce(address, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_customers_phone_trgm
  ON customers USING gin (regexp_replace(coalesce(phone, ''), '\D', '', 'g') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gs_jobs_customer_trgm
  ON jobs USING gin (lower(customer_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_jobs_service_trgm
  ON jobs USING gin (lower(coalesce(service_type, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_jobs_address_trgm
  ON jobs USING gin (lower(coalesce(address, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gs_quotes_customer_trgm
  ON quotes USING gin (lower(customer_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_quotes_email_trgm
  ON quotes USING gin (lower(coalesce(customer_email, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gs_invoices_number_trgm
  ON invoices USING gin (lower(coalesce(invoice_number, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_invoices_customer_trgm
  ON invoices USING gin (lower(customer_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_invoices_email_trgm
  ON invoices USING gin (lower(coalesce(customer_email, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gs_equipment_make_trgm
  ON equipment USING gin (lower(coalesce(make, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_equipment_model_trgm
  ON equipment USING gin (lower(coalesce(model, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_equipment_serial_trgm
  ON equipment USING gin (lower(coalesce(serial_number, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gs_team_name_trgm
  ON team_members USING gin (lower(coalesce(member_name, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_team_email_trgm
  ON team_members USING gin (lower(member_email) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gs_knowledge_title_trgm
  ON knowledge_articles USING gin (lower(title) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_knowledge_fts
  ON knowledge_articles USING gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, ''))
  );

CREATE INDEX IF NOT EXISTS idx_gs_leads_name_trgm
  ON leads USING gin (lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gs_calls_name_trgm
  ON calls USING gin (lower(coalesce(caller_name, '')) gin_trgm_ops);

-- -------------------------------------------------------------
-- 2. Scoring helper: exact > prefix > word-start > substring,
--    plus a trigram-similarity tiebreaker. Range roughly 0..1.4.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_text_score(p_q text, p_text text)
RETURNS real
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions
AS $$
  SELECT CASE
    WHEN p_text IS NULL OR p_text = '' OR p_q IS NULL OR p_q = '' THEN 0::real
    ELSE (
      CASE
        WHEN lower(p_text) = p_q THEN 1.0
        WHEN starts_with(lower(p_text), p_q) THEN 0.7
        WHEN position(' ' || p_q IN lower(p_text)) > 0 THEN 0.5
        WHEN position(p_q IN lower(p_text)) > 0 THEN 0.3
        ELSE 0.0
      END
      + similarity(lower(p_text), p_q) * 0.4
    )::real
  END;
$$;

-- -------------------------------------------------------------
-- 3. Billing permission check, mirroring AuthContext:
--    owner => true; team member => custom role overrides base permissions.
--    SECURITY DEFINER only so a team member can read their own role row.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_can_view_billing()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (cr.permissions ->> 'can_view_billing')::boolean,
        (tm.permissions ->> 'can_view_billing')::boolean,
        false
      )
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ),
    true
  );
$$;

-- -------------------------------------------------------------
-- 4. The search RPC
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.global_search(
  p_query text,
  p_types text[] DEFAULT NULL,
  p_limit integer DEFAULT 24
)
RETURNS TABLE (
  entity_type text,
  entity_id uuid,
  title text,
  subtitle text,
  parent_id uuid,
  status text,
  score real,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
#variable_conflict use_column
DECLARE
  v_q           text := left(lower(btrim(coalesce(p_query, ''))), 80);
  v_like        text;
  v_digits      text;
  v_digits_like text;
  v_has_digits  boolean;
  v_ts          tsquery;
  v_limit       integer := least(greatest(coalesce(p_limit, 24), 1), 50);
  v_per         integer;
  v_owner       uuid;
  v_billing     boolean;
  w_customer    boolean := p_types IS NULL OR 'customer' = ANY (p_types);
  w_job         boolean := p_types IS NULL OR 'job' = ANY (p_types);
  w_quote       boolean := p_types IS NULL OR 'quote' = ANY (p_types);
  w_invoice     boolean := p_types IS NULL OR 'invoice' = ANY (p_types);
  w_equipment   boolean := p_types IS NULL OR 'equipment' = ANY (p_types);
  w_team        boolean := p_types IS NULL OR 'team' = ANY (p_types);
  w_knowledge   boolean := p_types IS NULL OR 'knowledge' = ANY (p_types);
  w_lead        boolean := p_types IS NULL OR 'lead' = ANY (p_types);
  w_call        boolean := p_types IS NULL OR 'call' = ANY (p_types);
BEGIN
  IF auth.uid() IS NULL OR char_length(v_q) < 2 THEN
    RETURN;
  END IF;

  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN
    RETURN;
  END IF;

  v_billing     := public.search_can_view_billing();
  v_like        := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits      := regexp_replace(v_q, '\D', '', 'g');
  v_has_digits  := char_length(v_digits) >= 3;
  v_digits_like := '%' || v_digits || '%';
  v_per         := least(8, v_limit);

  -- Prefix full-text query ("furn" matches "furnace"), built from sanitised words.
  SELECT to_tsquery('simple', string_agg(quote_literal(s.w) || ':*', ' & '))
    INTO v_ts
    FROM (
      SELECT regexp_replace(x, '[''\\:&|!()<>*]', '', 'g') AS w
      FROM regexp_split_to_table(v_q, '[\s,;/]+') AS x
    ) s
   WHERE s.w <> '';

  RETURN QUERY
  SELECT r.entity_type, r.entity_id, r.title, r.subtitle, r.parent_id, r.status, r.score, r.created_at
  FROM (
    -- CUSTOMERS ------------------------------------------------
    (SELECT 'customer'::text AS entity_type, c.id AS entity_id, c.name AS title,
            concat_ws(' · ', nullif(c.phone, ''), nullif(c.email, ''), nullif(c.address, '')) AS subtitle,
            NULL::uuid AS parent_id, c.lifecycle_stage AS status,
            (1.0 * greatest(
               search_text_score(v_q, c.name),
               0.85 * search_text_score(v_q, c.email),
               0.6 * search_text_score(v_q, c.address),
               CASE WHEN v_has_digits AND regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') LIKE v_digits_like THEN 0.9 ELSE 0 END
            ))::real AS score,
            c.created_at AS created_at
       FROM customers c
      WHERE w_customer AND c.user_id = v_owner
        AND (lower(c.name) LIKE v_like
          OR lower(c.name) % v_q
          OR lower(coalesce(c.email, '')) LIKE v_like
          OR lower(coalesce(c.address, '')) LIKE v_like
          OR (v_has_digits AND regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') LIKE v_digits_like))
      ORDER BY score DESC, c.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- JOBS -----------------------------------------------------
    (SELECT 'job'::text, j.id, j.customer_name,
            concat_ws(' · ', nullif(j.service_type, ''), nullif(j.address, ''),
                      to_char(j.scheduled_datetime, 'Mon DD')),
            NULL::uuid, j.job_status,
            (0.95 * greatest(
               search_text_score(v_q, j.customer_name),
               0.8 * search_text_score(v_q, j.service_type),
               0.6 * search_text_score(v_q, j.address)
            ))::real,
            j.created_at
       FROM jobs j
      WHERE w_job AND j.user_id = v_owner
        AND (lower(j.customer_name) LIKE v_like
          OR lower(coalesce(j.service_type, '')) LIKE v_like
          OR lower(coalesce(j.address, '')) LIKE v_like
          OR lower(j.customer_name) % v_q)
      ORDER BY 7 DESC, j.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- QUOTES ---------------------------------------------------
    (SELECT 'quote'::text, q.id, q.customer_name,
            concat_ws(' · ', q.status, nullif(q.customer_email, ''), nullif(q.customer_phone, '')),
            NULL::uuid, q.status,
            (0.9 * greatest(
               search_text_score(v_q, q.customer_name),
               0.8 * search_text_score(v_q, q.customer_email),
               CASE WHEN v_has_digits AND regexp_replace(coalesce(q.customer_phone, ''), '\D', '', 'g') LIKE v_digits_like THEN 0.8 ELSE 0 END
            ))::real,
            q.created_at
       FROM quotes q
      WHERE w_quote AND q.user_id = v_owner
        AND (lower(q.customer_name) LIKE v_like
          OR lower(coalesce(q.customer_email, '')) LIKE v_like
          OR lower(q.customer_name) % v_q
          OR (v_has_digits AND regexp_replace(coalesce(q.customer_phone, ''), '\D', '', 'g') LIKE v_digits_like))
      ORDER BY 7 DESC, q.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- INVOICES (billing permission required) -------------------
    (SELECT 'invoice'::text, i.id,
            concat_ws(' · ', coalesce(i.invoice_number, 'Invoice'), i.customer_name),
            concat_ws(' · ', i.status, nullif(i.customer_email, '')),
            NULL::uuid, i.status,
            (0.9 * greatest(
               search_text_score(v_q, i.invoice_number),
               0.95 * search_text_score(v_q, i.customer_name),
               0.8 * search_text_score(v_q, i.customer_email)
            ))::real,
            i.created_at
       FROM invoices i
      WHERE w_invoice AND v_billing AND i.user_id = v_owner
        AND (lower(coalesce(i.invoice_number, '')) LIKE v_like
          OR lower(i.customer_name) LIKE v_like
          OR lower(coalesce(i.customer_email, '')) LIKE v_like
          OR lower(i.customer_name) % v_q)
      ORDER BY 7 DESC, i.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- EQUIPMENT ------------------------------------------------
    (SELECT 'equipment'::text, e.id,
            coalesce(nullif(btrim(concat_ws(' ', e.make, e.model)), ''), e.equipment_type),
            concat_ws(' · ', e.equipment_type,
                      CASE WHEN nullif(e.serial_number, '') IS NOT NULL THEN 'S/N ' || e.serial_number END,
                      cu.name),
            e.customer_id, e.status,
            (0.85 * greatest(
               search_text_score(v_q, e.serial_number),
               search_text_score(v_q, btrim(concat_ws(' ', e.make, e.model))),
               0.8 * search_text_score(v_q, e.model),
               0.7 * search_text_score(v_q, e.make)
            ))::real,
            e.created_at
       FROM equipment e
       LEFT JOIN customers cu ON cu.id = e.customer_id
      WHERE w_equipment AND e.user_id = v_owner
        AND (lower(coalesce(e.make, '')) LIKE v_like
          OR lower(coalesce(e.model, '')) LIKE v_like
          OR lower(coalesce(e.serial_number, '')) LIKE v_like)
      ORDER BY 7 DESC, e.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- TEAM MEMBERS ---------------------------------------------
    (SELECT 'team'::text, t.id, coalesce(nullif(t.member_name, ''), t.member_email),
            concat_ws(' · ', t.role, t.member_email),
            NULL::uuid, t.invite_status,
            (0.85 * greatest(
               search_text_score(v_q, t.member_name),
               0.9 * search_text_score(v_q, t.member_email)
            ))::real,
            t.created_at
       FROM team_members t
      WHERE w_team AND t.account_owner_id = v_owner
        AND (lower(coalesce(t.member_name, '')) LIKE v_like
          OR lower(t.member_email) LIKE v_like)
      ORDER BY 7 DESC, t.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- KNOWLEDGE ARTICLES (full-text + trigram on title + keywords)
    (SELECT 'knowledge'::text, k.id, k.title,
            coalesce(nullif(k.category, ''), left(k.summary, 80)),
            NULL::uuid, k.status,
            (0.8 * greatest(
               search_text_score(v_q, k.title),
               CASE WHEN v_ts IS NULL THEN 0::real ELSE least(
                 ts_rank_cd(to_tsvector('simple', coalesce(k.title, '') || ' ' || coalesce(k.summary, '') || ' ' || coalesce(k.body, '')), v_ts) * 2,
                 0.9)::real END,
               CASE WHEN EXISTS (SELECT 1 FROM unnest(k.keywords) kw WHERE lower(kw) LIKE v_like) THEN 0.6 ELSE 0 END
            ))::real,
            k.created_at
       FROM knowledge_articles k
      WHERE w_knowledge AND k.user_id = v_owner AND k.status <> 'archived'
        AND (lower(k.title) LIKE v_like
          OR (v_ts IS NOT NULL AND to_tsvector('simple', coalesce(k.title, '') || ' ' || coalesce(k.summary, '') || ' ' || coalesce(k.body, '')) @@ v_ts)
          OR EXISTS (SELECT 1 FROM unnest(k.keywords) kw WHERE lower(kw) LIKE v_like))
      ORDER BY 7 DESC, k.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- LEADS (kept from the previous palette) -------------------
    (SELECT 'lead'::text, l.id, l.name,
            concat_ws(' · ', nullif(l.service_interested, ''), nullif(l.phone, ''), nullif(l.email, '')),
            NULL::uuid, l.stage,
            (0.8 * greatest(
               search_text_score(v_q, l.name),
               0.7 * search_text_score(v_q, l.email),
               CASE WHEN v_has_digits AND regexp_replace(coalesce(l.phone, ''), '\D', '', 'g') LIKE v_digits_like THEN 0.8 ELSE 0 END
            ))::real,
            l.created_at
       FROM leads l
      WHERE w_lead AND l.user_id = v_owner
        AND (lower(l.name) LIKE v_like
          OR lower(l.name) % v_q
          OR lower(coalesce(l.email, '')) LIKE v_like
          OR (v_has_digits AND regexp_replace(coalesce(l.phone, ''), '\D', '', 'g') LIKE v_digits_like))
      ORDER BY 7 DESC, l.created_at DESC
      LIMIT v_per)
    UNION ALL
    -- CALLS (kept from the previous palette) -------------------
    (SELECT 'call'::text, ca.id, coalesce(nullif(ca.caller_name, ''), 'Unknown caller'),
            concat_ws(' · ', nullif(ca.caller_phone, ''), to_char(ca.call_datetime, 'Mon DD')),
            NULL::uuid, ca.status,
            (0.7 * greatest(
               search_text_score(v_q, ca.caller_name),
               CASE WHEN v_has_digits AND regexp_replace(coalesce(ca.caller_phone, ''), '\D', '', 'g') LIKE v_digits_like THEN 0.8 ELSE 0 END
            ))::real,
            ca.call_datetime
       FROM calls ca
      WHERE w_call AND ca.user_id = v_owner
        AND (lower(coalesce(ca.caller_name, '')) LIKE v_like
          OR (v_has_digits AND regexp_replace(coalesce(ca.caller_phone, ''), '\D', '', 'g') LIKE v_digits_like))
      ORDER BY 7 DESC, ca.call_datetime DESC
      LIMIT v_per)
  ) r
  ORDER BY r.score DESC, r.created_at DESC
  LIMIT v_limit;
END;
$$;

-- -------------------------------------------------------------
-- 5. Grants: signed-in users only
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION public.global_search(text, text[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.global_search(text, text[], integer) TO authenticated;

REVOKE ALL ON FUNCTION public.search_can_view_billing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_can_view_billing() TO authenticated;

GRANT EXECUTE ON FUNCTION public.search_text_score(text, text) TO authenticated;

COMMENT ON FUNCTION public.global_search(text, text[], integer) IS
  'Cmd+K global search. SECURITY INVOKER: RLS on every table still applies. Returns ranked rows across customers, jobs, quotes, invoices (billing permission), equipment, team, knowledge, leads, calls.';
