import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import {
  BOOKING_LIMITS,
  INTAKE_TYPE_LABELS,
  newIntakeQuestion,
  type IntakeQuestion,
  type IntakeQuestionType,
} from '@/lib/bookingPolicy';

interface Props {
  questions: IntakeQuestion[];
  errors: Record<string, string>;
  onChange: (next: IntakeQuestion[]) => void;
}

export function IntakeQuestionsEditor({ questions, errors, onChange }: Props) {
  const update = (id: string, patch: Partial<IntakeQuestion>) =>
    onChange(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const remove = (id: string) => onChange(questions.filter((q) => q.id !== id));
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const atMax = questions.length >= BOOKING_LIMITS.intakeMax;

  return (
    <div>
      {questions.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No intake questions yet"
          description="Ask customers what you need to know before you arrive — gate codes, symptoms, equipment age."
          action={{ label: 'Add a question', onClick: () => onChange([newIntakeQuestion()]) }}
        />
      ) : (
        <ul className="space-y-3">
          {questions.map((q, i) => (
            <li key={q.id} className="rounded-xl border border-border bg-bg-primary p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex-1">
                  <Input
                    label={`Question ${i + 1}`}
                    value={q.label}
                    maxLength={BOOKING_LIMITS.labelMax + 20}
                    placeholder="e.g. What is the gate or door code?"
                    error={errors[`intake.${q.id}`]}
                    onChange={(e) => update(q.id, { label: e.target.value })}
                  />
                </div>
                <div className="sm:w-40">
                  <label htmlFor={`type-${q.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">Answer type</label>
                  <select
                    id={`type-${q.id}`}
                    value={q.type}
                    onChange={(e) => update(q.id, { type: e.target.value as IntakeQuestionType })}
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary"
                  >
                    {(Object.keys(INTAKE_TYPE_LABELS) as IntakeQuestionType[]).map((t) => (
                      <option key={t} value={t}>{INTAKE_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
              </div>

              {q.type === 'select' && (
                <div className="mt-3">
                  <Textarea
                    label="Options (one per line)"
                    rows={3}
                    value={q.options.join('\n')}
                    onChange={(e) => update(q.id, { options: e.target.value.split('\n') })}
                    helperText={`${BOOKING_LIMITS.optionsMin}–${BOOKING_LIMITS.optionsMax} options.`}
                  />
                </div>
              )}

              <div className="mt-3 flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={q.required} onChange={(e) => update(q.id, { required: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent-primary))]" />
                  Required
                </label>
                <div className="flex items-center gap-1">
                  <button type="button" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary disabled:opacity-30"><ArrowUp size={16} /></button>
                  <button type="button" aria-label={`Move question ${i + 1} down`} disabled={i === questions.length - 1} onClick={() => move(i, 1)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary disabled:opacity-30"><ArrowDown size={16} /></button>
                  <button type="button" aria-label={`Delete question ${i + 1}`} onClick={() => remove(q.id)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger"><Trash2 size={16} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {questions.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-text-secondary">{questions.length} of {BOOKING_LIMITS.intakeMax} questions</p>
          <Button variant="secondary" size="sm" disabled={atMax} onClick={() => onChange([...questions, newIntakeQuestion()])}>
            <Plus size={16} /> Add question
          </Button>
        </div>
      )}
    </div>
  );
}
