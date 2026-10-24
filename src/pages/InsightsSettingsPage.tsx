/**
 * Vireek Insights - /dashboard/insights
 * Opt-in consent (owner/admin), a preview of exactly which of your own numbers
 * would be shared, and state-level indexes for contributing businesses.
 * Consent and access are enforced in the database; this page only calls RPCs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock, ShieldCheck, TrendingUp, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  CONSENT_NEVER_SHARED,
  CONSENT_SHARED,
  CONSENT_TERMS,
  METRIC_META,
  METRIC_ORDER,
  US_STATES,
  TRADE_LABELS,
  contributorBandLabel,
  formatChange,
  formatInsightValue,
  periodLabelHuman,
  regionLabel,
  tradeLabel,
  type InsightCell,
  type InsightMetric,
} from '@/lib/insights';
import {
  fetchConsentLog,
  fetchInsightsSettings,
  fetchMemberIndexes,
  fetchMyPreview,
  setInsightsContribution,
  type ConsentLogEntry,
  type InsightsSettings,
  type MyPreview,
} from '@/lib/insightsApi';

const UNIT_BY_METRIC: Record<InsightMetric, InsightCell['unit']> = {
  avg_ticket_cents: 'cents',
  close_rate_pct: 'percent',
  response_hours: 'hours',
  leads_per_business: 'count',
  demand_index: 'index',
};

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function InsightsSettingsPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const canView = isOwner || permissions.can_view_billing;

  const [settings, setSettings] = useState<InsightsSettings | null>(null);
  const [preview, setPreview] = useState<MyPreview | null>(null);
  const [log, setLog] = useState<ConsentLogEntry[]>([]);
  const [cells, setCells] = useState<InsightCell[]>([]);
  const [trade, setTrade] = useState('all');
  const [region, setRegion] = useState('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const s = await fetchInsightsSettings();
      const [p, l, c] = await Promise.all([
        fetchMyPreview().catch(() => null),
        fetchConsentLog().catch(() => []),
        s.contribute ? fetchMemberIndexes().catch(() => []) : Promise.resolve([] as InsightCell[]),
      ]);
      if (id !== reqId.current) return;
      setSettings(s);
      setPreview(p);
      setLog(l);
      setCells(c);
    } catch {
      if (id === reqId.current) toastRef.current('Could not load Insights settings', 'error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void load();
  }, [canView, load]);

  const change = async (enabled: boolean) => {
    setSaving(true);
    try {
      await setInsightsContribution(enabled);
      toastRef.current(enabled ? 'Thanks. Your business now contributes to Vireek Insights.' : 'You have stopped sharing data.', 'success');
      setConfirming(false);
      setUnderstood(false);
      await load();
    } catch {
      toastRef.current('Only an owner or admin can change data sharing.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const visible = useMemo(
    () => cells.filter((c) => (trade === 'all' ? c.trade === 'all' : c.trade === trade) && c.region_key === region),
    [cells, trade, region],
  );
  const byMetric = useMemo(() => new Map(visible.map((c) => [c.metric, c])), [visible]);
  const contributing = settings?.contribute ?? false;
  const previewMap = new Map((preview?.values ?? []).map((v) => [v.metric, v.value]));

  return (
    <DashboardLayout activeLabel="Insights">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <TrendingUp size={22} className="text-accent" /> Vireek Insights
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Contribute anonymously to quarterly industry indexes and see state-level results for your trade. Nothing is published unless
            at least 10 businesses are in the group. <Link to="/insights" className="font-semibold text-accent">See the public report</Link>
          </p>
        </div>

        {!canView ? (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center">
            <Lock className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
            <p className="mx-auto max-w-sm text-sm text-text-secondary">Insights settings are available to owners and users with billing access.</p>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            <section className="rounded-2xl border border-border bg-bg-secondary p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-bold text-text-primary">
                    <ShieldCheck size={18} className="text-accent" /> Data sharing
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    {contributing ? `Sharing since ${formatDate(settings?.consented_at ?? null)}.` : 'Off. Nothing from your business is shared.'}
                  </p>
                </div>
                {contributing ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void change(false)}
                    className="focus-ring rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-50"
                  >
                    Stop sharing
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white"
                  >
                    Review and opt in
                  </button>
                )}
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">What is shared</p>
                  <ul className="space-y-1.5 text-sm text-text-primary">
                    {CONSENT_SHARED.map((t) => (
                      <li key={t} className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-success-500" />{t}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Never shared</p>
                  <ul className="space-y-1.5 text-sm text-text-primary">
                    {CONSENT_NEVER_SHARED.map((t) => (
                      <li key={t} className="flex gap-2"><X size={15} className="mt-0.5 shrink-0 text-danger" />{t}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {confirming && !contributing && (
                <div className="mt-5 rounded-xl border border-accent/30 bg-accent/5 p-4">
                  <p className="text-sm font-semibold text-text-primary">Before you opt in</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                    {CONSENT_TERMS.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                  <label className="mt-3 flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1" />
                    I understand and I am authorised to share on behalf of this business.
                  </label>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={!understood || saving}
                      onClick={() => void change(true)}
                      className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Confirm opt-in
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} className="focus-ring rounded-xl border border-border px-4 py-2 text-sm text-text-secondary">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-bg-secondary p-6">
              <h2 className="text-lg font-bold text-text-primary">Your numbers for the last quarter</h2>
              <p className="mt-1 text-sm text-text-secondary">
                {preview
                  ? `${periodLabelHuman(preview.period)} - ${preview.trade === 'other' ? 'trade not recognised' : tradeLabel(preview.trade)} - ${regionLabel(preview.region)}.`
                  : 'No metric has enough data yet.'}{' '}
                A metric needs at least 10 records to count.
              </p>
              {preview && preview.trade === 'other' && (
                <p className="mt-2 text-sm text-warning-500">Set your primary industry in the business profile so your numbers can be grouped.</p>
              )}
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {METRIC_ORDER.map((m) => {
                  const v = previewMap.get(m);
                  return (
                    <div key={m} className="flex items-center justify-between rounded-xl bg-bg-tertiary px-4 py-3 text-sm">
                      <span className="text-text-secondary">{METRIC_META[m].label}</span>
                      <span className="font-semibold text-text-primary">{v === undefined ? 'Not enough data' : formatInsightValue(UNIT_BY_METRIC[m], v)}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-bg-secondary p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-bold text-text-primary">Industry indexes</h2>
                {contributing && (
                  <div className="flex gap-2">
                    <select value={trade} onChange={(e) => setTrade(e.target.value)} aria-label="Trade" className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
                      {Object.keys(TRADE_LABELS).map((k) => (
                        <option key={k} value={k}>{TRADE_LABELS[k]}</option>
                      ))}
                    </select>
                    <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region" className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
                      <option value="all">United States</option>
                      {Object.entries(US_STATES).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {!contributing ? (
                <p className="mt-3 text-sm text-text-secondary">Opt in to unlock state-level indexes for every trade.</p>
              ) : visible.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">No published index for this selection. Small groups are never published.</p>
              ) : (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {METRIC_ORDER.map((m) => {
                    const c = byMetric.get(m);
                    if (!c) return null;
                    return (
                      <div key={m} className="rounded-xl bg-bg-tertiary px-4 py-3">
                        <p className="text-xs text-text-secondary">{METRIC_META[m].label} - {periodLabelHuman(c.period_label)}</p>
                        <p className="mt-1 text-xl font-bold text-text-primary">{formatInsightValue(c.unit, c.p50)}</p>
                        <p className="text-xs text-text-secondary">
                          {formatInsightValue(c.unit, c.p25)} - {formatInsightValue(c.unit, c.p75)}
                          {m !== 'demand_index' && c.qoq_change_pct !== null ? ` - ${formatChange(c.qoq_change_pct)} QoQ` : ''} - {contributorBandLabel(c.contributor_band)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {log.length > 0 && (
              <section className="rounded-2xl border border-border bg-bg-secondary p-6">
                <h2 className="text-lg font-bold text-text-primary">Consent history</h2>
                <ul className="mt-3 space-y-1 text-sm text-text-secondary">
                  {log.map((e, i) => (
                    <li key={`${e.created_at}-${i}`}>{formatDate(e.created_at)} - {e.action === 'granted' ? 'Opted in' : 'Stopped sharing'} (terms v{e.consent_version})</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
