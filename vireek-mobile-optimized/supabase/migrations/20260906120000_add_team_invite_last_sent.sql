/*
# Track when a team invite email was last sent

## What this migration does
Adds `last_invited_at` to `team_members` so the dashboard can show "invited
X ago" and the send-team-invite edge function can stamp each successful send.

## Changes
- team_members: + last_invited_at (timestamptz, nullable)
*/

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS last_invited_at timestamptz;
