import { useEffect, useState } from 'react';
import { TriangleAlert as AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { INTERP_META, loadCallTurns, type InterpreterSessionRow, type InterpreterTurn } from '@/lib/interpreter';

const FLAG_TEXT: Record<string, string> = {
  critical_mismatch: 'A number or time may have changed in translation — verify it',
  retried_critical: 'Re-translated to protect a number or time',
  glossary_miss: 'Trade term may be imprecise',
  asr_medium: 'Speech was hard to hear',
  emergency: 'Emergency words detected',
  safety_relevant: 'Safety instruction',
  translation_failed: 'Not translated',
};

function Row({ t }: { t: InterpreterTurn }) {
  const from = INTERP_META[t.from_lang];
  const flags = t.flags.filter((f) => FLAG_TEXT[f]);
  return (
    <li className="grid gap-2 border-b border-border py-3 sm:grid-cols-2" data-testid="bilingual-turn">
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t.speaker === 'caller' ? 'Caller' : 'Team'} · {from.name}</p>
        <p lang={t.from_lang} dir={from.dir} className="text-sm text-text-primary">{t.original}</p>
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">English</p>
        <p className="text-sm text-text-primary">{t.translated ?? <span className="text-text-secondary">Not translated</span>}</p>
        {(flags.length > 0 || t.emergency.length > 0) && (
          <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-warning-500">
            <AlertTriangle size={11} aria-hidden />
            {[...flags.map((f) => FLAG_TEXT[f]), ...(t.emergency.length && !flags.includes('emergency') ? [FLAG_TEXT.emergency] : [])].join(' · ')}
          </p>
        )}
      </div>
    </li>
  );
}

/** Original | English transcript for an interpreted call. Renders nothing if the call was not interpreted. */
export function BilingualTranscript({ callId }: { callId: string }) {
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [data, setData] = useState<{ session: InterpreterSessionRow | null; turns: InterpreterTurn[] }>({ session: null, turns: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState('loading');
    loadCallTurns(callId).then((d) => { if (alive) { setData(d); setState('ready'); } }).catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [callId, attempt]);

  if (state === 'loading') return <div className="space-y-2" aria-busy="true"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>;
  if (state === 'error') {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-text-secondary">
        Couldn’t load the translated transcript.
        <Button size="xs" variant="secondary" onClick={() => setAttempt((n) => n + 1)}><RefreshCw size={12} /> Retry</Button>
      </div>
    );
  }
  if (!data.session || data.turns.length === 0) return null;
  return (
    <section aria-label="Bilingual transcript">
      <p className="mb-2 text-xs text-text-secondary">
        Interpreted by AI ({INTERP_META[data.session.caller_language].name} ⇄ English). The original wording is kept on the left; confirm critical details with the customer.
        {data.session.degraded && ' Live interpretation fell back to captions during this call.'}
      </p>
      <ul>{data.turns.map((t) => <Row key={t.id} t={t} />)}</ul>
    </section>
  );
}
