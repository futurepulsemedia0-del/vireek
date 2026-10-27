/**
 * Customer portal — loyalty card. Shows the customer's balance, tier progress, rewards they can redeem,
 * recent activity and their redemption codes. Renders nothing when the business has no active program.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Crown, Gift, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { Pill, ProgressBar } from '@/components/loyalty/loyaltyUi';
import { fetchPortalLoyalty, redeemPortalReward } from '@/lib/loyaltyApi';
import {
  canAfford,
  formatMultiplier,
  formatPoints,
  formatRewardValue,
  formatSigned,
  pointsShort,
  redemptionTone,
  tierProgress,
  timeAgo,
  type PortalLoyalty,
} from '@/lib/loyalty';

const MAX_PENDING = 3;

export function PortalLoyaltyCard({ portalToken }: { portalToken: string }) {
  const [data, setData] = useState<PortalLoyalty | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchPortalLoyalty(portalToken));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [portalToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const progress = useMemo(
    () => (data ? tierProgress(data.tiers.map((t) => ({ ...t, id: t.name })), data.lifetime) : null),
    [data],
  );

  if (state === 'loading') return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (state === 'error') {
    return (
      <section className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4" role="alert">
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <TriangleAlert size={16} aria-hidden /> We couldn&apos;t load your rewards.
        </p>
        <button type="button" onClick={() => { setState('loading'); void load(); }} className="focus-ring min-h-10 rounded-xl border border-border px-4 text-sm font-medium text-text-primary">
          Try again
        </button>
      </section>
    );
  }
  if (!data) return null;

  const label = data.program.points_label;
  const pending = data.redemptions.filter((r) => r.status === 'pending').length;
  const canRedeem = data.program.redemption_enabled && pending < MAX_PENDING;

  const redeem = async (rewardId: string) => {
    setBusy(rewardId);
    setMessage(null);
    try {
      const res = await redeemPortalReward(portalToken, rewardId);
      setMessage({ kind: 'success', text: `Done! Show code ${res.code} to claim "${res.reward_name}". The business will confirm it shortly.` });
      setConfirming(null);
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not redeem this reward.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6" aria-labelledby="portal-loyalty-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Crown className="h-4 w-4 text-accent" aria-hidden />
            <h2 id="portal-loyalty-title" className="truncate text-sm font-semibold text-text-primary">{data.program.name}</h2>
          </div>
          <p className="mt-2 text-3xl font-bold text-text-primary">
            {formatPoints(data.balance)} <span className="text-base font-medium text-text-secondary">{label}</span>
          </p>
        </div>
        {data.tier && <Pill tone="success">{data.tier.name} · {formatMultiplier(data.tier.earn_multiplier)}</Pill>}
      </div>

      {progress && data.tiers.length > 0 && (
        <div className="mt-4">
          <ProgressBar percent={progress.percent} label="Progress to the next tier" />
          <p className="mt-1.5 text-xs text-text-secondary">
            {progress.next
              ? `${formatPoints(progress.pointsToNext)} more lifetime ${label} to reach ${progress.next.name}`
              : 'You have reached the top tier. Thank you!'}
          </p>
          {data.tier?.perks && <p className="mt-1 text-xs text-text-secondary">{data.tier.perks}</p>}
        </div>
      )}

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`mt-4 flex items-start gap-2 rounded-xl p-3 text-sm ${message.kind === 'success' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}
        >
          {message.kind === 'success' && <Check size={16} className="mt-0.5 shrink-0" aria-hidden />} {message.text}
        </p>
      )}

      <h3 className="mt-6 flex items-center gap-2 text-sm font-semibold text-text-primary"><Gift size={16} aria-hidden /> Rewards</h3>
      {data.rewards.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">Rewards will appear here soon. Keep earning {label}!</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {data.rewards.map((r) => {
            const ok = canAfford(data.balance, r.points_cost);
            const isConfirming = confirming === r.id;
            return (
              <li key={r.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{r.name}</p>
                    <p className="text-xs text-text-secondary">
                      {formatRewardValue(r)} · {formatPoints(r.points_cost)} {label}
                      {!ok && ` · ${formatPoints(pointsShort(data.balance, r.points_cost))} to go`}
                    </p>
                    {r.description && <p className="mt-0.5 text-xs text-text-secondary">{r.description}</p>}
                  </div>
                  {!isConfirming && (
                    <button
                      type="button"
                      onClick={() => { setConfirming(r.id); setMessage(null); }}
                      disabled={!ok || !canRedeem || busy !== null}
                      className="focus-ring min-h-10 rounded-xl border border-border px-4 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 disabled:opacity-50"
                    >
                      Redeem
                    </button>
                  )}
                </div>
                {isConfirming && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-tertiary p-3">
                    <p className="text-sm text-text-primary">Spend {formatPoints(r.points_cost)} {label} on this reward?</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setConfirming(null)} disabled={busy !== null} className="focus-ring min-h-10 rounded-xl px-3 text-sm text-text-secondary hover:text-text-primary">
                        Cancel
                      </button>
                      <Button size="sm" onClick={() => void redeem(r.id)} disabled={busy !== null}>
                        {busy === r.id && <Loader2 size={14} className="animate-spin" />} Confirm
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!data.program.redemption_enabled && data.rewards.length > 0 && (
        <p className="mt-2 text-xs text-text-secondary">To redeem a reward, please contact us.</p>
      )}
      {data.program.redemption_enabled && pending >= MAX_PENDING && (
        <p className="mt-2 text-xs text-text-secondary">You have {MAX_PENDING} rewards waiting. You can redeem more once they are completed.</p>
      )}

      {data.redemptions.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold text-text-primary">Your redemptions</h3>
          <ul className="mt-2 space-y-2">
            {data.redemptions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{r.reward_name}</p>
                  <p className="text-xs text-text-secondary">
                    Code <span className="font-mono font-semibold text-text-primary">{r.code}</span> · {timeAgo(r.created_at)}
                  </p>
                </div>
                <Pill tone={redemptionTone(r.status)}>{r.status === 'pending' ? 'Being prepared' : r.status === 'fulfilled' ? 'Completed' : 'Cancelled'}</Pill>
              </li>
            ))}
          </ul>
        </>
      )}

      {data.history.length > 0 && (
        <details className="mt-6">
          <summary className="focus-ring cursor-pointer rounded-lg text-sm font-semibold text-text-primary">Recent activity</summary>
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {data.history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{h.label}</p>
                  <p className="text-xs text-text-secondary">{timeAgo(h.created_at)}</p>
                </div>
                <span className={`text-sm font-semibold ${h.points > 0 ? 'text-success' : 'text-text-primary'}`}>{formatSigned(h.points)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {data.tiers.length > 1 && (
        <details className="mt-4">
          <summary className="focus-ring cursor-pointer rounded-lg text-sm font-semibold text-text-primary">How tiers work</summary>
          <ul className="mt-2 space-y-1.5">
            {data.tiers.map((t) => (
              <li key={t.name} className="text-xs text-text-secondary">
                <span className="font-semibold text-text-primary">{t.name}</span> · from {formatPoints(t.min_lifetime_points)} lifetime {label} · {formatMultiplier(t.earn_multiplier)} {label}
                {t.perks ? ` · ${t.perks}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
