/*
  Unified Onboarding — wizard progress tracking
  ------------------------------------------------------------
  The unified onboarding wizard (business info -> operations -> hours ->
  phone -> calendar -> Sarah setup -> knowledge -> test call -> confirm ->
  launch) needs somewhere durable to remember which step an account left
  off on, plus a couple of small choices (calendar provider, whether the
  test call was completed) that don't have a dedicated column anywhere
  else.

  A single JSONB column keeps this additive and low-risk: no existing
  column is touched, no existing row shape changes, and future tweaks to
  what the wizard tracks don't require another migration.
*/

alter table public.business_profile
  add column if not exists onboarding_wizard_state jsonb not null default '{}'::jsonb;

comment on column public.business_profile.onboarding_wizard_state is
  'Unified onboarding wizard progress: { current_step, completed_steps, calendar_provider, test_call_completed, updated_at }. Written by src/pages/onboarding/useOnboardingWizard.ts.';
