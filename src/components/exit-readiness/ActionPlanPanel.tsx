import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { fmtMoney, type ActionStatus, type PlanAction } from '@/lib/exitReadiness';
import { EstimateBanner } from './shared';

interface Props {
  actions: PlanAction[];
  states: Record<string, ActionStatus>;
  busyKey: string | null;
  onState: (key: string, status: ActionStatus) => void;
  onSimulate: (action: PlanAction) => void;
}

const EFFORT_LABEL = { low: 'Low effort', medium: 'Medium effort', high: 'High effort' } as const;

function ImpactText({ a }: { a: PlanAction }) {
  if (!a.impact) return <span className="text-xs text-text-secondary">Value impact not quantified (real, but outside the model)</span>;
  const sign = a.impact.pointCents >= 0 ? '+' : '−';
  return (
    <span className="text-sm font-semibold text-success-500">
      {sign}{fmtMoney(Math.abs(a.impact.pointCents))} est.
      <span className="ml-1 text-[11px] font-normal text-text-secondary">(range {fmtMoney(a.impact.lowCents)} to {fmtMoney(a.impact.highCents)})</span>
    </span>
  );
}

export function ActionPlanPanel({ actions, states, busyKey, onState, onSimulate }: Props) {
  const status = (k: string): ActionStatus => states[k] ?? 'open';
  const open = actions.filter((a) => ['open', 'in_progress'].includes(status(a.key)));
  const closed = actions.filter((a) => ['done', 'dismissed'].includes(status(a.key)));

  return (
    <div className="space-y-6">
      <EstimateBanner compact />
      {open.length === 0 ? (
        <EmptyState icon={ListChecks} title={actions.length ? 'Every action is done or dismissed' : 'No actions needed right now'} description="Your drivers look healthy on the data we have. Recheck after the next month’s snapshot." />
      ) : (
        <ol className="space-y-3">
          {open.map((a, i) => (
            <li key={a.key}>
              <Card className="!p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent" aria-hidden="true">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text-primary">{a.title}</h3>
                    <p className="mt-1 text-xs text-text-secondary">{a.why}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <ImpactText a={a} />
                      {a.cashImpactCents !== null && a.cashImpactCents > 0 && <span className="text-xs text-text-secondary">Frees ≈ {fmtMoney(a.cashImpactCents)} cash (not enterprise value)</span>}
                      <span className="text-xs text-text-secondary">{EFFORT_LABEL[a.effort]} · ~{a.horizonDays} days</span>
                      {status(a.key) === 'in_progress' && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">In progress</span>}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 pl-10">
                  {Object.keys(a.scenario).length > 0 && <Button variant="secondary" size="sm" onClick={() => onSimulate(a)}>Try in simulator</Button>}
                  {status(a.key) === 'open' && <Button variant="ghost" size="sm" disabled={busyKey === a.key} onClick={() => onState(a.key, 'in_progress')}>Start</Button>}
                  <Button variant="ghost" size="sm" disabled={busyKey === a.key} onClick={() => onState(a.key, 'done')}><CheckCircle2 size={14} aria-hidden="true" /> Mark done</Button>
                  <Button variant="ghost" size="sm" disabled={busyKey === a.key} onClick={() => onState(a.key, 'dismissed')}>Dismiss</Button>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      )}
      {closed.length > 0 && (
        <Card className="!p-5">
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Done or dismissed</h3>
          <ul className="space-y-1.5">
            {closed.map((a) => (
              <li key={a.key} className="flex items-center justify-between gap-3 text-xs text-text-secondary">
                <span>{status(a.key) === 'done' ? '✓ ' : ''}{a.title}</span>
                <button type="button" className="focus-ring rounded px-2 py-1 text-accent" disabled={busyKey === a.key} onClick={() => onState(a.key, 'open')}>Reopen</button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
