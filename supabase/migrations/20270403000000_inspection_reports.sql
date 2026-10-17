/*
  # Inspection Reports (/dashboard/inspection-reports)

  Branded, shareable inspection reports compiled from REAL job data:
    - checklist  -> job_quality_checklist_templates + job_checklist_completions
    - photos     -> jobs.before_photos / after_photos (job-room-photos bucket)
                    and job_evidence_checks.photo_paths (job-evidence-photos bucket)
    - notes      -> jobs.work_performed_notes / completion_notes / diagnosis_notes

  The report row is an IMMUTABLE SNAPSHOT once published (what the customer
  saw is what we keep). One row per report, keyed by the ACCOUNT OWNER's
  profile id (user_id = get_account_owner_id()).

  Access model (same posture as the Unified Inbox / email_settings):
    - Account members can SELECT their account's rows.
    - Every write goes through the service-role `inspection-reports` edge
      function (permission gate + snapshot compilation + signed URLs), so a
      client can never forge checklist/photo evidence or flip a status.
    - Customers read ONLY through the `inspection-report-public` edge
      function using the unguessable share_token; nothing is opened to anon.
    - E-sign reuses the native e-signature system (signature_requests with
      document_type = 'custom', document_id = inspection_reports.id).

  PDFs live in the private `inspection-reports` bucket (no storage policies:
  uploads use signed upload URLs minted by the edge function, reads use
  short-lived signed URLs).
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('inspection-reports', 'inspection-reports', false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS inspection_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  report_number text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'signed', 'voided')),
  overall_result text CHECK (overall_result IS NULL OR overall_result IN ('pass', 'attention', 'fail')),
  summary text CHECK (summary IS NULL OR length(summary) <= 4000),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb,
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,
  address text,
  service_type text,
  inspector_name text,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  share_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  share_enabled boolean NOT NULL DEFAULT false,
  share_expires_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  pdf_path text,
  pdf_generated_at timestamptz,
  published_at timestamptz,
  signed_at timestamptz,
  voided_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inspection_reports_user ON inspection_reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspection_reports_job ON inspection_reports(job_id);

-- One live (draft/published/signed) report per job; a voided one frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inspection_reports_one_active_per_job
  ON inspection_reports(job_id) WHERE status <> 'voided';

ALTER TABLE inspection_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_inspection_reports" ON inspection_reports;
CREATE POLICY "select_account_inspection_reports" ON inspection_reports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
