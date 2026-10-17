import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import type { CustomerOption } from '@/lib/installProjectsApi';
import {
  EMPTY_PROJECT_FORM,
  PROJECT_TYPE_LABEL,
  validateProjectForm,
  type ProjectFormValues,
  type ProjectType,
} from '@/lib/installProjects';
import { panelClass, selectClass } from './projectUi';

interface Props {
  mode: 'create' | 'edit';
  initial?: ProjectFormValues;
  customers?: CustomerOption[];
  submitting: boolean;
  onSubmit: (values: ProjectFormValues) => void;
  onCancel: () => void;
}

export function ProjectForm({ mode, initial = EMPTY_PROJECT_FORM, customers = [], submitting, onSubmit, onCancel }: Props) {
  const [v, setV] = useState<ProjectFormValues>(initial);
  const [touched, setTouched] = useState(false);
  const errors = useMemo(() => validateProjectForm(v), [v]);
  const set = <K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const show = (k: keyof ProjectFormValues) => (touched ? errors[k] : undefined);

  const pickCustomer = (id: string) => {
    const c = customers.find((x) => x.id === id);
    setV((prev) => ({
      ...prev,
      customerId: id,
      customerName: c ? c.name : prev.customerName,
      siteAddress: c?.address && !prev.siteAddress ? c.address : prev.siteAddress,
    }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length === 0) onSubmit(v);
  };

  return (
    <form onSubmit={submit} className={`${panelClass} space-y-4`} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Project name" required value={v.name} onChange={(e) => set('name', e.target.value)} error={show('name')} placeholder="e.g. Full system replacement — 4-ton heat pump" maxLength={160} />
        <div>
          <label htmlFor="project-type" className="mb-1.5 block text-sm font-medium text-text-primary">Project type</label>
          <select id="project-type" className={selectClass} value={v.projectType} onChange={(e) => set('projectType', e.target.value as ProjectType)}>
            {(Object.keys(PROJECT_TYPE_LABEL) as ProjectType[]).map((t) => (
              <option key={t} value={t}>{PROJECT_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        {mode === 'create' && customers.length > 0 && (
          <div>
            <label htmlFor="project-customer" className="mb-1.5 block text-sm font-medium text-text-primary">Existing customer</label>
            <select id="project-customer" className={selectClass} value={v.customerId} onChange={(e) => pickCustomer(e.target.value)}>
              <option value="">Enter a new customer below…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <Input label="Customer name" required value={v.customerName} onChange={(e) => set('customerName', e.target.value)} error={show('customerName')} disabled={mode === 'create' && !!v.customerId} maxLength={160} />
        <Input label="Site address" value={v.siteAddress} onChange={(e) => set('siteAddress', e.target.value)} className="sm:col-span-1" />
        <Input label="Contract value (USD)" inputMode="decimal" value={v.contractValue} onChange={(e) => set('contractValue', e.target.value)} error={show('contractValue')} placeholder="18500" />
        <Input label="Estimated labor cost (USD)" inputMode="decimal" value={v.laborEstimate} onChange={(e) => set('laborEstimate', e.target.value)} error={show('laborEstimate')} helperText="Used for the margin forecast." />
        <Input label="Retainage held (%)" inputMode="decimal" value={v.retainagePercent} onChange={(e) => set('retainagePercent', e.target.value)} error={show('retainagePercent')} helperText="Withheld from each progress invoice until completion." />
        <Input label="Start date" type="date" value={v.startDate} onChange={(e) => set('startDate', e.target.value)} />
        <Input label="Target end date" type="date" value={v.targetEndDate} onChange={(e) => set('targetEndDate', e.target.value)} error={show('targetEndDate')} />
      </div>
      <Textarea label="Notes" rows={3} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
      {mode === 'create' && (
        <label className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={v.useTemplate} onChange={(e) => set('useTemplate', e.target.checked)} />
          <span>
            Start from the standard install plan
            <span className="block text-xs text-text-secondary">Adds four phases with milestones and a 30 / 40 / 30 progress billing schedule. Everything stays editable.</span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" size="sm" disabled={submitting}>{submitting ? 'Saving…' : mode === 'create' ? 'Create project' : 'Save changes'}</Button>
      </div>
    </form>
  );
}
