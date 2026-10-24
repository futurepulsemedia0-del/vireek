import { useCallback, useEffect, useMemo, useState } from 'react';
import { Briefcase, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  deleteAssignment,
  deleteJobWorker,
  fetchJobWorkers,
  fetchRates,
  saveAssignment,
  saveJobWorker,
  type Determination,
  type EmployeeLite,
  type JobAssignment,
  type JobLite,
  type JobWorker,
  type RuleSetRow,
} from '@/lib/prevailingWageApi';
import { isIsoDate } from '@/lib/prevailingWage';
import { Pill, ReviewBadge, SectionTitle, Select, errMsg, todayIso } from './shared';

interface Props {
  canEdit: boolean;
  jobs: JobLite[];
  assignments: JobAssignment[];
  determinations: Determination[];
  ruleSets: RuleSetRow[];
  employees: EmployeeLite[];
  loading: boolean;
  reload: () => Promise<void>;
}

interface Form {
  determinationId: string;
  ruleSetId: string;
  projectName: string;
  contractNumber: string;
  awardingAgency: string;
  primeContractor: string;
  projectLocation: string;
  contractorName: string;
  contractorAddress: string;
  rateLockDate: string;
  isCertifiedPayroll: boolean;
  notes: string;
}

const emptyForm = (job?: JobLite): Form => ({
  determinationId: '',
  ruleSetId: '',
  projectName: job ? `${job.customer_name}${job.service_type ? ` — ${job.service_type}` : ''}` : '',
  contractNumber: '',
  awardingAgency: '',
  primeContractor: '',
  projectLocation: job?.address ?? '',
  contractorName: '',
  contractorAddress: '',
  rateLockDate: '',
  isCertifiedPayroll: true,
  notes: '',
});

const toForm = (a: JobAssignment): Form => ({
  determinationId: a.determinationId,
  ruleSetId: a.ruleSetId,
  projectName: a.projectName ?? '',
  contractNumber: a.contractNumber ?? '',
  awardingAgency: a.awardingAgency ?? '',
  primeContractor: a.primeContractor ?? '',
  projectLocation: a.projectLocation ?? '',
  contractorName: a.contractorName ?? '',
  contractorAddress: a.contractorAddress ?? '',
  rateLockDate: a.rateLockDate ?? '',
  isCertifiedPayroll: a.isCertifiedPayroll,
  notes: a.notes ?? '',
});

export function JobSetupTab({ canEdit, jobs, assignments, determinations, ruleSets, employees, loading, reload }: Props) {
  const { toast } = useToast();
  const [jobId, setJobId] = useState('');
  const [form, setForm] = useState<Form>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [workers, setWorkers] = useState<JobWorker[]>([]);
  const [classNames, setClassNames] = useState<string[]>([]);
  const [wEmployee, setWEmployee] = useState('');
  const [wClass, setWClass] = useState('');
  const [wFrom, setWFrom] = useState(todayIso());

  const assignment = useMemo(() => assignments.find((a) => a.jobId === jobId) ?? null, [assignments, jobId]);
  const job = useMemo(() => jobs.find((j) => j.id === jobId) ?? null, [jobs, jobId]);
  const assigned = useMemo(() => new Set(assignments.map((a) => a.jobId)), [assignments]);
  const empName = useMemo(() => new Map(employees.map((e) => [e.id, e.fullName])), [employees]);
  const det = determinations.find((d) => d.id === form.determinationId) ?? null;
  const rs = ruleSets.find((r) => r.id === form.ruleSetId) ?? null;

  useEffect(() => {
    setError(null);
    setForm(assignment ? toForm(assignment) : emptyForm(job ?? undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, assignment?.id]);

  const loadWorkers = useCallback(async (id: string, determinationId: string | null) => {
    try {
      const [w, rates] = await Promise.all([fetchJobWorkers(id), determinationId ? fetchRates(determinationId) : Promise.resolve([])]);
      setWorkers(w);
      setClassNames([...new Set(rates.map((r) => r.classification))].sort());
    } catch (e) {
      toast(errMsg(e, 'Could not load job workers.'), 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (jobId && assignment) void loadWorkers(jobId, assignment.determinationId);
    else {
      setWorkers([]);
      setClassNames([]);
    }
  }, [jobId, assignment, loadWorkers]);

  const save = async () => {
    if (!jobId) return setError('Choose a job.');
    if (!form.determinationId) return setError('Choose a wage table.');
    if (!form.ruleSetId) return setError('Choose an overtime rule set.');
    if (form.rateLockDate && !isIsoDate(form.rateLockDate)) return setError('Enter a valid rate-lock date.');
    setBusy(true);
    setError(null);
    try {
      await saveAssignment({
        jobId,
        determinationId: form.determinationId,
        ruleSetId: form.ruleSetId,
        projectName: form.projectName,
        contractNumber: form.contractNumber,
        awardingAgency: form.awardingAgency,
        primeContractor: form.primeContractor,
        projectLocation: form.projectLocation,
        contractorName: form.contractorName,
        contractorAddress: form.contractorAddress,
        isCertifiedPayroll: form.isCertifiedPayroll,
        rateLockDate: form.rateLockDate || null,
        notes: form.notes,
      } as Omit<JobAssignment, 'id'>);
      toast('Job setup saved.', 'success');
      await reload();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await deleteAssignment(jobId);
      toast('Prevailing-wage setup removed from this job.', 'success');
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setConfirmRemove(false);
    }
  };

  const addWorker = async () => {
    if (!wEmployee || !wClass.trim() || !isIsoDate(wFrom)) return toast('Choose an employee, a classification and a start date.', 'error');
    setBusy(true);
    try {
      await saveJobWorker({ jobId, employeeId: wEmployee, classification: wClass, effectiveFrom: wFrom });
      toast('Classification saved.', 'success');
      setWClass('');
      await loadWorkers(jobId, assignment?.determinationId ?? null);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeWorker = async (id: string) => {
    try {
      await deleteJobWorker(id);
      await loadWorkers(jobId, assignment?.determinationId ?? null);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  if (loading) return <SkeletonCardList count={3} />;

  const activeDets = determinations.filter((d) => d.status !== 'archived' || d.id === form.determinationId);
  const activeRules = ruleSets.filter((r) => r.active || r.id === form.ruleSetId);
  const disabled = !canEdit || busy;

  return (
    <div className="space-y-6">
      <SectionTitle hint="Choose the wage table and overtime rules a job follows, add the contract details printed on certified payroll, and set each worker's classification.">Job setup</SectionTitle>

      {jobs.length === 0 ? (
        <EmptyState icon={Briefcase} title="No jobs yet" description="Create a job first, then come back to attach a wage table and overtime rules." />
      ) : (
        <Card className="p-4 sm:p-5">
          <Select label="Job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">Choose a job…</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {assigned.has(j.id) ? '● ' : ''}{j.customer_name}{j.service_type ? ` — ${j.service_type}` : ''}
              </option>
            ))}
          </Select>
          <p className="mt-1.5 text-xs text-text-secondary">● marks jobs that already have a prevailing-wage setup ({assignments.length}).</p>
        </Card>
      )}

      {jobId && (
        <>
          {determinations.length === 0 || ruleSets.length === 0 ? (
            <EmptyState icon={Briefcase} title="Add a wage table and a rule set first" description="Jobs need both. Use the Wage tables and Overtime rules tabs." />
          ) : (
            <Card className="p-4 sm:p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Select label="Wage table" value={form.determinationId} onChange={(e) => setForm({ ...form, determinationId: e.target.value })} disabled={disabled}>
                    <option value="">Choose…</option>
                    {activeDets.map((d) => <option key={d.id} value={d.id}>{d.name}{d.determinationNumber ? ` (${d.determinationNumber})` : ''}</option>)}
                  </Select>
                  {det && <ReviewBadge status={det.legalReviewStatus} />}
                </div>
                <div className="space-y-2">
                  <Select label="Overtime rule set" value={form.ruleSetId} onChange={(e) => setForm({ ...form, ruleSetId: e.target.value })} disabled={disabled}>
                    <option value="">Choose…</option>
                    {activeRules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                  {rs && <ReviewBadge status={rs.legalReviewStatus} />}
                </div>
                <Input label="Project name" value={form.projectName} onChange={(e) => setForm({ ...form, projectName: e.target.value })} maxLength={200} disabled={disabled} />
                <Input label="Contract number" value={form.contractNumber} onChange={(e) => setForm({ ...form, contractNumber: e.target.value })} maxLength={120} disabled={disabled} />
                <Input label="Awarding agency" value={form.awardingAgency} onChange={(e) => setForm({ ...form, awardingAgency: e.target.value })} maxLength={200} disabled={disabled} />
                <Input label="Prime contractor (if you are a subcontractor)" value={form.primeContractor} onChange={(e) => setForm({ ...form, primeContractor: e.target.value })} maxLength={200} disabled={disabled} />
                <Input label="Project location" value={form.projectLocation} onChange={(e) => setForm({ ...form, projectLocation: e.target.value })} maxLength={300} disabled={disabled} />
                <Input label="Rate lock date (contract award)" type="date" value={form.rateLockDate} onChange={(e) => setForm({ ...form, rateLockDate: e.target.value })} disabled={disabled} />
                <Input label="Your company legal name" value={form.contractorName} onChange={(e) => setForm({ ...form, contractorName: e.target.value })} maxLength={200} disabled={disabled} />
                <Input label="Your company address" value={form.contractorAddress} onChange={(e) => setForm({ ...form, contractorAddress: e.target.value })} maxLength={300} disabled={disabled} />
              </div>
              <div className="mt-4">
                <Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} disabled={disabled} />
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={form.isCertifiedPayroll} onChange={(e) => setForm({ ...form, isCertifiedPayroll: e.target.checked })} disabled={disabled} className="h-4 w-4 accent-accent" />
                This job requires certified payroll
              </label>
              {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
              {canEdit && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={save} disabled={busy}>{assignment ? 'Save changes' : 'Enable prevailing wage'}</Button>
                  {assignment && <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={busy}><Trash2 size={14} /> Remove setup</Button>}
                </div>
              )}
            </Card>
          )}

          {assignment && (
            <Card className="p-4 sm:p-5">
              <SectionTitle hint="Each worker's classification on this job. A later start date records a promotion or a change of work mid-job. Without a row here, the worker's default classification (Workers tab) is used.">
                Worker classifications on this job
              </SectionTitle>
              {canEdit && (
                <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto] sm:items-end">
                  <Select label="Employee" value={wEmployee} onChange={(e) => setWEmployee(e.target.value)}>
                    <option value="">Choose…</option>
                    {employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
                  </Select>
                  <div>
                    <Input label="Classification" list="pw-class-options" value={wClass} onChange={(e) => setWClass(e.target.value)} maxLength={200} />
                    <datalist id="pw-class-options">{classNames.map((c) => <option key={c} value={c} />)}</datalist>
                  </div>
                  <Input label="Starting" type="date" value={wFrom} onChange={(e) => setWFrom(e.target.value)} />
                  <Button size="sm" onClick={addWorker} disabled={busy}><Plus size={14} /> Add</Button>
                </div>
              )}
              {workers.length === 0 ? (
                <p className="text-sm text-text-secondary">None added. Workers fall back to their default classification.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {workers.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="font-medium text-text-primary">{empName.get(w.employeeId) ?? 'Unknown employee'}</span>
                      <span className="flex flex-wrap items-center gap-2 text-text-secondary">
                        {w.classification}
                        <Pill>from {w.effectiveFrom}</Pill>
                        {canEdit && (
                          <button type="button" onClick={() => removeWorker(w.id)} className="focus-ring rounded-lg p-1.5 hover:text-danger" aria-label={`Remove ${w.classification} for ${empName.get(w.employeeId) ?? 'employee'}`}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Remove prevailing-wage setup?"
        description="Existing drafts stay. A job with a certified payroll cannot be changed or removed."
        confirmLabel="Remove setup"
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
