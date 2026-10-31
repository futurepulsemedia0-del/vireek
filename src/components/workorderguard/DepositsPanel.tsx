import { useCallback, useEffect, useMemo, useState } from 'react';
import { Landmark } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { formatUsd, type WorkOrder } from '@/lib/workOrderGuard';
import { applyDepositMatch, listCandidateDeposits, listMatches, removeDepositMatch, type DepositMatch, type PortalProfile } from '@/lib/workOrderGuardApi';
import { suggestDeposits, isMatchable, type DepositTxn } from '@/lib/workOrderGuardMatching';

interface Props { ownerId: string; profile: PortalProfile; orders: WorkOrder[] }

export function DepositsPanel({ ownerId, profile, orders }: Props) {
  const { toast } = useToast();
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [txns, setTxns] = useState<DepositTxn[]>([]);
  const [matches, setMatches] = useState<DepositMatch[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [t, m] = await Promise.all([listCandidateDeposits(ownerId, 120), listMatches(ownerId)]);
      setTxns(t); setMatches(m); setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load deposits.'); setState('error');
    }
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);

  const matchedIds = useMemo(() => new Set(matches.map((m) => m.workOrderId)), [matches]);
  const open = useMemo(() => orders.filter((o) => isMatchable(o) && !matchedIds.has(o.id as string)), [orders, matchedIds]);
  const suggestions = useMemo(() => suggestDeposits(open, txns, { payerName: profile.payerName, timezone: profile.timezone, paymentTermsDays: profile.rules.paymentTermsDays }), [open, txns, profile]);
  const byId = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);

  const apply = async (key: string, ids: string[], txnId: string, method: string, conf: number, why: string) => {
    setBusy(key);
    try { await applyDepositMatch(ids, txnId, method, conf, why); toast('Deposit matched.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not apply the match.', 'error'); }
    finally { setBusy(null); }
  };
  const remove = async (id: string) => {
    setBusy(id);
    try { await removeDepositMatch(id); toast('Match removed.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove the match.', 'error'); }
    finally { setBusy(null); }
  };

  if (state === 'loading') return <SkeletonCardList count={3} rows={2} />;
  if (state === 'error') return <EmptyStateError icon={Landmark} title="Could not load deposits" description={error} onRetry={() => void load()} />;
  return (
    <div className="space-y-5">
      <p className="text-sm text-text-secondary">Approved invoices ({open.length} unmatched) are compared with deposits from your connected bank (last 120 days) using the same matching engine as Bank Intelligence. Nothing is applied until you confirm.</p>
      {open.length === 0 && matches.length === 0 ? (
        <EmptyState icon={Landmark} title="No approved invoices" description={'Import work orders whose final status is "approved" to match them to deposits.'} />
      ) : suggestions.length === 0 && open.length > 0 ? (
        <EmptyState icon={Landmark} title="No matching deposits yet" description={txns.length === 0 ? 'No unreconciled deposits found. Connect a bank in Bank Intelligence, then refresh.' : 'None of the recent deposits line up with an approved invoice.'} action={{ label: 'Refresh', onClick: () => void load() }} />
      ) : (
        <ul className="space-y-3">
          {suggestions.map((s) => {
            const key = s.txn.id;
            return (
              <li key={key} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="font-semibold text-text-primary">{formatUsd(s.txn.amountCents)} · {s.txn.postedDate}</p>
                <p className="text-xs text-text-secondary">{s.txn.name} — {s.orders.map((o) => `WO ${o.woNumber} (${o.invoiceNumber ?? 'invoice'})`).join(', ')}</p>
                <p className="mt-2 text-sm text-text-secondary">{s.suggestion.explanation}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-border px-3 py-1 text-xs">{Math.round(s.suggestion.confidence * 100)}% confidence</span>
                  <Button size="sm" disabled={busy === key} onClick={() => void apply(key, s.orders.map((o) => o.id as string), s.txn.id, s.suggestion.method, s.suggestion.confidence, s.suggestion.explanation)}>{busy === key ? 'Applying…' : 'Confirm match'}</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {matches.length > 0 && (
        <section aria-label="Matched invoices" className="rounded-2xl border border-border bg-bg-secondary p-4">
          <h3 className="text-sm font-semibold text-text-primary">Matched ({matches.length})</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {matches.map((m) => {
              const o = byId.get(m.workOrderId);
              return (
                <li key={m.workOrderId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{o ? `WO ${o.woNumber}` : 'Work order'} · {formatUsd(m.matchedCents)}</span>
                  <Button variant="ghost" size="sm" disabled={busy === m.workOrderId} onClick={() => void remove(m.workOrderId)}>Unmatch</Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
