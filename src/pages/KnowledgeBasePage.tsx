/**
 * Advanced Knowledge Base — /dashboard/knowledge
 *
 * Three jobs on one page:
 *   Articles — author and version the facts the AI answers from.
 *   Gaps     — questions callers asked that nothing answered, ranked by
 *              how often they came up. Answering one is two fields.
 *   Test     — ask what a caller would ask and read back the exact
 *              sentence the phone assistant would say.
 *
 * See src/lib/knowledge.ts for the data layer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronDown,
  Download,
  History,
  Lightbulb,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  articleToForm,
  AUDIENCE_HELP,
  AUDIENCE_LABELS,
  computeStats,
  createArticle,
  deleteArticle,
  EMPTY_ARTICLE_FORM,
  fetchArticles,
  fetchArticleVersions,
  fetchGaps,
  gapToForm,
  importFaqs,
  refreshEmbeddings,
  relativeTime,
  restoreVersion,
  setArticleStatus,
  setGapStatus,
  SOURCE_LABELS,
  STATUS_COLORS,
  testKnowledgeAnswer,
  updateArticle,
  validateArticleForm,
} from '@/lib/knowledge';
import type {
  ArticleFormState,
  KnowledgeArticle,
  KnowledgeArticleVersion,
  KnowledgeAudience,
  KnowledgeGap,
  KnowledgeStatus,
  KnowledgeTestResult,
} from '@/lib/knowledge';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type Tab = 'articles' | 'gaps' | 'test';

// ============================================================
// EDITOR
// ============================================================

function ArticleEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: ArticleFormState;
  onCancel: () => void;
  onSave: (form: ArticleFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const errors = validateArticleForm(form);

  const patch = (p: Partial<ArticleFormState>) => setForm((f) => ({ ...f, ...p }));

  return (
    <div className="space-y-3 rounded-2xl border border-accent/30 bg-bg-secondary p-4">
      <div>
        <label className="mb-1 block text-xs text-text-secondary">
          Title — write it the way a caller asks it
        </label>
        <input
          type="text"
          value={form.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder="Do you charge for a diagnostic visit?"
          className={inputClass}
          autoFocus
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-secondary">
          Spoken answer — one or two sentences, read out loud on calls
        </label>
        <textarea
          rows={2}
          value={form.summary}
          onChange={(e) => patch({ summary: e.target.value })}
          placeholder="Yes — $89 for the visit, waived if you go ahead with the repair that day."
          className={`${inputClass} resize-y`}
        />
        <p className="mt-1 text-[11px] text-text-secondary/70">{form.summary.length}/400</p>
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-secondary">
          Full detail (optional) — used in chat and search, not read out
        </label>
        <textarea
          rows={4}
          value={form.body}
          onChange={(e) => patch({ body: e.target.value })}
          placeholder="The diagnostic covers up to an hour on site… Commercial jobs are quoted separately."
          className={`${inputClass} resize-y`}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Category</label>
          <input
            type="text"
            value={form.category}
            onChange={(e) => patch({ category: e.target.value })}
            placeholder="Pricing"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">
            Other wordings callers use (comma separated)
          </label>
          <input
            type="text"
            value={form.keywords}
            onChange={(e) => patch({ keywords: e.target.value })}
            placeholder="service call fee, trip charge, call out fee"
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Who can hear this</label>
          <select
            value={form.audience}
            onChange={(e) => patch({ audience: e.target.value as KnowledgeAudience })}
            className={inputClass}
          >
            {(Object.keys(AUDIENCE_LABELS) as KnowledgeAudience[]).map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Status</label>
          <select
            value={form.status}
            onChange={(e) => patch({ status: e.target.value as KnowledgeStatus })}
            className={inputClass}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Stop using after (optional)</label>
          <input
            type="date"
            value={form.expires_on}
            onChange={(e) => patch({ expires_on: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-text-secondary/80">{AUDIENCE_HELP[form.audience]}</p>

      {errors.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-warning-500/30 bg-warning-500/[0.06] px-3 py-2">
          {errors.map((e) => (
            <li key={e} className="flex items-start gap-1.5 text-xs text-text-secondary">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-warning-500" />
              {e}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={errors.length > 0 || saving}
          onClick={async () => {
            setSaving(true);
            await onSave(form);
            setSaving(false);
          }}
          className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}

// ============================================================
// VERSION HISTORY
// ============================================================

function VersionHistory({
  articleId,
  onRestore,
}: {
  articleId: string;
  onRestore: (version: KnowledgeArticleVersion) => Promise<void>;
}) {
  const [versions, setVersions] = useState<KnowledgeArticleVersion[] | null>(null);

  useEffect(() => {
    fetchArticleVersions(articleId).then(setVersions);
  }, [articleId]);

  if (versions === null) return <div className="h-12 animate-pulse rounded-xl bg-bg-tertiary" />;
  if (versions.length === 0) {
    return <p className="px-1 py-2 text-xs text-text-secondary">No edits yet — this is the original wording.</p>;
  }

  return (
    <div className="space-y-2">
      {versions.map((v) => (
        <div key={v.id} className="rounded-xl border border-border bg-bg-primary p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-text-primary">
              v{v.version} · {relativeTime(v.created_at)}
            </p>
            <button
              type="button"
              onClick={() => void onRestore(v)}
              className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline"
            >
              Restore
            </button>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{v.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary/80">{v.summary || v.body}</p>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function KnowledgeBasePage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('articles');
  const [articles, setArticles] = useState<KnowledgeArticle[]>([]);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<KnowledgeStatus | 'all'>('all');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<ArticleFormState>(EMPTY_ARTICLE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [answeringGapId, setAnsweringGapId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeArticle | null>(null);
  const [busy, setBusy] = useState(false);

  const [testQuestion, setTestQuestion] = useState('');
  const [testResult, setTestResult] = useState<KnowledgeTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, g] = await Promise.all([fetchArticles(), fetchGaps('open')]);
      setArticles(a);
      setGaps(g);
    } catch {
      toast('Could not load the knowledge base', 'error');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => computeStats(articles, gaps), [articles, gaps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return articles.filter((a) => {
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        a.keywords.some((k) => k.toLowerCase().includes(q))
      );
    });
  }, [articles, query, statusFilter]);

  // --- actions -------------------------------------------------

  const openNew = () => {
    setEditingId(null);
    setAnsweringGapId(null);
    setEditorInitial(EMPTY_ARTICLE_FORM);
    setEditorOpen(true);
    setTab('articles');
  };

  const openEdit = (article: KnowledgeArticle) => {
    setEditingId(article.id);
    setAnsweringGapId(null);
    setEditorInitial(articleToForm(article));
    setEditorOpen(true);
  };

  const openGapAnswer = (gap: KnowledgeGap) => {
    setEditingId(null);
    setAnsweringGapId(gap.id);
    setEditorInitial(gapToForm(gap));
    setEditorOpen(true);
    setTab('articles');
  };

  const handleSave = async (form: ArticleFormState) => {
    if (!user) return;
    try {
      if (editingId) {
        await updateArticle(editingId, form, user.id);
      } else {
        const created = await createArticle(form, user.id);
        if (answeringGapId) {
          await setGapStatus(answeringGapId, 'answered', created.id);
        }
      }
      toast('Saved', 'success');
      setEditorOpen(false);
      setEditingId(null);
      setAnsweringGapId(null);
      await load();
      // Semantic ranking catches up in the background; keyword search
      // already works the instant the row lands.
      if (user) void refreshEmbeddings(user.id);
    } catch {
      toast('Could not save this article', 'error');
    }
  };

  const handleToggleStatus = async (article: KnowledgeArticle) => {
    const next: KnowledgeStatus = article.status === 'published' ? 'draft' : 'published';
    try {
      await setArticleStatus(article.id, next);
      setArticles((prev) => prev.map((a) => (a.id === article.id ? { ...a, status: next } : a)));
    } catch {
      toast('Could not change the status', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteArticle(pendingDelete.id);
      setArticles((prev) => prev.filter((a) => a.id !== pendingDelete.id));
      toast('Article deleted', 'success');
    } catch {
      toast('Could not delete this article', 'error');
    }
    setPendingDelete(null);
  };

  const handleImportFaqs = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const count = await importFaqs(user.id);
      toast(
        count > 0 ? `Imported ${count} FAQ${count === 1 ? '' : 's'}` : 'Nothing new to import',
        count > 0 ? 'success' : 'info'
      );
      if (count > 0) {
        await load();
        void refreshEmbeddings(user.id);
      }
    } catch {
      toast('Could not import your FAQs', 'error');
    }
    setBusy(false);
  };

  const handleRefreshEmbeddings = async () => {
    if (!user) return;
    setBusy(true);
    await refreshEmbeddings(user.id);
    await load();
    toast('Search index refreshed', 'success');
    setBusy(false);
  };

  const handleTest = async () => {
    if (!user || !testQuestion.trim()) return;
    setTesting(true);
    try {
      setTestResult(await testKnowledgeAnswer(testQuestion.trim(), user.id));
    } catch {
      toast('Could not run that search', 'error');
    }
    setTesting(false);
  };

  // --- render --------------------------------------------------

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'articles', label: 'Articles', badge: articles.length || undefined },
    { key: 'gaps', label: 'Unanswered questions', badge: stats.openGaps || undefined },
    { key: 'test', label: 'Test an answer' },
  ];

  return (
    <DashboardLayout activeLabel="Knowledge">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Knowledge Base</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              What your AI receptionist knows about your business. Anything in here it can answer on a live
              call; anything missing becomes a logged question instead of an invented answer.
            </p>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white transition-all hover:brightness-110"
          >
            <Plus size={14} /> New article
          </button>
        </div>

        {/* Stats */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">{stats.published}</p>
            <p className="text-xs text-text-secondary">Live answers</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">{stats.drafts}</p>
            <p className="text-xs text-text-secondary">Drafts</p>
          </div>
          <div
            className={`rounded-2xl border p-4 ${
              stats.openGaps > 0 ? 'border-warning-500/30 bg-warning-500/[0.05]' : 'border-border bg-bg-secondary'
            }`}
          >
            <p className={`text-2xl font-bold ${stats.openGaps > 0 ? 'text-warning-500' : 'text-text-primary'}`}>
              {stats.openGaps}
            </p>
            <p className="text-xs text-text-secondary">Unanswered</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">{stats.neverUsed}</p>
            <p className="text-xs text-text-secondary">Never asked about</p>
          </div>
        </div>

        {(stats.unembedded > 0 || stats.staleTopics > 0) && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-bg-secondary/60 px-4 py-3">
            <p className="text-xs leading-relaxed text-text-secondary">
              {stats.unembedded > 0 && (
                <>
                  {stats.unembedded} article{stats.unembedded === 1 ? '' : 's'} still on keyword-only matching.{' '}
                </>
              )}
              {stats.staleTopics > 0 && (
                <>
                  {stats.staleTopics} article{stats.staleTopics === 1 ? '' : 's'} passed their expiry date and are
                  no longer being used.
                </>
              )}
            </p>
            {stats.unembedded > 0 && (
              <button
                type="button"
                onClick={() => void handleRefreshEmbeddings()}
                disabled={busy}
                className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Refresh index
              </button>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`focus-ring flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
              {t.badge !== undefined && (
                <span className={`rounded-full px-1.5 text-[10px] ${tab === t.key ? 'bg-white/20' : 'bg-bg-secondary'}`}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {editorOpen && (
          <div className="mb-4">
            <ArticleEditor
              initial={editorInitial}
              onCancel={() => {
                setEditorOpen(false);
                setEditingId(null);
                setAnsweringGapId(null);
              }}
              onSave={handleSave}
            />
          </div>
        )}

        {/* ---------------- ARTICLES ---------------- */}
        {tab === 'articles' && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter articles"
                  className={`${inputClass} pl-9`}
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as KnowledgeStatus | 'all')}
                className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-secondary"
              >
                <option value="all">All statuses</option>
                <option value="published">Published</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
              <button
                type="button"
                onClick={() => void handleImportFaqs()}
                disabled={busy}
                className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                <Download size={13} /> Import my FAQs
              </button>
            </div>

            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <BookOpen className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
                <p className="mx-auto max-w-sm text-sm text-text-secondary">
                  {articles.length === 0
                    ? 'Nothing here yet. Import the FAQs from your business profile, or write the five questions callers ask you every week.'
                    : 'No article matches that filter.'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((article) => (
                  <motion.div
                    key={article.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-border bg-bg-secondary p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-primary">{article.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                          {article.summary || article.body}
                        </p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[article.status]}`}>
                        {article.status}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary/80">
                      <span>{AUDIENCE_LABELS[article.audience]}</span>
                      {article.category && <span>{article.category}</span>}
                      <span>v{article.version}</span>
                      <span>
                        Used {article.usage_count}× · last {relativeTime(article.last_used_at)}
                      </span>
                      {article.source !== 'manual' && <span>{SOURCE_LABELS[article.source]}</span>}
                      {article.embedding_stale && article.status === 'published' && (
                        <span className="text-warning-500">keyword-only</span>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                      <button
                        type="button"
                        onClick={() => openEdit(article)}
                        className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleToggleStatus(article)}
                        className="focus-ring flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                      >
                        {article.status === 'published' ? <X size={12} /> : <Check size={12} />}
                        {article.status === 'published' ? 'Unpublish' : 'Publish'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setHistoryFor(historyFor === article.id ? null : article.id)}
                        aria-expanded={historyFor === article.id}
                        className="focus-ring flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                      >
                        <History size={12} /> History
                        <ChevronDown
                          size={11}
                          className={`transition-transform ${historyFor === article.id ? 'rotate-180' : ''}`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(article)}
                        aria-label="Delete article"
                        className="focus-ring ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                    <AnimatePresence initial={false}>
                      {historyFor === article.id && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="pt-3">
                            <VersionHistory
                              articleId={article.id}
                              onRestore={async (version) => {
                                try {
                                  await restoreVersion(article.id, version);
                                  toast(`Restored v${version.version}`, 'success');
                                  await load();
                                } catch {
                                  toast('Could not restore that version', 'error');
                                }
                              }}
                            />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ---------------- GAPS ---------------- */}
        {tab === 'gaps' && (
          <>
            <p className="mb-3 text-xs leading-relaxed text-text-secondary">
              Questions callers asked that nothing in your knowledge base answered. Ranked by how often they
              came up — the top one is costing you the most conversations.
            </p>

            {gaps.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <Lightbulb className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
                <p className="text-sm text-text-secondary">
                  Nothing unanswered right now. New ones appear here automatically after calls.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {gaps.map((gap) => (
                  <motion.div
                    key={gap.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-border bg-bg-secondary p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium text-text-primary">
                        &ldquo;{gap.question}&rdquo;
                      </p>
                      <span className="rounded-full bg-warning-500/10 px-2.5 py-0.5 text-xs font-semibold text-warning-500">
                        asked {gap.asked_count}×
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-text-secondary/80">
                      From {gap.source} · last {relativeTime(gap.last_asked_at)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => openGapAnswer(gap)}
                        className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
                      >
                        <Sparkles size={12} /> Answer this
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await setGapStatus(gap.id, 'dismissed');
                          setGaps((prev) => prev.filter((g) => g.id !== gap.id));
                        }}
                        className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                      >
                        Not worth answering
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ---------------- TEST ---------------- */}
        {tab === 'test' && (
          <>
            <p className="mb-3 text-xs leading-relaxed text-text-secondary">
              Ask something the way a caller would. This runs the same search your phone assistant runs and
              shows you the exact answer it would give.
            </p>

            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={testQuestion}
                onChange={(e) => setTestQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleTest();
                }}
                placeholder="Do you work weekends?"
                className={`${inputClass} min-w-[240px] flex-1`}
              />
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testing || !testQuestion.trim()}
                className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
                Ask
              </button>
            </div>

            {testResult && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4 space-y-3">
                <div className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
                    What the assistant would say
                  </p>
                  <p className="text-sm leading-relaxed text-text-primary">{testResult.spokenAnswer}</p>
                </div>

                <p className="text-[11px] text-text-secondary/80">
                  {testResult.semantic
                    ? 'Matched on meaning and keywords.'
                    : 'Matched on keywords only — no embedding provider is configured, so wording matters more than usual.'}
                </p>

                {testResult.hits.length > 0 && (
                  <div className="space-y-2">
                    {testResult.hits.map((hit) => (
                      <div key={hit.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-text-primary">{hit.title}</p>
                          <span className="shrink-0 text-[11px] text-text-secondary/70">
                            {hit.lexical_rank ? `keyword #${hit.lexical_rank}` : ''}
                            {hit.lexical_rank && hit.semantic_rank ? ' · ' : ''}
                            {hit.semantic_rank ? `meaning #${hit.semantic_rank}` : ''}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{hit.summary || hit.body}</p>
                      </div>
                    ))}
                  </div>
                )}

                {testResult.hits.length === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditorInitial({ ...EMPTY_ARTICLE_FORM, title: testQuestion.trim(), status: 'published' });
                      setEditingId(null);
                      setAnsweringGapId(null);
                      setEditorOpen(true);
                      setTab('articles');
                    }}
                    className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary"
                  >
                    <Plus size={13} /> Write the answer to this
                  </button>
                )}
              </motion.div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this article?"
        description={`"${pendingDelete?.title ?? ''}" and its edit history will be removed. Your assistant will stop being able to answer this question.`}
        confirmLabel="Yes, delete it"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}
