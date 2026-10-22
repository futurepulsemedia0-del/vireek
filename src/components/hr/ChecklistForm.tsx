import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { CheckField, FormShell, SelectField } from '@/components/hr/HrUi';
import {
  CATEGORY_LABELS,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  HR_CATEGORIES,
  MAX_OFFSET_DAYS,
  SHORT_TEXT_LIMIT,
  TITLE_LIMIT,
  validateTask,
  validateTemplateItem,
  type DocType,
  type HrCategory,
} from '@/lib/hrOnboarding';

export interface ChecklistValues {
  title: string;
  description: string;
  category: HrCategory;
  required: boolean;
  document_type: DocType | '';
  /** Template lines: days after the start date. */
  due_offset_days: string;
  /** Assigned tasks: an exact date (optional). */
  due_date: string;
}

export const EMPTY_CHECKLIST: ChecklistValues = {
  title: '',
  description: '',
  category: 'paperwork',
  required: true,
  document_type: '',
  due_offset_days: '0',
  due_date: '',
};

interface Props {
  /** "template" edits a reusable line (due = N days after start); "task" edits an assigned task (due = a date). */
  mode: 'template' | 'task';
  heading: string;
  submitLabel: string;
  initial?: Partial<ChecklistValues>;
  onSubmit: (values: ChecklistValues) => Promise<boolean>;
  onCancel: () => void;
}

export function ChecklistForm({ mode, heading, submitLabel, initial, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<ChecklistValues>({ ...EMPTY_CHECKLIST, ...initial });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);

  const errors = mode === 'template' ? validateTemplateItem(values) : validateTask(values);
  const err = (key: string): string | undefined => (attempted ? (errors as Record<string, string | undefined>)[key] : undefined);
  const set = <K extends keyof ChecklistValues>(key: K, value: ChecklistValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      await onSubmit(values);
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell title={heading}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <Input label="Title" required value={values.title} maxLength={TITLE_LIMIT} error={err('title')} onChange={(e) => set('title', e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Category" value={values.category} error={err('category')} onChange={(e) => set('category', e.target.value as HrCategory)}>
            {HR_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          {mode === 'template' ? (
            <Input
              label="Due (days after start)"
              inputMode="numeric"
              value={values.due_offset_days}
              error={err('due_offset_days')}
              helperText={`0 = on the start date, up to ${MAX_OFFSET_DAYS}`}
              onChange={(e) => set('due_offset_days', e.target.value)}
            />
          ) : (
            <Input label="Due date (optional)" type="date" value={values.due_date} error={err('due_date')} onChange={(e) => set('due_date', e.target.value)} />
          )}
        </div>
        <SelectField label="Collect a document for this line" value={values.document_type} onChange={(e) => set('document_type', e.target.value as DocType | '')}>
          <option value="">No document</option>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOC_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <Textarea label="Notes / instructions (optional)" rows={2} value={values.description} maxLength={SHORT_TEXT_LIMIT} error={err('description')} onChange={(e) => set('description', e.target.value)} />
        <CheckField label="Required to finish onboarding" checked={values.required} onChange={(v) => set('required', v)} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </form>
    </FormShell>
  );
}
