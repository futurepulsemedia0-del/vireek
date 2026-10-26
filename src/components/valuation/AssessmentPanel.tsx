import { Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ScoreBar } from '@/components/valuation/ValuationUi';
import {
  ANSWER_LABELS,
  DIMENSIONS,
  QUESTIONS,
  scoreAssessment,
  type AnswerValue,
  type Answers,
} from '@/lib/valuation';

interface Props {
  draft: Answers;
  dirty: boolean;
  saving: boolean;
  onChange: (key: string, value: AnswerValue) => void;
  onSave: () => void;
  onReset: () => void;
}

export function AssessmentPanel({ draft, dirty, saving, onChange, onSave, onReset }: Props) {
  const result = scoreAssessment(draft);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            {result.answered} of {result.total} answered
          </p>
          <p className="text-xs text-text-secondary">Answer honestly. Unanswered questions count as zero, so a partial survey never flatters you.</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={!dirty || saving}>Discard changes</Button>
          <Button type="button" size="sm" onClick={onSave} disabled={!dirty || saving}>
            <Save size={16} aria-hidden="true" /> {saving ? 'Saving…' : 'Save answers'}
          </Button>
        </div>
      </div>

      {DIMENSIONS.map((dim) => {
        const dimResult = result.dimensions.find((d) => d.key === dim.key);
        return (
          <section key={dim.key} aria-labelledby={`dim-${dim.key}`} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
            <div className="mb-4 space-y-2">
              <h2 id={`dim-${dim.key}`} className="text-base font-bold text-text-primary">{dim.label}</h2>
              <p className="text-sm text-text-secondary">{dim.blurb}</p>
              <ScoreBar label="Section score" score={dimResult?.score ?? null} detail={`${dimResult?.answered ?? 0} of ${dimResult?.total ?? 0} answered`} />
            </div>
            <ul className="space-y-5">
              {QUESTIONS.filter((q) => q.dimension === dim.key).map((q) => (
                <li key={q.key}>
                  <div role="radiogroup" aria-labelledby={`q-${q.key}`}>
                    <p id={`q-${q.key}`} className="text-sm font-medium text-text-primary">{q.prompt}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {ANSWER_LABELS.map((opt) => {
                        const selected = draft[q.key] === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => onChange(q.key, opt.value)}
                            className={`focus-ring min-h-[44px] rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${selected ? 'border-accent bg-accent text-white' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40 hover:text-text-primary'}`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
