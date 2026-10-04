import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  BatteryLow,
  CheckCircle2,
  Copy,
  Cpu,
  Package,
  Plus,
  Radar,
  RefreshCw,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  curlExample,
  deviceIsOnline,
  dismissMission,
  fetchDevices,
  fetchEquipmentOptions,
  fetchMissions,
  fetchPredictions,
  formatRelative,
  PART_STATUS_LABEL,
  PART_STATUS_STYLE,
  PIPELINE,
  recordOutcome,
  registerDevice,
  runPropertyIntelligenceAgent,
  setDeviceStatus,
  SEVERITY_STYLE,
  stageIndex,
  type DeviceProtocol,
  type EquipmentOption,
  type MissionOutcome,
  type PioDevice,
  type PioMission,
  type PioPrediction,
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
