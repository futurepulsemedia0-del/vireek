/**
 * Emergency Network — /dashboard/emergency-network
 *
 * Triage -> Dispatch -> ETA -> Customer updates -> Technician prep -> Job -> Evidence -> Payment -> Follow-up,
 * with the Contractor Network as the fallback: "No technician available" != "No service available".
 * See src/lib/emergencyNetwork.ts.
 */

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, Network, Phone, Plus, RefreshCw, Settings2, Siren, Zap } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  HAZARD_CHOICES,
  SLA_COLORS,
  SOURCE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  TIER_COLORS,
  TIER_LABELS,
  TRADE_LABELS,
  cancelIncident,
  computeStats,
  declareEmergency,
  decideNetworkHandoff,
  fetchIncidentEvents,
  fetchIncidents,
  fetchSettings,
  formatEtaMinutes,
  formatSla,
  isActive,
  needsAttention,
  pipelineProgress,
  retryIncident,
  runIncidentNow,
  saveSettings,
  slaView,
  validateSettings,
  type EmergencyIncident,
  type EmergencyNetworkSettings,
  type IncidentEvent,
  type SettingsInput,
  type StepState,
} from '@/lib/emergencyNetwork';

type Tab = 'live' | 'declare' | 'settings';

const POLL_MS = 15_000;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>;
}

function StatCard({ label, value, tone = 'text-text-primary' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

const STEP_STYLES: Record<StepState, string> = {
  done: 'bg-success-500 text-white',
  current: 'bg-accent text-white',
  pending: 'bg-bg-tertiary text-text-secondary',
  failed: 'bg-danger text-white',
};

function Pipeline({ incident }: { incident: EmergencyIncident }) {
  const steps = pipelineProgress(incident);
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Emergency pipeline">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${STEP_STYLES[s.state]}`}>
            {s.state === 'done' ? <Check size={11} aria-hidden="true" /> : <span aria-hidden="true">{i + 1}</span>}
            {s.label}
            <span className="sr-only"> — {s.state}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const OUTCOME_DOT: Record<IncidentEvent['outcome'], string> = {
  ok: 'bg-success-500',
  info: 'bg-accent',
  skipped: 'bg-text-secondary',
  failed: 'bg-danger',
};

function Timeline({ incidentId, version }: { incidentId: string; version: string }) {
  const [events, setEvents] = useState<IncidentEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchIncidentEvents(incidentId)
      .then((rows) => {
        if (!cancelled) {
          setEvents(rows);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [incidentId, version]);

  if (failed) return <p className="text-xs text-text-secondary">The timeline could not be loaded.</p>;
  if (events === null) return <p className="text-xs text-text-secondary">Loading timeline…</p>;
  if (events.length === 0) return <p className="text-xs text-text-secondary">No activity yet.</p>;
  return (
    <ol className="space-y-2 border-l border-border pl-3">
      {events.map((e) => (
        <li key={e.id} className="relative text-xs">
          <span className={`absolute -left-[17px] top-1 h-2 w-2 rounded-full ${OUTCOME_DOT[e.outcome]}`} aria-hidden="true" />
          <p className="text-text-primary">{e.summary}</p>
          <p className="text-text-secondary">
            {formatWhen(e.created_at)}
            {e.actor !== 'system' ? ' · by a person' : ''}
          </p>
        </li>
      ))}
    </ol>
  );
}

function IncidentCard({ incident, canAct, onChanged }: { incident: EmergencyIncident; canAct: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(needsAttention(incident));
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const sla = slaView(incident);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const open_ = isActive(incident.status);

  return (
    <div className={`rounded-2xl border bg-bg-secondary ${needsAttention(incident) ? 'border-warning-500' : 'border-border'}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex w-full items-start justify-between gap-3 rounded-2xl p-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className={TIER_COLORS[incident.severity_tier]}>{TIER_LABELS[incident.severity_tier]}</Badge>
            <Badge className={STATUS_COLORS[incident.status]}>{STATUS_LABELS[incident.status]}</Badge>
            <Badge className="bg-bg-tertiary text-text-secondary">{TRADE_LABELS[incident.required_trade]}</Badge>
            {incident.insurance_involved && <Badge className="bg-bg-tertiary text-text-secondary">Insurance</Badge>}
          </div>
          <p className="truncate text-sm font-semibold text-text-primary">{incident.customer_name}</p>
          <p className="truncate text-xs text-text-secondary">{incident.description ?? incident.address ?? 'No description'}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {open_ && <span className={SLA_COLORS[sla.state]}>{formatSla(sla)}</span>}
            {incident.assigned_technician_name && (
              <span className="text-text-secondary">
                {incident.assigned_technician_name}
                {incident.eta_minutes_est !== null ? ` · ETA ${formatEtaMinutes(incident.eta_minutes_est)} (estimate)` : ''}
              </span>
            )}
            {incident.partner_name && <span className="text-text-secondary">Partner: {incident.partner_name}</span>}
          </div>
        </div>
        <ChevronDown size={16} className={`mt-1 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          <Pipeline incident={incident} />

          {incident.decision.reason && (
            <div className="rounded-xl bg-bg-primary p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Why Vireek chose this</p>
              <p className="mt-1 text-sm text-text-primary">{incident.decision.reason}</p>
            </div>
          )}

          {incident.last_error && incident.status === 'needs_human' && (
            <p className="flex items-start gap-2 text-sm text-danger" role="alert">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              {incident.last_error}
            </p>
          )}

          <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-2"><dt className="text-text-secondary">Reported</dt><dd className="text-text-primary">{formatWhen(incident.created_at)} · {SOURCE_LABELS[incident.source]}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-text-secondary">Address</dt><dd className="truncate text-text-primary">{incident.address ?? '—'}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-text-secondary">Severity</dt><dd className="text-text-primary">{incident.severity_score}{incident.severity_reason ? ` · ${incident.severity_reason}` : ''}</dd></div>
            <div className="flex justify-between gap-2">
              <dt className="text-text-secondary">Customer</dt>
              <dd className="text-text-primary">
                {incident.customer_phone ? (
                  <a href={`tel:${incident.customer_phone}`} className="focus-ring inline-flex items-center gap-1 rounded text-accent">
                    <Phone size={11} aria-hidden="true" /> {incident.customer_phone}
                  </a>
                ) : '—'}
              </dd>
            </div>
            {incident.partner_phone && (
              <div className="flex justify-between gap-2"><dt className="text-text-secondary">Partner phone</dt><dd className="text-text-primary">{incident.partner_phone}</dd></div>
            )}
          </dl>

          {canAct && incident.status === 'network_pending_approval' && (
            <div className="rounded-xl bg-bg-primary p-3">
              <p className="mb-2 text-sm text-text-primary">Our crews cannot respond fast enough. Send this emergency to trusted Contractor Network partners?</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => void run(() => decideNetworkHandoff(incident.id, true), 'Sent to the network')}>
                  <Network size={14} /> Approve hand-off
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => decideNetworkHandoff(incident.id, false), 'Using our own technician')}>
                  Use our own technician
                </Button>
              </div>
            </div>
          )}

          {canAct && open_ && !cancelling && (
            <div className="flex flex-wrap gap-2">
              {incident.status === 'needs_human' && (
                <Button size="sm" disabled={busy} onClick={() => void run(() => retryIncident(incident.id), 'Retrying')}>
                  <RefreshCw size={14} /> Retry automatically
                </Button>
              )}
              {incident.status !== 'needs_human' && incident.status !== 'network_pending_approval' && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => runIncidentNow(incident.id), 'Checked now')}>
                  <Zap size={14} /> Check now
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(true)}>
                Cancel emergency
              </Button>
            </div>
          )}

          {canAct && cancelling && (
            <div className="space-y-2 rounded-xl bg-bg-primary p-3">
              <Textarea label="Why are you cancelling?" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !reason.trim()}
                  onClick={() => void run(() => cancelIncident(incident.id, reason), 'Emergency cancelled').then(() => setCancelling(false))}
                >
                  Confirm cancellation
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Timeline</p>
            <Timeline incidentId={incident.id} version={`${incident.updated_at}:${incident.status}`} />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// DECLARE
// ============================================================

function DeclareForm({ enabled, onCreated }: { enabled: boolean; onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [hazards, setHazards] = useState<string[]>([]);
  const [insurance, setInsurance] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setHazards((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));

  const submit = async () => {
    if (!description.trim() && hazards.length === 0) {
      toast('Describe the emergency or select a hazard.', 'error');
      return;
    }
    setBusy(true);
    try {
      await declareEmergency({
        customer_name: name,
        customer_phone: phone,
        address,
        description,
        hazards,
        insurance_involved: insurance,
      });
      toast('Emergency declared — Vireek is on it', 'success');
      setName('');
      setPhone('');
      setAddress('');
      setDescription('');
      setHazards([]);
      setInsurance(false);
      onCreated();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) {
    return <EmptyState icon={Siren} title="Emergency Network is off" description="Switch it on in Settings to declare emergencies and let Vireek run the whole response." />;
  }

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">If anyone is in immediate danger, tell them to get to safety and call 911 first.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Customer name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        <Input label="Customer phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} />
      </div>
      <Input label="Address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={400} helperText="A full address gives the most accurate ETA." />
      <Textarea label="What is happening?" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} placeholder="Pipe burst in the basement, water everywhere" />
      <div>
        <p className="mb-2 text-sm font-medium text-text-primary">Hazards</p>
        <div className="flex flex-wrap gap-2">
          {HAZARD_CHOICES.map((h) => (
            <button
              key={h.id}
              type="button"
              aria-pressed={hazards.includes(h.id)}
              onClick={() => toggle(h.id)}
              className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${hazards.includes(h.id) ? 'bg-danger text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
            >
              {h.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={insurance} onChange={(e) => setInsurance(e.target.checked)} />
        Insurance claim likely
      </label>
      <Button onClick={() => void submit()} disabled={busy}>
        <Siren size={16} /> Declare emergency
      </Button>
    </div>
  );
}

// ============================================================
// SETTINGS
// ============================================================

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-start gap-3 py-2 text-sm text-text-primary">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="mt-0.5" />
      <span>
        {label}
        <span className="block text-xs text-text-secondary">{hint}</span>
      </span>
    </label>
  );
}

function SettingsPanel({ settings, canManage, onSaved }: { settings: EmergencyNetworkSettings; canManage: boolean; onSaved: (s: EmergencyNetworkSettings) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<SettingsInput>(() => {
    const { user_id: _unused, ...rest } = settings;
    void _unused;
    return rest;
  });
  const [busy, setBusy] = useState(false);

  const num = (key: keyof SettingsInput) => (v: string) => setDraft((d) => ({ ...d, [key]: v === '' ? Number.NaN : Number(v) }));
  const numValue = (n: number) => (Number.isFinite(n) ? String(n) : '');

  const save = async () => {
    const problem = validateSettings(draft);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setBusy(true);
    try {
      onSaved(await saveSettings(draft));
      toast('Emergency Network settings saved', 'success');
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const off = !canManage;

  return (
    <div className="space-y-4">
      {off && <p className="rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">Only owners, admins and security managers can change these settings.</p>}

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Autonomous response</h2>
        <Toggle label="Emergency Network enabled" hint="Master switch. Off = nothing autonomous happens." checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} disabled={off} />
        <Toggle label="Dispatch the best technician automatically" hint="Off = Vireek only triages and alerts you." checked={draft.auto_dispatch} onChange={(v) => setDraft((d) => ({ ...d, auto_dispatch: v }))} disabled={off} />
        <Toggle
          label="Hand over to the Contractor Network without asking"
          hint="Off (recommended) = you approve each hand-off with one tap. If you do not answer in 10 minutes, Vireek uses your own best technician."
          checked={draft.auto_network_handoff}
          onChange={(v) => setDraft((d) => ({ ...d, auto_network_handoff: v }))}
          disabled={off}
        />
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Input label="Use the network if our best ETA is above (minutes)" inputMode="numeric" value={numValue(draft.max_internal_eta_minutes)} onChange={(e) => num('max_internal_eta_minutes')(e.target.value)} disabled={off} />
          <Input label="Wait for a partner at most (minutes)" inputMode="numeric" value={numValue(draft.network_wait_minutes)} onChange={(e) => num('network_wait_minutes')(e.target.value)} disabled={off} />
          <Input label="Referral fee to partners (%)" inputMode="decimal" value={numValue(draft.referral_fee_pct)} onChange={(e) => num('referral_fee_pct')(e.target.value)} disabled={off} />
          <Input label="Phone for emergency alerts" inputMode="tel" value={draft.notify_phone ?? ''} onChange={(e) => setDraft((d) => ({ ...d, notify_phone: e.target.value }))} disabled={off} helperText="Optional SMS when something needs you." />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Response targets (SLA)</h2>
        <p className="mb-3 text-xs text-text-secondary">Minutes until a technician must be committed to the emergency.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Critical" inputMode="numeric" value={numValue(draft.sla_critical_minutes)} onChange={(e) => num('sla_critical_minutes')(e.target.value)} disabled={off} />
          <Input label="High" inputMode="numeric" value={numValue(draft.sla_high_minutes)} onChange={(e) => num('sla_high_minutes')(e.target.value)} disabled={off} />
          <Input label="Standard" inputMode="numeric" value={numValue(draft.sla_standard_minutes)} onChange={(e) => num('sla_standard_minutes')(e.target.value)} disabled={off} />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Customer communication</h2>
        <Toggle label="Text the customer at each step" hint="Sent through your compliant SMS channel (opt-outs and A2P approval are respected)." checked={draft.customer_updates} onChange={(v) => setDraft((d) => ({ ...d, customer_updates: v }))} disabled={off} />
        <Toggle label="Share the estimated arrival time" hint="Always labelled as an estimate. Off = no time is promised." checked={draft.publish_estimated_eta} onChange={(v) => setDraft((d) => ({ ...d, publish_estimated_eta: v }))} disabled={off} />
      </div>

      <p className="text-xs text-text-secondary">
        To use the Contractor Network fallback, your business must have joined the network and the cron job must call the orchestrator every minute.
      </p>

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function EmergencyNetworkPage() {
  const { isOwner, permissions } = useAuth();
  const canManage = isOwner || Boolean(permissions?.can_manage_security);

  const [tab, setTab] = useState<Tab>('live');
  const [showAll, setShowAll] = useState(false);
  const [incidents, setIncidents] = useState<EmergencyIncident[]>([]);
  const [settings, setSettings] = useState<EmergencyNetworkSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rows, s] = await Promise.all([fetchIncidents(), fetchSettings()]);
      setIncidents(rows);
      setSettings(s);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const stats = computeStats(incidents);
  const visible = showAll ? incidents : incidents.filter((i) => isActive(i.status));
  const attention = stats.needsAttention;

  const tabs: Array<{ key: Tab; label: string; icon: typeof Siren; badge?: number }> = [
    { key: 'live', label: 'Live emergencies', icon: Siren, badge: attention },
    { key: 'declare', label: 'Declare', icon: Plus },
    { key: 'settings', label: 'Settings', icon: Settings2 },
  ];

  return (
    <DashboardLayout activeLabel="Emergency Network">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Siren size={18} /> Emergency Network
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              One call becomes a complete response: triage, dispatch, ETA, customer updates, technician prep, job, evidence, payment and follow-up. If your own crews cannot respond in time, the Contractor Network steps in.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading} className="shrink-0">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        {settings && !settings.enabled && (
          <p className="mb-4 rounded-xl bg-warning-500/10 px-3 py-2 text-sm text-warning-500" role="status">
            The Emergency Network is switched off, so nothing runs automatically. Turn it on in Settings.
          </p>
        )}

        <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Emergency Network sections">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
            >
              <t.icon size={13} aria-hidden="true" />
              {t.label}
              {t.badge !== undefined && t.badge > 0 && <span className="rounded-full bg-warning-500 px-1.5 py-0.5 text-[10px] text-white">{t.badge}</span>}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={2} />
          </div>
        ) : failed || !settings ? (
          <EmptyState
            icon={AlertTriangle}
            title="Emergency Network unavailable"
            description="It could not be loaded. Make sure the latest database migration has been applied, then try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : (
          <>
            {tab === 'live' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatCard label="Active emergencies" value={stats.active} />
                  <StatCard label="Need you now" value={stats.needsAttention} tone={stats.needsAttention > 0 ? 'text-warning-500' : 'text-text-primary'} />
                  <StatCard label="With network partners" value={stats.withPartner} />
                  <StatCard label="Response target passed" value={stats.slaBreached} tone={stats.slaBreached > 0 ? 'text-danger' : 'text-text-primary'} />
                </div>

                <div className="flex gap-2" role="group" aria-label="Which emergencies to show">
                  {([false, true] as const).map((all) => (
                    <button
                      key={String(all)}
                      type="button"
                      aria-pressed={showAll === all}
                      onClick={() => setShowAll(all)}
                      className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${showAll === all ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                    >
                      {all ? 'All' : 'Active'}
                    </button>
                  ))}
                </div>

                {visible.length === 0 ? (
                  <EmptyState
                    icon={Siren}
                    title={showAll ? 'No emergencies yet' : 'No active emergencies'}
                    description="When an emergency call, a customer self-triage report or a declared emergency arrives, you will see Vireek work through it here."
                    action={settings.enabled ? { label: 'Declare an emergency', onClick: () => setTab('declare') } : undefined}
                  />
                ) : (
                  <div className="space-y-3">
                    {visible.map((i) => (
                      <IncidentCard key={i.id} incident={i} canAct={true} onChanged={refresh} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'declare' && <DeclareForm enabled={settings.enabled} onCreated={() => { setTab('live'); refresh(); }} />}
            {tab === 'settings' && <SettingsPanel settings={settings} canManage={canManage} onSaved={setSettings} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
