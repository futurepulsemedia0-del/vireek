import { useState } from 'react';
import { BarChart3, Camera, Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { InlineError, Pill, Stat, panelCls } from '@/components/acquisitions/acquisitionUi';
import { captureBaseline, describeAcquisitionError, saveBaseline } from '@/lib/acquisitionsApi';
import {
  KPI_KEYS, KPI_META, buildBaselineMetrics, formatKpi, formatPct, kpiDelta, retentionRisk, todayIso, type KpiKey, type KpiReport,
} from '@/lib/acquisitions';

interface Props {
  acquisitionId: string;
  currency: string;
  report: KpiReport | null;
  loading: boolean;
  error: string | null;
  canManage: boolean;
  onRetry: () => void;
  onChanged: () => void;
}

const centsToInput = (v: number) => String(Math.round(v) / 100);
const valueToInput = (k: KpiKey, v: number | null | undefined) => (v == null ? '' : KPI_META[k].unit === 'cents' ? centsToInput(v) : String(v));

export function DayOneDashboard({ acquisitionId, currency, report, loading, error, canManage, onRetry, onChanged }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Partial<Record<KpiKey, string>>>({});
  const [asOf, setAsOf] = useState(todayIso());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<KpiKey, string>>>({});

  if (loading) return <SkeletonCardList count={3} rows={3} />;
  if (error) return <InlineError message={error} onRetry={onRetry} />;
  if (!report) return <EmptyState icon={BarChart3} title="No dashboard yet" description="Reload the page to try again." action={{ label: 'Reload', onClick: onRetry }} />;

  const base = report.baseline?.metrics ?? null;
  const now = report.now;
  const parent = report.parent;
  const hasData = report.has_live_data && (now?.jobs_count ?? 0) > 0;

  const startEdit = () => {
    const next: Partial<Record<KpiKey, string>> = {};
    for (const k of KPI_KEYS) next[k] = valueToInput(k, base?.[k]);
    setValues(next); setAsOf(report.baseline?.as_of ?? todayIso()); setNote(report.baseline?.note ?? ''); setErrors({}); setEditing(true);
  };
  const submit = async () => {
    const { metrics, errors: e } = buildBaselineMetrics(values);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setBusy(true);
    try { await saveBaseline(acquisitionId, metrics, asOf, note); toast('Baseline saved.', 'success'); setEditing(false); onChanged(); }
    catch (err) { toast(describeAcquisitionError(err), 'error'); } finally { setBusy(false); }
  };
  const capture = async () => {
    setBusy(true);
    try { await captureBaseline(acquisitionId); toast('Baseline captured from live data.', 'success'); onChanged(); }
    catch (err) { toast(describeAcquisitionError(err), 'error'); } finally { setBusy(false); }
  };

  const risk = retentionRisk(now?.retention_pct, parent?.retention_pct);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Revenue, last 90 days" value={formatKpi('revenue_cents', now?.revenue_cents, currency)} sub={hasData ? undefined : 'No live data yet'} />
        <Stat label="Gross margin" value={formatPct(now?.gross_margin_pct)} sub={now?.margin_coverage_pct != null ? `${now.margin_coverage_pct}% of jobs costed` : 'Add job costs to measure'} />
        <Stat label="Utilization" value={formatPct(now?.utilization_pct)} sub={now?.technicians ? `${now.technicians} technicians` : undefined} />
        <Stat label="Retention" value={formatPct(now?.retention_pct)} sub={risk === 'unknown' ? undefined : `${now?.retention_at_risk ?? 0} customers at risk`} tone={risk === 'high' ? 'bad' : risk === 'low' ? 'good' : undefined} />
      </div>

      <div className={panelCls}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Day-one baseline vs your business</h3>
            <p className="text-xs text-text-secondary">
              {report.baseline
                ? `Baseline ${report.baseline.source === 'computed' ? 'captured from live data' : 'entered from the seller’s numbers'} as of ${report.baseline.as_of}.`
                : 'No baseline yet — capture or enter one to measure the integration against.'}
            </p>
          </div>
          {canManage && !editing && (
            <div className="flex flex-wrap gap-2">
              {report.has_live_data && <Button variant="secondary" size="sm" onClick={() => void capture()} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Camera size={14} aria-hidden="true" />} Capture from live data</Button>}
              <Button variant="secondary" size="sm" onClick={startEdit} disabled={busy}><Pencil size={14} aria-hidden="true" /> {report.baseline ? 'Edit baseline' : 'Enter baseline'}</Button>
            </div>
          )}
        </div>

        {editing ? (
          <div className="space-y-4">
            <p className="text-xs text-text-secondary">Fill what you know — money in dollars, percentages 0–100. Empty fields are left out.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {KPI_KEYS.map((k) => (
                <Input key={k} label={KPI_META[k].label} inputMode="decimal" value={values[k] ?? ''} error={errors[k]} helperText={KPI_META[k].help}
                  onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              ))}
              <Input label="As of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              <Input label="Source note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={() => void submit()} disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save baseline</Button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-secondary">
                  <th scope="col" className="py-2 pr-3 font-medium">KPI</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Your business</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Acquired · day one</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Acquired · now</th>
                  <th scope="col" className="py-2 text-right font-medium">Now vs your business</th>
                </tr>
              </thead>
              <tbody>
                {KPI_KEYS.map((k) => {
                  const d = kpiDelta(k, now?.[k], parent?.[k]);
                  return (
                    <tr key={k} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="py-2.5 pr-3 text-left font-medium text-text-primary" title={KPI_META[k].help}>{KPI_META[k].label}</th>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-text-secondary">{formatKpi(k, parent?.[k], currency)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-text-secondary">{formatKpi(k, base?.[k], currency)}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold tabular-nums text-text-primary">{formatKpi(k, now?.[k], currency)}</td>
                      <td className="py-2.5 text-right">{d ? <Pill tone={d.tone === 'good' ? 'good' : d.tone === 'bad' ? 'bad' : 'neutral'}>{d.label}</Pill> : <span className="text-text-secondary">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-text-secondary">“Your business” excludes everything imported for acquisitions. Utilization is a job-count proxy against your target jobs per technician-day.</p>
      </div>

      {!report.has_live_data && (
        <EmptyState icon={BarChart3} title="No live numbers for this acquisition yet"
          description={report.scope_kind === 'external' ? 'It isn’t on Vireek yet, so only the baseline you enter is shown. Switch its data source in Settings once you import or link it.' : 'Link an Import Wizard run (Data checks tab) or a franchise account to see live numbers.'} />
      )}
    </div>
  );
}
