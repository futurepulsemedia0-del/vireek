/*
# Business hours: holidays + call-routing/escalation rules

## Why
`business_profile.business_hours` already lets an account set its weekly
open hours, but there was no way to configure (a) one-off closures/holidays
that override those hours for a specific date, or (b) what should actually
happen when a call needs to be routed — emergency detected, call comes in
after hours, or nobody answers. Those were only ever described in marketing
copy (see knowledge.ts's "industries"/"faq" facts about escalation), never
an actual account-level setting a customer could configure.

## What this does
Adds two nullable jsonb columns to `business_profile`:

- `holidays` — array of `{ id, date, label, message }`. `date` is
  `YYYY-MM-DD`. When today's date matches an entry, that closure takes
  precedence over the normal weekly `business_hours` for that day.
- `escalation_rules` — array of
  `{ id, trigger, action, target, note }` where
  `trigger` is `'emergency' | 'after_hours' | 'no_answer'` and
  `action` is `'transfer' | 'sms' | 'email'`. `target` is the phone
  number or email the action routes to.

Both default to NULL (no rows to migrate — every existing account simply
has no holidays/escalation rules configured yet, same as before this
migration). Purely additive, no RLS changes needed since these live on the
existing `business_profile` row, already scoped per-user by its current
policies.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS holidays jsonb,
ADD COLUMN IF NOT EXISTS escalation_rules jsonb;
