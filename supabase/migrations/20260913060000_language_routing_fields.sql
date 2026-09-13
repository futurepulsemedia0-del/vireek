/*
  # Language-based call routing fields

  ## Why this migration is needed
  Sarah already answers a call in the caller's own language (see the
  marketing copy in src/components/sections/Emergencyintelligence.tsx and
  HighlightBanner.tsx), but nothing in the schema lets an account owner
  say which language(s) each technician speaks, or gives the technician
  a phone number to actually transfer that call to. Without those two
  fields, "route the Spanish call to the Spanish-speaking technician" is
  not implementable — Sarah has no data to route on and nowhere to send
  the call. This migration adds exactly those fields, additively.

  ## What this adds

  ### team_members
  - `languages` (text[], not null, default '{}') — languages this
    technician speaks fluently enough to take a live call in (e.g.
    'English', 'Spanish'). Mirrors the existing `skills` column added in
    20260912040000_dispatch_fields.sql — same shape, same UI pattern.
  - `member_phone` (text, nullable) — the technician's own direct number.
    Required for `escalated_to` (see below) to actually be dialable;
    team_members had no phone column of any kind before this.

  ### calls
  - `detected_language` (text, nullable) — the language Sarah detected
    for this call (e.g. 'Spanish'). Recorded so it shows up in the call
    log/reporting and so escalate-emergency can route on it.

  ## Important notes
  1. Purely additive — no existing rows, policies, or triggers change.
     RLS already covers both tables via get_account_owner_id(), so no
     new policies are needed.
  2. This migration does NOT change how Sarah talks during a call — that
     logic lives in the Vapi assistant configuration outside this repo
     (see the note at the top of src/components/settings/EscalationSettings.tsx).
     It only adds the data those systems need to make and record a
     language-based routing decision.
  3. Existing technicians will have `languages = '{}'` until an account
     owner fills them in from the Team page — until then, language
     routing simply finds no match and the call falls back to the
     existing single `escalation_phone` on `profiles`, so nothing breaks
     for accounts that don't use this yet.
*/

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS languages text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS member_phone text;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS detected_language text;
