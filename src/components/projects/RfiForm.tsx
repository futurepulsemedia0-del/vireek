import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import type { ProjectPhase } from '@/lib/installProjects';
import {
  RFI_PARTY_MAX,
  RFI_PARTY_ROLES,
  RFI_PARTY_ROLE_LABEL,
  RFI_PRIORITIES,
  RFI_PRIORITY_LABEL,
  RFI_SUBJECT_MAX,
  RFI_TEXT_MAX,
  validateRfiForm,
  type RfiDirection,
  type RfiFormValues,
  type RfiPartyRole,
  type RfiPriority,
} from '@/lib/projectRfis';
import { compactInput, panelClass, selectClass } from './projectUi';

interface Props {
  mode: 'create' | 'edit';
  initial: RfiFormValues;
  phases: ProjectPhase[];
  submitting: boolean;
  onSubmit: (values: RfiFormValues, intent: 'draft' | 'open') => void;
  onCancel: () => void;
}

const DIRECTIONS: { key: RfiDirection; label: string; hint: string }[] = [
  { key: 'outgoing', label: 'We are asking', hint: 'You need an answer from someone else.' },
  { key: 'incoming', label: 'They are asking us', hint: 'Someone sent you a question to answer.' },
];

export function RfiForm({ mode, initial, phases, submitting, onSubmit, onCancel }: Props) {
  const [v, setV] = useState<RfiFormValues>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateRfiForm(v);
  const hasErrors = Object.keys(errors).length > 0;
  const err = (k: keyof RfiFormValues) => (showErrors ? errors[k] : undefined);
  const set = <K extends keyof RfiFormValues>(k: K, value: RfiFormValues[K]) => setV((f) => ({ ...f, [k]: value }));

  const submit = (intent: 'draft' | 'open') => (e?: React.FormEvent) => {
    e?.preventDefault();
    setShowErrors(true);
    if (!hasErrors) onSubmit(v, intent);
  };

  return (
    <form onSubmit={submit(mode === 'create' ? 'open' : 'draft')} className={`${panelClass} space-y-4`} aria-label={mode === 'create' ? 'New RFI' : 'Edit RFI'} noValidate>
      <h3 className="text-sm font-semibold text-text-primary">{mode === 'create' ? 'New RFI' : 'Edit RFI'}</h3>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-text-primary">Direction</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {DIRECTIONS.map((d) => (
            <label key={d.key} className={`focus-within:ring-2 focus-within:ring-accent/40 flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 text-sm transition-colors ${v.direction === d.key ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/40'}`}>
              <span className="flex items-center gap-2 font-medium text-text-primary">
                <input type="radio" name="rfi-direction" checked={v.direction === d.key} onChange={() => set('direction', d.key)} />
                {d.label}
              </span>
              <span className="mt-0.5 pl-6 text-xs text-text-secondary">{d.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Input label="Subject" required value={v.subject} onChange={(e) => set('subject', e.target.value)} className={compactInput} maxLength={RFI_SUBJECT_MAX} placeholder="e.g. Confirm curb height for RTU-2" error={err('subject')} />
      <Textarea label="Question" required rows={4} value={v.question} onChange={(e) => set('question', e.target.value)} className="py-2 text-sm" maxLength={RFI_TEXT_MAX} placeholder="Be specific: drawing or spec reference, what you need decided, and by when." error={err('question')} />

      <div className="grid gap-3 sm:grid-cols-6">
        <div className="sm:col-span-3">
          <Input label={v.direction === 'incoming' ? 'From' : 'To'} required value={v.partyName} onChange={(e) => set('partyName', e.target.value)} className={compactInput} maxLength={RFI_PARTY_MAX} placeholder="Person or company" error={err('partyName')} />
        </div>
        <div className="sm:col-span-3">
          <label htmlFor="rfi-party-role" className="mb-1.5 block text-sm font-medium text-text-primary">Their role</label>
          <select id="rfi-party-role" className={selectClass} value={v.partyRole} onChange={(e) => set('partyRole', e.target.value as RfiPartyRole)}>
            {RFI_PARTY_ROLES.map((r) => <option key={r} value={r}>{RFI_PARTY_ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Input label="Response due" type="date" value={v.dueDate} onChange={(e) => set('dueDate', e.target.value)} className={compactInput} error={err('dueDate')} helperText={v.dueDate ? undefined : 'No due date means it can never go overdue.'} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="rfi-priority" className="mb-1.5 block text-sm font-medium text-text-primary">Priority</label>
          <select id="rfi-priority" className={selectClass} value={v.priority} onChange={(e) => set('priority', e.target.value as RfiPriority)}>
            {RFI_PRIORITIES.map((p) => <option key={p} value={p}>{RFI_PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="rfi-phase" className="mb-1.5 block text-sm font-medium text-text-primary">Phase</label>
          <select id="rfi-phase" className={selectClass} value={v.phaseId} onChange={(e) => set('phaseId', e.target.value)}>
            <option value="">Whole project</option>
            {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
        <legend className="sr-only">Possible impact</legend>
        <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={v.impactsCost} onChange={(e) => set('impactsCost', e.target.checked)} /> May change cost</label>
        <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={v.impactsSchedule} onChange={(e) => set('impactsSchedule', e.target.checked)} /> May change schedule</label>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        {mode === 'create' ? (
          <>
            <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => submit('draft')()}>Save draft</Button>
            <Button type="submit" size="sm" disabled={submitting}>{v.direction === 'incoming' ? 'Log RFI' : 'Create RFI'}</Button>
          </>
        ) : (
          <Button type="submit" size="sm" disabled={submitting}>Save changes</Button>
        )}
      </div>
      {mode === 'create' && <p className="text-xs text-text-secondary">Open RFIs are tracked for overdue and notify your account when answered. Drafts are not tracked.</p>}
    </form>
  );
}
