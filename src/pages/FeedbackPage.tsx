import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ChevronUp,
  Lightbulb,
  Loader as Loader2,
  MessageSquare,
  Plus,
  RotateCw,
  Search,
  ThumbsUp,
  X,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchRoadmapItems,
  fetchMyVotedItemIds,
  submitRoadmapItem,
  voteRoadmapItem,
  unvoteRoadmapItem,
  ROADMAP_STATUS_META,
  ROADMAP_CATEGORY_META,
  type RoadmapItem,
  type RoadmapCategory,
  type RoadmapStatus,
} from '@/lib/roadmap';
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_TITLE_MAX,
  countByStatus,
  isDuplicateVoteError,
  selectFeedbackItems,
  validateIdeaDraft,
  type FeedbackCategoryFilter,
  type FeedbackSort,
  type FeedbackStatusFilter,
} from '@/lib/feedbackBoard';

const STATUS_TABS: Array<{ value: FeedbackStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'under_review', label: ROADMAP_STATUS_META.under_review.label },
  { value: 'planned', label: ROADMAP_STATUS_META.planned.label },
  { value: 'in_progress', label: ROADMAP_STATUS_META.in_progress.label },
  { value: 'shipped', label: ROADMAP_STATUS_META.shipped.label },
];

const STATUS_STYLE: Record<RoadmapStatus, string> = {
  under_review: 'bg-bg-tertiary text-text-secondary',
  planned: 'bg-accent/10 text-accent',
  in_progress: 'bg-warning-500/10 text-warning-500',
  shipped: 'bg-success-500/10 text-success-500',
  declined: 'bg-danger/10 text-danger',
};

const STATUS_LABEL: Record<RoadmapStatus, string> = {
  under_review: ROADMAP_STATUS_META.under_review.label,
  planned: ROADMAP_STATUS_META.planned.label,
  in_progress: ROADMAP_STATUS_META.in_progress.label,
  shipped: ROADMAP_STATUS_META.shipped.label,
  declined: 'Declined',
};

const selectClass =
  'focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary';

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function FeedbackPage() {
  const { user, profileLoading } = useAuth();
  const { toast } = useToast();
  // The ideas board is a global, cross-account board (roadmap_items has no tenant
  // column) and votes are per person: roadmap_votes RLS is user_id = auth.uid().
  // So everything here is keyed to the signed-in user, for owners and team members alike.
  const ready = !!user && !profileLoading;

  const [items, setItems] = useState<RoadmapItem[]>([]);
  const [votedIds, setVotedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const [status, setStatus] = useState<FeedbackStatusFilter>('all');
  const [category, setCategory] = useState<FeedbackCategoryFilter>('all');
  const [sort, setSort] = useState<FeedbackSort>('top');
  const [query, setQuery] = useState('');
  const [onlyMyVotes, setOnlyMyVotes] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [formCategory, setFormCategory] = useState<RoadmapCategory>('feature');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [all, mine] = await Promise.all([
        fetchRoadmapItems(),
        fetchMyVotedItemIds(user.id).catch(() => null),
      ]);
      setItems(all);
      if (mine) setVotedIds(mine);
      else toast('Could not load your votes — vote buttons may be out of date.', 'error');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const counts = useMemo(() => countByStatus(items), [items]);
  const visible = useMemo(
    () => selectFeedbackItems(items, { status, category, sort, query, onlyMyVotes, votedIds }),
    [items, status, category, sort, query, onlyMyVotes, votedIds]
  );
  const filtersActive = status !== 'all' || category !== 'all' || query.trim() !== '' || onlyMyVotes;

  const clearFilters = () => {
    setStatus('all');
    setCategory('all');
    setQuery('');
    setOnlyMyVotes(false);
  };

  const setPending = (id: string, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const patchVotes = (id: string, delta: 1 | -1, voted: boolean) => {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, votes_count: Math.max(i.votes_count + delta, 0) } : i))
    );
    setVotedIds((prev) => {
      const next = new Set(prev);
      if (voted) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  async function handleVote(item: RoadmapItem) {
    if (!user || pendingIds.has(item.id)) return;
    const hadVoted = votedIds.has(item.id);
    setPending(item.id, true);
    patchVotes(item.id, hadVoted ? -1 : 1, !hadVoted); // optimistic
    try {
      if (hadVoted) await unvoteRoadmapItem(item.id, user.id);
      else await voteRoadmapItem(item.id, user.id);
    } catch (err) {
      if (!hadVoted && isDuplicateVoteError(err)) {
        // Already recorded (second tab / double submit): keep the voted state, undo the extra +1.
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, votes_count: Math.max(i.votes_count - 1, 0) } : i)));
      } else {
        patchVotes(item.id, hadVoted ? 1 : -1, hadVoted); // rollback
        toast('Could not save your vote — please try again.', 'error');
      }
    } finally {
      setPending(item.id, false);
    }
  }

  const errors = validateIdeaDraft({ title, description });
  const hasErrors = Object.keys(errors).length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!user || submitting || hasErrors) return;
    setSubmitting(true);
    try {
      const created = await submitRoadmapItem({ title, description, category: formCategory, userId: user.id });
      setItems((prev) => [created, ...prev]);
      setTitle('');
      setDescription('');
      setFormCategory('feature');
      setTouched(false);
      setFormOpen(false);
      clearFilters();
      toast('Thanks! Your idea is live and open for votes.', 'success');
    } catch {
      toast('Could not submit your idea — please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const showLoading = loading || profileLoading;

  return (
    <DashboardLayout activeLabel="Feedback">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Lightbulb size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Feedback &amp; Ideas</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Tell us what to build next and vote on what matters most to your business.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setFormOpen((o) => !o)} aria-expanded={formOpen} aria-controls="feedback-form">
          {formOpen ? <X size={16} /> : <Plus size={16} />}
          {formOpen ? 'Close' : 'Submit an idea'}
        </Button>
      </div>

      {formOpen && (
        <form
          id="feedback-form"
          onSubmit={handleSubmit}
          noValidate
          className="mb-6 space-y-4 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-6 dark:shadow-card-dark"
        >
          <Input
            label="Title"
            required
            value={title}
            maxLength={FEEDBACK_TITLE_MAX + 20}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sync jobs with Google Calendar"
            error={touched ? errors.title : undefined}
            helperText={`${title.trim().length}/${FEEDBACK_TITLE_MAX}`}
          />
          <Textarea
            label="Details (optional)"
            value={description}
            rows={4}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What problem would this solve for you?"
            error={touched ? errors.description : undefined}
            helperText={`${description.trim().length}/${FEEDBACK_DESCRIPTION_MAX}`}
          />
          <div>
            <label htmlFor="feedback-category" className="mb-1.5 block text-sm font-medium text-text-primary">
              Category
            </label>
            <select
              id="feedback-category"
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value as RoadmapCategory)}
              className={`${selectClass} w-full sm:w-auto`}
            >
              {(Object.keys(ROADMAP_CATEGORY_META) as RoadmapCategory[]).map((c) => (
                <option key={c} value={c}>
                  {ROADMAP_CATEGORY_META[c].label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting ? 'Submitting…' : 'Submit idea'}
            </Button>
          </div>
        </form>
      )}

      <div className="mb-3 flex gap-1 overflow-x-auto rounded-xl bg-bg-tertiary p-1" role="tablist" aria-label="Filter by status">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            onClick={() => setStatus(t.value)}
            className={`focus-ring shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition-colors sm:text-sm ${
              status === t.value ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label} <span className="text-text-secondary/70">{counts[t.value]}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <Input
          icon={Search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ideas"
          aria-label="Search ideas"
        />
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategoryFilter)} className={selectClass}>
          <option value="all">All categories</option>
          {(Object.keys(ROADMAP_CATEGORY_META) as RoadmapCategory[]).map((c) => (
            <option key={c} value={c}>
              {ROADMAP_CATEGORY_META[c].label}
            </option>
          ))}
        </select>
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as FeedbackSort)} className={selectClass}>
          <option value="top">Most voted</option>
          <option value="newest">Newest</option>
        </select>
        <button
          type="button"
          aria-pressed={onlyMyVotes}
          onClick={() => setOnlyMyVotes((v) => !v)}
          className={`focus-ring flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            onlyMyVotes ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary'
          }`}
        >
          <ThumbsUp size={14} />
          My votes ({votedIds.size})
        </button>
      </div>

      {showLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading ideas">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-bg-secondary px-6 py-14 text-center">
          <AlertCircle size={24} className="text-danger" />
          <p className="text-sm text-text-secondary">We couldn't load the ideas board.</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RotateCw size={14} />
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        items.length === 0 ? (
          <EmptyState
            icon={Lightbulb}
            title="No ideas yet"
            description="Be the first to suggest something. The best ideas rise to the top as people vote."
            action={{ label: 'Submit an idea', onClick: () => setFormOpen(true) }}
          />
        ) : (
          <EmptyState
            icon={Search}
            title="No ideas match your filters"
            description="Try a different search or clear the filters."
            action={filtersActive ? { label: 'Clear filters', onClick: clearFilters } : undefined}
          />
        )
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => {
            const voted = votedIds.has(item.id);
            const pending = pendingIds.has(item.id);
            return (
              <li
                key={item.id}
                className="flex gap-3 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:gap-4 sm:p-5 dark:shadow-card-dark"
              >
                <button
                  type="button"
                  onClick={() => void handleVote(item)}
                  disabled={pending}
                  aria-pressed={voted}
                  aria-label={`${voted ? 'Remove your vote from' : 'Vote for'} ${item.title}`}
                  className={`focus-ring flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-xl border text-sm font-semibold transition-colors disabled:opacity-60 ${
                    voted ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/50 hover:text-text-primary'
                  }`}
                >
                  <ChevronUp size={18} />
                  <span>{item.votes_count}</span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words text-base font-semibold text-text-primary">{item.title}</h3>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[item.status]}`}>
                      {STATUS_LABEL[item.status]}
                    </span>
                    {item.submitted_by === user?.id && (
                      <span className="rounded-full bg-ai/10 px-2.5 py-0.5 text-xs font-medium text-ai">Your idea</span>
                    )}
                  </div>
                  {item.description && (
                    <p className="mt-1.5 whitespace-pre-line break-words text-sm leading-relaxed text-text-secondary">{item.description}</p>
                  )}
                  {item.admin_note && (
                    <p className="mt-2 flex gap-2 rounded-lg bg-accent/5 px-3 py-2 text-sm text-text-primary">
                      <MessageSquare size={15} className="mt-0.5 shrink-0 text-accent" />
                      <span className="break-words">
                        <span className="font-medium">Vireek team: </span>
                        {item.admin_note}
                      </span>
                    </p>
                  )}
                  <p className="mt-2 text-xs text-text-secondary/70">
                    {ROADMAP_CATEGORY_META[item.category]?.label ?? 'General'} · {formatDate(item.created_at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardLayout>
  );
}
