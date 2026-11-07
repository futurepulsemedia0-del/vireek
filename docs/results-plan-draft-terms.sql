-- DRAFT Results Plan terms with the recommended structure. NOTHING here is live:
-- a DRAFT row has no effect until staff run rp_staff_approve_terms(). Every number is a PLACEHOLDER for your decision.
-- Run in the Supabase SQL editor AFTER the three Results Plan migrations.
insert into results_plan_pricing_terms (
  name, model, currency,
  base_fee_cents, per_job_cents, tier_price_cents,
  monthly_floor_cents, monthly_cap_cents,
  guarantee_days, guarantee_cap_cents, guarantee_minutes_cap,
  trial_days, fair_use_minutes, confirmed_fallback_days, is_public
) values (
  'DRAFT recommended v1', 'hybrid', 'USD',
  2900, 1500, '{}'::jsonb,        -- $29 base + $15 per verified job, single price (no tiers yet)
  0, 19900,                        -- hard monthly cap on per-job charges: $199
  30, 7900, 400,                   -- 30-day guarantee: base waived, per-job charges capped at $79, 400 minutes
  0, 1500, 14, false               -- no trial (guarantee instead), 1,500 fair-use minutes, confirmed fallback after 14 days, not public yet
) returning id;

-- Review the margin table first (node --experimental-strip-types scripts/results-plan-simulate.ts ...), then:
-- select rp_staff_approve_terms('<id returned above>');
-- select rp_staff_publish_rules('rp-rules-v1');            -- publishes the rules on /how-we-verify
-- update results_plan_pricing_terms set is_public = true where id = '<id>';  -- only if you want the price on /pricing (blocked once approved: set is_public BEFORE approving)
