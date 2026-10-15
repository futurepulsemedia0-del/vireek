import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import { Header } from '@/components/Header';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { HealthBadge } from '@/components/staff/HealthBadge';
import { AccountDetailPanel } from '@/components/staff/AccountDetailPanel';
import { StaffAuditLog } from '@/components/staff/StaffAuditLog';
import {
  BAND_LABELS,
  daysBetween,
  fetchAccountOverview,
  filterAndSortRows,
  type AccountOverview,
  type ExplorerSort,
  type HealthBand,
  type StaffAccount,
} from '@/lib/staffCustomers';

const PAGE_SIZE = 25;
const BANDS: HealthBand[] = ['critical', 'at_risk', 'watch', 'new', 'healthy', 'churned'];
const SORTS: [ExplorerSort, string][] = [
  ['attention', 'Needs attention first'],
  ['health_desc', 'Healthiest first'],
  ['calls_desc', 'Most calls (30 days)'],
  ['last_call', 'Most recent call'],
  ['newest', 'Newest accounts'],
];
const SELECT_CLASS = 'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

type Tab = 'accounts' | 'audit';

/** Staff pages must never be indexed, regardless of the site-wide default. */
function useNoIndex(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    let el = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !el;
    if (!el) {
      el = document.createElement('meta');
      el.name = 'robots';
      document.head.appendChild(el);
    }
    const previous = el.content;
    el.content = 'noindex, nofollow';
    return () => {
      document.title = previousTitle;
      if (created) el?.remove();
      else if (el) el.content = previous;
    };
  }, [title]);
}

function lastCallLabel(iso: string | null): string {
  if (!iso) return 'No calls';
  const d = daysBetween(iso, new Date());
  return d === 0 ? 'Today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

export function StaffCustomersPage() {
  useNoIndex('Customers — Staff');
  const [tab, setTab] = useState<Tab>('accounts');
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [band, setBand] = useState<HealthBand | 'all'>('all');
  const [sort, setSort] = useState<ExplorerSort>('attention');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setOverview(await fetchAccountOverview());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const accounts = overview?.accounts ?? [];
  const counts = useMemo(() => {
    const c: Record<HealthBand, number> = { critical: 0, at_risk: 0, watch: 0, new: 0, healthy: 0, churned: 0 };
    accounts.forEach((a) => c[a.health.band]++);
    return c;
  }, [accounts]);
  const rows = useMemo(() => filterAndSortRows(accounts, { search, band, sort }) as StaffAccount[], [accounts, search, band, sort]);
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.companyName || a.email])), [accounts]);
  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const safePage = Math.min(page, lastPage);
  const visible = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const select = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center gap-2">
            <Users className="text-accent" size={22} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Customers</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">Internal account explorer. Every view and every sign-in is recorded in the audit log.</p>

          <div role="tablist" aria-label="Customer sections" className="mt-6 flex gap-1 border-b border-border">
            {([['accounts', 'Accounts'], ['audit', 'Audit log']] as [Tab, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === id ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-6" role="tabpanel">
            {tab === 'audit' ? (
              <StaffAuditLog accountNames={accountNames} />
            ) : loading ? (
              <div className="space-y-3" aria-busy="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Card key={i} className="space-y-2 p-4 hover:translate-y-0"><Skeleton className="h-4 w-56" /><Skeleton className="h-3 w-40" /></Card>
                ))}
              </div>
            ) : error ? (
              <EmptyState icon={AlertTriangle} title="Couldn't load customers" description="You may have lost staff access, or the connection dropped. Nothing was changed." action={{ label: 'Retry', onClick: () => void load() }} />
            ) : accounts.length === 0 ? (
              <EmptyState icon={Users} title="No customer accounts yet" description="Accounts appear here as soon as the first customer signs up." />
            ) : (
              <div className="space-y-5">
                {overview?.truncated && (
                  <p role="status" className="rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">Showing the newest 2,000 accounts. Older accounts are not included — use search in the database for those.</p>
                )}

                <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by health">
                  <button type="button" aria-pressed={band === 'all'} onClick={() => { setBand('all'); setPage(0); }} className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${band === 'all' ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                    All · {accounts.length}
                  </button>
                  {BANDS.filter((b) => counts[b] > 0).map((b) => (
                    <button key={b} type="button" aria-pressed={band === b} onClick={() => { setBand(b); setPage(0); }} className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${band === b ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                      {BAND_LABELS[b]} · {counts[b]}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1 sm:max-w-sm">
                    <Input label="Search" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Company, email or account ID" />
                  </div>
                  <div>
                    <label htmlFor="staff-sort" className="mb-1 block text-xs font-medium text-text-secondary">Sort</label>
                    <select id="staff-sort" className={SELECT_CLASS} value={sort} onChange={(e) => { setSort(e.target.value as ExplorerSort); setPage(0); }}>
                      {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                </div>

                <div className={`grid gap-6 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]' : ''}`}>
                  <div className="min-w-0 space-y-3">
                    {rows.length === 0 ? (
                      <EmptyState icon={Search} title="Nothing matches your search" description="Try a different name, email or filter." action={{ label: 'Clear filters', onClick: () => { setSearchInput(''); setSearch(''); setBand('all'); setPage(0); } }} />
                    ) : (
                      <>
                        <ul className="space-y-2">
                          {visible.map((a) => (
                            <li key={a.id}>
                              <button
                                type="button"
                                onClick={() => select(a.id)}
                                aria-current={selectedId === a.id ? 'true' : undefined}
                                className={`focus-ring w-full rounded-2xl border bg-bg-secondary p-4 text-left transition-colors ${selectedId === a.id ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-text-secondary'}`}
                              >
                                <span className="flex items-start justify-between gap-3">
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-semibold text-text-primary">{a.companyName || a.email}</span>
                                    <span className="block truncate text-xs text-text-secondary">{a.email}</span>
                                  </span>
                                  <HealthBadge band={a.health.band} score={a.health.score} />
                                </span>
                                <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
                                  <span className="capitalize">{a.plan}</span>
                                  <span>{a.calls30d} calls / 30d</span>
                                  <span>Last call: {lastCallLabel(a.lastCallAt)}</span>
                                  <span>Joined {new Date(a.createdAt).toLocaleDateString()}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                        <div className="flex items-center justify-between text-xs text-text-secondary">
                          <span>{safePage * PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * PAGE_SIZE)} of {rows.length}</span>
                          <div className="flex gap-1">
                            <button type="button" className="focus-ring rounded-lg p-1.5 hover:bg-bg-tertiary disabled:opacity-30" onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
                            <button type="button" className="focus-ring rounded-lg p-1.5 hover:bg-bg-tertiary disabled:opacity-30" onClick={() => setPage(safePage + 1)} disabled={safePage >= lastPage} aria-label="Next page"><ChevronRight size={16} /></button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {selected && (
                    <div ref={detailRef} className="min-w-0 scroll-mt-24">
                      <AccountDetailPanel key={selected.id} account={selected} onClose={() => setSelectedId(null)} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
