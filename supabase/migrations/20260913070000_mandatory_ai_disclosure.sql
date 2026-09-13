/*
  # Mandatory AI-voice disclosure on business_profile

  ## Why
  Sarah currently has no field anywhere that guarantees a caller is told
  they're talking to an AI. This isn't a nice-to-have: as of Jan 1, 2025,
  California's AB 2905 (Pub. Util. Code § 2874) requires calls using an
  AI-generated voice to disclose that fact, and the FCC's Feb 2024
  Declaratory Ruling confirms AI-generated voices are treated as
  "artificial voice" under the TCPA. Vireek's own outbound_campaigns
  feature (quote follow-ups, appointment reminders, review-request
  calls — see 20260912020000_outbound_campaigns.sql) places exactly the
  kind of automated outbound calls these rules squarely cover, so this
  isn't a hypothetical edge case.

  Note on scope, for whoever reads this later: AB 2905 and the FCC
  ruling are written around outbound automated calls. Whether they
  extend to an inbound AI receptionist answering a call the customer
  placed is not settled law today. This migration does not depend on
  that being resolved — the two sentences of audio this adds cost
  effectively nothing, and having it on by default for every call is
  the safer posture regardless of how that question eventually settles.

  ## What this adds, and why it's built this way

  - `ai_disclosure_script` (text, not null) — the sentence Sarah says
    disclosing she's an AI. Has a sensible default so no existing
    account breaks, but is editable per-account (tone, language,
    wording) the same way `greeting_script` already is.
  - `ai_disclosure_enabled` (boolean, not null, default true) — locked
    to `true` by a CHECK constraint below. This is deliberate: the ask
    was for a field that cannot be disabled, not just a toggle that
    defaults to on. A CHECK constraint enforces that at the database
    level, so no bug, admin tool, or direct API call can ever flip it
    off — not just the dashboard UI hiding the switch.
  - A second CHECK ensures the script itself can never be saved empty,
    since an empty string would be a silent, technically-still-"enabled"
    way of disabling the disclosure in practice.

  ## Important notes
  1. Purely additive on the existing `business_profile` row — no RLS
     changes needed, current policies already scope this per-account.
  2. This table only stores *what should be said*. Same as
     escalation_phone/assistant_voice/assistant_tone before it, actually
     getting Sarah to say it on a live call means the connected Vapi
     assistant's system prompt / first message must be generated from
     (or start with) this field. That wiring lives outside this repo,
     in the Vapi assistant configuration — see the note in
     src/components/settings/EscalationSettings.tsx for the same
     pattern with escalation.
*/

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS ai_disclosure_script text NOT NULL
    DEFAULT 'This call is answered by an AI voice assistant, not a live person.',
  ADD COLUMN IF NOT EXISTS ai_disclosure_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE business_profile
  DROP CONSTRAINT IF EXISTS business_profile_ai_disclosure_enabled_must_be_true;

ALTER TABLE business_profile
  ADD CONSTRAINT business_profile_ai_disclosure_enabled_must_be_true
  CHECK (ai_disclosure_enabled = true);

ALTER TABLE business_profile
  DROP CONSTRAINT IF EXISTS business_profile_ai_disclosure_script_not_blank;

ALTER TABLE business_profile
  ADD CONSTRAINT business_profile_ai_disclosure_script_not_blank
  CHECK (char_length(btrim(ai_disclosure_script)) > 0);
