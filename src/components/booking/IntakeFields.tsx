import { useId } from 'react';
import type { IntakeQuestion } from '@/lib/bookingPolicy';

interface IntakeFieldsProps {
  questions: IntakeQuestion[];
  answers: Record<string, string>;
  errors: Record<string, string>;
  onChange: (id: string, value: string) => void;
}

const fieldClass =
  'focus-ring w-full rounded-xl border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

export function IntakeFields({ questions, answers, errors, onChange }: IntakeFieldsProps) {
  const base = useId();
  if (questions.length === 0) return null;

  return (
    <div className="space-y-3">
      {questions.map((q) => {
        const id = `${base}-${q.id}`;
        const value = answers[q.id] ?? '';
        const error = errors[q.id];
        const border = error ? 'border-danger' : 'border-border';
        const described = error ? `${id}-error` : undefined;

        return (
          <div key={q.id}>
            <label htmlFor={q.type === 'yesno' ? undefined : id} id={`${id}-label`} className="mb-1.5 block text-xs font-medium text-text-secondary">
              {q.label}
              {q.required ? <span className="ml-0.5 text-danger" aria-hidden="true">*</span> : <span className="ml-1 text-text-secondary/70">(optional)</span>}
            </label>

            {q.type === 'text' && (
              <input id={id} value={value} maxLength={1000} aria-invalid={!!error} aria-describedby={described} aria-required={q.required}
                onChange={(e) => onChange(q.id, e.target.value)} className={`${fieldClass} ${border}`} />
            )}
            {q.type === 'longtext' && (
              <textarea id={id} value={value} rows={3} maxLength={1000} aria-invalid={!!error} aria-describedby={described} aria-required={q.required}
                onChange={(e) => onChange(q.id, e.target.value)} className={`${fieldClass} ${border} resize-none`} />
            )}
            {q.type === 'select' && (
              <select id={id} value={value} aria-invalid={!!error} aria-describedby={described} aria-required={q.required}
                onChange={(e) => onChange(q.id, e.target.value)} className={`${fieldClass} ${border}`}>
                <option value="">Select…</option>
                {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {q.type === 'yesno' && (
              <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={described} className="grid grid-cols-2 gap-2">
                {(['yes', 'no'] as const).map((opt) => (
                  <button key={opt} type="button" role="radio" aria-checked={value === opt} onClick={() => onChange(q.id, opt)}
                    className={`focus-ring rounded-xl border px-3 py-2.5 text-xs font-medium capitalize transition-colors ${value === opt ? 'border-accent bg-accent/10 text-accent' : `${border} bg-bg-primary text-text-primary hover:border-accent/40`}`}>
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {error && <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
