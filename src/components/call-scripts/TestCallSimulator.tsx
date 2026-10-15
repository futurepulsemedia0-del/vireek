import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Send, Loader2, Bot, User, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  scenarioLabel,
  simulateTurn,
  validateScriptDraft,
  SimulatorError,
  type ScenarioKey,
  type SimulatorTurn,
} from '@/lib/callScripts';

const MAX_TURNS = 24;
const MAX_CALLER_CHARS = 600;

const CALLER_STARTERS: Record<ScenarioKey, string[]> = {
  emergency: ['Water is pouring out of my ceiling right now!', 'I smell gas in my kitchen.', 'My furnace died and it is freezing in here.'],
  after_hours: ['Hi, I know it is late — can someone come look at my AC tomorrow?', 'Are you guys open? My water heater is leaking a little.'],
  new_inquiry: ['Hi, my AC is blowing warm air. Can you come out?', 'I need someone to look at a clogged kitchen drain.'],
  price_quote: ['How much do you charge to replace a water heater?', 'Can you give me a ballpark for a new AC unit?'],
  reschedule_cancel: ['I need to move my appointment to Friday.', 'I want to cancel my visit tomorrow.'],
  existing_customer: ['You fixed my furnace last month and it is making a noise again.', 'I got an invoice and have a question about it.'],
  complaint: ['The technician left a mess and I am really upset.', 'Your price was way higher than what I was told.'],
};

interface TestCallSimulatorProps {
  scenario: ScenarioKey;
  opening_line: string;
  body: string;
  /** Short label such as "unsaved draft" or "saved v3" so the owner knows what is being tested. */
  sourceLabel: string;
}

export function TestCallSimulator({ scenario, opening_line, body, sourceLabel }: TestCallSimulatorProps) {
  const [turns, setTurns] = useState<SimulatorTurn[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const requestRef = useRef(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  const check = validateScriptDraft({ scenario, opening_line, body });
  const atLimit = turns.length >= MAX_TURNS - 1;

  const reset = useCallback(() => {
    requestRef.current += 1; // invalidate any in-flight reply
    setTurns([]);
    setInput('');
    setError(null);
    setPending(false);
    setLastLatency(null);
  }, []);

  // A different scenario is a different call.
  useEffect(() => {
    reset();
  }, [scenario, reset]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, pending]);

  const run = useCallback(
    async (history: SimulatorTurn[]) => {
      const id = ++requestRef.current;
      setPending(true);
      setError(null);
      try {
        const res = await simulateTurn({ scenario, opening_line, body, turns: history });
        if (id !== requestRef.current) return;
        setTurns([...history, { role: 'assistant', content: res.reply }]);
        setLastLatency(res.latencyMs);
      } catch (e) {
        if (id !== requestRef.current) return;
        setError(e instanceof SimulatorError ? e.message : 'The simulator could not answer right now. Please try again.');
      } finally {
        if (id === requestRef.current) setPending(false);
      }
    },
    [scenario, opening_line, body],
  );

  const send = (text: string) => {
    const content = text.trim().slice(0, MAX_CALLER_CHARS);
    if (!content || pending || !check.ok || atLimit) return;
    const opening = opening_line.trim();
    const base: SimulatorTurn[] =
      turns.length === 0 && opening ? [{ role: 'assistant', content: opening }] : turns;
    const next: SimulatorTurn[] = [...base, { role: 'caller', content }];
    setTurns(next);
    setInput('');
    void run(next);
  };

  const retry = () => {
    if (pending || turns.length === 0 || turns[turns.length - 1].role !== 'caller') return;
    void run(turns);
  };

  const opening = opening_line.trim();
  const shown: SimulatorTurn[] = turns.length === 0 && opening ? [{ role: 'assistant', content: opening }] : turns;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary">
          You play the caller. Testing <span className="font-medium text-text-primary">{sourceLabel}</span> for{' '}
          {scenarioLabel(scenario).toLowerCase()} calls. Nothing is booked, sent, or saved.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={turns.length === 0 && !error}>
          <RotateCcw size={15} />
          New test call
        </Button>
      </div>

      {!check.ok && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
          <span>Fix the script in the Editor tab first: {Object.values(check.errors)[0]}</span>
        </div>
      )}

      <div
        className="max-h-[420px] min-h-[220px] space-y-3 overflow-y-auto rounded-2xl border border-border bg-bg-primary p-4"
        role="log"
        aria-live="polite"
        aria-label="Test call conversation"
      >
        {shown.length === 0 ? (
          <div className="flex h-[188px] flex-col items-center justify-center text-center">
            <Bot size={22} className="text-text-secondary" />
            <p className="mt-2 text-sm text-text-secondary">Pick a caller line below or type your own to start the call.</p>
          </div>
        ) : (
          shown.map((t, i) => (
            <div key={i} className={`flex gap-2 ${t.role === 'caller' ? 'justify-end' : 'justify-start'}`}>
              {t.role === 'assistant' && (
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <Bot size={14} />
                </span>
              )}
              <p
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  t.role === 'caller' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-primary'
                }`}
              >
                <span className="sr-only">{t.role === 'caller' ? 'Caller: ' : 'Assistant: '}</span>
                {t.content}
              </p>
              {t.role === 'caller' && (
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                  <User size={14} />
                </span>
              )}
            </div>
          ))
        )}
        {pending && (
          <div className="flex items-center gap-2 text-xs text-text-secondary" aria-live="polite">
            <Loader2 size={14} className="animate-spin" /> Assistant is replying…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="text-text-primary">{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={retry} disabled={pending}>
            Try again
          </Button>
        </div>
      )}

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {CALLER_STARTERS[scenario].map((line) => (
            <button
              key={line}
              type="button"
              onClick={() => send(line)}
              disabled={!check.ok || pending}
              className="focus-ring rounded-full border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary disabled:opacity-50"
            >
              {line}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            aria-label="Caller message"
            value={input}
            maxLength={MAX_CALLER_CHARS}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            disabled={!check.ok || atLimit}
            placeholder={atLimit ? 'Call limit reached — start a new test call' : 'Type what the caller says…'}
          />
        </div>
        <Button type="button" onClick={() => send(input)} disabled={!input.trim() || pending || !check.ok || atLimit} aria-label="Send caller message">
          <Send size={16} />
        </Button>
      </div>
      {lastLatency !== null && (
        <p className="text-xs text-text-secondary">Last reply took {(lastLatency / 1000).toFixed(1)}s. Live calls use your real voice model, so wording may differ slightly.</p>
      )}
    </div>
  );
}
