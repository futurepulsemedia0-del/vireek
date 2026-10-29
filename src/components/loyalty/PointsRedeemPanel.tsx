import { useCallback, useEffect, useState } from 'react';
import { Award } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/invoices';
import {
  centsToPoints,
  fetchInvoiceContext,
  newIdempotencyKey,
  parsePoints,
  pointsToCents,
  redeemPoints,
  type InvoiceContext,
} from '@/lib/pointsLedger';

/** "Pay with points" card for the invoice detail page. Renders nothing when the program is off or there is nothing to use. */
export function PointsRedeemPanel({ invoiceId, onApplied }: { invoiceId: string; onApplied?: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [ctx, setCtx] = useState<InvoiceContext | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);

  const load = useCallback(async () => {
    try {
      setCtx(await fetchInvoiceContext(invoiceId));
    } catch {
      setCtx(null);
    }
  }, [invoiceId]);
  useEffect(() => { void load(); }, [load]);

  if (!ctx || !ctx.enabled || !ctx.customer_id || !ctx.balance_points || !ctx.max_redeem_points) return null;
  const rate = ctx.redeem_points_per_dollar ?? 100;
  const maxPts = ctx.max_redeem_points;
  const entered = parsePoints(value);
  const worth = entered ? Math.min(pointsToCents(entered, rate), ctx.max_redeem_cents ?? 0) : 0;
  const tooLow = entered !== null && entered < (ctx.min_redeem_points ?? 1);

  const apply = async () => {
    if (!entered) return toast('Enter the number of points to use.', 'error');
    if (tooLow) return toast(`The minimum is ${ctx.min_redeem_points} points.`, 'error');
    if (entered > maxPts) return toast(`At most ${maxPts.toLocaleString()} points can be used on this invoice.`, 'error');
    setBusy(true);
    try {
      const r = await redeemPoints({ customerId: ctx.customer_id as string, invoiceId, points: entered, idempotencyKey: key });
      toast(r.invoice_paid ? 'Invoice paid with points.' : `${formatCents(r.applied_cents)} applied with points.`, 'success');
      setValue('');
      setKey(newIdempotencyKey());
      await onApplied?.();
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not redeem points.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Pay with loyalty points">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Award size={16} className="text-accent" /> Pay with points</h3>
      <p className="mt-1 text-xs text-text-secondary">
        {ctx.customer_name} has {ctx.balance_points.toLocaleString()} points. Up to {maxPts.toLocaleString()} points ({formatCents(ctx.max_redeem_cents ?? 0)}) can be used here.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="focus-ring w-36 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          inputMode="numeric"
          aria-label="Points to use"
          placeholder="Points"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="focus-ring rounded-xl border border-border px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary" onClick={() => setValue(String(maxPts))}>Use max</button>
        <button type="button" disabled={busy || !entered} onClick={() => void apply()} className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50">
          {busy ? 'Applying…' : worth > 0 ? `Apply ${formatCents(worth)}` : 'Apply'}
        </button>
      </div>
      {entered !== null && worth > 0 && <p className="mt-2 text-xs text-text-secondary">Uses {Math.min(centsToPoints(worth, rate), entered).toLocaleString()} points.</p>}
    </section>
  );
}
