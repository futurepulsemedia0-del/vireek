/**
 * Truck-Roll Elimination — /dashboard/truck-roll
 *
 * Before any technician leaves, Vireek asks: should this truck roll happen at
 * all? Seven gates, one verdict (dispatch / try remote first / DO NOT DISPATCH /
 * emergency), a reason for every answer and a one-click fix for every gap.
 * See src/lib/truckRoll.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  MinusCircle,
  Phone,
  RefreshCw,
  Settings2,
  XCircle,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DEFAULT_SETTINGS as DEFAULT_ASSURANCE_SETTINGS, fetchAssuranceSettings } from '@/lib/outcomeAssurance';
import {
  DEFAULT_TRUCK_ROLL_SETTINGS,
  GATE_STATUS_LABELS,
  VERDICT_COLORS,
  VERDICT_LABELS,
  buildMediaRequestMessage,
  evaluateTruckRolls,
  fetchTruckRollSettings,
  gatherTruckRollContext,
  persistTruckRollAssessments,
  recordTruckRollAction,
  saveTruckRollSettings,
  smsHref,
  summarizeTruckRolls,
  type ActionKind,
  type Gate,
  type GateStatus,
  type TruckRollContext,
  type TruckRollRow,
  type TruckRollSettings,
} from '@/lib/truckRoll';

type Filter = 'all' | 'action' | 'cleared';

const REFRESH_MS = 90_000;

const ACTION_LABELS: Record<ActionKind, string> = {
  request_media: 'Photo/video requested',
  media_received: 'Photo/video received',
  access_confirmed: 'Access confirmed',
  remote_resolved: 'Resolved remotely',
  remote_failed: 'Remote attempt failed',
  override_dispatch: 'Hold overridden',
};

const GATE_STYLE: Record<GateStatus, { icon: typeof CheckCircle2; className: string }> = {
  pass: { icon: CheckCircle2, className: 'text-success-500' },
  warn: { icon: AlertTriangle, className: 'text-warning-500' },
  fail: { icon: XCircle, className: 'text-danger' },
  unknown: { icon: HelpCircle, className: 'text-text-secondary' },
  na: { icon: MinusCircle, className: 'text-text-secondary' },
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'Not scheduled';
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function StatCard({ label, value, hint, valueClass = 'text-text-primary' }: { label: string; value: string | number; hint?: string; valueClass?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${valueClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

// ============================================================
// GATE ROW
// ============================================================

function GateRow({ gate }: { gate: Gate }) {
  const { icon: Icon, className } = GATE_STYLE[gate.status];
  return (
    <li className="flex items-start gap-2.5 rounded-xl bg-bg-primary px-3 py-2">
      <Icon size={15} className={`mt-0.5 shrink-0 ${className}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <p className="text-xs font-medium text-text-primary">{gate.question}</p>
          <p className="flex items-center gap-1.5 text-xs">
            <span className={`font-semibold ${className}`}>{gate.answer}</span>
            <span className="sr-only">{GATE_STATUS_LABELS[gate.status]}</span>
            {gate.basis === 'estimated' && gate.status !== 'na' && <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">estimated</span>}
          </p>
        </div>
        <p className="mt-0.5 text-[11px] text-text-secondary">{gate.detail}</p>
        {gate.issues.length > 0 && (
          <ul className="mt-0.5 list-disc pl-4 text-[11px] text-warning-500">
            {gate.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

// ============================================================
// ACTIONS
// ============================================================

function RemotePanel({ row, onDone }: { row: TruckRollRow; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const pattern = row.remotePattern;
  if (!pattern) return null;

  const record = async (kind: 'remote_resolved' | 'remote_failed') => {
    setBusy(kind);
    try {
      await recordTruckRollAction(row.job.id, kind, pattern.label);
      toast(kind === 'remote_resolved' ? 'Truck roll eliminated. Nice work.' : 'Noted. The visit is now justified.');
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
      <p className="mb-1 text-xs font-semibold text-text-primary">Guided remote fix: {pattern.label}</p>
      <p className="mb-2 text-[11px] text-text-secondary">Read these to the customer. Safe steps only: no panels opened, no tools, no gas.</p>
      <ol className="mb-3 list-decimal space-y-1 pl-4 text-xs text-text-primary">
        {pattern.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {row.customerPhone && (
          <a
            href={`tel:${row.customerPhone.replace(/[^\d+]/g, '')}`}
            className="focus-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-2 text-xs font-semibold text-text-primary hover:bg-bg-primary"
          >
            <Phone size={12} /> Call customer
          </a>
        )}
        <Button size="sm" onClick={() => void record('remote_resolved')} disabled={busy !== null}>
          It worked: resolved remotely
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void record('remote_failed')} disabled={busy !== null}>
          Did not resolve
        </Button>
      </div>
    </div>
  );
}

function OverridePanel({ row, isOwner, onDone }: { row: TruckRollRow; isOwner: boolean; onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (row.verdict !== 'hold') return null;
  if (!isOwner) return <p className="text-[11px] text-text-secondary">Only the account owner can override a hold.</p>;

  const submit = async () => {
    setBusy(true);
    try {
      await recordTruckRollAction(row.job.id, 'override_dispatch', reason.trim());
      toast('Hold overridden. The reason is recorded.');
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="focus-ring rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
        Dispatch anyway…
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <label className="block text-xs text-text-secondary">
        Why is this roll justified despite the hold? (recorded permanently)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-sm text-text-primary"
        />
      </label>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy || reason.trim().length < 10}>
          Confirm override
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {reason.trim().length > 0 && reason.trim().length < 10 && <p className="mt-1 text-[11px] text-danger">Please write at least 10 characters.</p>}
    </div>
  );
}

function ActionBar({ row, isOwner, onDone }: { row: TruckRollRow; isOwner: boolean; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const record = async (kind: ActionKind, okMessage: string, note?: string) => {
    setBusy(true);
    try {
      await recordTruckRollAction(row.job.id, kind, note);
      toast(okMessage);
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
      setBusy(false);
    }
  };

  const media = row.gates.find((g) => g.key === 'media');
  const access = row.gates.find((g) => g.key === 'access');
  const showRequest = row.actions.some((a) => a.kind === 'request_media') && !!row.customerPhone;
  const showReceived = !!media && media.status !== 'pass' && media.status !== 'na' && (media.answer === 'Requested' || media.answer === 'No reply');
  const showAccess = !!access && access.status !== 'pass' && access.status !== 'na' && access.status !== 'fail';
  const links = row.actions.filter((a) => a.href);

  const message = buildMediaRequestMessage(row.job.customer_name, row.job.service_type);

  return (
    <div className="space-y-3">
      {row.verdict === 'remote_first' && <RemotePanel row={row} onDone={onDone} />}
      <div className="flex flex-wrap items-center gap-2">
        {showRequest && row.customerPhone && (
          <a
            href={smsHref(row.customerPhone, message)}
            onClick={() => void recordTruckRollAction(row.job.id, 'request_media', 'sms').then(onDone).catch((e) => toast(errMessage(e), 'error'))}
            className="focus-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
          >
            <Phone size={12} /> Request photo/video by text
          </a>
        )}
        {showReceived && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void record('media_received', 'Marked as received')}>
            Customer sent photo/video
          </Button>
        )}
        {showAccess && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void record('access_confirmed', 'Access confirmed')}>
            Mark access confirmed
          </Button>
        )}
        {links.map((a) => (
          <Link
            key={a.kind}
            to={a.href as string}
            className="focus-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            {a.label} <ArrowRight size={12} />
          </Link>
        ))}
        <span className="ml-auto">
          <OverridePanel row={row} isOwner={isOwner} onDone={onDone} />
        </span>
      </div>
    </div>
  );
}

// ============================================================
// JOB CARD
// ============================================================

function JobCard({ row, open, onToggle, isOwner, onChanged }: { row: TruckRollRow; open: boolean; onToggle: () => void; isOwner: boolean; onChanged: () => void }) {
  const { job } = row;
  const isHold = row.verdict === 'hold';
  return (
    <div className={`overflow-hidden rounded-2xl border bg-bg-secondary ${isHold ? 'border-danger/40' : 'border-border'}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="focus-ring flex w-full items-start justify-between gap-3 p-4 text-left">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text-primary">{job.customer_name}</span>
          <span className="block truncate text-xs text-text-secondary">
            {job.service_type ?? 'Service'} · {formatWhen(job.scheduled_datetime)}
            {row.hoursToJob !== null && row.hoursToJob >= 0 && row.hoursToJob < 24 ? ` · in ${Math.max(1, Math.round(row.hoursToJob))}h` : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${VERDICT_COLORS[row.verdict]}`}>
            {isHold && <Ban size={12} aria-hidden />}
            {VERDICT_LABELS[row.verdict]}
          </span>
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      <div className="grid grid-cols-7 gap-1 px-4 pb-3" aria-label="Gate results">
        {row.gates.map((g) => {
          const { icon: Icon, className } = GATE_STYLE[g.status];
          return (
            <span key={g.key} title={`${g.label}: ${g.answer}`} className="flex flex-col items-center gap-0.5 rounded-lg bg-bg-primary py-1.5">
              <Icon size={14} className={className} aria-hidden />
              <span className="max-w-full truncate px-0.5 text-[9px] text-text-secondary">{g.label.split(' ')[0]}</span>
              <span className="sr-only">{GATE_STATUS_LABELS[g.status]}</span>
            </span>
          );
        })}
      </div>

      <div className="px-4 pb-4">
        {row.reasons.length > 0 && (
          <ul className={`space-y-0.5 text-xs ${isHold ? 'text-danger' : 'text-text-secondary'}`}>
            {row.reasons.slice(0, open ? 8 : 2).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {row.avoidableCost > 0 && (
          <p className="mt-1.5 text-[11px] text-text-secondary">
            Estimated avoidable cost: <span className="font-semibold text-text-primary">{formatMoney(row.avoidableCost)}</span>
          </p>
        )}
      </div>

      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {row.conditions.length > 0 && (
            <div className="rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">
              <p className="mb-1 font-semibold">Before the technician leaves</p>
              <ul className="list-disc pl-4">
                {row.conditions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <ActionBar row={row} isOwner={isOwner} onDone={onChanged} />
          <div>
            <p className="mb-2 text-xs font-semibold text-text-primary">
              The seven checks{row.readiness !== null && <span className="font-normal text-text-secondary"> · readiness {Math.round(row.readiness)}%</span>}
            </p>
            <ul className="space-y-1.5">
              {row.gates.map((g) => (
                <GateRow key={g.key} gate={g} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SETTINGS
// ============================================================

function SettingsPanel({ settings, isOwner, onSaved }: { settings: TruckRollSettings; isOwner: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  const valid =
    draft.truck_roll_cost >= 0 && draft.truck_roll_cost <= 5000 && draft.remote_threshold >= 30 && draft.remote_threshold <= 95 &&
    draft.min_resolution >= 50 && draft.min_resolution <= 99 && draft.min_readiness >= 40 && draft.min_readiness <= 99;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const field = 'focus-ring w-24 rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60';

  const save = async () => {
    setSaving(true);
    try {
      await saveTruckRollSettings(draft);
      toast('Truck-roll policy saved');
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setSaving(false);
  };

  const num = (key: keyof TruckRollSettings, label: string, min: number, max: number) => (
    <label className="text-xs text-text-secondary">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={draft[key] as number}
        disabled={!isOwner}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        className={`${field} mt-1 block`}
      />
    </label>
  );

  return (
    <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
        <Settings2 size={15} /> Truck-roll policy
      </p>
      <div className="flex flex-wrap items-end gap-4">
        {num('truck_roll_cost', 'Cost of one truck roll ($)', 0, 5000)}
        {num('min_resolution', 'Min first-visit probability (%)', 50, 99)}
        {num('min_readiness', 'Min readiness (%)', 40, 99)}
        {num('remote_threshold', 'Try remote at or above (%)', 30, 95)}
        <label className="flex items-center gap-2 pb-1.5 text-xs text-text-secondary">
          <input type="checkbox" checked={draft.notify_on_hold} disabled={!isOwner} onChange={(e) => setDraft({ ...draft, notify_on_hold: e.target.checked })} />
          Alert me when a job within 24h is held
        </label>
        {isOwner && (
          <Button size="sm" onClick={() => void save()} disabled={!dirty || !valid || saving}>
            Save
          </Button>
        )}
      </div>
      {!valid && <p className="mt-2 text-xs text-danger">Check the ranges: cost 0-5000, probability 50-99, readiness 40-99, remote 30-95.</p>}
      {!isOwner && <p className="mt-2 text-xs text-text-secondary">Only the account owner can change the policy.</p>}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function TruckRollEliminationPage() {
  const { isOwner } = useAuth();
  const [ctx, setCtx] = useState<TruckRollContext | null>(null);
  const [settings, setSettings] = useState<TruckRollSettings>(DEFAULT_TRUCK_ROLL_SETTINGS);
  const [rows, setRows] = useState<TruckRollRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [context, assuranceSettings, cfg] = await Promise.all([
        gatherTruckRollContext(),
        fetchAssuranceSettings().catch(() => DEFAULT_ASSURANCE_SETTINGS),
        fetchTruckRollSettings(),
      ]);
      const evaluated = evaluateTruckRolls(context, assuranceSettings, cfg);
      if (!mounted.current) return;
      setCtx(context);
      setSettings(cfg);
      setRows(evaluated);
      setFailed(false);
      setLoading(false);
      // History + automatic alerts. Never blocks or breaks the page.
      try {
        await persistTruckRollAssessments(evaluated);
      } catch {
        /* migration not applied yet: verdicts still show, just not stored */
      }
    } catch {
      if (mounted.current) {
        setFailed(true);
        setLoading(false);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const summary = useMemo(() => summarizeTruckRolls(rows, ctx?.actions ?? [], settings, ctx?.assurance.now ?? Date.now()), [rows, ctx, settings]);
  const recent = useMemo(() => (ctx?.actions ?? []).slice(0, 8), [ctx]);
  const names = useMemo(() => new Map((ctx?.assurance.jobs ?? []).map((j) => [j.id, j.customer_name])), [ctx]);

  const visible = useMemo(() => {
    if (filter === 'action') return rows.filter((r) => r.verdict === 'hold' || r.verdict === 'remote_first');
    if (filter === 'cleared') return rows.filter((r) => r.verdict === 'dispatch' || r.verdict === 'emergency' || r.verdict === 'eliminated');
    return rows;
  }, [rows, filter]);

  const needsAction = summary.hold + summary.remoteFirst;
  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: rows.length },
    { key: 'action', label: 'Needs action', count: needsAction },
    { key: 'cleared', label: 'Cleared', count: rows.length - needsAction },
  ];

  return (
    <DashboardLayout activeLabel="Truck-Roll Elimination">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Ban size={18} /> Truck-Roll Elimination
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Before a technician leaves, Vireek asks the one question that matters: should this truck roll happen at all? It checks seven things and either clears the job, tries a remote fix first, or says do not dispatch.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
              <Settings2 size={14} /> Policy
            </Button>
            <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {showSettings && <SettingsPanel settings={settings} isOwner={isOwner} onSaved={refresh} />}

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed ? (
          <EmptyState
            icon={Ban}
            title="Truck-Roll Elimination unavailable"
            description="Jobs or team data could not be loaded. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Ban}
            title="No scheduled jobs to review"
            description="Scheduled jobs appear here with a clear dispatch decision as soon as they are booked."
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Do not dispatch" value={summary.hold} valueClass="text-danger" />
              <StatCard label="Try remote first" value={summary.remoteFirst} valueClass="text-accent" />
              <StatCard label="Cleared" value={summary.dispatch + summary.emergency} valueClass="text-success-500" />
              <StatCard label="Potential savings" value={formatMoney(summary.potentialSavings)} hint={`at ${formatMoney(settings.truck_roll_cost)} per roll (estimate)`} />
            </div>
            {summary.realizedRolls > 0 && (
              <p className="mb-4 rounded-xl bg-success-500/10 px-3 py-2 text-xs text-success-500">
                Measured, last 90 days: {summary.realizedRolls} truck roll{summary.realizedRolls === 1 ? '' : 's'} eliminated by remote resolution, about {formatMoney(summary.realizedSavings)} saved.
              </p>
            )}

            <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter jobs">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {f.label} ({f.count})
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {visible.map((r) => (
                <JobCard
                  key={r.job.id}
                  row={r}
                  open={openId === r.job.id}
                  onToggle={() => setOpenId(openId === r.job.id ? null : r.job.id)}
                  isOwner={isOwner}
                  onChanged={refresh}
                />
              ))}
              {visible.length === 0 && <p className="py-6 text-center text-sm text-text-secondary">Nothing in this view.</p>}
            </div>

            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-1 text-sm font-semibold text-text-primary">How Vireek decides</p>
              <p className="text-xs text-text-secondary">
                Emergencies and urgent-SLA jobs are never held. Planned work (installs, tune-ups, cleaning) is a visit by definition. A missing answer counts as unknown, never as a pass. Remote-fix odds start as estimates and are replaced by your own recorded results as they accumulate.
              </p>
            </div>

            {recent.length > 0 && (
              <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="mb-2 text-sm font-semibold text-text-primary">Recent decisions</p>
                <ul className="space-y-1.5">
                  {recent.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg-primary px-3 py-2 text-xs">
                      <span className="min-w-0 text-text-primary">
                        {ACTION_LABELS[a.kind]} <span className="text-text-secondary">· {names.get(a.job_id) ?? 'Job'}</span>
                      </span>
                      <span className="shrink-0 text-text-secondary">{new Date(a.created_at).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
