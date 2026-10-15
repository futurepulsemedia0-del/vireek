-- SMS compliance dashboard (/dashboard/settings/sms-compliance) reads three
-- existing sources: profiles (A2P status), dnc_suppressions (opt-out log) and
-- consent_records (opt-in proof). No schema change is needed — only indexes so
-- the newest-first, per-account pages stay fast on large tenants.

CREATE INDEX IF NOT EXISTS idx_dnc_suppressions_user_created
  ON dnc_suppressions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_consent_records_sms_ledger
  ON public.consent_records (user_id, created_at DESC)
  WHERE consent_type = 'marketing_sms';
