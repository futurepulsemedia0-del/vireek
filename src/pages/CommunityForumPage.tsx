/**
 * Customer Community — /dashboard/community
 *
 * A real, in-app forum: customers post questions and share experience
 * inside categories, and reply to each other. Backed by
 * community_categories / community_threads (src/lib/community.ts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, MessageCircle, Pin, Plus, Search, ThumbsUp, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  createCommunityThread,
  fetchCommunityCategories,
  fetchCommunityThreads,
  type CommunityCategory,
  type CommunityThread,
} from '@/lib/community';

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function NewThreadForm({
  categories,
  onCreated,
  onClose,
}: {
  categories: CommunityCategory[];
  onCreated: (t: CommunityThread) => void;
  onClose: () => void;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [authorName, setAuthorName] = useState(profile?.full_name || profile?.company_name || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (title.trim().length < 4 || body.trim().length < 1 || !categoryId || !authorName.trim()) return;
    setSaving(true);
    try {
      const thread = await createCommunityThread({ categoryId, title: title.trim(), body: body.trim(), authorName: authorName.trim() });
      onCreated(thread);
      onClose();
    } catch {
      toast('Could not post your question', 'error');
    }
    setSaving(false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="mb-4 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">Ask the community</p>
        <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1 text-text-secondary hover:text-accent">
          <X size={16} />
        </button>
      </div>
      <div className="grid gap-3">
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What's your question?"
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="Add details — the more specific, the better the answers."
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
        />
        <input
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
          placeholder="Your name (shown on the post)"
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
        />
        <div className="flex justify-end">
          <button
            type="button"
            disabled={saving || title.trim().length < 4 || !body.trim() || !authorName.trim()}
            onClick={submit}
            className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? 'Posting…' : 'Post question'}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function ThreadRow({ thread, categoryName }: { thread: CommunityThread; categoryName: string }) {
  return (
    <Link to={`/dashboard/community/${thread.id}`}>
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-4 rounded-2xl border border-border bg-bg-secondary p-4 hover:border-accent/40">
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 text-text-secondary">
          <ThumbsUp size={14} />
          <span className="text-sm font-semibold text-text-primary">{thread.upvote_count}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {thread.is_pinned && <Pin size={13} className="text-accent" />}
            <p className="truncate text-sm font-semibold text-text-primary">{thread.title}</p>
            {thread.status === 'answered' && (
              <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
                <CheckCircle2 size={11} /> Answered
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-1 text-xs text-text-secondary">{thread.body}</p>
          <p className="mt-2 text-[11px] text-text-secondary">
            {categoryName} · {thread.author_name} · {timeAgo(thread.created_at)} · {thread.reply_count} replies
          </p>
        </div>
      </motion.div>
    </Link>
  );
}

export function CommunityForumPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [categories, setCategories] = useState<CommunityCategory[]>([]);
  const [threads, setThreads] = useState<CommunityThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [cats, thrds] = await Promise.all([
        fetchCommunityCategories(),
        fetchCommunityThreads({ categoryId: categoryFilter === 'all' ? undefined : categoryFilter, search: search || undefined }),
      ]);
      setCategories(cats);
      setThreads(thrds);
    } catch {
      toast('Could not load the community', 'error');
    }
    setLoading(false);
  }, [user, categoryFilter, search, toast]);

  useEffect(() => { void load(); }, [load]);

  const categoryName = useMemo(() => {
    const map = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? 'General';
  }, [categories]);

  return (
    <DashboardLayout activeLabel="Community">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <MessageCircle size={22} className="text-accent" /> Customer Community
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Ask questions, share what's working, and learn from other Vireek customers.
            </p>
          </div>
          <button type="button" onClick={() => setShowForm((v) => !v)} className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white">
            <Plus size={15} /> New question
          </button>
        </div>

        {showForm && <NewThreadForm categories={categories} onCreated={(t) => setThreads((prev) => [t, ...prev])} onClose={() => setShowForm(false)} />}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search questions…"
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary"
            />
          </div>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
        ) : threads.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <MessageCircle className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">No questions yet — be the first to ask.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {threads.map((t) => <ThreadRow key={t.id} thread={t} categoryName={categoryName(t.category_id)} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
