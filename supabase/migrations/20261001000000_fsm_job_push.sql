-- Tracks whether a booked job was pushed to the connected FSM
-- (ServiceTitan / Jobber / Housecall Pro), and stores the FSM's own id
-- for reconciliation.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fsm_push_status text
  CHECK (fsm_push_status IN ('not_applicable','pending','pushed','failed'))
  DEFAULT 'not_applicable';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fsm_external_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fsm_push_error text;

-- ServiceTitan job type / business unit are per-tenant config, not
-- something Sarah can guess — store them once during onboarding.
ALTER TABLE price_book_connections ADD COLUMN IF NOT EXISTS st_default_job_type_id bigint;
ALTER TABLE price_book_connections ADD COLUMN IF NOT EXISTS st_default_business_unit_id bigint;
