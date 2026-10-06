// src/components/technician/FieldFormsCard.tsx
// Checklist / form templates for one job. Templates are cached on the device, so forms work
// the same with no signal; each submission is saved locally first and synced automatically.
import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useFieldVersion } from '@/hooks/useFieldSync';
import { getLastKnownFix } from '@/lib/offline/capture';
import { idb } from '@/lib/offline/db';
import {
  loadTemplates, sortForService, toAnswers, validateValues,
  type FormField, type FormTemplate, type FormValue, type FormValues,
} from '@/lib/offline/forms';
import { enqueue } from '@/lib/offline/outbox';

const fieldClass = 'w-full rounded-md border border-border bg-bg-primary p-2 text-sm text-text-primary';

function FieldInput(props: { field: FormField; value: FormValue | undefined; error?: string; onChange: (v: FormValue) => void }) {
  const { field, value, error, onChange } = props;
  const id = `ff-${field.id}`;

  let control;
  if (field.type === 'textarea') {
    control = <textarea id={id} rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={fieldClass} />;
  } else if (field.type === 'select') {
    control = (
      <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
        <option value="">Select…</option>
        {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (field.type === 'yes_no') {
    control = (
      <div className="flex gap-2" role="radiogroup" aria-labelledby={`${id}-label`}>
        {(['yes', 'no'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={value === choice}
            onClick={() => onChange(choice)}
            className={`min-h-[44px] flex-1 rounded-md border text-sm font-medium ${value === choice ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-primary'}`}
          >
            {choice === 'yes' ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    );
  } else if (field.type === 'checkbox') {
    return (
      <div>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {field.label}{field.required ? ' *' : ''}
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  } else {
    control = (
      <input
        id={id}
        type={field.type === 'number' ? 'number' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className={fieldClass}
      />
    );
  }

  return (
    <div className="space-y-1">
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-text-primary">
        {field.label}{field.required ? ' *' : ''}
      </label>
      {field.help && <p className="text-xs text-text-secondary">{field.help}</p>}
      {control}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export function FieldFormsCard({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const version = useFieldVersion();
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadTemplates(), idb.get<{ service_type?: string | null }>('jobs', jobId).catch(() => undefined)]).then(([all, job]) => {
      if (cancelled) return;
      const sorted = sortForService(all, job?.service_type);
      setTemplates(sorted);
      setSelectedId((current) => (sorted.some((t) => t.id === current) ? current : sorted[0]?.id ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, version]);

  const template = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);

  if (!template) return null;

  function select(id: string) {
    setSelectedId(id);
    setValues({});
    setErrors({});
  }

  async function submit() {
    if (!template || busy) return;
    const found = validateValues(template, values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      toast('Please complete the required fields.', 'error');
      return;
    }
    setBusy(true);
    try {
      const fix = getLastKnownFix();
      await enqueue('artifact', jobId, {
        kind: 'form',
        data: { template_id: template.id, slug: template.slug, version: template.version, title: template.title, answers: toAnswers(template, values) },
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
      });
      setValues({});
      toast(`${template.title} saved`, 'success');
    } catch {
      toast('Could not save on this device — free up storage and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border border-border bg-bg-primary p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text-primary">
        <ClipboardCheck className="h-4 w-4" /> Checklists &amp; forms
      </summary>
      <div className="mt-3 space-y-3">
        {templates.length > 1 && (
          <select value={selectedId} onChange={(e) => select(e.target.value)} aria-label="Choose a form" className={fieldClass}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        )}
        {template.description && <p className="text-xs text-text-secondary">{template.description}</p>}
        {template.fields.map((field) => (
          <FieldInput
            key={`${template.id}:${field.id}`}
            field={field}
            value={values[field.id]}
            error={errors[field.id]}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
          />
        ))}
        <button type="button" disabled={busy} onClick={() => void submit()} className="w-full rounded-md bg-accent py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save form'}
        </button>
      </div>
    </details>
  );
}
