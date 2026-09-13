/*
# Quote follow-up tracking + financing mention

## Why
`leads.stage` already has a 'quoted' value (see LeadsPage.tsx's kanban), but
there was no way to record what was actually quoted, when, or whether anyone
followed up on it — the exact gap ServiceTitan's "Follow-Ups" tab fills.
Deliberately NOT building a full estimates/invoicing system here (line items,
PDF generation, e-signature) — that's real FSM territory and out of scope by
design. This is just enough structure for a business to see which quotes are
sitting unconverted and follow up (manually today, via automation later
through the existing outbound_campaigns table if they choose to).

Also adds a lightweight, free-text financing mention to `business_profile` —
not a payment integration, just a note ("financed through Wisetack, 0% APR
available") a business can configure once and reference when quoting or
following up. Actually getting Sarah to *say* this on a live call requires
adding it to the Vapi assistant's own prompt/FAQ config — see the comment
on the `financing_note` column below and the note left in
supabase/functions/vapi-webhook/index.ts.

## What this does

`leads` — four nullable columns, all additive:
- `quote_amount` numeric — what was quoted, in dollars.
- `quote_sent_at` timestamptz — when the quote was given.
- `follow_up_count` integer, default 0 — how many times someone has
  followed up since the quote was sent.
- `last_follow_up_at` timestamptz — most recent follow-up.

`business_profile` — two nullable text columns:
- `financing_partner_name` — e.g. "Wisetack", left blank if not offered.
- `financing_note` — free text describing the offer, e.g. "0% APR for
  12 months on jobs over $500". Shown in the dashboard's Quotes page and
  meant to be copied into the Vapi assistant prompt/FAQ config so Sarah can
  actually mention it — see the note above.

No RLS changes needed — both tables are already scoped per-user by their
existing policies.
*/

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS quote_amount numeric,
ADD COLUMN IF NOT EXISTS quote_sent_at timestamptz,
ADD COLUMN IF NOT EXISTS follow_up_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_follow_up_at timestamptz;

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS financing_partner_name text,
ADD COLUMN IF NOT EXISTS financing_note text;
