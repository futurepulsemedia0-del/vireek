-- New Trial accounts include 60 minutes (was 50).
--
-- SAFE / METADATA-ONLY: SET DEFAULT affects only profiles inserted AFTER this migration (handle_new_user() inserts
-- (id, email) and relies on the column default). It does NOT rewrite any existing row, so every existing customer keeps
-- the minutes_included they already have (grandfathered).
--
-- Keep in sync with FREE_MINUTES_INCLUDED (supabase/functions/_shared/billing/planCatalog.ts), FREE_MINUTES
-- (supabase/functions/_shared/fraud/planLimits.ts) and the Trial plan in src/lib/pricing.ts.
--
-- Rollback (also only affects future rows):
--   ALTER TABLE public.profiles ALTER COLUMN minutes_included SET DEFAULT 50;

ALTER TABLE public.profiles
  ALTER COLUMN minutes_included SET DEFAULT 60;
