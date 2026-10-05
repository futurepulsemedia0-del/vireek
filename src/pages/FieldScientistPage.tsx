/**
 * AI Field Scientist — /dashboard/field-scientist
 *
 * Mines completed jobs for statistically real, mix-adjusted callback gaps,
 * lets the AI propose candidate causes, runs a pre-registered randomised
 * experiment on real upcoming jobs, then accepts / rejects the hypothesis and
 * writes the result into Organizational Memory. See src/lib/fieldScientist.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { BookCheck, CheckCircle2, ChevronDown, Loader2, Microscope, Play, RefreshCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  assignExperimentArms,
  CALLBACK_WINDOW_DAYS,
  concludeExperiment,
  dismissHypothesis,
  ExperimentResult,
  fetchHypotheses,
  FieldHypothesis,
  measureExperiment,
  requestCauses,
  runDiscovery,
  selectCause,
  startExperiment,
  STATUS_COLORS,
  STATUS_LABELS,
  type DiscoveryRunSummary,
} from '@/lib/fieldScientist';

const pct = (n: number) => `${n}%`;
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

function EvidencePanel({ h }: { h: FieldHypothesis }) {
  const d = h.discovery;
  const worse = h.direction === 'worse';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Segment callback rate" value={`${pct(d.segment_rate_pct)} (n=${d.segment_n})`} tone={worse ? 'bad' : 'good'} />
        <Stat label="Comparison rate" value={`${pct(d.comparison_rate_pct)} (n=${d.comparison_n})`} />
        <Stat label="Gap (95% CI)" value={`${d.diff_pp > 0 ? '+' : ''}${d.diff_pp} pp (${d.ci_low_pp} to ${d.ci_high_pp})`} />
        <Stat label="FDR q-value" value={`${d.q_value}`} />
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-text-secondary">
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success-500" />
        <span>
          Survived {d.tested_segments}-segment multiple-testing control (Benjamini–Hochberg).
          {d.adjusted_p !== null
            ? ` Still significant after adjusting for service mix (Mantel–Haenszel p=${d.adjusted_p}, OR=${d.adjusted_or}).`
            : ' Service type is the segment itself, so no mix adjustment applies.'}
          {' '}Only jobs older than {d.window_days} days are counted, so callbacks had time to happen.
        </span>
      </p>
      {d.drilldown.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-primary p-3">
          <p className="mb-1 text-xs font-medium text-text-primary">Where the gap concentrates (exploratory)</p>
          <ul className="space-y-0.5 text-xs text-text-secondary">
            {d.drilldown.map((r) => (
              <li key={`${r.dimension}-${r.key}`}>
                {r.dimension} “{r.key}”: {pct(r.segment_rate_pct)} vs {pct(r.others_rate_pct)} (n={r.n})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProgressPanel({ result }: { result: ExperimentResult }) {
  const t = result.test;
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Stat label="Treatment" value={`${result.treatment.k}/${result.treatment.n} callbacks`} />
        <Stat label="Control" value={`${result.control.k}/${result.control.n} callbacks`} />
      </div>
      {t && <p>Difference {Math.round(t.diff * 1000) / 10} pp · p={t.p.toPrecision(2)} · 95% CI {Math.round(t.ci_low * 1000) / 10} to {Math.round(t.ci_high * 1000) / 10} pp</p>}
      <p className="mt-1">{result.reasoning}</p>
      {result.pending_jobs > 0 && <p className="mt-1">{result.pending_jobs} tagged job(s) are still scheduled or inside the {CALLBACK_WINDOW_DAYS}-day callback window.</p>}
    </div>
  );
}

function HypothesisCard({ h, onChanged }: { h: FieldHypothesis; onChanged: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(h.status === 'ready' || h.status === 'testing');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExperimentResult | null>(null);

  const run = async (key: string, fn: () => Promise<void>, errorMsg: string) => {
    setBusy(key);
    try { await fn(); } catch { toast(errorMsg, 'error'); }
    setBusy(null);
  };

  const design = h.experiment_design;
  const finished = h.status === 'accepted' || h.status === 'rejected' || h.status === 'inconclusive';
  const spinner = (key: string) => (busy === key ? <Loader2 size={13} className="animate-spin" /> : null);
  const btn = 'focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40';

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-start gap-3 rounded-2xl p-4 text-left">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[h.status]}`}>{STATUS_LABELS[h.status]}</span>
            <span className="text-[10px] uppercase tracking-wide text-text-secondary">{h.direction === 'worse' ? 'Problem' : 'Best practice'} · {h.segment_label}</span>
          </div>
          <p className="text-sm font-medium text-text-primary">{h.statement}</p>
        </div>
        <ChevronDown size={16} className={`mt-1 shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border p-4">
          <EvidencePanel h={h} />

          {/* Candidate causes */}
          {h.status === 'proposed' && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-border p-3">
              <p className="text-xs text-text-secondary">Candidate causes have not been generated yet.</p>
              <button type="button" disabled={busy !== null} className={`${btn} bg-accent text-white`}
                onClick={() => void run('causes', async () => { await requestCauses(h.id); onChanged(); }, 'AI could not propose causes right now')}>
                {spinner('causes') ?? <Sparkles size={13} />} Generate causes
              </button>
            </div>
          )}

          {h.candidate_causes.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-primary">Candidate causes — pick one to test</p>
              <div className="space-y-1.5">
                {h.candidate_causes.map((c) => {
                  const selected = h.selected_cause_id === c.id;
                  const locked = h.status !== 'ready';
                  return (
                    <button key={c.id} type="button" disabled={locked || busy !== null}
                      onClick={() => void run(`cause-${c.id}`, async () => { await selectCause(h, c.id); onChanged(); }, 'Could not register the design')}
                      className={`focus-ring w-full rounded-xl border p-3 text-left text-xs disabled:cursor-default ${selected ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary'}`}>
                      <p className="font-medium text-text-primary">{c.label} <span className="font-normal text-text-secondary">· priority {c.priority}</span></p>
                      <p className="mt-0.5 text-text-secondary">{c.mechanism}</p>
                      <p className="mt-0.5 text-text-secondary"><span className="font-medium text-text-primary">Test:</span> {c.intervention}</p>
                    </button>
                  );
                })}
              </div>
              {h.status === 'ready' && (
                <button type="button" disabled={busy !== null} className="focus-ring mt-2 text-[11px] text-accent disabled:opacity-40"
                  onClick={() => void run('regen', async () => { await requestCauses(h.id); onChanged(); }, 'AI could not propose causes right now')}>
                  Regenerate causes
                </button>
              )}
            </div>
          )}

          {/* Pre-registered design */}
          {design && (
            <div className="rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
              <p className="mb-1 font-medium text-text-primary">Pre-registered experiment</p>
              <ul className="space-y-0.5">
                <li><span className="text-text-primary">Treatment:</span> {design.intervention}</li>
                <li><span className="text-text-primary">Control:</span> {design.control_desc}</li>
                <li><span className="text-text-primary">Outcome:</span> {design.primary_metric}</li>
                <li><span className="text-text-primary">Sample:</span> {design.n_per_arm} jobs per arm (α={design.alpha}, power {design.power * 100}%, {design.control_rate_pct}% → {design.target_rate_pct}%)</li>
                <li><span className="text-text-primary">Expected duration:</span> ~{design.expected_days} days incl. the {design.callback_window_days}-day callback window</li>
                <li><span className="text-text-primary">Randomization:</span> {design.randomization}</li>
                <li><span className="text-text-primary">Stop rule:</span> {design.stop_rule}</li>
              </ul>
              {design.underpowered && (
                <p className="mt-2 rounded-lg bg-warning-500/10 px-2 py-1 text-warning-500">
                  This would take over 180 days at your current volume — consider testing a broader segment.
                </p>
              )}
            </div>
          )}

          {/* Actions by status */}
          <div className="flex flex-wrap items-center gap-2">
            {h.status === 'ready' && design && (
              <button type="button" disabled={busy !== null} className={`${btn} bg-accent text-white`}
                onClick={() => void run('start', async () => {
                  const t = await startExperiment(h);
                  toast(`Experiment started — ${t.treatment} treatment / ${t.control} control jobs tagged`, 'success');
                  onChanged();
                }, 'Could not start the experiment')}>
                {spinner('start') ?? <Play size={13} />} Start experiment
              </button>
            )}
            {h.status === 'testing' && (
              <>
                <button type="button" disabled={busy !== null} className={`${btn} border border-border text-text-primary`}
                  onClick={() => void run('assign', async () => {
                    const t = await assignExperimentArms(h);
                    toast(t.treatment + t.control > 0 ? `${t.treatment + t.control} new job(s) assigned` : 'No new eligible jobs to assign', 'success');
                  }, 'Could not assign new jobs')}>
                  {spinner('assign') ?? <RefreshCcw size={13} />} Assign new jobs
                </button>
                <button type="button" disabled={busy !== null} className={`${btn} border border-border text-text-primary`}
                  onClick={() => void run('measure', async () => { setProgress(await measureExperiment(h)); }, 'Could not read outcomes')}>
                  {spinner('measure') ?? <Microscope size={13} />} Check progress
                </button>
                {progress && (
                  <button type="button" disabled={busy !== null} className={`${btn} bg-accent text-white`}
                    onClick={() => void run('conclude', async () => {
                      const r = await concludeExperiment(h);
                      toast(`Verdict: ${r.verdict}`, r.verdict === 'accepted' ? 'success' : 'info');
                      onChanged();
                    }, 'Could not save the verdict')}>
                    {spinner('conclude') ?? <CheckCircle2 size={13} />} {progress.complete ? 'Save verdict' : 'Stop early (saves as inconclusive)'}
                  </button>
                )}
              </>
            )}
            {!finished && (
              <button type="button" disabled={busy !== null} className={`${btn} text-text-secondary`}
                onClick={() => void run('dismiss', async () => { await dismissHypothesis(h.id); onChanged(); }, 'Could not dismiss')}>
                <X size={13} /> Dismiss
              </button>
            )}
          </div>

          {h.status === 'testing' && (
            <p className="text-[11px] text-text-secondary">Started {fmtDate(h.experiment_started_at)} · planned end {fmtDate(h.experiment_ends_at)}. New eligible jobs are tagged when you press “Assign new jobs”.</p>
          )}
          {progress && h.status === 'testing' && <ProgressPanel result={progress} />}

          {/* Verdict */}
          {finished && h.experiment_result && (
            <div className={`rounded-xl border p-3 text-xs ${h.status === 'accepted' ? 'border-success-500/40 bg-success-500/5' : h.status === 'rejected' ? 'border-danger/40 bg-danger/5' : 'border-border bg-bg-primary'}`}>
              <p className="mb-1 flex items-center gap-1.5 font-medium text-text-primary"><BookCheck size={13} /> {STATUS_LABELS[h.status]} · {fmtDate(h.decided_at)}</p>
              <p className="text-text-secondary">{h.verdict_reasoning}</p>
              {h.playbook_entry_id && <p className="mt-1 text-text-secondary">Saved to Organizational Memory as {h.status === 'accepted' ? 'a winning playbook' : 'a failure pattern'}.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FieldScientistPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<FieldHypothesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<DiscoveryRunSummary | null>(null);

  const load = useCallback(async () => {
    try { setItems(await fetchHypotheses()); } catch { /* empty state covers it */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDiscover = async () => {
    setRunning(true);
    try {
      const s = await runDiscovery();
      setSummary(s);
      if (s.notEnoughData) toast('Not enough completed jobs with outcomes yet', 'info');
      await load();
    } catch {
      toast('Discovery failed — please try again', 'error');
    }
    setRunning(false);
  };

  return (
    <DashboardLayout activeLabel="AI Field Scientist">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Microscope size={18} /> AI Field Scientist</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Vireek forms its own hypotheses from your jobs, checks them against chance and job mix, designs the experiment, and only then accepts or rejects — updating your playbook with what actually worked.
            </p>
          </div>
          <button type="button" disabled={running} onClick={() => void handleDiscover()}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
            {running ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Discover hypotheses
          </button>
        </div>

        {summary && !summary.notEnoughData && (
          <p className="mb-3 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
            Scanned {summary.jobs.toLocaleString('en-US')} jobs across {summary.tested} segments: {summary.created} new hypothesis{summary.created === 1 ? '' : 'es'}
            {summary.confoundedFiltered > 0 ? `, ${summary.confoundedFiltered} discarded as explained by job mix` : ''}.
          </p>
        )}

        {loading ? (
          <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <Microscope className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">
              No hypotheses yet. Run discovery once you have a few months of completed jobs with callbacks tracked.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((h) => (
              <motion.div key={h.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <HypothesisCard h={h} onChanged={() => void load()} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
