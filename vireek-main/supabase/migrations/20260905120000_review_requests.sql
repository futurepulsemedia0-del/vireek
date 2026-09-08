/*
  # Review requests

  Adds support for automated review requests:
  - customer phone on jobs
  - Google review URL on businesses
  - review_requests tracking table
  - RLS policies using auth.uid()
*/

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS customer_phone text;

ALTER TABLE businesses
ADD COLUMN IF NOT EXISTS google_review_url text;


CREATE TABLE IF NOT EXISTS review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'completed', 'declined')),
  rating smallint
    CHECK (rating BETWEEN 1 AND 5),
  sent_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX IF NOT EXISTS idx_review_requests_user_id
ON review_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_review_requests_job_id
ON review_requests(job_id);


ALTER TABLE review_requests
ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "select_own_review_requests"
ON review_requests;

CREATE POLICY "select_own_review_requests"
ON review_requests
FOR SELECT
TO authenticated
USING (user_id = auth.uid());


DROP POLICY IF EXISTS "insert_own_review_requests"
ON review_requests;

CREATE POLICY "insert_own_review_requests"
ON review_requests
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());


DROP POLICY IF EXISTS "update_own_review_requests"
ON review_requests;

CREATE POLICY "update_own_review_requests"
ON review_requests
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());


DROP POLICY IF EXISTS "delete_own_review_requests"
ON review_requests;

CREATE POLICY "delete_own_review_requests"
ON review_requests
FOR DELETE
TO authenticated
USING (user_id = auth.uid());
