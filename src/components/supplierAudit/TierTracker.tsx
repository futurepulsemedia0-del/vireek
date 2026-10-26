import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import { programSpendSummary, programFreshness } from '@/lib/supplierAudit/engine';
import { daysBetween, formatMoney, todayInZone } from '@/lib/supplierAudit/money';
import type { AuditData } from '@/lib/supplierAudit/api';
import { EmptyState } from '@/components/EmptyState';
import { Card, Pill } from './shared';

export function TierTracker({ data, timeZone }: { data: AuditData; timeZone: string }) {
  const today = todayInZone(new Date(), timeZone);
  const rows = useMemo(() => data.programs.filter((p) => p.status === 'active' && (p.type === 'volume_rebate' || p.type === 'patronage') && p.tiers.length).map((p) => {
    const s = programSpendSummary(p, data.input);
    const next = s.tierIndex + 1 < p.tiers.length ? p.tiers[s.tierIndex + 1] : null;
    return { p, s, next, vendor: data.vendors.find((v) => v.id === p.vendorId)?.name ?? 'Supplier', fresh: programFreshness(p, today) };
  }), [data, today]);
  if (!rows.length) return <EmptyState icon={TrendingUp} title="No tiered programs yet" description="Add an active volume-rebate or patronage program on the Programs tab to track spend against its tiers." />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {rows.map(({ p, s, next, vendor, fresh }) => {
        const top = p.tiers[p.tiers.length - 1].thresholdCents;
        const pct = Math.min(100, Math.round((s.acceptedCents / top) * 100));
        const daysLeft = p.periodEnd ? daysBetween(today, p.periodEnd) : null;
        return (
          <Card key={p.id} title={`${vendor} — ${p.name}`}>
            <div className="mb-2 flex flex-wrap gap-2">
              <Pill cls="bg-accent/10 text-accent">{s.tierIndex >= 0 ? `Tier ${s.tierIndex + 1}: ${p.tiers[s.tierIndex].rateBps / 100}%` : 'Below first tier'}</Pill>
              <Pill cls="bg-bg-tertiary text-text-secondary">{s.source === 'statements' ? 'From statements' : s.source === 'vendor_bills' ? 'From AP bills (rough)' : 'No spend data'}</Pill>
              {fresh.stale && <Pill cls="bg-warning-500/10 text-warning-500">Rules need re-verifying</Pill>}
            </div>
            <p className="text-2xl font-bold text-text-primary">{formatMoney(s.acceptedCents, p.currency)}</p>
            <p className="text-xs text-text-secondary">qualifying spend{p.periodStart ? `, ${p.periodStart} → ${p.periodEnd}` : ''}</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>
            <ul className="mt-3 space-y-1 text-xs text-text-secondary">
              {p.tiers.map((t, i) => <li key={i} className={i === s.tierIndex ? 'font-semibold text-text-primary' : ''}>{formatMoney(t.thresholdCents, p.currency)} → {t.rateBps / 100}%</li>)}
            </ul>
            <p className="mt-3 text-sm text-text-primary">{next ? `${formatMoney(Math.max(0, next.thresholdCents - s.acceptedCents), p.currency)} more to reach ${next.rateBps / 100}%${daysLeft !== null ? (daysLeft >= 0 ? ` (${daysLeft} days left)` : ' — period ended') : ''}` : 'Top tier reached.'}</p>
            <p className="mt-1 text-xs text-text-secondary">Accrued rebate estimate: {formatMoney(s.expectedCents, p.currency)} (estimate — verify with your distributor).{s.pendingLines ? ` ${s.pendingLines} line(s) awaiting review not counted.` : ''}</p>
          </Card>);
      })}
    </div>
  );
}
