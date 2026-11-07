/*
  # Jobber webhooks support

  - price_book_connections.jobber_account_id: Jobber's account id (webhook `accountId`), captured at connect time /
    first sync, used to route APP_DISCONNECT to the right tenant(s). Intentionally NOT unique: one Jobber account may be
    connected by more than one Vireek user, and an uninstall invalidates all of them.
  - jobber_webhook_events: de-duplication ledger (Jobber delivers at least once). Service role only.
*/

ALTER TABLE price_book_connections ADD COLUMN IF NOT EXISTS jobber_account_id text;
CREATE INDEX IF NOT EXISTS idx_price_book_connections_jobber_account
  ON price_book_connections (jobber_account_id) WHERE jobber_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS jobber_webhook_events (
  event_key text PRIMARY KEY,
  topic text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobber_webhook_events_received ON jobber_webhook_events (received_at);

ALTER TABLE jobber_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jobber_webhook_events FROM anon, authenticated;
