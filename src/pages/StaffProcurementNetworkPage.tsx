/**
 * Staff console for the Procurement Network - /staff/procurement-network
 * Network operator work: approve supplier applications (W-9 + insurance) and negotiate
 * price schedules (approve, or counter with a note). Access is enforced by pn_is_staff() in SQL.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { formatMoney, validateScheduleDraft } from '@/lib/procurementNetwork';
import {
  errorMessage,
  fetchScheduleForReview,
  fetchStaffOverview,
  reviewSchedule,
  reviewSupplier,
} from '@/lib/procurementNetworkApi';
import type { StaffOverview } from '@/lib/procurementNetworkApi';

const fieldClass = 'w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus-ring';
const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-5';

export function StaffProcurementNetworkPage() {
  const { toast } = useToast();
  const [data, setData] = useState<StaffOverview | null>(null);
  const [checks, setChecks] = useState<Record<string, { w9: boolean; ins: boolean }>>({});
  const [detail, setDetail] = useState<{ id: string; text: string; issues: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchStaffOverview());
    } catch (e) {
      toast(errorMessage(e, 'Not allowed or failed to load'), 'error');
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const decideSupplier = async (id: string, decision: 'approved' | 'rejected' | 'suspended') => {
    const notes = window.prompt('Review notes (visible to the supplier)') ?? '';
    const c = checks[id] ?? { w9: false, ins: false };
    try {
      await reviewSupplier(id, decision, notes, c.w9, c.ins);
      toast(`Supplier ${decision}`, 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const inspect = async (s: StaffOverview['proposed_schedules'][number]) => {
    if (detail?.id === s.id) return setDetail(null);
    try {
      const { lines, tiers, items } = await fetchScheduleForReview(s.id, s.program_id);
      const sorted = [...tiers].sort((a, b) => a.rank - b.rank);
      const text = items
        .map((i) => {
          const prices = sorted.map((t) => {
            const l = lines.find((x) => x.catalog_item_id === i.id && x.tier_id === t.id);
            return `${t.label}: ${l ? formatMoney(l.unit_price_cents) : '-'}`;
          });
          return `${i.sku} (list ${formatMoney(i.list_price_cents)})  ${prices.join('  |  ')}`;
        })
        .join('\n');
      setDetail({ id: s.id, text, issues: validateScheduleDraft(sorted, items, lines) });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const decideSchedule = async (id: string, decision: 'approve' | 'counter') => {
    const note = window.prompt(decision === 'counter' ? 'Counter-proposal (required)' : 'Approval note (optional)') ?? '';
    if (decision === 'counter' && note.trim().length < 3) return;
    try {
      await reviewSchedule(id, decision, note);
      toast(decision === 'approve' ? 'Schedule is now active' : 'Counter sent to supplier', 'success');
      setDetail(null);
      await load();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (!data) return <div className="flex min-h-screen items-center justify-center bg-bg-primary"><Loader2 className="animate-spin text-text-secondary" /></div>;

  return (
    <div className="min-h-screen bg-bg-primary px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <h1 className="text-2xl font-bold text-text-primary">Procurement Network - operator console</h1>
        <div className="grid gap-4 sm:grid-cols-4">
          {[['Members', data.network.members], ['Approved suppliers', data.network.approved_suppliers], ['Open programs', data.network.open_programs], ['Network GMV', formatMoney(data.network.orders_gmv_cents)]].map(([l, v]) => (
            <div key={String(l)} className={cardClass}><p className="text-xs uppercase text-text-secondary">{l}</p><p className="mt-1 text-2xl font-bold text-text-primary">{v}</p></div>
          ))}
        </div>

        <section className={cardClass}>
          <h2 className="mb-3 font-semibold text-text-primary">Supplier applications ({data.pending_suppliers.length})</h2>
          {data.pending_suppliers.length === 0 && <p className="text-sm text-text-secondary">Nothing pending.</p>}
          {data.pending_suppliers.map((s) => {
            const c = checks[s.id] ?? { w9: s.w9_verified, ins: s.insurance_verified };
            return (
              <div key={s.id} className="border-t border-border py-3 first:border-0">
                <p className="font-medium text-text-primary">{s.name} <span className="text-xs text-text-secondary">{s.legal_name}</span></p>
                <p className="text-xs text-text-secondary">{s.contact_name} - {s.contact_email} - {s.website}</p>
                <p className="mt-1 text-xs text-text-secondary">{s.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
                  <label><input type="checkbox" checked={c.w9} onChange={(e) => setChecks({ ...checks, [s.id]: { ...c, w9: e.target.checked } })} /> W-9 verified</label>
                  <label><input type="checkbox" checked={c.ins} onChange={(e) => setChecks({ ...checks, [s.id]: { ...c, ins: e.target.checked } })} /> Insurance verified</label>
                  <Button size="sm" onClick={() => void decideSupplier(s.id, 'approved')} disabled={!c.w9 || !c.ins}>Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => void decideSupplier(s.id, 'rejected')}>Reject</Button>
                </div>
              </div>
            );
          })}
        </section>

        <section className={cardClass}>
          <h2 className="mb-3 font-semibold text-text-primary">Price schedules under review ({data.proposed_schedules.length})</h2>
          {data.proposed_schedules.length === 0 && <p className="text-sm text-text-secondary">Nothing pending.</p>}
          {data.proposed_schedules.map((s) => (
            <div key={s.id} className="border-t border-border py-3 first:border-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-text-primary">{s.supplier_name} - {s.program_title} <span className="text-text-secondary">v{s.version}, {s.lines} price lines</span></p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void inspect(s)}>{detail?.id === s.id ? 'Hide' : 'Inspect'}</Button>
                  <Button size="sm" onClick={() => void decideSchedule(s.id, 'approve')}>Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => void decideSchedule(s.id, 'counter')}>Counter</Button>
                </div>
              </div>
              {detail?.id === s.id && (
                <>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-bg-tertiary p-3 text-xs text-text-primary">{detail.text || 'No lines'}</pre>
                  {detail.issues.length > 0 && <ul className="mt-1 text-xs text-rose-600">{detail.issues.map((m) => <li key={m}>{m}</li>)}</ul>}
                </>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
