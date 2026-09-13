/*
  # AI Dispatcher — automatic assignment toggle
  Default false so no existing installation starts auto-assigning without asking for it.
*/
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS ai_dispatch_enabled boolean NOT NULL DEFAULT false;
