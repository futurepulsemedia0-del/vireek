/*
  # Newsletter subscribers

  Backs the footer newsletter form (NewsletterSection in Footer.tsx),
  which previously just faked a success state with setTimeout and threw
  the email away. Insert-only from the client — no SELECT policy for
  anon/authenticated, so the subscriber list is only ever readable via
  the service role / Supabase dashboard, never exposed to the browser.
*/

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'footer',
  subscribed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "insert_newsletter_subscriber" ON newsletter_subscribers;
CREATE POLICY "insert_newsletter_subscriber" ON newsletter_subscribers
  FOR INSERT TO anon, authenticated WITH CHECK (true);
