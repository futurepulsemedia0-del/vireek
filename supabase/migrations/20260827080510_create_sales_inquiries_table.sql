/*
# Create sales_inquiries table for pre-signup lead capture

## What this migration does
Creates a `sales_inquiries` table to store leads submitted via the
"Talk to Sales" / "Start Free Trial" form on the public marketing site.
Form submissions insert directly into Supabase.

## New Tables

### sales_inquiries
- `id` (uuid, PK, default gen_random_uuid)
- `full_name` (text, not null) — submitted by visitor
- `email` (text, not null) — submitted by visitor
- `company_name` (text, nullable) — submitted by visitor
- `phone` (text, nullable) — submitted by visitor
- `best_time_to_call` (text, nullable) — "Morning 8-12", "Afternoon 12-5", "Evening 5-8"
- `sms_consent` (boolean, not null, default false) — TCPA consent checkbox
- `status` (text, not null, default 'new') — enum: 'new', 'contacted', 'closed'
- `created_at` (timestamptz, default now)

## Security
- RLS enabled on sales_inquiries.
- INSERT: allowed for anyone (TO anon, authenticated) with no ownership
  check, since this form is for pre-signup visitors who have no account.
  This is intentionally public — the form is on the public marketing site.
- SELECT: restricted to admin users only (role = 'admin' in profiles),
  so only staff can view submitted inquiries.
- UPDATE: restricted to admin users only, so staff can update the status
  of an inquiry (e.g., mark as 'contacted' or 'closed').
- DELETE: restricted to admin users only.

## Important Notes
1. The admin check uses a subquery against profiles where
   role = 'admin' AND id = auth.uid(). This reuses the existing role
   column on profiles (values: 'owner', 'admin', 'member').
2. The status column is constrained with a CHECK to the three allowed
   values: 'new', 'contacted', 'closed'.
3. An index on created_at supports the "newest first" listing in the
   admin panel.
*/

CREATE TABLE IF NOT EXISTS sales_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  email text NOT NULL,
  company_name text,
  phone text,
  best_time_to_call text,
  sms_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_inquiries_created_at ON sales_inquiries (created_at DESC);

ALTER TABLE sales_inquiries ENABLE ROW LEVEL SECURITY;

-- Public INSERT: anyone (including anon) can submit a sales inquiry.
-- This is intentional — the form is on the public marketing site for
-- pre-signup visitors who have no account.
DROP POLICY IF EXISTS "public_insert_sales_inquiries" ON sales_inquiries;
CREATE POLICY "public_insert_sales_inquiries"
ON sales_inquiries FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Admin-only SELECT: only users with role = 'admin' in profiles can view inquiries.
DROP POLICY IF EXISTS "admin_select_sales_inquiries" ON sales_inquiries;
CREATE POLICY "admin_select_sales_inquiries"
ON sales_inquiries FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Admin-only UPDATE: only admins can update the status of an inquiry.
DROP POLICY IF EXISTS "admin_update_sales_inquiries" ON sales_inquiries;
CREATE POLICY "admin_update_sales_inquiries"
ON sales_inquiries FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- Admin-only DELETE: only admins can delete an inquiry.
DROP POLICY IF EXISTS "admin_delete_sales_inquiries" ON sales_inquiries;
CREATE POLICY "admin_delete_sales_inquiries"
ON sales_inquiries FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);
