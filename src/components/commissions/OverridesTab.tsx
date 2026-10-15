import { useMemo, useState } from 'react';
import { Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/payroll';
import { dollarsToCents, parseRatePercent, type OverrideType } from '@/lib/commissionEngine';
import {
  errorMessage,
  fetchCompletedJobs,
  fetchJobOverrides,
  fetchJobsByIds,
  removeJobOverride,
  setJobOverride,
  type CommissionEmployee,
  type JobOverride,
  type JobSummary,
} from '@/lib/commissions';
import { Dialog, LoadError, SelectField, StatusPill, formatDay, formatPct, useLoader } from './shared';

const TYPE_LABEL: Record<OverrideType, string> = {
  rate_percent: 'Custom rate',
  flat_cents: 'Flat amount',
  excluded: 'No commission',
};

function describe(o: JobOverride): string {
  if (o.override_type === 'rate_percent') return `${formatPct(Number(o.rate_percent ?? 0))} of job`;
  if (o.override_type === 'flat_cents') return `${formatCents(o.flat_cents ?? 0)} flat`;
  return 'Excluded from commission';
}

function outcomeMessage(status: string): string {
  switch (status) {
    case 'created': return 'Override saved and the commission was recalculated.';
    case 'excluded': return 'Override saved. This job no longer earns commission.';
    case 'exists': return 'Override saved. A manual commission already exists for this job, so it was left unchanged.';
    case 'no_employee': return 'Override saved. It applies once the job’s technician is linked to an employee.';
    case 'no_rule': return 'Override saved, but no commission rule matched this job.';
    default: return 'Override saved. It applies when the job is completed and its invoice is paid.';
  }
}

function OverrideDialog({ open, employees, onClose, onSaved, ownerId }: { open: boolean; employees: CommissionEmployee[]; onClose: () => void; onSaved: () => void; ownerId: string }) {
  const { toast } = useToast();
  const jobs = useLoader(() => (open ? fetchCompletedJobs(ownerId) : Promise.resolve([] as JobSummary[])), [open, ownerId]);
  const [query, setQuery] = useState('');
  const [jobId, setJobId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState<OverrideType>('rate_percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = jobs.data ?? [];
    return (q ? list.filter((j) => `${j.customer_name} ${j.service_type ?? ''}`.toLowerCase().includes(q)) : list).slice(0, 50);
  }, [jobs.data, query]);

  const selected = (jobs.data ?? []).find((j) => j.id === jobId);
  const rate = type === 'rate_percent' ? parseRatePercent(value) : null;
  const flat = type === 'flat_cents' ? dollarsToCents(value) : null;
  const valueOk = type === 'excluded' || (type === 'rate_percent' ? rate !== null : flat !== null && flat <= 2_000_000_000);
  const valid = Boolean(jobId) && valueOk && reason.trim().length >= 3;

  const reset = () => { setQuery(''); setJobId(''); setEmployeeId(''); setType('rate_percent'); setValue(''); setReason(''); };

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const status = await setJobOverride({ jobId, employeeId: employeeId || null, type, ratePercent: rate, flatCents: flat, reason: reason.trim() });
      toast(outcomeMessage(status), 'success');
      reset();
      onSaved();
      onClose();
    } catch (e) {
      toast(errorMessage(e, 'Could not save override.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Add job override"
      description="Replace the normal rule for one job. A reason is required and is kept in the audit trail."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!valid || saving}>{saving ? 'Saving…' : 'Save override'}</Button>
        </>
      }
    >
      <Input label="Find a completed job" icon={Search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Customer or service" />
      {jobs.error ? (
        <LoadError message={jobs.error} onRetry={jobs.reload} />
      ) : (
        <SelectField label="Job" value={jobId} onChange={(v) => { setJobId(v); setEmployeeId(''); }} disabled={jobs.loading} helperText={!jobs.loading && filtered.length === 0 ? 'No completed jobs match.' : undefined}>
          <option value="">{jobs.loading ? 'Loading jobs…' : 'Choose a job'}</option>
          {filtered.map((j) => (
            <option key={j.id} value={j.id}>
              {j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''}{j.completed_at ? ` · ${formatDay(j.completed_at)}` : ''}{j.invoice_amount ? ` · $${Number(j.invoice_amount).toLocaleString()}` : ''}
            </option>
          ))}
        </SelectField>
      )}
      <SelectField label="Applies to" value={employeeId} onChange={setEmployeeId} disabled={!selected}>
        <option value="">Everyone who earns on this job</option>
        {employees
          .filter((e) => e.active && selected?.assigned_technician_id && e.team_member_id === selected.assigned_technician_id)
          .map((e) => <option key={e.id} value={e.id}>{e.full_name} only</option>)}
      </SelectField>
      <SelectField label="Override" value={type} onChange={(v) => { setType(v as OverrideType); setValue(''); }}>
        <option value="rate_percent">Custom rate (% of job)</option>
        <option value="flat_cents">Flat amount (USD)</option>
        <option value="excluded">No commission on this job</option>
      </SelectField>
      {type !== 'excluded' && (
        <Input
          label={type === 'rate_percent' ? 'Rate (%)' : 'Amount (USD)'}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={value && !valueOk ? (type === 'rate_percent' ? 'Enter 0-100 with up to 2 decimals.' : 'Enter a valid dollar amount.') : undefined}
        />
      )}
      <Input label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} helperText="For example: split job with a second technician, warranty return, or promotional discount." />
    </Dialog>
  );
}

export function OverridesTab({ ownerId, employees }: { ownerId: string; employees: CommissionEmployee[] }) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<JobOverride | null>(null);

  const list = useLoader<{ overrides: JobOverride[]; jobs: Map<string, JobSummary> }>(async () => {
    const overrides = await fetchJobOverrides(ownerId);
    const jobs = await fetchJobsByIds(ownerId, overrides.map((o) => o.job_id));
    return { overrides, jobs: new Map(jobs.map((j) => [j.id, j])) };
  }, [ownerId]);

  const nameOf = useMemo(() => new Map(employees.map((e) => [e.id, e.full_name])), [employees]);

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await removeJobOverride(removing.id);
      toast('Override removed and the commission was recalculated.', 'success');
      list.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not remove override.'), 'error');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-secondary">Overrides win over every plan. They cannot change a job that is already on a statement; use an adjustment for those.</p>
        <Button size="sm" onClick={() => setAddOpen(true)} className="shrink-0"><Plus size={14} /> Add override</Button>
      </div>

      {list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <SkeletonTable rows={4} columns={3} />
      ) : (list.data?.overrides.length ?? 0) === 0 ? (
        <EmptyState icon={SlidersHorizontal} title="No job overrides" description="Use an override when one job should pay a different rate, a flat amount, or nothing at all, such as a split job or a warranty return." action={{ label: 'Add override', onClick: () => setAddOpen(true) }} />
      ) : (
        <Card className="p-0 hover:translate-y-0">
          {list.data?.overrides.map((o) => {
            const job = list.data?.jobs.get(o.job_id);
            return (
              <div key={o.id} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{job ? `${job.customer_name}${job.service_type ? ` · ${job.service_type}` : ''}` : 'Job no longer available'}</p>
                  <p className="text-xs text-text-secondary">{o.employee_id ? nameOf.get(o.employee_id) ?? 'Employee' : 'All earners'} · {formatDay(o.created_at)} · {o.reason}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusPill tone={o.override_type === 'excluded' ? 'danger' : 'info'}>{TYPE_LABEL[o.override_type]}</StatusPill>
                  <span className="text-sm font-semibold text-text-primary">{describe(o)}</span>
                  <button type="button" aria-label="Remove override" onClick={() => setRemoving(o)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger"><Trash2 size={16} /></button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <OverrideDialog open={addOpen} employees={employees} ownerId={ownerId} onClose={() => setAddOpen(false)} onSaved={list.reload} />
      <ConfirmDialog
        open={removing !== null}
        title="Remove this override?"
        description="The job goes back to the normal commission rules and its pending commission is recalculated."
        confirmLabel="Remove override"
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
