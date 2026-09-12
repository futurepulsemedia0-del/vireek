/*
# Surge / Storm Mode

## Why
Home-service call volume can spike 3-10x in hours after a regional weather
event (hailstorm, hard freeze, hurricane, flood) — mostly HVAC, roofing,
plumbing, and restoration. There was no way for a business to tell Sarah
"we're in a surge right now" so she can shorten calls, prioritize triage,
and set honest expectations about callback time, and no way for the
business's own dashboard to visually flag that it's happening.

## What this does
Adds three columns to `business_profile`:

- `surge_mode_active` boolean, default false — the on/off switch, set by
  the business owner from the dashboard (BusinessProfilePage).
- `surge_mode_note` text, nullable — a short free-text note describing the
  event (e.g. "Hailstorm across the metro — expect a high volume of roof
  and gutter calls"), surfaced to Sarah via the `check_business_status`
  tool (see supabase/functions/vapi-webhook/index.ts) and to the team via
  the dashboard banner (see src/components/SurgeModeBanner.tsx).
- `surge_mode_activated_at` timestamptz, nullable — set whenever
  `surge_mode_active` flips to true; used purely to key the dashboard
  banner's per-activation dismissal (so a *new* surge always reappears
  even if a past one was dismissed) and to show "active since" in the UI.
  Not a source of truth for on/off — `surge_mode_active` is.

All three default to NULL/false, purely additive, no RLS changes needed —
`business_profile` is already scoped per-user by its existing policies.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS surge_mode_active boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS surge_mode_note text,
ADD COLUMN IF NOT EXISTS surge_mode_activated_at timestamptz;
