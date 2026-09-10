/*
  # Add missing "operations" columns to business_profile

  ## Why
  src/pages/OnboardingPage.tsx (step 2, "Your operations") collects
  primary_industry, team_size, current_call_handling, scheduling_tool,
  avg_job_value and handles_emergency_calls, and src/lib/supabase.ts's
  `BusinessProfile` type has declared these columns for a while — but no
  migration ever actually added them to the `business_profile` table.

  Every call to `saveBusinessProfile()` (src/pages/OnboardingPage.tsx),
  which runs as part of finishing onboarding, upserts a payload containing
  these six keys. Postgres rejects the upsert outright because the columns
  don't exist, `handleFinish` throws, and onboarding can never complete —
  for any account, every time — which is why users end up bounced back to
  step 1 no matter how many times (or with how many different emails) they
  try.

  ## What this does
  Adds the six missing columns as nullable text (avg_job_value as numeric),
  matching the shape already declared in `BusinessProfile`. Purely additive
  — `IF NOT EXISTS` guards make this safe to run even if some of these
  were already added by hand.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS primary_industry text,
ADD COLUMN IF NOT EXISTS team_size text,
ADD COLUMN IF NOT EXISTS current_call_handling text,
ADD COLUMN IF NOT EXISTS scheduling_tool text,
ADD COLUMN IF NOT EXISTS avg_job_value numeric,
ADD COLUMN IF NOT EXISTS handles_emergency_calls text;
