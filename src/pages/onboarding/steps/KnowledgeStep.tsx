import { BookOpen, Plus, Trash2 } from 'lucide-react';
import { StepShell } from '../StepShell';
import type { StepProps } from '../types';

const STARTER_PROMPTS = [
  'Do you offer free estimates?',
  'What areas do you service?',
  'Do you charge extra for emergency calls?',
];

export function KnowledgeStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const addRow = () => update({ faqs: [...data.faqs, { question: '', answer: '' }] });
  const removeRow = (i: number) => update({ faqs: data.faqs.filter((_, idx) => idx !== i) });
  const setRow = (i: number, field: 'question' | 'answer', value: string) =>
    update({ faqs: data.faqs.map((f, idx) => (idx === i ? { ...f, [field]: value } : f)) });

  return (
    <StepShell
      stepKey="knowledge"
      icon={BookOpen}
      title="Give Sarah a few quick answers"
      description="A handful of common questions goes a long way. You can build out the full knowledge base later."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
    >
      {data.faqs.length === 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {STARTER_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => update({ faqs: [...data.faqs, { question: q, answer: '' }] })}
              className="focus-ring rounded-full border border-border bg-bg-primary px-3.5 py-1.5 text-xs font-medium text-text-secondary transition-all hover:border-accent/30 hover:text-text-primary"
            >
              + {q}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {data.faqs.map((f, i) => (
          <div key={i} className="rounded-xl border border-border bg-bg-primary p-3">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  value={f.question}
                  onChange={(e) => setRow(i, 'question', e.target.value)}
                  placeholder="Question a caller might ask"
                  className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60"
                />
                <textarea
                  rows={2}
                  value={f.answer}
                  onChange={(e) => setRow(i, 'answer', e.target.value)}
                  placeholder="How Sarah should answer"
                  className="focus-ring w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60"
                />
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="focus-ring mt-1 rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
                aria-label="Remove"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="focus-ring mt-3 flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3.5 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
      >
        <Plus size={14} /> Add another
      </button>

      <p className="mt-4 text-xs text-text-secondary">These are published straight to your AI-facing knowledge base on launch.</p>
    </StepShell>
  );
}
