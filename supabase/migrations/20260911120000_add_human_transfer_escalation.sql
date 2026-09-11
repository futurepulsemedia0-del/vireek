-- Adds live-agent escalation ("talk to a human" / warm transfer) support to
-- the existing calls + business_profile.escalation_rules architecture.
--
-- This mirrors the existing `is_emergency` flag/trigger pattern exactly
-- (see 20260831090000_notifications_and_audit_log.sql) but is for a caller
-- explicitly asking to be connected to a live person mid-call, independent
-- of an emergency. business_profile.escalation_rules already supports
-- arbitrary trigger strings (jsonb), so no change is needed there beyond
-- adopting the new convention trigger value "human_request" when you add a
-- rule row (action: "transfer", target: <E.164 number>).

alter table public.calls
  add column if not exists human_transfer_requested boolean not null default false;

comment on column public.calls.human_transfer_requested is
  'True when the caller explicitly asked to speak to a live person during the call (set by the request_human_transfer Vapi tool). Independent of is_emergency.';

create index if not exists idx_calls_human_transfer_requested
  on public.calls (user_id, human_transfer_requested)
  where human_transfer_requested = true;
