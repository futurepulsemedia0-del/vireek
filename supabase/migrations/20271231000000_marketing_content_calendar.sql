/*
  # Marketing Content Calendar

  Adds: content_calendar_items — the plan for what goes out, when, and on which
  channel (social, blog, email, SMS, direct mail). Powers /dashboard/marketing/calendar.

  ## Design notes
  - RLS follows this project's standard: `public.get_account_owner_id()` so the
    account owner and every team member see the same calendar.
  - This table is a PLANNING + scheduling record. It does not publish to social
    networks; "Published" is set by a person (or later by an integration).
  - Email campaigns are NOT copied here. The page overlays public.email_campaigns
    (read-only) so there is a single source of truth for sends.
  - Additive only: no existing table, column, policy or function is changed.

  ## Requires (already in your project)
  public.profiles, public.get_account_owner_id(), auth.uid()

  ## After applying
  No edge function, secret or cron job is needed.
*/

CREATE TABLE IF NOT EXISTS content_calendar_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  channel text NOT NULL CHECK (channel IN (
    'facebook', 'instagram', 'google_business', 'linkedin', 'x', 'tiktok', 'youtube',
    'nextdoor', 'blog', 'email', 'sms', 'direct_mail', 'other'
  )),
  content_type text NOT NULL DEFAULT 'post' CHECK (content_type IN (
    'post', 'story', 'video', 'article', 'email', 'sms', 'offer', 'event', 'ad', 'other'
  )),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'idea', 'draft', 'in_review', 'approved', 'scheduled', 'published', 'cancelled'
  )),
  scheduled_at timestamptz,
  published_at timestamptz,
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  link_url text CHECK (link_url IS NULL OR (char_length(link_url) <= 500 AND link_url ~* '^https?://')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_calendar_scheduled_needs_time CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_content_calendar_user_scheduled
  ON content_calendar_items(user_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_content_calendar_user_status
  ON content_calendar_items(user_id, status);

ALTER TABLE content_calendar_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_content_calendar_items" ON content_calendar_items;
CREATE POLICY "select_own_content_calendar_items" ON content_calendar_items
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_content_calendar_items" ON content_calendar_items;
CREATE POLICY "insert_own_content_calendar_items" ON content_calendar_items
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_content_calendar_items" ON content_calendar_items;
CREATE POLICY "update_own_content_calendar_items" ON content_calendar_items
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_content_calendar_items" ON content_calendar_items;
CREATE POLICY "delete_own_content_calendar_items" ON content_calendar_items
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- Own trigger function (this project defines set_updated_at() in several migrations
-- with different bodies, so this table does not depend on any of them).
CREATE OR REPLACE FUNCTION public.content_calendar_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_content_calendar_touch_updated_at ON content_calendar_items;
CREATE TRIGGER trg_content_calendar_touch_updated_at
  BEFORE UPDATE ON content_calendar_items
  FOR EACH ROW EXECUTE FUNCTION public.content_calendar_touch_updated_at();
