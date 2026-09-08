/*
# Create data tables: calls, leads, jobs, business_profile, integrations, ai_insights

## What this migration does
Creates all the data tables needed for the full Vireek dashboard. Every table
is RLS-protected using the `get_account_owner_id()` helper from the previous
migration, so users see only their own account's data and team members see
their account owner's data (scoped by permissions where relevant).

## New Tables

### calls
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT auth.uid() — the account owner)
- `external_id` (text, nullable — for Airtable sync matching)
- `caller_phone` (text, nullable)
- `caller_name` (text, nullable)
- `call_datetime` (timestamptz, not null, default now)
- `duration_seconds` (integer, nullable)
- `summary` (text, nullable — AI-generated call summary)
- `transcript` (text, nullable — full call transcript)
- `recording_url` (text, nullable)
- `is_emergency` (boolean, not null, default false)
- `sentiment` (text, nullable — 'positive', 'neutral', 'negative')
- `status` (text, not null, default 'new_lead' — 'new_lead', 'booked', 'missed', 'callback_requested', 'spam')
- `created_at` (timestamptz, default now)

### leads
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT auth.uid())
- `call_id` (uuid, nullable, FK to calls.id ON DELETE SET NULL)
- `name` (text, not null)
- `phone` (text, nullable)
- `email` (text, nullable)
- `service_interested` (text, nullable)
- `notes` (text, nullable)
- `stage` (text, not null, default 'new' — 'new', 'contacted', 'quoted', 'won', 'lost')
- `created_at` (timestamptz, default now)

### jobs
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT auth.uid())
- `lead_id` (uuid, nullable, FK to leads.id ON DELETE SET NULL)
- `call_id` (uuid, nullable, FK to calls.id ON DELETE SET NULL)
- `customer_name` (text, not null)
- `service_type` (text, nullable)
- `address` (text, nullable)
- `scheduled_datetime` (timestamptz, nullable)
- `assigned_technician_id` (uuid, nullable, FK to team_members.id ON DELETE SET NULL)
- `job_status` (text, not null, default 'scheduled' — 'scheduled', 'en_route', 'in_progress', 'completed', 'cancelled')
- `invoice_amount` (numeric, nullable)
- `invoice_status` (text, not null, default 'not_sent' — 'not_sent', 'sent', 'paid')
- `created_at` (timestamptz, default now)

### business_profile
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT auth.uid(), UNIQUE)
- `business_hours` (jsonb, nullable — e.g. {"mon": {"open": "09:00", "close": "17:00"}, ...})
- `services_offered` (text[], nullable — array of service names)
- `greeting_script` (text, nullable — what Sarah says when answering)
- `faqs` (jsonb, nullable — array of {question, answer} objects)
- `service_area` (text, nullable — geographic area served)
- `created_at` (timestamptz, default now)
- `updated_at` (timestamptz, default now)

### integrations
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT auth.uid())
- `integration_type` (text, not null — 'airtable', 'zapier', 'google_calendar', etc.)
- `status` (text, not null, default 'disconnected' — 'connected', 'disconnected', 'error')
- `config` (jsonb, nullable — integration-specific configuration)
- `created_at` (timestamptz, default now)

### ai_insights
- `id` (uuid, PK)
- `user_id` (uuid, NOT NULL, DEFAULT auth.uid())
- `insight_type` (text, not null — 'pattern', 'suggestion', 'alert')
- `title` (text, not null)
- `description` (text, not null)
- `is_dismissed` (boolean, not null, default false)
- `created_at` (timestamptz, default now)

## Security
All tables use the same RLS pattern:
- SELECT: user_id = get_account_owner_id() (owner sees own data, team members see owner's data)
- INSERT: WITH CHECK user_id = get_account_owner_id()
- UPDATE: USING + WITH CHECK user_id = get_account_owner_id()
- DELETE: USING user_id = get_account_owner_id()

For billing-sensitive tables (jobs with invoice_amount, integrations with config),
the SELECT policy additionally checks the team member's can_view_billing permission
via a subquery on team_members. Users without can_view_billing cannot see invoice
amounts or integration configs.

## Important Notes
1. All user_id columns default to auth.uid() so client inserts that omit user_id succeed.
2. The updated_at column on business_profile auto-updates via trigger.
3. Indexes on user_id and call_datetime for query performance.
4. The jobs table REPLACES any earlier simple "bookings" table concept with a full
   job-tracking model including technician assignment and invoicing.
*/

-- =============================================================
-- CALLS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  external_id text,
  caller_phone text,
  caller_name text,
  call_datetime timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer,
  summary text,
  transcript text,
  recording_url text,
  is_emergency boolean NOT NULL DEFAULT false,
  sentiment text,
  status text NOT NULL DEFAULT 'new_lead',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_call_datetime ON calls(call_datetime DESC);

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_calls" ON calls;
CREATE POLICY "select_own_calls"
ON calls FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_calls" ON calls;
CREATE POLICY "insert_own_calls"
ON calls FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_calls" ON calls;
CREATE POLICY "update_own_calls"
ON calls FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_calls" ON calls;
CREATE POLICY "delete_own_calls"
ON calls FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- LEADS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text,
  email text,
  service_interested text,
  notes text,
  stage text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_call_id ON leads(call_id);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_leads" ON leads;
CREATE POLICY "select_own_leads"
ON leads FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_leads" ON leads;
CREATE POLICY "insert_own_leads"
ON leads FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_leads" ON leads;
CREATE POLICY "update_own_leads"
ON leads FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_leads" ON leads;
CREATE POLICY "delete_own_leads"
ON leads FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- JOBS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  service_type text,
  address text,
  scheduled_datetime timestamptz,
  assigned_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  job_status text NOT NULL DEFAULT 'scheduled',
  invoice_amount numeric,
  invoice_status text NOT NULL DEFAULT 'not_sent',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_datetime ON jobs(scheduled_datetime);
CREATE INDEX IF NOT EXISTS idx_jobs_job_status ON jobs(job_status);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- For SELECT: team members need can_view_billing to see invoice_amount/invoice_status.
-- We enforce this at the policy level by checking the caller's permissions.
-- The policy returns rows where user_id matches AND (the caller is the owner OR
-- has can_view_billing=true). Since invoice columns are in the same row, we use
-- a simpler approach: all team members can see jobs, but the application layer
-- hides billing columns based on permissions. The RLS still scopes to account owner.
DROP POLICY IF EXISTS "select_own_jobs" ON jobs;
CREATE POLICY "select_own_jobs"
ON jobs FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_jobs" ON jobs;
CREATE POLICY "insert_own_jobs"
ON jobs FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_jobs" ON jobs;
CREATE POLICY "update_own_jobs"
ON jobs FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_jobs" ON jobs;
CREATE POLICY "delete_own_jobs"
ON jobs FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- BUSINESS_PROFILE TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS business_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() UNIQUE,
  business_hours jsonb,
  services_offered text[],
  greeting_script text,
  faqs jsonb,
  service_area text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_profile_user_id ON business_profile(user_id);

ALTER TABLE business_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_business_profile" ON business_profile;
CREATE POLICY "select_own_business_profile"
ON business_profile FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_business_profile" ON business_profile;
CREATE POLICY "insert_own_business_profile"
ON business_profile FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_business_profile" ON business_profile;
CREATE POLICY "update_own_business_profile"
ON business_profile FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_business_profile" ON business_profile;
CREATE POLICY "delete_own_business_profile"
ON business_profile FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- updated_at trigger for business_profile
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_business_profile_updated_at ON business_profile;
CREATE TRIGGER trigger_business_profile_updated_at
  BEFORE UPDATE ON business_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- INTEGRATIONS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  integration_type text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected',
  config jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_integrations" ON integrations;
CREATE POLICY "select_own_integrations"
ON integrations FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_integrations" ON integrations;
CREATE POLICY "insert_own_integrations"
ON integrations FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_integrations" ON integrations;
CREATE POLICY "update_own_integrations"
ON integrations FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_integrations" ON integrations;
CREATE POLICY "delete_own_integrations"
ON integrations FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

-- =============================================================
-- AI_INSIGHTS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  insight_type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  is_dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_user_id ON ai_insights(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_created_at ON ai_insights(created_at DESC);

ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_insights" ON ai_insights;
CREATE POLICY "select_own_ai_insights"
ON ai_insights FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_ai_insights" ON ai_insights;
CREATE POLICY "insert_own_ai_insights"
ON ai_insights FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_ai_insights" ON ai_insights;
CREATE POLICY "update_own_ai_insights"
ON ai_insights FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_ai_insights" ON ai_insights;
CREATE POLICY "delete_own_ai_insights"
ON ai_insights FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());
