import { useCallback, useEffect, useState } from 'react';
import { Zap, Loader as Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { startStripeConnectOnboarding } from '@/lib/payments';
import { InstantPayoutDialog } from '@/components/payments/InstantPayoutDialog';
import {
  INSTANT_PAYOUT_STATUS_META,
  describeFeeSchedule,
  fetchInstantPayoutEligibility,
  fetchPayoutMethodsLink,
  formatMoney,
  resumeInstantPayout,
  type InstantPayout,
  type InstantPayoutEligibility,
} from '@/lib/instantPayouts';

function StatusBadge({ status }: { status: InstantPayout['status'] }) {
  const meta = INSTANT_PAYOUT_STATUS_META[status];
  const toneClass = {
    neutral: 'bg-bg-tertiary text-text-secondary border-border',
    accent: 'bg-accent/10 text-accent border-accent/25',
    success: 'bg-success/10 text-success border-success/25',
    danger: 'bg-danger/10 text-danger border-danger/25',
  }[meta.tone];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClass}`}>{meta.label}</span>;
}

/**
 * Instant payouts for the connected Stripe account: eligibility, live fee, confirm step, payout history.
 * Render it only when the Stripe account is connected. It loads and refreshes itself.
 */
export function InstantPayoutCard() {
  const { toast } = useToast();
  const [data, setData] = useState<InstantPayoutEligibility | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchInstantPayoutEligibility());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not check instant payouts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openLink(kind: 'onboarding' | 'methods') {
    setBusy(kind);
    try {
      const url = kind === 'onboarding' ? await startStripeConnectOnboarding() : await fetchPayoutMethodsLink();
      if (kind === 'onboarding') window.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open Stripe', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function checkStatus(id: string) {
    setBusy(id);
    try {
      const out = await resumeInstantPayout(id);
      toast(out.warning ? out.message ?? 'Stripe has not confirmed this yet — try again shortly.' : 'Payout confirmed', out.warning ? 'error' : 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not check this payout', 'error');
    } finally {
      setBusy(null);
      void load();
    }
  }

  const recent = data?.recent ?? [];
  const reason = data?.reason ?? null;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${data?.eligible ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary'}`}>
              <Zap className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-text-primary">Instant payout</p>
              {loading && !data ? (
                <p className="mt-1 flex items-center gap-2 text-sm text-text-secondary"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking your balance…</p>
              ) : loadError && !data ? (
                <p role="alert" className="mt-1 text-sm text-danger">{loadError}</p>
              ) : data?.eligible ? (
                <>
                  <p className="mt-0.5 text-2xl font-bold text-text-primary">{formatMoney(data.maxPayoutCents)}</p>
                  <p className="text-sm text-text-secondary">
                    available now → {data.destination?.label} · fee {describeFeeSchedule(data.pricing)} · arrives in about 30 minutes
                  </p>
                </>
              ) : (
                <p className="mt-1 max-w-xl text-sm text-text-secondary">{data?.message ?? 'Instant payouts are not available right now.'}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh instant payout balance"
              className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {data?.eligible && (
              <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)}>
                <Zap className="h-3.5 w-3.5" /> Cash out now
              </Button>
            )}
            {(reason === 'not_connected' || reason === 'onboarding_incomplete' || reason === 'payouts_disabled') && (
              <Button variant="primary" size="sm" onClick={() => openLink('onboarding')} disabled={busy === 'onboarding'}>
                {busy === 'onboarding' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Finish verification
              </Button>
            )}
            {reason === 'no_instant_destination' && (
              <Button variant="primary" size="sm" onClick={() => openLink('methods')} disabled={busy === 'methods'}>
                {busy === 'methods' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                Add a debit card
              </Button>
            )}
            {loadError && data && (
              <Button variant="secondary" size="sm" onClick={() => void load()}>Retry</Button>
            )}
          </div>
        </div>

        {recent.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">Recent instant payouts</p>
            <ul className="divide-y divide-border">
              {recent.slice(0, 5).map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {formatMoney(p.amount_cents, p.currency)}
                      {p.fee_cents > 0 && <span className="ml-2 text-xs font-normal text-text-secondary">fee {formatMoney(p.fee_cents, p.currency)}</span>}
                    </p>
                    <p className="truncate text-xs text-text-secondary">
                      {new Date(p.created_at).toLocaleString()} · {p.destination_label ?? 'Debit card'}
                    </p>
                    {(p.status === 'failed' || p.status === 'canceled') && p.failure_message && (
                      <p className="mt-0.5 text-xs text-danger">{p.failure_message}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={p.status} />
                    {p.status === 'pending' && !p.stripe_payout_id && (
                      <button
                        type="button"
                        onClick={() => void checkStatus(p.id)}
                        disabled={busy === p.id}
                        className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                      >
                        {busy === p.id ? 'Checking…' : 'Check status'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {dialogOpen && data?.eligible && (
        <InstantPayoutDialog
          eligibility={data}
          onClose={() => setDialogOpen(false)}
          onDone={(refresh) => {
            setDialogOpen(false);
            if (refresh) void load();
          }}
        />
      )}
    </>
  );
}
