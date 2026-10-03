/**
 * Pricing Learning Flywheel — /dashboard/pricing-flywheel
 *
 * Job Profitability Autopsy -> Learn -> Approve -> Apply -> Measure -> repeat.
 * Realized margin per Price Book item becomes a bounded price proposal; the
 * owner approves it; the result is judged on real jobs afterwards.
 * See src/lib/pricingFlywheel.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, RefreshCw, RotateCcw, TrendingUp, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  analyzePricing,
  centsText,
  decideAdjustment,
  gatherFlywheelData,
  pctText,
  persistProposals,
  saveFlywheelSettings,
  STATE_META,
  summarizeResults,
  VERDICT_META,
  type AdjustmentRow,
  type FlywheelData,
  type FlywheelSettings,
  type ItemAnalysis,
} from '@/lib/pricingFlywheel';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={CARD}>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-text-secondary/70">{hint}</p>}
    </div>
  );
}

const LAP = ['Autopsy', 'Learn', 'Approve', 'Measure'];

function LapStrip({ jobs, proposals, active, judged }: { jobs: number; proposals: number; active: number; judged: number }) {
  const counts = [`${jobs} jobs`, `${proposals} proposed`, `${active} live`, `${judged} judged`];
  return (
    <ol className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Flywheel stages">
      {LAP.map((l, i) => (
        <li key={l} className="rounded-xl border border-border bg-bg-secondary px-3 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            {i + 1}. {l}
          </p>
          <p className="text-sm font-semibold text-text-primary">{counts[i]}</p>
        </li>
      ))}
    </ol>
  );
}

function ItemRow({ a }: { a: ItemAnalysis }) {
  const meta = STATE_META[a.state];
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="min-w-0 max-w-md">
        <p className="truncate text-sm font-medium text-text-primary">{a.item.service_name}</p>
        <p className="text-[11px] text-text-secondary">{a.reason}</p>
      </div>
      <div className="flex items-center gap-3 text-right">
        <div className="text-[11px] text-text-secondary">
          <p>Book {centsText(a.item.price_cents)}</p>
          <p>Margin {pctText(a.marginPct)}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
      </div>
    </li>
  );
}

function ProposalCard({
  p,
  busy,
  canDecide,
  onDecide,
}: {
  p: AdjustmentRow;
  busy: boolean;
  canDecide: boolean;
  onDecide: (id: string, d: 'approve' | 'dismiss') => void;
}) {
  const rise = Math.round((p.price_proposed_cents / p.price_before_cents - 1) * 1000) / 10;
  const projected = ((p.price_proposed_cents - p.avg_cost_cents) / p.price_proposed_cents) * 100;
  const driver = p.evidence?.driver === 'cost_overrun';
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">{p.service_name}</p>
          <p className="mt-0.5 text-sm text-text-primary">
            {centsText(p.price_before_cents)} → <span className="font-semibold">{centsText(p.price_proposed_cents)}</span>{' '}
            <span className="text-xs text-text-secondary">(+{rise}%)</span>
          </p>
        </div>
        {canDecide ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(p.id, 'dismiss')}>
              <X size={14} /> Dismiss
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onDecide(p.id, 'approve')}>
              <Check size={14} /> Approve &amp; apply
            </Button>
          </div>
        ) : (
          <span className="text-[11px] text-text-secondary">Only the account owner can approve</span>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
        Based on {p.sample_size} costed jobs at the current price: average cost {centsText(p.avg_cost_cents)}, average billed{' '}
        {centsText(p.avg_revenue_cents)}, margin {pctText(p.observed_margin_pct)} vs. {pctText(p.target_margin_pct, 0)} target. If cost and
        volume stay the same, margin would be about {pctText(projected)}.
        {driver ? ' Real cost also runs above this item’s cost estimate — review that estimate too.' : ''}
      </p>
    </div>
  );
}

function SettingsCard({ settings, canEdit, onSave }: { settings: FlywheelSettings; canEdit: boolean; onSave: (s: FlywheelSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const dirty =
    draft.target_margin_pct !== settings.target_margin_pct ||
    draft.max_step_pct !== settings.max_step_pct ||
    draft.min_samples !== settings.min_samples;
  const valid =
    draft.target_margin_pct >= 5 && draft.target_margin_pct <= 80 &&
    draft.max_step_pct >= 1 && draft.max_step_pct <= 25 &&
    Number.isInteger(draft.min_samples) && draft.min_samples >= 3 && draft.min_samples <= 50;

  const field = (key: keyof FlywheelSettings, label: string, hint: string) => (
    <label className="block text-xs text-text-secondary">
      {label}
      <input
        type="number"
        value={Number.isNaN(draft[key]) ? '' : draft[key]}
        disabled={!canEdit || saving}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value === '' ? NaN : Number(e.target.value) })}
        className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60"
      />
      <span className="text-[10px] text-text-secondary/70">{hint}</span>
    </label>
  );

  return (
    <section className={CARD} aria-label="Flywheel settings">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">Flywheel rules</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {field('target_margin_pct', 'Target margin %', '5 – 80')}
        {field('max_step_pct', 'Max price rise per step %', '1 – 25')}
        {field('min_samples', 'Min costed jobs', '3 – 50')}
      </div>
      {canEdit && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            disabled={!dirty || !valid || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(draft);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save rules
          </Button>
        </div>
      )}
    </section>
  );
}

export function PricingFlywheelPage() {
  const { toast } = useToast();
  const { isOwner } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<FlywheelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (learn: boolean) => {
      const id = ++reqId.current;
      try {
        let d = await gatherFlywheelData();
        if (learn && isOwner) {
          const a = analyzePricing(d.facts, d.items, d.adjustments, d.settings);
          const saved = await persistProposals(a.proposals);
          if (saved > 0) d = await gatherFlywheelData();
          if (id === reqId.current) toast(saved > 0 ? `${saved} price proposal${saved === 1 ? '' : 's'} updated` : 'No new price proposals');
        }
        if (id !== reqId.current) return;
        setData(d);
        setFailed(false);
      } catch (e) {
        if (id !== reqId.current) return;
        if (learn) toast(errMessage(e), 'error');
        else setFailed(true);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [isOwner, toast],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const analysis = useMemo(
    () => (data ? analyzePricing(data.facts, data.items, data.adjustments, data.settings) : null),
    [data],
  );
  const summary = useMemo(() => summarizeResults(data?.results ?? []), [data]);
  const proposed = useMemo(() => (data?.adjustments ?? []).filter((a) => a.status === 'proposed'), [data]);
  const active = useMemo(() => (data?.adjustments ?? []).filter((a) => a.status === 'active'), [data]);
  const resultById = useMemo(() => new Map((data?.results ?? []).map((r) => [r.adjustment_id, r])), [data]);

  const onDecide = async (id: string, decision: 'approve' | 'dismiss' | 'revert') => {
    setBusyId(id);
    try {
      await decideAdjustment(id, decision);
      toast(
        decision === 'approve' ? 'Price applied to the Price Book' : decision === 'revert' ? 'Price restored' : 'Proposal dismissed',
      );
      await load(false);
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onSaveSettings = async (s: FlywheelSettings) => {
    try {
      await saveFlywheelSettings(s);
      toast('Flywheel rules saved');
      await load(false);
    } catch (e) {
      toast(errMessage(e), 'error');
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    void load(true);
  };

  return (
    <DashboardLayout activeLabel="Pricing Flywheel">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <TrendingUp size={18} /> Pricing Learning Flywheel
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every finished job teaches your Price Book. Vireek learns what each service really earns, proposes a bounded price change,
              applies it only after you approve, then measures whether margin actually improved.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onRefresh} disabled={refreshing || loading}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {isOwner ? 'Learn from jobs' : 'Refresh'}
          </Button>
        </div>

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={2} />
          </div>
        ) : failed || !data || !analysis ? (
          <EmptyState
            icon={TrendingUp}
            title="Pricing Flywheel unavailable"
            description="Pricing data could not be loaded. Check your connection and try again."
            action={{ label: 'Reload', onClick: () => { setLoading(true); setFailed(false); void load(false); } }}
          />
        ) : data.items.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="Your Price Book is empty"
            description="Add services to the Price Book and log job costs. The flywheel learns from costed jobs matched to those services."
            action={{ label: 'Open Price Book', onClick: () => navigate('/dashboard/price-book') }}
          />
        ) : (
          <>
            <LapStrip
              jobs={analysis.totals.jobsLearnedFrom}
              proposals={proposed.length}
              active={active.length}
              judged={summary.improved + summary.flat + summary.worsened}
            />

            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Services with data" value={String(analysis.totals.itemsWithData)} hint="Enough costed jobs at today’s price" />
              <StatCard label="Open proposals" value={String(proposed.length)} hint="Waiting for owner approval" />
              <StatCard label="Discount leakage" value={centsText(analysis.totals.leakageCents)} hint="Billed under book price (sampled jobs)" />
              <StatCard label="Margin target" value={`${data.settings.target_margin_pct}%`} hint={`Max step ${data.settings.max_step_pct}%`} />
            </div>

            {proposed.length > 0 && (
              <section className={`${CARD} mb-4`} aria-label="Price proposals">
                <h2 className="mb-3 text-sm font-semibold text-text-primary">Proposed price changes</h2>
                <div className="space-y-3">
                  {proposed.map((p) => (
                    <ProposalCard key={p.id} p={p} busy={busyId === p.id} canDecide={isOwner} onDecide={onDecide} />
                  ))}
                </div>
              </section>
            )}

            <section className={`${CARD} mb-4`} aria-label="Measured results">
              <h2 className="text-sm font-semibold text-text-primary">Did applied prices help?</h2>
              <p className="mt-1 text-sm text-text-secondary">{summary.headline}</p>
              {active.length + data.adjustments.filter((a) => a.status === 'reverted' || a.status === 'superseded').length > 0 && (
                <ul className="mt-3 divide-y divide-border">
                  {data.adjustments
                    .filter((a) => a.activated_at)
                    .map((a) => {
                      const r = resultById.get(a.id);
                      const v = r ? VERDICT_META[r.verdict] : VERDICT_META.insufficient;
                      return (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-text-primary">
                              {a.service_name}: {centsText(a.price_before_cents)} → {centsText(a.applied_price_cents)}{' '}
                              <span className="text-[11px] text-text-secondary">({a.status})</span>
                            </p>
                            <p className="text-[11px] text-text-secondary">
                              {a.activated_at ? shortDate(a.activated_at) : ''}
                              {r ? ` · ${r.costed_before} jobs before, ${r.costed_after} after` : ''}
                              {r && r.margin_before !== null && r.margin_after !== null
                                ? ` · margin ${pctText(r.margin_before)} → ${pctText(r.margin_after)}`
                                : ''}
                              {r?.demand_warning ? ' · job volume dropped sharply' : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${v.className}`}>{v.label}</span>
                            {a.status === 'active' && isOwner && (
                              <Button size="sm" variant="secondary" disabled={busyId === a.id} onClick={() => onDecide(a.id, 'revert')}>
                                <RotateCcw size={14} /> Revert
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-text-secondary/70">
                Observational comparison of the 30 days before and after each change, only with enough costed jobs on both sides. It is
                evidence, not proof of cause. Every applied change is also recorded in the{' '}
                <Link to="/dashboard/operations-loop" className="text-accent hover:underline">
                  Operations Loop
                </Link>
                .
              </p>
            </section>

            <section className={`${CARD} mb-4`} aria-label="Service analysis">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">What each service really earns</h2>
                <Link to="/dashboard/job-autopsy" className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-accent">
                  Job autopsies <ArrowRight size={10} />
                </Link>
              </div>
              <ul className="divide-y divide-border">
                {analysis.items.map((a) => (
                  <ItemRow key={a.item.id} a={a} />
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-text-secondary/70">
                Learned only from completed, non-rework jobs with itemized costs, linked to a Price Book item by explicit link or exact
                name, at the current price. Only flat-price items are learned.
              </p>
            </section>

            <SettingsCard settings={data.settings} canEdit={isOwner} onSave={onSaveSettings} />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
