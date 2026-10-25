// Owner/admin: Vireek Capital. Pre-screen from real revenue data → choose invoices → apply → partner offers.
// Vireek never shows an approval of its own: only a pre-screen and the PARTNER's offers (full cost shown).
import { useCallback, useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { DisclosureGate, Pill } from '@/components/pay/PayShared';
import { PayError, acceptCapitalOffer, listCapital, prescreenCapital, submitCapital, withdrawCapital } from '@/lib/payApi';
import { formatCents, offerCostRows, offerIsExpired, parseMoneyToCents, type CapitalApplication, type CapitalOffer, type PrescreenResponse } from '@/lib/pay';

export function PayCapitalPanel() {
  const [apps, setApps] = useState<CapitalApplication[]>([]);
  const [offers, setOffers] = useState<CapitalOffer[]>([]);
  const [pre, setPre] = useState<PrescreenResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('');
  const [terms, setTerms] = useState<'capital_prescreen' | 'capital_application' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { const r = await listCapital(); setApps(r.applications); setOffers(r.offers); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null); setInfo(null);
    try { await fn(); await reload(); }
    catch (e) {
      if (e instanceof PayError && e.code === 'disclosure_required') setTerms(e.extra?.disclosure_key as 'capital_prescreen' | 'capital_application');
      else setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally { setBusy(false); }
  }

  const doPrescreen = () => run(async () => {
    const r = await prescreenCapital(); setPre(r); setTerms(null);
    setSelected(new Set(r.eligibleReceivables.map((x) => x.invoiceId)));
    setAmount('');
  });

  const chosenTotal = pre ? pre.eligibleReceivables.filter((r) => selected.has(r.invoiceId)).reduce((s, r) => s + r.amountCents, 0) : 0;
  const cents = parseMoneyToCents(amount);
  const canSubmit = pre?.outcome === 'eligible_to_apply' && cents !== null && cents <= chosenTotal && selected.size > 0;

  const submit = () => run(async () => {
    if (!pre || !cents) return;
    const r = await submitCapital(pre.application.id, cents, [...selected]);
    setInfo(r.outcome === 'declined' ? `The lending partner declined this application.${r.declineReasons[0] ? ` ${r.declineReasons[0]}` : ''}` : r.outcome === 'offers' ? 'The lending partner returned offers. Review the full terms below.' : 'Submitted. The lending partner is reviewing.');
    setPre(null); setTerms(null);
  });

  const sandbox = pre?.sandbox || apps.some((a) => a.sandbox) || offers.some((o) => o.sandbox);

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {info && <p role="status" className="text-sm text-text-primary">{info}</p>}
      {terms && <DisclosureGate disclosureKey={terms} onAccepted={() => { setTerms(null); }} />}

      <section className="rounded-xl border border-border bg-bg-secondary p-4">
        <h3 className="text-sm font-semibold text-text-primary">Working capital against your unpaid invoices</h3>
        <p className="mt-1 text-xs text-text-secondary">We check your real paid and unpaid invoices to see if you can apply. A lending partner — not Vireek — decides, and only after you apply.</p>
        <Button className="mt-3" disabled={busy} onClick={doPrescreen}>{busy && !pre ? 'Checking…' : 'Check if I can apply'}</Button>

        {pre && (
          <div className="mt-4 space-y-3">
            <p className="rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">{pre.notice}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-text-secondary">Paid revenue, 12 months</dt><dd className="font-semibold text-text-primary">{formatCents(pre.profile.trailing12mCents)}</dd></div>
              <div><dt className="text-xs text-text-secondary">Paid invoices, 12 months</dt><dd className="font-semibold text-text-primary">{pre.profile.paidInvoiceCount12m}</dd></div>
              <div><dt className="text-xs text-text-secondary">History</dt><dd className="font-semibold text-text-primary">{pre.profile.monthsOfHistory} months</dd></div>
              <div><dt className="text-xs text-text-secondary">Qualifying unpaid invoices</dt><dd className="font-semibold text-text-primary">{formatCents(pre.eligibleReceivablesCents)}</dd></div>
            </dl>
            {pre.outcome === 'not_yet_eligible' ? (
              <div>
                <p className="text-sm font-medium text-text-primary">Not yet eligible to apply. Why:</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-text-secondary">{pre.reasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-medium text-text-primary">You can apply. Choose the invoices to put forward:</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {pre.eligibleReceivables.map((r) => (
                    <li key={r.invoiceId}>
                      <label className="flex cursor-pointer items-center gap-3 p-3 text-sm">
                        <input type="checkbox" className="h-5 w-5" checked={selected.has(r.invoiceId)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.invoiceId); else n.delete(r.invoiceId); return n; })} />
                        <span className="flex-1 text-text-primary">{formatCents(r.amountCents)}</span>
                        <span className="text-xs text-text-secondary">issued {new Date(r.issuedAt).toLocaleDateString()}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <Input label="Amount to request ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} helperText={`Up to ${formatCents(chosenTotal)} (total of selected invoices). The partner sets the actual offer.`} />
                <DisclosureGateInline onNeed={() => setTerms('capital_application')} />
                <Button className="w-full" disabled={busy || !canSubmit} onClick={submit}>{busy ? 'Sending…' : 'Send application to lending partner'}</Button>
              </div>
            )}
          </div>
        )}
      </section>

      {offers.filter((o) => o.status === 'open' || o.status === 'accepted').map((o) => {
        const app = apps.find((a) => a.id === o.application_id);
        const expired = offerIsExpired(o);
        return (
          <section key={o.id} className="rounded-xl border border-border bg-bg-secondary p-4">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-text-primary">Offer from lending partner</h3>{o.sandbox && <Pill tone="warning">Sandbox fixture</Pill>}</div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              {offerCostRows(o, formatCents).map((r) => (<div key={r.label}><dt className="text-xs text-text-secondary">{r.label}</dt><dd className="font-semibold text-text-primary">{r.value}</dd></div>))}
            </dl>
            <p className="mt-2 text-xs text-text-secondary">{o.repayment_description}</p>
            {o.terms_url && <a href={o.terms_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-accent underline">Full partner terms</a>}
            <p className="mt-1 text-xs text-text-secondary">Expires {new Date(o.expires_at).toLocaleDateString()}.</p>
            {o.status === 'open' && app && (
              <div className="mt-3 flex gap-2">
                <Button disabled={busy || expired} onClick={() => { if (window.confirm(`Accept: you receive ${formatCents(o.offered_amount_cents)} and repay ${formatCents(o.total_repayment_cents)}?`)) void run(async () => { await acceptCapitalOffer(app.id, o.id); }); }}>Accept offer</Button>
                <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await withdrawCapital(app.id); })}>Withdraw</Button>
              </div>
            )}
            {o.status === 'accepted' && <Pill tone="success">Accepted</Pill>}
          </section>
        );
      })}

      {apps.length === 0 && !pre ? <EmptyState icon={Landmark} title="No applications yet" description="Check if you can apply to see your eligibility and the exact reasons." /> : apps.length > 0 && (
        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <h3 className="text-sm font-semibold text-text-primary">Applications</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {apps.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2">
                <span className="text-text-primary">{new Date(a.created_at).toLocaleDateString()}{a.requested_amount_cents ? ` · ${formatCents(a.requested_amount_cents)}` : ''}{a.sandbox ? ' (sandbox)' : ''}</span>
                <Pill tone={a.status === 'funded' || a.status === 'accepted' ? 'success' : a.status.includes('declined') || a.status === 'error' || a.status === 'prescreen_not_eligible' ? 'danger' : 'neutral'}>{a.status.replace(/_/g, ' ')}</Pill>
              </li>
            ))}
          </ul>
          {sandbox && <p className="mt-2 text-xs text-warning-500">Sandbox applications are simulations only.</p>}
        </section>
      )}
    </div>
  );
}

/** The submit button is server-gated; this just tells the user the terms apply. */
function DisclosureGateInline({ onNeed }: { onNeed: () => void }) {
  return <button type="button" onClick={onNeed} className="text-xs text-accent underline">Read the application terms and data-sharing consent</button>;
}
