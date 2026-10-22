import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CloudSun, Headphones, Loader2, RefreshCw, Settings2, Sparkles, Users } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  CONFIDENCE_TONE,
  KIND_LABEL,
  KIND_LINK,
  SEVERITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  fetchLatestStaffingRun,
  fetchStaffingRunHistory,
  fetchStaffingSettings,
  fmtDay,
  fmtHour,
  fmtMoney,
  fmtPct,
  runStaffingForecast,
  updateStaffingSettings,
  type CapStatus,
  type StaffingForecastResult,
  type StaffingReport,
  type StaffingRunSummary,
  type StaffingSettingsRow,
} from '@/lib/staffingForecast';

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}>{children}</span>;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

const BAR_TONE: Record<CapStatus, string> = {
  low: 'fill-warning-500',
  optimal: 'fill-success-500',
  full: 'fill-danger',
  no_capacity: 'fill-text-secondary',
  closed: 'fill-text-secondary',
};

/** Forecast jobs (bar) with p10–p90 range (whisker) against technician capacity (tick), next 14 days. */
function DemandChart({ daily }: { daily: StaffingReport['daily'] }) {
  const W = 640;
  const H = 200;
  const P = { l: 34, r: 8, t: 10, b: 26 };
  const max = Math.max(4, ...daily.map((d) => Math.max(d.jobs.p90, d.tech_capacity_jobs)));
  const top = Math.ceil(max / 2) * 2;
  const bw = (W - P.l - P.r) / Math.max(1, daily.length);
  const y = (v: number) => P.t + (1 - v / top) * (H - P.t - P.b);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Forecast jobs per day with uncertainty range compared to technician capacity for the next 14 days"
    >
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={y(top * t)} y2={y(top * t)} className="stroke-border" strokeWidth={1} />
          <text x={P.l - 6} y={y(top * t) + 3} textAnchor="end" className="fill-text-secondary text-[10px]">
            {Math.round(top * t)}
          </text>
        </g>
      ))}
      {daily.map((d, i) => {
        const x = P.l + i * bw;
        const cx = x + bw / 2;
        return (
          <g key={d.date}>
            <rect x={x + bw * 0.2} width={bw * 0.6} y={y(d.jobs.p50)} height={Math.max(0, y(0) - y(d.jobs.p50))} rx={3} className={BAR_TONE[d.status]} opacity={0.85} />
            <line x1={cx} x2={cx} y1={y(d.jobs.p90)} y2={y(d.jobs.p10)} className="stroke-text-secondary" strokeWidth={1.5} />
            {d.tech_capacity_jobs > 0 && (
              <line x1={x + bw * 0.1} x2={x + bw * 0.9} y1={y(d.tech_capacity_jobs)} y2={y(d.tech_capacity_jobs)} className="stroke-text-primary" strokeWidth={2} strokeDasharray="4 3" />
            )}
            <text x={cx} y={H - 8} textAnchor="middle" className="fill-text-secondary text-[10px]">
              {d.weekday.slice(0, 2)} {d.date.slice(8)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 8-week projected utilization against the account's own low / full thresholds. */
function WeeklyChart({ report }: { report: StaffingReport }) {
  const W = 640;
  const H = 180;
  const P = { l: 34, r: 8, t: 10, b: 26 };
  const weeks = report.weekly;
  const top = Math.max(120, Math.ceil(Math.max(...weeks.map((w) => w.utilization_p90_pct ?? 0)) / 20) * 20);
  const bw = (W - P.l - P.r) / weeks.length;
  const y = (v: number) => P.t + (1 - v / top) * (H - P.t - P.b);
  const { low_threshold_pct: low, full_threshold_pct: full } = report.capacity;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Projected technician utilization for the next 8 weeks against your low and full thresholds">
      {[low, full, 100].map((t, i) => (
        <g key={`${t}-${i}`}>
          <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className={t === 100 ? 'stroke-border' : 'stroke-text-secondary'} strokeDasharray={t === 100 ? undefined : '4 3'} strokeWidth={1} />
          <text x={P.l - 6} y={y(t) + 3} textAnchor="end" className="fill-text-secondary text-[10px]">{t}%</text>
        </g>
      ))}
      {weeks.map((w, i) => {
        const x = P.l + i * bw;
        const cx = x + bw / 2;
        const u = w.utilization_pct ?? 0;
        return (
          <g key={w.week_start}>
            <rect x={x + bw * 0.2} width={bw * 0.6} y={y(u)} height={Math.max(0, y(0) - y(u))} rx={3} className={BAR_TONE[w.status]} opacity={0.85} />
            {w.utilization_p10_pct !== null && w.utilization_p90_pct !== null && (
              <line x1={cx} x2={cx} y1={y(w.utilization_p90_pct)} y2={y(w.utilization_p10_pct)} className="stroke-text-secondary" strokeWidth={1.5} />
            )}
            <text x={cx} y={H - 8} textAnchor="middle" className="fill-text-secondary text-[10px]">{w.week_start.slice(5)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Next 7 days x 24 hours: human-handled call demand vs CSR coverage. */
function CoverageHeatmap({ hourly }: { hourly: StaffingReport['hourly'] }) {
  const dates = [...new Set(hourly.map((h) => h.date))];
  const maxHuman = Math.max(0.5, ...hourly.map((h) => h.human_calls));
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="ml-16 grid grid-cols-24 gap-px text-[10px] text-text-secondary" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center">{h % 3 === 0 ? fmtHour(h) : ''}</span>
          ))}
        </div>
        {dates.map((d) => (
          <div key={d} className="mt-px flex items-center">
            <span className="w-16 shrink-0 pr-2 text-right text-[11px] text-text-secondary">{fmtDay(d).split(',')[0]}</span>
            <div className="grid flex-1 gap-px" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
              {hourly.filter((h) => h.date === d).map((h) => {
                const gap = h.gap > 0.25;
                const tone = gap ? 'bg-danger' : h.open ? 'bg-success-500' : 'bg-warning-500';
                const opacity = h.human_calls <= 0.01 && !h.open ? 0.06 : 0.12 + 0.88 * Math.min(1, h.human_calls / maxHuman);
                return (
                  <span
                    key={h.hour}
                    className={`h-5 rounded-sm ${tone}`}
                    style={{ opacity }}
                    title={`${fmtDay(d)} ${fmtHour(h.hour)} — ${h.calls} calls, ${h.human_calls} need a person, ${h.csr_available} CSR on, ${h.csr_required} needed`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-text-secondary">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-success-500" /> Covered (open hours)</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-danger" /> CSR gap</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-warning-500" /> After hours (AI only)</span>
        <span>Darker = more callers asking for a person</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function SettingsPanel({ settings, onSaved }: { settings: StaffingSettingsRow; onSaved: (s: StaffingSettingsRow) => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    calls_per_csr_hour: String(settings.calls_per_csr_hour),
    csr_target_occupancy_pct: String(settings.csr_target_occupancy_pct),
    csr_concurrent_override: settings.csr_concurrent_override === null ? '' : String(settings.csr_concurrent_override),
    avg_job_minutes_override: settings.avg_job_minutes_override === null ? '' : String(settings.avg_job_minutes_override),
    tech_hourly: settings.tech_hourly_cost_cents === null ? '' : String(settings.tech_hourly_cost_cents / 100),
    csr_hourly: settings.csr_hourly_cost_cents === null ? '' : String(settings.csr_hourly_cost_cents / 100),
    overtime_multiplier: String(settings.overtime_multiplier),
    tech_paid_hours_per_day: String(settings.tech_paid_hours_per_day),
    sustained_weeks_to_hire: String(settings.sustained_weeks_to_hire),
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const blankOrNum = (v: string): number | null => (v.trim() === '' ? null : Number(v));

  const save = async () => {
    const nums = [form.calls_per_csr_hour, form.csr_target_occupancy_pct, form.overtime_multiplier, form.tech_paid_hours_per_day, form.sustained_weeks_to_hire];
    if (nums.some((v) => v.trim() === '' || !Number.isFinite(Number(v)))) {
      toast('Please fill in every required number.', 'error');
      return;
    }
    const opt = [form.csr_concurrent_override, form.avg_job_minutes_override, form.tech_hourly, form.csr_hourly];
    if (opt.some((v) => v.trim() !== '' && !Number.isFinite(Number(v)))) {
      toast('Optional fields must be numbers or left blank.', 'error');
      return;
    }
    setSaving(true);
    try {
      const techHourly = blankOrNum(form.tech_hourly);
      const csrHourly = blankOrNum(form.csr_hourly);
      const saved = await updateStaffingSettings({
        calls_per_csr_hour: Number(form.calls_per_csr_hour),
        csr_target_occupancy_pct: Math.round(Number(form.csr_target_occupancy_pct)),
        csr_concurrent_override: blankOrNum(form.csr_concurrent_override) === null ? null : Math.round(Number(form.csr_concurrent_override)),
        avg_job_minutes_override: blankOrNum(form.avg_job_minutes_override) === null ? null : Math.round(Number(form.avg_job_minutes_override)),
        tech_hourly_cost_cents: techHourly === null ? null : Math.round(techHourly * 100),
        csr_hourly_cost_cents: csrHourly === null ? null : Math.round(csrHourly * 100),
        overtime_multiplier: Number(form.overtime_multiplier),
        tech_paid_hours_per_day: Number(form.tech_paid_hours_per_day),
        sustained_weeks_to_hire: Math.round(Number(form.sustained_weeks_to_hire)),
      });
      onSaved(saved);
      toast('Staffing assumptions saved. Re-run the forecast to apply them.', 'success');
    } catch {
      toast('Could not save. Check that every value is in range.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-6 p-6">
      <h2 className="text-sm font-semibold text-text-primary">Staffing assumptions</h2>
      <p className="mt-1 text-xs text-text-secondary">
        Wages are optional and only used to estimate costs — leave them blank to see no dollar figures. Only owners and admins can see or change this.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Input label="Calls one CSR handles per hour" type="number" min={0.5} max={30} step={0.5} value={form.calls_per_csr_hour} onChange={set('calls_per_csr_hour')} />
        <Input label="CSR target occupancy (%)" type="number" min={30} max={95} value={form.csr_target_occupancy_pct} onChange={set('csr_target_occupancy_pct')} />
        <Input label="CSRs on phones at once (optional)" type="number" min={0} max={50} value={form.csr_concurrent_override} onChange={set('csr_concurrent_override')} helperText="Blank = count of active member / CSR / dispatcher team members" />
        <Input label="Average job length, minutes (optional)" type="number" min={10} max={960} value={form.avg_job_minutes_override} onChange={set('avg_job_minutes_override')} helperText="Blank = learned from your last 90 days" />
        <Input label="Technician hourly wage, $ (optional)" type="number" min={0} step={0.5} value={form.tech_hourly} onChange={set('tech_hourly')} />
        <Input label="CSR hourly wage, $ (optional)" type="number" min={0} step={0.5} value={form.csr_hourly} onChange={set('csr_hourly')} />
        <Input label="Overtime multiplier" type="number" min={1} max={3} step={0.1} value={form.overtime_multiplier} onChange={set('overtime_multiplier')} />
        <Input label="Paid hours per technician-day" type="number" min={4} max={14} step={0.5} value={form.tech_paid_hours_per_day} onChange={set('tech_paid_hours_per_day')} />
        <Input label="Weeks over capacity before recommending a hire" type="number" min={1} max={8} value={form.sustained_weeks_to_hire} onChange={set('sustained_weeks_to_hire')} />
      </div>
      <div className="mt-4">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save assumptions'}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function StaffingForecastPage() {
  const { toast } = useToast();
  const [result, setResult] = useState<StaffingForecastResult | null>(null);
  const [settings, setSettings] = useState<StaffingSettingsRow | null>(null);
  const [history, setHistory] = useState<StaffingRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [latest, s, h] = await Promise.all([fetchLatestStaffingRun(), fetchStaffingSettings(), fetchStaffingRunHistory()]);
      setResult(latest);
      setSettings(s);
      setHistory(h);
    } catch {
      setError('Only the account owner or an admin can view the staffing forecast, or it failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await runStaffingForecast();
      setResult(r);
      setHistory(await fetchStaffingRunHistory());
      if (!r.persisted) toast('Forecast built, but it could not be saved to history.', 'info');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Forecast failed.';
      setError(msg);
      toast(msg, 'error');
    } finally {
      setRunning(false);
    }
  }, [toast]);

  const report = result?.report ?? null;
  const ok = report?.status === 'ok';
  const generated = useMemo(() => (report ? new Date(report.generated_at).toLocaleString() : null), [report]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <CalendarClock size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Staffing Forecast</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                Predicts hourly call volume and daily job demand from your history, the weekday, the season, the weather and your regional trend — then compares it to technician capacity and CSR/AI coverage to recommend hiring, overtime or schedule changes.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSettings((v) => !v)} disabled={!settings}>
              <Settings2 size={14} /> Assumptions
            </Button>
            <Button size="sm" onClick={run} disabled={running || loading}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {running ? 'Forecasting…' : report ? 'Re-run forecast' : 'Run forecast'}
            </Button>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-6 flex items-start gap-2 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {loading && (
          <Card className="flex items-center gap-3 p-6 text-sm text-text-secondary" aria-busy="true">
            <Loader2 size={16} className="animate-spin" /> Loading your latest forecast…
          </Card>
        )}

        {!loading && !report && !error && (
          <Card className="p-8 text-center">
            <Users size={28} className="mx-auto text-accent" />
            <h2 className="mt-3 text-base font-semibold text-text-primary">No forecast yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">
              Run your first forecast. It needs at least three weeks of call or job history; the more history, the more accurate it gets.
            </p>
            <Button className="mt-4" onClick={run} disabled={running}>
              <Sparkles size={14} /> Run forecast
            </Button>
          </Card>
        )}

        {report && !ok && (
          <Card className="p-6">
            <h2 className="text-sm font-semibold text-text-primary">Not enough history yet</h2>
            {report.recommendations.map((r) => (
              <p key={r.id} className="mt-2 text-sm text-text-secondary">{r.detail}</p>
            ))}
          </Card>
        )}

        {report && ok && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
              <Pill className={CONFIDENCE_TONE[report.confidence]}>{report.confidence} confidence</Pill>
              <span>Generated {generated}</span>
              {report.accuracy.jobs_wape !== null && (
                <span>Back-test error on jobs: {Math.round(report.accuracy.jobs_wape * 100)}% over the last {report.accuracy.backtest_days} days</span>
              )}
              <span className="flex items-center gap-1">
                <CloudSun size={12} />
                {report.data_quality.weather === 'used' ? 'Weather-adjusted' : report.data_quality.weather === 'no_signal' ? 'Weather checked, no measurable effect' : 'Weather unavailable'}
              </span>
            </div>

            {report.data_quality.notes.length > 0 && (
              <ul className="mb-6 list-disc space-y-1 rounded-2xl border border-border bg-bg-secondary p-4 pl-8 text-xs text-text-secondary">
                {report.data_quality.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}

            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Technician utilization, next 7 days" value={fmtPct(report.headline.next7_avg_utilization_pct)} sub={`${report.headline.next7_jobs} jobs forecast`} />
              <Kpi label="Peak day" value={report.headline.peak_day ? fmtDay(report.headline.peak_day) : '—'} sub={fmtPct(report.headline.peak_utilization_pct) + ' of capacity'} />
              <Kpi label="Jobs over capacity, next 14 days" value={String(report.headline.next14_deficit_jobs)} sub={report.headline.next14_deficit_jobs > 0 ? 'Needs rebalancing or overtime' : 'Within capacity'} />
              <Kpi label="Callers needing a person, next 7 days" value={String(Math.round(report.headline.next7_human_calls))} sub={`${report.headline.next7_csr_gap_hours} CSR-hours short`} />
            </div>

            <Card className="mb-6 p-6">
              <h2 className="mb-4 text-sm font-semibold text-text-primary">Recommendations</h2>
              <ul className="space-y-3">
                {report.recommendations.map((r) => {
                  const link = KIND_LINK[r.kind];
                  return (
                    <li key={r.id} className="rounded-2xl border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill className={SEVERITY_TONE[r.severity]}>{KIND_LABEL[r.kind]}</Pill>
                        <h3 className="text-sm font-semibold text-text-primary">{r.title}</h3>
                      </div>
                      <p className="mt-2 text-sm text-text-secondary">{r.detail}</p>
                      {r.evidence.length > 0 && (
                        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
                          {r.evidence.map((e) => <li key={e}>{e}</li>)}
                        </ul>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                        {r.est_cost_cents !== null && <span className="font-semibold text-text-primary">≈ {fmtMoney(r.est_cost_cents)}</span>}
                        <span>{r.confidence} confidence</span>
                        {link && <Link to={link.href} className="font-semibold text-accent hover:underline">{link.label}</Link>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {result?.insights && result.insights.length > 0 && (
                <div className="mt-5 border-t border-border pt-4">
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary"><Sparkles size={12} /> AI summary</h3>
                  <ul className="space-y-2">
                    {result.insights.map((i) => (
                      <li key={i.title} className="text-sm">
                        <p className="font-semibold text-text-primary">{i.title}</p>
                        <p className="text-text-secondary">{i.description}</p>
                        <p className="text-text-secondary"><span className="font-semibold">Next step:</span> {i.recommended_action}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            <Card className="mb-6 p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">Job demand vs technician capacity — next 14 days</h2>
                <span className="text-xs text-text-secondary">Bar = expected jobs · line = p10–p90 range · dashes = capacity</span>
              </div>
              <DemandChart daily={report.daily} />
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="text-text-secondary">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Day</th>
                      <th className="pr-3 font-medium">Weather</th>
                      <th className="pr-3 font-medium">Calls</th>
                      <th className="pr-3 font-medium">Jobs (range)</th>
                      <th className="pr-3 font-medium">Booked</th>
                      <th className="pr-3 font-medium">Capacity</th>
                      <th className="pr-3 font-medium">Utilization</th>
                      <th className="pr-3 font-medium">Person-calls</th>
                      <th className="font-medium">CSR gap (h)</th>
                    </tr>
                  </thead>
                  <tbody className="text-text-primary">
                    {report.daily.map((d) => (
                      <tr key={d.date} className="border-t border-border">
                        <td className="py-2 pr-3 font-medium">{fmtDay(d.date)}</td>
                        <td className="pr-3 text-text-secondary">
                          {d.weather?.mean_f != null ? `${Math.round(d.weather.mean_f)}°F${d.weather.precip_in ? ` · ${d.weather.precip_in}"` : ''}` : '—'}
                        </td>
                        <td className="pr-3">{d.calls.p50}</td>
                        <td className="pr-3">{d.jobs.p50} <span className="text-text-secondary">({d.jobs.p10}–{d.jobs.p90})</span></td>
                        <td className="pr-3">{d.jobs_booked}</td>
                        <td className="pr-3">{d.tech_capacity_jobs || '—'}</td>
                        <td className="pr-3"><Pill className={STATUS_TONE[d.status]}>{d.utilization_pct !== null ? `${Math.round(d.utilization_pct)}% · ` : ''}{STATUS_LABEL[d.status]}</Pill></td>
                        <td className="pr-3">{d.human_calls}</td>
                        <td className={d.csr_gap_hours > 0 ? 'font-semibold text-danger' : ''}>{d.csr_gap_hours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="mb-6 p-6">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary"><Headphones size={14} /> Call volume and CSR / AI coverage — next 7 days</h2>
              <p className="mb-4 text-xs text-text-secondary">
                Your AI answers every call around the clock. This shows only the calls where the caller asks for a person, against the CSRs you have on the phones ({report.capacity.csr_concurrent} at once).
              </p>
              <CoverageHeatmap hourly={report.hourly} />
            </Card>

            <Card className="mb-6 p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">8-week outlook — technician utilization</h2>
                <span className="text-xs text-text-secondary">Dashed lines: your low ({report.capacity.low_threshold_pct}%) and full ({report.capacity.full_threshold_pct}%) thresholds from Capacity Demand Control</span>
              </div>
              <WeeklyChart report={report} />
              <p className="mt-2 text-xs text-text-secondary">Weeks beyond day 14 use calendar and seasonal patterns only (no weather forecast), so their ranges are wider.</p>
            </Card>

            <Card className="p-6">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">What drives this forecast</h2>
              <div className="grid gap-4 text-xs text-text-secondary sm:grid-cols-2">
                <div>
                  <p className="mb-1 font-semibold text-text-primary">Weekday pattern (jobs, 1.0 = average day)</p>
                  {report.drivers.weekday_factors_jobs
                    ? <p>{Object.entries(report.drivers.weekday_factors_jobs).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
                    : <p>Not enough job history.</p>}
                </div>
                <div>
                  <p className="mb-1 font-semibold text-text-primary">Weather sensitivity</p>
                  {report.drivers.weather
                    ? <p>Demand moves about {report.drivers.weather.hot_per_f_pct}% per °F hotter than normal and {report.drivers.weather.cold_per_f_pct}% per °F colder than normal (explains {Math.round(report.drivers.weather.r2 * 100)}% of day-to-day variation).</p>
                    : <p>No measurable weather effect found (or weather unavailable).</p>}
                </div>
                <div>
                  <p className="mb-1 font-semibold text-text-primary">Regional trend</p>
                  {report.drivers.regional
                    ? <p>{report.drivers.regional.label}: regional calls {report.drivers.regional.region_change_pct ?? '—'}% week over week vs your {report.drivers.regional.local_change_pct ?? '—'}%. Nudge applied: {report.drivers.regional.applied_pct}% (fades over a week).</p>
                    : <p>No regional data for your area and trade yet (needs at least 5 similar businesses).</p>}
                </div>
                <div>
                  <p className="mb-1 font-semibold text-text-primary">Model basis</p>
                  <p>{report.data_quality.jobs_days} days of jobs, {report.data_quality.calls_days} days of calls · average job {report.data_quality.job_hours} h ({report.data_quality.job_hours_source}) · seasonality {report.data_quality.seasonality === 'used' ? 'on' : 'off (needs ~11 months)'}.</p>
                </div>
              </div>
            </Card>
          </>
        )}

        {showSettings && settings && <SettingsPanel settings={settings} onSaved={setSettings} />}

        {history.length > 1 && (
          <Card className="mt-6 p-6">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent forecasts</h2>
            <ul className="divide-y divide-border text-xs text-text-secondary">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{new Date(h.created_at).toLocaleString()}</span>
                  <span>Utilization next 7d: {fmtPct(h.headline.next7_avg_utilization_pct)} · over capacity (14d): {h.headline.next14_deficit_jobs} jobs</span>
                  <Pill className={CONFIDENCE_TONE[h.confidence]}>{h.confidence}</Pill>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
