/*
# Tag support for calls, leads, and jobs

## Why
Teams need lightweight labels ("urgent", "follow-up needed", "VIP") to
triage their queues faster than status/stage fields alone allow.

## What this does
- Adds `tags text[]` (NOT NULL, default '{}') to calls, leads, and jobs.
  Purely additive — existing rows just get an empty tag list.
- Adds a GIN index on each so "has tag X" filters stay fast as the
  table grows (`tags @> ARRAY['urgent']`).
*/

ALTER TABLE calls ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_calls_tags ON calls USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_leads_tags ON leads USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_jobs_tags  ON jobs  USING GIN (tags);
