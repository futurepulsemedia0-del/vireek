// /tech/pay — a technician's own earned-wage access and instant payouts.
// Every number comes from the server (pay-transfer-request "quote"); the fee is shown in dollars
// before confirming. Nothing is sent until the technician confirms; a failed or ambiguous request
// never double-sends (idempotency key is reused on retry).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { DisclosureGate, Pill, SandboxBanner, UnavailableNotice } from '@/components/pay/PayShared';
import {
  PayError, ensureSandboxAccount, listTransfers, quoteEwa, quoteInstant, requestTransfer,
} from '@/lib/payApi';
import {
  feeSentence, formatCents, newIdempotencyKey, parseMoneyToCents, transferKindLabel, transferStatusInfo,
  type EwaQuote, type InstantQuote, type TransferRow,
} from '@/lib/pay';

type Loaded<T> = { quote: T } | { unavailable: string } | { error: string };

async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try { return { quote: await fn() }; }
  catch (e) {
    if (e instanceof PayError && e.code === 'unavailable') return { unavailable: String(e.extra?.reason ?? '') };
    if (e instanceof PayError && (e.code === 'no_pay_profile' || e.code === 'not_a_technician')) return { error: e.message };
    return { error: e instanceof Error ? e.message : 'Could not load.' };
  }
}

export function TechnicianPayPage() {
  const navigate = useNavigate();
  const [ewa, setEwa] = useState<Loaded<EwaQuote> | null>(null);
  const [instant, setInstant] = useState<Loaded<InstantQuote> | null>(null);
  const [history, setHistory] = useState<TransferRow[]>([]);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const keyRef = useRef<string>(newIdempotencyKey());

  const reload = useCallback(async () => {
    const [e, i, h] = await Promise.all([load(quoteEwa), load(quoteInstant), listTransfers(30).catch(() => [] as TransferRow[])]);
    setEwa(e); setInstant(i); setHistory(h);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const sandbox = useMemo(() => [ewa, instant].some((s) => s && 'quote' in s && s.quote.sandbox) || history.some((t) => t.sandbox), [ewa, instant, history]);

  async function send(input: Parameters<typeof requestTransfer>[0]) {
    setBusy(true); setMessage(null);
    try {
      const res = await requestTransfer(input);
      keyRef.current = newIdempotencyKey();            // success: next request gets a fresh key
      const t = res.transfer;
      setMessage({ tone: 'ok', text: t.status === 'paid' ? `Sent: ${formatCents(t.receive_cents)}.` : `On its way: ${formatCents(t.receive_cents)}. We will update the status.` });
      setAmount('');
      await reload();
    } catch (e) {
      // Keep the SAME key on a retry so a duplicate click can never send twice.
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Something went wrong. Nothing was sent.' });
      if (e instanceof PayError && e.code && e.code !== 'network') keyRef.current = newIdempotencyKey();
      await reload();
    } finally { setBusy(false); }
  }

  async function linkSandbox(kind: 'earned_wage_advance' | 'instant_payout') {
    setBusy(true);
    try { await ensureSandboxAccount(kind); await reload(); }
    catch (e) { setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Could not link the account.' }); }
    finally { setBusy(false); }
  }

  const cents = parseMoneyToCents(amount);
  const ewaQ = ewa && 'quote' in ewa ? ewa.quote : null;
  const fee = ewaQ && cents ? Math.min(Math.max(Math.round((cents * ewaQ.fee_schedule.fee_bps) / 10000), ewaQ.fee_schedule.min_fee_cents), Math.max(ewaQ.fee_schedule.min_fee_cents, ewaQ.fee_schedule.max_fee_cents)) : 0;

  const bothDown = ewa && instant && !('quote' in ewa) && !('quote' in instant);

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <button onClick={() => navigate('/tech/today')} aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>
        <h1 className="text-lg font-semibold text-text-primary">Vireek Pay</h1>
      </header>
      <main className="mx-auto max-w-lg space-y-4 px-4 py-4">
        <SandboxBanner show={sandbox} />
        {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-xl p-3 text-sm ${message.tone === 'error' ? 'bg-danger/10 text-danger' : 'bg-success-500/10 text-success-500'}`}>{message.text}</p>}
        {(!ewa || !instant) && <SkeletonCardList count={2} rows={3} />}

        {bothDown && (
          <>
            {'unavailable' in ewa && <UnavailableNotice reason={ewa.unavailable} />}
            {'error' in ewa && <EmptyState icon={Wallet} title="Pay features unavailable" description={ewa.error} />}
          </>
        )}

        {ewaQ && (
          <section className="rounded-xl border border-border bg-bg-secondary p-4">
            <h2 className="text-sm font-semibold text-text-primary">Earned wage access</h2>
            <p className="mt-1 text-xs text-text-secondary">Take part of the pay you have already earned. Repaid from your next paycheck.</p>
            <p className="mt-3 text-3xl font-bold text-text-primary">{formatCents(ewaQ.availableCents)}</p>
            <p className="text-xs text-text-secondary">available now · estimated earned take-home {formatCents(ewaQ.accruedNetEstimateCents)}{ewaQ.outstandingAdvanceCents > 0 ? ` · ${formatCents(ewaQ.outstandingAdvanceCents)} already advanced` : ''}</p>
            {ewaQ.availableCents === 0 && <p className="mt-2 text-xs text-text-secondary">Nothing available yet. Approved hours and commission appear here.</p>}

            {!ewaQ.disclosure.accepted ? (
              <div className="mt-3"><DisclosureGate disclosureKey={ewaQ.disclosure.key} onAccepted={reload} /></div>
            ) : !ewaQ.payout_account ? (
              <div className="mt-3 text-sm text-text-secondary">
                No payout account linked.
                {ewaQ.sandbox ? <Button size="sm" variant="secondary" className="mt-2 w-full" disabled={busy} onClick={() => linkSandbox('earned_wage_advance')}>Link sandbox test card</Button>
                  : <span> Your payout partner will let you link one here once it is connected.</span>}
              </div>
            ) : ewaQ.availableCents > 0 && (
              <div className="mt-3 space-y-2">
                <Input label="Amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} helperText={`To ${ewaQ.payout_account.account_type === 'debit_card' ? 'debit card' : 'account'} ending ${ewaQ.payout_account.last4 ?? '••••'}`} />
                {cents !== null && cents > 0 && (
                  <p className="text-sm text-text-primary" aria-live="polite">
                    {cents > ewaQ.availableCents ? 'That is more than is available.' : <>{feeSentence(cents, fee, formatCents)} <span className="text-text-secondary">{formatCents(cents)} will be deducted from your next paycheck.</span></>}
                  </p>
                )}
                <Button className="w-full" disabled={busy || !cents || cents > ewaQ.availableCents} onClick={() => send({ kind: 'earned_wage_advance', idempotencyKey: keyRef.current, amountCents: cents ?? 0 })}>
                  {busy ? 'Sending…' : 'Confirm and send'}
                </Button>
              </div>
            )}
          </section>
        )}
        {ewa && 'unavailable' in ewa && !bothDown && <UnavailableNotice reason={ewa.unavailable} />}

        {instant && 'quote' in instant && instant.quote.items.length > 0 && (
          <section className="rounded-xl border border-border bg-bg-secondary p-4">
            <h2 className="text-sm font-semibold text-text-primary">Instant payout</h2>
            <p className="mt-1 text-xs text-text-secondary">Get an approved paycheck now instead of on payday. It is your own pay — nothing to repay.</p>
            {!instant.quote.disclosure.accepted ? (
              <div className="mt-3"><DisclosureGate disclosureKey={instant.quote.disclosure.key} onAccepted={reload} /></div>
            ) : !instant.quote.payout_account ? (
              <div className="mt-3 text-sm text-text-secondary">
                No payout account linked.
                {instant.quote.sandbox && <Button size="sm" variant="secondary" className="mt-2 w-full" disabled={busy} onClick={() => linkSandbox('instant_payout')}>Link sandbox test card</Button>}
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {instant.quote.items.map((i) => (
                  <li key={i.item_id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium text-text-primary">Paycheck {formatCents(i.net_pay_cents)}</p>
                      <p className="text-xs text-text-secondary">Payday {i.pay_date}{i.quote.ok ? ` · ${feeSentence(i.quote.amountCents, i.quote.feeCents, formatCents)}` : ''}</p>
                    </div>
                    <Button size="sm" disabled={busy || !i.quote.ok} onClick={() => send({ kind: 'instant_payout', idempotencyKey: keyRef.current, payRunItemId: i.item_id })}>Get now</Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {history.length > 0 && (
          <section className="rounded-xl border border-border bg-bg-secondary p-4">
            <h2 className="text-sm font-semibold text-text-primary">Recent</h2>
            <ul className="mt-2 divide-y divide-border">
              {history.map((t) => {
                const s = transferStatusInfo(t.status);
                return (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <p className="text-text-primary">{transferKindLabel(t.kind)}{t.sandbox ? ' (sandbox)' : ''}</p>
                      <p className="text-xs text-text-secondary">{new Date(t.created_at).toLocaleDateString()} · received {formatCents(t.receive_cents)}</p>
                    </div>
                    <Pill tone={s.tone}>{s.label}</Pill>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {history.some((t) => t.status === 'needs_review') && (
          <p className="flex items-start gap-2 text-xs text-warning-500"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> A transfer is under review. Do not request it again — your employer has been flagged to confirm it.</p>
        )}
      </main>
    </div>
  );
}
