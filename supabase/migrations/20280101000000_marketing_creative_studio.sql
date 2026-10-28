/*
  # Marketing Creative Studio

  Adds: marketing_creatives — AI-generated ad/social images and blog/SEO posts,
  built from real completed jobs and real customer reviews. Powers
  /dashboard/marketing/creative.

  ## Design notes
  - RLS follows this project's standard: `public.get_account_owner_id()` so the
    account owner and every team member can SEE the library; only the owner or a
    member with `can_edit_business_profile` (public.can_manage_branding()) can
    create / edit / delete.
  - Rows are inserted by the `marketing-creative-generate` edge function AS the
    signed-in user (never the service role), so every write passes these policies.
  - Images live in the PRIVATE `marketing-creatives` storage bucket under
    `<account_owner_id>/<creative_id>.<ext>`; the dashboard reads them through
    short-lived signed URLs.
  - No customer name / address is stored or sent to the AI; only service type,
    season, an eligible review excerpt and owner-typed details.
  - Additive only: no existing table, column, policy or function is changed.

  ## Requires (already in your project)
  public.profiles, public.jobs, public.reviews, public.content_calendar_items,
  public.get_account_owner_id(), public.can_manage_branding(), auth.uid()

  ## After applying
  Set the edge-function secret GEMINI_API_KEY (already used by Visual Estimate).
  Optional: GEMINI_IMAGE_MODEL (default gemini-2.5-flash-image).
*/

CREATE TABLE IF NOT EXISTS public.marketing_creatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),

  kind text NOT NULL CHECK (kind IN ('image', 'article')),
  format text NOT NULL CHECK (format IN (
    'social_square', 'social_portrait', 'social_story', 'ad_landscape', 'blog_post', 'seo_local_page'
  )),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'approved', 'archived')),

  source_type text NOT NULL DEFAULT 'custom' CHECK (source_type IN ('job', 'review', 'custom')),
  source_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  source_review_id uuid REFERENCES public.reviews(id) ON DELETE SET NULL,

  tone text NOT NULL DEFAULT 'friendly' CHECK (tone IN ('friendly', 'professional', 'urgent', 'premium')),
  goal text NOT NULL DEFAULT 'book_service' CHECK (goal IN ('book_service', 'seasonal_offer', 'build_trust', 'membership')),

  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  headline text CHECK (headline IS NULL OR char_length(headline) <= 120),
  caption text CHECK (caption IS NULL OR char_length(caption) <= 2000),
  cta text CHECK (cta IS NULL OR char_length(cta) <= 60),
  hashtags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hashtags) <= 12),
  quote text CHECK (quote IS NULL OR char_length(quote) <= 300),
  body text CHECK (body IS NULL OR char_length(body) <= 30000),
  meta_title text CHECK (meta_title IS NULL OR char_length(meta_title) <= 120),
  meta_description text CHECK (meta_description IS NULL OR char_length(meta_description) <= 300),
  slug text CHECK (slug IS NULL OR char_length(slug) <= 120),
  keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 12),
  faq jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(faq) = 'array'),

  image_path text CHECK (image_path IS NULL OR char_length(image_path) <= 300),
  image_prompt text CHECK (image_prompt IS NULL OR char_length(image_prompt) <= 2000),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  model text CHECK (model IS NULL OR char_length(model) <= 120),

  calendar_item_id uuid REFERENCES public.content_calendar_items(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_creatives_image_has_path CHECK (kind <> 'image' OR image_path IS NOT NULL),
  CONSTRAINT marketing_creatives_article_has_body CHECK (kind <> 'article' OR body IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_marketing_creatives_user_created
  ON public.marketing_creatives(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_creatives_user_status
  ON public.marketing_creatives(user_id, status);
CREATE INDEX IF NOT EXISTS idx_marketing_creatives_source_review
  ON public.marketing_creatives(source_review_id) WHERE source_review_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_creatives_source_job
  ON public.marketing_creatives(source_job_id) WHERE source_job_id IS NOT NULL;

ALTER TABLE public.marketing_creatives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_creatives_select" ON public.marketing_creatives;
CREATE POLICY "marketing_creatives_select" ON public.marketing_creatives
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "marketing_creatives_insert" ON public.marketing_creatives;
CREATE POLICY "marketing_creatives_insert" ON public.marketing_creatives
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_branding());

DROP POLICY IF EXISTS "marketing_creatives_update" ON public.marketing_creatives;
CREATE POLICY "marketing_creatives_update" ON public.marketing_creatives
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_branding())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_branding());

DROP POLICY IF EXISTS "marketing_creatives_delete" ON public.marketing_creatives;
CREATE POLICY "marketing_creatives_delete" ON public.marketing_creatives
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_branding());

-- Own trigger function (this project defines set_updated_at() in several
-- migrations with different bodies, so this table does not depend on any).
CREATE OR REPLACE FUNCTION public.marketing_creatives_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketing_creatives_touch_updated_at ON public.marketing_creatives;
CREATE TRIGGER trg_marketing_creatives_touch_updated_at
  BEFORE UPDATE ON public.marketing_creatives
  FOR EACH ROW EXECUTE FUNCTION public.marketing_creatives_touch_updated_at();

-- =============================================================
-- STORAGE: private bucket, first folder = account owner id
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketing-creatives', 'marketing-creatives', false, 10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "marketing_creatives_obj_select" ON storage.objects;
CREATE POLICY "marketing_creatives_obj_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'marketing-creatives'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

DROP POLICY IF EXISTS "marketing_creatives_obj_insert" ON storage.objects;
CREATE POLICY "marketing_creatives_obj_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'marketing-creatives'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_branding()
  );

DROP POLICY IF EXISTS "marketing_creatives_obj_delete" ON storage.objects;
CREATE POLICY "marketing_creatives_obj_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'marketing-creatives'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_branding()
  );
