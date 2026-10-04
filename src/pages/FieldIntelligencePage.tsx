import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Brain, CheckCircle2, ClipboardCheck, Database, FlaskConical, Gauge, Network, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import {
  GRADE_META,
  KIND_LABELS,
  LABEL_META,
  brierTrend,
  coverageRows,
  dataCompletenessScore,
  describeEquipment,
  failedKindsFor,
  formatPercent,
  formatRateWithInterval,
  formatReason,
  formatTag,
  gradeCalibration,
  settledCount,
  type ActionKind,
  type CalibrationBlock,
  type FinalLabel,
  type LearningMetrics,
  type ObservationRow,
  type OutcomeLabel,
} from '@/lib/fieldIntelligence';

type Tab = 'overview' | 'review' | 'outcomes' | 'datasets';

interface OutcomeStats {
  n: number;
  n_success: number;
  success_rate: number | null;
  wilson_lower: number | null;
  wilson_upper: number | null;
}
interface DiagnosisRow extends OutcomeStats { diagnosis_tag: string }
interface PartRow extends OutcomeStats { part_key: string; part_label: string | null }
interface TechnicianRow extends OutcomeStats { technician_id: string; technician_name: string | null; avg_duration_minutes: number | null }
interface EvalSetRow { id: string; name: string; version: number; case_count: number; human_labeled_count: number; created_at: string }
interface NetworkRow { dimension: 'diagnosis' | 'part'; equipment_make: string; equipment_model: string; action_key: string; n_observations: number; n_accounts: number; success_rate: number; wilson_lower: number }

const OBS_COLS =
  'id, job_id, service_type, equipment_make, equipment_model, equipment_type, equipment_age_months, symptoms, symptom_tags, diagnosis, diagnosis_tag, technician_id, parts, duration_minutes, cost_cents, revenue_cents, observed_at, outcome_label, label_confidence, uncertainty, outcome_reasons, matured_horizon';
const STATS_COLS = 'n, n_success, success_rate, wilson_lower, wilson_upper';
const LABEL_ORDER: OutcomeLabel[] = ['success', 'partial', 'failure', 'ambiguous', 'pending'];
const LABEL_BAR: Record<OutcomeLabel, string> = {
  success: 'bg-success-500',
  partial: 'bg-warning-500',
  failure: 'bg-danger',
  ambiguous: 'bg-accent',
  pending: 'bg-bg-tertiary',
};
const KINDS: ActionKind[] = ['diagnosis', 'part', 'repair'];

export function FieldIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<LearningMetrics | null>(null);
  const [previousRunAt, setPreviousRunAt] = useState<string | null>(null);
  const [queue, setQueue] = useState<ObservationRow[]>([]);
  const [diagnoses, setDiagnoses] = useState<DiagnosisRow[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [technicians, setTechnicians] = useState<TechnicianRow[]>([]);
  const [evalSets, setEvalSets] = useState<EvalSetRow[]>([]);
  const [network, setNetwork] = useState<NetworkRow[]>([]);
  const [contribute, setContribute] = useState(true);
  const [evalName, setEvalName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const [runs, q, d, p, t, e, s, n] = await Promise.all([
      supabase.from('fie_learning_runs').select('metrics, created_at').order('created_at', { ascending: false }).limit(2),
      supabase.from('fie_observations').select(OBS_COLS).eq('needs_adjudication', true).order('observed_at', { ascending: false }).limit(25),
      supabase.from('fie_diagnosis_outcomes_v').select(`diagnosis_tag, ${STATS_COLS}`).order('n', { ascending: false }).limit(12),
      supabase.from('fie_part_outcomes_v').select(`part_key, part_label, ${STATS_COLS}`).order('n', { ascending: false }).limit(12),
      supabase.from('fie_technician_outcomes_v').select(`technician_id, technician_name, avg_duration_minutes, ${STATS_COLS}`).order('n', { ascending: false }).limit(20),
      supabase.from('fie_eval_sets').select('id, name, version, case_count, human_labeled_count, created_at').order('version', { ascending: false }).limit(10),
      supabase.from('fie_settings').select('contribute_to_network').maybeSingle(),
      supabase
        .from('fie_global_patterns')
        .select('dimension, equipment_make, equipment_model, action_key, n_observations, n_accounts, success_rate, wilson_lower')
        .gte('n_observations', 10)
        .order('success_rate', { ascending: true })
        .limit(8),
    ]);

    if (runs.error || q.error || d.error || p.error || t.error || e.error || n.error) {
      setLoadError(true);
      setLoading(false);
      toast('Failed to load Field Intelligence', 'error');
      return;
    }
    setLoadError(false);
    const runRows = (runs.data ?? []) as { metrics: LearningMetrics; created_at: string }[];
    setMetrics(runRows[0]?.metrics ?? null);
    setPreviousRunAt(runRows[0]?.created_at ?? null);
    setQueue((q.data ?? []) as unknown as ObservationRow[]);
    setDiagnoses((d.data ?? []) as unknown as DiagnosisRow[]);
    setParts((p.data ?? []) as unknown as PartRow[]);
    setTechnicians((t.data ?? []) as unknown as TechnicianRow[]);
    setEvalSets((e.data ?? []) as EvalSetRow[]);
    setNetwork((n.data ?? []) as unknown as NetworkRow[]);
    setContribute((s.data as { contribute_to_network: boolean } | null)?.contribute_to_network ?? true);
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const runCycle = async () => {
    setRunning(true);
    const { data, error } = await supabase.rpc('fie_refresh_my_account');
    setRunning(false);
    if (error) return toast('Could not run the learning cycle.', 'error');
    const result = data as { busy?: boolean; ingested?: number; labeled?: number } | null;
    if (result?.busy) return toast('A learning cycle is already running.', 'info');
    toast(`Learning cycle done: ${result?.ingested ?? 0} new, ${result?.labeled ?? 0} relabeled.`, 'success');
    await load();
  };

  const adjudicate = async (obs: ObservationRow, finalLabel: FinalLabel | null, kinds: ActionKind[], notes: string) => {
    setBusyId(obs.id);
    const { error } = await supabase.rpc('fie_adjudicate', {
      p_observation_id: obs.id,
      p_final_label: finalLabel,
      p_failed_kinds: finalLabel ? failedKindsFor(finalLabel, kinds) : [],
      p_notes: notes.trim() || null,
    });
    setBusyId(null);
    if (error) return toast(error.message.includes('account owner') ? 'Only the account owner can adjudicate outcomes.' : 'Could not save the decision.', 'error');
    setQueue((prev) => prev.filter((o) => o.id !== obs.id));
    toast('Decision saved. It now overrides the automatic label.', 'success');
    load();
  };

  const createEvalSet = async () => {
    const name = evalName.trim();
    if (!name) return toast('Name the evaluation set first.', 'error');
    setRunning(true);
    const { error } = await supabase.rpc('fie_create_eval_set', { p_name: name, p_max_cases: 500 });
    setRunning(false);
    if (error) {
      if (error.message.includes('No eligible')) return toast('No eligible outcomes yet. Adjudicate a few jobs or wait for outcomes to mature.', 'error');
      return toast(error.message.includes('account owner') ? 'Only the account owner can create evaluation sets.' : 'Could not create the evaluation set.', 'error');
    }
    setEvalName('');
    toast('Evaluation set frozen.', 'success');
    load();
  };

  const toggleContribute = async () => {
    if (!user) return;
    const next = !contribute;
    setContribute(next);
    const { error } = await supabase.from('fie_settings').upsert({ user_id: user.id, contribute_to_network: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) {
      setContribute(!next);
      toast('Only the account owner can change this setting.', 'error');
    }
  };

  const settled = settledCount(metrics?.label_counts);
  const completeness = useMemo(() => dataCompletenessScore(metrics), [metrics]);
  const total = metrics?.total_observations ?? 0;
  const backlog = metrics?.adjudication_backlog ?? 0;

  return (
    <DashboardLayout activeLabel="Field Intelligence">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Brain size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Field Intelligence Engine</h1>
          <p className="text-sm text-text-secondary">Every job becomes a labeled lesson: what was diagnosed, what was done, and whether it actually held.</p>
        </div>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={runCycle} disabled={running || loading}>
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} /> Run learning cycle
        </Button>
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={2} />
        </div>
      ) : loadError ? (
        <EmptyState icon={AlertTriangle} title="Field Intelligence could not load" description="Check that the latest database migration has been applied, then refresh." action={{ label: 'Try again', onClick: () => { setLoading(true); load(); } }} />
      ) : !metrics ? (
        <EmptyState
          icon={Database}
          title="Build intelligence from your job history"
          description="Vireek turns every completed job into a structured observation and labels how it turned out. The first run may take a moment."
          action={{ label: running ? 'Building…' : 'Build now', onClick: runCycle }}
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Jobs learned from', value: total, icon: Database, tone: 'text-accent' },
              { label: 'Settled outcomes', value: settled, icon: CheckCircle2, tone: 'text-success-500' },
              { label: 'Needs your review', value: backlog, icon: ClipboardCheck, tone: backlog > 0 ? 'text-warning-500' : 'text-text-secondary' },
              { label: 'Data completeness', value: formatPercent(completeness), icon: Gauge, tone: 'text-accent' },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-border bg-bg-secondary p-4">
                <k.icon size={16} className={k.tone} />
                <p className="mt-2 text-2xl font-bold text-text-primary">{k.value}</p>
                <p className="text-xs text-text-secondary">{k.label}</p>
              </div>
            ))}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Field intelligence views">
            {([['overview', 'Overview'], ['review', `Review queue (${backlog})`], ['outcomes', 'Outcomes'], ['datasets', 'Datasets & network']] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`focus-ring rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === key ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <Overview metrics={metrics} lastRunAt={previousRunAt} />}

          {tab === 'review' &&
            (queue.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing to review" description="Jobs with conflicting or low-confidence outcomes appear here. Your decision always overrides the automatic label." />
            ) : (
              <div className="space-y-3">
                {queue.map((o) => (
                  <ReviewCard key={o.id} obs={o} busy={busyId === o.id} onDecide={adjudicate} />
                ))}
              </div>
            ))}

          {tab === 'outcomes' && (
            <div className="space-y-6">
              <OutcomeTable title="Diagnosis outcomes" empty="No settled diagnoses yet." rows={diagnoses.map((r) => ({ key: r.diagnosis_tag, name: formatTag(r.diagnosis_tag), ...r }))} />
              <OutcomeTable title="Part outcomes" empty="No settled part usage yet." rows={parts.map((r) => ({ key: r.part_key, name: r.part_label ?? r.part_key, ...r }))} />
              <OutcomeTable
                title="Technician outcomes"
                empty="No settled technician jobs yet."
                rows={technicians.map((r) => ({ key: r.technician_id, name: r.technician_name ?? 'Technician', extra: r.avg_duration_minutes ? `${r.avg_duration_minutes} min avg` : undefined, ...r }))}
              />
              <p className="text-xs text-text-secondary">Rates show a 95% interval. A wide interval means the sample is still small, so don’t rank on it yet.</p>
            </div>
          )}

          {tab === 'datasets' && (
            <div className="space-y-6">
              <section className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="mb-3 flex items-center gap-2"><FlaskConical size={16} className="text-accent" /><h2 className="text-sm font-semibold text-text-primary">Evaluation datasets</h2></div>
                <p className="mb-3 text-xs text-text-secondary">A frozen, stratified snapshot of settled jobs — human-adjudicated first. Re-score any model against it to prove it is improving. Frozen sets can never be edited.</p>
                <div className="mb-4 flex flex-wrap gap-2">
                  <input
                    value={evalName}
                    onChange={(e) => setEvalName(e.target.value)}
                    maxLength={120}
                    placeholder="e.g. Q4 baseline"
                    aria-label="Evaluation set name"
                    className="focus-ring min-w-[200px] flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  />
                  <Button size="sm" onClick={createEvalSet} disabled={running}>Freeze new set</Button>
                </div>
                {evalSets.length === 0 ? (
                  <p className="text-sm text-text-secondary">No evaluation sets yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {evalSets.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="font-medium text-text-primary">v{s.version} · {s.name}</span>
                        <span className="text-xs text-text-secondary">{s.case_count} cases · {s.human_labeled_count} human-labeled · {new Date(s.created_at).toLocaleDateString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="mb-3 flex items-center gap-2"><Network size={16} className="text-accent" /><h2 className="text-sm font-semibold text-text-primary">Vireek network learning</h2></div>
                <p className="mb-3 text-xs text-text-secondary">
                  Contribute anonymous outcome counts (make, model, diagnosis category, part number) to the shared network. Nothing is shared unless at least 5 outcomes from 3 different businesses agree. No customers, addresses, notes or business names ever leave your account.
                </p>
                <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={contribute} onChange={toggleContribute} className="h-4 w-4 accent-[var(--color-accent,theme(colors.accent))]" />
                  Contribute to and benefit from network learning
                </label>
                {network.length === 0 ? (
                  <p className="text-sm text-text-secondary">Network risk signals appear once enough businesses contribute data.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {network.map((r) => (
                      <li key={`${r.dimension}-${r.equipment_make}-${r.equipment_model}-${r.action_key}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="text-text-primary">
                          {r.equipment_make ? `${r.equipment_make}${r.equipment_model ? ` ${r.equipment_model}` : ''} · ` : ''}
                          {r.dimension === 'diagnosis' ? formatTag(r.action_key) : `part ${r.action_key}`}
                        </span>
                        <span className="text-xs text-text-secondary">{formatPercent(r.success_rate)} hold up · {r.n_observations} outcomes · {r.n_accounts} businesses</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}

function Overview({ metrics, lastRunAt }: { metrics: LearningMetrics; lastRunAt: string | null }) {
  const counts = metrics.label_counts ?? {};
  const total = LABEL_ORDER.reduce((s, l) => s + (counts[l] ?? 0), 0) || 1;
  const trend = brierTrend(metrics.ftf_brier_delta);
  const rows = coverageRows(metrics);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">Outcome labels</h2>
        <div className="flex h-3 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label="Outcome label distribution">
          {LABEL_ORDER.map((l) => (counts[l] ?? 0) > 0 && <div key={l} className={LABEL_BAR[l]} style={{ width: `${((counts[l] ?? 0) / total) * 100}%` }} />)}
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {LABEL_ORDER.map((l) => (
            <li key={l} className="text-xs" title={LABEL_META[l].description}>
              <span className={`inline-block rounded-md px-1.5 py-0.5 font-medium ${LABEL_META[l].tone}`}>{LABEL_META[l].label}</span>
              <span className="ml-1.5 text-text-primary">{counts[l] ?? 0}</span>
            </li>
          ))}
        </ul>
        {metrics.human.n > 0 && (
          <p className="mt-3 text-xs text-text-secondary">
            {metrics.human.n} human decision{metrics.human.n === 1 ? '' : 's'}; the automatic rules were overruled {formatPercent(metrics.human.override_rate)} of the time.
          </p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <CalibrationCard title="First-time-fix predictions" block={metrics.ftf} trend={trend?.text} trendTone={trend?.tone} />
        <CalibrationCard title="Outcome-assurance predictions" block={metrics.assurance} />
      </div>

      <section className="rounded-xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">What the engine can see</h2>
        <p className="mb-3 text-xs text-text-secondary">Missing links cap how much any model can learn. Weakest first.</p>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex justify-between text-xs"><span className="text-text-primary">{r.label}</span><span className="text-text-secondary">{r.count} of {metrics.total_observations} · {formatPercent(r.share)}</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full rounded-full bg-accent" style={{ width: `${r.share * 100}%` }} /></div>
            </li>
          ))}
        </ul>
        {metrics.copilot_agreement.n > 0 && (
          <p className="mt-3 text-xs text-text-secondary">
            Diagnosis Copilot’s top cause matched the technician’s final diagnosis {formatPercent(metrics.copilot_agreement.rate)} of the time ({metrics.copilot_agreement.n} sessions).
          </p>
        )}
        {lastRunAt && <p className="mt-2 text-xs text-text-secondary">Last learning cycle: {new Date(lastRunAt).toLocaleString()}. Runs automatically every night.</p>}
      </section>
    </div>
  );
}

function CalibrationCard({ title, block, trend, trendTone }: { title: string; block: CalibrationBlock | null; trend?: string; trendTone?: string }) {
  const grade = gradeCalibration(block);
  const meta = GRADE_META[grade];
  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <span className={`text-xs font-medium ${meta.tone}`}>{meta.label}</span>
      </div>
      {!block || !block.n ? (
        <p className="text-sm text-text-secondary">No settled jobs have a saved prediction yet.</p>
      ) : (
        <>
          <p className="text-xs text-text-secondary">
            {block.n} settled jobs · average gap between claimed and actual {formatPercent(block.ece, 1)} · Brier {block.brier?.toFixed(3)}
          </p>
          {trend && <p className={`mt-1 text-xs ${trendTone ?? 'text-text-secondary'}`}>{trend}</p>}
          <ul className="mt-3 space-y-1.5">
            {(block.bins ?? []).map((b) => (
              <li key={b.bin} className="text-xs">
                <div className="flex justify-between text-text-secondary"><span>Predicted ~{formatPercent(b.avg_predicted)} ({b.n})</span><span>Actual {formatPercent(b.observed_rate)}</span></div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full rounded-full bg-accent" style={{ width: `${b.observed_rate * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface OutcomeTableRow extends OutcomeStats { key: string; name: string; extra?: string }

function OutcomeTable({ title, rows, empty }: { title: string; rows: OutcomeTableRow[]; empty: string }) {
  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-text-secondary">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-text-secondary">
              <tr><th className="py-1 pr-3 font-medium">Name</th><th className="py-1 pr-3 font-medium">Settled</th><th className="py-1 font-medium">Held up (95% interval)</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="py-2 pr-3 text-text-primary">{r.name}{r.extra && <span className="ml-2 text-xs text-text-secondary">{r.extra}</span>}</td>
                  <td className="py-2 pr-3 text-text-secondary">{r.n}</td>
                  <td className="py-2 text-text-primary">{formatRateWithInterval(r.success_rate, r.wilson_lower, r.wilson_upper)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ReviewCard({ obs, busy, onDecide }: { obs: ObservationRow; busy: boolean; onDecide: (o: ObservationRow, label: FinalLabel | null, kinds: ActionKind[], notes: string) => void }) {
  const [kinds, setKinds] = useState<ActionKind[]>([]);
  const [notes, setNotes] = useState('');
  const meta = LABEL_META[obs.outcome_label];
  const partNames = (obs.parts ?? []).map((p) => p.name ?? p.part_number).filter(Boolean).join(', ');
  const toggleKind = (k: ActionKind) => setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <article className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${meta.tone}`}>Proposed: {meta.label} ({formatPercent(obs.label_confidence)})</span>
        <span className="text-xs text-text-secondary">{obs.service_type ?? 'Job'} · {new Date(obs.observed_at).toLocaleDateString()}</span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-text-secondary">Equipment: </dt><dd className="inline text-text-primary">{describeEquipment(obs)}</dd></div>
        <div><dt className="inline text-text-secondary">Diagnosis: </dt><dd className="inline text-text-primary">{obs.diagnosis ?? formatTag(obs.diagnosis_tag)}</dd></div>
        <div><dt className="inline text-text-secondary">Parts: </dt><dd className="inline text-text-primary">{partNames || '—'}</dd></div>
        <div><dt className="inline text-text-secondary">Why flagged: </dt><dd className="inline text-text-primary">{obs.outcome_reasons.map(formatReason).join('; ') || 'Low confidence'}</dd></div>
      </dl>
      {obs.symptoms && <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{obs.symptoms}</p>}

      <fieldset className="mt-3">
        <legend className="text-xs text-text-secondary">If it failed, which step failed? (optional)</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kinds.includes(k)}
              onClick={() => toggleKind(k)}
              className={`focus-ring rounded-lg border px-2.5 py-1 text-xs font-medium ${kinds.includes(k) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </fieldset>
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={1000}
        placeholder="Optional note"
        aria-label="Adjudication note"
        className="focus-ring mt-3 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => onDecide(obs, 'success', kinds, notes)}>It held up</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(obs, 'partial', kinds, notes)}>Partial</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(obs, 'failure', kinds, notes)}>It failed</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(obs, null, [], notes)}>Can’t tell</Button>
      </div>
    </article>
  );
}
