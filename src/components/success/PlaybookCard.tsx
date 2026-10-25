import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, CircleDashed, HelpCircle, SkipForward, Undo2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { PlaybookProgress, PlaybookStepView } from '@/lib/successTools';

interface PlaybookCardProps {
  progress: PlaybookProgress;
  highlighted?: boolean;
  onSkip: (playbookId: string, stepId: string) => void;
  onUnskip: (playbookId: string, stepId: string) => void;
}

function StepIcon({ status }: { status: PlaybookStepView['status'] }) {
  if (status === 'done') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-500 text-white">
        <Check size={13} strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (status === 'unknown') return <HelpCircle size={24} className="shrink-0 text-text-secondary/50" aria-hidden="true" />;
  if (status === 'skipped') return <SkipForward size={24} className="shrink-0 text-text-secondary/40" aria-hidden="true" />;
  return <CircleDashed size={24} className="shrink-0 text-text-secondary/70" aria-hidden="true" />;
}

const STATUS_TEXT: Record<PlaybookStepView['status'], string> = { done: 'Completed', todo: 'To do', skipped: 'Skipped', unknown: 'Can’t be checked yet' };

/** One guided activation playbook. Step completion is detected from real account data, never self-reported. */
export function PlaybookCard({ progress, highlighted = false, onSkip, onUnskip }: PlaybookCardProps) {
  const navigate = useNavigate();
  const { def, steps, done, total, pct, complete, minutesLeft } = progress;
  return (
    <Card className={`space-y-4 p-5 hover:translate-y-0 ${highlighted ? 'ring-2 ring-accent/30' : ''}`}>
      <div>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-text-primary">{def.title}</h3>
          <span className="shrink-0 rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
            {complete ? 'Complete' : total === 0 ? 'Nothing to do' : `${done}/${total} · ~${minutesLeft} min left`}
          </span>
        </div>
        <p className="mt-1 text-sm text-text-secondary">{def.outcome}</p>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
          role="progressbar"
          aria-label={`${def.title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={`h-full ${complete ? 'bg-success-500' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="space-y-3">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3">
            <StepIcon status={s.status} />
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${s.status === 'done' || s.status === 'skipped' ? 'text-text-secondary' : 'text-text-primary'}`}>
                {s.title} <span className="sr-only">— {STATUS_TEXT[s.status]}</span>
              </p>
              {s.status === 'todo' && <p className="mt-0.5 text-xs text-text-secondary">{s.why}</p>}
              {s.status === 'todo' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" onClick={() => navigate(s.href)}>
                    {s.cta} <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onSkip(def.id, s.id)}>
                    Skip
                  </Button>
                  <span className="text-[11px] text-text-secondary">~{s.minutes} min</span>
                </div>
              )}
              {s.status === 'skipped' && (
                <button type="button" onClick={() => onUnskip(def.id, s.id)} className="focus-ring mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-accent hover:underline">
                  <Undo2 size={12} aria-hidden="true" /> Undo skip
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
