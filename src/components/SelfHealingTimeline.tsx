import {
  ScanSearch, Brain, GitBranch, Zap, ShieldCheck,
  MessageSquare, UserCog, Route, CalendarClock, Package, Users, MessageSquareText,
  Check, X, MinusCircle, Clock,
} from 'lucide-react';
import {
  SelfHealingIncident, SelfHealingAction, ActionType,
  INCIDENT_TYPE_LABELS, RISK_TIER_LABELS, RISK_TIER_COLORS, ACTION_TYPE_LABELS,
  OUTCOME_LABELS, OUTCOME_COLORS, formatRelativeTime,
} from '@/lib/selfHealing';

const ACTION_ICONS: Record<ActionType, React.ComponentType<{ size?: number; className?: string }>> = {
  notify_customer: MessageSquare,
  reassign_technician: UserCog,
  reoptimize_route: Route,
  reschedule_downstream: CalendarClock,
  reserve_parts: Package,
  activate_contractor_network: Users,
  offer_customer_options: MessageSquareText,
};

const STATUS_STYLE: Record<string, { icon: typeof Check; className: string }> = {
  success: { icon: Check, className: 'text-success-500' },
  skipped: { icon: MinusCircle, className: 'text-text-secondary' },
  failed: { icon: X, className: 'text-danger' },
  pending: { icon: Clock, className: 'text-text-secondary' },
};

function PhaseStep({
  icon: Icon, title, active, done, children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  active: boolean;
  done: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
            done ? 'border-accent bg-accent text-white' : active ? 'border-accent text-accent' : 'border-border text-text-secondary'
          }`}
        >
          <Icon size={14} />
        </span>
        <span className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <p className={`text-xs font-semibold ${done || active ? 'text-text-primary' : 'text-text-secondary'}`}>{title}</p>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  );
}

export function SelfHealingTimeline({ incident, actions }: { incident: SelfHealingIncident; actions: SelfHealingAction[] }) {
  const hasPredicted = incident.risk_score != null;
  const hasDecided = Boolean(incident.decision?.chosen_actions?.length);
  const hasActed = actions.length > 0;
  const hasVerified = incident.stage === 'resolved';

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <PhaseStep icon={ScanSearch} title="Detect" active done>
        <p className="text-xs text-text-secondary">
          {INCIDENT_TYPE_LABELS[incident.incident_type]} detected {formatRelativeTime(incident.detected_at)}.
        </p>
      </PhaseStep>

      <PhaseStep icon={Brain} title="Predict" active={hasPredicted} done={hasPredicted}>
        {hasPredicted ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RISK_TIER_COLORS[incident.risk_tier!]}`}>
              {RISK_TIER_LABELS[incident.risk_tier!]} · {incident.risk_score}/100
            </span>
            {Boolean((incident.predicted_impact as { cascade_jobs_today?: number })?.cascade_jobs_today) && (
              <span className="text-[11px] text-text-secondary">
                {(incident.predicted_impact as { cascade_jobs_today?: number }).cascade_jobs_today} later job(s) today could cascade
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-text-secondary">Waiting to run.</p>
        )}
      </PhaseStep>

      <PhaseStep icon={GitBranch} title="Decide" active={hasDecided} done={hasDecided}>
        {hasDecided ? (
          <p className="text-xs text-text-secondary">{incident.decision.reasoning}</p>
        ) : (
          <p className="text-xs text-text-secondary">Waiting to run.</p>
        )}
      </PhaseStep>

      <PhaseStep icon={Zap} title="Act" active={hasActed} done={hasActed}>
        {hasActed ? (
          <ul className="space-y-1.5">
            {actions.map((a) => {
              const ActionIcon = ACTION_ICONS[a.action_type];
              const style = STATUS_STYLE[a.status];
              const StatusIcon = style.icon;
              return (
                <li key={a.id} className="flex items-center gap-2 text-xs text-text-secondary">
                  <ActionIcon size={13} className="shrink-0 text-text-secondary" />
                  <span className="flex-1 text-text-primary">{ACTION_TYPE_LABELS[a.action_type]}</span>
                  <StatusIcon size={13} className={style.className} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-text-secondary">Waiting to run.</p>
        )}
      </PhaseStep>

      <div className="flex gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
            hasVerified ? 'border-accent bg-accent text-white' : 'border-border text-text-secondary'
          }`}
        >
          <ShieldCheck size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-xs font-semibold ${hasVerified ? 'text-text-primary' : 'text-text-secondary'}`}>Verify</p>
          {hasVerified && incident.outcome ? (
            <div className="mt-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OUTCOME_COLORS[incident.outcome]}`}>
                {OUTCOME_LABELS[incident.outcome]}
              </span>
              {incident.outcome_note && <p className="mt-1 text-xs text-text-secondary">{incident.outcome_note}</p>}
            </div>
          ) : (
            <p className="mt-1 text-xs text-text-secondary">
              {incident.stage === 'awaiting_verification' ? 'Actions taken — confirming the outcome shortly.' : 'Waiting to run.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
