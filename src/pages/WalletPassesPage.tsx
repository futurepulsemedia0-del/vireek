/**
 * Wallet Passes — /dashboard/wallet-passes
 * Issue Apple Wallet / Google Wallet passes (appointments with live ETA, memberships, protection & warranty,
 * gift cards, technician IDs). Passes refresh on the customer's phone automatically when the data changes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Lock, RefreshCw, Search, Smartphone } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { IssuePassPanel } from '@/components/wallet/IssuePassPanel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchWalletPasses, voidWalletPass } from '@/lib/walletPassesApi';
import {
  TONE_CLASS, WALLET_KIND_META, WALLET_KIND_ORDER, countByKind, filterPasses, passStatus, timeAgo,
  type WalletKind, type WalletPassRow,
} from '@/lib/walletPasses';

export function WalletPassesPage() {
  const { toast } = useToast();
  const { isOwner, permissions } = useAuth();
  const canBilling = isOwner || !!permissions.can_view_billing;
  const kinds = useMemo(() => WALLET_KIND_ORDER.filter((k) => !WALLET_KIND_META[k].needsBilling || canBilling), [canBilling]);

  const [rows, setRows] = useState<WalletPassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [kind, setKind] = useState<WalletKind>('appointment');
  const [query, setQuery] = useState('');
  const [voiding, setVoiding] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setLoading(true);
    try {
      setRows(await fetchWalletPasses());
      setFailed(false);
    } catch {
      if (background) toast('Could not refresh passes.', 'error'); else setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => countByKind(rows), [rows]);
  const visible = useMemo(() => filterPasses(rows, kind, query), [rows, kind, query]);
  const devices = useMemo(() => rows.filter((r) => r.status === 'active').reduce((n, r) => n + r.apple_devices, 0), [rows]);

  const doVoid = async (row: WalletPassRow) => {
    if (!window.confirm(`Void "${row.label}"? It will show as voided on the customer's phone.`)) return;
    setVoiding(row.id);
    try {
      await voidWalletPass(row.id);
      toast('Pass voided.', 'success');
      await load(true);
    } catch {
      toast('Could not void the pass.', 'error');
    } finally {
      setVoiding(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Wallet Passes">
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Wallet passes</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">Put appointments, memberships, warranties, gift cards and technician IDs on customers&apos; phones. Passes update themselves when the ETA, technician, balance or coverage changes.</p>
          </div>
          {!loading && !failed && (
            <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh passes">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          )}
        </header>

        {loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading passes"><SkeletonCardList count={3} rows={2} /></div>
        ) : failed ? (
          <EmptyStateError title="Could not load wallet passes" onRetry={() => void load()} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4"><p className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">Active passes</p><p className="mt-1 text-xl font-semibold text-text-primary">{Object.values(counts).reduce((a, b) => a + b, 0)}</p></div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4"><p className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">iPhones with a pass</p><p className="mt-1 text-xl font-semibold text-text-primary">{devices}</p></div>
              <div className="col-span-2 rounded-2xl border border-border bg-bg-secondary p-4 sm:col-span-1"><p className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">Updating now</p><p className="mt-1 text-xl font-semibold text-text-primary">{rows.filter((r) => r.pending_push).length}</p></div>
            </div>

            <div role="tablist" aria-label="Pass types" className="flex flex-wrap gap-2">
              {kinds.map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                  className={`focus-ring rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${kind === k ? 'border-accent bg-accent text-white' : 'border-border text-text-secondary hover:bg-bg-tertiary'}`}>
                  {WALLET_KIND_META[k].label} <span className="opacity-70">{counts[k]}</span>
                </button>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
              <IssuePassPanel kind={kind} onIssued={() => void load(true)} />

              <section aria-label={`${WALLET_KIND_META[kind].label} issued`} className="space-y-3">
                <label className="relative block">
                  <span className="sr-only">Search issued passes</span>
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-secondary" aria-hidden />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search issued passes"
                    className="focus-ring h-9 w-full rounded-lg border border-border bg-bg-secondary pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary" />
                </label>

                {visible.length === 0 ? (
                  <EmptyState icon={kind === 'gift_card' && !canBilling ? Lock : Smartphone} title="No passes issued yet" description="Pick a record on the left and create a link, or text it straight to the customer." />
                ) : (
                  <ul className="space-y-2">
                    {visible.map((r) => {
                      const s = passStatus(r);
                      return (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-3.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text-primary">{r.label}</p>
                            <p className="mt-0.5 text-xs text-text-secondary">
                              {r.apple_devices > 0 ? `${r.apple_devices} iPhone${r.apple_devices > 1 ? 's' : ''}` : 'No iPhone yet'}{r.google_synced ? ' · Google Wallet' : ''} · changed {timeAgo(r.last_changed_at)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[s.tone]}`}>{s.label}</span>
                            {r.status === 'active' && (
                              <Button variant="ghost" size="sm" onClick={() => void doVoid(r)} disabled={voiding === r.id} aria-label={`Void ${r.label}`}><Ban className="h-4 w-4" /></Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

export default WalletPassesPage;
