import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, BellRing, CheckCircle2, KeyRound, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { UsageChart } from '@/components/apiUsage/UsageChart';
import {
  DEFAULT_RULES,
  RANGES,
  RATE_LIMIT_PER_MINUTE,
  alertDetail,
  alertTitle,
  errorCount,
  errorRate,
  formatCount,
  formatMs,
  formatPct,
  formatRelative,
  friendlyUsageError,
  keyHealth,
  rulesEqual,
  totals,
  validateRules,
  type AlertEvent,
  type AlertRules,
  type Breach,
  type KeyHealth,
  type RangeHours,
  type UsagePoint,
  type UsageSummaryRow,
} from '@/lib/apiUsage';
import {
  fetchAlertEvents,
  fetchAlertRules,
  fetchBreaches,
  fetchUsageKeys,
  fetchUsageSeries,
  fetchUsageSummary,
  saveAlertRules,
  type UsageKey,
} from '@/lib/apiUsageApi';

const LABEL = 'API Usage';
const REFRESH_MS = 60_000;
const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const HEALTH_STYLE: Record<KeyHealth, { label: string; cls: string }> = {
  idle: { label: 'No traffic', cls: 'bg-bg-tertiary text-text-secondary' },
  healthy: { label: 'Healthy', cls: 'bg-success/10 text-success' },
  warning: { label: 'Needs attention', cls: 'bg-warning-500/10 text-warning-500' },
  critical: { label: 'Critical', cls: 'bg-danger/10 text-danger' },
};

function HealthBadge({ health }: { health: KeyHealth }) {
  const s = HEALTH_STYLE[health];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' | 'warning' }) {
  return (
    <Card className="p-4 hover:translate-y-0">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-text-secondary">{sub}</p>}
    </Card>
  );
}

function NumberField({ label, error, value, onChange, suffix, step }: { label: string; error?: string; value: number; onChange: (n: number) => void; suffix?: string; step?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-text-secondary">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" inputMode="decimal" step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} aria-invalid={!!error} className={inputCls} />
        {suffix && <span className="shrink-0 text-xs text-text-secondary">{suffix}</span>}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function ApiUsagePage() {
  const { profile, isOwner } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const ownerId = isOwner ? profile?.id : undefined;

  const [hours, setHours] = useState<RangeHours>(24);
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [keys, setKeys] = useState<UsageKey[]>([]);
  const [summary, setSummary] = useState<UsageSummaryRow[]>([]);
  const [series, setSeries] = useState<UsagePoint[]>([]);
  const [breaches, setBreaches] = useState<Breach[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [savedRules, setSavedRules] = useState<AlertRules>({ ...DEFAULT_RULES });
  const [draft, setDraft] = useState<AlertRules>({ ...DEFAULT_RULES });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const reqId = useRef(0);
  const seriesReq = useRef(0);
  const keyFilterRef = useRef<string | null>(null);
  const savedRef = useRef<AlertRules>({ ...DEFAULT_RULES });

  const load = useCallback(
    async (initial: boolean) => {
      if (!ownerId) return;
      const id = ++reqId.current;
      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(false);
      try {
        const [k, s, b, ev, rules, ts] = await Promise.all([
          fetchUsageKeys(ownerId),
          fetchUsageSummary(ownerId, hours),
          fetchBreaches(ownerId),
          fetchAlertEvents(ownerId),
          fetchAlertRules(ownerId),
          fetchUsageSeries(ownerId, hours, keyFilterRef.current),
        ]);
        if (id !== reqId.current) return;
        setKeys(k);
        setSummary(s);
        setBreaches(b);
        setEvents(ev);
        setSavedRules(rules);
        setDraft((d) => (rulesEqual(d, savedRef.current) ? rules : d));
        savedRef.current = rules;
        setSeries(ts);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (id !== reqId.current) return;
        if (initial) setError(true);
        else toast(friendlyUsageError(err, 'Could not refresh usage.'), 'error');
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [ownerId, hours, toast],
  );

  useEffect(() => {
    load(true);
  }, [load]);

  useEffect(() => {
    if (!ownerId) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load(false);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [ownerId, load]);

  const loadSeries = useCallback(
    async (key: string | null) => {
      if (!ownerId) return;
      const id = ++seriesReq.current;
      setSeriesLoading(true);
      try {
        const ts = await fetchUsageSeries(ownerId, hours, key);
        if (id === seriesReq.current) setSeries(ts);
      } catch {
        if (id === seriesReq.current) toast('Could not load the chart for this key.', 'error');
      } finally {
        if (id === seriesReq.current) setSeriesLoading(false);
      }
    },
    [ownerId, hours, toast],
  );

  const selectKey = (id: string | null) => {
    const next = id === keyFilter ? null : id;
    keyFilterRef.current = next;
    setKeyFilter(next);
    loadSeries(next);
  };

  const keyById = useMemo(() => new Map(keys.map((k) => [k.id, k])), [keys]);
  const summaryById = useMemo(() => new Map(summary.map((s) => [s.key_id, s])), [summary]);
  const rows = useMemo(() => {
    const ids = new Set<string>([...keys.filter((k) => !k.revoked_at).map((k) => k.id), ...summary.map((s) => s.key_id)]);
    return [...ids]
      .map((id) => ({ id, key: keyById.get(id), stats: summaryById.get(id) }))
      .sort((a, b) => (b.stats?.requests ?? 0) - (a.stats?.requests ?? 0));
  }, [keys, summary, keyById, summaryById]);
  const t = useMemo(() => totals(summary), [summary]);
  const ruleErrors = useMemo(() => validateRules(draft), [draft]);
  const rulesDirty = !rulesEqual(draft, savedRules);
  const keyName = (id: string) => keyById.get(id)?.name ?? 'Deleted key';

  const handleSaveRules = async () => {
    if (!ownerId) return;
    if (Object.keys(ruleErrors).length) {
      toast('Fix the highlighted alert settings first.', 'error');
      return;
    }
    setSaving(true);
    try {
      const next = await saveAlertRules(ownerId, draft);
      setSavedRules(next);
      savedRef.current = next;
      setDraft(next);
      setBreaches(await fetchBreaches(ownerId).catch(() => breaches));
      toast('Alert settings saved.', 'success');
    } catch (err) {
      toast(friendlyUsageError(err, 'Could not save alert settings.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const patch = <K extends keyof AlertRules>(k: K, v: AlertRules[K]) => setDraft((d) => ({ ...d, [k]: v }));

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <ShieldAlert className="mx-auto mb-3 text-text-secondary" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Owner access only</h3>
          <p className="mt-1.5 text-sm text-text-secondary">Only the account owner can view API usage, the same as API keys.</p>
        </div>
      </DashboardLayout>
    );
  }

  const hasKeys = keys.some((k) => !k.revoked_at) || summary.length > 0;
  const hasTraffic = t.requests > 0;

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Activity size={22} /> API Usage</h1>
          <p className="mt-1 text-sm text-text-secondary">Request volume, errors, latency and rate-limit hits for the Vireek API (api-v1), per key.</p>
        </div>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-xl border border-border bg-bg-primary p-1">
            {RANGES.map((r) => (
              <button key={r.hours} type="button" role="radio" aria-checked={hours === r.hours} onClick={() => setHours(r.hours)} className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium ${hours === r.hours ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => load(false)} disabled={loading || refreshing} aria-label="Refresh" className="focus-ring flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary disabled:opacity-50">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading API usage">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
          <div className="h-56 animate-pulse rounded-2xl bg-bg-tertiary" />
          <div className="h-48 animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <AlertTriangle className="mx-auto mb-3 text-warning-500" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Couldn’t load API usage</h3>
          <p className="mt-1.5 text-sm text-text-secondary">Check your connection and try again.</p>
          <button type="button" onClick={() => load(true)} className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"><RefreshCw size={14} /> Retry</button>
        </div>
      ) : !hasKeys ? (
        <EmptyState icon={KeyRound} title="No API keys yet" description="Create an API key to start using the Vireek API. Usage appears here as soon as requests arrive." action={{ label: 'Create an API key', onClick: () => navigate('/dashboard/settings/api-keys') }} />
      ) : (
        <div className="space-y-6">
          {breaches.length > 0 ? (
            <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-danger"><AlertTriangle size={16} /> {breaches.length} active alert{breaches.length === 1 ? '' : 's'}</p>
              <ul className="mt-2 space-y-1.5">
                {breaches.map((b) => (
                  <li key={`${b.key_id}-${b.kind}`} className="text-sm text-text-primary">
                    <span className="font-medium">{alertTitle(b.kind)}</span> · {keyName(b.key_id)} — <span className="text-text-secondary">{alertDetail(b)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            savedRules.enabled && hasTraffic && (
              <p className="flex items-center gap-2 text-sm text-text-secondary"><CheckCircle2 size={16} className="text-success" /> All keys are within your alert thresholds.</p>
            )
          )}

          {!hasTraffic && (
            <Card className="p-5 hover:translate-y-0">
              <h2 className="text-sm font-semibold text-text-primary">No requests in this period</h2>
              <p className="mt-1 text-xs text-text-secondary">Send a request with one of your keys and refresh. Requests that fail authentication are not attributed to a key and are not counted.</p>
              <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-bg-primary p-3 text-[11px] text-text-primary"><code>{`curl -H "Authorization: Bearer vrk_live_..." \\\n  "${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://<project>.supabase.co'}/functions/v1/api-v1/calls?limit=1"`}</code></pre>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Requests" value={formatCount(t.requests)} sub={`last ${RANGES.find((r) => r.hours === hours)?.label}`} />
            <Kpi label="Error rate" value={formatPct(t.errorRate)} sub={`${formatCount(t.errors)} failed`} tone={t.errorRate !== null && t.errorRate * 100 >= savedRules.error_rate_pct ? 'danger' : undefined} />
            <Kpi label="p95 latency" value={formatMs(t.worstP95)} sub="slowest key" tone={t.worstP95 !== null && t.worstP95 >= savedRules.p95_latency_ms ? 'warning' : undefined} />
            <Kpi label="Rate-limit hits" value={formatCount(t.rateLimited)} sub={`limit ${RATE_LIMIT_PER_MINUTE}/min per key`} tone={t.rateLimited > 0 ? 'warning' : undefined} />
          </div>

          <Card className="p-5 hover:translate-y-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-text-primary">Requests{keyFilter ? ` · ${keyName(keyFilter)}` : ' · all keys'}</h2>
              {keyFilter && <button type="button" onClick={() => selectKey(null)} className="focus-ring rounded-lg text-xs font-medium text-accent hover:underline">Show all keys</button>}
            </div>
            <div className={seriesLoading ? 'opacity-50 transition-opacity' : 'transition-opacity'} aria-busy={seriesLoading}>
              <UsageChart points={series} hours={hours} />
            </div>
          </Card>

          <Card className="overflow-hidden p-0 hover:translate-y-0">
            <div className="border-b border-border/70 px-5 py-3">
              <h2 className="text-sm font-semibold text-text-primary">By key</h2>
              <p className="text-xs text-text-secondary">Select a key to filter the chart.</p>
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-text-secondary">
                  <tr>
                    {['Key', 'Status', 'Requests', 'Errors', 'p50', 'p95', 'Rate limited', 'Last request'].map((h, i) => (
                      <th key={h} scope="col" className={`px-4 py-2 font-medium ${i >= 2 && i <= 6 ? 'text-right' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ id, key, stats }) => (
                    <tr key={id} className={`border-t border-border/60 ${keyFilter === id ? 'bg-accent/5' : ''}`}>
                      <td className="px-4 py-2.5">
                        <button type="button" onClick={() => selectKey(id)} aria-pressed={keyFilter === id} className="focus-ring rounded text-left">
                          <span className="font-medium text-text-primary">{key?.name ?? 'Deleted key'}</span>
                          <span className="block font-mono text-[11px] text-text-secondary">{key?.key_prefix ?? '—'}{key?.revoked_at ? ' · revoked' : ''}</span>
                        </button>
                      </td>
                      <td className="px-4 py-2.5"><HealthBadge health={keyHealth(stats, breaches)} /></td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(stats?.requests ?? 0)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{stats ? `${formatCount(errorCount(stats))} (${formatPct(errorRate(stats))})` : '—'}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatMs(stats?.p50_ms ?? null)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatMs(stats?.p95_ms ?? null)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(stats?.rate_limited ?? 0)}</td>
                      <td className="px-4 py-2.5 text-text-secondary">{formatRelative(stats?.last_request_at ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-border/60 md:hidden">
              {rows.map(({ id, key, stats }) => (
                <li key={id} className={`px-4 py-3 ${keyFilter === id ? 'bg-accent/5' : ''}`}>
                  <button type="button" onClick={() => selectKey(id)} aria-pressed={keyFilter === id} className="focus-ring flex w-full items-start justify-between gap-2 rounded text-left">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-primary">{key?.name ?? 'Deleted key'}</span>
                      <span className="block font-mono text-[11px] text-text-secondary">{key?.key_prefix ?? '—'}{key?.revoked_at ? ' · revoked' : ''}</span>
                    </span>
                    <HealthBadge health={keyHealth(stats, breaches)} />
                  </button>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div className="flex justify-between"><dt className="text-text-secondary">Requests</dt><dd className="tabular-nums">{formatCount(stats?.requests ?? 0)}</dd></div>
                    <div className="flex justify-between"><dt className="text-text-secondary">Errors</dt><dd className="tabular-nums">{stats ? formatPct(errorRate(stats)) : '—'}</dd></div>
                    <div className="flex justify-between"><dt className="text-text-secondary">p95</dt><dd className="tabular-nums">{formatMs(stats?.p95_ms ?? null)}</dd></div>
                    <div className="flex justify-between"><dt className="text-text-secondary">Rate limited</dt><dd className="tabular-nums">{formatCount(stats?.rate_limited ?? 0)}</dd></div>
                    <div className="col-span-2 flex justify-between"><dt className="text-text-secondary">Last request</dt><dd>{formatRelative(stats?.last_request_at ?? null)}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="space-y-4 p-5 hover:translate-y-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"><BellRing size={15} /> Alerts</h2>
                <p className="mt-0.5 text-xs text-text-secondary">Checked every 10 minutes per key. You get an in-app notification, then a cooldown before the same alert repeats.</p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => patch('enabled', e.target.checked)} className="h-4 w-4 rounded border-border" /> Enabled
              </label>
            </div>
            <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${draft.enabled ? '' : 'pointer-events-none opacity-50'}`} aria-disabled={!draft.enabled}>
              <NumberField label="Look-back window" suffix="min" value={draft.window_minutes} onChange={(n) => patch('window_minutes', n)} error={ruleErrors.window_minutes} />
              <NumberField label="Minimum requests" value={draft.min_requests} onChange={(n) => patch('min_requests', n)} error={ruleErrors.min_requests} />
              <NumberField label="Error rate at or above" suffix="%" step="0.5" value={draft.error_rate_pct} onChange={(n) => patch('error_rate_pct', n)} error={ruleErrors.error_rate_pct} />
              <NumberField label="p95 latency at or above" suffix="ms" value={draft.p95_latency_ms} onChange={(n) => patch('p95_latency_ms', n)} error={ruleErrors.p95_latency_ms} />
              <NumberField label="Rate-limit hits at or above" value={draft.rate_limit_hits} onChange={(n) => patch('rate_limit_hits', n)} error={ruleErrors.rate_limit_hits} />
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-text-primary">
                <input type="checkbox" checked={draft.notify_in_app} onChange={(e) => patch('notify_in_app', e.target.checked)} className="h-3.5 w-3.5 rounded border-border" /> In-app notifications
              </label>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-text-secondary" aria-live="polite">{rulesDirty ? 'You have unsaved changes.' : updatedAt ? `Usage updated ${formatRelative(new Date(updatedAt).toISOString())}.` : ''}</p>
              <button type="button" onClick={handleSaveRules} disabled={saving || !rulesDirty} className="focus-ring rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">{saving ? 'Saving…' : 'Save alerts'}</button>
            </div>

            <div className="border-t border-border/60 pt-3">
              <h3 className="mb-2 text-xs font-semibold text-text-secondary">Recent alerts</h3>
              {events.length === 0 ? (
                <p className="text-xs text-text-secondary">No alerts have fired yet.</p>
              ) : (
                <ul className="space-y-2">
                  {events.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                      <span className="text-text-primary"><span className="font-medium">{alertTitle(e.kind)}</span> · {keyName(e.key_id)}<span className="block text-xs text-text-secondary">{alertDetail(e)}</span></span>
                      <span className="text-xs text-text-secondary">{formatRelative(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}
