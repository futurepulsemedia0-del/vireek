/*
# Lead source attribution on calls

## Why
Owners want to know which marketing channel (Google Ads, referral,
organic, etc.) actually produces booked jobs, not just raw call volume.

## What this does
- Adds `lead_source text` (nullable) to calls. NULL means "unknown /
  not tagged yet" — purely additive, no backfill needed.
- Constrains it to a known set of channels so the attribution report
  can't be polluted by free-text typos. "other" is the escape hatch.
- Indexes it (alongside user_id) for the GROUP BY the attribution
  report runs.
*/

ALTER TABLE calls
ADD COLUMN IF NOT EXISTS lead_source text
  CHECK (lead_source IS NULL OR lead_source IN (
    'google_ads', 'facebook_ads', 'referral', 'organic', 'direct', 'other'
  ));

CREATE INDEX IF NOT EXISTS idx_calls_lead_source ON calls (user_id, lead_source);
