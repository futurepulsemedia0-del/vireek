import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, CreditCard, Loader2, X } from 'lucide-react';
import { fetchPublicRenewal, formatUsd, respondToRenewal, type PublicRenewal } from '@/lib/membershipRenewal';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Public, token-gated renewal quote: /renew/:token. No login; the unguessable token is the credential. */
export function RenewMembershipPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [renewal, setRenewal] = useState<PublicRenewal | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);

  useEffect(() => {
    document.title = 'Your membership renewal';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let alive = true;
    fetchPublicRenewal(token)
      .then((r) => {
        if (!alive) return;
        setRenewal(r);
        setState(r ? 'ready' : 'missing');
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
    };
  }, [token]);

  const respond = async (action: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(action);
    setMessage(null);
    try {
      const result = await respondToRenewal(token, action);
      if (result === 'accepted' || result === 'declined') {
        setRenewal((r) => (r ? { ...r, quote_status: result, auto_renew: result === 'accepted' } : r));
        setConfirmDecline(false);
      } else {
        setMessage('This renewal can no longer be changed online. Please contact the business.');
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const shell = (children: React.ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-6 shadow-sm">{children}</div>
    </main>
  );

  if (state === 'loading') return shell(<Loader2 className="mx-auto h-6 w-6 animate-spin text-text-secondary" aria-label="Loading" />);
  if (state === 'error') return shell(<p role="alert" className="text-center text-sm text-danger">We couldn’t load this renewal. Please try again in a moment.</p>);
  if (state === 'missing' || !renewal) {
    return shell(
      <div className="text-center">
        <X className="mx-auto mb-3 h-10 w-10 text-text-secondary" />
        <h1 className="text-lg font-bold text-text-primary">This renewal link isn’t available</h1>
        <p className="mt-1 text-sm text-text-secondary">It may have expired. Please contact the business.</p>
      </div>,
    );
  }

  const business = renewal.business_name ?? 'Your service provider';
  const interval = renewal.billing_interval === 'monthly' ? 'month' : 'year';
  const priceUp = renewal.amount_cents > renewal.previous_amount_cents;

  if (renewal.outcome === 'renewed') {
    return shell(
      <div className="text-center">
        <CircleCheck className="mx-auto mb-3 h-10 w-10 text-success" />
        <h1 className="text-lg font-bold text-text-primary">You’re renewed</h1>
        <p className="mt-1 text-sm text-text-secondary">Thank you — your {renewal.plan_name ?? 'membership'} is active. Nothing more to do.</p>
      </div>,
    );
  }
  if (renewal.outcome) {
    return shell(
      <div className="text-center">
        <X className="mx-auto mb-3 h-10 w-10 text-text-secondary" />
        <h1 className="text-lg font-bold text-text-primary">This membership has ended</h1>
        <p className="mt-1 text-sm text-text-secondary">Contact {business} if you’d like to rejoin.</p>
      </div>,
    );
  }

  const declined = renewal.quote_status === 'declined' || !renewal.auto_renew;

  return shell(
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wider text-text-secondary">{business}</p>
        <h1 className="mt-1 text-xl font-bold text-text-primary">
          {renewal.customer_first_name ? `Hi ${renewal.customer_first_name}, ` : ''}your {renewal.plan_name ?? 'membership'} renews {formatDate(renewal.period_end)}
        </h1>
      </div>

      <div className="rounded-xl border border-border-primary p-4">
        <p className="text-3xl font-bold text-text-primary">
          {formatUsd(renewal.amount_cents)}
          <span className="ml-1 text-sm font-normal text-text-secondary">/ {interval}</span>
        </p>
        {priceUp && <p className="mt-1 text-xs text-warning-500">Up from {formatUsd(renewal.previous_amount_cents)}</p>}
        {renewal.benefits.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-text-secondary">
            {renewal.benefits.map((b) => (
              <li key={b} className="flex gap-2"><CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />{b}</li>
            ))}
          </ul>
        )}
      </div>

      {renewal.card_last4 ? (
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <CreditCard className="h-4 w-4" /> We’ll charge your {renewal.card_brand ?? 'card'} ending {renewal.card_last4} on the renewal date.
        </p>
      ) : renewal.pay_token ? (
        <Link to={`/pay/${renewal.pay_token}`} className="focus-ring flex w-full items-center justify-center rounded-xl bg-accent py-3 text-base font-semibold text-white">
          Pay {formatUsd(renewal.amount_cents)} to renew
        </Link>
      ) : (
        <p className="text-sm text-text-secondary">We’ll send you a secure payment link before your renewal date.</p>
      )}

      {declined ? (
        <div className="space-y-3">
          <p className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">
            You’ve chosen not to renew. Your benefits continue through {formatDate(renewal.period_end)}.
          </p>
          <button type="button" disabled={!!busy} onClick={() => respond('accept')} className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-base font-semibold text-white disabled:opacity-50">
            {busy === 'accept' && <Loader2 className="h-4 w-4 animate-spin" />} Changed my mind — keep my membership
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button type="button" disabled={!!busy} onClick={() => respond('accept')} className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-base font-semibold text-white disabled:opacity-50">
            {busy === 'accept' && <Loader2 className="h-4 w-4 animate-spin" />}
            {renewal.quote_status === 'accepted' ? 'Renewal confirmed ✓' : 'Confirm renewal'}
          </button>
          {!confirmDecline ? (
            <button type="button" onClick={() => setConfirmDecline(true)} className="focus-ring w-full rounded-xl py-2 text-sm text-text-secondary hover:text-text-primary">
              I don’t want to renew
            </button>
          ) : (
            <div className="rounded-xl border border-border-primary p-3 text-sm">
              <p className="text-text-secondary">Your benefits continue through {formatDate(renewal.period_end)}, then the membership ends. You won’t be charged.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={!!busy} onClick={() => respond('decline')} className="focus-ring flex-1 rounded-lg bg-danger py-2 font-medium text-white disabled:opacity-50">
                  {busy === 'decline' ? 'Saving…' : 'Don’t renew'}
                </button>
                <button type="button" onClick={() => setConfirmDecline(false)} className="focus-ring flex-1 rounded-lg border border-border-primary py-2 text-text-secondary">Keep it</button>
              </div>
            </div>
          )}
        </div>
      )}

      {message && <p role="alert" className="text-sm text-danger">{message}</p>}
    </div>,
  );
}
