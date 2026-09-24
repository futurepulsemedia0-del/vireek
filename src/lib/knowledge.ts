/**
 * Advanced Knowledge Base — client library.
 *
 * Everything the dashboard needs to author, publish, version and test the
 * knowledge the AI receptionist answers from. Server counterparts live in
 * supabase/migrations/20260921000000_advanced_knowledge_base.sql and
 * supabase/functions/_shared/knowledge/search.ts.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type KnowledgeAudience = 'all' | 'ai' | 'customer' | 'team';
export type KnowledgeStatus = 'draft' | 'published' | 'archived';
export type KnowledgeSource = 'manual' | 'faq_import' | 'gap' | 'price_book' | 'voice_note' | 'manual_upload';
export type GapStatus = 'open' | 'answered' | 'dismissed';

export interface KnowledgeArticle {
  id: string;
  user_id: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  keywords: string[];
  audience: KnowledgeAudience;
  status: KnowledgeStatus;
  source: KnowledgeSource;
  expires_on: string | null;
  embedding_model: string | null;
  embedded_at: string | null;
  embedding_stale: boolean;
  version: number;
  usage_count: number;
  last_used_at: string | null;
  contributed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeArticleVersion {
  id: string;
  article_id: string;
  version: number;
  title: string;
  summary: string;
  body: string;
  keywords: string[];
  status: KnowledgeStatus;
  created_at: string;
}

export interface KnowledgeGap {
  id: string;
  question: string;
  source: 'voice' | 'chat' | 'dashboard' | 'sms';
  asked_count: number;
  first_asked_at: string;
  last_asked_at: string;
  status: GapStatus;
  resolved_article_id: string | null;
}

export interface KnowledgeHit {
  id: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  audience: KnowledgeAudience;
  score: number;
  lexical_rank: number | null;
  semantic_rank: number | null;
}

export interface KnowledgeTestResult {
  spokenAnswer: string;
  hits: KnowledgeHit[];
  semantic: boolean;
}

// ============================================================
// LABELS
// ============================================================

export const AUDIENCE_LABELS: Record<KnowledgeAudience, string> = {
  all: 'Everyone',
  ai: 'Phone calls only',
  customer: 'Customers only',
  team: 'Internal — never spoken',
};

export const AUDIENCE_HELP: Record<KnowledgeAudience, string> = {
  all: 'Usable on calls, in chat, and by your team.',
  ai: 'The AI receptionist can say this. Not shown to customers in writing.',
  customer: 'For written channels. Not read out on a call.',
  team: 'Cost floors, vendor notes, rules of thumb. Excluded from every customer-facing answer at the database level.',
};

export const STATUS_COLORS: Record<KnowledgeStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  published: 'bg-success-500/10 text-success-500',
  archived: 'bg-bg-tertiary text-text-secondary/70',
};

export const SOURCE_LABELS: Record<KnowledgeSource, string> = {
  manual: 'Written here',
  faq_import: 'Imported from FAQs',
  gap: 'Answered a gap',
  price_book: 'From price book',
  voice_note: 'Captured from a voice note',
  manual_upload: 'Pulled from an uploaded manual',
};

// ============================================================
// FORM STATE
// ============================================================

export interface ArticleFormState {
  title: string;
  summary: string;
  body: string;
  category: string;
  keywords: string;
  audience: KnowledgeAudience;
  status: KnowledgeStatus;
  expires_on: string;
}

export const EMPTY_ARTICLE_FORM: ArticleFormState = {
  title: '',
  summary: '',
  body: '',
  category: '',
  keywords: '',
  audience: 'all',
  status: 'draft',
  expires_on: '',
};

export function articleToForm(article: KnowledgeArticle): ArticleFormState {
  return {
    title: article.title,
    summary: article.summary,
    body: article.body,
    category: article.category ?? '',
    keywords: article.keywords.join(', '),
    audience: article.audience,
    status: article.status,
    expires_on: article.expires_on ?? '',
  };
}

export function validateArticleForm(form: ArticleFormState): string[] {
  const errors: string[] = [];
  if (!form.title.trim()) errors.push('Give the article a title — phrase it the way a caller would ask.');
  if (!form.summary.trim() && !form.body.trim()) errors.push('Write an answer.');
  if (form.summary.length > 400) errors.push('The spoken answer is too long — keep it under 400 characters.');
  if (form.status === 'published' && !form.summary.trim()) {
    errors.push('A published article needs a spoken answer: that is the sentence the AI reads out.');
  }
  return errors;
}

export function formToPayload(form: ArticleFormState, userId: string) {
  return {
    user_id: userId,
    title: form.title.trim(),
    summary: form.summary.trim(),
    body: form.body.trim(),
    category: form.category.trim() || null,
    keywords: form.keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    audience: form.audience,
    status: form.status,
    expires_on: form.expires_on || null,
  };
}

// ============================================================
// ARTICLES
// ============================================================

export async function fetchArticles(): Promise<KnowledgeArticle[]> {
  const { data, error } = await supabase
    .from('knowledge_articles')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as KnowledgeArticle[]) ?? [];
}

export async function createArticle(form: ArticleFormState, userId: string): Promise<KnowledgeArticle> {
  const { data, error } = await supabase
    .from('knowledge_articles')
    .insert({ ...formToPayload(form, userId), created_by: userId })
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeArticle;
}

export async function updateArticle(id: string, form: ArticleFormState, userId: string): Promise<void> {
  const { user_id, ...patch } = formToPayload(form, userId);
  // `user_id` is intentionally dropped: it is immutable once set, and
  // resending it would fight the RLS check when a team member edits an
  // article that belongs to the account owner.
  void user_id;
  const { error } = await supabase.from('knowledge_articles').update(patch).eq('id', id);
  if (error) throw error;
}

export async function setArticleStatus(id: string, status: KnowledgeStatus): Promise<void> {
  const { error } = await supabase.from('knowledge_articles').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function deleteArticle(id: string): Promise<void> {
  const { error } = await supabase.from('knowledge_articles').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchArticleVersions(articleId: string): Promise<KnowledgeArticleVersion[]> {
  const { data, error } = await supabase
    .from('knowledge_article_versions')
    .select('*')
    .eq('article_id', articleId)
    .order('version', { ascending: false })
    .limit(20);
  if (error) return [];
  return (data as KnowledgeArticleVersion[]) ?? [];
}

/** Restoring writes the old content back as a NEW version — history is append-only. */
export async function restoreVersion(articleId: string, version: KnowledgeArticleVersion): Promise<void> {
  const { error } = await supabase
    .from('knowledge_articles')
    .update({
      title: version.title,
      summary: version.summary,
      body: version.body,
      keywords: version.keywords,
    })
    .eq('id', articleId);
  if (error) throw error;
}

// ============================================================
// GAPS
// ============================================================

export async function fetchGaps(status: GapStatus | 'all' = 'open'): Promise<KnowledgeGap[]> {
  let query = supabase
    .from('knowledge_gaps')
    .select('*')
    .order('asked_count', { ascending: false })
    .limit(200);
  if (status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return [];
  return (data as KnowledgeGap[]) ?? [];
}

export async function setGapStatus(
  id: string,
  status: GapStatus,
  resolvedArticleId: string | null = null
): Promise<void> {
  await supabase
    .from('knowledge_gaps')
    .update({ status, resolved_article_id: resolvedArticleId })
    .eq('id', id);
}

/** Pre-fills the editor from a gap so answering one is a two-field job. */
export function gapToForm(gap: KnowledgeGap): ArticleFormState {
  return {
    ...EMPTY_ARTICLE_FORM,
    title: gap.question,
    status: 'published',
  };
}

// ============================================================
// IMPORT + EMBEDDING
// ============================================================

/** Pulls business_profile.faqs into real articles. Safe to run twice. */
export async function importFaqs(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('import_faqs_to_knowledge', { p_user_id: userId });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Asks the embedder to process this account's stale articles. Fire and
 * forget: semantic search is an upgrade on top of keyword search, so a
 * failure here degrades ranking quality and nothing else.
 */
export async function refreshEmbeddings(userId: string): Promise<void> {
  await supabase.functions.invoke('knowledge-embed', { body: { user_id: userId } });
}

// ============================================================
// SEARCH / TEST
// ============================================================

/**
 * Runs the exact search the phone assistant runs and returns the sentence
 * it would say. Goes through the edge function because query embedding
 * needs a server-side API key — the browser gets the result, never the key.
 *
 * Falls back to a direct keyword-only RPC if the function isn't deployed,
 * so the page still works on a partial install.
 */
export async function testKnowledgeAnswer(question: string, userId: string): Promise<KnowledgeTestResult> {
  const { data, error } = await supabase.functions.invoke('knowledge-search', {
    body: { question, record_gap: false },
  });

  if (!error && data && typeof data.answer === 'string') {
    return {
      spokenAnswer: data.answer,
      hits: (data.hits ?? []) as KnowledgeHit[],
      semantic: Boolean(data.semantic),
    };
  }

  const { data: rows } = await supabase.rpc('search_knowledge_articles', {
    p_user_id: userId,
    p_query: question,
    p_embedding: null,
    p_audience: 'ai',
    p_limit: 3,
  });

  const hits = (rows as KnowledgeHit[]) ?? [];
  return {
    spokenAnswer:
      hits.length > 0
        ? `"${hits[0].title}": ${hits[0].summary || hits[0].body}`
        : 'Nothing in the knowledge base answers this. The assistant would tell the caller someone will confirm, and log the question as a gap.',
    hits,
    semantic: false,
  };
}

// ============================================================
// COVERAGE
// ============================================================

export interface KnowledgeStats {
  published: number;
  drafts: number;
  unembedded: number;
  openGaps: number;
  neverUsed: number;
  staleTopics: number;
}

export function computeStats(articles: KnowledgeArticle[], gaps: KnowledgeGap[]): KnowledgeStats {
  const today = new Date().toISOString().slice(0, 10);
  return {
    published: articles.filter((a) => a.status === 'published').length,
    drafts: articles.filter((a) => a.status === 'draft').length,
    unembedded: articles.filter((a) => a.embedding_stale && a.status === 'published').length,
    openGaps: gaps.filter((g) => g.status === 'open').length,
    neverUsed: articles.filter((a) => a.status === 'published' && a.usage_count === 0).length,
    staleTopics: articles.filter((a) => a.expires_on !== null && a.expires_on < today).length,
  };
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

// ============================================================
// COMPANY BRAIN — TRIBAL KNOWLEDGE CAPTURE
// ============================================================

export interface KnowledgeManualUpload {
  id: string;
  file_name: string;
  storage_path: string;
  status: 'processing' | 'done' | 'failed';
  articles_created: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

const TRIBAL_MEDIA_BUCKET = 'tribal-knowledge-media';

/** Uploads a technician's voice note to their own folder in the private tribal-knowledge-media bucket. */
export async function uploadTribalVoiceNote(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'wav';
  const path = `${userId}/voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from(TRIBAL_MEDIA_BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

/** Uploads a manual/spec-sheet PDF to the same private bucket. */
export async function uploadTribalManualPdf(userId: string, file: File): Promise<string> {
  const path = `${userId}/manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  const { error } = await supabase.storage.from(TRIBAL_MEDIA_BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export interface VoiceCaptureResult {
  useful: boolean;
  message?: string;
  article?: KnowledgeArticle;
  error?: string;
}

/** Sends an uploaded voice note (+ optional notes) to be drafted into a team-only KB article. */
export async function captureVoiceNote(audioPath: string | null, notes: string): Promise<VoiceCaptureResult> {
  const { data, error } = await supabase.functions.invoke('tribal-knowledge-voice-capture', {
    body: { audioPath, notes },
  });
  if (error) throw error;
  if (data?.error) return { useful: false, error: data.error as string };
  return data as VoiceCaptureResult;
}

export interface ManualIngestResult {
  articlesCreated: number;
  message?: string;
  error?: string;
}

/** Sends an uploaded manual PDF to be split into one or more draft KB articles. */
export async function ingestManual(pdfPath: string, fileName: string): Promise<ManualIngestResult> {
  const { data, error } = await supabase.functions.invoke('tribal-knowledge-manual-ingest', {
    body: { pdfPath, fileName },
  });
  if (error) throw error;
  if (data?.error) return { articlesCreated: 0, error: data.error as string };
  return data as ManualIngestResult;
}

export async function fetchManualUploads(): Promise<KnowledgeManualUpload[]> {
  const { data, error } = await supabase
    .from('knowledge_manual_uploads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return [];
  return (data as KnowledgeManualUpload[]) ?? [];
}
