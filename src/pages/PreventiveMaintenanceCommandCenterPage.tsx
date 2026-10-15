/**
 * Preventive Maintenance Command Center - /dashboard/preventive-maintenance
 *
 * One queue for every maintenance obligation (overdue, due soon, contract, warranty, seasonal, high-risk),
 * built from existing Equipment / Lifecycle / Failure Prediction / Warranty / Contract data. For each unit it
 * recommends the visit date, technician, parts and customer message, and creates the job atomically.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Package,
  Radar,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { handoffPfnForecast } from '@/lib/predictiveFailure';
import {
  PRIORITY_LABEL,
  SIGNAL_LABEL,
  buildCandidates,
  buildDispatchNote,
  describeAssignment,
  describeScheduleError,
  formatDay,
  kitOnTruckByTechnician,
  planParts,
  rankTechnicians,
  summarize,
  wantedParts,
  type PmCandidate,
  type PmPartLine,
  type PmPartSource,
  type PmPriority,
  type PmSettings,
  type PmSignalKind,
} from '@/lib/preventiveMaintenance';
import {
  dismissUnit,
  loadSnapshot,
  notifyCustomer,
  savePmSettings,
  scheduleVisit,
  snoozeUnit,
  type PmSnapshot,
} from '@/lib/preventiveMaintenanceApi';

const FIELD = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const PRIORITY_STYLE: Record<PmPriority, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/25',
  high: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  medium: 'bg-accent/10 text-accent border-accent/25',
  low: 'bg-bg-tertiary text-text-secondary border-border',
};

const SOURCE_LABEL: Record<PmPartSource, string> = {
  on_truck: 'On truck',
  warehouse: 'Warehouse',
  other_location: 'Other location (transfer needed)',
  short: 'Short: will be backordered',
};

const FILTERS: (PmSignalKind | 'all')[] = ['all', 'overdue', 'upcoming', 'contract', 'warranty', 'seasonal', 'high_risk'];
type Tab = 'queue' | 'scheduled' | 'settings';

function StatTile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 sm:rounded-2xl sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Notify dialog (preview -> edit -> send) ──────────────────────────────────

function NotifyDialog({ workItemId, customerName, onClose, onSent }: { workItemId: string; customerName: string; onClose: () => void; onSent: () => void }) {
  const { toast } = useToast();
  const [channel, setChannel] = useState<'auto' | 'sms' | 'email'>('auto');
  const [message, setMessage] = useState('');
  const [defaultMessage, setDefaultMessage] = useState('');
  const [to, setTo] = useState('');
  const [resolved, setResolved] = useState<'sms' | 'email' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [needsForce, setNeedsForce] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    notifyCustomer({ workItemId, channel, dryRun: true })
      .then((r) => {
        if (!alive) return;
        setMessage(r.message ?? '');
        setDefaultMessage(r.message ?? '');
        setTo(r.to ?? '');
        setResolved(r.channel ?? null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not prepare the message.'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workItemId, channel]);

  const send = async (force: boolean) => {
    setSending(true);
    setError(null);
    try {
      await notifyCustomer({ workItemId, channel, message: message === defaultMessage ? undefined : message, force });
      toast(`Notified ${customerName}.`, 'success');
      onSent();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not send the message.';
      setNeedsForce(msg.includes('notified a few minutes ago'));
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal title={`Notify ${customerName}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="pm-channel" className="mb-1 block text-xs font-medium text-text-secondary">Channel</label>
          <select id="pm-channel" className={FIELD} value={channel} onChange={(e) => setChannel(e.target.value as 'auto' | 'sms' | 'email')}>
            <option value="auto">Automatic (text first, then email)</option>
            <option value="sms">Text message</option>
            <option value="email">Email</option>
          </select>
        </div>
        {loading ? (
          <SkeletonCardList count={1} rows={3} />
        ) : (
          <div>
            <label htmlFor="pm-message" className="mb-1 block text-xs font-medium text-text-secondary">
              Message {resolved ? `(${resolved === 'sms' ? 'text' : 'email'} to ${to})` : ''}
            </label>
            <textarea id="pm-message" className={`${FIELD} min-h-[130px]`} value={message} maxLength={480} onChange={(e) => setMessage(e.target.value)} disabled={!resolved} />
            <p className="mt-1 text-xs text-text-secondary">The reschedule link is always included. Texts honor opt-outs and A2P approval.</p>
          </div>
        )}
        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-600">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
          {needsForce ? (
            <Button size="sm" disabled={sending} onClick={() => void send(true)}>Send again anyway</Button>
          ) : (
            <Button size="sm" disabled={sending || loading || !resolved || !message.trim()} onClick={() => void send(false)}>
              <Send size={15} aria-hidden="true" /> {sending ? 'Sending…' : 'Send'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Schedule dialog ──────────────────────────────────────────────────────────

function ScheduleDialog({ candidate, snapshot, onClose, onDone }: { candidate: PmCandidate; snapshot: PmSnapshot; onClose: () => void; onDone: (workItemId: string | null) => void }) {
  const { toast } = useToast();
  const [when, setWhen] = useState(`${candidate.recommendedDate}T09:00`);
  const [minutes, setMinutes] = useState(candidate.visitMinutes);
  const [techId, setTechId] = useState<string>('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const whenDate = useMemo(() => new Date(when), [when]);
  const whenValid = !Number.isNaN(whenDate.getTime()) && whenDate.getTime() > Date.now() - 3_600_000;

  const wanted = useMemo(
    () =>
      wantedParts({
        kits: snapshot.kits,
        parts: snapshot.parts,
        equipmentType: candidate.equipment.equipment_type,
        forecastPartNames: candidate.forecast?.recommended?.parts ?? [],
      }),
    [snapshot.kits, snapshot.parts, candidate],
  );

  const ranked = useMemo(
    () =>
      whenValid
        ? rankTechnicians({
            candidate,
            scheduledAtIso: whenDate.toISOString(),
            technicians: snapshot.technicians,
            jobsByTechnician: snapshot.jobsByTechnician,
            lastTechnicianId: snapshot.lastTechnicianByEquipment[candidate.equipmentId] ?? null,
            kitOnTruck: kitOnTruckByTechnician({ wanted, stock: snapshot.stock, locations: snapshot.locations }),
          })
        : [],
    [whenValid, whenDate, candidate, snapshot, wanted],
  );

  // Default to the best-ranked technician; keep the operator's choice while it is still available.
  const effectiveTech = techId === 'auto' ? '' : ranked.some((r) => r.technician.id === techId) ? techId : (ranked[0]?.technician.id ?? '');

  const lines: PmPartLine[] = useMemo(
    () => planParts({ wanted, parts: snapshot.parts, stock: snapshot.stock, locations: snapshot.locations, technicianId: effectiveTech || ranked[0]?.technician.id || null }),
    [wanted, snapshot, effectiveTech, ranked],
  );
  const sendable = lines.filter((l) => l.location_id && !excluded.has(l.part_id));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await scheduleVisit({
        equipmentId: candidate.equipmentId,
        scheduledAtIso: whenDate.toISOString(),
        technicianId: effectiveTech || null,
        durationMinutes: minutes,
        serviceType: candidate.serviceType,
        signals: [...new Set(candidate.signals.map((s) => s.kind))],
        priorityScore: candidate.score,
        dueBy: candidate.deadline,
        parts: sendable.map((l) => ({ part_id: l.part_id, location_id: l.location_id as string, quantity: l.quantity })),
        note: buildDispatchNote(candidate),
      });
      const a = describeAssignment(r.assignment?.status);
      toast(`Visit scheduled. ${a.text}${r.parts_status === 'backordered' || r.parts_status === 'partial' ? ' Some parts are backordered.' : ''}`, a.ok ? 'success' : 'info');
      onDone(r.work_item_id);
    } catch (e) {
      setError(describeScheduleError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Schedule: ${candidate.label}`} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm text-text-secondary">
          {candidate.customer?.name ?? 'Unknown customer'}{candidate.customer?.address ? ` · ${candidate.customer.address}` : ''}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Date and time" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} error={whenValid ? undefined : 'Pick a time that is not in the past.'} />
          <Input label="Visit length (minutes)" type="number" min={15} max={720} step={5} value={minutes} onChange={(e) => setMinutes(Math.round(Number(e.target.value)) || 60)} />
        </div>

        <section aria-labelledby="pm-tech">
          <h3 id="pm-tech" className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary"><Wrench size={15} aria-hidden="true" /> Technician</h3>
          {ranked.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-3 text-sm text-text-secondary">
              No technician has capacity at that time. You can still create the job and assign it later.
            </p>
          ) : (
            <div className="space-y-2">
              {ranked.slice(0, 4).map((r, i) => (
                <label key={r.technician.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${effectiveTech === r.technician.id ? 'border-accent/50 bg-accent/5' : 'border-border'}`}>
                  <input type="radio" name="pm-tech" className="mt-1" checked={effectiveTech === r.technician.id} onChange={() => setTechId(r.technician.id)} />
                  <span>
                    <span className="font-medium text-text-primary">{r.technician.member_name ?? r.technician.member_email}</span>
                    {i === 0 ? <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">Best match</span> : null}
                    <span className="mt-0.5 block text-xs text-text-secondary">{r.reasons.join(' · ')}</span>
                  </span>
                </label>
              ))}
              <label className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${techId === 'auto' ? 'border-accent/50 bg-accent/5' : 'border-border'}`}>
                <input type="radio" name="pm-tech" checked={techId === 'auto'} onChange={() => setTechId('auto')} />
                <span className="text-text-primary">Let dispatch choose automatically</span>
              </label>
            </div>
          )}
          <p className="mt-2 text-xs text-text-secondary">Capacity and credential rules are enforced when the job is assigned.</p>
        </section>

        <section aria-labelledby="pm-parts">
          <h3 id="pm-parts" className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary"><Package size={15} aria-hidden="true" /> Parts to reserve</h3>
          {lines.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-3 text-sm text-text-secondary">
              No matching service kit or recommended parts. Create a kit for this equipment type under Inventory to automate this.
            </p>
          ) : (
            <ul className="space-y-2">
              {lines.map((l) => (
                <li key={l.part_id} className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Reserve ${l.part_name}`}
                    disabled={!l.location_id}
                    checked={!!l.location_id && !excluded.has(l.part_id)}
                    onChange={(e) =>
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(l.part_id);
                        else next.add(l.part_id);
                        return next;
                      })
                    }
                  />
                  <span className="flex-1">
                    <span className="font-medium text-text-primary">{l.quantity} × {l.part_name}</span>
                    <span className={`mt-0.5 block text-xs ${l.source === 'short' ? 'text-amber-600' : 'text-text-secondary'}`}>
                      {l.location_id ? `${SOURCE_LABEL[l.source]}${l.location_name ? ` · ${l.location_name}` : ''}` : 'No inventory location set up'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-600">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy || !whenValid} onClick={() => void submit()}>
            <CalendarClock size={15} aria-hidden="true" /> {busy ? 'Scheduling…' : 'Create job and reserve parts'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Queue card ───────────────────────────────────────────────────────────────

function QueueCard({ c, busy, onSchedule, onSnooze, onDismiss, onHandoff }: { c: PmCandidate; busy: boolean; onSchedule: () => void; onSnooze: () => void; onDismiss: () => void; onHandoff: () => void }) {
  const kinds = [...new Set(c.signals.map((s) => s.kind))];
  const canHandoff = c.forecast?.status === 'open';
  return (
    <article className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text-primary">{c.label}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">
            {c.customer ? <Link to={`/dashboard/customers/${c.customer.id}`} className="hover:text-accent hover:underline">{c.customer.name}</Link> : 'Unknown customer'}
            {c.equipment.serial_number ? ` · S/N ${c.equipment.serial_number}` : ''}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${PRIORITY_STYLE[c.priority]}`}>
          {PRIORITY_LABEL[c.priority]} · {c.score}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {kinds.map((k) => (
          <span key={k} className="rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">{SIGNAL_LABEL[k]}</span>
        ))}
      </div>

      <ul className="mt-3 space-y-1 text-sm text-text-primary">
        {c.signals.map((s, i) => <li key={`${s.kind}-${i}`}>{s.detail}</li>)}
      </ul>
      {c.context.length || c.dataGaps.length ? (
        <ul className="mt-2 space-y-1 text-xs text-text-secondary">
          {[...c.context, ...c.dataGaps].map((t) => <li key={t}>{t}</li>)}
        </ul>
      ) : null}

      <p className="mt-3 text-xs text-text-secondary">
        Recommended visit: <span className="font-medium text-text-primary">{formatDay(c.recommendedDate)}</span>
        {c.deadline ? ` · hard deadline ${formatDay(c.deadline)}` : ''}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !c.customer} onClick={onSchedule}>
          <CalendarClock size={15} aria-hidden="true" /> Schedule visit
        </Button>
        {canHandoff ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onHandoff}>
            <Radar size={15} aria-hidden="true" /> Hand off to Home Health Agent
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onSnooze}>Snooze 30 days</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>Dismiss</Button>
      </div>
      {!c.customer ? <p className="mt-2 text-xs text-amber-600">Attach a customer to this unit to schedule a job.</p> : null}
    </article>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function PreventiveMaintenanceCommandCenterPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const allowed = isOwner || permissions.can_view_all_jobs;

  const [snapshot, setSnapshot] = useState<PmSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('queue');
  const [filter, setFilter] = useState<PmSignalKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<PmCandidate | null>(null);
  const [notifyFor, setNotifyFor] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState<PmSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await loadSnapshot();
      setSnapshot(s);
      setDraft(s.settings);
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : 'Could not load maintenance data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
    else setLoading(false);
  }, [allowed, load]);

  const candidates = useMemo(
    () =>
      snapshot
        ? buildCandidates({
            equipment: snapshot.equipment,
            customers: snapshot.customers,
            alerts: snapshot.alerts,
            forecasts: snapshot.forecasts,
            contracts: snapshot.contracts,
            workItems: snapshot.workItems,
            settings: snapshot.settings,
          })
        : [],
    [snapshot],
  );
  const summary = useMemo(() => summarize(candidates), [candidates]);
  const isScheduled = (c: PmCandidate) => c.workItem?.status === 'scheduled' || c.workItem?.status === 'notified';
  const queue = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter(
      (c) =>
        !isScheduled(c) &&
        (filter === 'all' || c.signals.some((s) => s.kind === filter)) &&
        (!q || c.label.toLowerCase().includes(q) || (c.customer?.name ?? '').toLowerCase().includes(q)),
    );
  }, [candidates, filter, query]);
  const scheduled = useMemo(() => candidates.filter(isScheduled), [candidates]);
  const techName = useMemo(() => new Map((snapshot?.technicians ?? []).map((t) => [t.id, t.member_name ?? t.member_email])), [snapshot]);

  const meta = (c: PmCandidate) => ({ signals: [...new Set(c.signals.map((s) => s.kind))], priorityScore: c.score, dueBy: c.deadline });

  const run = async (id: string, action: () => Promise<void>, ok: string) => {
    setBusyId(id);
    try {
      await action();
      toast(ok, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const saveSettings = async () => {
    if (!user || !draft) return;
    setSavingSettings(true);
    try {
      await savePmSettings(user.id, draft);
      toast('Settings saved.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not save settings.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Preventive Maintenance">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <CalendarClock size={22} className="text-accent" aria-hidden="true" /> Preventive Maintenance
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Every overdue, contract, warranty, seasonal and high-risk maintenance need in one queue, with the visit date,
            technician, parts and customer message already recommended.
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </Button>
      </header>

      {!allowed ? (
        <EmptyState icon={ShieldCheck} title="You do not have access to maintenance planning" description="Ask the account owner to grant you access to all jobs." />
      ) : loading && !snapshot ? (
        <div className="space-y-4">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={3} />
        </div>
      ) : loadError || !snapshot ? (
        <EmptyState icon={AlertTriangle} title="Maintenance data is unavailable" description="Make sure the preventive maintenance migration is applied, then try again." action={{ label: 'Try again', onClick: () => void load() }} />
      ) : (
        <div className="space-y-6">
          {snapshot.degraded.length ? (
            <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-600">
              Some sources could not be loaded ({snapshot.degraded.join(', ')}). Recommendations may be less complete.
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <StatTile label="Overdue" value={summary.byKind.overdue} />
            <StatTile label="Due soon" value={summary.byKind.upcoming} hint={`next ${snapshot.settings.due_soon_days} days`} />
            <StatTile label="Contract" value={summary.byKind.contract} />
            <StatTile label="Warranty" value={summary.byKind.warranty} />
            <StatTile label="Seasonal" value={summary.byKind.seasonal} />
            <StatTile label="High risk" value={summary.byKind.high_risk} />
          </div>

          <div role="tablist" aria-label="Maintenance views" className="flex gap-1 border-b border-border">
            {([['queue', `Queue (${summary.total})`], ['scheduled', `Scheduled (${summary.scheduled})`], ['settings', 'Settings']] as [Tab, string][]).map(([key, label]) => (
              <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)} className={`focus-ring -mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${tab === key ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
                {key === 'settings' ? <Settings2 size={14} className="mr-1.5 inline" aria-hidden="true" /> : null}{label}
              </button>
            ))}
          </div>

          {tab === 'queue' ? (
            <section aria-label="Maintenance queue" className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map((f) => (
                  <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${filter === f ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                    {f === 'all' ? 'All' : SIGNAL_LABEL[f]}{f !== 'all' ? ` (${summary.byKind[f]})` : ''}
                  </button>
                ))}
                <div className="ml-auto w-full sm:w-64">
                  <Input aria-label="Search equipment or customer" placeholder="Search equipment or customer" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              </div>
              {queue.length === 0 ? (
                <EmptyState icon={CheckCircle2} title={summary.total === 0 ? 'Everything is on schedule' : 'Nothing matches this filter'} description={summary.total === 0 ? 'New maintenance needs appear here automatically as equipment comes due.' : 'Try another filter or clear the search.'} />
              ) : (
                queue.map((c) => (
                  <QueueCard
                    key={c.equipmentId}
                    c={c}
                    busy={busyId === c.equipmentId}
                    onSchedule={() => setScheduleFor(c)}
                    onSnooze={() => void run(c.equipmentId, () => snoozeUnit(c.equipmentId, c.customer?.id ?? null, 30, meta(c)), 'Snoozed for 30 days.')}
                    onDismiss={() => void run(c.equipmentId, () => dismissUnit(c.equipmentId, c.customer?.id ?? null, meta(c)), 'Dismissed. It will resurface after 90 days if still needed.')}
                    onHandoff={() => c.forecast && void run(c.equipmentId, () => handoffPfnForecast(c.forecast!.id), 'Handed to the Home Health Agent. It will quote the customer under your governance rules.')}
                  />
                ))
              )}
            </section>
          ) : null}

          {tab === 'scheduled' ? (
            <section aria-label="Scheduled maintenance" className="space-y-3">
              {scheduled.length === 0 ? (
                <EmptyState icon={CalendarClock} title="No visits are scheduled from here" description="Schedule a visit from the queue and it will be tracked here until the job is completed." />
              ) : (
                scheduled.map((c) => {
                  const w = c.workItem!;
                  const a = describeAssignment(w.assignment_status);
                  return (
                    <article key={c.equipmentId} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-text-primary">{c.label}</h3>
                          <p className="text-sm text-text-secondary">{c.customer?.name ?? 'Unknown customer'}</p>
                        </div>
                        <p className="text-sm font-medium text-text-primary">{w.scheduled_at ? new Date(w.scheduled_at).toLocaleString() : '—'}</p>
                      </div>
                      <dl className="mt-3 grid gap-2 text-xs text-text-secondary sm:grid-cols-3">
                        <div><dt className="font-medium text-text-primary">Technician</dt><dd>{w.technician_id ? (techName.get(w.technician_id) ?? 'Assigned') : a.text}</dd></div>
                        <div><dt className="font-medium text-text-primary">Parts</dt><dd className={w.parts_status === 'backordered' || w.parts_status === 'partial' ? 'text-amber-600' : ''}>{{ none: 'None needed', reserved: 'Reserved', partial: 'Partly reserved, rest backordered', backordered: 'Backordered' }[w.parts_status]}</dd></div>
                        <div><dt className="font-medium text-text-primary">Customer</dt><dd>{w.notified_at ? `Notified by ${w.notified_channel === 'email' ? 'email' : 'text'} · ${new Date(w.notified_at).toLocaleDateString()}` : w.notify_error ?? 'Not notified yet'}</dd></div>
                      </dl>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button size="sm" variant={w.notified_at ? 'secondary' : 'primary'} disabled={!c.customer} onClick={() => setNotifyFor({ id: w.id, name: c.customer?.name ?? 'customer' })}>
                          <Send size={15} aria-hidden="true" /> {w.notified_at ? 'Notify again' : 'Notify customer'}
                        </Button>
                        <Link to="/dashboard/jobs" className="focus-ring inline-flex min-h-[40px] items-center rounded-xl border border-border px-4 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">Open Jobs</Link>
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          ) : null}

          {tab === 'settings' && draft ? (
            <section aria-label="Settings" className="max-w-xl space-y-4 rounded-2xl border border-border bg-bg-secondary p-5">
              {!isOwner ? <p className="text-xs text-text-secondary">Only the account owner can change these settings.</p> : null}
              <Input label="Due-soon window (days)" type="number" min={7} max={180} disabled={!isOwner} value={draft.due_soon_days} onChange={(e) => setDraft({ ...draft, due_soon_days: Number(e.target.value) })} />
              <Input label="High-risk threshold (0.05 to 0.95)" type="number" min={0.05} max={0.95} step={0.05} disabled={!isOwner} value={draft.risk_threshold} onChange={(e) => setDraft({ ...draft, risk_threshold: Number(e.target.value) })} helperText="Failure forecasts at or above this probability enter the queue." />
              <Input label="Default visit length (minutes)" type="number" min={15} max={480} disabled={!isOwner} value={draft.default_visit_minutes} onChange={(e) => setDraft({ ...draft, default_visit_minutes: Number(e.target.value) })} />
              <div>
                <label htmlFor="pm-hemi" className="mb-1 block text-xs font-medium text-text-secondary">Seasons follow the</label>
                <select id="pm-hemi" className={FIELD} disabled={!isOwner} value={draft.hemisphere} onChange={(e) => setDraft({ ...draft, hemisphere: e.target.value === 'south' ? 'south' : 'north' })}>
                  <option value="north">Northern hemisphere (heating tune-ups Sep–Nov, cooling Mar–May)</option>
                  <option value="south">Southern hemisphere (heating tune-ups Mar–May, cooling Sep–Nov)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" disabled={!isOwner} checked={draft.seasonal_enabled} onChange={(e) => setDraft({ ...draft, seasonal_enabled: e.target.checked })} /> Include seasonal tune-up reminders
              </label>
              <Button size="sm" disabled={!isOwner || savingSettings} onClick={() => void saveSettings()}>
                {savingSettings ? 'Saving…' : 'Save settings'}
              </Button>
            </section>
          ) : null}
        </div>
      )}

      {scheduleFor && snapshot ? (
        <ScheduleDialog
          candidate={scheduleFor}
          snapshot={snapshot}
          onClose={() => setScheduleFor(null)}
          onDone={(workItemId) => {
            const name = scheduleFor.customer?.name ?? 'customer';
            setScheduleFor(null);
            void load();
            if (workItemId) setNotifyFor({ id: workItemId, name });
          }}
        />
      ) : null}
      {notifyFor ? <NotifyDialog workItemId={notifyFor.id} customerName={notifyFor.name} onClose={() => setNotifyFor(null)} onSent={() => void load()} /> : null}
    </DashboardLayout>
  );
}
