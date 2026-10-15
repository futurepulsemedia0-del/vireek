import { CheckCircle2, CircleDashed, Clock, MinusCircle, PhoneOff, Play, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { wallClockNow, type CallRoutingConfig, type DialAttempt, type SimulationInput, type SimulationResult, type TraceStatus } from '@/lib/callRouting';

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent';

const TRACE_ICON: Record<TraceStatus, JSX.Element> = {
  matched: <CheckCircle2 size={14} className="text-success-500" />,
  not_matched: <XCircle size={14} className="text-text-secondary" />,
  skipped: <MinusCircle size={14} className="text-text-secondary/60" />,
  disabled: <CircleDashed size={14} className="text-text-secondary/60" />,
};

const OUTCOME_STYLE: Record<DialAttempt['outcome'], string> = {
  answered: 'bg-success-500/10 text-success-500',
  no_answer: 'bg-warning-500/10 text-warning-500',
  unreachable: 'bg-danger/10 text-danger',
};
const OUTCOME_LABEL: Record<DialAttempt['outcome'], string> = { answered: 'Answered', no_answer: 'No answer', unreachable: 'Skipped' };
const STAGE_LABEL: Record<DialAttempt['stage'], string> = { rule: 'Rule', overflow: 'Overflow', fallback: 'Everything else', voicemail: 'Safety net' };

interface RoutingSimulatorProps {
  config: CallRoutingConfig;
  input: SimulationInput;
  result: SimulationResult;
  languageOptions: string[];
  onChange: (input: SimulationInput) => void;
}

export function RoutingSimulator({ config, input, result, languageOptions, onChange }: RoutingSimulatorProps) {
  const set = (patch: Partial<SimulationInput>) => onChange({ ...input, ...patch });
  return (
    <Card className="space-y-5 p-5 hover:translate-y-0">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Play size={16} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Live simulation</h2>
          <p className="text-xs text-text-secondary">Uses your real hours, holidays and team. Nothing is dialed.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Date" type="date" value={input.at.date} onChange={(e) => e.target.value && set({ at: { ...input.at, date: e.target.value } })} />
        <Input label="Time" type="time" value={input.at.time} onChange={(e) => e.target.value && set({ at: { ...input.at, time: e.target.value } })} />
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={() => set({ at: wallClockNow(config.timezone) })}>
        <Clock size={14} /> Use current time ({config.timezone})
      </Button>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="sim-language" className="mb-1 block text-xs font-medium text-text-secondary">Caller language</label>
          <select id="sim-language" className={SELECT_CLASS} value={input.language} onChange={(e) => set({ language: e.target.value })}>
            <option value="">Not detected</option>
            {languageOptions.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sim-dept" className="mb-1 block text-xs font-medium text-text-secondary">Department requested</label>
          <select id="sim-dept" className={SELECT_CLASS} value={input.departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value || null })}>
            <option value="">None</option>
            {config.departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name || 'Unnamed department'}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sim-ring" className="mb-1 block text-xs font-medium text-text-secondary">When a person is dialed</label>
          <select id="sim-ring" className={SELECT_CLASS} value={input.ringOutcome} onChange={(e) => set({ ringOutcome: e.target.value as SimulationInput['ringOutcome'] })}>
            <option value="answered">They answer</option>
            <option value="no_answer">Nobody answers</option>
          </select>
        </div>
        <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-text-primary">
          <input type="checkbox" className="focus-ring h-4 w-4 rounded border-border" checked={input.emergency} onChange={(e) => set({ emergency: e.target.checked })} />
          Caller reports an emergency
        </label>
      </div>

      <div role="status" aria-live="polite" className="rounded-xl bg-bg-tertiary p-4">
        <p className="text-xs text-text-secondary">
          {result.facts.holiday ? `Holiday: ${result.facts.holiday}` : result.facts.hoursConfigured ? (result.facts.open ? 'You are open' : 'You are closed') : 'Hours not set (treated as open)'}
        </p>
        <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
          {result.finalKind === 'voicemail' && <PhoneOff size={14} className="text-warning-500" />}
          Call is answered by: {result.finalLabel}
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Dial sequence</h3>
        <ol className="space-y-1.5">
          {result.attempts.map((a, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 shrink-0 text-xs text-text-secondary">{STAGE_LABEL[a.stage]}</span>
              <span className="min-w-0 flex-1 truncate text-text-primary">{a.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${OUTCOME_STYLE[a.outcome]}`}>{OUTCOME_LABEL[a.outcome]}</span>
              {a.note && <span className="w-full pl-24 text-xs text-text-secondary">{a.note}</span>}
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Why this route</h3>
        {result.trace.length === 0 ? (
          <p className="text-xs text-text-secondary">Add a rule to see how it is evaluated.</p>
        ) : (
          <ol className="space-y-1.5">
            {result.trace.map((t) => (
              <li key={t.ruleId} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 shrink-0">{TRACE_ICON[t.status]}</span>
                <span className="text-text-primary">
                  <span className="font-semibold">{t.name || 'Untitled rule'}</span> — <span className="text-text-secondary">{t.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
