/*
# Commercial vs Residential customer differentiation + SLA fields

## Why
Sameday advertises adapting to "residential priorities and commercial
SLAs" as a competitive differentiator. Today `jobs` has no way to record
whether a customer is a commercial account (often bound by a contract and
a guaranteed response-time SLA) or a residential one, so the AI
receptionist has no signal to tell them apart and always falls back to
residential-style, no-SLA handling.

## What this does
- Adds `customer_type` (text, NOT NULL, default 'residential', constrained
  to 'residential' | 'commercial') to `jobs`.
- Adds `sla_response_hours` (numeric, nullable) — the contracted response
  time in hours for commercial accounts. NULL means no SLA on file.
- Adds `contract_reference` (text, nullable) — a PO number / contract ID /
  free-text note staff or the AI can use to confirm the account on a call.
- Adds `commercial_sla_policy` (text, nullable) to `business_profile` — a
  free-text field the business owner fills in once (e.g. "Commercial
  accounts get a 4-hour response SLA. Confirm the PO number and site
  contact before booking.") that the AI receptionist is given as general
  instructions, instead of hardcoding any specific policy in code.

All four columns are purely additive with safe defaults/NULLs — no
existing row or behavior changes. Setting `customer_type` on a job to
'commercial' and filling in SLA fields is a manual/future-UI step; this
migration only adds the columns. Wiring these into the AI's live context
is done separately in `supabase/functions/vapi-webhook/index.ts`
(`buildCustomerTypeContextVariable` + `toolLookupCustomer`).
*/

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'residential'
  CHECK (customer_type IN ('residential', 'commercial')),
ADD COLUMN IF NOT EXISTS sla_response_hours numeric,
ADD COLUMN IF NOT EXISTS contract_reference text;

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS commercial_sla_policy text;
