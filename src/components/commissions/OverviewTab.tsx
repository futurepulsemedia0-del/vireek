import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/payroll';
import { dollarsToCents, summarizeGeneration } from '@/lib/commissionEngine';
import {
  RECORDS_PAGE_LIMIT,
  addAdjustment,
  errorMessage,
  fetchCommissionOverview,
  fetchCommissionRecords,
  fetchJobsByIds,
  generateCommissionRecords,
  type CalcSource,
  type CommissionEmployee,
  type CommissionOverviewRow,
  type CommissionRecordRow,
} from '@/lib/commissions';
import { Dialog, LoadError, RECORD_TONE, SelectField, StatusPill, formatDay, formatPct, useLoader } from './shared';

const SOURCE_LABEL: Record<CalcSource, string> = {
  plan: 'Tier plan',
  override_rate: 'Job override (rate)',
  override_flat: 'Job override (flat)',
  employee_rate: 'Flat rate',
  manual: 'Manual entry',
};

type AdjustmentKind = 'bonus' | 'deduction' | 'clawback';

function AdjustmentDialog({ open, employees, defaultEnd, onClose, onSaved }: { open: boolean; employees: CommissionEmployee[]; defaultEnd: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [employeeId, setEmployeeId] = useState('');
  const [kind, setKind] = useState<AdjustmentKind>('clawback');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);

  const cents = dollarsToCents(amount);
  const memoOk = memo.trim().length >= 3;
  const valid = Boolean(employeeId) && cents !== null && cents > 0 && memoOk;

  const submit = async () => {
    if (!valid || cents === null) return;
    setSaving(true);
    try {
      await addAdjustment({
        employeeId,
        kind: kind === 'clawback' ? 'clawback' : 'adjustment',
        amountCents: kind === 'bonus' ? cents : -cents,
        jobId: null,
        memo: memo.trim(),
        earnedDate: defaultEnd,
      });
      toast('Adjustment added. It will be included in the next statement.', 'success');
      setAmount('');
      setMemo('');
      onSaved();
      onClose();
    } catch (e) {
      toast(errorMessage(e, 'Could not add adjustment.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Add adjustment"
      description="Bonuses, corrections and clawbacks (for example a refunded invoice) are ledger lines that flow into the next statement."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!valid || saving}>{saving ? 'Saving…' : 'Add adjustment'}</Button>
        </>
      }
    >
      <SelectField label="Employee" value={employeeId} onChange={setEmployeeId}>
        <option value="">Choose an employee</option>
        {employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
      </SelectField>
      <SelectField label="Type" value={kind} onChange={(v) => setKind(v as AdjustmentKind)}>
        <option value="clawback">Clawback (refund / chargeback)</option>
        <option value="deduction">Correction: subtract</option>
        <option value="bonus">Bonus / correction: add</option>
      </SelectField>
      <Input label="Amount (USD)" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} error={amount && cents === null ? 'Enter a valid amount, e.g. 125.50' : undefined} />
      <Input label="Memo" value={memo} maxLength={300} onChange={(e) => setMemo(e.target.value)} helperText="Shown on the statement and in the audit trail." />
    </Dialog>
  );
}

export function OverviewTab({ ownerId, employees, range, onRangeChange }: { ownerId: string; employees: CommissionEmployee[]; range: { start: string; end: string }; onRangeChange: (r: { start: string; end: string }) => void }) {
  const { toast } = useToast();
  const [generating, setGenerating] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const rangeValid = Boolean(range.start) && Boolean(range.end) && range.end >= range.start;

  const overview = useLoader<CommissionOverviewRow[]>(() => (rangeValid ? fetchCommissionOverview(range.start, range.end) : Promise.resolve([])), [range.start, range.end, rangeValid]);
  const ledger = useLoader<{ records: CommissionRecordRow[]; jobs: Map<string, string> }>(async () => {
    if (!rangeValid) return { records: [], jobs: new Map() };
    const records = await fetchCommissionRecords(ownerId, range.start, range.end);
    const jobs = await fetchJobsByIds(ownerId, records.map((r) => r.job_id).filter((id): id is string => Boolean(id)));
    return { records, jobs: new Map(jobs.map((j) => [j.id, `${j.customer_name}${j.service_type ? ` · ${j.service_type}` : ''}`])) };
  }, [ownerId, range.start, range.end, rangeValid]);

  const nameOf = useMemo(() => new Map(employees.map((e) => [e.id, e.full_name])), [employees]);
  const rows = overview.data ?? [];
  const totals = useMemo(() => rows.reduce((a, r) => ({ pending: a.pending + r.pending_cents, approved: a.approved + r.approved_cents, paid: a.paid + r.paid_cents }), { pending: 0, approved: 0, paid: 0 }), [rows]);

  const reloadAll = () => { overview.reload(); ledger.reload(); };

  const generate = async () => {
    setGenerating(true);
    try {
      toast(summarizeGeneration(await generateCommissionRecords(range.start, range.end)), 'success');
      reloadAll();
    } catch (e) {
      toast(errorMessage(e, 'Could not generate commissions.'), 'error');
    } finally {
      setGenerating(false);
    }
  };

  const loading = overview.loading || ledger.loading;
  const error = overview.error || ledger.error;
  const records = ledger.data?.records ?? [];

  return (
    <div className="space-y-6">
      <Card className="grid gap-4 p-4 hover:translate-y-0 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-end">
        <Input type="date" label="From" value={range.start} onChange={(e) => onRangeChange({ ...range, start: e.target.value })} />
        <Input type="date" label="To" value={range.end} min={range.start} onChange={(e) => onRangeChange({ ...range, end: e.target.value })} error={!rangeValid && range.start && range.end ? 'End date must be on or after the start date.' : undefined} />
        <Button onClick={generate} disabled={!rangeValid || generating} className="w-full lg:w-auto">
          <RefreshCw size={16} className={generating ? 'animate-spin' : ''} /> {generating ? 'Generating…' : 'Generate commissions'}
        </Button>
        <Button variant="secondary" onClick={() => setAdjustOpen(true)} className="w-full lg:w-auto"><Plus size={16} /> Adjustment</Button>
      </Card>

      {error ? (
        <LoadError message={error} onRetry={reloadAll} />
      ) : loading ? (
        <>
          <SkeletonStatGrid count={3} />
          <SkeletonTable rows={5} columns={5} />
        </>
      ) : records.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No commissions in this period"
          description="Commissions are created from completed jobs with a paid invoice whose technician is linked to an employee with a commission rule. Generate them for this period, or widen the dates."
          action={{ label: generating ? 'Generating…' : 'Generate commissions', onClick: () => void generate() }}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { label: 'Pending review', value: totals.pending, hint: 'Not yet on an approved statement' },
              { label: 'Approved', value: totals.approved, hint: 'Ready for payroll' },
              { label: 'Paid', value: totals.paid, hint: 'Included in a completed payment' },
            ].map((k) => (
              <Card key={k.label} className="p-5 hover:translate-y-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{k.label}</p>
                <p className="mt-2 text-2xl font-bold text-text-primary">{formatCents(k.value)}</p>
                <p className="mt-1 text-xs text-text-secondary">{k.hint}</p>
              </Card>
            ))}
          </div>

          <Card className="p-0 hover:translate-y-0">
            <div className="hidden grid-cols-[2fr_repeat(5,1fr)] gap-3 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-secondary md:grid">
              <span>Employee</span><span className="text-right">Jobs</span><span className="text-right">Earned</span><span className="text-right">Adjust.</span><span className="text-right">Pending</span><span className="text-right">Paid</span>
            </div>
            {rows.map((r) => (
              <div key={r.employee_id} className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-border px-4 py-3 text-sm last:border-b-0 md:grid-cols-[2fr_repeat(5,1fr)] md:items-center">
                <span className="col-span-2 font-medium text-text-primary md:col-span-1">{r.full_name}</span>
                <span className="text-text-secondary md:text-right"><span className="md:hidden">Jobs: </span>{r.jobs_count}</span>
                <span className="text-text-primary md:text-right"><span className="text-text-secondary md:hidden">Earned: </span>{formatCents(r.earned_cents)}</span>
                <span className="text-text-secondary md:text-right"><span className="md:hidden">Adj.: </span>{formatCents(r.adjustment_cents)}</span>
                <span className="text-text-secondary md:text-right"><span className="md:hidden">Pending: </span>{formatCents(r.pending_cents)}</span>
                <span className="text-text-secondary md:text-right"><span className="md:hidden">Paid: </span>{formatCents(r.paid_cents)}</span>
              </div>
            ))}
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Ledger</h2>
            <Card className="p-0 hover:translate-y-0">
              {records.map((r) => {
                const job = r.job_id ? ledger.data?.jobs.get(r.job_id) : null;
                const tiers = r.calc_detail?.segments?.map((s) => `${formatCents(s.amount_cents)} @ ${formatPct(s.rate_percent)}`).join(' + ');
                return (
                  <div key={r.id} className="flex flex-col gap-1 border-b border-border px-4 py-3 text-sm last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text-primary">
                        {nameOf.get(r.employee_id) ?? 'Unknown employee'}
                        {job ? <span className="font-normal text-text-secondary"> · {job}</span> : null}
                      </p>
                      <p className="text-xs text-text-secondary" title={tiers}>
                        {formatDay(r.earned_date)} ·{' '}
                        {r.kind === 'earned'
                          ? `${SOURCE_LABEL[r.calc_source]} · ${formatCents(r.basis_amount_cents)} @ ${formatPct(r.commission_rate_percent)}`
                          : `${r.kind === 'clawback' ? 'Clawback' : 'Adjustment'}${r.memo ? `: ${r.memo}` : ''}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {r.statement_id && <StatusPill tone="neutral">On statement</StatusPill>}
                      <StatusPill tone={RECORD_TONE[r.status]}>{r.status}</StatusPill>
                      <span className={`w-24 text-right font-semibold ${r.commission_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>{formatCents(r.commission_cents)}</span>
                    </div>
                  </div>
                );
              })}
            </Card>
            {records.length >= RECORDS_PAGE_LIMIT && (
              <p className="mt-2 text-xs text-text-secondary">Showing the latest {RECORDS_PAGE_LIMIT} lines. Narrow the date range to see the rest. Totals above cover the full range.</p>
            )}
          </div>
        </>
      )}

      <AdjustmentDialog open={adjustOpen} employees={employees} defaultEnd={range.end || range.start} onClose={() => setAdjustOpen(false)} onSaved={reloadAll} />
    </div>
  );
}
