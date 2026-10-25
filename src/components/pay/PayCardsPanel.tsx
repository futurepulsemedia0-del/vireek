// Owner/admin: spend cards (policy, freeze, receipts, sandbox purchase simulator).
import { useCallback, useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { DisclosureGate, Pill } from '@/components/pay/PayShared';
import { PayError, createCard, listCardTransactions, listCards, setCardStatus, simulatePurchase, updateTransactionMeta, uploadReceipt } from '@/lib/payApi';
import { DECLINE_COPY, formatCents, needsReceipt, parseMccList, parseMoneyToCents, type CardTransaction, type SpendCard } from '@/lib/pay';

export function PayCardsPanel({ sandbox }: { sandbox: boolean }) {
  const [cards, setCards] = useState<SpendCard[]>([]);
  const [txns, setTxns] = useState<CardTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [needTerms, setNeedTerms] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [form, setForm] = useState({ holder: '', perTxn: '500', daily: '1000', monthly: '5000', allowed: '', blocked: '' });

  const reload = useCallback(async () => {
    try { const [c, t] = await Promise.all([listCards(), listCardTransactions()]); setCards(c); setTxns(t); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load cards.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id); setError(null); setInfo(null);
    try { await fn(); await reload(); }
    catch (e) {
      if (e instanceof PayError && e.code === 'disclosure_required') setNeedTerms(true);
      else setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally { setBusy(null); }
  }

  function create() {
    const per = parseMoneyToCents(form.perTxn), day = parseMoneyToCents(form.daily), mon = parseMoneyToCents(form.monthly);
    const allowed = parseMccList(form.allowed), blocked = parseMccList(form.blocked);
    if (!form.holder.trim()) return setError('Enter the cardholder name.');
    if (!per || !day || !mon) return setError('Enter valid dollar limits.');
    if (allowed.invalid.length || blocked.invalid.length) return setError('Merchant category codes must be 4 digits.');
    void run('create', async () => {
      await createCard({ holder_name: form.holder.trim(), per_txn_limit_cents: per, daily_limit_cents: day, monthly_limit_cents: mon, allowed_mcc: allowed.valid, blocked_mcc: blocked.valid });
      setForm((f) => ({ ...f, holder: '' }));
    });
  }

  if (loading) return <p className="text-sm text-text-secondary">Loading…</p>;
  const thresholds = new Map(cards.map((c) => [c.id, c.receipt_required_over_cents]));

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {info && <p role="status" className="text-sm text-text-primary">{info}</p>}
      {needTerms && <DisclosureGate disclosureKey="spend_card_terms" onAccepted={() => { setNeedTerms(false); }} />}

      <section className="rounded-xl border border-border bg-bg-secondary p-4">
        <h3 className="text-sm font-semibold text-text-primary">Issue a card</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input label="Cardholder" value={form.holder} onChange={(e) => setForm({ ...form, holder: e.target.value })} />
          <Input label="Per purchase ($)" inputMode="decimal" value={form.perTxn} onChange={(e) => setForm({ ...form, perTxn: e.target.value })} />
          <Input label="Daily ($)" inputMode="decimal" value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} />
          <Input label="Monthly ($)" inputMode="decimal" value={form.monthly} onChange={(e) => setForm({ ...form, monthly: e.target.value })} />
          <Input label="Allowed merchant categories (optional)" placeholder="5251, 5072" value={form.allowed} onChange={(e) => setForm({ ...form, allowed: e.target.value })} helperText="4-digit MCC codes. Empty = all except blocked." />
          <Input label="Blocked categories" placeholder="7995" value={form.blocked} onChange={(e) => setForm({ ...form, blocked: e.target.value })} />
        </div>
        <Button className="mt-3" disabled={busy === 'create'} onClick={create}>{busy === 'create' ? 'Issuing…' : 'Issue virtual card'}</Button>
      </section>

      {cards.length === 0 ? (
        <EmptyState icon={CreditCard} title="No cards yet" description="Issue a card with limits for a team member's business purchases." />
      ) : cards.map((c) => (
        <section key={c.id} className="rounded-xl border border-border bg-bg-secondary p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-text-primary">{c.holder_name} · •••• {c.last4 ?? '••••'}{c.sandbox ? ' (sandbox)' : ''}</p>
              <p className="text-xs text-text-secondary">{formatCents(c.per_txn_limit_cents)} / purchase · {formatCents(c.daily_limit_cents)} / day · {formatCents(c.monthly_limit_cents)} / month</p>
            </div>
            <Pill tone={c.status === 'active' ? 'success' : c.status === 'frozen' ? 'warning' : 'neutral'}>{c.status}</Pill>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {c.status === 'active' && <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => run(c.id, () => setCardStatus(c.id, 'frozen'))}>Freeze</Button>}
            {c.status === 'frozen' && <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => run(c.id, () => setCardStatus(c.id, 'active'))}>Unfreeze</Button>}
            {c.status !== 'canceled' && <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => { if (window.confirm('Cancel this card permanently?')) void run(c.id, () => setCardStatus(c.id, 'canceled')); }}>Cancel card</Button>}
            {sandbox && c.sandbox && c.status !== 'canceled' && (
              <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => run(c.id, async () => {
                const r = await simulatePurchase(c.id, { amount_cents: 7500, mcc: '5251', merchant_name: 'Sandbox Hardware' });
                setInfo(r.approved ? `Simulated $75.00 purchase: approved.` : `Simulated purchase declined: ${r.message}`);
              })}>Simulate $75 purchase</Button>
            )}
          </div>
        </section>
      ))}

      {txns.length > 0 && (
        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <h3 className="text-sm font-semibold text-text-primary">Recent activity</h3>
          <ul className="mt-2 divide-y divide-border">
            {txns.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <p className="text-text-primary">{t.merchant_name ?? 'Merchant'} · {formatCents(t.amount_cents)}{t.sandbox ? ' (sandbox)' : ''}</p>
                  <p className="text-xs text-text-secondary">{new Date(t.created_at).toLocaleString()}{t.status === 'declined' ? ` · ${DECLINE_COPY[t.decline_code ?? ''] ?? 'Declined'}` : ''}</p>
                </div>
                {needsReceipt(t, thresholds.get(t.card_id) ?? 0) ? (
                  <label className="cursor-pointer rounded-lg border border-warning-500/40 px-2 py-1 text-xs font-medium text-warning-500">
                    Add receipt
                    <input type="file" accept="image/*,application/pdf" className="sr-only" onChange={(e) => {
                      const f = e.target.files?.[0]; if (!f) return;
                      void run(t.id, async () => updateTransactionMeta(t.id, { receiptPath: await uploadReceipt(t.user_id, t.id, f) }));
                    }} />
                  </label>
                ) : <Pill tone={t.status === 'declined' ? 'danger' : 'neutral'}>{t.status}</Pill>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
