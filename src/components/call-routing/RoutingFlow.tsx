import { ArrowDown, Bot, Building2, CalendarOff, ChevronDown, ChevronUp, Clock, Languages, PhoneForwarded, PhoneIncoming, Siren, Voicemail } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  describeCondition,
  describeTarget,
  TARGET_KIND_LABELS,
  type CallRoutingConfig,
  type RoutingContext,
  type RoutingIssue,
  type RoutingTarget,
  type RuleKind,
  type SimulationResult,
  type TargetKind,
  type TraceStatus,
} from '@/lib/callRouting';

export const RULE_ICONS: Record<RuleKind, LucideIcon> = {
  emergency: Siren,
  holiday: CalendarOff,
  hours: Clock,
  language: Languages,
  department: Building2,
};

const TARGET_ICONS: Record<TargetKind, LucideIcon> = {
  ai: Bot,
  member: PhoneForwarded,
  department: Building2,
  phone: PhoneForwarded,
  voicemail: Voicemail,
};

const TRACE_STYLES: Record<TraceStatus, string> = {
  matched: 'border-success-500 ring-2 ring-success-500/30',
  not_matched: 'border-border opacity-80',
  skipped: 'border-border opacity-50',
  disabled: 'border-border opacity-50',
};

function Connector() {
  return (
    <div className="flex justify-center py-1 text-text-secondary/60" aria-hidden="true">
      <ArrowDown size={16} />
    </div>
  );
}

function TargetChip({ target, config, ctx, prefix }: { target: RoutingTarget; config: CallRoutingConfig; ctx: RoutingContext; prefix?: string }) {
  const Icon = TARGET_ICONS[target.kind];
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-primary">
      <Icon size={12} className="shrink-0 text-text-secondary" />
      {prefix && <span className="text-text-secondary">{prefix}</span>}
      <span className="truncate">{describeTarget(target, config, ctx)}</span>
    </span>
  );
}

interface RoutingFlowProps {
  config: CallRoutingConfig;
  ctx: RoutingContext;
  selectedId: string | null;
  issues: RoutingIssue[];
  simulation: SimulationResult | null;
  readOnly?: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onToggle: (id: string) => void;
}

/** The visual flow: one vertical, mobile-first column — Incoming call → ordered rules → fallback → voicemail. */
export function RoutingFlow({ config, ctx, selectedId, issues, simulation, readOnly = false, onSelect, onMove, onToggle }: RoutingFlowProps) {
  const statusOf = (ruleId: string): TraceStatus | null => simulation?.trace.find((t) => t.ruleId === ruleId)?.status ?? null;
  const fallbackReached = !!simulation && simulation.attempts.some((a) => a.stage === 'fallback');

  return (
    <ol className="flex flex-col" aria-label="Call routing flow">
      <li className="flex items-center gap-3 rounded-2xl border border-border bg-bg-secondary px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <PhoneIncoming size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Incoming call</p>
          <p className="text-xs text-text-secondary">Rules are checked top to bottom — the first match wins.</p>
        </div>
      </li>

      {config.rules.map((rule, index) => {
        const Icon = RULE_ICONS[rule.kind];
        const ruleIssues = issues.filter((i) => i.ruleId === rule.id);
        const hasError = ruleIssues.some((i) => i.severity === 'error');
        const status = statusOf(rule.id);
        const selected = selectedId === rule.id;
        const ring = status ? TRACE_STYLES[status] : selected ? 'border-accent ring-2 ring-accent/30' : hasError ? 'border-danger' : 'border-border';
        return (
          <li key={rule.id}>
            <Connector />
            <div className={`flex items-stretch rounded-2xl border bg-bg-secondary transition-colors ${ring} ${rule.enabled ? '' : 'opacity-60'}`}>
              <button
                type="button"
                onClick={() => onSelect(rule.id)}
                aria-current={selected ? 'true' : undefined}
                className="focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-l-2xl p-4 text-left"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-text-primary">{rule.name || 'Untitled rule'}</span>
                    {!rule.enabled && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">Off</span>}
                    {status === 'matched' && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-semibold text-success-500">Matched</span>}
                    {hasError && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">Needs attention</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-secondary">{describeCondition(rule, config)}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    <TargetChip target={rule.target} config={config} ctx={ctx} prefix="Then" />
                    {rule.overflow && <TargetChip target={rule.overflow} config={config} ctx={ctx} prefix="No answer →" />}
                  </span>
                </span>
              </button>
              {!readOnly && (
                <div className="flex shrink-0 flex-col items-center justify-between gap-1 border-l border-border p-1.5">
                  <button type="button" onClick={() => onMove(rule.id, -1)} disabled={index === 0} aria-label={`Move ${rule.name || 'rule'} up`} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary disabled:opacity-30">
                    <ChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} ${rule.name || 'rule'}`}
                    onClick={() => onToggle(rule.id)}
                    className={`focus-ring relative h-5 w-9 rounded-full transition-colors ${rule.enabled ? 'bg-success-500' : 'bg-bg-tertiary'}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${rule.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                  <button type="button" onClick={() => onMove(rule.id, 1)} disabled={index === config.rules.length - 1} aria-label={`Move ${rule.name || 'rule'} down`} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary disabled:opacity-30">
                    <ChevronDown size={16} />
                  </button>
                </div>
              )}
            </div>
          </li>
        );
      })}

      <li>
        <Connector />
        <button
          type="button"
          onClick={() => onSelect('fallback')}
          aria-current={selectedId === 'fallback' ? 'true' : undefined}
          className={`focus-ring flex w-full items-start gap-3 rounded-2xl border bg-bg-secondary p-4 text-left transition-colors ${
            fallbackReached ? 'border-success-500 ring-2 ring-success-500/30' : selectedId === 'fallback' ? 'border-accent ring-2 ring-accent/30' : 'border-border'
          }`}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
            <Bot size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-text-primary">Everything else</span>
            <span className="mt-0.5 block text-xs text-text-secondary">Calls that match no rule go to {TARGET_KIND_LABELS[config.fallback.kind].toLowerCase()}.</span>
            <span className="mt-2 flex">
              <TargetChip target={config.fallback} config={config} ctx={ctx} prefix="Then" />
            </span>
          </span>
        </button>
      </li>

      <li>
        <Connector />
        <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
            <Voicemail size={16} />
          </span>
          <p className="text-xs text-text-secondary">Safety net: if no one answers anywhere above, the caller always reaches voicemail.</p>
        </div>
      </li>
    </ol>
  );
}
