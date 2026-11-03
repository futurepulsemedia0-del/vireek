import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2, Play, Square, BarChart3 } from 'lucide-react';
import { EmptyStateInline } from '@/components/EmptyState';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { VOICE_CATALOG } from '@/lib/voiceStudio';
import {
  createExperiment, experimentReport, listExperiments, startExperiment, stopExperiment,
  type ExperimentReport, type ExperimentRow,
} from '@/lib/voiceStudioApi';

const btn = 'focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50';
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const nameOf = (k: string) => VOICE_CATALOG.find((v) => v.key === k)?.name ?? k;

const VERDICT: Record<ExperimentReport['decision']['status'], string> = {
  insufficient_data: 'Not enough calls yet. Results are only judged once every voice reaches the minimum.',
  no_difference: 'No meaningful difference between the voices.',
  winner: 'There is a clear winner.',
  stop_guardrail: 'Stopped: one voice made callers hang up noticeably more.',
};

export function ExperimentsPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<ExperimentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [minPerArm, setMinPerArm] = useState(200);
  const [report, setReport] = useState<ExperimentReport | null>(null);

  const load = useCallback(async () => {
    try { setRows(await listExperiments()); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load experiments.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); } finally { setBusy(null); }
  };

  return (
    <Card interactive={false} aria-labelledby="vs-exp">
      <div className="mb-3 flex items-center gap-2">
        <FlaskConical size={16} className="text-accent" />
        <h2 id="vs-exp" className="text-sm font-semibold text-text-primary">Live A/B test</h2>
      </div>
      <p className="mb-4 text-xs text-text-secondary">
        Split real calls between 2 or 3 voices and compare booking and hang-up rates. Results are only judged once every voice has the minimum number of finished calls.
      </p>

      <div className="mb-4 space-y-3">
        <input aria-label="Experiment name" placeholder="Experiment name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
          className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm" />
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-text-secondary">Voices (first one is the control)</legend>
          <div className="flex flex-wrap gap-3">
            {VOICE_CATALOG.map((v) => (
              <label key={v.key} className="flex items-center gap-1.5 text-sm text-text-primary">
                <input type="checkbox" checked={picked.includes(v.key)} disabled={!picked.includes(v.key) && picked.length >= 3}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, v.key] : p.filter((x) => x !== v.key)))} />
                {v.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-xs text-text-secondary">Minimum calls per voice
          <input type="number" min={50} max={100000} value={minPerArm} onChange={(e) => setMinPerArm(Number(e.target.value))}
            className="focus-ring w-24 rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm" />
        </label>
        <button type="button" className={btn} disabled={busy !== null || !name.trim() || picked.length < 2}
          onClick={() => run('create', async () => { await createExperiment(name.trim(), picked, minPerArm); setName(''); setPicked([]); await load(); toast('Experiment created', 'success'); })}>
          {busy === 'create' ? <Loader2 size={14} className="animate-spin" /> : null} Create experiment
        </button>
      </div>

      {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
      {!rows && !loadError && <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
      {rows && rows.length === 0 && <EmptyStateInline text="No experiments yet." />}

      <ul className="space-y-2">
        {rows?.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
            <span className="text-sm text-text-primary">{r.name} <span className="text-xs text-text-secondary">· {r.status}{r.stop_reason ? ` (${r.stop_reason})` : ''}</span></span>
            <span className="flex gap-2">
              {r.status === 'draft' && (
                <button type="button" className={btn} disabled={busy !== null}
                  onClick={() => run(`s-${r.id}`, async () => { await startExperiment(r.id); await load(); toast('Experiment started', 'success'); })}><Play size={14} /> Start</button>
              )}
              {r.status === 'running' && (
                <button type="button" className={btn} disabled={busy !== null}
                  onClick={() => run(`x-${r.id}`, async () => { await stopExperiment(r.id); await load(); })}><Square size={14} /> Stop</button>
              )}
              <button type="button" className={btn} disabled={busy !== null}
                onClick={() => run(`r-${r.id}`, async () => { setReport(await experimentReport(r.id)); await load(); })}><BarChart3 size={14} /> Results</button>
            </span>
          </li>
        ))}
      </ul>

      {report && (
        <div className="mt-4" aria-live="polite">
          <p className="mb-2 text-sm font-medium text-text-primary">{report.name}</p>
          <p className="mb-3 text-xs text-text-secondary">
            {VERDICT[report.decision.status]}
            {report.decision.arm ? ` (${nameOf(report.arms.find((a) => a.key === report.decision.arm)?.voiceKey ?? '')})` : ''}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Results by voice</caption>
              <thead><tr className="text-text-secondary"><th scope="col" className="py-1 pr-3">Voice</th><th scope="col" className="pr-3">Calls</th><th scope="col" className="pr-3">Booked</th><th scope="col">Hung up</th></tr></thead>
              <tbody>
                {report.arms.map((a, i) => (
                  <tr key={a.key} className="text-text-primary">
                    <th scope="row" className="py-1 pr-3 font-medium">{nameOf(a.voiceKey)}{i === 0 ? ' (control)' : ''}</th>
                    <td className="pr-3">{a.calls} / {report.minPerArm}</td>
                    <td className="pr-3">{a.bookings} ({pct(a.bookingRate)})</td>
                    <td>{a.hangups} ({pct(a.hangupRate)})</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
