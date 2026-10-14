/**
 * Duplicates — /dashboard/duplicates
 *
 * Finds customers / leads that look like the same person (same phone, email
 * or address), lets you merge them side by side (all history moves to the
 * record you keep) and undo any merge for 7 days. Detection, merge and undo
 * run in the database, scoped to the account owner and audit-logged; see
 * src/lib/duplicates.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GitMerge, Lock, Loader2, ShieldCheck, TriangleAlert, Undo2, Users } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { MergeDialog } from '@/components/duplicates/MergeDialog';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DUPLICATE_KINDS,
  DUPLICATE_KIND_LABELS,
  MERGE_FIELDS,
  REASON_LABELS,
  UNMERGE_WINDOW_DAYS,
  DuplicatesError,
  canManageDuplicates,
  daysLeftToUnmerge,
  dismissPair,
  fetchDuplicateCounts,
  fetchDuplicatePairs,
  fetchRecentMerges,
  humanizeTable,
  isBlank,
  totalMoved,
  unmergeRecords,
  type DuplicateKind,
  type DuplicatePair,
  type DuplicateRecord,
  type MergeResult,
  type RecentMerge,
} from '@/lib/duplicates';

type View = 'review' | 'merges';

const PAGE_SIZE = 10;

function errorMessage(e: unknown): string {
  return e instanceof DuplicatesError ? e.message : 'Something went wrong. Please try again.';
}

function RecordSummary({ kind, record, label }: { kind: DuplicateKind; record: DuplicateRecord; label: string }) {
  const fields = MERGE_FIELDS[kind].filter((f) => f.key !== 'name' && !isBlank(record[f.key]));
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border bg-bg-primary p-3" aria-label={label}>
      <p className="truncate text-sm font-medium text-text-primary">{record.name}</p>
      <dl className="mt-1 space-y-0.5 text-xs text-text-secondary">
        {fields.map((f) => (
          <div key={f.key} className="flex gap-1.5">
            <dt className="shrink-0 opacity-70">{f.label}:</dt>
            <dd className="min-w-0 truncate">{record[f.key]}</dd>
          </div>
        ))}
        {record.created_at && (
          <div className="flex gap-1.5">
            <dt className="shrink-0 opacity-70">Added:</dt>
            <dd>{new Date(record.created_at).toLocaleDateString()}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function DuplicatesPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const allowed = canManageDuplicates(isOwner, permissions);

  const [kind, setKind] = useState<DuplicateKind>('customers');
  const [view, setView] = useState<View>('review');
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<DuplicateKind, number> | null>(null);
  const [merges, setMerges] = useState<RecentMerge[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<DuplicatePair | null>(null);
  const [undoTarget, setUndoTarget] = useState<RecentMerge | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [page, c, recent] = await Promise.all([
        fetchDuplicatePairs(kind, PAGE_SIZE, 0),
        fetchDuplicateCounts(),
        fetchRecentMerges(),
      ]);
      if (requestId !== requestRef.current) return; // superseded by a newer request
      setPairs(page.pairs);
      setTotal(page.total);
      setCounts(c);
      setMerges(recent);
    } catch (e) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(e));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load();
  }, [allowed, load]);

  const loadMore = async () => {
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchDuplicatePairs(kind, PAGE_SIZE, pairs.length);
      if (requestId !== requestRef.current) return;
      setPairs((prev) => {
        const seen = new Set(prev.map((p) => p.key));
        return [...prev, ...page.pairs.filter((p) => !seen.has(p.key))];
      });
      setTotal(page.total);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleDismiss = async (pair: DuplicatePair) => {
    if (busyKey) return;
    setBusyKey(pair.key);
    try {
      await dismissPair(pair.kind, pair.a.id, pair.b.id);
      toast('Marked as not a duplicate.', 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleMerged = (result: MergeResult) => {
    setMergeTarget(null);
    const moved = totalMoved(result.moved);
    toast(
      moved > 0
        ? `Merged. ${moved} linked ${moved === 1 ? 'record' : 'records'} moved. You can undo this for ${UNMERGE_WINDOW_DAYS} days.`
        : `Merged. You can undo this for ${UNMERGE_WINDOW_DAYS} days.`,
      'success',
    );
    const skipped = totalMoved(result.skipped);
    if (skipped > 0) {
      toast(
        `${skipped} linked ${skipped === 1 ? 'record was' : 'records were'} left behind because an identical one already exists (${Object.keys(result.skipped).map(humanizeTable).join(', ')}).`,
        'info',
      );
    }
    void load();
  };

  const handleUndo = async () => {
    if (!undoTarget) return;
    try {
      const r = await unmergeRecords(undoTarget.id);
      toast(
        r.not_restored.length > 0
          ? `Merge undone. ${r.not_restored.map(humanizeTable).join(', ')} couldn't be moved back automatically.`
          : 'Merge undone.',
        'success',
      );
      setUndoTarget(null);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error'); // dialog stays open so it can be retried or cancelled
    }
  };

  const visibleMerges = merges.filter((m) => m.kind === kind);

  return (
    <DashboardLayout activeLabel="Duplicates">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Duplicates</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Merge records that are really the same person. All history moves to the one you keep, and you can undo for{' '}
            {UNMERGE_WINDOW_DAYS} days.
          </p>
        </div>

        {!allowed ? (
          <EmptyState
            icon={Lock}
            title="You don't have access to duplicates"
            description="Ask the account owner to give you billing access if you need to merge records."
          />
        ) : (
          <>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div role="tablist" aria-label="Record type" className="flex gap-1">
                {DUPLICATE_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={kind === k}
                    onClick={() => setKind(k)}
                    className={`focus-ring rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
                      kind === k ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                    }`}
                  >
                    {DUPLICATE_KIND_LABELS[k].plural}
                    {counts && <span className="ml-1.5 text-xs opacity-70">{counts[k]}</span>}
                  </button>
                ))}
              </div>
              <div role="tablist" aria-label="View" className="flex gap-1">
                {(['review', 'merges'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    className={`focus-ring rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
                      view === v ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {v === 'review' ? 'To review' : 'Recent merges'}
                    {v === 'merges' && (
                      <span className="ml-1.5 text-xs opacity-70">{visibleMerges.length}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <SkeletonCardList count={4} rows={3} />
            ) : error ? (
              <EmptyState
                icon={TriangleAlert}
                title="Couldn't load duplicates"
                description={error}
                action={{ label: 'Try again', onClick: () => void load() }}
              />
            ) : view === 'review' ? (
              pairs.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  title={`No duplicate ${DUPLICATE_KIND_LABELS[kind].plural.toLowerCase()} found`}
                  description="We compare phone numbers, emails and addresses. New matches show up here automatically."
                />
              ) : (
                <div className="space-y-3">
                  <p className="px-1 text-sm text-text-secondary">
                    {total} possible {total === 1 ? 'duplicate' : 'duplicates'}
                  </p>
                  <ul className="space-y-3">
                    {pairs.map((pair) => (
                      <li key={pair.key} className="rounded-2xl border border-border bg-bg-secondary p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              pair.confidence === 'high' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary'
                            }`}
                          >
                            {pair.confidence === 'high' ? 'Likely duplicate' : 'Possible duplicate'}
                          </span>
                          {pair.reasons.map((r) => (
                            <span key={r} className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">
                              {REASON_LABELS[r]}
                            </span>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-col gap-3 md:flex-row">
                          <RecordSummary kind={kind} record={pair.a} label={`First record: ${pair.a.name}`} />
                          <RecordSummary kind={kind} record={pair.b} label={`Second record: ${pair.b.name}`} />
                        </div>
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyKey === pair.key}
                            onClick={() => void handleDismiss(pair)}
                            aria-label={`Not a duplicate: ${pair.a.name} and ${pair.b.name}`}
                          >
                            Not a duplicate
                          </Button>
                          <Button
                            size="sm"
                            disabled={busyKey === pair.key}
                            onClick={() => setMergeTarget(pair)}
                            aria-label={`Review and merge ${pair.a.name} and ${pair.b.name}`}
                          >
                            <GitMerge size={16} aria-hidden="true" /> Review &amp; merge
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {pairs.length < total && (
                    <div className="flex justify-center pt-2">
                      <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                        {loadingMore && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                        {loadingMore ? 'Loading…' : 'Load more'}
                      </Button>
                    </div>
                  )}
                </div>
              )
            ) : visibleMerges.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No recent merges"
                description={`Merges you make stay undoable for ${UNMERGE_WINDOW_DAYS} days and appear here.`}
              />
            ) : (
              <ul className="space-y-3">
                {visibleMerges.map((m) => {
                  const days = daysLeftToUnmerge(m.expires_at);
                  return (
                    <li
                      key={m.id}
                      className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {m.merged_name ?? 'Unknown'} → {m.survivor_name ?? 'Unknown'}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {m.moved_total} linked {m.moved_total === 1 ? 'record' : 'records'} moved · merged{' '}
                          {new Date(m.merged_at).toLocaleDateString()}
                          {m.merged_by_email ? ` by ${m.merged_by_email}` : ''}
                        </p>
                        <p className={`mt-0.5 text-xs ${days <= 1 ? 'font-medium text-danger' : 'text-text-secondary'}`}>
                          {days === 0 ? 'Undo closes within 24h' : `${days} ${days === 1 ? 'day' : 'days'} left to undo`}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setUndoTarget(m)}
                        aria-label={`Undo merge of ${m.merged_name ?? 'record'} into ${m.survivor_name ?? 'record'}`}
                        className="w-full sm:w-auto"
                      >
                        <Undo2 size={16} aria-hidden="true" /> Undo merge
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      <MergeDialog pair={mergeTarget} onClose={() => setMergeTarget(null)} onMerged={handleMerged} />

      <ConfirmDialog
        open={!!undoTarget}
        title="Undo this merge?"
        description={`${undoTarget?.merged_name ?? 'The merged record'} comes back as its own record and its history moves back from ${undoTarget?.survivor_name ?? 'the kept record'}. Anything added since the merge stays where it is.`}
        confirmLabel="Undo merge"
        onConfirm={handleUndo}
        onCancel={() => setUndoTarget(null)}
      />
    </DashboardLayout>
  );
}
