import { useState } from 'react';
import { Check, Copy, KeyRound, Pause, Play, Plug, Trash2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import {
  PROVIDER_LABELS,
  createTelematicsConnection,
  deleteConnection,
  fleetIngestUrl,
  formatAge,
  minutesSince,
  setConnectionStatus,
  updateVehicleTelematics,
  type FleetOverview,
  type FleetVehicle,
  type TelematicsProvider,
} from '@/lib/fleetIntelligence';

const fieldClass =
  'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

const FUEL_TYPES = ['gasoline', 'diesel', 'hybrid', 'electric', 'propane', 'other'] as const;

function VehicleMappingRow({
  vehicle,
  technicians,
  onSaved,
}: {
  vehicle: FleetVehicle;
  technicians: FleetOverview['technicians'];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [technicianId, setTechnicianId] = useState(vehicle.assigned_technician_id ?? '');
  const [provider, setProvider] = useState(vehicle.telematics_provider ?? '');
  const [deviceId, setDeviceId] = useState(vehicle.telematics_device_id ?? '');
  const [fuelType, setFuelType] = useState(vehicle.fuel_type);
  const [mpg, setMpg] = useState(vehicle.rated_mpg != null ? String(vehicle.rated_mpg) : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsedMpg = mpg.trim() === '' ? null : Number(mpg);
    if (parsedMpg !== null && (!Number.isFinite(parsedMpg) || parsedMpg <= 0 || parsedMpg >= 200)) {
      toast('Rated MPG must be between 1 and 199.', 'error');
      return;
    }
    setSaving(true);
    try {
      await updateVehicleTelematics(vehicle.id, {
        assigned_technician_id: technicianId || null,
        telematics_provider: provider || null,
        telematics_device_id: deviceId.trim() || null,
        fuel_type: fuelType,
        rated_mpg: parsedMpg,
      });
      toast(`${vehicle.label} saved.`, 'success');
      onSaved();
    } catch {
      toast('Could not save. Is that device already linked to another vehicle?', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-xl border border-border bg-bg-primary p-3 sm:grid-cols-6">
      <p className="self-center text-sm font-semibold text-text-primary sm:col-span-1">{vehicle.label}</p>
      <select aria-label={`Driver for ${vehicle.label}`} value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} className={fieldClass}>
        <option value="">No driver</option>
        {technicians.map((t) => (
          <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>
        ))}
      </select>
      <select aria-label={`Provider for ${vehicle.label}`} value={provider} onChange={(e) => setProvider(e.target.value)} className={fieldClass}>
        <option value="">No provider</option>
        {(Object.keys(PROVIDER_LABELS) as TelematicsProvider[]).map((p) => (
          <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
        ))}
      </select>
      <input aria-label={`Device ID for ${vehicle.label}`} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="Device / vehicle ID" className={fieldClass} />
      <div className="flex gap-2">
        <select aria-label={`Fuel type for ${vehicle.label}`} value={fuelType} onChange={(e) => setFuelType(e.target.value)} className={`${fieldClass} capitalize`}>
          {FUEL_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input aria-label={`Rated MPG for ${vehicle.label}`} value={mpg} onChange={(e) => setMpg(e.target.value)} type="number" min="1" max="199" step="0.1" placeholder="MPG" className={`${fieldClass} w-20`} />
      </div>
      <Button size="sm" variant="secondary" onClick={save} disabled={saving} className="min-h-[36px] px-3 py-2">
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

export function FleetConnectPanel({
  overview,
  ownerId,
  onChanged,
}: {
  overview: FleetOverview;
  ownerId: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [provider, setProvider] = useState<TelematicsProvider>('samsara');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<'token' | 'url' | null>(null);

  const url = fleetIngestUrl();

  const create = async () => {
    setCreating(true);
    try {
      const { token } = await createTelematicsConnection({ ownerId, provider, label });
      setFreshToken(token);
      setLabel('');
      onChanged();
    } catch {
      toast('Could not create the connection.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const copy = async (what: 'token' | 'url', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast('Copy failed. Select the text and copy it manually.', 'error');
    }
  };

  const toggle = async (id: string, status: 'active' | 'paused') => {
    try {
      await setConnectionStatus(id, status === 'active' ? 'paused' : 'active');
      onChanged();
    } catch {
      toast('Could not update the connection.', 'error');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this connection? Any device still using its token will stop being accepted.')) return;
    try {
      await deleteConnection(id);
      onChanged();
    } catch {
      toast('Could not delete the connection.', 'error');
    }
  };

  const sample = `curl -X POST '${url}' \\
  -H 'X-Fleet-Token: <YOUR_TOKEN>' \\
  -H 'Content-Type: application/json' \\
  -d '{"pings":[{"device_id":"<DEVICE_ID>","provider":"${provider}","recorded_at":"${new Date().toISOString()}","latitude":30.2672,"longitude":-97.7431,"speed_mph":31,"ignition_on":true,"odometer_miles":48210.4}]}'`;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary"><Plug size={14} /> Telematics connections</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Each connection gets its own secret token. Point your GPS provider's webhook (or a small gateway) at the ingest URL below and send the token in the
          <code className="mx-1 rounded bg-bg-tertiary px-1">X-Fleet-Token</code> header. Only a hash of the token is stored.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-secondary p-3">
          <code className="min-w-0 flex-1 truncate text-xs text-text-secondary">{url}</code>
          <Button size="sm" variant="ghost" onClick={() => copy('url', url)} className="min-h-[32px] px-3 py-1.5">
            {copied === 'url' ? <Check size={14} /> : <Copy size={14} />} Copy URL
          </Button>
        </div>

        <div className="mb-4 grid gap-2 rounded-xl border border-border bg-bg-secondary p-3 sm:grid-cols-4">
          <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as TelematicsProvider)} className={fieldClass}>
            {(Object.keys(PROVIDER_LABELS) as TelematicsProvider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
          </select>
          <input aria-label="Connection label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Samsara — main yard)" className={`${fieldClass} sm:col-span-2`} maxLength={60} />
          <Button size="sm" onClick={create} disabled={creating}>
            <KeyRound size={14} /> {creating ? 'Creating…' : 'Create token'}
          </Button>
        </div>

        {freshToken && (
          <div className="mb-4 rounded-xl border border-warning-500/40 bg-warning-500/5 p-3">
            <p className="mb-2 text-xs font-semibold text-text-primary">Copy this token now. It will never be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-xs text-text-primary">{freshToken}</code>
              <Button size="sm" variant="secondary" onClick={() => copy('token', freshToken)} className="min-h-[32px] px-3 py-1.5">
                {copied === 'token' ? <Check size={14} /> : <Copy size={14} />} Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)} className="min-h-[32px] px-3 py-1.5">Done</Button>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-primary p-3 text-[11px] text-text-secondary">{sample}</pre>
          </div>
        )}

        <div className="space-y-2">
          {overview.connections.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{c.label}</p>
                <p className="text-[11px] text-text-secondary">
                  {PROVIDER_LABELS[c.provider]} · token …{c.token_hint} · last data {formatAge(minutesSince(c.last_event_at))}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.status === 'active' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{c.status}</span>
                <button type="button" onClick={() => toggle(c.id, c.status)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-accent" aria-label={c.status === 'active' ? 'Pause connection' : 'Resume connection'}>
                  {c.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button type="button" onClick={() => remove(c.id)} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger" aria-label="Delete connection">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Vehicle ↔ driver ↔ device</h2>
        <p className="mb-3 text-xs text-text-secondary">
          The driver link is what ties a truck's GPS to a technician and their jobs. The device ID must match what your provider sends. Rated MPG and fuel type
          are used only until enough real fuel expenses are logged.
        </p>
        <div className="space-y-2">
          {overview.vehicles.map((v) => (
            <VehicleMappingRow key={v.id} vehicle={v} technicians={overview.technicians} onSaved={onChanged} />
          ))}
          {overview.vehicles.length === 0 && (
            <p className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
              Add your trucks on the Fleet Economics page first, then map them here.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
