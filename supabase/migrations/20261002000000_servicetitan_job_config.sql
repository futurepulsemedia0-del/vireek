/*
  # ServiceTitan job write-back config

  Job creation on ServiceTitan requires a businessUnitId and jobTypeId that
  are specific to each tenant's own ServiceTitan account (there is no
  discoverable default — these must be entered once at connect time, the
  same way client_id/client_secret already are).
*/

ALTER TABLE price_book_connections
  ADD COLUMN IF NOT EXISTS st_business_unit_id text,
  ADD COLUMN IF NOT EXISTS st_job_type_id text;
