/**
 * VIREEK Adaptive Diagnostic Network - /dashboard/adaptive-diagnostics
 *
 * Symptom -> best question (highest information gain) -> answer -> re-ranked causes ->
 * diagnosis -> confirmed cause -> repair -> verified outcome -> the model learns from it.
 * All probabilities come from the deterministic engine on the server; this page only
 * renders state and sends answers.
 *
 * Also hosts the "Customer intake learning" panel: measured accuracy and question value for the
 * customer-facing Adaptive Customer Diagnostic (/diagnose/:token).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit,
  Loader2,
  TriangleAlert as AlertTriangle,
  ShieldAlert,
  ChevronRight,
  CircleCheck as CheckCircle2,
  Wrench,
  SkipForward,
  Gauge,
  Sparkles,
  Network,
  RefreshCw,
  History,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/Skeleton';
import { supabase } from '@/lib/supabase';
import {
  ADN_FAMILY_LABELS,
  ADN_SKIP_ANSWER,
  ADN_STATUS_META,
  ADN_STOP_REASON_TEXT,
  ADN_DEFAULT_SETTINGS,
  abandonAdnSession,
  answerAdnStep,
  completeAdnRepair,
  confirmAdnCause,
  fetchAdnCauses,
  fetchAdnSessions,
  fetchAdnSettings,
  fetchAdnState,
  fetchAdnStats,
  fetchAdnSymptoms,
  pct,
  recordAdnOutcome,
  saveAdnSettings,
  startAdnSession,
  sweepAdnVerifications,
  type AdnCause,
  type AdnOutcome,
  type AdnSessionRow,
  type AdnSettings,
  type AdnState,
  type AdnStats,
  type AdnSymptom,
} from '@/lib/adaptiveDiagnostics';
import {
  LEARNING_MIN_SAMPLES,
  TREND_MIN_BUCKET,
  accuracyChange,
  pct as intakePct,
  type LearningSummary,
} from '@/lib/adaptiveDiagnostic';
import { fetchLearningSummary } from '@/lib/adaptiveDiagnosticApi';

interface JobOption {
  id: string;
  customer_name: string;
  customer_id: string | null;
  service_type: string | null;
}
interface EquipmentOption {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
}

const CONFIDENCE_STYLES = {
  high: 'bg-success-500/15 text-success-500',
  moderate: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
} as const;

const inputCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function DifferentialBars({ items }: { items: AdnState['decision']['differential'] }) {
  return (
    <ul className="space-y-2" aria-label="Probable causes">
      {items.slice(0, 6).map((d, i) => (
        <li key={d.cause_key}>
          <div className="flex items-center justify-between text-xs">
            <span
              className={`flex items-center gap-1 font-medium ${i === 0 ? 'text-text-primary' : 'text-text-secondary'}`}
            >
              {d.safety_critical && <ShieldAlert size={12} className="text-danger-500" />}
              {d.label}
            </span>
            <span className="tabular-nums text-text-secondary">{pct(d.probability)}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
            <div
              className={`h-full rounded-full transition-all duration-500 ${d.safety_critical ? 'bg-danger-500' : i === 0 ? 'bg-accent' : 'bg-text-secondary/40'}`}
              style={{ width: `${Math.max(d.probability * 100, 1)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Measured learning of the customer-facing intake diagnostic. Renders nothing until the
 * customer-intake migration is applied and at least one outcome exists, so it never shows
 * invented numbers or an error to the user.
 */
function CustomerIntakeLearning() {
  const [data, setData] = useState<LearningSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLearningSummary()
      .then((s) => {
        if (!cancelled) setData(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || (data.confirmed === 0 && data.awaiting_outcome === 0 && data.unmapped === 0)) {
    return null;
  }
  const change = accuracyChange(data.trend);

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <BrainCircuit size={15} className="text-accent" /> Customer intake learning
      </h2>
      <p className="mb-4 text-xs text-text-secondary">
        Measured from confirmed jobs: how well the customer-facing questions predict the real cause.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Confirmed" value={String(data.confirmed)} />
        <StatTile label="Top-1 accuracy" value={intakePct(data.accuracy)} />
        <StatTile label="Awaiting outcome" value={String(data.awaiting_outcome)} />
        <StatTile label="Needs review" value={String(data.unmapped)} />
      </div>

      {data.trend.length > 0 && (
        <div className="mt-4">
          <div
            className="flex h-24 items-end gap-2"
            role="img"
            aria-label="Intake diagnosis accuracy per group of ten confirmed jobs"
          >
            {data.trend.map((b) => (
              <div key={b.bucket} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-full w-full items-end">
                  <div
                    className={`w-full rounded-t-md ${b.n >= TREND_MIN_BUCKET ? 'bg-accent' : 'bg-accent/30'}`}
                    style={{ height: `${Math.max(4, Math.round(b.accuracy * 100))}%` }}
                    title={`${intakePct(b.accuracy)} over ${b.n} jobs, ${b.avg_questions} questions on average`}
                  />
                </div>
                <span className="text-[10px] tabular-nums text-text-secondary">
                  {intakePct(b.accuracy)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-text-secondary">
            Each bar is ten confirmed jobs in order.{' '}
            {change
              ? `Accuracy moved ${change.deltaPp >= 0 ? '+' : ''}${change.deltaPp} points from the first group to the latest.`
              : 'A trend appears once two groups have at least five jobs each.'}
          </p>
        </div>
      )}

      {data.questions.length > 0 && (
        <ul className="mt-4 divide-y divide-border">
          {data.questions.slice(0, 8).map((q) => (
            <li key={q.code} className="flex items-center justify-between gap-3 py-2 text-xs">
              <span className="text-text-primary">{q.text}</span>
              <span className="shrink-0 tabular-nums text-text-secondary">
                {q.asked_n < LEARNING_MIN_SAMPLES || q.avg_gain_pp == null
                  ? `Learning (${q.asked_n}/${LEARNING_MIN_SAMPLES})`
                  : `${q.avg_gain_pp >= 0 ? '+' : ''}${q.avg_gain_pp} pts · ${q.asked_n} jobs`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdaptiveDiagnosticsPage() {
  const { user, isOwner } = useAuth();
  const { toast } = useToast();

  const [symptoms, setSymptoms] = useState<AdnSymptom[]>([]);
  const [causes, setCauses] = useState<Record<string, AdnCause>>({});
  const [stats, setStats] = useState<AdnStats | null>(null);
  const [sessions, setSessions] = useState<AdnSessionRow[]>([]);
  const [settings, setSettings] = useState<AdnSettings>(ADN_DEFAULT_SETTINGS);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);

  const [symptomKey, setSymptomKey] = useState('');
  const [jobId, setJobId] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');

  const [state, setState] = useState<AdnState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [confirmKey, setConfirmKey] = useState('');
  const [repairNotes, setRepairNotes] = useState('');
  const [correctedKey, setCorrectedKey] = useState('');

  const refreshLists = useCallback(async () => {
    const [st, ss] = await Promise.allSettled([fetchAdnStats(), fetchAdnSessions(30)]);
    if (st.status === 'fulfilled') setStats(st.value);
    if (ss.status === 'fulfilled') setSessions(ss.value);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sy, ca, se] = await Promise.all([
          fetchAdnSymptoms(),
          fetchAdnCauses(),
          fetchAdnSettings(),
        ]);
        if (cancelled) return;
        setSymptoms(sy);
        setCauses(ca);
        setSettings(se);
        const swept = await sweepAdnVerifications().catch(() => 0);
        if (swept > 0 && !cancelled)
          toast(
            `${swept} repair${swept === 1 ? '' : 's'} auto-verified - the network learned from them.`,
            'success',
          );
        await refreshLists();
        const { data } = await supabase
          .from('jobs')
          .select('id, customer_name, customer_id, service_type')
          .neq('job_status', 'completed')
          .order('scheduled_datetime', { ascending: false })
          .limit(100);
        if (!cancelled) setJobs((data as JobOption[]) ?? []);
      } catch (err) {
        if (!cancelled)
          toast(
            err instanceof Error ? err.message : 'Could not load the diagnostic network.',
            'error',
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshLists, toast]);

  useEffect(() => {
    setEquipmentId('');
    const job = jobs.find((j) => j.id === jobId);
    if (!job?.customer_id) {
      setEquipment([]);
      return;
    }
    let cancelled = false;
    supabase
      .from('equipment')
      .select('id, equipment_type, make, model')
      .eq('customer_id', job.customer_id)
      .then(({ data }) => {
        if (!cancelled) setEquipment((data as EquipmentOption[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, jobs]);

  const groupedSymptoms = useMemo(() => {
    const g: Record<string, AdnSymptom[]> = {};
    for (const s of symptoms) (g[s.family] ??= []).push(s);
    return g;
  }, [symptoms]);

  const applyState = (s: AdnState) => {
    setState(s);
    setConfirmKey(
      s.session.confirmed_cause_key ??
        s.session.suggested_cause_key ??
        s.decision.differential[0]?.cause_key ??
        '',
    );
    setCorrectedKey('');
    setRepairNotes('');
  };

  const run = async <T,>(fn: () => Promise<T>, errorFallback: string): Promise<T | null> => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : errorFallback, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    if (!symptomKey) {
      toast('Choose the symptom first.', 'error');
      return;
    }
    const s = await run(
      () =>
        startAdnSession({
          symptomKey,
          jobId: jobId || null,
          equipmentId: equipmentId || null,
          make,
          model,
          equipmentLabel: '',
        }),
      'Could not start the diagnostic.',
    );
    if (s) {
      applyState(s);
      refreshLists();
    }
  };

  const onAnswer = async (testKey: string, answerKey: string) => {
    if (!state) return;
    const s = await run(
      () => answerAdnStep(state.session.id, testKey, answerKey),
      'Could not record that answer.',
    );
    if (s) {
      applyState(s);
      if (s.decision.hazards.length > 0)
        toast('Safety hazard reported - make the site safe before continuing.', 'error');
      refreshLists();
    }
  };

  const openSession = async (id: string) => {
    const s = await run(() => fetchAdnState(id), 'Could not open that session.');
    if (s) applyState(s);
  };

  const onConfirm = async () => {
    if (!state || !confirmKey) return;
    const id = state.session.id;
    const s = await run(async () => {
      await confirmAdnCause(id, confirmKey);
      return fetchAdnState(id);
    }, 'Could not confirm the cause.');
    if (s) {
      applyState(s);
      refreshLists();
    }
  };

  const onRepaired = async () => {
    if (!state) return;
    const id = state.session.id;
    const res = await run(async () => {
      const r = await completeAdnRepair(id, repairNotes);
      return { r, s: await fetchAdnState(id) };
    }, 'Could not save the repair.');
    if (res) {
      toast(
        `Repair logged. Vireek will verify it on ${new Date(res.r.verify_due_at).toLocaleDateString()}.`,
        'success',
      );
      applyState(res.s);
      refreshLists();
    }
  };

  const onOutcome = async (sessionId: string, outcome: AdnOutcome, corrected?: string) => {
    const res = await run(async () => {
      await recordAdnOutcome(sessionId, outcome, corrected);
      return { s: state?.session.id === sessionId ? await fetchAdnState(sessionId) : null };
    }, 'Could not record the outcome.');
    if (res) {
      toast('Outcome verified - the network just got smarter.', 'success');
      if (res.s) applyState(res.s);
      refreshLists();
    }
  };

  const onAbandon = async () => {
    if (!state) return;
    const ok = await run(async () => {
      await abandonAdnSession(state.session.id);
      return true;
    }, 'Could not close the session.');
    if (ok) {
      setState(null);
      refreshLists();
    }
  };

  const updateSettings = async (next: AdnSettings) => {
    if (!user) return;
    const prev = settings;
    setSettings(next);
    try {
      await saveAdnSettings(user.id, next);
    } catch (err) {
      setSettings(prev);
      toast(
        err instanceof Error ? err.message : 'Only the account owner can change these settings.',
        'error',
      );
    }
  };

  const d = state?.decision;
  const sess = state?.session;
  const confirmedCause = sess?.confirmed_cause_key ? causes[sess.confirmed_cause_key] : undefined;
  const queue = sessions.filter((s) => s.status === 'repaired');
  const familyCauses = sess
    ? Object.values(causes)
        .filter((c) => c.family === sess.family)
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  const symptomLabel = (key: string) => symptoms.find((s) => s.key === key)?.label ?? key;

  return (
    <DashboardLayout activeLabel="Adaptive Diagnostics">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <BrainCircuit size={24} />
        </span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Adaptive Diagnostic Network</h1>
          <p className="text-sm text-text-secondary">
            Vireek asks the one question that narrows the diagnosis fastest, re-ranks causes after
            every answer, and learns from every verified repair.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4" aria-busy="true">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
            <StatTile
              label="Diagnostics"
              value={String(stats?.sessions_total ?? 0)}
              hint={`${stats?.in_progress ?? 0} in progress`}
            />
            <StatTile
              label="Verified fixes"
              value={String(stats?.verified ?? 0)}
              hint={`${stats?.awaiting_verification ?? 0} awaiting`}
            />
            <StatTile label="Fix rate" value={pct(stats?.fix_rate)} />
            <StatTile
              label="First-guess accuracy"
              value={pct(stats?.top1_accuracy)}
              hint="Top suggestion = real cause"
            />
            <StatTile
              label="Avg questions"
              value={stats?.avg_questions != null ? String(stats.avg_questions) : '—'}
            />
            <StatTile
              label="Learned outcomes"
              value={String(Math.round(stats?.account_learned_outcomes ?? 0))}
              hint={`Network: ${Math.round(stats?.network_learned_outcomes ?? 0)}`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              {!state && (
                <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <Sparkles size={16} className="text-accent" /> Start a diagnostic
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label
                        className="mb-1 block text-xs text-text-secondary"
                        htmlFor="adn-symptom"
                      >
                        What is the customer seeing?
                      </label>
                      <select
                        id="adn-symptom"
                        className={inputCls}
                        value={symptomKey}
                        onChange={(e) => setSymptomKey(e.target.value)}
                      >
                        <option value="">Select a symptom…</option>
                        {Object.entries(groupedSymptoms).map(([family, list]) => (
                          <optgroup key={family} label={ADN_FAMILY_LABELS[family] ?? family}>
                            {list.map((s) => (
                              <option key={s.key} value={s.key}>
                                {s.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-text-secondary" htmlFor="adn-job">
                        Job (optional)
                      </label>
                      <select
                        id="adn-job"
                        className={inputCls}
                        value={jobId}
                        onChange={(e) => setJobId(e.target.value)}
                      >
                        <option value="">No linked job</option>
                        {jobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.customer_name}
                            {j.service_type ? ` · ${j.service_type}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-text-secondary" htmlFor="adn-eq">
                        Saved equipment (optional)
                      </label>
                      <select
                        id="adn-eq"
                        className={inputCls}
                        value={equipmentId}
                        onChange={(e) => setEquipmentId(e.target.value)}
                        disabled={equipment.length === 0}
                      >
                        <option value="">
                          {equipment.length ? 'Select equipment…' : 'Link a job to see equipment'}
                        </option>
                        {equipment.map((e) => (
                          <option key={e.id} value={e.id}>
                            {[e.equipment_type, e.make, e.model].filter(Boolean).join(' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-text-secondary" htmlFor="adn-make">
                        Brand (improves accuracy)
                      </label>
                      <input
                        id="adn-make"
                        className={inputCls}
                        value={make}
                        onChange={(e) => setMake(e.target.value)}
                        placeholder="e.g. Carrier"
                        maxLength={40}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-text-secondary" htmlFor="adn-model">
                        Model
                      </label>
                      <input
                        id="adn-model"
                        className={inputCls}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="e.g. 24ABC"
                        maxLength={80}
                      />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="mt-4"
                    onClick={onStart}
                    disabled={busy || !symptomKey}
                  >
                    {busy ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <ChevronRight size={15} />
                    )}{' '}
                    Start diagnostic
                  </Button>
                </section>
              )}

              {state && sess && d && (
                <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-text-primary">
                        {symptomLabel(sess.symptom_key)}
                      </h2>
                      <p className="text-xs text-text-secondary">
                        {[sess.make && sess.make.toUpperCase(), sess.model, sess.equipment_label]
                          .filter(Boolean)
                          .join(' · ') || 'Equipment not specified'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${ADN_STATUS_META[sess.status].className}`}
                      >
                        {ADN_STATUS_META[sess.status].label}
                      </span>
                      <button
                        onClick={() => setState(null)}
                        className="rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"
                        aria-label="Close session"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>

                  {d.hazards.length > 0 && (
                    <div
                      role="alert"
                      className="mb-4 rounded-xl border border-danger-500/40 bg-danger-500/10 p-4"
                    >
                      <p className="flex items-center gap-2 text-sm font-semibold text-danger-500">
                        <AlertTriangle size={16} /> Safety hazard reported - stop work
                      </p>
                      <p className="mt-1 text-xs text-text-primary">
                        {d.hazards.map((h) => h.answer_label).join('; ')}. Ventilate, shut off
                        gas/power if safe, evacuate occupants and follow your emergency procedure.
                        Resume only when a licensed professional has cleared the site.
                      </p>
                    </div>
                  )}
                  {d.hazards.length === 0 && d.safety_alerts.length > 0 && (
                    <div
                      role="alert"
                      className="mb-4 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-text-primary"
                    >
                      <span className="font-semibold text-warning-500">Safety watch:</span>{' '}
                      {d.safety_alerts.map((a) => `${a.label} (${pct(a.probability)})`).join(', ')}.
                      Keep safety checks in mind while testing.
                    </div>
                  )}

                  <div className="grid gap-5 md:grid-cols-2">
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                          Probable causes
                        </p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CONFIDENCE_STYLES[d.confidence]}`}
                        >
                          {d.confidence} confidence
                        </span>
                      </div>
                      <DifferentialBars items={d.differential} />
                    </div>

                    <div>
                      {sess.status === 'active' && d.next ? (
                        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
                          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                            <Gauge size={12} />{' '}
                            {d.next.reason === 'safety_check'
                              ? 'Safety check first'
                              : `Best next question · ${d.next.information_gain_bits.toFixed(2)} bits`}
                          </p>
                          <p className="text-sm font-semibold text-text-primary">
                            {d.next.test.question}
                          </p>
                          {d.next.test.tool_needed && (
                            <p className="mt-1 text-xs text-text-secondary">
                              Tool: {d.next.test.tool_needed}
                            </p>
                          )}
                          {d.next.test.safety_note && (
                            <p className="mt-2 flex gap-1.5 text-xs text-warning-500">
                              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                              {d.next.test.safety_note}
                            </p>
                          )}
                          <div className="mt-3 space-y-2">
                            {d.next.test.answers.map((a) => {
                              const pv = d.next!.preview.find((p) => p.answer_key === a.key);
                              return (
                                <button
                                  key={a.key}
                                  disabled={busy}
                                  onClick={() => onAnswer(d.next!.test.key, a.key)}
                                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition hover:border-accent disabled:opacity-50 ${a.hazard ? 'border-danger-500/40 text-danger-500' : 'border-border text-text-primary'} bg-bg-primary`}
                                >
                                  <span className="block font-medium">{a.label}</span>
                                  {pv && (
                                    <span className="block text-[11px] text-text-secondary">
                                      If so → {pv.top_cause_label} {pct(pv.top_cause_probability)}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                            {d.next.reason !== 'safety_check' && (
                              <button
                                disabled={busy}
                                onClick={() => onAnswer(d.next!.test.key, ADN_SKIP_ANSWER)}
                                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2 text-xs text-text-secondary hover:border-accent disabled:opacity-50"
                              >
                                <SkipForward size={12} /> Can't test this right now - ask something
                                else
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-border bg-bg-primary p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                            Diagnosis
                          </p>
                          <p className="mt-1 text-sm font-semibold text-text-primary">
                            {d.differential[0]?.label ?? '—'} ·{' '}
                            {pct(d.differential[0]?.probability)}
                          </p>
                          {d.stop_reason && (
                            <p className="mt-1 text-xs text-text-secondary">
                              {ADN_STOP_REASON_TEXT[d.stop_reason]}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {state.steps.length > 0 && (
                    <div className="mt-5">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        Reasoning trail
                      </p>
                      <ol className="space-y-1.5">
                        {state.steps.map((s) => (
                          <li
                            key={s.step_no}
                            className="flex flex-wrap items-center gap-x-2 rounded-lg bg-bg-primary px-3 py-2 text-xs"
                          >
                            <span className="font-medium text-text-primary">
                              {s.step_no}. {s.test_label}
                            </span>
                            <span className="text-text-secondary">→ {s.answer_label}</span>
                            {s.top_cause_label && (
                              <span className="ml-auto text-text-secondary">
                                leading: {s.top_cause_label} {pct(s.top_probability)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {sess.status === 'diagnosed' && (
                    <div className="mt-5 rounded-xl border border-border bg-bg-primary p-4">
                      <p className="mb-2 text-sm font-semibold text-text-primary">
                        Confirm the root cause you actually found
                      </p>
                      <select
                        className={inputCls}
                        value={confirmKey}
                        onChange={(e) => setConfirmKey(e.target.value)}
                        aria-label="Confirmed root cause"
                      >
                        {familyCauses.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                            {c.key === sess.suggested_cause_key ? ' (suggested)' : ''}
                          </option>
                        ))}
                      </select>
                      <div className="mt-3 flex gap-2">
                        <Button size="sm" onClick={onConfirm} disabled={busy || !confirmKey}>
                          <CheckCircle2 size={15} /> Confirm cause
                        </Button>
                        <button
                          onClick={onAbandon}
                          disabled={busy}
                          className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary"
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                  {sess.status === 'active' && state.steps.length > 0 && (
                    <button
                      onClick={onAbandon}
                      disabled={busy}
                      className="mt-4 text-xs text-text-secondary underline"
                    >
                      Discard this diagnostic
                    </button>
                  )}

                  {sess.status === 'confirmed' && confirmedCause && (
                    <div className="mt-5 rounded-xl border border-border bg-bg-primary p-4">
                      <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                        <Wrench size={15} className="text-accent" /> Repair path:{' '}
                        {confirmedCause.label}
                      </p>
                      {confirmedCause.summary && (
                        <p className="mt-1 text-xs text-text-secondary">{confirmedCause.summary}</p>
                      )}
                      {confirmedCause.repair_steps.length > 0 && (
                        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-text-primary">
                          {confirmedCause.repair_steps.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ol>
                      )}
                      {confirmedCause.parts.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {confirmedCause.parts.map((p) => (
                            <span
                              key={p.name}
                              className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary"
                            >
                              {p.name} · {p.necessity.replace('_', ' ')}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="mt-3 text-[11px] text-text-secondary">
                        Follow the manufacturer's service data, local code and EPA 608 for exact
                        specifications.
                      </p>
                      <textarea
                        className={`${inputCls} mt-3`}
                        rows={2}
                        maxLength={2000}
                        value={repairNotes}
                        onChange={(e) => setRepairNotes(e.target.value)}
                        placeholder="What did you actually do? (parts replaced, readings after repair)"
                      />
                      <Button size="sm" className="mt-3" onClick={onRepaired} disabled={busy}>
                        <CheckCircle2 size={15} /> Repair complete
                      </Button>
                    </div>
                  )}

                  {(sess.status === 'repaired' || (sess.status === 'verified' && sess.outcome)) && (
                    <div className="mt-5 rounded-xl border border-border bg-bg-primary p-4">
                      {sess.status === 'repaired' ? (
                        <>
                          <p className="text-sm font-semibold text-text-primary">
                            Repair logged
                            {sess.verify_due_at
                              ? ` - auto-verification on ${new Date(sess.verify_due_at).toLocaleDateString()}`
                              : ''}
                          </p>
                          <p className="mt-1 text-xs text-text-secondary">
                            If the customer had no repeat visit by then, it counts as a verified
                            success. You can also record the real result now.
                          </p>
                          <OutcomeButtons
                            busy={busy}
                            familyCauses={familyCauses}
                            correctedKey={correctedKey}
                            setCorrectedKey={setCorrectedKey}
                            onOutcome={(o, c) => onOutcome(sess.id, o, c)}
                          />
                        </>
                      ) : (
                        <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                          <CheckCircle2 size={16} className="text-success-500" /> Verified:{' '}
                          {sess.outcome} - this outcome is now training the network.
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}

              {queue.length > 0 && (
                <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                      <RefreshCw size={15} className="text-accent" /> Verification queue
                    </h2>
                    <span className="text-xs text-text-secondary">{queue.length} awaiting</span>
                  </div>
                  <ul className="space-y-2">
                    {queue.map((s) => {
                      const due = s.verify_due_at ? new Date(s.verify_due_at) : null;
                      const overdue = due ? due.getTime() <= Date.now() : false;
                      return (
                        <li
                          key={s.id}
                          className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-primary px-3 py-2 text-xs"
                        >
                          <button
                            onClick={() => openSession(s.id)}
                            className="font-medium text-text-primary hover:underline"
                          >
                            {causes[s.confirmed_cause_key ?? '']?.label ??
                              symptomLabel(s.symptom_key)}
                          </button>
                          <span className="text-text-secondary">
                            {due
                              ? `${overdue ? 'due' : 'verifies'} ${due.toLocaleDateString()}`
                              : ''}
                          </span>
                          {s.needs_review && (
                            <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-warning-500">
                              Customer had a repeat job - please review
                            </span>
                          )}
                          <span className="ml-auto flex gap-1.5">
                            <button
                              disabled={busy}
                              onClick={() => onOutcome(s.id, 'success')}
                              className="rounded-lg bg-success-500/15 px-2.5 py-1 text-success-500"
                            >
                              Fixed
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => openSession(s.id)}
                              className="rounded-lg bg-bg-tertiary px-2.5 py-1 text-text-secondary"
                            >
                              Not fixed…
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <CustomerIntakeLearning />
            </div>

            <div className="space-y-6">
              <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <History size={15} /> Recent diagnostics
                </h2>
                {sessions.length === 0 ? (
                  <p className="text-xs text-text-secondary">
                    No diagnostics yet. Start one - every verified repair makes the next diagnosis
                    faster.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {sessions.slice(0, 12).map((s) => (
                      <li key={s.id}>
                        <button
                          onClick={() => openSession(s.id)}
                          className="w-full rounded-xl bg-bg-primary px-3 py-2 text-left hover:ring-1 hover:ring-accent"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium text-text-primary">
                              {symptomLabel(s.symptom_key)}
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${ADN_STATUS_META[s.status].className}`}
                            >
                              {ADN_STATUS_META[s.status].label}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-text-secondary">
                            {[s.make && s.make.toUpperCase(), s.model].filter(Boolean).join(' ') ||
                              ADN_FAMILY_LABELS[s.family] ||
                              s.family}{' '}
                            · {new Date(s.created_at).toLocaleDateString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Network size={15} className="text-accent" /> Network learning
                </h2>
                <label className="flex items-start gap-2 text-xs text-text-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.share_anonymous_learning}
                    disabled={!isOwner}
                    onChange={(e) =>
                      updateSettings({ ...settings, share_anonymous_learning: e.target.checked })
                    }
                  />
                  <span>
                    Contribute anonymous outcome counts to the Vireek network and benefit from
                    everyone's verified repairs. Only aggregate counts by equipment family and brand
                    are shared - never customers, jobs, notes or business details.
                  </span>
                </label>
                <label className="mt-3 block text-xs text-text-secondary" htmlFor="adn-days">
                  Verify repairs after
                </label>
                <select
                  id="adn-days"
                  className={`${inputCls} mt-1`}
                  value={settings.verify_after_days}
                  disabled={!isOwner}
                  onChange={(e) =>
                    updateSettings({ ...settings, verify_after_days: Number(e.target.value) })
                  }
                >
                  {[7, 14, 21, 30, 45, 60].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
                {!isOwner && (
                  <p className="mt-2 text-[11px] text-text-secondary">
                    Only the account owner can change these settings.
                  </p>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}

function OutcomeButtons({
  busy,
  familyCauses,
  correctedKey,
  setCorrectedKey,
  onOutcome,
}: {
  busy: boolean;
  familyCauses: AdnCause[];
  correctedKey: string;
  setCorrectedKey: (k: string) => void;
  onOutcome: (o: AdnOutcome, corrected?: string) => void;
}) {
  const [notFixed, setNotFixed] = useState(false);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() => onOutcome('success')}
          className="rounded-xl bg-success-500/15 px-4 py-2 text-sm font-semibold text-success-500 disabled:opacity-50"
        >
          Fixed
        </button>
        <button
          disabled={busy}
          onClick={() => onOutcome('partial')}
          className="rounded-xl bg-warning-500/10 px-4 py-2 text-sm font-semibold text-warning-500 disabled:opacity-50"
        >
          Partly fixed
        </button>
        <button
          disabled={busy}
          onClick={() => setNotFixed((v) => !v)}
          className="rounded-xl bg-danger-500/10 px-4 py-2 text-sm font-semibold text-danger-500 disabled:opacity-50"
        >
          Not fixed
        </button>
      </div>
      {notFixed && (
        <div className="mt-3">
          <label className="mb-1 block text-xs text-text-secondary" htmlFor="adn-corrected">
            What was the real cause? (teaches the network the right answer)
          </label>
          <select
            id="adn-corrected"
            className={inputCls}
            value={correctedKey}
            onChange={(e) => setCorrectedKey(e.target.value)}
          >
            <option value="">Not known yet</option>
            {familyCauses.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            onClick={() => onOutcome('failed', correctedKey || undefined)}
            className="mt-2 rounded-xl bg-danger-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Record as not fixed
          </button>
        </div>
      )}
    </div>
  );
}
