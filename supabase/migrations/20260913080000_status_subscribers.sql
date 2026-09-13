/*
  # Status page subscribers (email + SMS-ready)

  ## Why
  /status currently only displays uptime/incidents — there was no way
  for a visitor to actually subscribe to be notified of an outage. For
  an enterprise-trust page, "subscribe" needs to really send something,
  not just collect an email into a black hole. This migration adds the
  table; the actual sending happens in the notify-status-subscribers
  edge function (uses Resend, same provider already wired up in
  send-team-invite/index.ts).

  ## Why this writes directly to Supabase instead of the
  submit-form.com relay other public forms use (ContactPage,
  SignupForm, PressPage)
  Those forms only need the submission to reach an inbox once. This
  feature needs to query the subscriber list back later to actually
  send incident emails, so it has to live in a table we can query —
  a form relay can't do that.

  ## What this adds
  - `status_subscribers`
    - `email` (text, not null) — required, this is the channel that
      actually works today (Resend is already configured).
    - `phone` (text, nullable) — captured now so nobody has to
      re-subscribe once SMS ships, but NOT sent to yet. See the
      honesty note on VOICE_OPTIONS in AssistantPersonaPage.tsx for the
      same "don't claim a channel works before it does" principle.
    - `notify_sms` (boolean, default false) — the visitor's stated
      interest in SMS once it exists; ignored by the mailer today.
    - `unsubscribe_token` (uuid, unique, default random) — lets a
      subscriber unsubscribe from a one-click emailed link without
      creating an account or exposing every subscriber's token in a
      public RLS policy (the token is only ever checked server-side by
      the unsubscribe-status-updates edge function via the service
      role key, not through client-side RLS).

  ## Security
  RLS enabled. INSERT is public (anon + authenticated) — same pattern
  as sales_inquiries, since this form is on the public marketing site
  for visitors with no account. SELECT/UPDATE/DELETE are admin-only,
  same admin check already used by sales_inquiries. There is
  deliberately NO public DELETE-by-token policy — unsubscribing is
  handled by the unsubscribe-status-updates edge function (service
  role), which is a safer boundary than an RLS policy that would let
  any anonymous request attempt a delete.
*/

CREATE TABLE IF NOT EXISTS status_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  phone text,
  notify_sms boolean NOT NULL DEFAULT false,
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_subscribers_email ON status_subscribers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_status_subscribers_unsubscribe_token ON status_subscribers (unsubscribe_token);

ALTER TABLE status_subscribers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_insert_status_subscribers" ON status_subscribers;
CREATE POLICY "public_insert_status_subscribers"
ON status_subscribers FOR INSERT
TO anon, authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "admin_select_status_subscribers" ON status_subscribers;
CREATE POLICY "admin_select_status_subscribers"
ON status_subscribers FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

DROP POLICY IF EXISTS "admin_delete_status_subscribers" ON status_subscribers;
CREATE POLICY "admin_delete_status_subscribers"
ON status_subscribers FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);
