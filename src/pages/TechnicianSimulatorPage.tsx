/**
 * AI Technician Simulator - /dashboard/technician-simulator
 *
 * Lobby -> Workbench (safety, customer questions, measurements, diagnosis) -> Result.
 * The hidden scenario truth never reaches this page until the attempt is
 * submitted; scoring is deterministic and server-side (see
 * supabase/functions/technician-simulator).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Award, BadgeCheck, CheckCircle2, Clock, FlaskConical, Fingerprint, HardHat, MessageCircle,
  Play, Ruler, ShieldAlert, Stethoscope, TriangleAlert as AlertTriangle, XCircle, Zap,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyStateInline } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  SIM_DECISION_META, SIM_DIFFICULTIES, SIM_DIFFICULTY_META, SIM_PASS_MARK, SIM_QUESTION_MAX_CHARS,
  SIM_REASONING_MAX_CHARS, SIM_SCORE_LABELS, SIM_SCORE_MAX, SIM_TRADES, SIM_TRADE_META,
  abandonSimulation, acknowledgeSafety, askCustomerFreeText, askCustomerTopic, fetchActiveAttempt,
  fetchAttemptHistory, formatClock, remainingSeconds, startSimulation, submitDiagnosis, takeMeasurement,
  type SimAttempt, type SimDecision, type SimDifficulty, type SimResult, type SimTrade,
} from '@/lib/technicianSimulator';

interface Reading { text: string; blocked?: boolean }
interface QaEntry { key: string; question: string; answer: string }

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// ============================================================
// LOBBY
// ============================================================

function Lobby({
  history, starting, presetTrade, sourceJobId, onStart,
}: {
  history: SimAttempt[];
  starting: boolean;
  presetTrade: SimTrade | null;
  sourceJobId: string | null;
  onStart: (trade: SimTrade | null, difficulty: SimDifficulty | null) => void;
}) {
  const [trade, setTrade] = useState<SimTrade | null>(presetTrade);
  const [difficulty, setDifficulty] = useState<SimDifficulty | null>(null);

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FlaskConical size={20} />
          </span>
          <div>
            <h2 className="text-lg font-bold text-text-primary">Run a new scenario</h2>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              A fresh AI-built service call every time. Ask the customer, stay safe, choose your measurements, then commit to a
              diagnosis. Scoring is a fixed rubric, so results are fair and auditable. Pass mark: {SIM_PASS_MARK}, the right root
              cause and zero safety violations.
            </p>
            {sourceJobId && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
                <Stethoscope size={12} /> Based on a real job (customer details are never used)
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">Trade</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip active={trade === null} onClick={() => setTrade(null)}>Adaptive</Chip>
              {SIM_TRADES.map((t) => (
                <Chip key={t} active={trade === t} onClick={() => setTrade(t)}>{SIM_TRADE_META[t].label}</Chip>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">Difficulty</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip active={difficulty === null} onClick={() => setDifficulty(null)}>Adaptive</Chip>
              {SIM_DIFFICULTIES.map((d) => (
                <Chip key={d} active={difficulty === d} onClick={() => setDifficulty(d)}>{SIM_DIFFICULTY_META[d].label}</Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-text-secondary">
              {difficulty ? SIM_DIFFICULTY_META[difficulty].blurb : 'Adaptive picks the trade you have practised least and steps up as you pass.'}
            </p>
          </fieldset>
        </div>

        <div className="mt-6">
          <Button onClick={() => onStart(trade, difficulty)} disabled={starting}>
            <Play size={16} />
            {starting ? 'Building your scenario...' : 'Start simulation'}
          </Button>
          {starting && <p className="mt-2 text-xs text-text-secondary">This can take up to 30 seconds while the AI builds a unique case.</p>}
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Award size={17} className="text-accent" /> Your recent results
        </h2>
        {history.length === 0 ? (
          <EmptyStateInline className="mt-3" text="Your completed simulations will appear here." />
        ) : (
          <ul className="mt-3 divide-y divide-border/60">
            {history.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-primary">{a.brief.title}</p>
                  <p className="text-xs text-text-secondary">
                    {SIM_TRADE_META[a.trade].label} - {SIM_DIFFICULTY_META[a.difficulty].label} -{' '}
                    {a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : ''}
                  </p>
                </div>
                <span className="flex flex-shrink-0 items-center gap-2">
                  <span className="text-base font-bold text-text-primary">{a.score ?? '-'}</span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      a.passed ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'
                    }`}
                  >
                    {a.passed ? 'Passed' : 'Not passed'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-text-secondary">
          Passing results build your simulator certification, shown in the{' '}
          <Link to="/dashboard/trust-passport" className="font-medium text-accent hover:underline">Trust Passport</Link>. It is always labelled
          as simulator-verified and never mixed with real-job metrics.
        </p>
      </Card>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`focus-ring rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40'
      }`}
    >
      {children}
    </button>
  );
}

// ============================================================
// WORKBENCH
// ============================================================

function Workbench({
  attempt, onSubmitted, onAbandoned,
}: {
  attempt: SimAttempt;
  onSubmitted: (r: SimResult) => void;
  onAbandoned: () => void;
}) {
  const { toast } = useToast();
  const brief = attempt.brief;

  const [seconds, setSeconds] = useState(() => remainingSeconds(attempt.expires_at));
  const [ackedIds, setAckedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const e of attempt.events) if (e.type === 'safety_ack') e.ids.forEach((id) => s.add(id));
    return s;
  });
  const [pendingSafety, setPendingSafety] = useState<Set<string>>(new Set());
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const [answeredFacts, setAnsweredFacts] = useState<Record<string, string>>({});
  const [qa, setQa] = useState<QaEntry[]>([]);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const [causeId, setCauseId] = useState('');
  const [partIds, setPartIds] = useState<Set<string>>(new Set());
  const [decision, setDecision] = useState<SimDecision | ''>('');
  const [confidence, setConfidence] = useState(3);
  const [reasoning, setReasoning] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  // Countdown.
  useEffect(() => {
    const id = window.setInterval(() => setSeconds(remainingSeconds(attempt.expires_at)), 1000);
    return () => window.clearInterval(id);
  }, [attempt.expires_at]);
  const expired = seconds <= 0;

  // Restore the "notebook" on resume: replays are deterministic, free and never re-logged (repeat: true).
  useEffect(() => {
    let cancelled = false;
    const measured = attempt.events.filter((e): e is Extract<typeof e, { type: 'measurement' }> => e.type === 'measurement').map((e) => e.id);
    const factIds = [...new Set(attempt.events.flatMap((e) => (e.type === 'question' ? e.fact_ids : [])))];
    if (measured.length === 0 && factIds.length === 0) return;
    void Promise.allSettled([
      ...measured.map((id) => takeMeasurement(attempt.id, id).then((r) => ({ kind: 'm' as const, id, r }))),
      ...factIds.map((id) => askCustomerTopic(attempt.id, id).then((r) => ({ kind: 'f' as const, id, r }))),
    ]).then((results) => {
      if (cancelled) return;
      const nextReadings: Record<string, Reading> = {};
      const nextFacts: Record<string, string> = {};
      for (const res of results) {
        if (res.status !== 'fulfilled') continue;
        if (res.value.kind === 'm' && res.value.r.reading) nextReadings[res.value.id] = { text: res.value.r.reading };
        if (res.value.kind === 'f') nextFacts[res.value.id] = res.value.r.answer;
      }
      setReadings((prev) => ({ ...nextReadings, ...prev }));
      setAnsweredFacts((prev) => ({ ...nextFacts, ...prev }));
    });
    return () => { cancelled = true; };
    // Run once per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt.id]);

  const toggleSafety = (id: string) => {
    if (ackedIds.has(id)) return;
    setPendingSafety((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const confirmSafety = async () => {
    if (pendingSafety.size === 0) return;
    setBusy('safety');
    try {
      const res = await acknowledgeSafety(attempt.id, [...pendingSafety]);
      setAckedIds(new Set(res.acknowledged));
      setPendingSafety(new Set());
    } catch (e) {
      toast(errMessage(e, 'Could not record safety checks.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const measure = async (id: string) => {
    setBusy(`m:${id}`);
    try {
      const res = await takeMeasurement(attempt.id, id);
      if (res.blocked) {
        toast(res.message ?? 'Safety stop.', 'error');
        setReadings((prev) => ({ ...prev, [id]: { text: res.message ?? 'Blocked by safety gate.', blocked: true } }));
      } else if (res.reading) {
        setReadings((prev) => ({ ...prev, [id]: { text: res.reading as string } }));
      }
    } catch (e) {
      toast(errMessage(e, 'Could not take that measurement.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const askTopic = async (factId: string, topic: string) => {
    if (answeredFacts[factId] !== undefined) return;
    setBusy(`f:${factId}`);
    try {
      const res = await askCustomerTopic(attempt.id, factId);
      setAnsweredFacts((prev) => ({ ...prev, [factId]: res.answer }));
      setQa((prev) => [...prev, { key: `t-${factId}`, question: topic, answer: res.answer }]);
    } catch (e) {
      toast(errMessage(e, 'Could not ask the customer.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const askFree = async () => {
    const q = freeText.trim();
    if (q.length < 4) return;
    setBusy('free');
    try {
      const res = await askCustomerFreeText(attempt.id, q);
      setQa((prev) => [...prev, { key: `q-${prev.length}-${Date.now()}`, question: q, answer: res.answer }]);
      setAnsweredFacts((prev) => {
        const next = { ...prev };
        for (const id of res.fact_ids) next[id] = next[id] ?? res.answer;
        return next;
      });
      setFreeText('');
    } catch (e) {
      toast(errMessage(e, 'Could not ask the customer.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const togglePart = (id: string) =>
    setPartIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const canSubmit = !!causeId && !!decision && !submitting && !expired;

  const submit = async () => {
    if (!canSubmit || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      const result = await submitDiagnosis({
        attemptId: attempt.id, causeId, partIds: [...partIds], decision: decision as SimDecision, confidence, reasoning,
      });
      onSubmitted(result);
    } catch (e) {
      submittedRef.current = false;
      toast(errMessage(e, 'Could not submit your diagnosis.'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const abandon = async () => {
    if (!window.confirm('Abandon this scenario? It will not count towards your results.')) return;
    try {
      await abandonSimulation(attempt.id);
      onAbandoned();
    } catch (e) {
      toast(errMessage(e, 'Could not close the scenario.'), 'error');
    }
  };

  const totalMinutes = useMemo(
    () => brief.measurement_options.filter((m) => readings[m.id] && !readings[m.id].blocked).reduce((s, m) => s + m.minutes, 0),
    [brief.measurement_options, readings],
  );

  return (
    <div className="space-y-6">
      {/* Brief + timer */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">
              {SIM_TRADE_META[brief.trade].label} - {SIM_DIFFICULTY_META[brief.difficulty].label}
            </p>
            <h2 className="mt-1 text-lg font-bold text-text-primary">{brief.title}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {brief.equipment.type} - {brief.equipment.make} {brief.equipment.model}
              {brief.equipment.age_years !== null ? ` - ${brief.equipment.age_years} yrs old` : ''}
            </p>
          </div>
          <span
            role="timer"
            aria-live="off"
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${
              seconds < 300 ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-primary'
            }`}
          >
            <Clock size={14} /> {formatClock(seconds)}
          </span>
        </div>
        <blockquote className="mt-4 rounded-xl border-l-4 border-accent bg-bg-tertiary/60 p-4 text-sm leading-relaxed text-text-primary">
          "{brief.customer_complaint}"
        </blockquote>
        {brief.environment && <p className="mt-3 text-xs text-text-secondary">On site: {brief.environment}</p>}
        {expired && (
          <p className="mt-3 rounded-lg bg-danger/10 p-3 text-sm text-danger">
            Time is up. This scenario has expired; start a new one from the lobby.
          </p>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Safety */}
        <Card className="p-6">
          <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <HardHat size={17} className="text-accent" /> 1. Safety checks
          </h3>
          <p className="mt-1 text-xs text-text-secondary">
            Tick everything you would do before touching the system, then confirm. Tests on live or pressurized systems are blocked until
            every required check is done.
          </p>
          <ul className="mt-3 space-y-2">
            {brief.safety_checks.map((s) => {
              const done = ackedIds.has(s.id);
              const checked = done || pendingSafety.has(s.id);
              return (
                <li key={s.id}>
                  <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm ${done ? 'border-success-500/40 bg-success-500/5' : 'border-border'}`}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
                      checked={checked}
                      disabled={done || expired}
                      onChange={() => toggleSafety(s.id)}
                    />
                    <span className="text-text-primary">{s.label}</span>
                    {done && <CheckCircle2 size={15} className="ml-auto flex-shrink-0 text-success-500" />}
                  </label>
                </li>
              );
            })}
          </ul>
          <Button className="mt-3" size="sm" variant="secondary" onClick={confirmSafety} disabled={pendingSafety.size === 0 || busy === 'safety' || expired}>
            <ShieldAlert size={15} /> {busy === 'safety' ? 'Saving...' : 'Confirm safety checks'}
          </Button>
        </Card>

        {/* Customer */}
        <Card className="p-6">
          <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <MessageCircle size={17} className="text-accent" /> 2. Ask the customer
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {brief.question_topics.map((q) => {
              const answered = answeredFacts[q.id] !== undefined;
              return (
                <button
                  key={q.id}
                  type="button"
                  disabled={answered || busy === `f:${q.id}` || expired}
                  onClick={() => askTopic(q.id, q.topic)}
                  className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                    answered ? 'border-success-500/40 bg-success-500/5 text-success-500' : 'border-border text-text-secondary hover:border-accent/40'
                  }`}
                >
                  {q.topic}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <Input
              aria-label="Ask the customer your own question"
              placeholder="Or ask your own question..."
              value={freeText}
              maxLength={SIM_QUESTION_MAX_CHARS}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void askFree(); }}
              disabled={expired}
            />
            <Button size="sm" variant="secondary" onClick={askFree} disabled={busy === 'free' || freeText.trim().length < 4 || expired}>
              Ask
            </Button>
          </div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto" aria-live="polite">
            {qa.length === 0 && Object.keys(answeredFacts).length === 0 && (
              <EmptyStateInline text="Answers from the customer will appear here." />
            )}
            {Object.keys(answeredFacts).length > 0 && qa.length === 0 && (
              <ul className="space-y-2">
                {brief.question_topics.filter((q) => answeredFacts[q.id] !== undefined).map((q) => (
                  <li key={q.id} className="rounded-lg bg-bg-tertiary/60 p-2.5 text-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{q.topic}</p>
                    <p className="text-text-primary">{answeredFacts[q.id]}</p>
                  </li>
                ))}
              </ul>
            )}
            {qa.map((entry) => (
              <div key={entry.key} className="rounded-lg bg-bg-tertiary/60 p-2.5 text-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">You: {entry.question}</p>
                <p className="text-text-primary">{entry.answer}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Measurements */}
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <Ruler size={17} className="text-accent" /> 3. Take measurements
          </h3>
          <span className="text-xs text-text-secondary">Time spent on tests: {totalMinutes} min - be efficient, every test costs time</span>
        </div>
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {brief.measurement_options.map((m) => {
            const r = readings[m.id];
            return (
              <li key={m.id} className={`rounded-xl border p-3 ${r?.blocked ? 'border-danger/40 bg-danger/5' : r ? 'border-accent/30 bg-accent/5' : 'border-border'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{m.label}</p>
                    <p className="text-xs text-text-secondary">{m.tool} - {m.location} - ~{m.minutes} min</p>
                  </div>
                  {m.intrusive && (
                    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-semibold text-warning-500">
                      <Zap size={11} /> Live work
                    </span>
                  )}
                </div>
                {r && !r.blocked ? (
                  <p className="mt-2 rounded-lg bg-bg-primary px-3 py-2 text-sm font-semibold text-text-primary">{r.text}</p>
                ) : r?.blocked ? (
                  <p className="mt-2 text-xs text-danger">{r.text}</p>
                ) : (
                  <Button className="mt-2" size="sm" variant="secondary" disabled={busy === `m:${m.id}` || expired} onClick={() => measure(m.id)}>
                    {busy === `m:${m.id}` ? 'Measuring...' : 'Take reading'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Diagnosis */}
      <Card className="p-6">
        <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Stethoscope size={17} className="text-accent" /> 4. Diagnose and decide
        </h3>

        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">Most likely root cause</legend>
            <div className="mt-2 space-y-2">
              {brief.candidate_causes.map((c) => (
                <label key={c.id} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm ${causeId === c.id ? 'border-accent bg-accent/5' : 'border-border'}`}>
                  <input type="radio" name="cause" className="mt-0.5 accent-[rgb(var(--accent))]" checked={causeId === c.id} onChange={() => setCauseId(c.id)} disabled={expired} />
                  <span className="text-text-primary">{c.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-text-primary">Parts you would use</legend>
            <div className="mt-2 space-y-2">
              {brief.parts_catalog.map((p) => (
                <label key={p.id} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm ${partIds.has(p.id) ? 'border-accent bg-accent/5' : 'border-border'}`}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]" checked={partIds.has(p.id)} onChange={() => togglePart(p.id)} disabled={expired} />
                  <span className="text-text-primary">{p.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-text-primary">Final decision</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {(Object.keys(SIM_DECISION_META) as SimDecision[]).map((d) => (
              <label key={d} className={`cursor-pointer rounded-lg border p-3 text-sm ${decision === d ? 'border-accent bg-accent/5' : 'border-border'}`}>
                <input type="radio" name="decision" className="sr-only" checked={decision === d} onChange={() => setDecision(d)} disabled={expired} />
                <span className="block font-medium text-text-primary">{SIM_DECISION_META[d].label}</span>
                <span className="block text-xs text-text-secondary">{SIM_DECISION_META[d].hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div>
            <label htmlFor="sim-confidence" className="text-sm font-medium text-text-primary">
              How confident are you? <span className="text-text-secondary">({confidence}/5)</span>
            </label>
            <input
              id="sim-confidence" type="range" min={1} max={5} step={1} value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="mt-2 w-full accent-[rgb(var(--accent))]" disabled={expired}
            />
            <p className="text-xs text-text-secondary">Honest confidence earns points; overconfidence when wrong costs them.</p>
          </div>
          <Textarea
            label="Your reasoning (optional, used for coaching only)"
            rows={3}
            maxLength={SIM_REASONING_MAX_CHARS}
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            disabled={expired}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={!canSubmit}>
            <BadgeCheck size={16} /> {submitting ? 'Scoring...' : 'Submit diagnosis'}
          </Button>
          <Button variant="ghost" onClick={abandon} disabled={submitting}>Abandon scenario</Button>
          {!causeId || !decision ? <span className="text-xs text-text-secondary">Choose a root cause and a decision to submit.</span> : null}
        </div>
      </Card>
    </div>
  );
}

// ============================================================
// RESULT
// ============================================================

function ResultView({ result, onNew }: { result: SimResult; onNew: () => void }) {
  const r = result;
  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className={`flex h-20 w-20 items-center justify-center rounded-2xl text-3xl font-extrabold ${r.passed ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>
              {r.score}
            </span>
            <div>
              <p className={`inline-flex items-center gap-1.5 text-lg font-bold ${r.passed ? 'text-success-500' : 'text-danger'}`}>
                {r.passed ? <CheckCircle2 size={20} /> : <XCircle size={20} />} {r.passed ? 'Passed' : 'Not passed'}
              </p>
              <p className="text-sm text-text-secondary">Pass requires {SIM_PASS_MARK}+, the correct root cause and zero safety violations.</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={onNew}><Play size={16} /> New scenario</Button>
            <Link to="/dashboard/trust-passport" className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40">
              <Fingerprint size={15} /> Trust Passport
            </Link>
          </div>
        </div>
        {r.flags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {r.flags.map((f) => (
              <span key={f} className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2.5 py-1 text-xs font-medium text-warning-500">
                <AlertTriangle size={12} /> {FLAG_LABELS[f] ?? f}
              </span>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h3 className="text-base font-semibold text-text-primary">Score breakdown</h3>
          <ul className="mt-4 space-y-3">
            {(Object.keys(SIM_SCORE_MAX) as (keyof typeof SIM_SCORE_MAX)[]).map((k) => {
              const pct = Math.round((r.breakdown[k] / SIM_SCORE_MAX[k]) * 100);
              return (
                <li key={k}>
                  <div className="flex justify-between text-sm">
                    <span className="text-text-primary">{SIM_SCORE_LABELS[k]}</span>
                    <span className="font-semibold text-text-primary">{r.breakdown[k]} / {SIM_SCORE_MAX[k]}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary">
                    <div className={`h-full rounded-full ${pct >= 70 ? 'bg-success-500' : pct >= 40 ? 'bg-warning-500' : 'bg-danger'}`} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="p-6">
          <h3 className="text-base font-semibold text-text-primary">Coaching</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-primary">{r.coaching.summary}</p>
          {r.coaching.strengths.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {r.coaching.strengths.map((s) => (
                <li key={s} className="flex items-start gap-2 text-sm text-text-primary"><CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-success-500" />{s}</li>
              ))}
            </ul>
          )}
          {r.coaching.improvements.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {r.coaching.improvements.map((s) => (
                <li key={s} className="flex items-start gap-2 text-sm text-text-primary"><AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-warning-500" />{s}</li>
              ))}
            </ul>
          )}
          {r.coaching.next_focus && (
            <p className="mt-3 rounded-lg bg-accent/10 p-3 text-sm text-accent"><span className="font-semibold">Next focus:</span> {r.coaching.next_focus}</p>
          )}
        </Card>
      </div>

      <Card className="p-6">
        <h3 className="text-base font-semibold text-text-primary">What was really wrong</h3>
        <p className="mt-2 text-sm text-text-primary">
          <span className="font-semibold">Root cause:</span> {r.reveal.root_cause}
        </p>
        {!r.diagnosis_correct && (
          <p className="mt-1 text-sm text-text-secondary">You chose: {r.reveal.chosen_cause}</p>
        )}
        <p className="mt-2 text-sm text-text-secondary">
          Correct decision: <span className="font-medium text-text-primary">{SIM_DECISION_META[r.reveal.correct_decision].label}</span>
          {r.reveal.decision_rationale ? ` - ${r.reveal.decision_rationale}` : ''}
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <RevealList title="Decisive tests" items={r.reveal.decisive_tests.map((t) => ({ text: `${t.label}: ${t.reading}`, ok: t.taken }))} okLabel="You ran this" missLabel="You skipped this" />
          <RevealList title="Correct parts" items={r.reveal.correct_parts.map((p) => ({ text: p.label, ok: p.chosen }))} okLabel="You chose this" missLabel="You missed this" />
        </div>
        {r.reveal.wrong_parts_chosen.length > 0 && (
          <p className="mt-3 text-sm text-danger">Unnecessary parts chosen: {r.reveal.wrong_parts_chosen.join(', ')}</p>
        )}
        {r.reveal.missed_critical_questions.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-medium text-text-primary">Critical customer details you never asked about</p>
            <ul className="mt-1 space-y-1 text-sm text-text-secondary">
              {r.reveal.missed_critical_questions.map((q) => (<li key={q.topic}><span className="font-medium text-text-primary">{q.topic}:</span> {q.answer}</li>))}
            </ul>
          </div>
        )}
        {r.reveal.missed_safety.length > 0 && (
          <p className="mt-3 text-sm text-danger">Required safety checks missed: {r.reveal.missed_safety.join('; ')}</p>
        )}
      </Card>
    </div>
  );
}

const FLAG_LABELS: Record<string, string> = {
  unverified_diagnosis: 'Right answer, but never confirmed with a decisive test',
  safety_violation: 'Safety violation logged',
  missing_safety_checks: 'Required safety checks missing',
  no_measurements: 'No measurements taken',
  over_time: 'Took much longer than a typical technician',
  overconfident: 'Overconfident for the result',
};

function RevealList({ title, items, okLabel, missLabel }: { title: string; items: { text: string; ok: boolean }[]; okLabel: string; missLabel: string }) {
  return (
    <div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {items.length === 0 ? (
        <EmptyStateInline className="mt-1" text="None for this scenario." />
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((i) => (
            <li key={i.text} className="flex items-start gap-2 text-sm text-text-secondary">
              {i.ok ? <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-success-500" aria-label={okLabel} /> : <XCircle size={15} className="mt-0.5 flex-shrink-0 text-danger" aria-label={missLabel} />}
              <span>{i.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function TechnicianSimulatorPage() {
  const { toast } = useToast();
  const [params] = useSearchParams();
  const presetTradeParam = params.get('trade');
  const presetTrade = (SIM_TRADES as string[]).includes(presetTradeParam ?? '') ? (presetTradeParam as SimTrade) : null;
  const sourceJobId = params.get('jobId');

  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [attempt, setAttempt] = useState<SimAttempt | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);
  const [history, setHistory] = useState<SimAttempt[]>([]);

  const load = useCallback(async () => {
    try {
      const [active, past] = await Promise.all([fetchActiveAttempt(), fetchAttemptHistory(15)]);
      setAttempt(active);
      setHistory(past);
    } catch (e) {
      toast(errMessage(e, 'Could not load the simulator.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const start = async (trade: SimTrade | null, difficulty: SimDifficulty | null) => {
    setStarting(true);
    try {
      const res = await startSimulation({ trade, difficulty, sourceJobId });
      setResult(null);
      setAttempt(res.attempt);
      if (res.resumed) toast('Resumed your unfinished scenario.', 'success');
    } catch (e) {
      toast(errMessage(e, 'Could not start the simulation.'), 'error');
    } finally {
      setStarting(false);
    }
  };

  const backToLobby = () => {
    setResult(null);
    setAttempt(null);
    void load();
  };

  return (
    <DashboardLayout activeLabel="Technician Simulator">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <FlaskConical size={24} className="text-accent" /> AI Technician Simulator
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Practise real diagnostics on AI-built service calls. Passing results become simulator-verified skills in your Trust Passport.
        </p>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : (
        <FadeIn>
          {result ? (
            <ResultView result={result} onNew={backToLobby} />
          ) : attempt ? (
            <Workbench key={attempt.id} attempt={attempt} onSubmitted={(r) => setResult(r)} onAbandoned={backToLobby} />
          ) : (
            <Lobby history={history} starting={starting} presetTrade={presetTrade} sourceJobId={sourceJobId} onStart={start} />
          )}
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
