/*
  # Vertical-Specific AI Playbooks

  ## Why
  Every tenant on Vireek is a different trade (HVAC, plumbing, roofing,
  electrical, restoration, locksmith), and each trade has its own triage
  questions, emergency language, common services and upsell moments. Today
  a brand-new tenant starts with a completely empty knowledge base and has
  to write all of that from scratch before the AI receptionist is actually
  useful on a real call.

  This adds a lightweight way to apply a curated, trade-specific starter
  pack ("playbook") that turns into real `knowledge_articles` rows the
  phone assistant already searches — see
  supabase/functions/_shared/knowledge/search.ts and
  20260921000000_advanced_knowledge_base.sql. No new retrieval path is
  needed; a playbook is just a fast, high-quality way to seed the existing
  one.

  ## What this does
  1. Extends `knowledge_articles.source` to allow 'playbook' alongside the
     existing sources, so playbook-generated articles are distinguishable
     from hand-written ones in the Knowledge Base UI.
  2. Adds `active_playbook_slug` / `active_playbook_applied_at` to
     `business_profile` so the dashboard can show "HVAC playbook applied
     Sep 23" instead of forcing a re-query of the articles table.
  3. Adds `playbook_applications` as an append-only audit log: which
     playbook, when, how many articles it created. This is what lets the
     Playbooks page show history instead of only current state.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, the same helper every
  other tenant-scoped table in this project uses (calls, leads, jobs,
  knowledge_articles) — team members see their account's applications,
  never another tenant's.
*/

-- =============================================================
-- 1. Allow 'playbook' as a knowledge_articles source
-- =============================================================

ALTER TABLE knowledge_articles DROP CONSTRAINT IF EXISTS knowledge_articles_source_check;
ALTER TABLE knowledge_articles ADD CONSTRAINT knowledge_articles_source_check
  CHECK (source IN ('manual', 'faq_import', 'gap', 'price_book', 'playbook'));

-- =============================================================
-- 2. Track which playbook is active on business_profile
-- =============================================================

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS active_playbook_slug text,
  ADD COLUMN IF NOT EXISTS active_playbook_applied_at timestamptz;

-- =============================================================
-- 3. Append-only audit log of playbook applications
-- =============================================================

CREATE TABLE IF NOT EXISTS playbook_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  playbook_slug text NOT NULL,
  articles_created integer NOT NULL DEFAULT 0,

  applied_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playbook_applications_user_id
  ON playbook_applications(user_id);

ALTER TABLE playbook_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_playbook_applications" ON playbook_applications
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "insert_own_playbook_applications" ON playbook_applications
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
