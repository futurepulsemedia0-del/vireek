import { Phone, RotateCcw, Undo2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MENU_KEYS, nodeById, type CallFlowConfig, type FlowSimInput, type FlowSimResult } from '@/lib/callFlows';

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';

const END_LABELS: Record<string, string> = {
  ai: 'Answered by the AI receptionist',
  member: 'Answered by a team member',
  department: 'Answered by a department',
  phone: 'Answered on an outside number',
  voicemail: 'Caller leaves a voicemail',
  hangup: 'The call ends',
};

interface FlowSimulatorProps {
  config: CallFlowConfig;
  input: FlowSimInput;
  result: FlowSimResult;
  onChange: (input: FlowSimInput) => void;
}

/** A test call you can walk through: press keys on the keypad and watch the path light up on the flow. */
export function FlowSimulator({ config, input, result, onChange }: FlowSimulatorProps) {
  const waiting = result.status === 'awaiting_input';
  const menu = waiting ? nodeById(config, result.awaitingNodeId) : undefined;
  const offered = new Set(menu?.kind === 'menu' ? menu.options.map((o) => o.key as string) : []);
  const press = (key: string) => onChange({ ...input, keys: [...input.keys, key] });

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Phone size={14} /> Test call
          </h2>
          <p className="text-xs text-text-secondary">Try the flow without calling anyone. Nothing here is saved.</p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" aria-label="Undo last key" disabled={input.keys.length === 0} onClick={() => onChange({ ...input, keys: input.keys.slice(0, -1) })}>
            <Undo2 size={14} />
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label="Restart test call" disabled={input.keys.length === 0} onClick={() => onChange({ ...input, keys: [] })}>
            <RotateCcw size={14} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input label="Date" type="date" value={input.at.date} onChange={(e) => e.target.value && onChange({ ...input, at: { ...input.at, date: e.target.value } })} />
        <Input label="Time" type="time" value={input.at.time} onChange={(e) => e.target.value && onChange({ ...input, at: { ...input.at, time: e.target.value } })} />
      </div>
      <div>
        <label htmlFor="flow-sim-ring" className="mb-1.5 block text-sm font-medium text-text-primary">
          When a person is dialed
        </label>
        <select id="flow-sim-ring" className={SELECT_CLASS} value={input.ringOutcome} onChange={(e) => onChange({ ...input, ringOutcome: e.target.value as FlowSimInput['ringOutcome'] })}>
          <option value="answered">They answer</option>
          <option value="no_answer">They don't answer</option>
        </select>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium text-text-primary">{waiting ? `Keypad — ${menu?.name ?? 'menu'} is waiting` : 'Keypad'}</p>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Phone keypad">
          {MENU_KEYS.map((k) => (
            <Button key={k} type="button" size="sm" variant={offered.has(k) ? 'primary' : 'secondary'} disabled={!waiting} onClick={() => press(k)} aria-label={`Press ${k}`}>
              {k}
            </Button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" disabled={!waiting} onClick={() => press('')}>
          Stay silent (no key)
        </Button>
      </div>

      <div aria-live="polite" className="space-y-3">
        {result.status === 'error' && (
          <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
            {result.error}
          </p>
        )}

        {result.steps.length > 0 && (
          <ol className="space-y-1.5" aria-label="Call path">
            {result.steps.map((s, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-[10px] font-semibold text-text-secondary">{i + 1}</span>
                <span className="min-w-0 text-text-secondary">
                  <span className="font-medium text-text-primary">{s.name || 'Untitled step'}</span> — {s.detail}
                </span>
              </li>
            ))}
          </ol>
        )}

        {result.status === 'ended' && result.end && (
          <p className="rounded-xl bg-success-500/10 p-3 text-sm font-semibold text-success-500">
            {END_LABELS[result.end.kind] ?? 'The call ends'}
            {result.end.kind !== 'hangup' && <span className="block text-xs font-normal text-text-secondary">{result.end.label}</span>}
          </p>
        )}
        {waiting && <p className="text-xs text-text-secondary">Press a key above to continue the call.</p>}
      </div>
    </Card>
  );
}
