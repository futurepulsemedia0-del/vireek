-- Needed so the OAuth callbacks above can safely upsert one row per
-- (user, integration type) instead of racing a select-then-insert.
ALTER TABLE integrations
  ADD CONSTRAINT integrations_user_id_integration_type_key
  UNIQUE (user_id, integration_type);
