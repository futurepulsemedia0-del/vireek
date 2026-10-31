import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { FlagBadge } from '@/components/workorderguard/shared';
import { evaluateOrder, formatUsd, stakeCents, type PortalRules, type WorkOrder } from '@/lib/workOrderGuard';

type Filter = 'action' | 'warning' | 'all';

export function OrdersPanel({ orders, rules, timezone }: { orders: WorkOrder[]; rules: PortalRules; timezone: string }) {
  const [filter, setFilter] = useState<Filter>('action');
  const [limit, setLimit] = useState(50);
  const rows = useMemo(() => {
    const now = new Date();
    return orders.map((o) => ({ o, flags: evaluateOrder(o, { rules, timezone, now }) }));
  }, [orders, rules, timezone]);
  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'action' ? r.flags.some((f) => f.level === 'violation') : r.flags.some((f) => f.level === 'warning')));
  const counts = { action: rows.filter((r) => r.flags.some((f) => f.level === 'violation')).length, warning: rows.filter((r) => r.flags.some((f) => f.level === 'warning')).length };

  if (orders.length === 0) {
    return <EmptyState icon={ShieldCheck} title="No work orders yet" description="Import a portal CSV or paste a forwarded work-order email in the Import tab." />;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Order filter">
        {([['action', `Rules broken (${counts.action})`], ['warning', `Deadlines approaching (${counts.warning})`], ['all', `All (${rows.length})`]] as [Filter, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} onClick={() => { setFilter(id); setLimit(50); }}
            className={`focus-ring min-h-[40px] rounded-full border px-4 text-sm font-medium ${filter === id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{label}</button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Nothing to fix here" description="No work orders match this filter against the current rules." />
      ) : (
        <ul className="space-y-3">
          {shown.slice(0, limit).map(({ o, flags }) => (
            <li key={o.id ?? o.woNumber} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold text-text-primary">WO {o.woNumber}{o.location ? ` · ${o.location}` : ''}</p>
                <p className="text-sm text-text-secondary">{o.outcome} · {formatUsd(stakeCents(o))}</p>
              </div>
              <p className="text-xs text-text-secondary">Received {new Date(o.receivedAt).toLocaleString()} · {o.priority}{o.nteCents != null ? ` · NTE ${formatUsd(o.nteCents)}` : ''}</p>
              {flags.length > 0 && <ul className="mt-3 space-y-2">{flags.map((f) => <FlagBadge key={f.code} flag={f} />)}</ul>}
            </li>
          ))}
        </ul>
      )}
      {shown.length > limit && <button className="focus-ring min-h-[40px] rounded-xl border border-border px-4 text-sm" onClick={() => setLimit(limit + 50)}>Show more ({shown.length - limit} left)</button>}
    </div>
  );
}
