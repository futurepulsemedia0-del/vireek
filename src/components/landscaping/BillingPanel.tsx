import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import { periodBounds, planBatch, type BatchResult } from '@/lib/tradePacks/landscaping/index';
import {
  billingContract,
  friendlyLandscapingError,
  listBillingRecords,
  listContracts,
  listUnbilledVisits,
  runBilling,
  useLandscapeLoader,
} from '@/lib/landscapingApi';
import { PanelState, Section, cents, todayISO } from './ui';

function lastMonths(n: number): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

export function BillingPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const periods = useMemo(() => lastMonths(12), []);
  const [period, setPeriod] = useState(periods[1] ?? periods[0]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const contracts = useLandscapeLoader((o) => listContracts(o), []);
  const records = useLandscapeLoader((o) => listBillingRecords(o, period), [period]);
  const unbilled = useLandscapeLoader((o) => listUnbilledVisits(o, periodBounds(period).end), [period]);

  const loading = contracts.loading || records.loading || unbilled.loading;
  const error = contracts.error ?? records.error ?? unbilled.error;
  const reload = () => { contracts.reload(); records.reload(); unbilled.reload(); };

  const preview: BatchResult | null = useMemo(() => {
    if (!contracts.data || !records.data || !unbilled.data) return null;
    const byContract = new Map<string, typeof unbilled.data>();
    for (const v of unbilled.data) byContract.set(v.contract_id, [...(byContract.get(v.contract_id) ?? []), v]);
    return planBatch(contracts.data.map(billingContract), byContract, period, new Set(records.data.map((r) => `${r.contract_id}:${r.period}`)));
  }, [contracts.data, records.data, unbilled.data, period]);

  const titleOf = (id: string) => contracts.data?.find((c) => c.id === id)?.title ?? 'Contract';
  const customerOf = (id: string) => contracts.data?.find((c) => c.id === id)?.customer_name ?? '';
  const futureMonth = periodBounds(period).end > todayISO();

  const run = async () => {
    setBusy(true);
    try {
      const r = await runBilling(period, null);
      toast(r.created === 0 ? 'Nothing new to invoice for this month.' : `${r.created} draft invoice(s) created (${cents(r.total_cents)})`, 'success');
      reload();
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Batch invoicing" description="Creates one DRAFT invoice per contract for the month. Running it again never duplicates an invoice; paused days are excluded." actions={canManage && <Button size="sm" loading={busy} disabled={!preview || preview.created.length === 0 || futureMonth} onClick={() => setConfirm(true)}><Receipt className="mr-1 h-4 w-4" />Create {preview?.created.length ?? 0} draft invoice(s)</Button>}>
      <div className="mb-3 max-w-xs">
        <SelectField label="Billing month" value={period} onChange={setPeriod}>{periods.map((p) => <option key={p} value={p}>{p}</option>)}</SelectField>
      </div>
      <PanelState loading={loading} error={error} empty={!preview || (contracts.data ?? []).length === 0} emptyTitle="No contracts to bill" emptyDescription="Billing appears once a contract exists." onRetry={reload}>
        {preview && (
          <div className="space-y-3">
            {preview.created.length === 0 && preview.skippedExisting.length === 0 && <p className="text-sm text-text-secondary">Nothing to invoice for {period}: no completed, unbilled visits.</p>}
            {preview.created.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-text-primary">Will be created</p>
                <ul className="space-y-1">
                  {preview.created.map((d) => (
                    <li key={d.idempotencyKey} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm">
                      <span>{titleOf(d.contractId)} <span className="text-xs text-text-secondary">· {customerOf(d.contractId)} · {d.lines.length} line(s)</span></span>
                      <strong>{cents(d.totalCents)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(records.data ?? []).length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-text-primary">Already invoiced for {period}</p>
                <ul className="space-y-1">
                  {(records.data ?? []).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>{titleOf(r.contract_id)} <Pill tone="success">draft created</Pill></span>
                      <span>{cents(r.total_cents)} · <Link className="text-accent underline" to="/dashboard/invoices">Open invoices</Link></span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-text-secondary">Voiding an invoice releases its month so it can be billed again.</p>
              </div>
            )}
            {preview.notBillable.length > 0 && <p className="text-xs text-text-secondary">{preview.notBillable.length} draft contract(s) are not billed until activated.</p>}
          </div>
        )}
      </PanelState>
      {futureMonth && <p className="mt-2 text-xs text-text-secondary">This month has not ended yet — invoices can be created after it ends.</p>}
      <ConfirmDialog open={confirm} title={`Create invoices for ${period}?`} description={`${preview?.created.length ?? 0} draft invoice(s) will be created. Nothing is sent to customers automatically.`} confirmLabel="Create drafts" onCancel={() => setConfirm(false)} onConfirm={async () => { setConfirm(false); await run(); }} />
    </Section>
  );
}
