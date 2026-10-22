import { useState } from 'react';
import { EyeOff, Gift, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { LoadError, StatusPill, useLoader, type Tone } from '@/components/commissions/shared';
import { fetchMySpiffs, leaderboardErrorMessage, setLeaderboardOptOut } from '@/lib/technicianLeaderboardApi';
import {
  PAYOUT_STATUS_LABEL,
  describeRule,
  formatUsd,
  ordinal,
  periodLabel,
  type PayoutStatus,
} from '@/lib/technicianLeaderboard';

const TONE: Record<PayoutStatus, Tone> = { pending: 'warning', approved: 'info', paid: 'success', rejected: 'neutral' };

export function MyBonusesPanel({ onOptOutChanged }: { onOptOutChanged: () => void }) {
  const { toast } = useToast();
  const mine = useLoader(() => fetchMySpiffs(), []);
  const [saving, setSaving] = useState(false);

  if (mine.loading) return <SkeletonCardList count={3} rows={2} />;
  if (mine.error || !mine.data) return <LoadError message={mine.error ?? 'Could not load your bonuses.'} onRetry={mine.reload} />;
  const { opted_out: optedOut, payouts, rules } = mine.data;
  const earned = payouts.filter((p) => p.status !== 'pending').reduce((s, p) => s + p.amount_cents, 0);

  const toggle = async () => {
    setSaving(true);
    try {
      await setLeaderboardOptOut(!optedOut);
      toast(optedOut ? 'You’re back on the leaderboard.' : 'You’re off the leaderboard.', 'success');
      mine.reload();
      onOptOutChanged();
    } catch (e) {
      toast(leaderboardErrorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="flex flex-col gap-3 !p-5 hover:!translate-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary"><EyeOff className="h-4 w-4 text-text-secondary" aria-hidden="true" /> Leaderboard participation</p>
          <p className="mt-1 text-sm text-text-secondary">
            {optedOut
              ? 'You’re opted out: you’re not ranked or shown to colleagues, and you won’t earn new leaderboard bonuses. Bonuses already earned are still paid.'
              : 'You’re on the board. Opt out any time to stop being ranked or shown to colleagues — you also stop earning new leaderboard bonuses.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!optedOut}
          aria-label="Take part in the leaderboard"
          disabled={saving}
          onClick={toggle}
          className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${optedOut ? 'bg-bg-tertiary' : 'bg-accent'}`}
        >
          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${optedOut ? 'left-0.5' : 'left-[1.375rem]'}`} />
        </button>
      </Card>

      <section aria-label="How to earn bonuses" className="space-y-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary"><Gift className="h-4 w-4 text-accent" aria-hidden="true" /> How to earn</h2>
        {rules.length === 0 ? (
          <p className="text-sm text-text-secondary">No bonus rules are active right now.</p>
        ) : (
          <ul className="space-y-2">{rules.map((r) => (
            <li key={r.id}><Card className="!p-4 hover:!translate-y-0"><p className="text-sm font-semibold text-text-primary">{r.name}</p><p className="text-sm text-text-secondary">{describeRule(r)}</p></Card></li>
          ))}</ul>
        )}
      </section>

      <section aria-label="My bonuses" className="space-y-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary"><Wallet className="h-4 w-4 text-accent" aria-hidden="true" /> My bonuses {earned > 0 && <span className="text-sm font-normal text-text-secondary">· {formatUsd(earned)} earned</span>}</h2>
        {payouts.length === 0 ? (
          <EmptyState icon={Gift} title="No bonuses yet" description="Bonuses appear here after a period closes. They’re added to your pay automatically." />
        ) : (
          <ul className="space-y-2">{payouts.map((p) => (
            <li key={p.id}>
              <Card className="flex items-center justify-between gap-3 !p-4 hover:!translate-y-0">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">{p.rule_name}<StatusPill tone={TONE[p.status]}>{PAYOUT_STATUS_LABEL[p.status]}</StatusPill></p>
                  <p className="text-xs text-text-secondary">{periodLabel(p.period, p.period_start, p.period_end)}{p.rank ? ` · ${ordinal(p.rank)} place` : ''}</p>
                </div>
                <span className="text-lg font-bold tabular-nums text-text-primary">{formatUsd(p.amount_cents)}</span>
              </Card>
            </li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
