/**
 * Loyalty — redemption queue. Pending redemptions already had their points deducted; fulfilling closes them,
 * cancelling returns the points to the customer.
 */

import { useMemo, useState } from 'react';
import { Check, Loader2, PackageCheck, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Pill } from '@/components/loyalty/loyaltyUi';
import { setRedemptionStatus } from '@/lib/loyaltyApi';
import {
  countPending,
  filterRedemptions,
  formatPoints,
  formatRewardValue,
  redemptionTone,
  timeAgo,
  type RedemptionDetail,
  type RedemptionStatus,
} from '@/lib/loyalty';

type Filter = RedemptionStatus | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'To fulfill' },
  { key: 'fulfilled', label: 'Fulfilled' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

interface Props {
  redemptions: RedemptionDetail[];
  pointsLabel: string;
  onChanged: () => void;
}

export function RedemptionsPanel({ redemptions, pointsLabel, onChanged }: Props) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<RedemptionDetail | null>(null);
  const rows = useMemo(() => filterRedemptions(redemptions, filter), [redemptions, filter]);
  const pending = countPending(redemptions);

  const act = async (r: RedemptionDetail, status: 'fulfilled' | 'cancelled') => {
    setBusy(r.id);
    try {
      await setRedemptionStatus(r.id, status);
      toast(status === 'fulfilled' ? 'Marked as fulfilled.' : `Cancelled. ${formatPoints(r.points_cost)} ${pointsLabel} returned.`, 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the redemption.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Redemption status">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`focus-ring min-h-10 rounded-full border px-4 text-sm font-medium transition-colors ${
              filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {f.label}
            {f.key === 'pending' && pending > 0 ? ` (${pending})` : ''}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title={filter === 'pending' ? 'Nothing to fulfill' : 'No redemptions here'}
          description={filter === 'pending' ? 'When a customer redeems a reward, it shows up here for your team to fulfill.' : 'Redemptions with this status will appear here.'}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-text-primary">{r.reward_name}</p>
                    <Pill tone={redemptionTone(r.status)}>{r.status === 'pending' ? 'To fulfill' : r.status === 'fulfilled' ? 'Fulfilled' : 'Cancelled'}</Pill>
                  </div>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {r.customer_name}{r.customer_phone ? ` · ${r.customer_phone}` : ''} · {formatRewardValue(r)} · {formatPoints(r.points_cost)} {pointsLabel}
                  </p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    Code <span className="font-mono font-semibold text-text-primary">{r.code}</span> · {r.requested_via === 'portal' ? 'Requested online' : 'Added by your team'} · {timeAgo(r.created_at)}
                  </p>
                </div>
                {r.status === 'pending' && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void act(r, 'fulfilled')} disabled={busy === r.id}>
                      {busy === r.id ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Fulfill
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setCancelling(r)} disabled={busy === r.id}>
                      <Undo2 size={16} /> Cancel &amp; refund
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title="Cancel and refund points?"
        description={`${cancelling ? formatPoints(cancelling.points_cost) : ''} ${pointsLabel} go back to ${cancelling?.customer_name ?? 'the customer'} and this redemption closes.`}
        confirmLabel="Cancel redemption"
        onConfirm={async () => {
          if (cancelling) await act(cancelling, 'cancelled');
          setCancelling(null);
        }}
        onCancel={() => setCancelling(null)}
      />
    </div>
  );
}
