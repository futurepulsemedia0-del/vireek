import { useMemo, useState } from 'react';
import { Pencil, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { saveWorkerProfile, type EmployeeLite, type WorkerProfile } from '@/lib/prevailingWageApi';
import { centsToInput, formatMoney, parseMoneyToCents } from '@/lib/prevailingWage';
import { Pill, SectionTitle, errMsg } from './shared';

interface Props {
  canEdit: boolean;
  employees: EmployeeLite[];
  profiles: WorkerProfile[];
  loading: boolean;
  reload: () => Promise<void>;
}

interface Form {
  employeeId: string;
  defaultClassification: string;
  workerIdLast4: string;
  address: string;
  fringePlan: string;
  fringePlanDescription: string;
  apprenticeRegistration: string;
}

export function WorkersTab({ canEdit, employees, profiles, loading, reload }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byEmp = useMemo(() => new Map(profiles.map((p) => [p.employeeId, p])), [profiles]);
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.fullName ?? 'Employee';

  const edit = (e: EmployeeLite) => {
    const p = byEmp.get(e.id);
    setError(null);
    setForm({
      employeeId: e.id,
      defaultClassification: p?.defaultClassification ?? '',
      workerIdLast4: p?.workerIdLast4 ?? '',
      address: p?.address ?? '',
      fringePlan: centsToInput(p?.fringePlanCentsPerHour ?? 0),
      fringePlanDescription: p?.fringePlanDescription ?? '',
      apprenticeRegistration: p?.apprenticeRegistration ?? '',
    });
  };

  const submit = async () => {
    if (!form) return;
    const plan = parseMoneyToCents(form.fringePlan === '' ? '0' : form.fringePlan);
    if (plan === null || plan > 100_000) return setError('Enter the hourly plan contribution as a dollar amount, for example 8.50.');
    if (form.workerIdLast4 && !/^\d{4}$/.test(form.workerIdLast4)) return setError('Enter exactly the last 4 digits of the worker ID, or leave it blank.');
    setBusy(true);
    setError(null);
    try {
      await saveWorkerProfile({
        employeeId: form.employeeId,
        defaultClassification: form.defaultClassification || null,
        workerIdLast4: form.workerIdLast4 || null,
        address: form.address || null,
        fringePlanCentsPerHour: plan,
        fringePlanDescription: form.fringePlanDescription || null,
        apprenticeRegistration: form.apprenticeRegistration || null,
      });
      toast('Worker saved.', 'success');
      setForm(null);
      await reload();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <SkeletonCardList count={3} />;

  return (
    <div className="space-y-6">
      <SectionTitle hint="Default classification, fringe paid to bona fide plans, and the identifiers certified payroll needs. Plan contributions are credited against required fringe; the rest is paid in cash.">Workers</SectionTitle>

      {form && (
        <Card className="p-4 sm:p-5">
          <SectionTitle>{nameOf(form.employeeId)}</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Default classification" value={form.defaultClassification} onChange={(e) => setForm({ ...form, defaultClassification: e.target.value })} maxLength={200} helperText="Used when the job has no specific entry" />
            <Input label="Worker ID — last 4 digits only" inputMode="numeric" value={form.workerIdLast4} onChange={(e) => setForm({ ...form, workerIdLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })} helperText="Never enter a full SSN" />
            <Input label="Fringe paid to plans ($/hr)" inputMode="decimal" value={form.fringePlan} onChange={(e) => setForm({ ...form, fringePlan: e.target.value })} />
            <div className="sm:col-span-2">
              <Input label="Home address (printed on certified payroll)" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={300} />
            </div>
            <Input label="Plan description" value={form.fringePlanDescription} onChange={(e) => setForm({ ...form, fringePlanDescription: e.target.value })} maxLength={300} placeholder="Health, pension…" />
            <Input label="Apprentice registration no." value={form.apprenticeRegistration} onChange={(e) => setForm({ ...form, apprenticeRegistration: e.target.value })} maxLength={120} />
          </div>
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={submit} disabled={busy}>Save worker</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
          </div>
        </Card>
      )}

      {employees.length === 0 ? (
        <EmptyState icon={Users} title="No employees yet" description="Add employees in Payroll first, then set their prevailing-wage details here." />
      ) : (
        <Card className="overflow-x-auto p-2 sm:p-3">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                <th className="px-2 py-2 font-semibold">Employee</th>
                <th className="px-2 py-2 font-semibold">Default classification</th>
                <th className="px-2 py-2 text-right font-semibold">Rate on file</th>
                <th className="px-2 py-2 text-right font-semibold">Plan fringe</th>
                <th className="px-2 py-2 font-semibold">Details</th>
                <th className="px-2 py-2"><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const p = byEmp.get(e.id);
                return (
                  <tr key={e.id} className="border-b border-border/60">
                    <td className="px-2 py-2 font-medium text-text-primary">{e.fullName}{!e.active && <span className="ml-2"><Pill>Inactive</Pill></span>}</td>
                    <td className="px-2 py-2 text-text-secondary">{p?.defaultClassification ?? '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{e.hourlyRateCents === null ? '—' : formatMoney(e.hourlyRateCents)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p && p.fringePlanCentsPerHour > 0 ? formatMoney(p.fringePlanCentsPerHour) : '—'}</td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {p?.workerIdLast4 && <Pill>ID ••{p.workerIdLast4}</Pill>}
                        {p?.apprenticeRegistration && <Pill tone="accent">Apprentice</Pill>}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canEdit && (
                        <button type="button" onClick={() => edit(e)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary" aria-label={`Edit ${e.fullName}`}>
                          <Pencil size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
