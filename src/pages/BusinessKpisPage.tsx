/**
 * Governed business KPIs — /dashboard/business-kpis (behind flag `analytics_layer`, default OFF).
 * KPIs come from the governed definitions in supabase/functions/_shared/analytics/customerKpis.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyNote } from '@/components/ui/EmptyNote';
import { useToast } from '@/contexts/ToastContext';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import {
  AnalyticsError, ackAlert, fetchCsv, fetchOverview, saveSettings, trackEvent, type AnalyticsOverview, type AnalyticsSettings,
} from '@/lib/analyticsApi';
import { downloadCsv, fmtDelta, fmtPct, fmtUsd, rangeFromDays } from '@/lib/analyticsFormat';
import type { MetricId } from '../../supabase/functions/_shared/analytics/customerKpis';

const RANGES = [{ days: 30, label: 'Last 30 days' }, { days: 90, label: 'Last 90 days' }, { days: 365, label: 'Last 12 months' }];
const TONE = { good: 'text-green-700', bad: 'text-red-700', flat: 'text-gray-500', none: 'text-gray-400' } as const;
const AR_LABELS: Record<string, string> = { current: 'Current', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: '90+ days' };

export function BusinessKpisPage() {
  const { toast } = useToast();
  const flagOn = useFeatureFlag('analytics_layer');
  const [days, setDays] = useState(90);
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('week');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'disabled'>('loading');
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);

  const range = useMemo(() => rangeFromDays(days), [days]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const d = await fetchOverview({ from: range.from, to: range.to, granularity, teamIds });
      setData(d);
      setState('ready');
      trackEvent('dashboard_viewed', { range_days: days, team_filtered: teamIds.length > 0 });
    } catch (e) {
      if (e instanceof AnalyticsError && e.code === 'not_enabled') setState('disabled');
      else { setMessage(e instanceof Error ? e.message : 'Could not load analytics.'); setState('error'); }
    }
  }, [range.from, range.to, granularity, teamIds, days]);

  useEffect(() => { void load(); }, [load]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { filename, csv } = await fetchCsv({ from: range.from, to: range.to, granularity, teamIds });
      downloadCsv(filename, csv);
      trackEvent('csv_exported', { granularity, range_days: days });
    } catch (e) { toast(e instanceof Error ? e.message : 'Export failed.', 'error'); } finally { setExporting(false); }
  };

  const update = async (patch: Partial<AnalyticsSettings>) => {
    setSaving(true);
    try {
      const r = await saveSettings(patch);
      setData((d) => (d ? { ...d, settings: r.settings } : d));
      if (patch.digestEnabled !== undefined) trackEvent('digest_toggled', { enabled: patch.digestEnabled, cadence: r.settings.digestCadence });
      toast('Settings saved.', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save settings.', 'error'); } finally { setSaving(false); }
  };

  const ack = async (id: string) => {
    try { await ackAlert(id); setData((d) => (d ? { ...d, alerts: d.alerts.map((a) => (a.id === id ? { ...a, acknowledged_at: new Date().toISOString() } : a)) } : d)); }
    catch { toast('Could not dismiss the alert.', 'error'); }
  };

  if (state === 'disabled' || (!flagOn && state !== 'ready' && state !== 'loading')) {
    return <main className="mx-auto max-w-3xl p-6"><EmptyNote>Analytics is not enabled for your account yet. Contact support to turn it on.</EmptyNote></main>;
  }

  const k = data?.kpis;
  const p = data?.previous;
  const empty = state === 'ready' && k && k.jobsCompleted === 0 && k.quotesSent === 0;

  const cards: { id: MetricId; value: string; delta: ReturnType<typeof fmtDelta> }[] = k && p && data ? [
    { id: 'first_time_fix_rate', value: fmtPct(k.firstTimeFixRateBp), delta: fmtDelta(k.firstTimeFixRateBp, p.firstTimeFixRateBp, 'pct', 'up') },
    { id: 'callback_rate', value: fmtPct(k.callbackRateBp), delta: fmtDelta(k.callbackRateBp, p.callbackRateBp, 'pct', 'down') },
    { id: 'revenue_per_technician', value: fmtUsd(k.revenuePerTechnicianCents), delta: fmtDelta(k.revenuePerTechnicianCents, p.revenuePerTechnicianCents, 'usd', 'up') },
    { id: 'job_profitability', value: fmtPct(k.jobProfitabilityBp), delta: fmtDelta(k.jobProfitabilityBp, p.jobProfitabilityBp, 'pct', 'up') },
    { id: 'utilization', value: fmtPct(k.utilizationBp), delta: fmtDelta(k.utilizationBp, p.utilizationBp, 'pct', 'up') },
    { id: 'quote_conversion', value: fmtPct(k.quoteConversionBp), delta: fmtDelta(k.quoteConversionBp, p.quoteConversionBp, 'pct', 'up') },
  ] : [];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6" aria-busy={state === 'loading'}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-sm text-gray-600">Governed business metrics. Every number follows one written definition.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm">Period
            <select className="ml-2 rounded border px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
            </select>
          </label>
          <label className="text-sm">Trend
            <select className="ml-2 rounded border px-2 py-1" value={granularity} onChange={(e) => setGranularity(e.target.value as 'day' | 'week' | 'month')}>
              <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option>
            </select>
          </label>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} loadingLabel="Exporting…" disabled={state !== 'ready'}>Export CSV</Button>
        </div>
      </header>

      {data && data.technicians.length > 0 && (
        <fieldset className="rounded border p-3">
          <legend className="px-1 text-sm font-medium">Team filter</legend>
          <div className="flex flex-wrap gap-3">
            {data.technicians.map((t) => (
              <label key={t.id} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={teamIds.includes(t.id)} onChange={(e) => setTeamIds((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))} />
                {t.name}
              </label>
            ))}
            {teamIds.length > 0 && <button type="button" className="text-sm underline" onClick={() => setTeamIds([])}>Clear</button>}
          </div>
          {teamIds.length > 0 && <p className="mt-2 text-xs text-gray-500">Quote conversion is not available for a team filter (quotes are not tied to a technician).</p>}
        </fieldset>
      )}

      {state === 'loading' && !data && <div role="status" className="flex items-center gap-2 text-gray-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading analytics…</div>}
      {state === 'error' && (
        <Card padding="md" interactive={false} error role="alert">
          <p className="mb-3 text-sm">{message}</p>
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        </Card>
      )}
      {empty && <EmptyNote>No completed jobs or sent quotes in this period yet. Metrics appear as soon as there is activity.</EmptyNote>}

      {state === 'ready' && data && k && !empty && (
        <>
          {data.truncated && <p role="status" className="rounded bg-amber-50 p-3 text-sm">This range is very large and was truncated. Narrow the period or the team filter.</p>}
          {data.alerts.filter((a) => !a.acknowledged_at).length > 0 && (
            <section aria-label="Alerts" className="space-y-2">
              {data.alerts.filter((a) => !a.acknowledged_at).map((a) => (
                <div key={a.id} className={`flex items-center justify-between rounded border p-3 text-sm ${a.bad ? 'border-red-300 bg-red-50' : 'border-blue-200 bg-blue-50'}`}>
                  <span><strong>{data.definitions[a.metric].label}</strong> moved {a.direction} to {a.metric === 'revenue_per_technician' ? fmtUsd(a.value) : fmtPct(a.value)} for {a.period_start} – {a.period_end} (usual {a.metric === 'revenue_per_technician' ? fmtUsd(a.baseline_mean) : fmtPct(a.baseline_mean)}).</span>
                  <Button size="sm" variant="ghost" onClick={() => { trackEvent('anomaly_alert_opened', { metric: a.metric, severity: a.severity }); void ack(a.id); }}>Dismiss</Button>
                </div>
              ))}
            </section>
          )}

          <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => (
              <Card key={c.id} padding="md" interactive={false}>
                <h2 className="text-sm font-medium text-gray-600" title={data.definitions[c.id].definition}>{data.definitions[c.id].label}</h2>
                <p className="mt-1 text-3xl font-semibold">{c.value}</p>
                <p className={`text-sm ${TONE[c.delta.tone]}`}>{c.delta.text} <span className="text-gray-400">vs previous period</span></p>
                <p className="mt-2 text-xs text-gray-500">{data.definitions[c.id].definition}</p>
              </Card>
            ))}
          </section>

          <Card padding="md" interactive={false}>
            <h2 className="mb-3 text-lg font-medium">Trend</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Metrics by period</caption>
                <thead><tr className="border-b"><th scope="col" className="py-2 pr-4">Period</th><th scope="col">Jobs</th><th scope="col">Revenue</th><th scope="col">First-time fix</th><th scope="col">Callbacks</th><th scope="col">Profitability</th><th scope="col">Utilization</th></tr></thead>
                <tbody>
                  {data.series.map((s) => (
                    <tr key={s.start} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-4 font-normal">{s.start}{s.end !== s.start ? ` – ${s.end}` : ''}</th>
                      <td>{s.values.jobsCompleted}</td><td>{fmtUsd(s.values.revenueCents)}</td><td>{fmtPct(s.values.firstTimeFixRateBp)}</td>
                      <td>{fmtPct(s.values.callbackRateBp)}</td><td>{fmtPct(s.values.jobProfitabilityBp)}</td><td>{fmtPct(s.values.utilizationBp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card padding="md" interactive={false}>
            <h2 className="mb-1 text-lg font-medium">{data.definitions.ar_aging.label}</h2>
            <p className="mb-3 text-sm text-gray-600">Open balance {fmtUsd(data.ar.totalCents)} · overdue {fmtUsd(data.ar.overdueCents)} ({fmtPct(data.ar.overdueShareBp)}) as of {data.ar.asOfDay}</p>
            <div className="grid gap-2 sm:grid-cols-5">
              {(Object.keys(AR_LABELS) as (keyof typeof data.ar.buckets)[]).map((b) => (
                <div key={b} className="rounded border p-3"><div className="text-xs text-gray-500">{AR_LABELS[b]}</div><div className="font-semibold">{fmtUsd(data.ar.buckets[b].cents)}</div><div className="text-xs text-gray-500">{data.ar.buckets[b].count} invoices</div></div>
              ))}
            </div>
          </Card>
        </>
      )}

      {data?.isOwner && (
        <Card padding="md" interactive={false}>
          <h2 className="mb-3 text-lg font-medium">Settings</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">Working hours per technician per day (utilization)
              <input type="number" min={1} max={24} step={0.5} defaultValue={data.settings.hoursPerDay} className="mt-1 block w-24 rounded border px-2 py-1"
                onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v <= 24 && v !== data.settings.hoursPerDay) void update({ hoursPerDay: v }); }} />
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.settings.alertsEnabled} disabled={saving} onChange={(e) => void update({ alertsEnabled: e.target.checked })} /> Alert me about unusual changes</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.settings.digestEnabled} disabled={saving} onChange={(e) => void update({ digestEnabled: e.target.checked })} /> Email me a digest</label>
            <label className="text-sm">Digest frequency
              <select className="ml-2 rounded border px-2 py-1" value={data.settings.digestCadence} disabled={saving || !data.settings.digestEnabled} onChange={(e) => void update({ digestCadence: e.target.value as 'weekly' | 'monthly' })}>
                <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
              </select>
            </label>
          </div>
        </Card>
      )}
    </main>
  );
}
