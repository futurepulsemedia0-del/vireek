import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download, FileText, Layers, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { exportToCsv, type CsvColumn } from '@/lib/csvExport';
import { formatCents } from '@/lib/payroll';
import { buildPayrollExportRows, canTransition, type StatementAction, type StatementStatus } from '@/lib/commissionEngine';
import {
  buildStatements,
  errorMessage,
  fetchCommissionStatements,
  fetchStatementRecords,
  markStatementsExported,
  markStatementsPaid,
  transitionStatement,
  type CommissionEmployee,
  type CommissionRecordRow,
  type CommissionStatement,
} from '@/lib/commissions';
import { Dialog, LoadError, STATEMENT_LABEL, STATEMENT_TONE, StatusPill, formatDay, formatPct, useLoader } from './shared';

type Filter = 'all' | StatementStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'pending_approval', label: 'Awaiting approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'paid', label: 'Paid' },
  { id: 'void', label: 'Void' },
];

type NoteAction = { id: string; action: 'return' | 'void' };
const NOTE_COPY = {
  return: { title: 'Return to draft', description: 'Tell the preparer what needs to change.', label: 'Note', button: 'Return statement' },
  void: { title: 'Void statement', description: 'Its commission lines go back to pending so they can be re-issued on a new statement.', label: 'Reason', button: 'Void statement' },
} as const;

function StatementLines({ ownerId, statementId }: { ownerId: string; statementId: string }) {
  const lines = useLoader<CommissionRecordRow[]>(() => fetchStatementRecords(ownerId, statementId), [ownerId, statementId]);
  if (lines.error) return <LoadError message={lines.error} onRetry={lines.reload} />;
  if (lines.loading) return <p className="px-4 py-3 text-xs text-text-secondary">Loading lines…</p>;
  return (
    <div className="border-t border-border bg-bg-primary/60 px-4 py-2">
      {(lines.data ?? []).map((r) => (
        <div key={r.id} className="flex justify-between gap-3 py-1 text-xs">
          <span className="min-w-0 truncate text-text-secondary">
            {formatDay(r.earned_date)} · {r.kind === 'earned' ? `${formatCents(r.basis_amount_cents)} @ ${formatPct(r.commission_rate_percent)}` : `${r.kind === 'clawback' ? 'Clawback' : 'Adjustment'}${r.memo ? `: ${r.memo}` : ''}`}
          </span>
          <span className={`shrink-0 font-medium ${r.commission_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>{formatCents(r.commission_cents)}</span>
        </div>
      ))}
    </div>
  );
}

export function StatementsTab({ ownerId, employees, range, onRangeChange }: { ownerId: string; employees: CommissionEmployee[]; range: { start: string; end: string }; onRangeChange: (r: { start: string; end: string }) => void }) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [building, setBuilding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteAction, setNoteAction] = useState<NoteAction | null>(null);
  const [note, setNote] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [payRef, setPayRef] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const statements = useLoader(() => fetchCommissionStatements(ownerId), [ownerId]);
  const nameOf = useMemo(() => new Map(employees.map((e) => [e.id, e.full_name])), [employees]);
  const rangeValid = Boolean(range.start) && Boolean(range.end) && range.end >= range.start;

  const all = statements.data ?? [];
  const visible = filter === 'all' ? all : all.filter((s) => s.status === filter);
  const exportable = all.filter((s) => selected.has(s.id) && (s.status === 'approved' || s.status === 'paid'));
  const payable = all.filter((s) => selected.has(s.id) && s.status === 'approved');

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAllApproved = () => setSelected(new Set(all.filter((s) => s.status === 'approved').map((s) => s.id)));

  const build = async () => {
    setBuilding(true);
    try {
      const r = await buildStatements(range.start, range.end);
      if (r.created === 0 && r.skipped_negative === 0) {
        toast('Nothing to build: there are no pending commissions in this period. Generate commissions first on the Overview tab.', 'info');
      } else {
        toast(`Created ${r.created} draft statement${r.created === 1 ? '' : 's'}${r.skipped_negative ? `; ${r.skipped_negative} skipped because clawbacks exceed earnings (they carry forward)` : ''}.`, 'success');
      }
      statements.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not build statements.'), 'error');
    } finally {
      setBuilding(false);
    }
  };

  const run = async (s: CommissionStatement, action: StatementAction, text?: string) => {
    setBusyId(s.id);
    try {
      await transitionStatement(s.id, action, text);
      toast({ submit: 'Submitted for approval.', approve: 'Approved. It will be picked up by the next pay run.', return: 'Returned to draft.', void: 'Statement voided.' }[action], 'success');
      statements.reload();
    } catch (e) {
      toast(errorMessage(e, 'Action failed.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmNote = async () => {
    if (!noteAction || note.trim().length < 3) return;
    const target = all.find((s) => s.id === noteAction.id);
    if (target) await run(target, noteAction.action, note.trim());
    setNoteAction(null);
    setNote('');
  };

  const exportCsv = async () => {
    if (exportable.length === 0) return;
    setBulkBusy(true);
    try {
      const rows = buildPayrollExportRows(exportable.map((s) => ({ ...s, employee_name: nameOf.get(s.employee_id) ?? 'Unknown employee' })));
      const keys = Object.keys(rows[0]) as (keyof (typeof rows)[number])[];
      const columns: CsvColumn<(typeof rows)[number]>[] = keys.map((k) => ({ header: k, accessor: (r) => r[k] }));
      exportToCsv(rows, columns, `commission-payroll-${range.end || 'export'}`);
      await markStatementsExported(exportable.map((s) => s.id));
      toast(`Exported ${rows.length} statement${rows.length === 1 ? '' : 's'}.`, 'success');
      statements.reload();
    } catch (e) {
      toast(errorMessage(e, 'Export failed.'), 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const markPaid = async () => {
    setBulkBusy(true);
    try {
      const n = await markStatementsPaid(payable.map((s) => s.id), payRef.trim());
      toast(`Marked ${n} statement${n === 1 ? '' : 's'} paid.`, 'success');
      setSelected(new Set());
      setPayOpen(false);
      setPayRef('');
      statements.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not mark paid.'), 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="grid gap-4 p-4 hover:translate-y-0 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
        <Input type="date" label="Period from" value={range.start} onChange={(e) => onRangeChange({ ...range, start: e.target.value })} />
        <Input type="date" label="Period to" value={range.end} min={range.start} onChange={(e) => onRangeChange({ ...range, end: e.target.value })} error={!rangeValid && range.start && range.end ? 'End date must be on or after the start date.' : undefined} />
        <Button onClick={build} disabled={!rangeValid || building} className="w-full lg:w-auto"><Layers size={16} /> {building ? 'Building…' : 'Build statements'}</Button>
      </Card>

      {statements.error ? (
        <LoadError message={statements.error} onRetry={statements.reload} />
      ) : statements.loading ? (
        <SkeletonCardList count={3} rows={2} />
      ) : all.length === 0 ? (
        <EmptyState icon={FileText} title="No statements yet" description="Generate commissions on the Overview tab, then build one statement per employee for the period. Statements are reviewed and approved before anything is paid." />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div role="tablist" aria-label="Filter statements" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} className={`focus-ring shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${filter === f.id ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={selectAllApproved}>Select approved</Button>
              <Button variant="secondary" size="sm" onClick={exportCsv} disabled={exportable.length === 0 || bulkBusy}><Download size={14} /> Export payroll CSV ({exportable.length})</Button>
              <Button variant="secondary" size="sm" onClick={() => setPayOpen(true)} disabled={payable.length === 0 || bulkBusy}><Wallet size={14} /> Mark paid ({payable.length})</Button>
            </div>
          </div>
          <p className="text-xs text-text-secondary">Approved statements flow into the next pay run automatically. Use the CSV export and “Mark paid” only when an outside payroll provider pays them. Those payments are not posted to the general ledger by Vireek.</p>

          {visible.length === 0 ? (
            <EmptyState icon={FileText} title="Nothing in this view" description="No statements match this filter." />
          ) : (
            <div className="space-y-3">
              {visible.map((s) => {
                const busy = busyId === s.id;
                const selectable = s.status === 'approved' || s.status === 'paid';
                return (
                  <Card key={s.id} className="p-0 hover:translate-y-0">
                    <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        {selectable && <input type="checkbox" aria-label={`Select statement for ${nameOf.get(s.employee_id) ?? 'employee'}`} checked={selected.has(s.id)} onChange={() => toggle(s.id)} className="mt-1" />}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{nameOf.get(s.employee_id) ?? 'Unknown employee'}</p>
                          <p className="text-xs text-text-secondary">{formatDay(s.period_start)} – {formatDay(s.period_end)} · {s.record_count} line{s.record_count === 1 ? '' : 's'}</p>
                          {s.status === 'draft' && s.review_note && <p className="mt-1 text-xs text-warning-500">Returned: {s.review_note}</p>}
                          {s.status === 'void' && s.void_reason && <p className="mt-1 text-xs text-text-secondary">Voided: {s.void_reason}</p>}
                          {s.payment_reference && <p className="mt-1 text-xs text-text-secondary">Payment ref: {s.payment_reference}</p>}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                        {s.exported_at && <StatusPill tone="neutral">Exported</StatusPill>}
                        <StatusPill tone={STATEMENT_TONE[s.status]}>{STATEMENT_LABEL[s.status]}</StatusPill>
                        <div className="text-right">
                          <p className="text-base font-bold text-text-primary">{formatCents(s.net_cents)}</p>
                          <p className="text-[11px] text-text-secondary">{formatCents(s.earned_cents)} earned · {formatCents(s.adjustment_cents)} adj.</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
                      {canTransition(s.status, 'submit') && <Button size="sm" disabled={busy} onClick={() => void run(s, 'submit')}>Submit for approval</Button>}
                      {canTransition(s.status, 'approve') && <Button size="sm" disabled={busy} onClick={() => void run(s, 'approve')}>Approve</Button>}
                      {canTransition(s.status, 'return') && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setNote(''); setNoteAction({ id: s.id, action: 'return' }); }}>Return</Button>}
                      {canTransition(s.status, 'void') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setNote(''); setNoteAction({ id: s.id, action: 'void' }); }}>Void</Button>}
                      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setExpanded(expanded === s.id ? null : s.id)} aria-expanded={expanded === s.id}>
                        {expanded === s.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Lines
                      </Button>
                    </div>
                    {expanded === s.id && <StatementLines ownerId={ownerId} statementId={s.id} />}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      <Dialog
        open={noteAction !== null}
        danger={noteAction?.action === 'void'}
        title={noteAction ? NOTE_COPY[noteAction.action].title : ''}
        description={noteAction ? NOTE_COPY[noteAction.action].description : undefined}
        onClose={() => setNoteAction(null)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setNoteAction(null)}>Cancel</Button>
            <Button size="sm" disabled={note.trim().length < 3 || busyId !== null} onClick={() => void confirmNote()}>{noteAction ? NOTE_COPY[noteAction.action].button : ''}</Button>
          </>
        }
      >
        <Input label={noteAction ? NOTE_COPY[noteAction.action].label : 'Note'} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Dialog>

      <Dialog
        open={payOpen}
        title="Mark statements paid"
        description={`Record that ${payable.length} approved statement${payable.length === 1 ? ' was' : 's were'} paid by your external payroll provider. This cannot be undone.`}
        onClose={() => setPayOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={bulkBusy || payable.length === 0} onClick={() => void markPaid()}>{bulkBusy ? 'Saving…' : 'Mark paid'}</Button>
          </>
        }
      >
        <Input label="Payment reference (optional)" value={payRef} maxLength={120} onChange={(e) => setPayRef(e.target.value)} helperText="Payroll run ID or check number, for your records." />
      </Dialog>
    </div>
  );
}
