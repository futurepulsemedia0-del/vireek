/**
 * Customer-facing change order — /change-order/:token
 * Public, token-gated (no sign-in). Shows exactly what changes and what it costs, and lets the customer
 * approve (typed-name signature) or decline. Never exposes internal notes, ids or other change orders.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileX2, Loader2, Clock3, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { formatCents } from '@/lib/quotes';
import { fetchPublicChangeOrder, recordPublicView, respondPublic } from '@/lib/changeOrdersApi';
import {
  REASON_LABEL,
  changeOrderError,
  formatDate,
  formatScheduleImpact,
  lineTotalCents,
  type PublicChangeOrder,
} from '@/lib/changeOrders';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; co: PublicChangeOrder };

function Notice({ icon: Icon, title, body, tone }: { icon: typeof CheckCircle2; title: string; body: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }) {
  const color = tone === 'success' ? 'text-success-500' : tone === 'danger' ? 'text-danger-500' : tone === 'warning' ? 'text-warning-500' : 'text-text-secondary';
  return (
    <div role="status" className="rounded-2xl border border-border bg-bg-secondary p-6 text-center">
      <Icon size={32} className={`mx-auto ${color}`} aria-hidden="true" />
      <h2 className="mt-3 text-lg font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 text-sm text-text-secondary">{body}</p>
    </div>
  );
}

function ResponseForm({ co, token, onDone }: { co: PublicChangeOrder; token: string; onDone: () => void }) {
  const [mode, setMode] = useState<'approve' | 'decline'>('approve');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'approve') {
      if (name.trim().length < 2) { setError('Please type your full name to sign.'); return; }
      if (!agree) { setError('Please confirm that you agree to this change.'); return; }
    }
    setError('');
    setBusy(true);
    try {
      await respondPublic(token, mode === 'approve' ? 'approved' : 'declined', name.trim(), note.trim());
      onDone();
    } catch (err) {
      setError(changeOrderError(err, 'We couldn’t record your response. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Your response">
      <div role="group" aria-label="Your decision" className="grid grid-cols-2 gap-2">
        {(['approve', 'decline'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setError(''); }}
            className={`focus-ring min-h-[44px] rounded-xl px-4 text-sm font-semibold transition-colors ${mode === m ? (m === 'approve' ? 'bg-accent text-white' : 'bg-danger-500 text-white') : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
            {m === 'approve' ? 'Approve' : 'Decline'}
          </button>
        ))}
      </div>

      {mode === 'approve' ? (
        <>
          <Input label="Type your full name to sign" required autoComplete="name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          <label className="flex items-start gap-3 text-sm text-text-primary">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border" />
            <span>I approve this change order for <strong className="tabular-nums">{formatCents(co.totalCents)}</strong>{co.scheduleImpactDays ? ` and the schedule change (${formatScheduleImpact(co.scheduleImpactDays)})` : ''}.</span>
          </label>
          <Textarea label="Note (optional)" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </>
      ) : (
        <>
          <Input label="Your name (optional)" autoComplete="name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          <Textarea label="Reason (optional)" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </>
      )}

      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        {mode === 'approve' ? 'Approve and sign' : 'Decline change order'}
      </Button>
      <p className="text-center text-xs text-text-secondary">Your name, the time and this exact content are recorded as your signature.</p>
    </form>
  );
}

export function PublicChangeOrderPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    const co = await fetchPublicChangeOrder(token);
    setState(co ? { kind: 'ready', co } : { kind: 'missing' });
    return co;
  }, [token]);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    fetchPublicChangeOrder(token).then((co) => {
      if (!live) return;
      setState(co ? { kind: 'ready', co } : { kind: 'missing' });
      if (co?.status === 'sent') void recordPublicView(token);
    });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl space-y-5">
        {state.kind === 'loading' && <div className="h-72 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" aria-label="Loading your change order" />}

        {state.kind === 'missing' && <Notice icon={FileX2} tone="neutral" title="We couldn’t find this change order" body="The link may be incorrect, or the change order was withdrawn. Please contact the business that sent it to you." />}

        {state.kind === 'ready' && (() => {
          const co = state.co;
          return (
            <>
              <header>
                <p className="text-sm font-medium text-text-secondary">{co.businessName ?? 'Change order'}{co.number ? ` · ${co.number}` : ''}</p>
                <h1 className="mt-1 break-words text-2xl font-bold text-text-primary">{co.title}</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  For {co.customerName}{co.reference ? ` · ${co.reference}` : ''}{co.siteAddress ? ` · ${co.siteAddress}` : ''}
                </p>
              </header>

              {co.status === 'approved' && <Notice icon={CheckCircle2} tone="success" title="Approved — thank you" body={`${co.approverName ? `${co.approverName} approved this` : 'This was approved'}${co.respondedAt ? ` on ${formatDate(co.respondedAt)}` : ''}. ${co.businessName ?? 'The business'} will proceed with the work.`} />}
              {co.status === 'declined' && <Notice icon={XCircle} tone="danger" title="You declined this change" body="No changes will be made to your original agreement." />}
              {co.status === 'cancelled' && <Notice icon={FileX2} tone="neutral" title="This change order was withdrawn" body="No action is needed. Contact the business if you have questions." />}
              {co.status === 'expired' && <Notice icon={Clock3} tone="warning" title="This approval link has expired" body="Please contact the business and ask them to send it again." />}

              <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="What is changing">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{REASON_LABEL[co.reason]}</p>
                {co.description && <p className="mt-2 whitespace-pre-wrap text-sm text-text-primary">{co.description}</p>}

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[20rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                        <th className="py-2 pr-3 font-medium">Item</th><th className="px-3 py-2 text-right font-medium">Qty</th><th className="py-2 pl-3 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {co.lineItems.map((l, i) => (
                        <tr key={i} className="border-b border-border/60 last:border-0">
                          <td className="py-2.5 pr-3 text-text-primary">{l.description}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{l.quantity}</td>
                          <td className="py-2.5 pl-3 text-right tabular-nums text-text-primary">{formatCents(lineTotalCents(l))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <dl className="ml-auto mt-4 w-full space-y-1.5 text-sm sm:w-64">
                  <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd className="tabular-nums">{formatCents(co.subtotalCents)}</dd></div>
                  {co.taxCents !== 0 && <div className="flex justify-between"><dt className="text-text-secondary">Tax ({co.taxPercent}%)</dt><dd className="tabular-nums">{formatCents(co.taxCents)}</dd></div>}
                  <div className="flex justify-between border-t border-border pt-1.5 text-base font-bold"><dt>{co.totalCents < 0 ? 'Credit to you' : 'Total'}</dt><dd className="tabular-nums" data-testid="public-total">{formatCents(co.totalCents)}</dd></div>
                </dl>
                <p className="mt-3 text-sm text-text-secondary">Schedule: {formatScheduleImpact(co.scheduleImpactDays)}</p>
              </section>

              {co.status === 'sent' && (
                <>
                  <ResponseForm co={co} token={token} onDone={() => void load()} />
                  {co.expiresAt && <p className="text-center text-xs text-text-secondary">This link is valid until {formatDate(co.expiresAt)}.</p>}
                </>
              )}
            </>
          );
        })()}
      </div>
    </main>
  );
}
