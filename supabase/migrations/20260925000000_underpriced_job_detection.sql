/*
  # Underpriced Job Detection

  Flags jobs that were invoiced below what the Price Book says that
  service should cost — the classic way margin quietly leaks out of a
  home-service business (a tech "just wants to close the job" and
  undercuts the book price, or gives a regular customer a discount that
  never gets tracked). This surfaces it per job AND rolled up per
  technician, so an owner can see both "which jobs" and "who."

  ## Matching a job to a Price Book entry
  Jobs are booked over the phone/in the field as free text
  (`jobs.service_type`), not a hard link to `price_book_items` — so this
  adds an OPTIONAL explicit link (`jobs.price_book_item_id`) for exact
  matching going forward (settable from /dashboard/jobs when creating a
  job), with a best-effort text/keyword fallback for jobs that don't have
  one (including every job already in the system today). Priority:
    1. `jobs.price_book_item_id`, if set — always wins, no ambiguity.
    2. Case-insensitive exact match: `price_book_items.service_name` = `jobs.service_type`.
    3. Loose match: `jobs.service_type` contains one of the item's
       `keywords`, or contains/matches the item's `service_name` as a
       substring.
  Text/keyword matching is a heuristic, not a guarantee — a short or
  generic service_name can over-match. The explicit link is always the
  reliable path; the fallback exists so historical data isn't invisible
  to this feature.

  ## New column
  - `jobs.price_book_item_id` (uuid, nullable) — which catalog entry this
    job was actually quoted/booked against.

  ## New views (both security_invoker — always apply the querying user's
  own RLS, exactly like `job_profitability`; never leak across accounts)
  - `underpriced_jobs` — one row per invoiced job that matched a Price
    Book entry (by either path above), with the book's price, the
    invoiced amount, and the gap between them in both cents and percent.
    Contains EVERY matched job, not just underpriced ones (a negative
    `underprice_cents` means the job actually billed ABOVE the book
    price) — the dashboard filters for `underprice_cents > 0` by default
    so an owner can also see the full picture if they want it, the same
    "view returns everything, page decides the threshold" pattern already
    used by /dashboard/profitability.
  - `technician_underpricing_summary` — `underpriced_jobs` rolled up per
    technician: how many of their matched jobs came in under book price,
    the total revenue given away, and their average underprice %.
*/

-- =============================================================
-- COLUMN ADDITION
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS price_book_item_id uuid REFERENCES price_book_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_price_book_item_id ON jobs(price_book_item_id);

-- =============================================================
-- UNDERPRICED_JOBS VIEW
-- =============================================================

CREATE OR REPLACE VIEW underpriced_jobs
WITH (security_invoker = true) AS
SELECT
  j.id AS job_id,
  j.user_id,
  j.customer_name,
  j.service_type,
  j.job_status,
  j.scheduled_datetime,
  j.assigned_technician_id,
  j.invoice_status,
  COALESCE(ROUND(j.invoice_amount * 100), 0)::integer AS invoice_cents,
  match.id AS matched_price_book_item_id,
  match.service_name AS matched_service_name,
  match.match_type,
  match.price_cents AS book_price_cents,
  (match.price_cents - COALESCE(ROUND(j.invoice_amount * 100), 0)::integer) AS underprice_cents,
  CASE
    WHEN match.price_cents > 0 THEN
      ROUND(
        ((match.price_cents - COALESCE(ROUND(j.invoice_amount * 100), 0)::integer)::numeric / match.price_cents::numeric) * 100,
        1
      )
    ELSE NULL
  END AS underprice_pct,
  jp.total_cost_cents,
  jp.gross_profit_cents,
  jp.margin_pct
FROM jobs j
LEFT JOIN LATERAL (
  SELECT
    pbi.id,
    pbi.service_name,
    pbi.price_cents,
    CASE
      WHEN pbi.id = j.price_book_item_id THEN 'linked'
      WHEN lower(pbi.service_name) = lower(j.service_type) THEN 'exact_name'
      ELSE 'keyword'
    END AS match_type
  FROM price_book_items pbi
  WHERE pbi.user_id = j.user_id
    AND pbi.active = true
    AND (
      pbi.id = j.price_book_item_id
      OR (
        j.price_book_item_id IS NULL
        AND j.service_type IS NOT NULL
        AND (
          lower(pbi.service_name) = lower(j.service_type)
          OR j.service_type ILIKE '%' || pbi.service_name || '%'
          OR EXISTS (SELECT 1 FROM unnest(pbi.keywords) kw WHERE j.service_type ILIKE '%' || kw || '%')
        )
      )
    )
  ORDER BY
    (pbi.id = j.price_book_item_id) DESC,
    (lower(pbi.service_name) = lower(j.service_type)) DESC,
    length(pbi.service_name) DESC
  LIMIT 1
) match ON true
LEFT JOIN job_profitability jp ON jp.job_id = j.id
WHERE j.invoice_amount IS NOT NULL
  AND match.id IS NOT NULL;

GRANT SELECT ON underpriced_jobs TO authenticated;

COMMENT ON VIEW underpriced_jobs IS
  'Every invoiced job matched to a Price Book entry, with the gap between the book price and what was actually billed. Positive underprice_cents = billed below book (margin leak); negative = billed above book. security_invoker=true so it always applies the querying user''s own RLS.';

-- =============================================================
-- TECHNICIAN_UNDERPRICING_SUMMARY VIEW
-- =============================================================

CREATE OR REPLACE VIEW technician_underpricing_summary
WITH (security_invoker = true) AS
SELECT
  uj.user_id,
  uj.assigned_technician_id,
  tm.member_name,
  tm.member_email,
  COUNT(*)::integer AS matched_job_count,
  COUNT(*) FILTER (WHERE uj.underprice_cents > 0)::integer AS underpriced_job_count,
  COALESCE(SUM(uj.underprice_cents) FILTER (WHERE uj.underprice_cents > 0), 0)::integer AS total_underpriced_cents,
  ROUND(AVG(uj.underprice_pct) FILTER (WHERE uj.underprice_cents > 0), 1) AS avg_underprice_pct
FROM underpriced_jobs uj
LEFT JOIN team_members tm ON tm.id = uj.assigned_technician_id
GROUP BY uj.user_id, uj.assigned_technician_id, tm.member_name, tm.member_email;

GRANT SELECT ON technician_underpricing_summary TO authenticated;

COMMENT ON VIEW technician_underpricing_summary IS
  'underpriced_jobs rolled up per technician — how often, and by how much, each tech books jobs below Price Book price. security_invoker=true; NULL assigned_technician_id groups unassigned jobs together.';
