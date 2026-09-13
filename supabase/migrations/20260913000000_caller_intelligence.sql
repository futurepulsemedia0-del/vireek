/*
# Caller intelligence: warranty tracking + phone lookup indexes

## Why
The AI receptionist can already look up a caller's history reactively via
the `lookup_customer` tool, but two things a good human CSR does
automatically are still missing:
  1. Knowing whether the customer's most recent job is still under
     warranty, before quoting or booking a new visit for the same issue.
  2. Fast enough phone-number lookups to run at the START of every call
     (see the new `assistant-request` handling in vapi-webhook), not just
     when the AI decides to call a tool mid-conversation.

## What this does
- Adds `warranty_expires_at` (date, nullable) and `warranty_notes` (text,
  nullable) to `jobs`, so a warranty can be recorded per job. Both default
  to NULL — purely additive, no existing behavior changes. Setting these
  is a manual/future-UI step; this migration only adds the columns.
- Adds indexes on `jobs(user_id, customer_phone)` and
  `calls(user_id, caller_phone)`. Neither existed before — the only
  phone-adjacent indexes that ship today are user_id + datetime/status
  (see 20260901120000_realtime_and_perf_indexes.sql), not phone itself.
*/

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS warranty_expires_at date,
ADD COLUMN IF NOT EXISTS warranty_notes text;

CREATE INDEX IF NOT EXISTS idx_jobs_user_customer_phone ON jobs (user_id, customer_phone);
CREATE INDEX IF NOT EXISTS idx_calls_user_caller_phone ON calls (user_id, caller_phone);
