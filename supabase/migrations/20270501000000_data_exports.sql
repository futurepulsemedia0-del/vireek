/*
# Data Exports (async CSV / XLSX / PDF)

## What this migration does
Adds the backend for `/dashboard/exports`:

- `export_jobs`      one row per export request (history + status + expiry)
- `can_export_data()` permission helper (owner = always, team member = flag)
- private storage bucket `data-exports` (NO client policies on purpose:
  files are written by the `export-run` edge function with the service role
  and handed out ONLY as short-lived signed URLs)

## Security model
1. Tenant scoping: `export_jobs.user_id` is the ACCOUNT OWNER id
   (`get_account_owner_id()`), same convention as calls / jobs / leads.
2. Permission gate: SELECT requires `can_export_data()`. Owners always pass.
   Team members need `can_export_data` in `team_members.permissions`, or in
   their custom role (custom role value wins when defined).
3. Clients can NEVER insert / update / delete export_jobs. All writes go
   through the edge function (service role), which re-checks permission.
4. Storage: private bucket, zero policies for anon/authenticated.
   Object path = `<account_owner_id>/<job_id>.<ext>`.
5. Files expire (default 7 days). Download links expire in minutes.
*/

-- =============================================================
-- 1. PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_export_data()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    -- Not a team member -> account owner (has own profile row).
    WHEN NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = auth.uid())
      THEN EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    -- Team member: custom role value wins when it defines the flag,
    -- otherwise fall back to the member's own permission flags.
    ELSE COALESCE((
      SELECT CASE
        WHEN cr.permissions ? 'can_export_data'
          THEN (cr.permissions ->> 'can_export_data') = 'true'
        ELSE COALESCE((tm.permissions ->> 'can_export_data') = 'true', false)
      END
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.can_export_data() TO authenticated;

-- =============================================================
-- 2. EXPORT JOBS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                       -- account owner id
  requested_by uuid NOT NULL,                  -- auth user who asked
  requested_by_email text,
  dataset text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 64),
  format text NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'expired')),
  row_count integer,
  truncated boolean NOT NULL DEFAULT false,
  file_path text,
  file_size_bytes bigint,
  error_message text,
  download_count integer NOT NULL DEFAULT 0,
  last_downloaded_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_user_created
  ON public.export_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_user_status
  ON public.export_jobs (user_id, status);

ALTER TABLE public.export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_jobs REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS "export_jobs_select" ON public.export_jobs;
CREATE POLICY "export_jobs_select"
  ON public.export_jobs FOR SELECT
  TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_export_data());

-- Intentionally NO insert / update / delete policies: service role only.

COMMENT ON TABLE public.export_jobs IS
  'Async data export requests (CSV/XLSX/PDF). Written only by the export-run edge function; read by account members holding can_export_data.';

-- Realtime so the history table updates live while a job is processing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'export_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.export_jobs;
  END IF;
END $$;

-- =============================================================
-- 3. PRIVATE STORAGE BUCKET (service-role access only)
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'data-exports', 'data-exports', false, 52428800,   -- 50 MB
  ARRAY[
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- No storage.objects policies for this bucket on purpose.
