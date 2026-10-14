/**
 * Trash — /dashboard/trash
 *
 * Everything deleted from Customers, Jobs, Quotes, Invoices and Leads
 * lands here for TRASH_RETENTION_DAYS. Restore it any time before then;
 * after that a daily database job removes it permanently. Restore is open
 * to the owner and billing-access team members; "Delete forever" is
 * owner-only. All data flows through the RPCs in src/lib/trash.ts, which
 * are scoped to the account owner server-side and audit-logged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  RotateCcw,
  Search,
  Lock,
  Users,
  Wrench,
  FileText,
  Receipt,
  UserPlus,
  Clock,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  TRASH_KINDS,
  TRASH_KIND_LABELS,
  TRASH_RETENTION_DAYS,
  TrashError,
  canManageTrash,
  canPurgeTrash,
  daysUntilPurge,
  fetchTrash,
  fetchTrashCounts,
  purgeRecords,
  restoreRecords,
  type TrashItem,
  type TrashKind,
} from '@/lib/trash';

type Tab = 'all' | TrashKind;

const PAGE_SIZE = 25;

const KIND_ICONS: Record<TrashKind, typeof Users> = {
  customers: Users,
  jobs: Wrench,
  quotes: FileText,
  invoices: Receipt,
  leads: UserPlus,
};

const keyOf = (item: Pick<TrashItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;

function groupByKind(items: TrashItem[]): [TrashKind, string[]][] {
  const map = new Map<TrashKind, string[]>();
  for (const item of items) map.set(item.kind, [...(map.get(item.kind) ?? []), item.id]);
  return Array.from(map.entries());
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function errorMessage(e: unknown): string {
  if (e instanceof TrashError) return e.message;
  return 'Something went wrong. Please try again.';
}

export function TrashPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const allowed = canManageTrash(isOwner, permissions);
  const mayPurge = canPurgeTrash(isOwner);

  const [tab, setTab] = useState<Tab>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<TrashItem[]>([]);
  const [counts, setCounts] = useState<Record<TrashKind, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<TrashItem[] | null>(null);
  const requestRef = useRef(0);

  // Debounce the search box so we don't hit the database on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [rows, c] = await Promise.all([
        fetchTrash({ kind: tab === 'all' ? null : tab, search, limit: PAGE_SIZE }),
        fetchTrashCounts(),
      ]);
      if (requestId !== requestRef.current) return; // a newer request superseded this one
      setItems(rows);
      setCounts(c);
      setHasMore(rows.length === PAGE_SIZE);
      setSelected(new Set());
    } catch (e) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(e));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [tab, search]);

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
      const rows = await fetchTrash({
        kind: tab === 'all' ? null : tab,
        search,
        limit: PAGE_SIZE,
        offset: items.length,
      });
      if (requestId !== requestRef.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map(keyOf));
        return [...prev, ...rows.filter((r) => !seen.has(keyOf(r)))];
      });
      setHasMore(rows.length === PAGE_SIZE);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (item: TrashItem) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const selectedItems = useMemo(() => items.filter((i) => selected.has(keyOf(i))), [items, selected]);
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const total = counts ? TRASH_KINDS.reduce((sum, k) => sum + counts[k], 0) : 0;

  const handleRestore = async (targets: TrashItem[]) => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    try {
      let restored = 0;
      let conflicts = 0;
      for (const [kind, ids] of groupByKind(targets)) {
        const r = await restoreRecords(kind, ids);
        restored += r.restored;
        conflicts += r.conflicts;
      }
      if (restored > 0) toast(restored === 1 ? 'Restored.' : `Restored ${restored} items.`, 'success');
      if (conflicts > 0) {
        toast(
          `${conflicts} ${conflicts === 1 ? 'item' : 'items'} couldn't be restored — a record with the same phone or email already exists.`,
          'error',
        );
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
      await load();
    }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    try {
      let removed = 0;
      for (const [kind, ids] of groupByKind(purgeTarget)) removed += await purgeRecords(kind, ids);
      toast(removed === 1 ? 'Permanently deleted.' : `Permanently deleted ${removed} items.`, 'success');
      setPurgeTarget(null);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error'); // dialog stays open so the owner can retry or cancel
    }
  };

  const tabs: { key: Tab; label: string; count: number | null }[] = [
    { key: 'all', label: 'All', count: counts ? total : null },
    ...TRASH_KINDS.map((k) => ({ key: k as Tab, label: TRASH_KIND_LABELS[k].plural, count: counts ? counts[k] : null })),
  ];

  return (
    <DashboardLayout activeLabel="Trash">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Trash</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Deleted items are kept for {TRASH_RETENTION_DAYS} days, then permanently removed.
          </p>
        </div>

        {!allowed ? (
          <EmptyState
            icon={Lock}
            title="You don't have access to the trash"
            description="Ask the account owner to give you billing access if you need to restore deleted items."
          />
        ) : (
          <>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div
                role="tablist"
                aria-label="Filter trash by type"
                className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
              >
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={`focus-ring shrink-0 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
                      tab === t.key
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                    }`}
                  >
                    {t.label}
                    {t.count !== null && <span className="ml-1.5 text-xs opacity-70">{t.count}</span>}
                  </button>
                ))}
              </div>
              <div className="w-full md:max-w-xs">
                <Input
                  icon={Search}
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search deleted items…"
                  aria-label="Search deleted items"
                />
              </div>
            </div>

            {selectedItems.length > 0 && (
              <div
                role="region"
                aria-label="Bulk actions"
                className="flex flex-wrap items-center gap-2 rounded-2xl border border-accent/30 bg-accent/5 px-4 py-3"
              >
                <p className="mr-auto text-sm font-medium text-text-primary">{selectedItems.length} selected</p>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleRestore(selectedItems)}>
                  <RotateCcw size={16} /> Restore
                </Button>
                {mayPurge && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPurgeTarget(selectedItems)}>
                    <Trash2 size={16} className="text-danger" /> Delete forever
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}

            {loading ? (
              <SkeletonCardList count={5} rows={2} />
            ) : error ? (
              <EmptyState
                icon={TriangleAlert}
                title="Couldn't load the trash"
                description={error}
                action={{ label: 'Try again', onClick: () => void load() }}
              />
            ) : items.length === 0 ? (
              search ? (
                <EmptyState
                  icon={Search}
                  title="No matching items"
                  description="Nothing in the trash matches your search."
                  action={{ label: 'Clear search', onClick: () => setSearchInput('') }}
                />
              ) : (
                <EmptyState
                  icon={Trash2}
                  title={tab === 'all' ? 'Trash is empty' : `No deleted ${TRASH_KIND_LABELS[tab].plural.toLowerCase()}`}
                  description={`When you delete a customer, job, quote, invoice or lead, it shows up here for ${TRASH_RETENTION_DAYS} days.`}
                />
              )
            ) : (
              <div className="space-y-3">
                <label className="flex items-center gap-2 px-1 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(items.map(keyOf)))
                    }
                    className="focus-ring h-4 w-4 rounded border-border accent-[rgb(var(--accent))]"
                  />
                  Select all on this page
                </label>

                <ul className="space-y-3">
                  {items.map((item) => {
                    const Icon = KIND_ICONS[item.kind];
                    const days = daysUntilPurge(item.purge_at);
                    const urgent = days <= 3;
                    const isSelected = selected.has(keyOf(item));
                    return (
                      <li
                        key={keyOf(item)}
                        className={`flex flex-col gap-3 rounded-2xl border bg-bg-secondary p-4 sm:flex-row sm:items-center ${
                          isSelected ? 'border-accent/50' : 'border-border'
                        }`}
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggle(item)}
                            aria-label={`Select ${item.title}`}
                            className="focus-ring mt-2.5 h-4 w-4 shrink-0 rounded border-border accent-[rgb(var(--accent))]"
                          />
                          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                            <Icon size={16} aria-hidden="true" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium text-text-primary">{item.title}</p>
                              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                                {TRASH_KIND_LABELS[item.kind].singular}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-text-secondary">{item.subtitle}</p>
                            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                              <span>
                                Deleted {relativeTime(item.deleted_at)}
                                {item.deleted_by_email ? ` by ${item.deleted_by_email}` : ''}
                              </span>
                              <span className={`inline-flex items-center gap-1 ${urgent ? 'font-medium text-danger' : ''}`}>
                                <Clock size={12} aria-hidden="true" />
                                {days === 0 ? 'Removed within 24h' : `${days} ${days === 1 ? 'day' : 'days'} left`}
                              </span>
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 sm:shrink-0">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void handleRestore([item])}
                            aria-label={`Restore ${item.title}`}
                            className="flex-1 sm:flex-none"
                          >
                            <RotateCcw size={16} /> Restore
                          </Button>
                          {mayPurge && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setPurgeTarget([item])}
                              aria-label={`Delete ${item.title} forever`}
                              className="flex-1 sm:flex-none"
                            >
                              <Trash2 size={16} className="text-danger" /> Delete forever
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {hasMore && (
                  <div className="flex justify-center pt-2">
                    <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                      {loadingMore && <Loader2 size={16} className="animate-spin" />}
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!purgeTarget}
        title={purgeTarget && purgeTarget.length > 1 ? `Delete ${purgeTarget.length} items forever?` : 'Delete forever?'}
        description="This can't be undone. The item and its record are permanently removed and can no longer be restored."
        confirmPhrase="delete forever"
        confirmLabel="Delete forever"
        onConfirm={handlePurge}
        onCancel={() => setPurgeTarget(null)}
      />
    </DashboardLayout>
  );
}
