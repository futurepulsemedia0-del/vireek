/**
 * Property Intelligence — two pages in one module:
 *  - PropertyIntelligencePage       : account-wide live sensors -> failure prediction -> missions (Property Intelligence OS)
 *  - PropertyIntelligenceGraphPage  : per-site building knowledge graph, /dashboard/customers/:customerId/sites/:siteId/intelligence
 *                                     (location, parcel/building/unit graph, characteristics, climate, hazards,
 *                                     permits/history, energy, area economics — every datum with provenance)
 * Data layer: src/lib/propertyIntelligence.ts
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  BatteryLow,
  Building2,
  CheckCircle2,
  CloudSun,
  Copy,
  Cpu,
  Home,
  Landmark,
  Lightbulb,
  Loader2,
  MapPin,
  Network,
  Package,
  Plus,
  Radar,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateInline } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SkeletonCard, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { fetchPropertyTwin, type PropertyTwin } from '@/lib/propertyTwin';
import { formatSiteLocationLine, SITE_TYPE_LABELS } from '@/lib/siteHierarchy';
import {
  addNode,
  ALLOWED_PARENTS,
  buildNodeTree,
  CHARACTERISTIC_FIELDS,
  computeCoverage,
  curlExample,
  deleteNode,
  deriveInsights,
  deviceIsOnline,
  dismissMission,
  eligibleParents,
  ENERGY_FIELDS,
  enrichProperty,
  fetchDevices,
  fetchEquipmentOptions,
  fetchMissions,
  fetchPredictions,
  fetchPropertyIntelligence,
  fieldFormValues,
  formatRelative,
  LAYER_LABELS,
  NODE_KIND_LABELS,
  numOf,
  objOf,
  parseFieldValues,
  PART_STATUS_LABEL,
  PART_STATUS_STYLE,
  PIPELINE,
  recordOutcome,
  registerDevice,
  runPropertyIntelligenceAgent,
  saveManualLayer,
  setDeviceStatus,
  SEVERITY_STYLE,
  stageIndex,
  strOf,
  type DeviceProtocol,
  type EquipmentOption,
  type FieldDef,
  type Insight,
  type IntelLayer,
  type IntelNodeKind,
  type IntelTreeNode,
  type MissionOutcome,
  type PioDevice,
  type PioMission,
  type PioPrediction,
  type PropertyIntelligence,
  type RegisteredDevice,
} from '@/lib/propertyIntelligence';

type Tab = 'missions' | 'predictions' | 'devices';

const OPEN_STAGES = ['detected', 'awaiting_customer', 'scheduled', 'dispatched', 'repaired'];
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent';

function StatCard({ icon: Icon, label, value, hint }: { icon: typeof Activity; label: string; value: string | number; hint?: string }) {
  return (
    <Card className="!p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Icon size={20} />
        </span>
        <div>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
          <p className="text-xs text-text-secondary">{label}</p>
        </div>
      </div>
      {hint && <p className="mt-2 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

function ProbabilityBar({ value, critical }: { value: number; critical?: boolean }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2" aria-label={`Failure probability ${pct}%`}>
      <div className="h-2 w-28 overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${critical ? 'bg-danger-500' : 'bg-warning-500'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-bold text-text-primary">{pct}%</span>
    </div>
  );
}

function MissionCard({ m, onChanged }: { m: PioMission; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const idx = stageIndex(m.stage);
  const terminalBad = idx === -1;
  const canDismiss = m.stage === 'detected' || m.stage === 'awaiting_customer';
  const needsOutcome = (m.stage === 'repaired' || m.stage === 'verified') && !m.outcome;

  const act = async (fn: () => Promise<boolean>, ok: string) => {
    setBusy(true);
    try {
      const done = await fn();
      toast(done ? ok : 'Nothing changed — it may have already moved on.', done ? 'success' : 'info');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="!p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.urgency === 'critical' ? SEVERITY_STYLE.critical : SEVERITY_STYLE.high}`}>
              {m.urgency.toUpperCase()}
            </span>
            <Link to={`/dashboard/customers/${m.customer_id}`} className="text-sm font-semibold text-text-primary hover:text-accent">
              {m.customer?.name ?? 'Customer'}
            </Link>
          </div>
          <p className="mt-1.5 text-sm text-text-primary">{m.headline}</p>
          {m.explanation && <p className="mt-1 text-xs text-text-secondary">{m.explanation}</p>}
        </div>
        <ProbabilityBar value={Number(m.probability)} critical={m.urgency === 'critical'} />
      </div>

      {terminalBad ? (
        <p className="mt-4 text-xs font-medium capitalize text-text-secondary">Closed — {m.stage}</p>
      ) : (
        <ol className="mt-4 flex items-center gap-1" aria-label="Mission progress">
          {PIPELINE.map((step, i) => (
            <li key={step.key} className="flex flex-1 flex-col gap-1">
              <span className={`h-1.5 rounded-full ${i <= idx ? 'bg-accent' : 'bg-bg-tertiary'}`} />
              <span className={`text-[11px] ${i === idx ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{step.label}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-medium ${PART_STATUS_STYLE[m.part_status]}`}>
          <Package size={11} /> {m.part?.name && m.part_status === 'reserved' ? `${m.part_quantity} × ${m.part.name} reserved` : PART_STATUS_LABEL[m.part_status]}
          {m.part_status === 'backorder' && m.part_eta ? ` · ETA ${m.part_eta}` : ''}
        </span>
        <span className="text-text-secondary">Fix before {new Date(m.deadline_at).toLocaleDateString()}</span>
        {m.job_id && (
          <Link to="/dashboard/jobs" className="font-medium text-accent hover:underline">
            View job →
          </Link>
        )}
      </div>

      {m.blocked_reason && <p className="mt-2 rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">{m.blocked_reason}</p>}

      {(canDismiss || needsOutcome) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canDismiss && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => dismissMission(m.id), 'Mission dismissed')}>
              Dismiss
            </Button>
          )}
          {needsOutcome && (
            <>
              <span className="text-xs text-text-secondary">What did the technician find?</span>
              {([
                ['confirmed', 'Failing as predicted'],
                ['different_issue', 'Different issue'],
                ['not_needed', 'Not needed'],
              ] as [MissionOutcome, string][]).map(([o, label]) => (
                <Button key={o} size="sm" variant="secondary" disabled={busy} onClick={() => act(() => recordOutcome(m.id, o), 'Thanks — Vireek will learn from this')}>
                  {label}
                </Button>
              ))}
            </>
          )}
        </div>
      )}
      {m.outcome && (
        <p className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-success-500">
          <CheckCircle2 size={12} /> Outcome recorded: {m.outcome.replace('_', ' ')}
        </p>
      )}
    </Card>
  );
}

function PredictionRow({ p }: { p: PioPrediction }) {
  return (
    <Card className="!p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${SEVERITY_STYLE[p.severity]}`}>{p.severity.toUpperCase()}</span>
            <span className="text-sm font-semibold text-text-primary">{p.label}</span>
            <span className="text-xs text-text-secondary">
              · {[p.equipment?.make, p.equipment?.equipment_type].filter(Boolean).join(' ')} · {p.customer?.name ?? 'Customer'}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-text-secondary">{p.probable_cause}</p>
        </div>
        <div className="text-right">
          <ProbabilityBar value={Number(p.probability)} critical={p.severity === 'critical'} />
          <p className="mt-1 text-xs text-text-secondary">
            {p.horizon_days_min}–{p.horizon_days_max} days · {Math.round(Number(p.confidence) * 100)}% confidence
          </p>
        </div>
      </div>
      {p.evidence.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {p.evidence.slice(0, 4).map((e) => (
            <li key={e.metric} className="rounded-lg bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">
              {e.label}
              {e.change_pct !== null ? ` ${e.change_pct > 0 ? '+' : ''}${e.change_pct}%` : ''}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DevicesPanel({ devices, onChanged }: { devices: PioDevice[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [options, setOptions] = useState<EquipmentOption[]>([]);
  const [open, setOpen] = useState(false);
  const [equipmentId, setEquipmentId] = useState('');
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<DeviceProtocol>('http');
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<RegisteredDevice | null>(null);

  useEffect(() => {
    if (open && options.length === 0) fetchEquipmentOptions().then(setOptions).catch(() => toast('Could not load equipment', 'error'));
  }, [open, options.length, toast]);

  const submit = async () => {
    if (!equipmentId || !name.trim()) return;
    setSaving(true);
    try {
      setCreated(await registerDevice({ equipmentId, name: name.trim(), sensorKind: 'generic', protocol }));
      setName('');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not register device', 'error');
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Copy failed — select and copy manually', 'error');
    }
  };

  const change = async (id: string, status: 'active' | 'paused' | 'revoked') => {
    try {
      await setDeviceStatus(id, status);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => { setOpen((o) => !o); setCreated(null); }}>
          <Plus size={16} /> Register sensor
        </Button>
      </div>

      {open && (
        <Card className="!p-5">
          {created ? (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-text-primary">Sensor registered — copy its key now.</p>
              <p className="text-xs text-warning-500">This key is shown only once. If you lose it, revoke the sensor and register a new one.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-primary">{created.api_key}</code>
                <Button size="sm" variant="secondary" onClick={() => copy(created.api_key)} aria-label="Copy API key"><Copy size={14} /></Button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-bg-tertiary p-3 text-[11px] text-text-secondary">{curlExample(created.api_key)}</pre>
              <Button size="sm" variant="secondary" onClick={() => copy(curlExample(created.api_key))}>Copy example</Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="pio-eq" className="mb-1.5 block text-sm font-medium text-text-primary">Equipment</label>
                <select id="pio-eq" className={selectClass} value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
                  <option value="">Select a unit…</option>
                  {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
              <Input label="Sensor name" placeholder="e.g. Condenser vibration" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              <div>
                <label htmlFor="pio-proto" className="mb-1.5 block text-sm font-medium text-text-primary">Protocol</label>
                <select id="pio-proto" className={selectClass} value={protocol} onChange={(e) => setProtocol(e.target.value as DeviceProtocol)}>
                  {(['http', 'mqtt', 'matter', 'modbus', 'bacnet', 'manual'] as DeviceProtocol[]).map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Button size="sm" disabled={saving || !equipmentId || !name.trim()} onClick={submit}>
                  {saving ? 'Registering…' : 'Register & generate key'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {devices.length === 0 ? (
        <EmptyState icon={Cpu} title="No sensors connected" description="Register a sensor on an equipment unit and stream readings to start live failure prediction." />
      ) : (
        devices.map((d) => {
          const online = deviceIsOnline(d);
          return (
            <Card key={d.id} className="!p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${online ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
                    {online ? <Wifi size={18} /> : <WifiOff size={18} />}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{d.name}</p>
                    <p className="text-xs text-text-secondary">
                      {[d.equipment?.make, d.equipment?.equipment_type].filter(Boolean).join(' ')} · {d.protocol.toUpperCase()} · {d.key_prefix}… · seen {formatRelative(d.last_seen_at)}
                      {d.status === 'paused' ? ' · paused' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {d.battery_pct !== null && (
                    <span className={`inline-flex items-center gap-1 text-xs ${d.battery_pct <= 15 ? 'text-danger-500' : 'text-text-secondary'}`}>
                      <BatteryLow size={13} /> {d.battery_pct}%
                    </span>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => change(d.id, d.status === 'paused' ? 'active' : 'paused')}>
                    {d.status === 'paused' ? 'Resume' : 'Pause'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => change(d.id, 'revoked')}>Revoke</Button>
                </div>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}

export function PropertyIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('missions');
  const [missions, setMissions] = useState<PioMission[]>([]);
  const [predictions, setPredictions] = useState<PioPrediction[]>([]);
  const [devices, setDevices] = useState<PioDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, p, d] = await Promise.all([fetchMissions(), fetchPredictions(), fetchDevices()]);
      setMissions(m);
      setPredictions(p);
      setDevices(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load Property Intelligence', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // Light polling keeps "last seen" fresh without subscribing to the high-volume telemetry table.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const debouncedLoad = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const liveStatus = useRealtimeSubscription({
    channelName: `pio-missions-${user?.id ?? 'anon'}`,
    table: 'pio_missions',
    event: '*',
    enabled: !!user,
    onChange: debouncedLoad,
  });

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await runPropertyIntelligenceAgent();
      toast(`Scan complete — ${r.predictions} predictions, ${r.missions_opened} new missions`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Scan failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  const stats = useMemo(() => {
    const open = missions.filter((m) => OPEN_STAGES.includes(m.stage));
    return {
      online: devices.filter(deviceIsOnline).length,
      predictions: predictions.length,
      open: open.length,
      critical: open.filter((m) => m.urgency === 'critical').length,
      prevented: missions.filter((m) => m.outcome === 'confirmed').length,
    };
  }, [missions, predictions, devices]);

  const openMissions = missions.filter((m) => OPEN_STAGES.includes(m.stage));
  const closedMissions = missions.filter((m) => !OPEN_STAGES.includes(m.stage));

  return (
    <DashboardLayout activeLabel="Property Intelligence">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Radar size={24} /></span>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-text-primary">Property Intelligence</h1>
            <LiveIndicator status={liveStatus} />
          </div>
          <p className="text-sm text-text-secondary">Live sensors → failure prediction → part, technician and customer — handled before the breakdown.</p>
        </div>
        <Button size="sm" className="ml-auto" disabled={running} onClick={runNow}>
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} /> {running ? 'Scanning…' : 'Run scan now'}
        </Button>
      </div>

      {loading ? (
        <div className="space-y-4">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} />
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Wifi} label="Sensors online" value={`${stats.online}/${devices.length}`} />
            <StatCard icon={Activity} label="Active predictions" value={stats.predictions} />
            <StatCard icon={Zap} label="Open missions" value={stats.open} hint={stats.critical ? `${stats.critical} critical` : undefined} />
            <StatCard icon={CheckCircle2} label="Failures confirmed & fixed" value={stats.prevented} />
          </div>

          <div role="tablist" aria-label="Property Intelligence sections" className="mb-4 flex gap-1 border-b border-border">
            {([['missions', 'Missions'], ['predictions', 'Predictions'], ['devices', 'Sensors']] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === key ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'missions' && (
            <div className="space-y-3">
              {openMissions.length === 0 && closedMissions.length === 0 ? (
                <EmptyState
                  icon={Radar}
                  title="No predicted failures"
                  description="When sensor data shows a unit heading toward failure, Vireek opens a mission here and runs the whole response automatically."
                  action={{ label: 'Connect a sensor', onClick: () => setTab('devices') }}
                />
              ) : (
                <>
                  {openMissions.map((m) => <MissionCard key={m.id} m={m} onChanged={load} />)}
                  {closedMissions.length > 0 && (
                    <details className="pt-2">
                      <summary className="cursor-pointer text-sm font-medium text-text-secondary">Closed missions ({closedMissions.length})</summary>
                      <div className="mt-3 space-y-3">{closedMissions.map((m) => <MissionCard key={m.id} m={m} onChanged={load} />)}</div>
                    </details>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'predictions' && (
            <div className="space-y-3">
              {predictions.length === 0 ? (
                <EmptyState icon={Activity} title="All monitored equipment looks healthy" description="Predictions appear here as soon as a unit's live readings drift from its own normal." />
              ) : (
                predictions.map((p) => <PredictionRow key={p.id} p={p} />)
              )}
            </div>
          )}

          {tab === 'devices' && <DevicesPanel devices={devices} onChanged={load} />}
        </>
      )}
    </DashboardLayout>
  );
}

// =====================================================================================
// PART 2 — Property Intelligence Graph (per site): /dashboard/customers/:customerId/sites/:siteId/intelligence
// =====================================================================================

const SEVERITY_STYLES: Record<Insight['severity'], string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

const KIND_LABELS: Record<Insight['kind'], string> = {
  risk: 'Risk',
  opportunity: 'Opportunity',
  compliance: 'Compliance',
  data_quality: 'Data quality',
};

const panel = 'rounded-2xl border border-border bg-bg-secondary p-5';

const fmt = (n: number | null, suffix = '') => (n === null ? '—' : `${n.toLocaleString('en-US')}${suffix}`);
const usd = (n: number | null) => (n === null ? '—' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right font-medium text-text-primary">{value}</span>
    </div>
  );
}

function Provenance({ layer }: { layer: IntelLayer | undefined }) {
  if (!layer) return null;
  const tone =
    layer.status === 'ok' || layer.status === 'manual'
      ? 'bg-success-500/10 text-success-500'
      : layer.status === 'partial'
        ? 'bg-warning-500/10 text-warning-500'
        : 'bg-danger-500/10 text-danger-500';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-[11px] text-text-secondary">
      <span className={`rounded-full px-2 py-0.5 font-medium ${tone}`}>{layer.status === 'manual' ? 'verified by you' : layer.status}</span>
      <span>{layer.source}</span>
      {layer.as_of && <span>· as of {layer.as_of}</span>}
      {layer.status !== 'manual' && <span>· confidence {Math.round(layer.confidence * 100)}%</span>}
    </div>
  );
}

function LayerPanel({ icon, title, layer, hint, children }: { icon: ReactNode; title: string; layer: IntelLayer | undefined; hint: string; children: ReactNode }) {
  const usable = layer && (layer.status === 'ok' || layer.status === 'partial' || layer.status === 'manual');
  return (
    <div className={panel}>
      <div className="mb-2 flex items-center gap-2 text-text-primary">
        <span className="text-cta">{icon}</span>
        <p className="text-sm font-semibold">{title}</p>
      </div>
      {usable ? children : <EmptyStateInline text={layer?.error ?? hint} />}
      <Provenance layer={layer} />
    </div>
  );
}

function ClimateBody({ d }: { d: Record<string, unknown> }) {
  const profile = strOf(d, 'climate_profile');
  return (
    <div>
      <Row label="Profile" value={profile ? profile.replace(/_/g, ' ') : '—'} />
      <Row label="Average temperature" value={fmt(numOf(d, 'avg_temp_f'), '°F')} />
      <Row label="Heating degree-days / yr" value={fmt(numOf(d, 'hdd65_f'))} />
      <Row label="Cooling degree-days / yr" value={fmt(numOf(d, 'cdd65_f'))} />
      <Row label="Days ≥ 95°F / yr" value={fmt(numOf(d, 'heat_days_95f'))} />
      <Row label="Days ≤ 32°F / yr" value={fmt(numOf(d, 'freeze_days_32f'))} />
      <Row label="Precipitation / yr" value={fmt(numOf(d, 'precip_in'), ' in')} />
    </div>
  );
}

function HazardsBody({ d }: { d: Record<string, unknown> }) {
  const flood = objOf(d, 'flood');
  const seismic = objOf(d, 'seismic');
  const notCovered = Array.isArray(d.not_covered) ? (d.not_covered as string[]) : [];
  return (
    <div>
      {flood ? (
        <Row
          label="FEMA flood zone"
          value={flood.mapped === false ? 'Not mapped' : `${strOf(flood, 'zone') ?? '—'}${flood.sfha === true ? ' (high-risk area)' : ''}`}
        />
      ) : (
        notCovered.includes('flood') && <Row label="FEMA flood zone" value="US only" />
      )}
      {seismic && (
        <Row
          label={`Quakes M4+ within 100 km (${numOf(seismic, 'window_years') ?? 10} yr)`}
          value={fmt(numOf(seismic, 'events_m4_100km'))}
        />
      )}
    </div>
  );
}

function EconomicBody({ d }: { d: Record<string, unknown> }) {
  return (
    <div>
      <Row label="Median home value" value={usd(numOf(d, 'median_home_value_usd'))} />
      <Row label="Median household income" value={usd(numOf(d, 'median_household_income_usd'))} />
      <Row label="Median year built" value={fmt(numOf(d, 'median_year_built'))} />
      <Row label="Owner-occupied" value={fmt(numOf(d, 'owner_occupied_pct'), '%')} />
      <p className="mt-2 text-[11px] text-text-secondary">Census-tract statistics for the surrounding area — not about the occupants.</p>
    </div>
  );
}

function FieldsEditor({
  icon,
  title,
  layerKey,
  fields,
  layer,
  profileId,
  onSaved,
}: {
  icon: ReactNode;
  title: string;
  layerKey: 'characteristics' | 'energy';
  fields: FieldDef[];
  layer: IntelLayer | undefined;
  profileId: string;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>(() => fieldFormValues(fields, layer?.data));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const { data, errors: found } = parseFieldValues(fields, values);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (Object.keys(data).length === 0) {
      toast('Enter at least one value to save.', 'info');
      return;
    }
    setSaving(true);
    try {
      await saveManualLayer(profileId, layerKey, data);
      toast(`${title} saved.`, 'success');
      await onSaved();
    } catch {
      toast(`Could not save ${title.toLowerCase()}.`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={panel}>
      <div className="mb-3 flex items-center gap-2 text-text-primary">
        <span className="text-cta">{icon}</span>
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) =>
          f.type === 'select' ? (
            <div key={f.key}>
              <label htmlFor={`${layerKey}-${f.key}`} className="mb-1.5 block text-sm font-medium text-text-primary">
                {f.label}
              </label>
              <select
                id={`${layerKey}-${f.key}`}
                className={selectClass}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                <option value="">—</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {errors[f.key] && <p className="mt-1 text-xs text-danger">{errors[f.key]}</p>}
            </div>
          ) : (
            <Input
              key={f.key}
              id={`${layerKey}-${f.key}`}
              label={f.unit ? `${f.label} (${f.unit})` : f.label}
              type={f.type === 'number' ? 'number' : 'text'}
              inputMode={f.type === 'number' ? 'decimal' : undefined}
              value={values[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          ),
        )}
      </div>
      <div className="mt-4">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 size={14} className="animate-spin" />} Save
        </Button>
      </div>
      <Provenance layer={layer} />
    </div>
  );
}

function TreeItem({ node, depth, onDelete }: { node: IntelTreeNode; depth: number; onDelete: (n: IntelTreeNode) => void }) {
  const notes = strOf(node.attributes, 'notes');
  return (
    <li>
      <div className="flex items-start justify-between gap-3 rounded-xl px-2 py-1.5 hover:bg-bg-tertiary" style={{ marginLeft: depth * 16 }}>
        <div className="min-w-0">
          <p className="text-sm text-text-primary">
            <span className="mr-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
              {NODE_KIND_LABELS[node.kind]}
            </span>
            {node.name}
            {node.occurred_on && <span className="ml-2 text-xs text-text-secondary">{node.occurred_on}</span>}
          </p>
          {notes && <p className="mt-0.5 text-xs text-text-secondary">{notes}</p>}
        </div>
        <button
          type="button"
          aria-label={`Delete ${node.name}`}
          onClick={() => onDelete(node)}
          className="focus-ring shrink-0 rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeItem key={c.id} node={c} depth={depth + 1} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </li>
  );
}

const KINDS = Object.keys(ALLOWED_PARENTS) as IntelNodeKind[];

function GraphPanel({ intel, onChanged }: { intel: PropertyIntelligence; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<IntelNodeKind>('permit');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const tree = useMemo(() => buildNodeTree(intel.nodes), [intel.nodes]);
  const parents = useMemo(() => eligibleParents(kind, intel.nodes), [kind, intel.nodes]);

  const submit = async () => {
    if (!name.trim()) {
      toast('Give the record a name.', 'info');
      return;
    }
    setBusy(true);
    try {
      await addNode({ profile_id: intel.profile.id, kind, name, parent_id: parentId || null, occurred_on: date || null, notes: notes || null });
      setName('');
      setNotes('');
      setDate('');
      await onChanged();
    } catch {
      toast('Could not add the record. Check the parent selection.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: IntelTreeNode) => {
    const extra = n.children.length ? ` This also removes ${n.children.length} nested record(s).` : '';
    if (!window.confirm(`Delete "${n.name}"?${extra}`)) return;
    try {
      await deleteNode(n.id);
      await onChanged();
    } catch {
      toast('Could not delete the record.', 'error');
    }
  };

  return (
    <div className={panel}>
      <div className="mb-3 flex items-center gap-2 text-text-primary">
        <Network size={16} className="text-cta" />
        <p className="text-sm font-semibold">Property graph — parcel, buildings, permits, history</p>
      </div>

      {tree.length === 0 ? (
        <EmptyStateInline text="Add the parcel, buildings, permits and construction events you know about." />
      ) : (
        <ul className="mb-4 space-y-0.5">
          {tree.map((n) => (
            <TreeItem key={n.id} node={n} depth={0} onDelete={(x) => void remove(x)} />
          ))}
        </ul>
      )}

      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pin-kind" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
          <select
            id="pin-kind"
            className={selectClass}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as IntelNodeKind);
              setParentId('');
            }}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{NODE_KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pin-parent" className="mb-1.5 block text-sm font-medium text-text-primary">
            Belongs to (optional)
          </label>
          <select id="pin-parent" className={selectClass} value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={ALLOWED_PARENTS[kind].length === 0}>
            <option value="">—</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{`${NODE_KIND_LABELS[p.kind]}: ${p.name}`}</option>
            ))}
          </select>
        </div>
        <Input id="pin-name" label="Name / permit number" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        <Input id="pin-date" label="Date (permit issued, work done)" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="sm:col-span-2">
          <Input id="pin-notes" label="Notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="mt-4">
        <Button size="sm" variant="secondary" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add record
        </Button>
      </div>
    </div>
  );
}

export function PropertyIntelligenceGraphPage() {
  const { customerId, siteId } = useParams<{ customerId: string; siteId: string }>();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [intel, setIntel] = useState<PropertyIntelligence | null>(null);
  const [twin, setTwin] = useState<PropertyTwin | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!customerId || !siteId) return;
      const req = ++reqRef.current;
      if (!silent) setLoading(true);
      try {
        const [i, t] = await Promise.all([fetchPropertyIntelligence(siteId, true), fetchPropertyTwin(customerId, siteId)]);
        if (req !== reqRef.current) return;
        setIntel(i);
        setTwin(t);
      } catch {
        if (req === reqRef.current) toast('Could not load property intelligence.', 'error');
      } finally {
        if (req === reqRef.current && !silent) setLoading(false);
      }
    },
    [customerId, siteId, toast],
  );

  useEffect(() => {
    void load();
    return () => {
      reqRef.current += 1; // invalidate in-flight loads on unmount / route change
    };
  }, [load]);

  const refreshQuiet = useCallback(() => load(true), [load]);

  const handleEnrich = async () => {
    if (!siteId || enriching) return;
    setEnriching(true);
    try {
      const r = await enrichProperty(siteId);
      if (r.status === 'failed') toast('No data source could be refreshed right now.', 'error');
      else if (r.status === 'partial') toast('Refreshed. Some sources were unavailable.', 'info');
      else toast('Property data refreshed.', 'success');
      await load(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Refresh failed.', 'error');
    } finally {
      setEnriching(false);
    }
  };

  const equipment = twin?.equipment;
  const coverage = useMemo(() => (intel ? computeCoverage(intel, equipment?.length ?? 0) : null), [intel, equipment]);
  const insights = useMemo(() => (intel ? deriveInsights(intel, equipment ?? []) : []), [intel, equipment]);

  if (loading || !intel || !twin || !coverage) {
    return (
      <DashboardLayout activeLabel="Sites">
        <div className="space-y-6 p-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCard rows={4} />
          <SkeletonCard rows={4} />
        </div>
      </DashboardLayout>
    );
  }

  if (!twin.site) {
    return (
      <DashboardLayout activeLabel="Sites">
        <div className="p-6"><p className="text-sm text-text-secondary">This property could not be found.</p></div>
      </DashboardLayout>
    );
  }

  const { site } = twin;
  const { profile, layers } = intel;
  const stale = profile.last_enriched_at ? new Date(profile.last_enriched_at).toLocaleString() : null;

  return (
    <DashboardLayout activeLabel="Sites">
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center gap-4 text-xs font-medium">
          <Link to={`/dashboard/customers/${customerId}/sites`} className="focus-ring flex items-center gap-1.5 text-text-secondary hover:text-text-primary">
            <ArrowLeft size={12} /> Back to sites
          </Link>
          <Link to={`/dashboard/customers/${customerId}/sites/${siteId}/twin`} className="focus-ring text-text-secondary hover:text-text-primary">
            Open Digital Twin
          </Link>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <Building2 className="text-cta" size={20} />
            <div>
              <p className="text-sm font-semibold text-text-primary">{site.name} — Property Intelligence</p>
              <p className="text-xs text-text-secondary">
                {SITE_TYPE_LABELS[site.site_type]}
                {formatSiteLocationLine(site) ? ` · ${formatSiteLocationLine(site)}` : ''}
                {profile.normalized_address ? ` · ${profile.normalized_address}` : site.address ? ` · ${site.address}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {stale && <span className="text-[11px] text-text-secondary">Last refreshed {stale}</span>}
            <Button size="sm" onClick={() => void handleEnrich()} disabled={enriching || profile.enrichment_status === 'running'}>
              {enriching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {profile.enrichment_status === 'never' ? 'Build intelligence' : 'Refresh data'}
            </Button>
          </div>
        </div>

        {/* Completeness */}
        <div className={panel}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Data completeness</p>
            <p className="text-2xl font-semibold text-text-primary">{coverage.score}%</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={coverage.score} aria-valuemin={0} aria-valuemax={100} aria-label="Data completeness">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${coverage.score}%` }} />
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            Weighted by source quality. It measures what Vireek knows about this property, not the property's condition.
          </p>
          {coverage.gaps.length > 0 && (
            <p className="mt-2 text-xs text-text-secondary">
              Biggest gaps: {coverage.gaps.slice(0, 4).map((g) => g.label).join(' · ')}
            </p>
          )}
        </div>

        {/* Insights */}
        <div className={panel}>
          <div className="mb-3 flex items-center gap-2 text-text-primary">
            <Lightbulb size={16} className="text-cta" />
            <p className="text-sm font-semibold">Insights</p>
          </div>
          {insights.length === 0 ? (
            <EmptyStateInline text="Insights appear as location, characteristics, permits and equipment data fill in." />
          ) : (
            <ul className="space-y-3">
              {insights.map((i) => (
                <li key={i.id} className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${SEVERITY_STYLES[i.severity]}`}>{i.severity}</span>
                    <span className="text-[10px] uppercase tracking-wide text-text-secondary">{KIND_LABELS[i.kind]}</span>
                    <p className="text-sm font-medium text-text-primary">{i.title}</p>
                  </div>
                  <p className="mt-1.5 text-xs text-text-secondary">{i.detail}</p>
                  <ul className="mt-1.5 list-disc pl-4 text-[11px] text-text-secondary">
                    {i.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* External layers */}
        <div className="grid gap-4 lg:grid-cols-3">
          <LayerPanel icon={<CloudSun size={16} />} title={LAYER_LABELS.climate} layer={layers.climate} hint="Run “Build intelligence” to load 5-year climate normals.">
            <ClimateBody d={layers.climate?.data ?? {}} />
          </LayerPanel>
          <LayerPanel icon={<ShieldAlert size={16} />} title={LAYER_LABELS.hazards} layer={layers.hazards} hint="Run “Build intelligence” to load flood and seismic context.">
            <HazardsBody d={layers.hazards?.data ?? {}} />
          </LayerPanel>
          <LayerPanel icon={<Landmark size={16} />} title={LAYER_LABELS.economic} layer={layers.economic} hint="Area statistics are available for US addresses.">
            <EconomicBody d={layers.economic?.data ?? {}} />
          </LayerPanel>
        </div>

        {/* Location + twin join */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={panel}>
            <div className="mb-2 flex items-center gap-2 text-text-primary">
              <MapPin size={16} className="text-cta" />
              <p className="text-sm font-semibold">Location</p>
            </div>
            <Row label="Coordinates" value={profile.latitude !== null && profile.longitude !== null ? `${profile.latitude.toFixed(5)}, ${profile.longitude.toFixed(5)}` : '—'} />
            <Row label="Country" value={profile.country_code ?? '—'} />
            <Row label="Census tract" value={profile.census_geoid ?? '—'} />
            <Row label="Geocode confidence" value={profile.geocode_confidence !== null ? `${Math.round(profile.geocode_confidence * 100)}%` : '—'} />
          </div>
          <div className={panel}>
            <div className="mb-2 flex items-center gap-2 text-text-primary">
              <Home size={16} className="text-cta" />
              <p className="text-sm font-semibold">From the Digital Twin</p>
            </div>
            <Row label="Equipment on site" value={String(twin.equipment.length)} />
            <Row label="Service visits" value={String(twin.jobs.length)} />
            <Row label="Open maintenance alerts" value={String(twin.maintenanceAlerts.length)} />
          </div>
        </div>

        {/* Manual layers */}
        <div className="grid gap-4 lg:grid-cols-2">
          <FieldsEditor
            icon={<Building2 size={16} />}
            title="Building characteristics"
            key={layers.characteristics?.fetched_at ?? 'characteristics-new'}
            layerKey="characteristics"
            fields={CHARACTERISTIC_FIELDS}
            layer={layers.characteristics}
            profileId={profile.id}
            onSaved={refreshQuiet}
          />
          <FieldsEditor
            icon={<Zap size={16} />}
            title="Energy"
            key={layers.energy?.fetched_at ?? 'energy-new'}
            layerKey="energy"
            fields={ENERGY_FIELDS}
            layer={layers.energy}
            profileId={profile.id}
            onSaved={refreshQuiet}
          />
        </div>

        <GraphPanel intel={intel} onChanged={refreshQuiet} />
      </div>
    </DashboardLayout>
  );
}
