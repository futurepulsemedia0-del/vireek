/*
  # Lead-marketplace ingestion (Angi, HomeAdvisor, Thumbtack, Nextdoor, Google LSA)

  ## What this adds
  - `leads.source / source_cost_cents / source_external_id / first_response_at`
    so every marketplace lead carries WHERE it came from and WHAT it cost.
  - `lead_marketplace_sources`  — per-tenant, per-provider config: on/off,
    auto-respond on/off, default lead cost, booking link, timezone and the
    secret webhook token. Owner-only (the token is a credential).
  - `lead_marketplace_events`   — one row per inbound webhook/email: raw payload
    (purged after 30 days by the sweeper), parsed fields, dedupe key, cost,
    auto-response status and the measured response time in ms. Written ONLY by
    edge functions (service role); tenants can read, never write.
  - `lead_marketplace_cost_report(from, to)` — per-provider leads, spend,
    booked jobs, cost per lead, cost per BOOKED JOB, response-time p50/p95 and
    % answered inside the 60 s SLA.

  ## Definitions (so the numbers are auditable)
  - "Booked" = the lead has >= 1 non-cancelled job, linked by `jobs.lead_id`, OR
    by the same phone (last 10 digits) on a job created after the lead arrived
    (many jobs are keyed in by hand without a lead_id).
  - A lead with several jobs counts as ONE booked lead, so repeat work never
    flatters cost-per-booked-job. `booked_jobs` is reported separately.
  - Spend = sum of known lead costs. Leads with unknown cost are counted in
    `leads_unknown_cost` so the UI can warn that spend is understated.
  - Cohort semantics: leads RECEIVED in the window; a booking that happens after
    the window end is not counted (same convention as demand_os_campaign_economics).

  ## Security
  RLS everywhere. `get_account_owner_id()` for reads (team members see the
  report), `auth.uid()` for source writes/reads (owner only, token is a secret).
  Not added to supabase_realtime on purpose.
*/

-- ============================================================
-- 1. Lead columns
-- ============================================================
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS source_cost_cents bigint CHECK (source_cost_cents IS NULL OR source_cost_cents >= 0),
  ADD COLUMN IF NOT EXISTS source_external_id text,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_user_source ON leads(user_id, source) WHERE source IS NOT NULL;

-- ============================================================
-- 2. Per-tenant provider configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_marketplace_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  provider text NOT NULL CHECK (provider IN ('angi', 'homeadvisor', 'thumbtack', 'nextdoor', 'google_lsa')),
  enabled boolean NOT NULL DEFAULT true,
  auto_respond_enabled boolean NOT NULL DEFAULT true,
  -- NULL = unknown. Used only when the payload/email carries no cost.
  default_cost_cents bigint CHECK (default_cost_cents IS NULL OR default_cost_cents >= 0),
  booking_url text,
  timezone text NOT NULL DEFAULT 'America/New_York',
  sms_quiet_hours boolean NOT NULL DEFAULT true,
  webhook_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE lead_marketplace_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lms_select_owner" ON lead_marketplace_sources;
CREATE POLICY "lms_select_owner" ON lead_marketplace_sources
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "lms_insert_owner" ON lead_marketplace_sources;
CREATE POLICY "lms_insert_owner" ON lead_marketplace_sources
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "lms_update_owner" ON lead_marketplace_sources;
CREATE POLICY "lms_update_owner" ON lead_marketplace_sources
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "lms_delete_owner" ON lead_marketplace_sources;
CREATE POLICY "lms_delete_owner" ON lead_marketplace_sources
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_lead_marketplace_sources_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_marketplace_sources_updated_at ON lead_marketplace_sources;
CREATE TRIGGER trg_lead_marketplace_sources_updated_at
  BEFORE UPDATE ON lead_marketplace_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_lead_marketplace_sources_updated_at();

-- ============================================================
-- 3. Inbound events (service-role writes only)
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_marketplace_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_id uuid REFERENCES lead_marketplace_sources(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('angi', 'homeadvisor', 'thumbtack', 'nextdoor', 'google_lsa')),
  received_via text NOT NULL CHECK (received_via IN ('webhook', 'email')),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'lead_created', 'parse_failed', 'error')),
  parse_error text,
  dedupe_key text,
  external_id text,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  parsed jsonb,
  raw_payload text,
  cost_cents bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  cost_source text CHECK (cost_source IS NULL OR cost_source IN ('parsed', 'default')),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Auto-response (SLA = 60 s from received_at)
  auto_respond_status text NOT NULL DEFAULT 'pending'
    CHECK (auto_respond_status IN (
      'pending', 'sent', 'failed', 'deferred_quiet_hours',
      'skipped_disabled', 'skipped_no_contact', 'not_applicable'
    )),
  auto_respond_channel text,
  auto_respond_error text,
  auto_respond_ai boolean NOT NULL DEFAULT false,
  attempt_count integer NOT NULL DEFAULT 0,
  responded_at timestamptz,
  response_ms integer CHECK (response_ms IS NULL OR response_ms >= 0),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_lme_user_received ON lead_marketplace_events(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_lme_user_provider ON lead_marketplace_events(user_id, provider, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_lme_lead ON lead_marketplace_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_lme_sweep ON lead_marketplace_events(received_at)
  WHERE auto_respond_status IN ('pending', 'failed', 'deferred_quiet_hours');

ALTER TABLE lead_marketplace_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lme_select_account" ON lead_marketplace_events;
CREATE POLICY "lme_select_account" ON lead_marketplace_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Intentionally NO insert/update/delete policies: only edge functions (service role) write.

-- ============================================================
-- 4. Cost-per-booked-job report
-- ============================================================
CREATE OR REPLACE FUNCTION public.lead_marketplace_cost_report(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  provider text,
  leads bigint,
  leads_unknown_cost bigint,
  spend_cents bigint,
  booked_leads bigint,
  booked_jobs bigint,
  revenue_cents bigint,
  cost_per_lead_cents bigint,
  cost_per_booked_job_cents bigint,
  booking_rate numeric,
  responded_leads bigint,
  within_sla_leads bigint,
  median_response_seconds numeric,
  p95_response_seconds numeric
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH ev AS (
    SELECT e.user_id, e.provider, e.lead_id, e.cost_cents, e.response_ms, e.received_at,
           CASE WHEN length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) >= 10
                THEN right(regexp_replace(l.phone, '\D', '', 'g'), 10) END AS phone10
    FROM lead_marketplace_events e
    LEFT JOIN leads l ON l.id = e.lead_id
    WHERE e.user_id = public.get_account_owner_id()
      AND e.status = 'lead_created'
      AND e.received_at >= p_from
      AND e.received_at < p_to
  ),
  jn AS (
    SELECT ev.*, b.n_jobs, b.rev
    FROM ev
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS n_jobs,
             COALESCE(sum(j.invoice_amount) FILTER (WHERE j.invoice_status = 'paid'), 0) AS rev
      FROM jobs j
      WHERE j.user_id = ev.user_id
        AND j.job_status <> 'cancelled'
        AND (
          j.lead_id = ev.lead_id
          OR (ev.phone10 IS NOT NULL
              AND j.created_at >= ev.received_at
              AND right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10) = ev.phone10)
        )
    ) b ON true
  )
  SELECT
    jn.provider,
    count(*)::bigint,
    count(*) FILTER (WHERE jn.cost_cents IS NULL)::bigint,
    COALESCE(sum(jn.cost_cents), 0)::bigint,
    count(*) FILTER (WHERE COALESCE(jn.n_jobs, 0) > 0)::bigint,
    COALESCE(sum(jn.n_jobs), 0)::bigint,
    round(COALESCE(sum(jn.rev), 0) * 100)::bigint,
    CASE WHEN count(*) > 0
         THEN round(COALESCE(sum(jn.cost_cents), 0)::numeric / count(*))::bigint END,
    CASE WHEN count(*) FILTER (WHERE COALESCE(jn.n_jobs, 0) > 0) > 0
         THEN round(COALESCE(sum(jn.cost_cents), 0)::numeric
                    / count(*) FILTER (WHERE COALESCE(jn.n_jobs, 0) > 0))::bigint END,
    round(count(*) FILTER (WHERE COALESCE(jn.n_jobs, 0) > 0)::numeric / NULLIF(count(*), 0), 4),
    count(*) FILTER (WHERE jn.response_ms IS NOT NULL)::bigint,
    count(*) FILTER (WHERE jn.response_ms IS NOT NULL AND jn.response_ms <= 60000)::bigint,
    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY jn.response_ms) / 1000.0)::numeric, 1),
    round((percentile_cont(0.95) WITHIN GROUP (ORDER BY jn.response_ms) / 1000.0)::numeric, 1)
  FROM jn
  GROUP BY jn.provider
  ORDER BY COALESCE(sum(jn.cost_cents), 0) DESC, jn.provider;
$$;

REVOKE ALL ON FUNCTION public.lead_marketplace_cost_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_marketplace_cost_report(timestamptz, timestamptz) TO authenticated;

/*
  ## Scheduling the retry sweeper (run once, after deploying the function)
  Retries stuck/failed/quiet-hours auto-responses and purges raw payloads > 30 days.
  See docs/lead-marketplace-ingestion.md for the exact cron.schedule() statement.
*/
