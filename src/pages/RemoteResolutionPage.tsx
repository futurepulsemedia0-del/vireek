import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Loader2, PhoneCall, Plus, Wifi } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  BUCKET_LABELS,
  CATEGORY_LABELS,
  STATUS_META,
  brierLabel,
  calibrationReady,
  formatUsd,
  pct,
  rate,
  validateSettings,
  type RrCase,
  type RrDevice,
  type RrSettings,
  type RrStats,
  type RrTone,
} from '@/lib/remoteResolution';
import {
  fetchActiveCases,
  fetchDevices,
  fetchEquipmentOptions,
  fetchSettings,
  fetchStats,
  registerDevice,
  saveSettings,
  setDeviceActive,
} from '@/lib/remoteResolutionApi';

const TONE_TEXT: Record<RrTone, string> = {
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger',
  neutral: 'text-text-secondary',
};
const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-sm text-text-primary focus-visible:border-accent';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

type CaseRowT = RrCase & { job: { customer_name: string; service_type: string | null } | null };

export function RemoteResolutionPage() {
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const [days, setDays] = useState(90);
  const [stats, setStats] = useState<RrStats | null>(null);
  const [cases, setCases] = useState<CaseRowT[]>([]);
  const [settings, setSettings] = useState<RrSettings | null>(null);
  const [devices, setDevices] = useState<RrDevice[]>([]);
  const [equipment, setEquipment] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [costDollars, setCostDollars] = useState('');

  const [devEquipment, setDevEquipment] = useState('');
  const [devLabel, setDevLabel] = useState('');
  const [devVendor, setDevVendor] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const load = useCallback(async () => {
    try {
      const [st, cs, se, dv, eq] = await Promise.all([
        fetchStats(days),
        fetchActiveCases(25),
        fetchSettings(),
        fetchDevices().catch(() => [] as RrDevice[]),
        fetchEquipmentOptions().catch(() => [] as { id: string; label: string }[]),
      ]);
      setStats(st);
      setCases(cs as CaseRowT[]);
      setSettings(se);
      setCostDollars(String(se.truck_roll_cost_cents / 100));
      setDevices(dv);
      setEquipment(eq);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load remote resolution.', 'error');
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async () => {
    if (!settings || saving) return;
    const dollars = Number(costDollars);
    const next: RrSettings = { ...settings, truck_roll_cost_cents: Number.isFinite(dollars) ? Math.round(dollars * 100) : -1 };
    const problems = validateSettings(next);
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      setSettings(await saveSettings(next));
      toast('Settings saved.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const onRegister = async () => {
    if (registering || !devEquipment || devLabel.trim().length < 2) return;
    setRegistering(true);
    try {
      const res = await registerDevice(devEquipment, devLabel, devVendor);
      setNewKey(res.key);
      setDevLabel('');
      setDevVendor('');
      setDevices(await fetchDevices());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not register the device.', 'error');
    } finally {
      setRegistering(false);
    }
  };

  const toggleDevice = async (d: RrDevice) => {
    try {
      await setDeviceActive(d.id, !d.active);
      setDevices((list) => list.map((x) => (x.id === d.id ? { ...x, active: !d.active } : x)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the device.', 'error');
    }
  };

  const ingestUrl = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://YOUR-PROJECT.supabase.co'}/functions/v1/rr-device-ingest`;
  const resolvedRate = stats ? rate(stats.resolved_of_attempted, stats.attempted) : null;
  const reopenRate = stats ? rate(stats.reopened, stats.resolved_remotely + stats.reopened) : null;

  return (
    <DashboardLayout activeLabel="Remote Resolution">
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <PhoneCall size={22} aria-hidden="true" /> Remote Resolution
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Solve the problem before a truck rolls. Savings only count after the customer confirmed the fix and the verification window passed without the problem returning.
            </p>
          </div>
          <label className="text-sm text-text-secondary">
            <span className="sr-only">Period</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={SELECT_CLASS}>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 12 months</option>
            </select>
          </label>
        </header>

        {loading || !stats ? (
          <SkeletonStatGrid count={4} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Truck rolls avoided" value={String(stats.resolved_remotely)} hint={`${stats.pending_verification} awaiting verification`} />
              <Stat label="Verified savings" value={formatUsd(stats.avoided_cost_cents)} hint={`+ ${formatUsd(stats.pending_savings_cents)} pending`} />
              <Stat label="Resolved of attempted" value={pct(resolvedRate)} hint={`${stats.resolved_of_attempted} of ${stats.attempted} attempts`} />
              <Stat label="Problem came back" value={pct(reopenRate)} hint={`${stats.reopened} reopened`} />
            </div>

            <Card className="space-y-3 p-6">
              <h2 className="text-base font-bold text-text-primary">Is the percentage honest?</h2>
              {calibrationReady(stats) ? (
                <>
                  <p className="text-sm text-text-secondary">
                    When Vireek says 80%, about 80 of 100 such cases should end without a visit. Calibration: <span className="font-semibold text-text-primary">{brierLabel(stats.brier)}</span>
                    {stats.brier != null ? ` (Brier ${stats.brier})` : ''}.
                  </p>
                  <div className="space-y-2">
                    {stats.calibration.map((b) => (
                      <div key={b.bucket} className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 text-sm">
                        <span className="text-text-secondary">{BUCKET_LABELS[b.bucket] ?? '?'}</span>
                        <div className="relative h-2 rounded-full bg-bg-tertiary" aria-hidden="true">
                          <div className="absolute inset-y-0 left-0 rounded-full bg-accent/30" style={{ width: `${b.predicted}%` }} />
                          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${b.actual}%`, height: '50%', top: '25%' }} />
                        </div>
                        <span className="text-xs text-text-secondary">
                          said {b.predicted}% · was {b.actual}% (n={b.n})
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-text-secondary">
                  Calibration appears after 10 attempted cases ({stats.attempted} so far). Until then the probability starts from conservative defaults and learns from your own outcomes.
                </p>
              )}
            </Card>

            <section aria-label="Recent cases" className="space-y-3">
              <h2 className="text-base font-bold text-text-primary">Recent cases</h2>
              {cases.length === 0 ? (
                <EmptyState
                  icon={PhoneCall}
                  title="No remote attempts yet"
                  description="Open a scheduled job and use the Remote Resolution panel to start one."
                />
              ) : (
                <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary">
                  {cases.map((c) => {
                    const m = STATUS_META[c.status];
                    return (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">{c.job?.customer_name ?? 'Customer'} · {c.symptom}</p>
                          <p className="text-xs text-text-secondary">
                            {CATEGORY_LABELS[c.category] ?? c.category} · {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          {c.probability != null && <span className="text-text-secondary">{c.probability}%</span>}
                          <span className={`font-semibold ${TONE_TEXT[m.tone]}`}>{m.label}</span>
                          <Link to="/dashboard/jobs" className="focus-ring rounded text-accent hover:underline">
                            Open jobs
                          </Link>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}

        {settings && (
          <Card className="space-y-4 p-6">
            <h2 className="text-base font-bold text-text-primary">Settings</h2>
            {!isOwner && <p className="text-sm text-text-secondary">Only the account owner can change these.</p>}
            <label className="flex items-center gap-3 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={!isOwner}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-accent,#4f46e5)]"
              />
              Remote Resolution is on
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Average cost of one truck roll ($)"
                inputMode="decimal"
                value={costDollars}
                disabled={!isOwner}
                onChange={(e) => setCostDollars(e.target.value)}
                helperText="Used to value each avoided visit. Use your real fully-loaded number."
              />
              <Input
                label="Try remote fix when chance is at least (%)"
                inputMode="numeric"
                value={settings.attempt_threshold}
                disabled={!isOwner}
                onChange={(e) => setSettings({ ...settings, attempt_threshold: Number(e.target.value) || 0 })}
                helperText="Lower = more attempts, more customers asked to try. 55 is a balanced start."
              />
              <Input
                label="Verification window (hours)"
                inputMode="numeric"
                value={settings.verification_hours}
                disabled={!isOwner}
                onChange={(e) => setSettings({ ...settings, verification_hours: Number(e.target.value) || 0 })}
                helperText="Savings count only if the problem does not return within this time."
              />
              <Input
                label="How long an attempt stays open (hours)"
                inputMode="numeric"
                value={settings.hold_hours}
                disabled={!isOwner}
                onChange={(e) => setSettings({ ...settings, hold_hours: Number(e.target.value) || 0 })}
              />
            </div>
            {errors.length > 0 && (
              <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-danger">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {isOwner && (
              <Button size="sm" onClick={onSave} disabled={saving}>
                {saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />} Save settings
              </Button>
            )}
          </Card>
        )}

        <Card className="space-y-4 p-6">
          <h2 className="flex items-center gap-2 text-base font-bold text-text-primary">
            <Wifi size={16} aria-hidden="true" /> Connected devices
          </h2>
          <p className="text-sm text-text-secondary">
            A thermostat, leak sensor or gateway can send readings for one piece of equipment. Vireek reads the last 24 hours when it reasons about a case.
          </p>

          {equipment.length === 0 ? (
            <p className="text-sm text-text-secondary">Add equipment to a customer first, then register a device for it.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-text-primary">Equipment</span>
                <select value={devEquipment} onChange={(e) => setDevEquipment(e.target.value)} className={SELECT_CLASS}>
                  <option value="">Choose...</option>
                  {equipment.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </label>
              <Input label="Device name" value={devLabel} onChange={(e) => setDevLabel(e.target.value)} maxLength={80} />
              <Input label="Vendor (optional)" value={devVendor} onChange={(e) => setDevVendor(e.target.value)} maxLength={60} />
              <div className="sm:col-span-3">
                <Button size="sm" onClick={onRegister} disabled={registering || !devEquipment || devLabel.trim().length < 2}>
                  {registering ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />} Register device
                </Button>
              </div>
            </div>
          )}

          {newKey && (
            <div role="status" className="space-y-2 rounded-xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm">
              <p className="font-semibold text-text-primary">Copy this key now. It is shown only once.</p>
              <code className="block break-all rounded-lg bg-bg-primary p-2 text-xs text-text-primary">{newKey}</code>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(newKey).then(() => toast('Key copied.', 'success'));
                  }}
                >
                  <Copy size={14} aria-hidden="true" /> Copy key
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>
                  I saved it
                </Button>
              </div>
              <p className="text-xs text-text-secondary">
                POST to <code>{ingestUrl}</code> with header <code>x-device-key</code> and body{' '}
                <code>{'{"readings":[{"metric":"supply_air_temp_f","value":55.2}]}'}</code>. Up to 50 readings per request.
              </p>
            </div>
          )}

          {devices.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-text-primary">{d.label}</p>
                    <p className="text-xs text-text-secondary">
                      {d.vendor ? `${d.vendor} · ` : ''}key {d.key_prefix}… · {d.last_seen_at ? `last seen ${new Date(d.last_seen_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'never connected'}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => toggleDevice(d)}>
                    {d.active ? 'Disable' : 'Enable'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}
