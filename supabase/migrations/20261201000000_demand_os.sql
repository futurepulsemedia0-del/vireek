/*
  # Demand OS — Google Ads / Meta Ads / Google LSA -> Booking -> Job -> Profit

  ## Why
  Click-to-Cash (20261115000000) already joins touches, calls, jobs and
  `job_profitability`, but ad SPEND is typed by hand and nothing can ACT on
  the result. This migration adds the real ad-platform layer:

    ad_accounts / ad_account_credentials   connected accounts (tokens are
                                           encrypted AND unreadable by clients)
    ad_campaigns / ad_campaign_daily       synced structure + daily spend
    ad_lsa_leads                           LSA leads (phone-matchable)
    ad_lead_attributions                   lead -> campaign, with method+confidence
    demand_os_campaign_economics()         spend, leads, jobs, revenue, GROSS PROFIT per campaign
    ad_budget_recommendations / _actions   guard-railed budget proposals + audit trail
    ad_conversion_events                   completed-job profit sent BACK to Google/Meta
    demand_os_settings                     mode (off | recommend | autopilot) + guardrails

  ## Security
  * RLS on every table, scoped with `public.get_account_owner_id()` like the rest of the project.
  * Clients can only READ these tables. All writes go through service-role edge functions.
  * `ad_account_credentials` has RLS enabled with NO policies => invisible to clients.
  * Heavy/aggregate functions are SECURITY DEFINER and revoked from anon/authenticated;
    the only client-callable wrappers re-derive the owner from the JWT.
*/

-- ============================================================
-- 0. Click IDs on existing touches (captured by marketing-track)
-- ============================================================
ALTER TABLE marketing_attribution_touches
  ADD COLUMN IF NOT EXISTS gclid text,
  ADD COLUMN IF NOT EXISTS gbraid text,
  ADD COLUMN IF NOT EXISTS wbraid text,
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS fbc text,
  ADD COLUMN IF NOT EXISTS fbp text;

CREATE INDEX IF NOT EXISTS idx_attribution_lead
  ON marketing_attribution_touches(lead_id) WHERE lead_id IS NOT NULL;

-- ============================================================
-- 1. Accounts + credentials
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('google_ads', 'meta_ads', 'google_lsa')),
  external_account_id text NOT NULL,
  login_customer_id text,                       -- Google MCC id, when accessed through a manager
  display_name text,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'error')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, external_account_id)
);

CREATE TABLE IF NOT EXISTS ad_account_credentials (
  account_id uuid PRIMARY KEY REFERENCES ad_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  encrypted_refresh_token text,                 -- AES-GCM, see _shared/ads/common.ts
  encrypted_access_token text,
  access_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ad_account_credentials ENABLE ROW LEVEL SECURITY; -- intentionally no policies

-- ============================================================
-- 2. Campaigns + daily metrics
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('google_ads', 'meta_ads', 'google_lsa')),
  external_id text NOT NULL,                    -- matched against utm_campaign ({campaignid} / {{campaign.id}})
  name text NOT NULL,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('enabled', 'paused', 'removed', 'unknown')),
  daily_budget_cents bigint CHECK (daily_budget_cents IS NULL OR daily_budget_cents >= 0),
  external_budget_ref text,                     -- Google campaign_budget resource name
  budget_editable boolean NOT NULL DEFAULT false, -- false: shared budget, ad-set budgets, LSA
  market_label text,                            -- Market -> channel -> campaign roll-up
  last_budget_change_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_user ON ad_campaigns(user_id, platform);

CREATE TABLE IF NOT EXISTS ad_campaign_daily (
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  day date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  PRIMARY KEY (campaign_id, day)
);
CREATE INDEX IF NOT EXISTS idx_ad_campaign_daily_user_day ON ad_campaign_daily(user_id, day DESC);

CREATE TABLE IF NOT EXISTS ad_lsa_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  external_lead_id text NOT NULL,
  lead_type text,                               -- PHONE_CALL | MESSAGE | BOOKING
  consumer_phone_digits text,                   -- last 10 digits, for lead matching
  created_at_platform timestamptz NOT NULL,
  UNIQUE (account_id, external_lead_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_lsa_leads_phone ON ad_lsa_leads(user_id, consumer_phone_digits);

-- ============================================================
-- 3. Lead -> campaign attribution
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_lead_attributions (
  lead_id uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  campaign_id uuid REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  platform text NOT NULL,
  method text NOT NULL CHECK (method IN ('utm_campaign_id', 'lsa_phone', 'utm_campaign_name', 'call_source_label')),
  confidence numeric(3, 2) NOT NULL,
  click_id text,
  click_id_type text CHECK (click_id_type IS NULL OR click_id_type IN ('gclid', 'gbraid', 'wbraid', 'fbclid')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_lead_attr_campaign ON ad_lead_attributions(user_id, campaign_id);

-- ============================================================
-- 4. Settings, recommendations, audit, conversions
-- ============================================================
CREATE TABLE IF NOT EXISTS demand_os_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  mode text NOT NULL DEFAULT 'recommend' CHECK (mode IN ('off', 'recommend', 'autopilot')),
  max_shift_pct int NOT NULL DEFAULT 15 CHECK (max_shift_pct BETWEEN 1 AND 30),
  cooldown_days int NOT NULL DEFAULT 7 CHECK (cooldown_days BETWEEN 3 AND 30),
  min_spend_cents bigint NOT NULL DEFAULT 30000 CHECK (min_spend_cents >= 0),
  min_jobs int NOT NULL DEFAULT 5 CHECK (min_jobs >= 1),
  maturation_days int NOT NULL DEFAULT 14 CHECK (maturation_days BETWEEN 0 AND 90),
  lookback_days int NOT NULL DEFAULT 60 CHECK (lookback_days BETWEEN 14 AND 365),
  allow_growth boolean NOT NULL DEFAULT false,
  total_daily_cap_cents bigint CHECK (total_daily_cap_cents IS NULL OR total_daily_cap_cents > 0),
  conversion_value_basis text NOT NULL DEFAULT 'gross_profit' CHECK (conversion_value_basis IN ('gross_profit', 'revenue')),
  conversion_delay_days int NOT NULL DEFAULT 3 CHECK (conversion_delay_days BETWEEN 0 AND 30),
  google_conversion_action_id text,             -- numeric id of the offline conversion action
  meta_pixel_id text,                           -- Meta dataset / pixel id for CAPI
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_budget_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'failed', 'reverted')),
  direction text NOT NULL CHECK (direction IN ('increase', 'decrease')),
  current_budget_cents bigint NOT NULL,
  proposed_budget_cents bigint NOT NULL CHECK (proposed_budget_cents >= 0),
  applyable boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  decided_at timestamptz,
  decided_by text                                -- 'user:<uuid>' | 'autopilot'
);
CREATE INDEX IF NOT EXISTS idx_ad_recs_user_status ON ad_budget_recommendations(user_id, status, created_at DESC);
-- At most one open proposal per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_recs_open_per_campaign
  ON ad_budget_recommendations(campaign_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ad_budget_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  recommendation_id uuid REFERENCES ad_budget_recommendations(id) ON DELETE SET NULL,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  platform text NOT NULL,
  old_budget_cents bigint NOT NULL,
  new_budget_cents bigint NOT NULL,
  actor text NOT NULL,
  kind text NOT NULL DEFAULT 'apply' CHECK (kind IN ('apply', 'revert')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_actions_user ON ad_budget_actions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ad_conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('google_ads', 'meta_ads')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  value_cents bigint NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, platform)                      -- idempotent: one conversion per job per platform
);
CREATE INDEX IF NOT EXISTS idx_ad_conv_status ON ad_conversion_events(status, created_at);

-- ============================================================
-- 5. RLS (read-only for clients; writes via service role)
-- ============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_accounts', 'ad_campaigns', 'ad_campaign_daily', 'ad_lsa_leads', 'ad_lead_attributions',
                            'ad_budget_recommendations', 'ad_budget_actions', 'ad_conversion_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "select_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "select_own_%1$s" ON %1$I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "delete_own_ad_accounts" ON ad_accounts;
CREATE POLICY "delete_own_ad_accounts" ON ad_accounts
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

ALTER TABLE demand_os_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_demand_os_settings" ON demand_os_settings;
CREATE POLICY "select_own_demand_os_settings" ON demand_os_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_demand_os_settings" ON demand_os_settings;
-- Settings can switch on autopilot, so only the account OWNER (not a team member) may write them.
CREATE POLICY "insert_own_demand_os_settings" ON demand_os_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_demand_os_settings" ON demand_os_settings;
CREATE POLICY "update_own_demand_os_settings" ON demand_os_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND user_id = auth.uid())
  WITH CHECK (user_id = public.get_account_owner_id() AND user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_demand_os_settings_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_demand_os_settings_updated_at ON demand_os_settings;
CREATE TRIGGER trg_demand_os_settings_updated_at
  BEFORE UPDATE ON demand_os_settings FOR EACH ROW EXECUTE FUNCTION public.set_demand_os_settings_updated_at();

-- ============================================================
-- 6. Functions
-- ============================================================

-- Last 10 digits of a phone number, or NULL when it is too short to match safely.
CREATE OR REPLACE FUNCTION public.demand_os_digits(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 10
              THEN right(regexp_replace(p, '\D', '', 'g'), 10) END;
$$;

-- Links unattributed leads (last 180 days) to ad campaigns. Best evidence wins:
--   0.98 lsa_phone          LSA lead phone == lead phone, lead created within 30d of the LSA lead
--   0.95 utm_campaign_id    touch.utm_campaign == campaign external id (ValueTrack {campaignid} / Meta {{campaign.id}})
--   0.80 utm_campaign_name  touch.utm_campaign == campaign name
--   0.70 call_source_label  call tracking-number label == campaign name
-- Re-linking only ever UPGRADES confidence.
CREATE OR REPLACE FUNCTION public.demand_os_link_leads(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH recent_leads AS (
    SELECT l.id, l.created_at, l.call_id, public.demand_os_digits(l.phone) AS digits
    FROM leads l WHERE l.user_id = p_user_id AND l.created_at > now() - interval '180 days'
  ),
  candidates AS (
    SELECT rl.id AS lead_id, c.id AS campaign_id, c.platform, 'utm_campaign_id'::text AS method, 0.95::numeric AS confidence, t.occurred_at AS ts
    FROM recent_leads rl
    JOIN marketing_attribution_touches t ON t.lead_id = rl.id AND t.user_id = p_user_id
    JOIN ad_campaigns c ON c.user_id = p_user_id AND c.external_id = t.campaign AND c.platform IN ('google_ads', 'meta_ads')
    WHERE t.occurred_at <= rl.created_at + interval '1 hour'
    UNION ALL
    SELECT rl.id, c.id, 'google_lsa', 'lsa_phone', 0.98, ll.created_at_platform
    FROM recent_leads rl
    JOIN ad_lsa_leads ll ON ll.user_id = p_user_id AND ll.consumer_phone_digits = rl.digits
    JOIN ad_campaigns c ON c.id = ll.campaign_id
    WHERE rl.digits IS NOT NULL
      AND rl.created_at BETWEEN ll.created_at_platform - interval '1 day' AND ll.created_at_platform + interval '30 days'
    UNION ALL
    SELECT rl.id, c.id, c.platform, 'utm_campaign_name', 0.80, t.occurred_at
    FROM recent_leads rl
    JOIN marketing_attribution_touches t ON t.lead_id = rl.id AND t.user_id = p_user_id AND t.campaign IS NOT NULL
    JOIN ad_campaigns c ON c.user_id = p_user_id AND lower(btrim(c.name)) = lower(btrim(t.campaign)) AND c.platform IN ('google_ads', 'meta_ads')
    WHERE t.occurred_at <= rl.created_at + interval '1 hour'
    UNION ALL
    SELECT rl.id, c.id, c.platform, 'call_source_label', 0.70, k.call_datetime
    FROM recent_leads rl
    JOIN calls k ON k.id = rl.call_id AND k.source_label IS NOT NULL
    JOIN ad_campaigns c ON c.user_id = p_user_id AND lower(btrim(c.name)) = lower(btrim(k.source_label))
  ),
  best AS (
    SELECT DISTINCT ON (lead_id) lead_id, campaign_id, platform, method, confidence
    FROM candidates ORDER BY lead_id, confidence DESC, ts DESC
  )
  INSERT INTO ad_lead_attributions (lead_id, user_id, campaign_id, platform, method, confidence, click_id, click_id_type)
  SELECT b.lead_id, p_user_id, b.campaign_id, b.platform, b.method, b.confidence, ck.click_id, ck.click_id_type
  FROM best b
  LEFT JOIN LATERAL (
    SELECT COALESCE(t.gclid, t.gbraid, t.wbraid, t.fbclid) AS click_id,
           CASE WHEN t.gclid IS NOT NULL THEN 'gclid' WHEN t.gbraid IS NOT NULL THEN 'gbraid'
                WHEN t.wbraid IS NOT NULL THEN 'wbraid' WHEN t.fbclid IS NOT NULL THEN 'fbclid' END AS click_id_type
    FROM marketing_attribution_touches t
    WHERE t.lead_id = b.lead_id AND t.user_id = p_user_id
      AND (t.gclid IS NOT NULL OR t.gbraid IS NOT NULL OR t.wbraid IS NOT NULL OR t.fbclid IS NOT NULL)
    ORDER BY t.occurred_at DESC LIMIT 1
  ) ck ON true
  ON CONFLICT (lead_id) DO UPDATE
    SET campaign_id = EXCLUDED.campaign_id, platform = EXCLUDED.platform, method = EXCLUDED.method,
        confidence = EXCLUDED.confidence, click_id = COALESCE(EXCLUDED.click_id, ad_lead_attributions.click_id),
        click_id_type = COALESCE(EXCLUDED.click_id_type, ad_lead_attributions.click_id_type)
    WHERE EXCLUDED.confidence > ad_lead_attributions.confidence;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Per-campaign economics for a LEAD COHORT created in [p_start, p_end]:
-- spend is summed over the same dates, so cost and outcome describe the same leads.
-- "Won" = job paid; revenue / gross profit come from job_profitability (real costs).
CREATE OR REPLACE FUNCTION public.demand_os_campaign_economics(p_user_id uuid, p_start date, p_end date)
RETURNS TABLE (
  campaign_id uuid, spend_cents bigint, clicks bigint, impressions bigint, leads bigint,
  jobs_booked bigint, jobs_won bigint, revenue_cents bigint, gross_profit_cents bigint, pipeline_cents bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH spend AS (
    SELECT d.campaign_id, sum(d.cost_cents)::bigint AS spend_cents, sum(d.clicks)::bigint AS clicks, sum(d.impressions)::bigint AS impressions
    FROM ad_campaign_daily d WHERE d.user_id = p_user_id AND d.day BETWEEN p_start AND p_end GROUP BY d.campaign_id
  ),
  cohort AS (
    SELECT a.campaign_id, l.id AS lead_id
    FROM ad_lead_attributions a JOIN leads l ON l.id = a.lead_id
    WHERE a.user_id = p_user_id AND a.campaign_id IS NOT NULL AND l.created_at::date BETWEEN p_start AND p_end
  ),
  lead_counts AS (SELECT c.campaign_id, count(*)::bigint AS leads FROM cohort c GROUP BY c.campaign_id),
  lead_jobs AS (
    SELECT c.campaign_id, j.id AS job_id, j.invoice_status, coalesce(j.invoice_amount, 0) AS invoice_amount
    FROM cohort c JOIN jobs j ON j.lead_id = c.lead_id AND j.user_id = p_user_id
    WHERE j.job_status <> 'cancelled'
  ),
  job_econ AS (
    SELECT lj.campaign_id,
           count(*)::bigint AS booked,
           (count(*) FILTER (WHERE lj.invoice_status = 'paid'))::bigint AS won,
           coalesce(sum(p.revenue_cents) FILTER (WHERE lj.invoice_status = 'paid'), 0)::bigint AS revenue,
           coalesce(sum(p.gross_profit_cents) FILTER (WHERE lj.invoice_status = 'paid'), 0)::bigint AS gp,
           coalesce(sum((lj.invoice_amount * 100)::bigint) FILTER (WHERE lj.invoice_status <> 'paid'), 0)::bigint AS pipeline
    FROM lead_jobs lj LEFT JOIN job_profitability p ON p.job_id = lj.job_id
    GROUP BY lj.campaign_id
  )
  SELECT c.id,
         coalesce(s.spend_cents, 0), coalesce(s.clicks, 0), coalesce(s.impressions, 0),
         coalesce(lc.leads, 0), coalesce(je.booked, 0), coalesce(je.won, 0),
         coalesce(je.revenue, 0), coalesce(je.gp, 0), coalesce(je.pipeline, 0)
  FROM ad_campaigns c
  LEFT JOIN spend s ON s.campaign_id = c.id
  LEFT JOIN lead_counts lc ON lc.campaign_id = c.id
  LEFT JOIN job_econ je ON je.campaign_id = c.id
  WHERE c.user_id = p_user_id;
$$;

-- Client-facing wrapper: owner is derived from the JWT, never from a parameter.
CREATE OR REPLACE FUNCTION public.demand_os_my_economics(p_start date, p_end date)
RETURNS TABLE (
  campaign_id uuid, spend_cents bigint, clicks bigint, impressions bigint, leads bigint,
  jobs_booked bigint, jobs_won bigint, revenue_cents bigint, gross_profit_cents bigint, pipeline_cents bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.demand_os_campaign_economics(public.get_account_owner_id(), p_start, p_end);
$$;

-- Queues completed, paid, ATTRIBUTED jobs to be sent back to the ad platforms.
-- Value = gross profit (default) so bidding optimises for profit, not volume.
CREATE OR REPLACE FUNCTION public.demand_os_enqueue_conversions(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_basis text; v_delay int; v_count integer;
BEGIN
  SELECT s.conversion_value_basis, s.conversion_delay_days INTO v_basis, v_delay
  FROM demand_os_settings s WHERE s.user_id = p_user_id;
  v_basis := coalesce(v_basis, 'gross_profit');
  v_delay := coalesce(v_delay, 3);

  INSERT INTO ad_conversion_events (user_id, job_id, lead_id, platform, status, value_cents, last_error)
  SELECT p_user_id, j.id, a.lead_id, a.platform,
         CASE WHEN v.val <= 0 THEN 'skipped'
              WHEN a.platform = 'google_ads' AND coalesce(a.click_id_type, '') NOT IN ('gclid', 'gbraid', 'wbraid') THEN 'skipped'
              ELSE 'pending' END,
         greatest(v.val, 0),
         CASE WHEN v.val <= 0 THEN 'non_positive_value'
              WHEN a.platform = 'google_ads' AND coalesce(a.click_id_type, '') NOT IN ('gclid', 'gbraid', 'wbraid') THEN 'no_click_id' END
  FROM ad_lead_attributions a
  JOIN jobs j ON j.lead_id = a.lead_id AND j.user_id = p_user_id
  JOIN job_profitability p ON p.job_id = j.id
  CROSS JOIN LATERAL (SELECT (CASE WHEN v_basis = 'revenue' THEN p.revenue_cents ELSE p.gross_profit_cents END)::bigint AS val) v
  WHERE a.user_id = p_user_id AND a.platform IN ('google_ads', 'meta_ads')
    AND j.invoice_status = 'paid' AND j.job_status = 'completed'
    AND coalesce(j.completed_at, j.created_at) <= now() - make_interval(days => v_delay)
  ON CONFLICT (job_id, platform) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Client RPC: label a campaign with its market.
CREATE OR REPLACE FUNCTION public.demand_os_set_market(p_campaign_id uuid, p_label text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE ad_campaigns SET market_label = nullif(left(btrim(p_label), 80), '')
  WHERE id = p_campaign_id AND user_id = public.get_account_owner_id();
$$;

-- Client RPC: Google's LSA API exposes no per-lead cost, so the owner logs
-- LSA spend from the LSA dashboard. It is spread evenly over the period.
CREATE OR REPLACE FUNCTION public.demand_os_log_lsa_spend(p_campaign_id uuid, p_start date, p_end date, p_total_cents bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_days int; v_share bigint;
BEGIN
  IF p_end < p_start OR p_total_cents < 0 OR (p_end - p_start) > 366 THEN RAISE EXCEPTION 'invalid period or amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ad_campaigns WHERE id = p_campaign_id AND user_id = v_owner AND platform = 'google_lsa') THEN
    RAISE EXCEPTION 'campaign not found';
  END IF;
  v_days := (p_end - p_start) + 1;
  v_share := p_total_cents / v_days;
  INSERT INTO ad_campaign_daily (campaign_id, user_id, day, cost_cents)
  SELECT p_campaign_id, v_owner, d::date,
         v_share + CASE WHEN d::date = p_end THEN p_total_cents - v_share * v_days ELSE 0 END
  FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
  ON CONFLICT (campaign_id, day) DO UPDATE SET cost_cents = EXCLUDED.cost_cents;
END;
$$;

-- Lock down: aggregate/system functions are service-role only.
REVOKE ALL ON FUNCTION public.demand_os_link_leads(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.demand_os_campaign_economics(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.demand_os_enqueue_conversions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.demand_os_link_leads(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.demand_os_campaign_economics(uuid, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.demand_os_enqueue_conversions(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.demand_os_my_economics(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.demand_os_set_market(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.demand_os_log_lsa_spend(uuid, date, date, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demand_os_my_economics(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.demand_os_set_market(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.demand_os_log_lsa_spend(uuid, date, date, bigint) TO authenticated;
