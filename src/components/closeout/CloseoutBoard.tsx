import { useMemo } from 'react';
import { AlertTriangle, Clock, CheckCircle2, ShieldAlert, FileWarning } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import {
  CLOSEOUT_STEP_KEYS, STEP_LABELS, STATUS_LABELS, RISK_LABELS, deadlineRisk, daysLeft, missingEvidence,
  type CloseoutSettings, type CloseoutStep, type RiskLevel, type CloseoutEvidence,
} from '@/lib/installCloseout';

export type RiskFilter = 'all' | 'overdue' | 'critical' | 'at_risk' | 'blocked';

export const RISK_STYLE: Record<RiskLevel, string> = {
  overdue: 'bg-danger/15 text-danger',
  critical: 'bg-danger/10 text-danger',
  at_risk: 'bg-warning-500/15 text-warning-500',
  on_track: 'bg-success/10 text-success',
  no_deadline: 'bg-bg-tertiary text-text-secondary',
  done: 'bg-success/10 text-success',
  filed: 'bg-accent/10 text-accent',
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${RISK_STYLE[risk]}`}>
      {RISK_LABELS[risk]}
    </span>
  );
}

export function deadlineText(deadline: string | null, today: string): string {
  if (!deadline) return 'No deadline';
  const d = daysLeft(deadline, today);
  if (d < 0) return `${Math.abs(d)}d overdue`;
  if (d === 0) return 'Due today';
  return `${d}d left`;
}

interface Props {
  steps: CloseoutStep[];
  evidenceByStep: Record<string, CloseoutEvidence[]>;
  today: string;
  settings: CloseoutSettings;
  filter: RiskFilter;
  query: string;
  onOpen: (step: CloseoutStep) => void;
}

export function CloseoutBoard({ steps, evidenceByStep, today, settings, filter, query, onOpen }: Props) {
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return steps.filter((s) => {
      const risk = deadlineRisk(s, today, settings);
      if (filter === 'overdue' && risk !== 'overdue') return false;
      if (filter === 'critical' && risk !== 'critical' && risk !== 'overdue') return false;
      if (filter === 'at_risk' && !['at_risk', 'critical', 'overdue'].includes(risk)) return false;
      if (filter === 'blocked' && !(s.pre_approval_required && s.pre_approval_status !== 'approved' && s.status !== 'not_applicable')) return false;
      if (q) {
        const hay = `${s.closeout_cases?.jobs?.customer_name ?? ''} ${s.closeout_cases?.jobs?.address ?? ''} ${s.closeout_programs?.name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [steps, today, settings, filter, query]);

  if (steps.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="No closeouts open"
        description="Open a closeout for a major install to track its permit, inspection, warranty, rebate and customer documents."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5" role="list" aria-label="Closeout board by step">
      {CLOSEOUT_STEP_KEYS.map((key) => {
        const col = visible.filter((s) => s.step_key === key);
        return (
          <div key={key} role="listitem" className="min-w-0">
            <div className="mb-2 flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold text-text-primary">{STEP_LABELS[key]}</h3>
              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{col.length}</span>
            </div>
            <div className="space-y-2">
              {col.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-text-secondary">Nothing here</p>}
              {col.map((s) => {
                const risk = deadlineRisk(s, today, settings);
                const missing = missingEvidence(s.closeout_programs?.required_evidence ?? [], evidenceByStep[s.id] ?? []);
                const gated = s.pre_approval_required && s.pre_approval_status !== 'approved' && s.status !== 'not_applicable';
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpen(s)}
                    className="focus-ring block w-full text-left"
                    aria-label={`${s.closeout_cases?.jobs?.customer_name ?? 'Job'} — ${STEP_LABELS[key]} — ${RISK_LABELS[risk]}`}
                  >
                    <Card className="!p-3 hover:!translate-y-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-text-primary">{s.closeout_cases?.jobs?.customer_name ?? 'Job'}</p>
                        <RiskBadge risk={risk} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-text-secondary">{s.closeout_programs?.name ?? 'No rule attached'}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                        <span className="inline-flex items-center gap-1"><Clock size={12} />{deadlineText(s.deadline_on, today)}</span>
                        <span>{STATUS_LABELS[s.status]}</span>
                      </div>
                      {(missing.length > 0 || gated || !s.closeout_programs) && (
                        <div className="mt-2 space-y-1 text-[11px]">
                          {gated && <p className="flex items-center gap-1 text-danger"><ShieldAlert size={12} />Pre-approval blocks job start</p>}
                          {missing.length > 0 && <p className="flex items-center gap-1 text-warning-500"><FileWarning size={12} />{missing.length} item(s) missing</p>}
                          {!s.closeout_programs && <p className="flex items-center gap-1 text-text-secondary"><AlertTriangle size={12} />No rule — deadline unknown</p>}
                        </div>
                      )}
                    </Card>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
