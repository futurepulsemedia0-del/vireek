import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Layers, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { errorMessage } from '@/lib/commissions';
import { formatCents } from '@/lib/payroll';
import { Dialog, LoadError, SelectField, StatusPill, currentMonthRange, formatDay, useLoader } from '@/components/commissions/shared';
import {
  BATCH_LABEL,
  BATCH_TONE,
  LINE_LABEL,
  LINE_TONE,
  PROVIDER_META,
  SKIP_COPY,
  buildBatch,
  canBatchTransition,
  canSendBatch,
  fetchBatchLines,
  fetchBatches,
  fetchLinks,
  formatHours,
  listOpenPayrolls,
  normalizeSettings,
  sendBatch,
  transitionBatch,
  type BatchAction,
  type OpenPayroll,
  type PayrollBatch,
  type PayrollConnection,
} from '@/lib/payrollSync';

const NOTE_COPY: Partial<Record<BatchAction, { title: string; description: string; label: string; button: string }>> = {
  return: { title: 'Return to draft', description: 'Tell the preparer what needs to change.', label: 'Note', button: 'Return batch' },
  cancel: { title: 'Cancel batch', description: 'Its timesheets and commission statements are released so they can go into a new batch.', label: 'Reason', button: 'Cancel batch' },
};
const DONE_COPY: Record<BatchAction, string> = { submit: 'Submitted for approval.', approve: 'Approved. You can now send it.', return: 'Returned to draft.', cancel: 'Batch cancelled.' };

function BatchCard({ ownerId, batch, connection, onChanged, onGoToEmployees }: { ownerId: string; batch: PayrollBatch; connection: PayrollConnection | undefined; onChanged: () => void; onGoToEmployees: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noteAction, setNoteAction] = useState<BatchAction | null>(null);
  const [note, setNote] = useState('');
  const [sendOpen, setSendOpen] = useState(false);
  const [payrolls, setPayrolls] = useState<OpenPayroll[] | null>(null);
  const [payrollId, setPayrollId] = useState('');

  const lines = useLoader(() => (open ? fetchBatchLines(ownerId, batch.id) : Promise.resolve([])), [ownerId, batch.id, open, batch.status, batch.run_count]);
  const links = useLoader(() => (open ? fetchLinks(ownerId, batch.connection_id) : Promise.resolve([])), [ownerId, batch.connection_id, open]);
  const linked = useMemo(() => new Set((links.data ?? []).filter((l) => l.confirmed).map((l) => l.employee_id)), [links.data]);
  const label = PROVIDER_META[batch.provider].label;
  const needsOtherApprover = connection ? normalizeSettings(connection.settings).require_separate_approver && batch.submitted_by === user?.id : false;

  const run = async (action: BatchAction, text?: string) => {
    setBusy(true);
    try {
      await transitionBatch(batch.id, action, text);
      toast(DONE_COPY[action], 'success');
      onChanged();
    } catch (e) {
      toast(errorMessage(e, 'Action failed.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmNote = async () => {
    if (!noteAction || note.trim().length < 3) return;
    await run(noteAction, note.trim());
    setNoteAction(null);
    setNote('');
  };

  const openSend = async () => {
    setSendOpen(true);
    setPayrollId('');
    setPayrolls(null);
    try {
      setPayrolls(await listOpenPayrolls(batch.connection_id, batch.period_start, batch.period_end));
    } catch {
      setPayrolls([]);
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      const r = await sendBatch(batch.id, payrollId);
      toast(r.status === 'synced' ? `Sent to ${label}. Review and run payroll there.` : r.error ?? 'Some lines could not be sent. Open the batch for details.', r.status === 'synced' ? 'success' : 'error');
      setSendOpen(false);
      setOpen(true);
    } catch (e) {
      toast(errorMessage(e, 'Could not send this batch.'), 'error');
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <Card className="p-0 hover:translate-y-0">
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{formatDay(batch.period_start)} – {formatDay(batch.period_end)} · {label}</p>
          <p className="text-xs text-text-secondary">{batch.line_count} employee{batch.line_count === 1 ? '' : 's'} · {formatHours(batch.regular_hours)} regular · {formatHours(batch.overtime_hours)} overtime · {formatCents(batch.commission_cents)} commission</p>
          {batch.status === 'draft' && batch.review_note && <p className="mt-1 text-xs text-warning-500">Returned: {batch.review_note}</p>}
          {batch.status === 'cancelled' && batch.cancel_reason && <p className="mt-1 text-xs text-text-secondary">Cancelled: {batch.cancel_reason}</p>}
          {(batch.status === 'partial' || batch.status === 'failed') && batch.last_error && <p className="mt-1 text-xs text-danger">{batch.last_error}</p>}
        </div>
        <StatusPill tone={BATCH_TONE[batch.status]}>{BATCH_LABEL[batch.status]}</StatusPill>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        {canBatchTransition(batch.status, 'submit') && <Button size="sm" disabled={busy} onClick={() => void run('submit')}>Submit for approval</Button>}
        {canBatchTransition(batch.status, 'approve') && <Button size="sm" disabled={busy || needsOtherApprover} onClick={() => void run('approve')} title={needsOtherApprover ? 'A different person must approve this batch.' : undefined}>Approve</Button>}
        {canSendBatch(batch.status) && <Button size="sm" disabled={busy} onClick={() => void openSend()}><Send size={14} /> {batch.status === 'approved' ? `Send to ${label}` : 'Send again'}</Button>}
        {canBatchTransition(batch.status, 'return') && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setNote(''); setNoteAction('return'); }}>Return</Button>}
        {canBatchTransition(batch.status, 'cancel') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setNote(''); setNoteAction('cancel'); }}>Cancel</Button>}
        {needsOtherApprover && batch.status === 'pending_approval' && <span className="text-xs text-text-secondary">Waiting for a second approver.</span>}
        <Button variant="ghost" size="sm" className="ml-auto" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Lines</Button>
      </div>
      {open && (
        <div className="border-t border-border bg-bg-primary/60 px-4 py-2">
          {lines.error ? <LoadError message={lines.error} onRetry={lines.reload} /> : lines.loading ? <p className="py-2 text-xs text-text-secondary">Loading lines…</p> : (lines.data ?? []).map((l) => {
            const unlinked = l.skip_reason === null && !linked.has(l.employee_id) && !links.loading;
            return (
              <div key={l.id} className="flex flex-col gap-1 border-b border-border/60 py-2 text-xs last:border-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-primary">{l.employee_name}</p>
                  <p className="text-text-secondary">
                    {l.send_hours ? `${formatHours(l.regular_hours)} regular · ${formatHours(l.overtime_hours)} overtime · ` : 'Hours not sent (salaried) · '}{formatCents(l.commission_cents)} commission
                  </p>
                  {l.skip_reason && <p className="text-text-secondary">{SKIP_COPY[l.skip_reason] ?? l.skip_reason}</p>}
                  {l.error_message && <p className="text-danger">{l.error_message}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {unlinked && batch.status !== 'synced' && batch.status !== 'cancelled' && <button type="button" onClick={onGoToEmployees} className="focus-ring rounded text-accent underline">Link employee</button>}
                  <StatusPill tone={LINE_TONE[l.status]}>{LINE_LABEL[l.status]}</StatusPill>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={noteAction !== null}
        danger={noteAction === 'cancel'}
        title={noteAction ? NOTE_COPY[noteAction]?.title ?? '' : ''}
        description={noteAction ? NOTE_COPY[noteAction]?.description : undefined}
        onClose={() => setNoteAction(null)}
        footer={<><Button variant="secondary" size="sm" onClick={() => setNoteAction(null)}>Back</Button><Button size="sm" disabled={note.trim().length < 3 || busy} onClick={() => void confirmNote()}>{noteAction ? NOTE_COPY[noteAction]?.button : ''}</Button></>}
      >
        <Input label={noteAction ? NOTE_COPY[noteAction]?.label ?? 'Note' : 'Note'} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Dialog>

      <Dialog
        open={sendOpen}
        title={`Send to ${label}`}
        description={`This fills hours, overtime and commissions on the open ${label} payroll that covers this period. Nothing is processed or paid until you review and run payroll in ${label}.`}
        onClose={() => setSendOpen(false)}
        footer={<><Button variant="secondary" size="sm" onClick={() => setSendOpen(false)}>Cancel</Button><Button size="sm" disabled={busy || payrolls === null} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</Button></>}
      >
        {payrolls === null ? <p className="text-sm text-text-secondary">Looking for open payrolls…</p> : (
          <SelectField label="Provider payroll" value={payrollId} onChange={setPayrollId} helperText={payrolls.length === 0 ? 'No open payroll found for this period. Sending will fail until one exists.' : 'Automatic picks the open payroll that matches this period.'}>
            <option value="">Automatic</option>
            {payrolls.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </SelectField>
        )}
        <p className="text-xs text-text-secondary">Sending again is safe: values are set, never added, so nothing is paid twice.</p>
      </Dialog>
    </Card>
  );
}

export function BatchesTab({ ownerId, connections, onGoToEmployees }: { ownerId: string; connections: PayrollConnection[]; onGoToEmployees: () => void }) {
  const { toast } = useToast();
  const live = connections.filter((c) => c.status === 'connected');
  const [range, setRange] = useState(currentMonthRange);
  const [connId, setConnId] = useState('');
  const [building, setBuilding] = useState(false);
  const batches = useLoader(() => fetchBatches(ownerId), [ownerId]);
  const selected = connId || live[0]?.id || '';
  const rangeValid = Boolean(range.start) && Boolean(range.end) && range.end >= range.start;

  const build = async () => {
    setBuilding(true);
    try {
      await buildBatch(selected, range.start, range.end);
      toast('Draft batch built. Review it, then submit for approval.', 'success');
      batches.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not build the batch.'), 'error');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="grid gap-4 p-4 hover:translate-y-0 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
        <Input type="date" label="Pay period from" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} />
        <Input type="date" label="Pay period to" value={range.end} min={range.start} onChange={(e) => setRange({ ...range, end: e.target.value })} error={!rangeValid && range.start && range.end ? 'End date must be on or after the start date.' : undefined} />
        <SelectField label="Provider" value={selected} onChange={setConnId} disabled={live.length === 0}>
          {live.length === 0 ? <option value="">Connect a provider first</option> : live.map((c) => <option key={c.id} value={c.id}>{PROVIDER_META[c.provider].label}{c.company_name ? ` · ${c.company_name}` : ''}</option>)}
        </SelectField>
        <Button onClick={() => void build()} disabled={!rangeValid || !selected || building} className="w-full lg:w-auto"><Layers size={16} /> {building ? 'Building…' : 'Build batch'}</Button>
      </Card>
      <p className="text-xs text-text-secondary">Includes approved hourly timesheets in the period and approved commission statements up to its end, unless they are already in a Vireek pay run or another batch. Salaried staff get commission only; 1099 contractors are listed but never sent.</p>

      {batches.error ? <LoadError message={batches.error} onRetry={batches.reload} /> : batches.loading ? <SkeletonCardList count={3} rows={2} /> : (batches.data ?? []).length === 0 ? (
        <EmptyState icon={Send} title="No batches yet" description="Connect a provider, link your employees, then build a batch for a pay period. Every batch is reviewed and approved before anything is sent." />
      ) : (
        <div className="space-y-3">
          {(batches.data ?? []).map((b) => (
            <BatchCard key={b.id} ownerId={ownerId} batch={b} connection={connections.find((c) => c.id === b.connection_id)} onChanged={batches.reload} onGoToEmployees={onGoToEmployees} />
          ))}
        </div>
      )}
    </div>
  );
}
