import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/warrantyClaimRecovery';

interface Row {
  claim_id: string;
  customer_name: string | null;
  manufacturer: string | null;
  status: string;
  approved_amount_cents: number | null;
  credit_received_cents: number | null;
  variance_vs_estimate_cents: number | null;
  variance_vs_approved_cents: number | null;
  short_paid: boolean;
  days_unpaid: number | null;
}

// Reimbursement reconciliation: short-pays and "submitted > N days unpaid" (read from warranty_claim_reconciliation).
export function WarrantyReimbursementPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [days, setDays] = useState(30);
  const [unpaid, setUnpaid] = useState<Row[]>([]);
  const [short, setShort] = useState<Row[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cols = 'claim_id, customer_name, manufacturer, status, approved_amount_cents, credit_received_cents, variance_vs_estimate_cents, variance_vs_approved_cents, short_paid, days_unpaid';
      const [u, s] = await Promise.all([
        supabase.from('warranty_claim_reconciliation').select(cols).gt('days_unpaid', days).order('days_unpaid', { ascending: false }).limit(50),
        supabase.from('warranty_claim_reconciliation').select(cols).eq('short_paid', true).limit(50),
      ]);
      if (!alive) return;
      setUnpaid((u.data as Row[] | null) ?? []);
      setShort((s.data as Row[] | null) ?? []);
    })();
    return () => { alive = false; };
  }, [days, refreshKey]);

  if (unpaid.length === 0 && short.length === 0) return null;
  return (
    <section className="mb-4 rounded-2xl border border-border p-4 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-text-primary">Reimbursement follow-up</h2>
        <label className="text-xs text-text-secondary">
          Unpaid more than{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-border bg-bg-primary px-1 py-0.5">
            {[14, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </div>
      {unpaid.length > 0 && (
        <ul className="mb-2 space-y-1">
          {unpaid.map((r) => (
            <li key={r.claim_id} className="flex justify-between text-text-secondary">
              <span>{r.manufacturer ?? 'Manufacturer'} · {r.customer_name ?? 'Customer'} · {r.status}</span>
              <span className="text-warning-500">{r.days_unpaid} days since submitted</span>
            </li>
          ))}
        </ul>
      )}
      {short.length > 0 && (
        <ul className="space-y-1">
          {short.map((r) => (
            <li key={r.claim_id} className="flex justify-between text-text-secondary">
              <span>Short-paid · {r.manufacturer ?? 'Manufacturer'} · {r.customer_name ?? 'Customer'}</span>
              <span className="text-danger">
                {formatCents(r.credit_received_cents)} of {formatCents(r.approved_amount_cents)}
                {r.variance_vs_estimate_cents !== null ? ` (${r.variance_vs_estimate_cents < 0 ? '-' : '+'}${formatCents(Math.abs(r.variance_vs_estimate_cents))} vs estimate)` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
