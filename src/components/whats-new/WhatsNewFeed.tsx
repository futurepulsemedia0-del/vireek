import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCheck, ExternalLink, ShieldCheck, Sparkles, TriangleAlert as AlertTriangle, Wrench, Zap } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useWhatsNew } from '@/contexts/WhatsNewContext';
import type { EntryType } from '@/lib/changelog';
import { countByType, filterReleases, type TypeFilter } from '@/lib/whatsNew';

/** Opening the feed counts as reading it — after a pause, so a glance-and-leave doesn't. */
const AUTO_READ_DELAY_MS = 4000;

const TYPE_META: Record<EntryType, { label: string; icon: typeof Sparkles; text: string; ring: string }> = {
  new: { label: 'New', icon: Sparkles, text: 'text-accent', ring: 'border-accent/25 bg-accent/10' },
  improved: { label: 'Improved', icon: Zap, text: 'text-success-500', ring: 'border-success-500/25 bg-success-500/10' },
  security: { label: 'Security', icon: ShieldCheck, text: 'text-warning-500', ring: 'border-warning-500/25 bg-warning-500/10' },
  fixed: { label: 'Fixed', icon: Wrench, text: 'text-text-secondary', ring: 'border-border bg-bg-tertiary' },
};

const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'improved', label: 'Improved' },
  { id: 'security', label: 'Security' },
  { id: 'fixed', label: 'Fixed' },
];

export function WhatsNewFeed() {
  const { status, releases, unreadIds, unreadCount, markRead, markAllRead, reload } = useWhatsNew();
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [onlyNew, setOnlyNew] = useState(false);
  // What was unread when the page opened — keeps the "New" highlights after the badge clears.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (status === 'ready' && freshIds === null) setFreshIds(new Set(unreadIds));
  }, [status, unreadIds, freshIds]);

  useEffect(() => {
    if (!freshIds || freshIds.size === 0) return;
    const timer = setTimeout(() => {
      void markRead(Array.from(freshIds));
    }, AUTO_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [freshIds, markRead]);

  const counts = useMemo(() => countByType(releases), [releases]);
  const visible = useMemo(
    () => filterReleases(releases, filter, onlyNew && freshIds ? freshIds : null),
    [releases, filter, onlyNew, freshIds],
  );
  const hasFresh = (freshIds?.size ?? 0) > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Sparkles className="h-6 w-6" aria-hidden="true" /> What’s New
          </h1>
          <p className="mt-1 text-sm text-text-secondary">Product updates, improvements, and fixes — newest first.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status === 'ready' && unreadCount > 0 && (
            <Button variant="secondary" size="sm" onClick={() => void markAllRead()}>
              <CheckCheck className="h-3.5 w-3.5" /> Mark all as read
            </Button>
          )}
          <Link
            to="/changelog"
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Public changelog <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {status === 'error' && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-500/25 bg-warning-500/10 px-3 py-2 text-sm text-warning-500"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> We couldn’t load which updates you’ve read.
          </span>
          <Button variant="secondary" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {status === 'loading' ? (
        <SkeletonCardList count={3} rows={3} />
      ) : releases.length === 0 ? (
        <EmptyState icon={Sparkles} title="No release notes yet" description="New features and improvements will show up here." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`focus-ring rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === f.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
              >
                {f.label} <span className="text-xs opacity-70">{counts[f.id]}</span>
              </button>
            ))}
            <label className={`ml-auto flex items-center gap-2 text-sm ${hasFresh ? 'cursor-pointer text-text-primary' : 'text-text-secondary/60'}`}>
              <input type="checkbox" disabled={!hasFresh} checked={onlyNew && hasFresh} onChange={(e) => setOnlyNew(e.target.checked)} />
              Only new for me
            </label>
          </div>

          {status === 'ready' && !hasFresh && <p className="text-sm text-text-secondary">You’re all caught up.</p>}

          {visible.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No updates match"
              description="Try another type or turn off “Only new for me”."
              action={{
                label: 'Clear filters',
                onClick: () => {
                  setFilter('all');
                  setOnlyNew(false);
                },
              }}
            />
          ) : (
            <ol className="space-y-4">
              {visible.map((release) => {
                const isFresh = freshIds?.has(release.id) ?? false;
                return (
                  <li key={release.id}>
                    <Card className={`!p-5 sm:!p-6 ${isFresh ? 'border-accent/40' : ''}`}>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold text-text-primary">{release.date}</h2>
                        {isFresh && (
                          <span
                            data-testid="new-badge"
                            className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white"
                          >
                            New
                          </span>
                        )}
                      </div>
                      <ul className="mt-4 space-y-4">
                        {release.entries.map((entry, i) => {
                          const meta = TYPE_META[entry.type];
                          const Icon = meta.icon;
                          return (
                            <li key={`${entry.title}-${i}`} className="flex gap-3">
                              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${meta.ring} ${meta.text}`}>
                                <Icon size={16} aria-hidden="true" />
                              </span>
                              <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-text-primary">
                                  <span className="sr-only">{meta.label}: </span>
                                  {entry.title}
                                </h3>
                                <p className="mt-1 text-sm leading-relaxed text-text-secondary">{entry.body}</p>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </Card>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
