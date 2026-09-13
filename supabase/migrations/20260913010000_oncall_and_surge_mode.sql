/*
# On-call rotation + Surge Mode

## Why
`business_profile.escalation_rules` already routes emergency/after-hours/
human-request calls, but only to ONE static target per trigger — there was
no way to express "even nights tech A, odd nights tech B" or "weekends go
to a different number." There was also no way for a business owner to
flip on a temporary "Surge Mode" after a storm/heat wave (per the
research: home-service call volume spikes hard right after these events)
to shift the AI's priorities, cap booking volume, and add a heads-up
message — that only ever existed as a marketing idea, never a real
setting.

## What this does
Adds four nullable/defaulted columns to `business_profile`:

- `on_call_schedule` — jsonb array of
    { id, label, phone, rule }
  where `rule` is one of:
    { type: "weekday", days: number[] }         // 0=Sun..6=Sat
    { type: "even_odd", parity: "even"|"odd" }  // by calendar day-of-month
    { type: "date_range", start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
  Evaluated top-to-bottom in the app layer, first match wins. When this
  resolves to nothing (NULL, empty, or no rule matches right now),
  behavior is unchanged — the existing static `escalation_rules` target
  is used exactly as before.
- `surge_mode_enabled` — boolean, defaults to false. A simple on/off
  switch a business owner can flip during a storm/heat-wave spike.
- `surge_mode_message` — text, nullable. A short heads-up line the AI can
  mention to callers while surge mode is on (e.g. "due to the recent
  storm, response times may be a bit longer than usual").
- `surge_mode_priority` — text, nullable. Free-text description of what
  to prioritize (e.g. "roof leaks and storm damage") that gets passed to
  the AI as call-handling guidance, not a hard-coded category list.
- `surge_max_bookings_per_day` — integer, nullable. When set (and surge
  mode is on), the booking tool enforces this as a real per-day cap
  instead of just an instruction the AI might ignore — see the
  vapi-webhook `toolBookAppointment` change shipped alongside this
  migration.

All four surge_* columns and on_call_schedule default to their "off"
state, so no existing account's call handling changes until an owner
actually configures one of these on a settings page.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS on_call_schedule jsonb,
ADD COLUMN IF NOT EXISTS surge_mode_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS surge_mode_message text,
ADD COLUMN IF NOT EXISTS surge_mode_priority text,
ADD COLUMN IF NOT EXISTS surge_max_bookings_per_day integer;
