import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarRange, Check, Loader2, RefreshCw, Settings2, Sparkles, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  ACTION_LABEL,
  ACTION_LINK,
  CONFIDENCE_TONE,
  GUARDRAIL_LABEL,
  GUARDRAIL_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  applyActions,
  fmtMoneyCents,
  fmtPct,
  fmtWeek,
  monthlyRollup,
  type CurvePoint,
  type StabilizerReport,
  type StabilizerSettings,
} from '@/lib/seasonalStabilizer';
import {
  computeReport,
  createDeferralOffers,
  decideAction,
  deferralMessage,
  fetchActions,
  fetchDeferralOffers,
  fetchRuns,
  launchAction,
  measureAction,
  respondDeferralOffer,
  saveForecast,
  updateSettings,
  type ActionRow,
  type DeferralOffer,
  type RunSummary,
} from '@/lib/seasonalStabilizerApi';

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}>{children}</span>;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

/** Grouped bars per month: without actions (muted) vs with actions (accent). */
function MonthChart({ rows, format }: { rows: { label: string; a: number; b: number }[]; format: (v: number) => string }) {
  const W = 720;
  const H = 220;
  const padL = 8;
  const padB = 26;
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const slot = (W - padL) / Math.max(1, rows.length);
  const bw = Math.max(6, slot / 2 - 5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Twelve month curve without and with actions">
      {rows.map((r, i) => {
        const x = padL + i * slot + 3;
        const ha = ((H - padB - 16) * r.a) / max;
        const hb = ((H - padB - 16) * r.b) / max;
        return (
          <g key={r.label + i}>
            <rect x={x} y={H - padB - ha} width={bw} height={ha} rx={3} className="fill-text-secondary opacity-40">
              <title>{`${r.label} without actions: ${format(r.a)}`}</title>
            </rect>
            <rect x={x + bw + 2} y={H - padB - hb} width={bw} height={hb} rx={3} className="fill-accent">
              <title>{`${r.label} with actions: ${format(r.b)}`}</title>
            </rect>
            <text x={x + bw} y={H - 8} textAnchor="middle" className="fill-text-secondary text-[10px]">{r.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-3 text-xs text-text-secondary">
      <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-text-secondary opacity-40" /> Without actions</span>
      <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-accent" /> With actions</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type SettingsForm = Record<string, string>;

function toForm(s: StabilizerSettings): SettingsForm {
  return {
    valley_threshold_pct: String(s.valley_threshold_pct),
    peak_threshold_pct: String(s.peak_threshold_pct),
    incentive_pct: String(s.incentive_pct),
    max_valley_discount_pct: String(s.max_valley_discount_pct),
    shift_share_pct: String(s.shift_share_pct),
    valley_sunk_labor_pct: String(s.valley_sunk_labor_pct),
    overtime_multiplier: String(s.overtime_multiplier),
    temp_help_cost_multiplier: String(s.temp_help_cost_multiplier),
    subcontractor_margin_share_pct: String(s.subcontractor_margin_share_pct),
    tech_hourly: s.tech_hourly_cost_cents === null ? '' : String(s.tech_hourly_cost_cents / 100),
    paid_hours_per_tech_week: String(s.paid_hours_per_tech_week),
    reserve_buffer_weeks: String(s.reserve_buffer_weeks),
    deferrable: s.deferrable_service_lines.join(', '),
  };
}

function SettingsCard({ settings, onSaved }: { settings: StabilizerSettings; onSaved: (s: StabilizerSettings) => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<SettingsForm>(() => toForm(settings));
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const n = (k: string): number => Number(form[k]);
      const saved = await updateSettings({
        valley_threshold_pct: Math.round(n('valley_threshold_pct')),
        peak_threshold_pct: Math.round(n('peak_threshold_pct')),
        incentive_pct: n('incentive_pct'),
        max_valley_discount_pct: n('max_valley_discount_pct'),
        shift_share_pct: Math.round(n('shift_share_pct')),
        valley_sunk_labor_pct: Math.round(n('valley_sunk_labor_pct')),
        overtime_multiplier: n('overtime_multiplier'),
        temp_help_cost_multiplier: n('temp_help_cost_multiplier'),
        subcontractor_margin_share_pct: Math.round(n('subcontractor_margin_share_pct')),
        tech_hourly_cost_cents: form.tech_hourly.trim() === '' ? null : Math.round(Number(form.tech_hourly) * 100),
        paid_hours_per_tech_week: n('paid_hours_per_tech_week'),
        reserve_buffer_weeks: Math.round(n('reserve_buffer_weeks')),
        deferrable_service_lines: form.deferrable.split(',').map((x) => x.trim()).filter(Boolean),
      });
      onSaved(saved);
      toast('Settings saved. Refresh the forecast to apply them.', 'success');
    } catch {
      toast('Could not save. Check that every value is in range (peak must be above valley).', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6 p-6">
      <h2 className="text-sm font-semibold text-text-primary">Stabilizer assumptions</h2>
      <p className="mt-1 text-xs text-text-secondary">
        Discounts are always capped by the margin floor in Margin Guardrails. Only owners and admins can see or change this.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Input label="Valley below (% of average)" type="number" min={50} max={98} value={form.valley_threshold_pct} onChange={set('valley_threshold_pct')} />
        <Input label="Peak above (% of average)" type="number" min={102} max={200} value={form.peak_threshold_pct} onChange={set('peak_threshold_pct')} />
        <Input label="Early-booking / opt-in incentive (%)" type="number" min={0} max={20} step={0.5} value={form.incentive_pct} onChange={set('incentive_pct')} />
        <Input label="Max valley discount (%)" type="number" min={0} max={25} step={0.5} value={form.max_valley_discount_pct} onChange={set('max_valley_discount_pct')} />
        <Input label="Peak demand to shift (%)" type="number" min={5} max={60} value={form.shift_share_pct} onChange={set('shift_share_pct')} />
        <Input label="Idle-labor share of job cost in valleys (%)" type="number" min={0} max={90} value={form.valley_sunk_labor_pct} onChange={set('valley_sunk_labor_pct')} />
        <Input label="Technician cost per hour, $ (optional)" type="number" min={0} step={0.5} value={form.tech_hourly} onChange={set('tech_hourly')} />
        <Input label="Paid hours per technician-week" type="number" min={20} max={80} step={0.5} value={form.paid_hours_per_tech_week} onChange={set('paid_hours_per_tech_week')} />
        <Input label="Overtime multiplier" type="number" min={1} max={3} step={0.1} value={form.overtime_multiplier} onChange={set('overtime_multiplier')} />
        <Input label="Temporary help cost multiplier" type="number" min={1} max={3} step={0.1} value={form.temp_help_cost_multiplier} onChange={set('temp_help_cost_multiplier')} />
        <Input label="Margin kept on subcontracted jobs (%)" type="number" min={0} max={60} value={form.subcontractor_margin_share_pct} onChange={set('subcontractor_margin_share_pct')} />
        <Input label="Cash buffer (weeks of fixed costs)" type="number" min={0} max={26} value={form.reserve_buffer_weeks} onChange={set('reserve_buffer_weeks')} />
        <Input label="Deferrable service lines (comma separated)" value={form.deferrable} onChange={set('deferrable')} helperText="Lowercase names as they appear on jobs, e.g. maintenance, duct cleaning" />
      </div>
      <div className="mt-4">
        <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save assumptions'}</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Action card
// ---------------------------------------------------------------------------

function ActionCard({
  a,
  busy,
  today,
  onDecide,
  onLaunch,
  onMeasure,
  onChanged,
}: {
  a: ActionRow;
  busy: boolean;
  today: string;
  onDecide: (id: string, d: 'approve' | 'reject' | 'cancel', reason?: string) => void;
  onLaunch: (id: string) => void;
  onMeasure: (id: string) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [offers, setOffers] = useState<DeferralOffer[] | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const link = ACTION_LINK[a.action_type];
  const blocked = a.guardrail_status === 'blocked';
  const lastEnd = a.measure_windows.reduce((m, w) => (w.end > m ? w.end : m), a.window_end);
  const canMeasure = (a.status === 'approved' || a.status === 'launched' || a.status === 'measured') && lastEnd < today;
  const isDefer = a.action_type === 'defer_to_valley' && (a.status === 'approved' || a.status === 'launched');

  const loadOffers = useCallback(async () => {
    try {
      setOffers(await fetchDeferralOffers(a.id));
    } catch {
      toast('Could not load the offers.', 'error');
    }
  }, [a.id, toast]);

  useEffect(() => {
    if (isDefer) void loadOffers();
  }, [isDefer, loadOffers]);

  const createOffers = async () => {
    setOfferBusy(true);
    try {
      const n = await createDeferralOffers(a.id);
      toast(n > 0 ? `${n} opt-in offer${n === 1 ? '' : 's'} created.` : 'No eligible scheduled jobs were found.', n > 0 ? 'success' : 'info');
      await loadOffers();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create offers.', 'error');
    } finally {
      setOfferBusy(false);
    }
  };

  const respond = async (o: DeferralOffer, accept: boolean) => {
    setOfferBusy(true);
    try {
      const r = await respondDeferralOffer(o.id, accept);
      if (!r.ok) toast(r.error ?? 'The job could not be moved.', 'error');
      else toast(accept ? 'Job moved to the valley week.' : 'Offer declined.', 'success');
      await loadOffers();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record the answer.', 'error');
    } finally {
      setOfferBusy(false);
    }
  };

  const res = a.result;
  return (
    <li className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill className="bg-accent/10 text-accent">{ACTION_LABEL[a.action_type]}</Pill>
        <Pill className={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Pill>
        {a.guardrail_status !== 'not_applicable' && <Pill className={GUARDRAIL_TONE[a.guardrail_status]}>{GUARDRAIL_LABEL[a.guardrail_status]}</Pill>}
        <h3 className="text-sm font-semibold text-text-primary">{a.title}</h3>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{a.rationale}</p>

      <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><p className="text-text-secondary">Est. revenue impact</p><p className="font-semibold text-text-primary">{fmtMoneyCents(a.est_revenue_cents)}</p></div>
        <div><p className="text-text-secondary">Est. margin impact</p><p className="font-semibold text-text-primary">{fmtMoneyCents(a.est_margin_cents)}</p></div>
        <div><p className="text-text-secondary">Demand shifted</p><p className="font-semibold text-text-primary">{a.shifted_revenue_cents ? fmtMoneyCents(a.shifted_revenue_cents) : '—'}</p></div>
        <div><p className="text-text-secondary">Window</p><p className="font-semibold text-text-primary">{fmtWeek(a.window_start)} – {fmtWeek(a.window_end)}</p></div>
      </div>
      {a.margin_pct_after !== null && (
        <p className="mt-2 text-xs text-text-secondary">
          Margin after incentive: {fmtPct(a.margin_pct_after, 1)} (floor {fmtPct(a.margin_floor_pct, 1)})
        </p>
      )}
      {a.override_reason && <p className="mt-1 text-xs text-text-secondary">Override reason: {a.override_reason}</p>}

      {a.status === 'proposed' && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {blocked && (
            <div className="min-w-[240px] flex-1">
              <Input label="Below the margin floor: owner override reason (min 10 characters)" value={reason} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value)} />
            </div>
          )}
          <Button size="sm" disabled={busy || (blocked && reason.trim().length < 10)} onClick={() => onDecide(a.id, 'approve', reason)}>
            <Check size={14} /> {blocked ? 'Approve with override' : 'Approve'}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(a.id, 'reject')}>
            <X size={14} /> Reject
          </Button>
        </div>
      )}

      {(a.status === 'approved' || a.status === 'launched') && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link to={link.href} className="text-xs font-semibold text-accent hover:underline">{link.label}</Link>
          {a.status === 'approved' && <Button size="sm" disabled={busy} onClick={() => onLaunch(a.id)}>Mark as launched</Button>}
          {canMeasure && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onMeasure(a.id)}>Measure results</Button>}
          {!canMeasure && <span className="text-xs text-text-secondary">Results can be measured after {fmtWeek(lastEnd)}.</span>}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(a.id, 'cancel')}>Cancel</Button>
        </div>
      )}
      {a.status === 'measured' && (
        <div className="mt-3">
          {canMeasure && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onMeasure(a.id)}>Re-measure</Button>}
        </div>
      )}

      {a.action_type === 'peak_surge_staffing' && Array.isArray(a.details.options) && (
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
          {(a.details.options as { key: string; label: string; hours: number; margin_per_hour_cents: number }[]).map((o) => (
            <li key={o.key}>{o.label}: {Math.round(o.hours)} h · {fmtMoneyCents(o.margin_per_hour_cents)} margin per hour</li>
          ))}
          <li>Alert date: {String(a.details.alert_date ?? '—')}</li>
        </ul>
      )}

      {isDefer && (
        <div className="mt-3 rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-text-primary">Customer opt-in offers</p>
            <Button size="sm" variant="secondary" disabled={offerBusy} onClick={createOffers}>
              {offerBusy ? <Loader2 size={14} className="animate-spin" /> : null} Find eligible jobs
            </Button>
          </div>
          {offers === null && <p className="mt-2 text-xs text-text-secondary">Loading offers…</p>}
          {offers !== null && offers.length === 0 && (
            <p className="mt-2 text-xs text-text-secondary">No offers yet. Mark the service line as deferrable in the settings, then find eligible jobs.</p>
          )}
          {offers !== null && offers.length > 0 && (
            <ul className="mt-2 space-y-2">
              {offers.map((o) => (
                <li key={o.id} className="rounded-lg bg-bg-tertiary p-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-text-primary">{o.customer_name ?? 'Customer'}</span>
                    <span className="text-text-secondary">{new Date(o.original_datetime).toLocaleDateString()} → {new Date(o.proposed_datetime).toLocaleDateString()}</span>
                    <Pill className={o.status === 'accepted' ? 'bg-success-500/10 text-success-500' : o.status === 'failed' ? 'bg-danger/10 text-danger' : 'bg-bg-secondary text-text-secondary'}>{o.status}</Pill>
                  </div>
                  {o.status === 'failed' && o.failure_reason && <p className="mt-1 text-danger">{o.failure_reason}</p>}
                  {o.status === 'offered' && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(deferralMessage(o)); toast('Message copied. Send it from your usual channel.', 'success'); }}>Copy message</Button>
                      <Button size="sm" disabled={offerBusy} onClick={() => respond(o, true)}>Customer accepted</Button>
                      <Button size="sm" variant="secondary" disabled={offerBusy} onClick={() => respond(o, false)}>Customer declined</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {res && (
        <div className="mt-3 rounded-xl border border-success-500/30 bg-success-500/5 p-3 text-xs">
          <p className="font-semibold text-text-primary">Measured {res.measured_on}</p>
          <p className="mt-1 text-text-secondary">
            Revenue vs baseline forecast: {fmtMoneyCents(res.realized_revenue_delta_cents)} (predicted {fmtMoneyCents(res.predicted_revenue_delta_cents)}
            {res.accuracy_ratio !== null ? `, ${Math.round(res.accuracy_ratio * 100)}% of prediction` : ''}) · margin ≈ {fmtMoneyCents(res.realized_margin_delta_cents)}
          </p>
          {a.action_type === 'membership_push' && <p className="mt-1 text-text-secondary">New memberships in the window: {res.new_memberships}{res.membership_target ? ` of ${res.membership_target} targeted` : ''}</p>}
          {a.action_type === 'defer_to_valley' && <p className="mt-1 text-text-secondary">Offers accepted: {res.deferral_offers_accepted} of {res.deferral_offers_total}</p>}
          <p className="mt-1 text-text-secondary">{res.method}</p>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SeasonalRevenueStabilizerPage() {
  const { toast } = useToast();
  const [report, setReport] = useState<StabilizerReport | null>(null);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [settings, setSettings] = useState<StabilizerSettings | null>(null);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeProposed, setIncludeProposed] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const acts = await fetchActions();
      const [{ report: r, history, settings: s }, rs] = await Promise.all([computeReport(acts), fetchRuns()]);
      setActions(acts);
      setReport(r);
      setSettings(s);
      setToday(history.today);
      setRuns(rs);
    } catch {
      setError('Only the account owner or an admin can view the Seasonal Revenue Stabilizer, or it failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshActions = useCallback(async () => {
    try {
      setActions(await fetchActions());
    } catch {
      toast('Could not refresh the action list.', 'error');
    }
  }, [toast]);

  const save = useCallback(async () => {
    if (!report) return;
    setSaving(true);
    try {
      const r = await saveForecast(report);
      toast(`Saved. ${r.inserted} new proposal${r.inserted === 1 ? '' : 's'}, ${r.refreshed} refreshed, ${r.withdrawn} withdrawn.`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the forecast.', 'error');
    } finally {
      setSaving(false);
    }
  }, [report, toast, load]);

  const run = useCallback(
    async (id: string, fn: () => Promise<void>, ok: string) => {
      setBusyId(id);
      try {
        await fn();
        toast(ok, 'success');
        await refreshActions();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'That did not work. Please try again.', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [toast, refreshActions],
  );

  const include = useMemo(() => new Set(includeProposed ? ['proposed', 'approved', 'launched'] : ['approved', 'launched']), [includeProposed]);
  const view = useMemo(() => (report && report.status === 'ok' ? applyActions(report, actions, include) : null), [report, actions, include]);
  const pending = report?.status === 'ok' ? report.actions.filter((a) => !actions.some((x) => x.fingerprint === a.fingerprint)).length : 0;
  const months = useMemo(() => (view ? monthlyRollup(view.curve) : []), [view]);
  const hasHours = report?.core.hours_available ?? false;
  const active = actions.filter((a) => a.status === 'proposed' || a.status === 'approved' || a.status === 'launched');
  const history = actions.filter((a) => a.status === 'measured' || a.status === 'rejected');
  const peakPoint = (c: CurvePoint[]): CurvePoint | undefined => c.reduce<CurvePoint | undefined>((m, p) => (!m || p.revenue_cents > m.revenue_cents ? p : m), undefined);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <CalendarRange size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Seasonal Revenue Stabilizer</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                Forecasts your peak and valley weeks per service line from your own job history, then proposes campaigns, offers, pricing and staffing moves to flatten revenue and cash flow. Every action is approved by you and measured afterwards.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSettings((v) => !v)} disabled={!settings}>
              <Settings2 size={14} /> Assumptions
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Recalculate
            </Button>
            <Button size="sm" onClick={save} disabled={saving || loading || !report || report.status !== 'ok'}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {saving ? 'Saving…' : 'Save forecast & proposals'}
            </Button>
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-6 flex items-start gap-2 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {showSettings && settings && <SettingsCard settings={settings} onSaved={(s) => setSettings(s)} />}

        {loading && !report && (
          <Card className="flex items-center gap-3 p-6 text-sm text-text-secondary" aria-busy="true">
            <Loader2 size={16} className="animate-spin" /> Building your seasonal forecast…
          </Card>
        )}

        {report && report.status !== 'ok' && (
          <Card className="p-8 text-center">
            <CalendarRange size={28} className="mx-auto text-accent" />
            <h2 className="mt-3 text-base font-semibold text-text-primary">Not enough history yet</h2>
            {report.notes.map((n) => <p key={n} className="mx-auto mt-2 max-w-md text-sm text-text-secondary">{n}</p>)}
            <Link to="/dashboard/jobs" className="mt-4 inline-block text-sm font-semibold text-accent hover:underline">Go to Jobs</Link>
          </Card>
        )}

        {report && report.status === 'ok' && view && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
              <Pill className={CONFIDENCE_TONE[report.confidence]}>{report.confidence} confidence</Pill>
              <span>Based on live data as of {today}</span>
              <label className="ml-auto flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={includeProposed} onChange={(e) => setIncludeProposed(e.target.checked)} />
                Include actions awaiting approval in the “with actions” view
              </label>
            </div>

            {pending > 0 && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-accent/30 bg-accent/5 p-4 text-sm text-text-primary">
                <span>{pending} new proposal{pending === 1 ? '' : 's'} ready. Save the forecast to send {pending === 1 ? 'it' : 'them'} to the approval list.</span>
                <Button size="sm" onClick={save} disabled={saving}>Save forecast & proposals</Button>
              </div>
            )}

            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Stability score" value={`${report.stability.score}`} sub={`With actions: ${view.score.score} (higher is steadier)`} />
              <Kpi label="Seasonal swing" value={fmtPct(report.headline.revenue_swing_pct)} sub={`${report.headline.peak_weeks} peak weeks · ${report.headline.valley_weeks} valley weeks`} />
              <Kpi label="Forecast revenue, next 12 months" value={fmtMoneyCents(report.headline.annual_revenue_cents)} sub={`Gross margin ≈ ${fmtPct(report.headline.gross_margin_pct)}`} />
              <Kpi label="Proposed actions" value={String(report.headline.actions)} sub={`≈ ${fmtMoneyCents(report.headline.est_margin_cents)} margin if all are approved`} />
            </div>

            <Card className="mb-6 p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">12-month revenue</h2>
                <Legend />
              </div>
              <MonthChart rows={months.map((m) => ({ label: m.label, a: m.baseline_revenue_cents, b: m.revenue_cents }))} format={fmtMoneyCents} />
              {peakPoint(view.curve) && <p className="mt-2 text-xs text-text-secondary">Busiest week: {fmtWeek(peakPoint(view.curve)!.w)}. Revenue without actions is capped at technician capacity.</p>}
            </Card>

            <Card className="mb-6 p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">12-month labor hours</h2>
                <Legend />
              </div>
              {hasHours ? (
                <>
                  <MonthChart rows={months.map((m) => ({ label: m.label, a: m.baseline_hours, b: m.hours }))} format={(v) => `${Math.round(v)} h`} />
                  <p className="mt-2 text-xs text-text-secondary">
                    Capacity {Math.round(report.capacity.cap_load)} billable hours per week ({report.capacity.source === 'team' ? 'from your technicians' : 'assumed'}). {report.stability.overload_weeks} week{report.stability.overload_weeks === 1 ? '' : 's'} over capacity today, {view.score.overload_weeks} with actions.
                  </p>
                </>
              ) : (
                <p className="text-sm text-text-secondary">Jobs have no duration recorded yet, so labor hours cannot be shown. Add job durations to unlock this chart and staffing alerts.</p>
              )}
            </Card>

            <Card className="mb-6 p-6">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Peaks and valleys</h2>
              {report.windows.length === 0 ? (
                <p className="text-sm text-text-secondary">No clear peaks or valleys at your thresholds. That is a stable year, or there is not enough history to measure seasonality yet.</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {report.windows.map((w) => (
                    <li key={w.start} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                      <span><Pill className={w.kind === 'peak' ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500'}>{w.kind}</Pill> <span className="ml-2 text-text-primary">{fmtWeek(w.start)} – {fmtWeek(w.end)}</span></span>
                      <span className="text-xs text-text-secondary">{Math.round(w.avg_ratio * 100)}% of average · {w.weeks} wk</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="text-text-secondary">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Service line</th>
                      <th className="pr-3 font-medium">Share</th>
                      <th className="pr-3 font-medium">Seasonality</th>
                      <th className="pr-3 font-medium">Peaks / valleys</th>
                      <th className="pr-3 font-medium">Margin</th>
                      <th className="pr-3 font-medium">Valley discount allowed</th>
                      <th className="font-medium">Needs volume lift ≥</th>
                    </tr>
                  </thead>
                  <tbody className="text-text-primary">
                    {report.lines.map((l) => (
                      <tr key={l.line} className="border-t border-border">
                        <td className="py-2 pr-3 font-semibold">{l.label}</td>
                        <td className="pr-3">{fmtPct(l.share_pct)}</td>
                        <td className="pr-3">{l.seasonality === 'measured' ? 'Measured' : 'Needs 12 months'}</td>
                        <td className="pr-3">{l.windows.filter((w) => w.kind === 'peak').length} / {l.windows.filter((w) => w.kind === 'valley').length}</td>
                        <td className="pr-3">{fmtPct(l.guardrail.margin_pct, 1)}{l.guardrail.margin_source === 'default' ? ' (default)' : ''}</td>
                        <td className="pr-3">{fmtPct(l.guardrail.allowed_valley_discount_pct, 1)} (floor {fmtPct(l.guardrail.margin_floor_pct)})</td>
                        <td>{l.guardrail.break_even_elasticity === null ? 'Never pays back' : `${l.guardrail.break_even_elasticity}% per 1% off`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="mb-6 p-6">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Actions</h2>
              {active.length === 0 && (
                <p className="text-sm text-text-secondary">
                  {report.actions.length > 0 ? 'Save the forecast to create approval-ready proposals.' : 'No actions are needed right now: no peak or valley is large enough to act on, or every opportunity is already covered.'}
                </p>
              )}
              <ul className="space-y-3">
                {active.map((a) => (
                  <ActionCard
                    key={a.id}
                    a={a}
                    today={today}
                    busy={busyId === a.id}
                    onChanged={() => void refreshActions()}
                    onDecide={(id, d, reason) => void run(id, () => decideAction(id, d, reason), d === 'approve' ? 'Approved.' : d === 'reject' ? 'Rejected.' : 'Cancelled.')}
                    onLaunch={(id) => void run(id, () => launchAction(id), 'Marked as launched.')}
                    onMeasure={(id) => void run(id, () => measureAction(id), 'Results measured.')}
                  />
                ))}
              </ul>
              {history.length > 0 && (
                <div className="mt-6 border-t border-border pt-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Measured and closed</h3>
                  <ul className="space-y-3">
                    {history.map((a) => (
                      <ActionCard
                        key={a.id}
                        a={a}
                        today={today}
                        busy={busyId === a.id}
                        onChanged={() => void refreshActions()}
                        onDecide={() => undefined}
                        onLaunch={() => undefined}
                        onMeasure={(id) => void run(id, () => measureAction(id), 'Results measured.')}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            <Card className="mb-6 p-6">
              <h2 className="mb-1 text-sm font-semibold text-text-primary">Memberships needed to cover fixed costs in the valley</h2>
              {!report.membership && <p className="text-sm text-text-secondary">Add your fixed expenses in <Link to="/dashboard/cash-flow" className="font-semibold text-accent hover:underline">Cash Flow Forecast</Link> to get a member target.</p>}
              {report.membership && (
                <>
                  <p className="text-xs text-text-secondary">
                    Fixed costs ≈ {fmtMoneyCents(report.membership.weekly_fixed_cents)}/week; valley gross profit ≈ {fmtMoneyCents(report.membership.valley_gross_profit_per_week_cents)}/week; {report.membership.active_members} active members today.
                  </p>
                  {report.membership.note && <p className="mt-2 text-sm text-text-secondary">{report.membership.note}</p>}
                  {report.membership.plans.length > 0 && (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full min-w-[560px] text-left text-xs">
                        <thead className="text-text-secondary">
                          <tr><th className="py-2 pr-3 font-medium">Plan</th><th className="pr-3 font-medium">Monthly</th><th className="pr-3 font-medium">More members needed</th><th className="pr-3 font-medium">Target total</th><th className="font-medium">Recurring revenue at target</th></tr>
                        </thead>
                        <tbody className="text-text-primary">
                          {report.membership.plans.map((p) => (
                            <tr key={p.id} className="border-t border-border">
                              <td className="py-2 pr-3 font-semibold">{p.name}</td>
                              <td className="pr-3">{fmtMoneyCents(p.monthly_cents)}</td>
                              <td className="pr-3">{p.additional_needed}</td>
                              <td className="pr-3">{p.total_target}</td>
                              <td>{fmtMoneyCents(p.mrr_at_target_cents)}/mo</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <Link to="/dashboard/memberships" className="mt-3 inline-block text-xs font-semibold text-accent hover:underline">Open Memberships</Link>
                </>
              )}
            </Card>

            <Card className="mb-6 p-6">
              <h2 className="mb-1 text-sm font-semibold text-text-primary">Cash-reserve plan</h2>
              {!report.cash && <p className="text-sm text-text-secondary">A reserve plan needs fixed expenses and a starting balance in <Link to="/dashboard/cash-flow" className="font-semibold text-accent hover:underline">Cash Flow Forecast</Link>.</p>}
              {report.cash && (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Kpi label="Starting cash" value={report.cash.starting_balance_known ? fmtMoneyCents(report.cash.starting_balance_cents) : 'Not set'} />
                    <Kpi label="Lowest point" value={fmtMoneyCents(report.cash.lowest_cum_cash_cents)} sub={report.cash.lowest_week ? `Week of ${fmtWeek(report.cash.lowest_week)}` : undefined} />
                    <Kpi label="Reserve to hold" value={fmtMoneyCents(report.cash.reserve_needed_cents)} sub={`Includes ${fmtMoneyCents(report.cash.buffer_cents)} buffer`} />
                    <Kpi label="Still to set aside" value={fmtMoneyCents(report.cash.shortfall_cents)} sub={report.cash.shortfall_cents === 0 ? 'Covered today' : report.cash.self_funded ? 'Fundable from peak surplus' : 'More than peak surplus can cover'} />
                  </div>
                  {report.cash.first_negative_week && (
                    <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">Cash turns negative in the week of {fmtWeek(report.cash.first_negative_week)} without a reserve.</p>
                  )}
                  {report.cash.monthly_set_aside_cents.length > 0 && (
                    <div className="mt-3 overflow-x-auto">
                      <p className="mb-1 text-xs text-text-secondary">Suggested set-aside from peak-season surplus</p>
                      <div className="flex flex-wrap gap-2">
                        {report.cash.monthly_set_aside_cents.map((m) => (
                          <span key={m.month} className="rounded-lg bg-bg-tertiary px-2 py-1 text-xs text-text-primary">{m.month}: {fmtMoneyCents(m.cents)}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {report.cash.compare_13_weeks.length > 0 && (
                    <p className="mt-3 text-xs text-text-secondary">
                      Week 13 balance: {fmtMoneyCents(report.cash.compare_13_weeks[report.cash.compare_13_weeks.length - 1].existing_cents)} in your Cash Flow Forecast vs {fmtMoneyCents(report.cash.compare_13_weeks[report.cash.compare_13_weeks.length - 1].stabilizer_cents)} here (this forecast also includes uncommitted seasonal demand).
                    </p>
                  )}
                  <Link to="/dashboard/cash-flow" className="mt-3 inline-block text-xs font-semibold text-accent hover:underline">Open Cash Flow Forecast</Link>
                </>
              )}
            </Card>

            {report.notes.length > 0 && (
              <ul className="mb-6 list-disc space-y-1 rounded-2xl border border-border bg-bg-secondary p-4 pl-8 text-xs text-text-secondary">
                {report.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}

            {runs.length > 0 && (
              <Card className="p-6">
                <h2 className="mb-3 text-sm font-semibold text-text-primary">Saved forecasts</h2>
                <ul className="space-y-1 text-xs text-text-secondary">
                  {runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap justify-between gap-2">
                      <span>{new Date(r.created_at).toLocaleString()}</span>
                      <span>Stability {r.stability_score}{r.stability_score_with_actions !== null ? ` → ${r.stability_score_with_actions} with actions` : ''} · {r.confidence} confidence</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
