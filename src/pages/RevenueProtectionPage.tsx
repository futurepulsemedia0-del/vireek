/**
 * Autonomous Revenue Protection — /dashboard/revenue-protection
 *
 * Detect -> Explain -> Recover -> Verify. Every card is a case the database
 * found before the money was lost, with the evidence behind the number.
 * A case is only marked Verified once the database sees the money move AND a
 * recovery action was logged — anything that resolves by itself is shown as
 * "resolved on its own", never claimed as a win. See
 * src/lib/revenueProtection.ts and the 20270106000000 migration.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  computeStats,
  DEFAULT_SETTINGS,
  dismissCase,
  fetchCases,
  fetchSettings,
  formatCents,
  hoursUntil,
  LEAK_COLORS,
  LEAK_LABELS,
  METHODS_BY_LEAK,
  relativeFromNow,
  runScan,
  saveSettings,
  SEVERITY_STYLES,
  startRecovery,
  STAGE_LABELS,
  VALUE_BASIS_LABELS,
} from '@/lib/revenueProtection';
import type {
  CaseBundle,
  EditableSettings,
  LeakType,
  ProtectionCase,
  ProtectionSettings,
  RecoveryActionMethod,
} from '@/lib/revenueProtection';

type ViewKey = 'active' | 'verified' | 'closed';

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'active', label: 'At risk now' },
  { key: 'verified', label: 'Verified' },
  { key: 'closed', label: 'Lost & closed' },
];

const EMPTY_BUNDLE: CaseBundle = { active: [], closed: [] };

// ============================================================
// PIPELINE STRIP
// ============================================================

function PipelineStep({
  index,
  title,
  value,
  caption,
  tone,
}: {
  index: number;
  title: string;
  value: string;
  caption: string;
  tone: 'neutral' | 'warn' | 'good';
}) {
  const toneClass =
    tone === 'good'
      ? 'border-success-500/25 bg-success-500/[0.05]'
      : tone === 'warn'
        ? 'border-warning-500/25 bg-warning-500/[0.05]'
        : 'border-border bg-bg-secondary';
  return (
    <div className={`relative rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">
        {index}. {title}
      </p>
      <p className="mt-1 text-xl font-bold text-text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{caption}</p>
    </div>
  );
}

// ============================================================
// CASE CARD
// ============================================================

function CaseCard({
  item,
  busy,
  onStart,
  onDismiss,
}: {
  item: ProtectionCase;
  busy: boolean;
  onStart: (method: RecoveryActionMethod, note: string) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const methods = METHODS_BY_LEAK[item.leak_type];
  const [method, setMethod] = useState<RecoveryActionMethod>(methods[0].value);
  const [note, setNote] = useState('');

  const styles = SEVERITY_STYLES[item.severity];
  const isActive = item.stage === 'explained' || item.stage === 'recovering';
  const dueHours = hoursUntil(item.due_at);
  const dueSoon = isActive && dueHours !== null && dueHours <= 72;
  const explanation = item.explanation ?? {};

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border p-4 ${isActive ? styles.card : 'border-border bg-bg-secondary'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-primary">{item.customer_name || 'Unknown'}</p>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${LEAK_COLORS[item.leak_type]}`}>
              {LEAK_LABELS[item.leak_type]}
            </span>
            {isActive && !item.is_capacity && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${styles.badge}`}>
                {item.severity}
              </span>
            )}
            {item.stage === 'recovering' && (
              <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent">Recovering</span>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">{explanation.summary}</p>
          <p className="mt-1 text-[11px] text-text-secondary/70">
            Detected {relativeFromNow(item.detected_at)}
            {item.customer_phone ? ` · ${item.customer_phone}` : ''}
            {` · ${item.confidence}% confidence`}
          </p>
        </div>

        <div className="text-right">
          <p className={`text-lg font-bold ${item.is_capacity ? 'text-text-secondary' : 'text-text-primary'}`}>
            {item.is_capacity ? '~' : ''}
            {formatCents(item.at_risk_cents)}
          </p>
          <p className="text-[10px] text-text-secondary/70">{VALUE_BASIS_LABELS[item.value_basis] ?? item.value_basis}</p>
        </div>
      </div>

      {dueSoon && dueHours !== null && (
        <p className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${dueHours <= 24 ? 'text-danger' : 'text-warning-500'}`}>
          <Clock size={12} />
          {dueHours <= 0 ? 'Deadline passed' : `Window closes in ${dueHours}h`}
        </p>
      )}

      {!isActive && (
        <p
          className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
            item.stage === 'verified' ? 'text-success-500' : 'text-text-secondary'
          }`}
        >
          {item.stage === 'verified' && <BadgeCheck size={13} />}
          {STAGE_LABELS[item.stage]}
          {item.stage === 'verified' && item.verification_kind === 'secured' && ` · ${formatCents(item.verified_amount_cents ?? 0)} secured`}
          {item.stage === 'verified' && item.verification_kind === 'protected' && ` · ${formatCents(item.verified_amount_cents ?? 0)} protected`}
          {item.stage === 'verified' && item.verification_kind === 'capacity_filled' && ' · capacity filled'}
          {item.verification?.reason ? ` — ${item.verification.reason}` : ''}
          {item.closed_at ? ` · ${relativeFromNow(item.closed_at)}` : ''}
        </p>
      )}

      {/* Explain */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring mt-3 flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary"
        aria-expanded={open}
      >
        <Search size={12} /> Why we flagged this
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-xl border border-border/60 bg-bg-primary p-3">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {(explanation.evidence ?? []).map((e) => (
                  <div key={e.label} className="flex items-baseline justify-between gap-3 text-xs">
                    <dt className="text-text-secondary">{e.label}</dt>
                    <dd className="text-right font-medium text-text-primary">{e.value}</dd>
                  </div>
                ))}
              </dl>
              {explanation.math && (
                <p className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-text-secondary/80">
                  {explanation.math}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recover */}
      {isActive && (
        <div className="mt-3 border-t border-border/60 pt-3">
          {!recovering ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {item.recommended_action?.href && (
                <Link
                  to={item.recommended_action.href}
                  className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110"
                >
                  {item.recommended_action.label ?? 'Open'} <ArrowRight size={12} />
                </Link>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => setRecovering(true)}
                className="focus-ring flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
              >
                <Wrench size={12} /> {item.stage === 'recovering' ? 'Log another action' : 'I took action'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDismiss()}
                className="focus-ring ml-auto flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-40"
              >
                <X size={12} /> Not a leak
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {methods.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMethod(m.value)}
                    className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      method === m.value ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={note}
                maxLength={280}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note"
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary/60"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRecovering(false)}
                  className="focus-ring rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    await onStart(method, note.trim());
                    setRecovering(false);
                    setNote('');
                  }}
                  className="focus-ring flex items-center gap-1.5 rounded-lg bg-success-500 px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Start recovery
                </button>
              </div>
              <p className="text-[11px] text-text-secondary/70">
                Vireek will keep watching this case and only mark it Verified when the numbers actually change.
              </p>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ============================================================
// SETTINGS PANEL
// ============================================================

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-text-primary">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
        className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
      />
      <span className="mt-0.5 block text-[11px] text-text-secondary/70">{hint}</span>
    </label>
  );
}

function SettingsPanel({
  settings,
  onSave,
  onClose,
}: {
  settings: ProtectionSettings;
  onSave: (values: EditableSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<EditableSettings>({
    quote_followup_hours: settings.quote_followup_hours,
    renewal_lookahead_days: settings.renewal_lookahead_days,
    min_parts_markup_pct: settings.min_parts_markup_pct,
    idle_min_open_slots: settings.idle_min_open_slots,
    idle_capacity_fill_pct: settings.idle_capacity_fill_pct,
    timezone: settings.timezone,
  });
  const [saving, setSaving] = useState(false);

  const zones = useMemo(() => {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    try {
      return fn ? fn('timeZone') : [];
    } catch {
      return [];
    }
  }, []);

  const set = <K extends keyof EditableSettings>(key: K, v: EditableSettings[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Detection thresholds</h2>
        <button type="button" onClick={onClose} aria-label="Close settings" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
          <X size={14} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <NumberField label="Quote follow-up window (hours)" hint="Flag a sent quote after this much silence." value={values.quote_followup_hours} min={1} max={720} onChange={(v) => set('quote_followup_hours', v)} />
        <NumberField label="Renewal look-ahead (days)" hint="Flag auto-renew-off plans this close to renewal." value={values.renewal_lookahead_days} min={1} max={120} onChange={(v) => set('renewal_lookahead_days', v)} />
        <NumberField label="Minimum parts markup (%)" hint="Price-book price must beat cost by this much." value={values.min_parts_markup_pct} min={0} max={500} onChange={(v) => set('min_parts_markup_pct', v)} />
        <NumberField label="Idle slots to flag" hint="Open dispatch slots per technician per day." value={values.idle_min_open_slots} min={1} max={20} onChange={(v) => set('idle_min_open_slots', v)} />
        <NumberField label="Capacity fill assumption (%)" hint="Share of open slots you realistically fill." value={values.idle_capacity_fill_pct} min={0} max={100} onChange={(v) => set('idle_capacity_fill_pct', v)} />
        <label className="block">
          <span className="text-xs font-medium text-text-primary">Business timezone</span>
          <input
            list="arp-timezones"
            value={values.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          />
          <datalist id="arp-timezones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <span className="mt-0.5 block text-[11px] text-text-secondary/70">Used to decide which day a job belongs to.</span>
        </label>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setValues({ ...DEFAULT_SETTINGS })} className="focus-ring rounded-lg px-3 py-2 text-xs text-text-secondary hover:text-text-primary">
          Reset to defaults
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await onSave(values);
            setSaving(false);
          }}
          className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {saving && <Loader2 size={12} className="animate-spin" />} Save &amp; rescan
        </button>
      </div>
    </motion.div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function RevenueProtectionPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [bundle, setBundle] = useState<CaseBundle>(EMPTY_BUNDLE);
  const [settings, setSettings] = useState<ProtectionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<ViewKey>('active');
  const [typeFilter, setTypeFilter] = useState<LeakType | 'all'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [cases, cfg] = await Promise.all([fetchCases(), fetchSettings()]);
      setBundle(cases);
      setSettings(cfg);
    } catch {
      toast('Could not load Revenue Protection', 'error');
    }
  }, [toast]);

  const scan = useCallback(
    async (silent: boolean, force = false) => {
      setScanning(true);
      try {
        const result = await runScan(force);
        await load();
        if (!silent) {
          if (result.throttled) toast('Already up to date', 'success');
          else toast(`Scan complete — ${result.new_cases ?? 0} new case${result.new_cases === 1 ? '' : 's'}`, 'success');
        }
      } catch {
        if (!silent) toast('Scan failed — please try again', 'error');
        await load();
      }
      setScanning(false);
    },
    [load, toast]
  );

  // First paint: scan (creates settings on first run, verifies open cases), then show.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await scan(true);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scan]);

  // Live: any change to a case (detector, verifier, teammate) refreshes the view, debounced.
  const liveStatus = useRealtimeSubscription({
    channelName: `revenue-protection-${user?.id ?? 'anon'}`,
    table: 'revenue_protection_cases',
    event: '*',
    enabled: Boolean(user),
    onChange: () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void load(), 600);
    },
  });

  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    []
  );

  const stats = useMemo(() => computeStats(bundle), [bundle]);

  const rows = useMemo(() => {
    let list: ProtectionCase[];
    if (view === 'active') list = [...bundle.active].sort((a, b) => Number(a.is_capacity) - Number(b.is_capacity) || b.at_risk_cents - a.at_risk_cents);
    else if (view === 'verified') list = bundle.closed.filter((c) => c.stage === 'verified');
    else list = bundle.closed.filter((c) => c.stage !== 'verified');
    if (typeFilter !== 'all') list = list.filter((c) => c.leak_type === typeFilter);
    return list;
  }, [bundle, view, typeFilter]);

  const handleStart = async (item: ProtectionCase, method: RecoveryActionMethod, note: string) => {
    setBusyId(item.id);
    const ok = await startRecovery(item.id, method, note || undefined);
    if (ok) {
      toast('Recovery started — Vireek is watching this case', 'success');
      await load();
    } else {
      toast('Could not start recovery — this case may have just changed', 'error');
      await load();
    }
    setBusyId(null);
  };

  const handleDismiss = async (item: ProtectionCase) => {
    setBusyId(item.id);
    const ok = await dismissCase(item.id);
    toast(ok ? 'Dismissed' : 'Could not dismiss this case', ok ? 'success' : 'error');
    await load();
    setBusyId(null);
  };

  const handleSaveSettings = async (values: EditableSettings) => {
    if (!settings) return;
    const ok = await saveSettings(settings.user_id, values);
    if (!ok) {
      toast('Could not save — check the timezone name', 'error');
      return;
    }
    toast('Saved', 'success');
    setShowSettings(false);
    await scan(false, true);
  };

  const typeChips = useMemo(() => {
    const counts = new Map<LeakType, number>();
    const source = view === 'active' ? bundle.active : bundle.closed.filter((c) => (view === 'verified' ? c.stage === 'verified' : c.stage !== 'verified'));
    for (const c of source) counts.set(c.leak_type, (counts.get(c.leak_type) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [bundle, view]);

  return (
    <DashboardLayout activeLabel="Revenue Protection">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck size={22} className="text-accent" />
              <h1 className="text-2xl font-bold text-text-primary">Revenue Protection</h1>
              <span
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  liveStatus === 'live' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${liveStatus === 'live' ? 'bg-success-500' : 'bg-text-secondary/50'}`} />
                {liveStatus === 'live' ? 'Live' : liveStatus === 'connecting' ? 'Connecting' : 'Reconnecting'}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Finds revenue that is about to be lost — before it is lost — explains exactly why, tracks the recovery, and
              only counts a win once the money actually moves.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              disabled={!settings}
              className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              <Settings2 size={13} /> Thresholds
            </button>
            <button
              type="button"
              onClick={() => void scan(false)}
              disabled={scanning}
              className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} /> Scan now
            </button>
          </div>
        </div>

        {showSettings && settings && (
          <SettingsPanel settings={settings} onSave={handleSaveSettings} onClose={() => setShowSettings(false)} />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-text-secondary">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : (
          <>
            {/* Headline */}
            <div
              className={`mb-4 rounded-2xl border p-5 ${
                stats.criticalCount > 0 ? 'border-danger/30 bg-danger/[0.04]' : 'border-border bg-bg-secondary'
              }`}
            >
              <p className="text-xs font-medium uppercase tracking-wider text-text-secondary/80">Revenue at risk right now</p>
              <p className={`mt-1 text-4xl font-bold ${stats.atRiskCents > 0 ? 'text-text-primary' : 'text-success-500'}`}>
                {formatCents(stats.atRiskCents)}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {stats.atRiskCount === 0
                  ? 'Nothing detected across quotes, warranty, memberships, billing, parts pricing and cancellations.'
                  : `${stats.atRiskCount} case${stats.atRiskCount === 1 ? '' : 's'}${stats.criticalCount > 0 ? `, ${stats.criticalCount} critical` : ''}`}
                {stats.capacityCount > 0 && ` · plus ~${formatCents(stats.capacityCents)} idle-capacity opportunity (estimate, not counted above)`}
              </p>
              {stats.byType.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {stats.byType.map((b) => (
                    <span key={b.type} className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${LEAK_COLORS[b.type]}`}>
                      {LEAK_LABELS[b.type]} · {b.count} · {b.type === 'technician_idle_time' ? '~' : ''}
                      {formatCents(b.cents)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Pipeline */}
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <PipelineStep index={1} title="Detect" value={String(stats.atRiskCount + stats.capacityCount)} caption="open cases, refreshed every 10 min" tone={stats.criticalCount > 0 ? 'warn' : 'neutral'} />
              <PipelineStep index={2} title="Explain" value="100%" caption="every case shows its evidence and math" tone="neutral" />
              <PipelineStep index={3} title="Recover" value={String(stats.recoveringCount)} caption={stats.recoveringCount > 0 ? `${formatCents(stats.recoveringCents)} in progress` : 'none in progress'} tone={stats.recoveringCount > 0 ? 'warn' : 'neutral'} />
              <PipelineStep
                index={4}
                title="Verify"
                value={formatCents(stats.securedCents)}
                caption={`secured${stats.protectedCents > 0 ? ` · ${formatCents(stats.protectedCents)} protected` : ''}${stats.verifyRatePercent !== null ? ` · ${stats.verifyRatePercent}% verify rate` : ''}`}
                tone={stats.securedCents > 0 ? 'good' : 'neutral'}
              />
            </div>

            {/* Views */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1.5">
                {VIEWS.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => {
                      setView(v.key);
                      setTypeFilter('all');
                    }}
                    className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      view === v.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              {settings?.last_scan_at && (
                <p className="ml-auto text-[11px] text-text-secondary/70">Last scan {relativeFromNow(settings.last_scan_at)}</p>
              )}
            </div>

            {typeChips.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setTypeFilter('all')}
                  className={`focus-ring rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                    typeFilter === 'all' ? 'border-accent text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  All types
                </button>
                {typeChips.map(([type, count]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setTypeFilter(type)}
                    className={`focus-ring rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                      typeFilter === type ? 'border-accent text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {LEAK_LABELS[type]} · {count}
                  </button>
                ))}
              </div>
            )}

            {view === 'closed' && stats.selfResolvedCount > 0 && (
              <p className="mb-3 flex items-center gap-1.5 text-[11px] text-text-secondary/80">
                <Sparkles size={11} /> {stats.selfResolvedCount} case{stats.selfResolvedCount === 1 ? '' : 's'} resolved on their own are
                listed here but never counted as recovered revenue.
              </p>
            )}

            {/* Cases */}
            {rows.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-14 text-center">
                <AlertTriangle size={18} className="mx-auto text-text-secondary/60" />
                <p className="mt-2 text-sm font-medium text-text-primary">
                  {view === 'active' ? 'No revenue at risk right now' : 'Nothing here yet'}
                </p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-text-secondary">
                  {view === 'active'
                    ? 'Vireek rescans your quotes, jobs, warranty claims, memberships, parts pricing and schedule every 10 minutes.'
                    : 'Cases appear here after Vireek verifies the money moved, or the window closes.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3 pb-10">
                {rows.map((item) => (
                  <CaseCard
                    key={item.id}
                    item={item}
                    busy={busyId === item.id}
                    onStart={(method, note) => handleStart(item, method, note)}
                    onDismiss={() => handleDismiss(item)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
