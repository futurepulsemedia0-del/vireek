// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Award } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/invoices';
import { centsToPoints, newIdempotencyKey, parsePoints, pointsToCents } from '@/lib/pointsLedger';

// "Pay with points" for the loyalty program in 20280105000000_loyalty_points.sql
// (RPCs `loyalty_invoice_context` and `redeem_loyalty_points`). The sibling PointsRedeemPanel talks to the
// separate points ledger (`lpts_*`). Render only the one that matches the account's active program: showing both
// would offer two different balances for the same customer.

interface LoyaltyContext {
  enabled: boolean;
  customer_id?: string | null;
  customer_name?: string;
  balance_points?: number;
  remaining_due_cents?: number;
  max_redeem_cents?: number;
  max_redeem_points?: number;
  redeem_points_per_dollar?: number;
  min_redeem_points?: number;
  max_redeem_pct?: number;
}

interface RedeemResult {
  applied_points: number;
  applied_cents: number;
  balance_points: number;
  remaining_due_cents: number;
  invoice_paid: boolean;
  duplicate: boolean;
}

interface Props {
  invoiceId: string;
  onApplied?: () => void | Promise<void>;
}

export function LoyaltyRedeemPanel({ invoiceId, onApplied }: Props) {
  const { toast } = useToast();
  const [ctx, setCtx] = useState<LoyaltyContext | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // One key per attempt: a retry after a network error reuses it, so the server can never apply the points twice.
  const [key, setKey] = useState(newIdempotencyKey);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { data, error } = await supabase.rpc('loyalty_invoice_context', { p_invoice_id: invoiceId });
      if (error) throw error;
      if (mine === seq.current) setCtx(data as LoyaltyContext);
    } catch {
      if (mine === seq.current) setCtx(null); // no panel rather than a broken one
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  if (!ctx || !ctx.enabled || !ctx.customer_id || !ctx.balance_points || !ctx.max_redeem_points) return null;

  const rate = ctx.redeem_points_per_dollar ?? 100;
  const maxPts = ctx.max_redeem_points;
  const minPts = ctx.min_redeem_points ?? 1;
  const entered = parsePoints(value);
  const worth = entered ? Math.min(pointsToCents(entered, rate), ctx.max_redeem_cents ?? 0) : 0;

  const apply = async () => {
    if (lock.current) return;
    if (!entered) return toast('Enter the number of points to use.', 'error');
    if (entered < minPts) return toast(`The minimum is ${minPts} points.`, 'error');
    if (entered > maxPts) return toast(`At most ${maxPts.toLocaleString()} points can be used on this invoice.`, 'error');
    lock.current = true;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('redeem_loyalty_points', {
        p_customer_id: ctx.customer_id,
        p_invoice_id: invoiceId,
        p_points: entered,
        p_idempotency_key: key,
      });
      if (error) throw new Error(error.message);
      const r = data as RedeemResult;
      toast(r.duplicate ? 'Those points were already applied.' : r.invoice_paid ? 'Invoice paid with points.' : `${formatCents(r.applied_cents)} applied with points.`, 'success');
      setValue('');
      setKey(newIdempotencyKey());
      await onApplied?.();
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not redeem points.', 'error');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4" aria-label="Pay with loyalty points">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Award size={16} className="text-accent" aria-hidden="true" /> Pay with points</h3>
      <p className="mt-1 text-xs text-text-secondary">
        {ctx.customer_name ?? 'This customer'} has {ctx.balance_points.toLocaleString()} points. Up to {maxPts.toLocaleString()} points ({formatCents(ctx.max_redeem_cents ?? 0)}) can be used here.
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
