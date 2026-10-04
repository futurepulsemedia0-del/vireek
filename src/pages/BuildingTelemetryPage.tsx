import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Cpu, Radio, TriangleAlert as AlertTriangle, Wrench, Copy, Check, RefreshCw, PackageCheck, PackageX, Plus,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  PROTOCOL_LABELS, METRIC_OPTIONS, SEVERITY_STYLES, createGateway, dismissPrediction, equipmentLabel, isOnline,
  mapPointToEquipment, metricLabel, revokeGateway, riskTone, runAnalysisNow, scheduleProactiveVisit,
  setPointMetric, setPointStatus, timeAgo, useTelemetryOverview,
  type FailurePrediction, type Protocol,
} from '@/lib/telemetry';

const INGEST_PATH = '/functions/v1/telemetry-ingest';
const card = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';
const btn = 'focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50';
const btnPrimary = 'focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50';

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={card}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone ?? 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

function PredictionCard({ p, customer, onChanged }: { p: FailurePrediction; customer: string; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const pct = Math.round(p.probability * 100);
  const tone = riskTone(p.probability);

  const prepare = async () => {
    setBusy(true);
    try {
      await scheduleProactiveVisit(p);
      toast('Proactive visit created with parts prepared.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the visit', 'error');
    } finally { setBusy(false); }
  };
  const dismiss = async () => {
    setBusy(true);
    try { await dismissPrediction(p.id); onChanged(); }
    catch { toast('Could not dismiss', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[tone]}`}>
              <AlertTriangle size={11} /> {pct}% in {p.horizon_days}d
            </span>
            <span className="text-sm font-semibold text-text-primary">{p.failure_label}</span>
            {p.status === 'prepared' && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Visit prepared</span>}
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            <Link to={`/dashboard/customers/${p.equipment?.customer_id}`} className="font-medium text-text-primary hover:text-accent">{customer}</Link>
            {' · '}{equipmentLabel(p.equipment)} · confidence {Math.round(p.confidence * 100)}%
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {p.status === 'open' && (
            <button type="button" onClick={prepare} disabled={busy} className={btnPrimary}>
              <Wrench size={12} className="mr-1 inline" />Prepare visit
            </button>
          )}
          {p.status === 'prepared' && <Link to="/dashboard/jobs" className={btn}>Open jobs →</Link>}
          <button type="button" onClick={dismiss} disabled={busy} className={btn}>Dismiss</button>
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border" role="img" aria-label={`Failure probability ${pct}%`}>
        <div className={`h-full ${tone === 'high' ? 'bg-danger-500' : tone === 'medium' ? 'bg-warning-500' : 'bg-success-500'}`} style={{ width: `${pct}%` }} />
      </div>

      {p.drivers.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.drivers.map((d) => (
            <span key={`${d.metric}-${d.kind}`} className="rounded-md bg-bg-primary px-2 py-0.5 text-xs text-text-secondary">
              {metricLabel(d.metric)} {d.direction === 'high' ? '↑' : '↓'} <span className="opacity-70">({d.kind.replace('_', ' ')})</span>
            </span>
          ))}
        </div>
      )}

      {p.recommended_action && <p className="mt-3 text-xs font-medium text-accent">{p.recommended_action}</p>}

      {p.predicted_parts.length > 0 && (
        <ul className="mt-3 space-y-1">
          {p.predicted_parts.map((part) => {
            const ok = part.in_stock !== null && part.in_stock >= part.qty;
            return (
              <li key={part.label} className="flex items-center gap-2 text-xs text-text-secondary">
                {part.part_id ? (ok ? <PackageCheck size={13} className="text-success-500" /> : <PackageX size={13} className="text-warning-500" />) : <PackageX size={13} className="opacity-40" />}
                <span>{part.qty}× {part.part_name ?? part.label}</span>
                <span className="opacity-70">{part.part_id ? (ok ? `in stock (${part.in_stock})` : 'low / out of stock — reorder') : 'not in your parts catalogue'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function BuildingTelemetryPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { data, loading, error, refresh } = useTelemetryOverview(!!user);
  const [analysing, setAnalysing] = useState(false);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('iot_gateway');
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [unmappedOnly, setUnmappedOnly] = useState(false);

  const activeGateways = data.gateways.filter((g) => !g.revoked_at);
  const online = activeGateways.filter((g) => isOnline(g.last_seen_at)).length;
  const atRisk = data.predictions.filter((p) => p.probability >= 0.35).length;
  const projectUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://YOUR-PROJECT.supabase.co';
  const equipmentById = useMemo(() => Object.fromEntries(data.equipmentOptions.map((e) => [e.id, e.label])), [data.equipmentOptions]);
  const visiblePoints = useMemo(
    () => data.points.filter((p) => (unmappedOnly ? !p.equipment_id : true)).slice(0, 60),
    [data.points, unmappedOnly],
  );

  const curl = (token: string) =>
    `curl -X POST "${projectUrl}${INGEST_PATH}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"readings":[{"point":"AHU-1/SAT","metric":"supply_air_temp","unit":"C","value":13.2}]}'`;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim()) return;
    setCreating(true);
    try {
      const { gateway, rawToken } = await createGateway({ name, protocol }, user.id);
      setNewToken({ name: gateway.name, token: rawToken });
      setName('');
      setCopied(false);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create gateway', 'error');
    } finally { setCreating(false); }
  };

  const handleRun = async () => {
    setAnalysing(true);
    try {
      const r = await runAnalysisNow();
      toast(`Analysed ${r.points} points · ${r.newAnomalies} new anomalies · ${r.predictions} active predictions`, 'success');
      await refresh();
    } catch {
      toast('Analysis could not run. Check that telemetry-analyze is deployed.', 'error');
    } finally { setAnalysing(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { toast('Copy failed — select and copy manually', 'error'); }
  };

  const guard = async (fn: () => Promise<void>, fail: string) => {
    try { await fn(); await refresh(); } catch { toast(fail, 'error'); }
  };

  return (
    <DashboardLayout activeLabel="Building Telemetry">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Cpu size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Building Telemetry Intelligence</h1>
          <p className="text-sm text-text-secondary">The machine tells us it is failing — before the customer calls. Telemetry → anomaly → failure probability → parts → proactive service.</p>
        </div>
        <button type="button" onClick={handleRun} disabled={analysing || activeGateways.length === 0} className={`${btn} ml-auto`}>
          <RefreshCw size={12} className={`mr-1 inline ${analysing ? 'animate-spin' : ''}`} />Run analysis now
        </button>
      </div>

      {error && <p className="mb-4 rounded-lg bg-danger-500/10 p-3 text-sm text-danger-500">{error}</p>}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Gateways online" value={`${online}/${activeGateways.length}`} />
        <Kpi label="Points tracked" value={data.points.length} />
        <Kpi label="Open anomalies" value={data.anomalies.length} tone={data.anomalies.length ? 'text-warning-500' : undefined} />
        <Kpi label="Units at risk" value={atRisk} tone={atRisk ? 'text-danger-500' : undefined} />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-text-primary">Predicted failures</h2>
      {loading ? <p className="text-sm text-text-secondary">Loading…</p> : data.predictions.length === 0 ? (
        <div className={`${card} mb-6 text-center`}>
          <p className="text-sm text-text-secondary">
            No failure predicted. Each machine first needs about two days of data to learn its own normal — then deviations surface here.
          </p>
        </div>
      ) : (
        <div className="mb-6 space-y-3">
          {data.predictions.map((p) => (
            <PredictionCard key={p.id} p={p} customer={data.customerNames[p.equipment?.customer_id ?? ''] ?? 'Customer'} onChanged={refresh} />
          ))}
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <section className={card}>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Live anomalies</h2>
          {data.anomalies.length === 0 ? <p className="text-sm text-text-secondary">All monitored points are within their learned normal range.</p> : (
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {data.anomalies.map((a) => (
                <li key={a.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[a.severity]}`}>{a.severity}</span>
                    <span className="text-sm font-medium text-text-primary">{metricLabel(a.metric)}</span>
                    <span className="ml-auto text-xs text-text-secondary">{timeAgo(a.detected_at)}</span>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">{a.explanation}</p>
                  {a.equipment_id && equipmentById[a.equipment_id] && <p className="mt-1 text-xs text-accent">{equipmentById[a.equipment_id]}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card}>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Connect a gateway</h2>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Main building BMS bridge" aria-label="Gateway name"
              className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)} aria-label="Protocol"
              className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
              {Object.entries(PROTOCOL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button type="submit" disabled={creating || !name.trim()} className={btnPrimary}><Plus size={12} className="mr-1 inline" />Create</button>
          </form>

          {newToken && (
            <div className="mt-3 rounded-lg border border-warning-500/40 bg-warning-500/5 p-3">
              <p className="text-xs font-semibold text-text-primary">Token for “{newToken.name}” — shown once. Copy it now.</p>
              <code className="mt-2 block break-all rounded bg-bg-primary p-2 text-xs text-text-primary">{newToken.token}</code>
              <pre className="mt-2 overflow-x-auto rounded bg-bg-primary p-2 text-[11px] text-text-secondary">{curl(newToken.token)}</pre>
              <button type="button" onClick={() => copy(newToken.token)} className={`${btn} mt-2`}>
                {copied ? <Check size={12} className="mr-1 inline" /> : <Copy size={12} className="mr-1 inline" />}{copied ? 'Copied' : 'Copy token'}
              </button>
            </div>
          )}

          <ul className="mt-4 space-y-2">
            {data.gateways.map((g) => (
              <li key={g.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <Radio size={16} className={g.revoked_at ? 'text-text-secondary opacity-40' : isOnline(g.last_seen_at) ? 'text-success-500' : 'text-warning-500'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{g.name}</p>
                  <p className="text-xs text-text-secondary">{PROTOCOL_LABELS[g.protocol]} · {g.token_prefix}… · {g.revoked_at ? 'revoked' : `last data ${timeAgo(g.last_seen_at)}`}</p>
                </div>
                {!g.revoked_at && (confirmRevoke === g.id ? (
                  <span className="flex gap-1">
                    <button type="button" className={btn} onClick={() => setConfirmRevoke(null)}>Cancel</button>
                    <button type="button" className={btnPrimary} onClick={() => { setConfirmRevoke(null); guard(() => revokeGateway(g.id), 'Could not revoke'); }}>Confirm revoke</button>
                  </span>
                ) : <button type="button" className={btn} onClick={() => setConfirmRevoke(g.id)}>Revoke</button>)}
              </li>
            ))}
            {data.gateways.length === 0 && <li className="text-sm text-text-secondary">No gateway yet. Create one, then point your BMS bridge, thermostat or IoT gateway at the endpoint above.</li>}
          </ul>
        </section>
      </div>

      <section className={card}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Points &amp; equipment mapping</h2>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={unmappedOnly} onChange={(e) => setUnmappedOnly(e.target.checked)} /> Unmapped only
          </label>
        </div>
        <p className="mb-3 text-xs text-text-secondary">Map each point to a piece of equipment — predictions only run for mapped points.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-text-secondary"><tr><th className="py-2 pr-3">Point</th><th className="pr-3">Metric</th><th className="pr-3">Equipment</th><th className="pr-3">Last value</th><th className="pr-3">Learning</th><th /></tr></thead>
            <tbody>
              {visiblePoints.map((pt) => (
                <tr key={pt.id} className="border-t border-border">
                  <td className="py-2 pr-3 font-medium text-text-primary">{pt.label ?? pt.external_id}</td>
                  <td className="pr-3">
                    <select value={pt.metric} aria-label="Metric" onChange={(e) => guard(() => setPointMetric(pt.id, e.target.value), 'Could not update metric')}
                      className="focus-ring max-w-[160px] rounded border border-border bg-bg-primary px-2 py-1 text-text-primary">
                      {METRIC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="pr-3">
                    <select value={pt.equipment_id ?? ''} aria-label="Equipment" onChange={(e) => guard(() => mapPointToEquipment(pt.id, e.target.value || null), 'Could not map equipment')}
                      className="focus-ring max-w-[200px] rounded border border-border bg-bg-primary px-2 py-1 text-text-primary">
                      <option value="">— not mapped —</option>
                      {data.equipmentOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="pr-3 text-text-secondary">{pt.last_value === null ? '—' : `${Number(pt.last_value.toFixed(2))}${pt.unit ? ` ${pt.unit}` : ''}`} · {timeAgo(pt.last_ts)}</td>
                  <td className="pr-3 text-text-secondary">{pt.baseline_n >= 48 ? 'Baseline ready' : 'Learning…'}</td>
                  <td><button type="button" className={btn} onClick={() => guard(() => setPointStatus(pt.id, pt.status === 'active' ? 'muted' : 'active'), 'Could not update')}>{pt.status === 'active' ? 'Mute' : 'Unmute'}</button></td>
                </tr>
              ))}
              {visiblePoints.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-text-secondary">No points yet — they appear automatically on the first reading from a gateway.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </DashboardLayout>
  );
}
