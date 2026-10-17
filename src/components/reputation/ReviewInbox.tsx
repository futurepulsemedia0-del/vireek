import { useMemo, useState } from 'react';
import { ChevronDown, MessageSquareText, Plus, Search, Trash2, EyeOff, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { ReplyEditor } from '@/components/reputation/ReplyEditor';
import { AddReviewModal } from '@/components/reputation/AddReviewModal';
import { Stars } from '@/components/reputation/Stars';
import {
  PLATFORMS,
  PLATFORM_LABEL,
  deleteManualReview,
  filterReviews,
  formatDate,
  setReviewStatus,
  type InboxFilter,
  type Overview,
  type Platform,
  type Review,
} from '@/lib/reputation';

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'all', label: 'All' },
  { key: 'replied', label: 'Replied' },
  { key: 'dismissed', label: 'Dismissed' },
];

function StatusChip({ review }: { review: Review }) {
  const map = {
    new: ['Needs reply', 'bg-warning-500/10 text-warning-500'],
    replied: ['Replied', 'bg-success/10 text-success'],
    dismissed: ['Dismissed', 'bg-bg-tertiary text-text-secondary'],
  } as const;
  const [label, cls] = map[review.status];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
}

export function ReviewInbox({ data, onChange }: { data: Overview; onChange: (o: Overview) => void }) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<InboxFilter>('needs_reply');
  const [platform, setPlatform] = useState<Platform | 'all'>('all');
  const [maxRating, setMaxRating] = useState(5);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Review | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = useMemo(() => filterReviews(data.reviews, { filter, platform, maxRating, search }), [data.reviews, filter, platform, maxRating, search]);
  const counts = useMemo(() => {
    const c = { needs_reply: 0, all: data.reviews.length, replied: 0, dismissed: 0 };
    for (const r of data.reviews) {
      if (r.status === 'new') c.needs_reply++;
      else if (r.status === 'replied') c.replied++;
      else c.dismissed++;
    }
    return c;
  }, [data.reviews]);
  const platformInfo = (p: Platform) => data.platforms.find((x) => x.platform === p);

  const toggleStatus = async (r: Review, status: 'new' | 'dismissed') => {
    setBusyId(r.id);
    try {
      onChange(await setReviewStatus(r.id, status));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the review.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const empty = data.reviews.length === 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {data.total} review{data.total === 1 ? '' : 's'}
          {data.truncated && ` · showing the latest ${data.reviews.length}`}
        </p>
        <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden="true" /> Log a review
        </Button>
      </div>

      {empty ? (
        <EmptyState
          icon={MessageSquareText}
          title="No reviews yet"
          description={data.connections.length ? 'Reviews will appear here after the next sync. You can also log one by hand.' : 'Connect Google, Yelp or Facebook under Sources & alerts, or log a review by hand to start tracking.'}
          action={{ label: 'Log a review', onClick: () => setAdding(true) }}
        />
      ) : (
        <>
          <div className="mb-4 space-y-3">
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filter reviews">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium ${filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                >
                  {f.label} <span className="text-xs opacity-70">{counts[f.key]}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Input aria-label="Search reviews" icon={Search} placeholder="Search reviewer or text" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value as Platform | 'all')} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary">
                <option value="all">All platforms</option>
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
              <select aria-label="Rating" value={maxRating} onChange={(e) => setMaxRating(Number(e.target.value))} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary">
                <option value={5}>Any rating</option>
                <option value={3}>3 stars &amp; below</option>
                <option value={2}>2 stars &amp; below</option>
                <option value={1}>1 star only</option>
              </select>
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={filter === 'needs_reply' ? MessageSquareText : Search}
              title={filter === 'needs_reply' && !search && platform === 'all' && maxRating === 5 ? "You're all caught up" : 'No reviews match'}
              description={filter === 'needs_reply' && !search && platform === 'all' && maxRating === 5 ? 'Every review has a reply or was dismissed.' : 'Try a different filter or search.'}
            />
          ) : (
            <ul className="space-y-3">
              {visible.map((r) => {
                const open = openId === r.id;
                const info = platformInfo(r.platform);
                const conn = r.connection_id ? data.connections.find((c) => c.id === r.connection_id) : undefined;
                const canPost = !!(info?.reply && info.configured && r.source === 'api' && conn && conn.status === 'active');
                return (
                  <li key={r.id} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Stars rating={r.rating} />
                          <span className="text-sm font-semibold text-text-primary">{r.reviewer_name}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {PLATFORM_LABEL[r.platform]} · {formatDate(r.reviewed_at)}
                          {r.source === 'manual' && ' · logged manually'}
                        </p>
                      </div>
                      <StatusChip review={r} />
                    </div>

                    <p className="mt-3 whitespace-pre-wrap break-words text-sm text-text-primary">
                      {r.body || <span className="text-text-secondary">Rating only — no written comment.</span>}
                    </p>

                    {r.status === 'replied' && r.reply_text && !open && (
                      <div className="mt-3 rounded-xl bg-bg-tertiary p-3 text-sm">
                        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Your reply</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-text-primary">{r.reply_text}</p>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {r.status !== 'dismissed' && (
                        <Button type="button" size="sm" variant={r.status === 'new' ? 'primary' : 'secondary'} aria-expanded={open} onClick={() => setOpenId(open ? null : r.id)}>
                          {r.status === 'replied' ? 'Edit reply' : 'Reply'}
                          <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                        </Button>
                      )}
                      {r.status === 'new' && (
                        <Button type="button" size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => toggleStatus(r, 'dismissed')}>
                          <EyeOff size={16} aria-hidden="true" /> Dismiss
                        </Button>
                      )}
                      {r.status === 'dismissed' && (
                        <Button type="button" size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => toggleStatus(r, 'new')}>
                          <Undo2 size={16} aria-hidden="true" /> Restore
                        </Button>
                      )}
                      {r.source === 'manual' && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                          <Trash2 size={16} aria-hidden="true" /> Delete
                        </Button>
                      )}
                    </div>

                    {open && <div className="mt-4"><ReplyEditor review={r} platform={info} canPost={canPost} onChange={onChange} /></div>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {adding && <AddReviewModal onClose={() => setAdding(false)} onAdded={onChange} />}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this logged review?"
        description="It's removed from your inbox and trends. Reviews synced from a platform can't be deleted here."
        confirmLabel="Delete review"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const r = deleting;
          setDeleting(null);
          if (!r) return;
          try {
            onChange(await deleteManualReview(r.id));
            toast('Review deleted.', 'success');
          } catch (e) {
            toast(e instanceof Error ? e.message : 'Could not delete the review.', 'error');
          }
        }}
      />
    </div>
  );
}
