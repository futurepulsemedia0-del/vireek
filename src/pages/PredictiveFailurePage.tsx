/**
 * Predictive Failure Network — /dashboard/predictive-failure
 *
 * Closed-loop failure intelligence: forecast -> governed customer outreach (Home Health Agent)
 * -> quote -> parts staged -> technician -> real outcome -> calibration.
 * Probabilities are computed and stored server-side; this page only displays them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, ChevronDown, Radar, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateInline } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import {
  BAND_LABEL,
  PARTS_LABEL,
  PFN_DEFAULT_SETTINGS,
  PFN_MIN_CALIBRATION_N,
  STAGE_LABEL,
  dismissPfnForecast,
  dollars,
  fetchPfnForecasts,
  fetchPfnSettings,
  fetchPfnStats,
  handoffPfnForecast,
  humanizeMode,
  pct,
  reliabilityRows,
  runOutreachNow,
  runPfnScan,
  savePfnSettings,
  skillLabel,
  sweepPfnForecasts,
  type PfnBand,
  type PfnForecast,
  type PfnSettings,
  type PfnStats,
} from '@/lib/predictiveFailure';

const FIELD =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const BAND_STYLES: Record<PfnBand, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/25',
  high: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  elevated: 'bg-accent/10 text-accent border-accent/25',
  low: 'bg-bg-tertiary text-text-secondary border-border',
};

const BAR_STYLES: Record<PfnBand, string> = {
  critical: 'bg-red-500',
  high: 'bg-amber-500',
  elevated: 'bg-accent',
  low: 'bg-text-secondary/50',
};

type Tab = 'forecasts' | 'learning' | 'settings';

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function LoopFunnel({ loop }: { loop: PfnStats['loop'] }) {
  const steps: { label: string; value: number }[] = [
    { label: 'Predicted', value: loop.issued },
    { label: 'Handed off', value: loop.handed_off },
    { label: 'Customer quoted', value: loop.contacted },
    { label: 'Scheduled', value: loop.scheduled },
    { label: 'Dispatched', value: loop.dispatched },
    { label: 'Completed', value: loop.completed },
    { label: 'Outcome scored', value: loop.scored },
  ];
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="pfn-loop-title">
      <h2 id="pfn-loop-title" className="text-sm font-semibold text-text-primary">
        Closed loop: prediction to learning
      </h2>
      <ol className="mt-3 grid gap-2 sm:grid-cols-7">
        {steps.map((s, i) => (
          <li key={s.label} className="rounded-xl border border-border bg-bg-primary p-3">
            <p className="text-[11px] text-text-secondary">
              {i + 1}. {s.label}
            </p>
            <p className="mt-1 text-lg font-bold text-text-primary">{s.value}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(s.value / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-text-secondary">
        Customer messages are sent by the Home Health Agent, so every one still passes Agent Governance, SMS
        compliance and your price book.
      </p>
    </section>
  );
}

function ForecastCard({
  f,
  canBilling,
  isOwner,
  busy,
  highlighted,
  onHandoff,
  onDismiss,
}: {
  f: PfnForecast;
  canBilling: boolean;
  isOwner: boolean;
  busy: boolean;
  highlighted: boolean;
  onHandoff: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(highlighted);
  const lowCi = f.ci_low ?? f.probability;
  const highCi = f.ci_high ?? f.probability;
  const inLoop = f.status === 'handed_off';
  return (
    <article
      className={`rounded-2xl border bg-bg-secondary p-4 ${highlighted ? 'border-accent' : 'border-border'}`}
      aria-label={`${f.equipment_label} failure forecast`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{f.equipment_label}</h3>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BAND_STYLES[f.band]}`}>
              {BAND_LABEL[f.band]}
            </span>
            {f.calibrated ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary">
                Calibrated
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            {f.top_mode_label ?? 'Failure risk'} · next {f.horizon_days} days · {f.confidence} confidence
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-text-primary">{pct(f.probability)}</p>
          <p className="text-[11px] text-text-secondary">
            likely range {pct(lowCi)}–{pct(highCi)}
          </p>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
        <div className={`h-full rounded-full ${BAR_STYLES[f.band]}`} style={{ width: `${Math.round(f.probability * 100)}%` }} />
      </div>

      {f.recommended ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-text-primary">
          <Wrench size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <span>
            <span className="font-medium">Recommended:</span> {f.recommended.label}
            {canBilling && f.exposure_cents > 0 ? (
              <span className="text-text-secondary"> · {dollars(f.exposure_cents)} expected exposure</span>
            ) : null}
          </span>
        </p>
      ) : null}

      {inLoop ? (
        <div className="mt-3 rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
          <p>
            <span className="font-medium text-text-primary">Loop status:</span>{' '}
            {STAGE_LABEL[f.loop_stage ?? 'explained'] ?? f.loop_stage}
            {f.loop_blocked_reason ? ` — ${f.loop_blocked_reason}` : ''}
          </p>
          <p className="mt-1">
            <span className="font-medium text-text-primary">Parts:</span> {PARTS_LABEL[f.parts_status]}
          </p>
        </div>
      ) : f.loop_blocked_reason ? (
        <p className="mt-3 text-xs text-amber-600">{f.loop_blocked_reason}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {f.status === 'open' && f.recommended && f.customer_id ? (
          <Button size="sm" disabled={busy || !isOwner} onClick={() => onHandoff(f.id)}>
            Start proactive outreach
          </Button>
        ) : null}
        {f.status === 'open' ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(f.id)}>
            Dismiss
          </Button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focus-ring ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          Why this forecast
          <ChevronDown size={14} className={open ? 'rotate-180' : ''} aria-hidden="true" />
        </button>
      </div>
      {!isOwner && f.status === 'open' ? (
        <p className="mt-2 text-[11px] text-text-secondary">Only the account owner can start customer outreach.</p>
      ) : null}

      {open ? (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Failure types</h4>
            <ul className="mt-2 space-y-2">
              {f.modes.slice(0, 5).map((m) => (
                <li key={m.mode} className="text-xs text-text-secondary">
                  <div className="flex items-center justify-between gap-2 text-text-primary">
                    <span className="font-medium">
                      {m.label}
                      {m.safetyCritical ? ' · safety-critical' : ''}
                    </span>
                    <span>{pct(m.probability)}</span>
                  </div>
                  <p>
                    {m.ageSource === 'component_replaced' ? 'Part age' : 'Unit age'} {(m.ageMonths / 12).toFixed(1)} yrs ·
                    typical life basis:{' '}
                    {m.etaSource === 'expert_prior'
                      ? 'engineering prior'
                      : m.etaSource === 'network'
                        ? 'network data'
                        : 'prior blended with network data'}
                    {m.network ? ` · ${m.network.failureRatePct.toFixed(1)}% of similar units failed this way` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">What drives the risk</h4>
            <ul className="mt-2 space-y-1.5">
              {f.factors.map((x) => (
                <li key={`${x.key}-${x.label}`} className="text-xs text-text-secondary">
                  <span className="font-medium text-text-primary">{x.label}</span>
                  {x.ratio !== 1 ? ` (${x.ratio >= 1 ? '×' : '÷'}${(x.ratio >= 1 ? x.ratio : 1 / x.ratio).toFixed(2)})` : ''} —{' '}
                  {x.detail}
                </li>
              ))}
            </ul>
          </div>
          {f.data_gaps.length > 0 ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Add data to sharpen this
              </h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-text-secondary">
                {f.data_gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-[11px] text-text-secondary">
            Failure types are combined assuming they are independent. The range reflects how much evidence backs the
            number; it is not a statistical confidence interval.
          </p>
        </div>
      ) : null}
    </article>
  );
}

function LearningTab({ stats }: { stats: PfnStats }) {
  const acc = stats.accuracy;
  const rows = reliabilityRows(stats.bins);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Outcomes scored" value={String(acc.scored)} hint={`${acc.failures} failed in window`} />
        <StatTile label="Brier score" value={acc.brier === null ? '—' : acc.brier.toFixed(3)} hint="Lower is better" />
        <StatTile label="Skill vs baseline" value={acc.skill === null ? '—' : acc.skill.toFixed(2)} hint={skillLabel(acc.skill)} />
        <StatTile
          label="Calibration"
          value={acc.calibrated ? 'Active' : 'Learning'}
          hint={acc.calibrated ? 'Probabilities corrected by your outcomes' : `Needs ${PFN_MIN_CALIBRATION_N} scored outcomes`}
        />
      </div>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="pfn-rel-title">
        <h2 id="pfn-rel-title" className="text-sm font-semibold text-text-primary">
          Reliability: what we predicted vs what happened
        </h2>
        {acc.scored === 0 ? (
          <EmptyStateInline text="Forecasts are scored automatically when their window ends. Results appear here." className="mt-3" />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text-secondary">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">Predicted range</th>
                  <th className="py-1.5 pr-4 font-medium">Forecasts</th>
                  <th className="py-1.5 pr-4 font-medium">Actually failed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.range} className="border-t border-border text-text-primary">
                    <td className="py-1.5 pr-4">{r.range}</td>
                    <td className="py-1.5 pr-4">{r.n}</td>
                    <td className="py-1.5 pr-4">{r.observed === null ? '—' : pct(r.observed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-text-secondary">
          Units we serviced because of a forecast ({acc.intervened}) are excluded: preventing a failure means we can
          never know whether it would have happened, and counting them would make the model look worse for helping.
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="pfn-modes-title">
        <h2 id="pfn-modes-title" className="text-sm font-semibold text-text-primary">
          Learned per failure type (expected vs observed)
        </h2>
        {stats.modes.length === 0 ? (
          <EmptyStateInline text="Per-failure-type learning starts after the first forecasts are scored." className="mt-3" />
        ) : (
          <ul className="mt-3 space-y-1.5 text-xs text-text-secondary">
            {stats.modes.map((m) => (
              <li key={m.mode} className="flex justify-between gap-3">
                <span className="text-text-primary">{humanizeMode(m.mode)}</span>
                <span>
                  expected {m.expected.toFixed(1)} · observed {m.observed} · n={m.n}
                  {m.n < 8 ? ' (too few to adjust)' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SettingsTab({
  settings,
  isOwner,
  saving,
  onSave,
}: {
  settings: PfnSettings;
  isOwner: boolean;
  saving: boolean;
  onSave: (s: PfnSettings) => void;
}) {
  const [draft, setDraft] = useState<PfnSettings>(settings);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const toggle = (key: 'enabled' | 'auto_handoff' | 'auto_stage_parts', label: string, help: string) => (
    <label className="flex items-start justify-between gap-4 rounded-xl border border-border bg-bg-primary p-3">
      <span>
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        <span className="block text-xs text-text-secondary">{help}</span>
      </span>
      <input
        type="checkbox"
        className="focus-ring mt-1 h-4 w-4"
        checked={draft[key]}
        disabled={!isOwner}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
      />
    </label>
  );

  return (
    <section className="max-w-2xl space-y-3" aria-labelledby="pfn-settings-title">
      <h2 id="pfn-settings-title" className="sr-only">
        Settings
      </h2>
      {toggle('enabled', 'Predictive monitoring', 'Score every active unit on a schedule and alert you to rising risk.')}
      {toggle(
        'auto_handoff',
        'Start proactive outreach automatically',
        'Forecasts above your alert level go straight to the Home Health Agent. Messages still need your approval if Agent Governance requires it.',
      )}
      {toggle('auto_stage_parts', 'Stage parts on scheduled visits', 'Adds the recommended parts to the job so availability and backorders surface early.')}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-text-secondary">
          Forecast horizon
          <select
            className={`${FIELD} mt-1 w-full`}
            value={draft.horizon_days}
            disabled={!isOwner}
            onChange={(e) => setDraft({ ...draft, horizon_days: Number(e.target.value) })}
          >
            {[30, 60, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-text-secondary">
          Alert when failure probability reaches
          <select
            className={`${FIELD} mt-1 w-full`}
            value={String(draft.alert_threshold)}
            disabled={!isOwner}
            onChange={(e) => setDraft({ ...draft, alert_threshold: Number(e.target.value) })}
          >
            {[0.2, 0.25, 0.35, 0.5, 0.6].map((t) => (
              <option key={t} value={String(t)}>
                {Math.round(t * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>
      {isOwner ? (
        <Button size="sm" disabled={!dirty || saving} onClick={() => onSave(draft)}>
          Save settings
        </Button>
      ) : (
        <p className="text-xs text-text-secondary">Only the account owner can change these settings.</p>
      )}
    </section>
  );
}

export function PredictiveFailurePage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const focusEquipment = params.get('equipment');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [forecasts, setForecasts] = useState<PfnForecast[]>([]);
  const [stats, setStats] = useState<PfnStats | null>(null);
  const [settings, setSettings] = useState<PfnSettings>(PFN_DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>('forecasts');
  const [showLow, setShowLow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      await sweepPfnForecasts().catch(() => 0);
      const [f, s, st] = await Promise.all([fetchPfnForecasts(), fetchPfnStats(), fetchPfnSettings()]);
      setForecasts(f);
      setStats(s);
      setSettings(st);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const list = showLow ? forecasts : forecasts.filter((f) => f.band !== 'low' || f.status === 'handed_off');
    return focusEquipment ? list.filter((f) => f.equipment_id === focusEquipment) : list;
  }, [forecasts, showLow, focusEquipment]);

  const run = async (fn: () => Promise<void>, errorMessage: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : errorMessage, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleScan = () =>
    run(async () => {
      const r = await runPfnScan(focusEquipment ? [focusEquipment] : undefined);
      toast(
        `Scanned ${r.scanned} units — ${r.forecasts_issued} new forecast${r.forecasts_issued === 1 ? '' : 's'}${r.handed_off ? `, ${r.handed_off} handed to outreach` : ''}.`,
        'success',
      );
      await load();
    }, 'Could not run the scan. Please try again.');

  const handleHandoff = (id: string) =>
    run(async () => {
      await handoffPfnForecast(id);
      toast('Handed to the Home Health Agent. It will quote the customer under your governance rules.', 'success');
      await load();
    }, 'Could not start outreach for this forecast.');

  const handleDismiss = (id: string) =>
    run(async () => {
      await dismissPfnForecast(id);
      await load();
    }, 'Could not dismiss this forecast.');

  const handleOutreach = () =>
    run(async () => {
      await runOutreachNow();
      toast('Outreach run started.', 'success');
      await load();
    }, 'Could not start outreach.');

  const handleSave = async (next: PfnSettings) => {
    if (!user) return;
    setSaving(true);
    try {
      await savePfnSettings(user.id, next);
      setSettings(next);
      toast('Settings saved.', 'success');
    } catch {
      toast('Could not save settings. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Predictive Failure">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Radar size={22} className="text-accent" aria-hidden="true" /> Predictive Failure Network
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Forecasts which equipment will fail next, hands the risk to your proactive-service loop, stages the parts,
            and learns from every real outcome.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy || !isOwner} onClick={handleOutreach}>
            <Activity size={15} aria-hidden="true" /> Run outreach now
          </Button>
          <Button size="sm" disabled={busy} onClick={handleScan}>
            <RefreshCw size={15} className={busy ? 'animate-spin' : ''} aria-hidden="true" /> Scan equipment
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="space-y-4">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} rows={3} />
        </div>
      ) : loadError ? (
        <EmptyState
          icon={ShieldCheck}
          title="Predictive failure data is unavailable"
          description="Make sure the predictive failure migration is applied, then try again."
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-4">
            <StatTile label="Monitored units" value={String(stats?.monitored_units ?? 0)} />
            <StatTile
              label="Critical + high risk"
              value={String((stats?.open.critical ?? 0) + (stats?.open.high ?? 0))}
              hint={`${stats?.open.elevated ?? 0} more elevated`}
            />
            <StatTile
              label="Expected exposure"
              value={permissions.can_view_billing ? dollars(stats?.open.exposure_cents ?? 0) : '—'}
              hint="Probability × typical repair cost"
            />
            <StatTile
              label="Model skill"
              value={stats?.accuracy.skill === null || stats?.accuracy.skill === undefined ? '—' : stats.accuracy.skill.toFixed(2)}
              hint={skillLabel(stats?.accuracy.skill ?? null)}
            />
          </div>

          {stats ? <LoopFunnel loop={stats.loop} /> : null}

          <div role="tablist" aria-label="Predictive failure sections" className="flex gap-1 border-b border-border">
            {(['forecasts', 'learning', 'settings'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${
                  tab === t ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'forecasts' ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
                <span>
                  {visible.length} forecast{visible.length === 1 ? '' : 's'}
                  {focusEquipment ? ' for this unit' : ''}
                </span>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" className="focus-ring h-4 w-4" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} />
                  Include low-risk units
                </label>
              </div>
              {visible.length === 0 ? (
                <EmptyState
                  icon={Radar}
                  title="No elevated-risk equipment right now"
                  description="Run a scan to score your equipment. Units with an install date and service history are forecast first."
                  action={{ label: 'Scan equipment', onClick: () => void handleScan() }}
                />
              ) : (
                visible.map((f) => (
                  <ForecastCard
                    key={f.id}
                    f={f}
                    canBilling={permissions.can_view_billing}
                    isOwner={isOwner}
                    busy={busy}
                    highlighted={f.equipment_id === focusEquipment}
                    onHandoff={(id) => void handleHandoff(id)}
                    onDismiss={(id) => void handleDismiss(id)}
                  />
                ))
              )}
            </div>
          ) : null}

          {tab === 'learning' && stats ? <LearningTab stats={stats} /> : null}
          {tab === 'settings' ? <SettingsTab settings={settings} isOwner={isOwner} saving={saving} onSave={(s) => void handleSave(s)} /> : null}
        </div>
      )}
    </DashboardLayout>
  );
}
