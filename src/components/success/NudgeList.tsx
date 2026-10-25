import { useNavigate } from 'react-router-dom';
import { ArrowRight, Clock, Lightbulb, RotateCcw, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { Nudge } from '@/lib/successTools';

interface NudgeListProps {
  nudges: Nudge[];
  onSnooze: (featureKey: string) => void;
  onDismiss: (featureKey: string) => void;
}

/** Nudges for unused / lapsed high-value features. Every one can be snoozed or dismissed for good. */
export function NudgeList({ nudges, onSnooze, onDismiss }: NudgeListProps) {
  const navigate = useNavigate();
  return (
    <ul className="space-y-3">
      {nudges.map((n) => (
        <li key={n.id}>
          <Card className="p-5 hover:translate-y-0">
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${n.kind === 'lapsed' ? 'bg-warning-500/10 text-warning-500' : 'bg-accent/10 text-accent'}`} aria-hidden="true">
                {n.kind === 'lapsed' ? <RotateCcw size={16} /> : <Lightbulb size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-text-primary">{n.title}</h3>
                <p className="mt-1 text-sm text-text-secondary">{n.body}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" onClick={() => navigate(n.href)}>
                    {n.cta} <ArrowRight size={14} aria-hidden="true" />
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onSnooze(n.featureKey)}>
                    <Clock size={14} aria-hidden="true" /> Remind me in 2 weeks
                  </Button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDismiss(n.featureKey)}
                aria-label={`Don’t show “${n.title}” again`}
                className="focus-ring -m-1 shrink-0 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"
              >
                <X size={16} />
              </button>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
