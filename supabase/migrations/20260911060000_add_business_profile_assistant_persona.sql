/*
# Assistant persona: name, voice, and tone

## Why
Every account's AI receptionist has always answered under the same
hardcoded name, "Sarah," with no way for a business owner to change it,
pick a different voice, or adjust how formal/casual it sounds. Businesses
want their receptionist to feel like part of their own brand, not a
generic Vireek persona.

## What this does
Adds three columns to `business_profile`, each with a default that
reproduces today's behavior exactly (so no existing account's assistant
changes until the owner visits the new settings page and saves):

- `assistant_name` — text, defaults to 'Sarah'. Free text, trimmed and
  length-capped in the app layer (not enforced here, same approach as
  `service_area`/`greeting_script`).
- `assistant_voice` — text, defaults to 'sarah-warm-f-us'. One of a fixed
  set of voice option ids the app presents in a picker; constrained here
  so a bad value can never reach the row.
- `assistant_tone` — text, defaults to 'friendly'. Also a fixed set,
  constrained the same way.

Purely additive, no RLS changes needed — these live on the existing
`business_profile` row, already scoped per-account by its current
policies.
*/

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS assistant_name text NOT NULL DEFAULT 'Sarah',
ADD COLUMN IF NOT EXISTS assistant_voice text NOT NULL DEFAULT 'sarah-warm-f-us'
  CHECK (assistant_voice IN (
    'sarah-warm-f-us',
    'aria-friendly-f-us',
    'maya-calm-f-uk',
    'miles-confident-m-us',
    'jay-easygoing-m-us',
    'oliver-polished-m-uk'
  )),
ADD COLUMN IF NOT EXISTS assistant_tone text NOT NULL DEFAULT 'friendly'
  CHECK (assistant_tone IN ('friendly', 'professional', 'warm', 'direct'));
