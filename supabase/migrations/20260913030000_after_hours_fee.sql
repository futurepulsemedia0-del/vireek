/*
# After-hours fee disclosure

## Why
`business_profile.business_hours` and `.holidays` already exist, and
`EscalationRule.trigger` even already lists `"after_hours"` as a possible
value — but nothing in the codebase actually computes whether "right now"
(or a given booking time) falls outside business hours. Many home-service
businesses charge an emergency/after-hours dispatch fee for calls outside
normal hours, and the AI should disclose that transparently BEFORE
booking, not leave it as a surprise on the invoice.

## What this does
Adds two nullable columns to `business_profile`:

- `after_hours_fee` — numeric. The flat fee amount (e.g. 50.00). NULL
  means no after-hours fee is configured, so nothing changes for an
  account that hasn't set this.
- `after_hours_fee_note` — text. Optional custom wording for the AI to
  use when disclosing the fee (e.g. "a $75 emergency dispatch fee applies
  after 6pm and on weekends"). When NULL, the webhook falls back to a
  plain sentence built from `after_hours_fee` alone.

Both default to NULL — purely additive, no existing behavior changes
until an owner sets a fee amount on a settings page.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS after_hours_fee numeric,
ADD COLUMN IF NOT EXISTS after_hours_fee_note text;
