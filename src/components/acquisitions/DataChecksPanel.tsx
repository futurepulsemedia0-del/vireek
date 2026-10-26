import { useMemo, useState } from 'react';
import { ClipboardCheck, ExternalLink, Loader2, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { Pill, panelCls, fieldCls, labelCls, type Tone } from '@/components/acquisitions/acquisitionUi';
import {
  deleteControl, describeAcquisitionError, linkImportJob, runDataChecks, saveControl, unlinkImportJob,
} from '@/lib/acquisitionsApi';
import { SOURCE_LABELS, STATUS_LABELS as IMPORT_STATUS_LABELS, type ImportJobRecord } from '@/lib/importWizard';
import {
  CONTROL_KEYS, CONTROL_META, checkSummary, evaluateControl, formatCents, latestRun, validateControl, type Acquisition, type CheckStatus, type ControlKey,
  type DataCheck, type SourceControl,
} from '@/lib/acquisitions';

interface Props {
  ownerId: string;
  acquisition: Acquisition;
  controls: SourceControl[];
  checks: DataCheck[];
  importJobs: ImportJobRecord[];
  importJobsError: string | null;
  linkedImportIds: string[];
  /** import_job_id -> acquisition_id for the whole account, so a run linked elsewhere cannot be linked twice. */
  allLinks: Record<string, string>;
  canManage: boolean;
  onControls: (list: SourceControl[]) => void;
  onLinks: (ids: string[]) => void;
  onChecksChanged: () => void;
}

const TONE: Record<CheckStatus, Tone> = { pass: 'good', warn: 'warn', fail: 'bad', skip: 'neutral' };
const LABEL: Record<CheckStatus, string> = { pass: 'Match', warn: 'Review', fail: 'Mismatch', skip: 'Pending' };
const VERDICT: Record<ReturnType<typeof checkSummary>['verdict'], { tone: Tone; text: string }> = {
  clean: { tone: 'good', text: 'Everything reconciles with the seller’s totals.' },
  review: { tone: 'warn', text: 'Mostly reconciled — review the warnings and pending items.' },
  blocked: { tone: 'bad', text: 'Do not cut over yet: at least one total does not match.' },
  none: { tone: 'neutral', text: 'No checks have been run yet.' },
};

function show(key: ControlKey, v: number | null): string {
  if (v == null) return '—';
  return CONTROL_META[key].money ? formatCents(v, 'USD') : Math.round(v).toLocaleString('en-US');
}
const inputValue = (key: ControlKey, c?: SourceControl) => (!c ? '' : CONTROL_META[key].money ? String(c.source_value / 100) : String(c.source_value));

export function DataChecksPanel(p: Props) {
  const { toast } = useToast();
  const byKey = useMemo(() => new Map(p.controls.map((c) => [c.metric_key, c])), [p.controls]);
  const [form, setForm] = useState<Record<ControlKey, { value: string; tolerance: string; label: string }>>(() => {
    const init = {} as Record<ControlKey, { value: string; tolerance: string; label: string }>;
    for (const k of CONTROL_KEYS) { const c = byKey.get(k); init[k] = { value: inputValue(k, c), tolerance: c ? String(c.tolerance_pct) : '0', label: c?.source_label ?? '' }; }
    return init;
  });
  const [errors, setErrors] = useState<Partial<Record<ControlKey, string>>>({});
  const [busy, setBusy] = useState<'save' | 'run' | string | null>(null);
  const run = latestRun(p.checks);
  const summary = checkSummary(run);
  const verdict = VERDICT[summary.verdict];
  const ranAt = run[0]?.checked_at ? new Date(run[0].checked_at).toLocaleString() : null;

  const saveAll = async () => {
    const nextErrors: Partial<Record<ControlKey, string>> = {};
    const writes: { key: ControlKey; value: number; tol: number; label: string }[] = [];
    const clears: SourceControl[] = [];
    for (const k of CONTROL_KEYS) {
      const f = form[k];
      if (f.value.trim() === '') { const existing = byKey.get(k); if (existing) clears.push(existing); continue; }
      const v = validateControl(k, f);
      if (v.value || v.tolerance) { nextErrors[k] = v.value ?? v.tolerance; continue; }
      writes.push({ key: k, value: CONTROL_META[k].money ? (v.cents as number) : (v.count as number), tol: f.tolerance.trim() === '' ? 0 : Number(f.tolerance), label: f.label });
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy('save');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const saved = await Promise.all(writes.map((w) => saveControl(p.ownerId, p.acquisition.id, w.key, w.value, w.tol, w.label, today)));
      await Promise.all(clears.map((c) => deleteControl(c.id, p.ownerId)));
      const keep = p.controls.filter((c) => !saved.some((s) => s.metric_key === c.metric_key) && !clears.some((x) => x.id === c.id));
      p.onControls([...keep, ...saved]);
      toast('Control totals saved.', 'success');
    } catch (e) { toast(describeAcquisitionError(e), 'error'); } finally { setBusy(null); }
  };

  const runChecks = async () => {
    setBusy('run');
    try { const r = await runDataChecks(p.acquisition.id); p.onChecksChanged(); toast(r.fail > 0 ? `${r.fail} check(s) failed.` : 'Checks finished.', r.fail > 0 ? 'error' : 'success'); }
    catch (e) { toast(describeAcquisitionError(e), 'error'); } finally { setBusy(null); }
  };

  const toggleLink = async (job: ImportJobRecord, linked: boolean) => {
    setBusy(job.id);
    try {
      if (linked) { await unlinkImportJob(p.ownerId, job.id); p.onLinks(p.linkedImportIds.filter((id) => id !== job.id)); }
      else { await linkImportJob(p.ownerId, p.acquisition.id, job.id); p.onLinks([...p.linkedImportIds, job.id]); }
    } catch (e) { toast(describeAcquisitionError(e), 'error'); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-5">
      {p.acquisition.scope_kind === 'imported' && (
        <section className={panelCls} aria-labelledby="imports-h">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 id="imports-h" className="text-sm font-semibold text-text-primary">Import runs for this business</h3>
              <p className="text-xs text-text-secondary">Only rows these runs created count as the acquired business. A rolled-back run drops out automatically.</p>
            </div>
            <Link to="/dashboard/imports" className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-accent hover:underline">Open Data Imports <ExternalLink size={12} aria-hidden="true" /></Link>
          </div>
          {p.importJobsError ? <p role="alert" className="text-sm text-danger">{p.importJobsError}</p> : p.importJobs.length === 0 ? (
            <EmptyState icon={ClipboardCheck} title="No import runs yet" description="Import the seller’s customers and jobs with the Import Wizard, then come back and link the runs." />
          ) : (
            <ul className="divide-y divide-border">
              {p.importJobs.map((j) => {
                const linked = p.linkedImportIds.includes(j.id);
                const elsewhere = !linked && Boolean(p.allLinks[j.id]);
                return (
                  <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{j.file_name ?? 'Import'} · {j.import_type}</p>
                      <p className="text-xs text-text-secondary">{SOURCE_LABELS[j.source] ?? j.source} · {IMPORT_STATUS_LABELS[j.status] ?? j.status} · {j.created_count} created · {j.error_count} errors · {new Date(j.created_at).toLocaleDateString()}</p>
                    </div>
                    {elsewhere ? <Pill>Linked to another acquisition</Pill> : (
                      <Button variant={linked ? 'secondary' : 'primary'} size="sm" disabled={!p.canManage || busy === j.id} onClick={() => void toggleLink(j, linked)}>
                        {busy === j.id && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{linked ? 'Unlink' : 'Link'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className={panelCls} aria-labelledby="controls-h">
        <h3 id="controls-h" className="text-sm font-semibold text-text-primary">Seller’s control totals</h3>
        <p className="mb-3 text-xs text-text-secondary">Type the totals from the seller’s system (money in dollars). Tolerance is how far Vireek may differ before we flag it.</p>
        <div className="space-y-3">
          {CONTROL_KEYS.map((k) => (
            <div key={k} className="grid gap-2 sm:grid-cols-[1.2fr_1fr_90px_1.2fr] sm:items-end">
              <div>
                <label htmlFor={`ctl-${k}`} className={labelCls}>{CONTROL_META[k].label}</label>
                <input id={`ctl-${k}`} inputMode="decimal" className={fieldCls} value={form[k].value} disabled={!p.canManage} aria-invalid={Boolean(errors[k])}
                  onChange={(e) => setForm({ ...form, [k]: { ...form[k], value: e.target.value } })} />
                {errors[k] && <span role="alert" className="mt-1 block text-xs text-danger">{errors[k]}</span>}
              </div>
              <div className="hidden text-xs text-text-secondary sm:block">{CONTROL_META[k].help}</div>
              <div>
                <label htmlFor={`tol-${k}`} className={labelCls}>Tolerance %</label>
                <input id={`tol-${k}`} inputMode="decimal" className={fieldCls} value={form[k].tolerance} disabled={!p.canManage}
                  onChange={(e) => setForm({ ...form, [k]: { ...form[k], tolerance: e.target.value } })} />
              </div>
              <div>
                <label htmlFor={`src-${k}`} className={labelCls}>Source report (optional)</label>
                <input id={`src-${k}`} className={fieldCls} maxLength={120} value={form[k].label} disabled={!p.canManage}
                  onChange={(e) => setForm({ ...form, [k]: { ...form[k], label: e.target.value } })} />
              </div>
            </div>
          ))}
        </div>
        {p.canManage && (
          <div className="mt-4 flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => void saveAll()} disabled={busy !== null}>{busy === 'save' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save totals</Button>
          </div>
        )}
      </section>

      <section className={panelCls} aria-labelledby="results-h">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="results-h" className="text-sm font-semibold text-text-primary">Reconciliation results</h3>
            <p className="text-xs text-text-secondary">{ranAt ? `Last run ${ranAt}` : 'Run the checks after each import or delta sync.'}</p>
          </div>
          {p.canManage && (
            <Button size="sm" onClick={() => void runChecks()} disabled={busy !== null}>{busy === 'run' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />} Run checks</Button>
          )}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2" aria-live="polite">
          <Pill tone={verdict.tone}>{verdict.text}</Pill>
          {run.length > 0 && <span className="text-xs text-text-secondary">{summary.pass} match · {summary.warn} review · {summary.fail} mismatch · {summary.skip} pending</span>}
        </div>
        {run.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="No results yet" description="Enter the seller’s totals above, then run the checks." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-text-secondary">
                <th scope="col" className="py-2 pr-3 font-medium">Check</th><th scope="col" className="py-2 pr-3 text-right font-medium">Seller</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Vireek</th><th scope="col" className="py-2 pr-3 text-right font-medium">Gap</th><th scope="col" className="py-2 font-medium">Result</th>
              </tr></thead>
              <tbody>
                {run.map((c) => {
                  const control = CONTROL_KEYS.includes(c.check_key as ControlKey);
                  const key = c.check_key as ControlKey;
                  const fmt = (v: number | null) => (control ? show(key, v) : v == null ? '—' : Math.round(v).toLocaleString('en-US'));
                  // Re-derive the band client-side so a stale row can never show a status that disagrees with its own numbers.
                  const status = control && c.source_value != null && c.actual_value != null && c.tolerance_pct != null ? evaluateControl(c.source_value, c.actual_value, c.tolerance_pct).status : c.status;
                  return (
                    <tr key={c.id} className="border-b border-border/60 align-top last:border-0">
                      <th scope="row" className="py-2.5 pr-3 text-left font-medium text-text-primary">{c.label}{c.detail && <span className="block text-xs font-normal text-text-secondary">{c.detail}</span>}</th>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-text-secondary">{control ? fmt(c.source_value) : '—'}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-text-primary">{fmt(c.actual_value)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-text-secondary">{c.diff_pct == null ? '—' : `${c.diff_pct}%`}</td>
                      <td className="py-2.5"><Pill tone={TONE[status]}>{LABEL[status]}</Pill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
