import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Lock, Megaphone, RefreshCw, Sparkles, Link2, Check, X, Undo2, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import {
  PLATFORM_LABEL,
  TRACKING_TEMPLATES,
  buildPerformance,
  buildPortfolio,
  cohortRange,
  decideRecommendation,
  disconnectAccount,
  fetchAccounts,
  fetchCampaigns,
  fetchConversionCounts,
  fetchEconomics,
  fetchRecommendations,
  fetchSettings,
  formatCents,
  leadsVsProfitInsight,
  logLsaSpend,
  marketRollup,
  runOptimizer,
  saveSettings,
  sendConversions,
  setCampaignMarket,
  startConnect,
  syncNow,
  DEFAULT_SETTINGS,
  type AdAccount,
  type AdCampaign,
  type BudgetRecommendation,
  type DemandOsSettings,
  type DemandOsMode,
  type EconomicsRow,
} from '@/lib/demandOs';

const inputClass = 'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';
const btnClass =
  'focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50';
const primaryBtn =
  'focus-ring inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50';

const money = (c: number | null | undefined) => formatCents(c, { compact: true });
const ratio = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'good' ? 'text-success-500' : tone === 'bad' ? 'text-danger' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

export function DemandOsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [economics, setEconomics] = useState<EconomicsRow[]>([]);
  const [recs, setRecs] = useState<BudgetRecommendation[]>([]);
  const [settings, setSettings] = useState<DemandOsSettings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<DemandOsSettings>(DEFAULT_SETTINGS);
  const [convCounts, setConvCounts] = useState({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAutopilot, setConfirmAutopilot] = useState(false);
  const [disconnecting, setDisconnecting] = useState<AdAccount | null>(null);
  const [lsa, setLsa] = useState({ campaignId: '', start: '', end: '', amount: '' });

  const load = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const s = await fetchSettings();
      const { start, end } = cohortRange(s);
      const [a, c, e, r, k] = await Promise.all([
        fetchAccounts(),
        fetchCampaigns(),
        fetchEconomics(start, end),
        fetchRecommendations(),
        fetchConversionCounts(),
      ]);
      setSettings(s);
      setDraft(s);
      setAccounts(a);
      setCampaigns(c);
      setEconomics(e);
      setRecs(r);
      setConvCounts(k);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    load();
  }, [load]);

  // OAuth return: ?ads=connected|error
  useEffect(() => {
    const status = params.get('ads');
    if (!status) return;
    if (status === 'connected') toast(`Connected ${params.get('accounts') ?? ''} ad account(s). Pulling data…`, 'success');
    else toast(`Connection failed (${params.get('reason') ?? 'unknown'}). Please try again.`, 'error');
    const next = new URLSearchParams(params);
    next.delete('ads');
    next.delete('platform');
    next.delete('accounts');
    next.delete('reason');
    setParams(next, { replace: true });
    if (status === 'connected') {
      syncNow().then(load).catch(() => undefined);
    }
  }, [params, setParams, toast, load]);

  const performance = useMemo(() => buildPerformance(economics, campaigns), [economics, campaigns]);
  const portfolio = useMemo(() => buildPortfolio(performance), [performance]);
  const insight = useMemo(() => leadsVsProfitInsight(performance), [performance]);
  const markets = useMemo(() => marketRollup(performance), [performance]);
  const campaignById = useMemo(() => new Map(campaigns.map((c) => [c.id, c])), [campaigns]);
  const pending = recs.filter((r) => r.status === 'pending');
  const history = recs.filter((r) => r.status !== 'pending').slice(0, 10);
  const lsaCampaigns = campaigns.filter((c) => c.platform === 'google_lsa');
  const reconnect = accounts.filter((a) => a.status === 'needs_reauth');

  const act = async (key: string, fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doSync = () =>
    act('sync', async () => {
      const r = await syncNow();
      if (r.failed > 0) throw new Error(`${r.failed} account(s) failed to sync — check connection status below.`);
      await load();
    }, 'Ad data synced and leads re-linked.');

  const doRun = () =>
    act('run', async () => {
      await runOptimizer();
      await load();
    }, 'Budget analysis complete.');

  const doDecide = (id: string, action: 'approve' | 'reject' | 'revert') =>
    act(`${action}:${id}`, async () => {
      await decideRecommendation(id, action);
      await load();
    }, action === 'approve' ? 'Budget updated in the ad platform.' : action === 'revert' ? 'Budget restored.' : 'Recommendation dismissed.');

  const doSaveSettings = (next: DemandOsSettings) =>
    act('settings', async () => {
      await saveSettings(next);
      setSettings(next);
      setDraft(next);
    }, 'Settings saved.');

  const setMode = (mode: DemandOsMode) => {
    if (mode === 'autopilot') setConfirmAutopilot(true);
    else doSaveSettings({ ...draft, mode });
  };

  const setNum = (k: keyof DemandOsSettings, v: string) => setDraft((d) => ({ ...d, [k]: v === '' ? 0 : Number(v) }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Demand OS">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Demand OS">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Megaphone size={22} className="text-accent" /> Demand OS
            </h1>
            <p className="text-sm text-text-secondary">Google, Meta and LSA to booked jobs and real gross profit — budget follows profit, not leads.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnClass} onClick={doSync} disabled={!!busy || accounts.length === 0}>
            <RefreshCw size={14} className={busy === 'sync' ? 'animate-spin' : ''} /> Sync now
          </button>
          {isOwner && (
            <button type="button" className={primaryBtn} onClick={doRun} disabled={!!busy || campaigns.length === 0}>
              <Sparkles size={14} /> {busy === 'run' ? 'Analyzing…' : 'Analyze budgets'}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : loadFailed ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load Demand OS" description="Check your connection and try again." action={{ label: 'Retry', onClick: load }} />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            {reconnect.length > 0 && (
              <div role="alert" className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-text-primary">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" />
                <span>
                  {reconnect.map((a) => a.display_name ?? a.external_account_id).join(', ')} need to be reconnected. Syncing and budget changes are paused for them until you do.
                </span>
              </div>
            )}

            {/* Connections */}
            <Card className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-text-primary">Ad accounts</h2>
                {isOwner && (
                  <div className="flex gap-2">
                    <button type="button" className={btnClass} onClick={() => act('cg', () => startConnect('google'), '')}>
                      <Link2 size={14} /> Connect Google
                    </button>
                    <button type="button" className={btnClass} onClick={() => act('cm', () => startConnect('meta'), '')}>
                      <Link2 size={14} /> Connect Meta
                    </button>
                  </div>
                )}
              </div>
              {accounts.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">
                  Connect Google (Ads + Local Services) and Meta to pull real spend, link leads to campaigns, and send job profit back to the platforms. Only the account owner can connect or disconnect accounts.
                </p>
              ) : (
                <ul className="mt-4 space-y-1.5">
                  {accounts.map((a) => (
                    <li key={a.id} className="flex items-center justify-between rounded-xl border border-border/60 bg-bg-tertiary/30 px-4 py-2 text-sm">
                      <span className="text-text-primary">
                        {PLATFORM_LABEL[a.platform]} · {a.display_name ?? a.external_account_id}
                        <span className="ml-2 text-xs text-text-secondary">
                          {a.last_synced_at ? `synced ${new Date(a.last_synced_at).toLocaleString()}` : 'not synced yet'}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className={`text-xs font-semibold ${a.status === 'active' ? 'text-success-500' : a.status === 'needs_reauth' ? 'text-warning-500' : 'text-danger'}`}>
                          {a.status === 'active' ? 'Connected' : a.status === 'needs_reauth' ? 'Reconnect needed' : 'Error'}
                        </span>
                        {isOwner && (
                          <button type="button" className="focus-ring text-text-secondary hover:text-danger" aria-label={`Disconnect ${a.display_name ?? a.external_account_id}`} onClick={() => setDisconnecting(a)}>
                            <X size={14} />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {performance.length === 0 ? (
              <EmptyState
                icon={Megaphone}
                title="No campaign data in this window yet"
                description={`Demand OS looks at leads from ${settings.lookback_days} days ending ${settings.maturation_days} days ago, so jobs have time to close. Connect an account and tag your ad links (below) to start.`}
              />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  <Kpi label="Ad spend" value={money(portfolio.spendCents)} />
                  <Kpi label="Leads" value={String(portfolio.leads)} hint={`${portfolio.jobsWon} jobs won`} />
                  <Kpi label="Revenue" value={money(portfolio.revenueCents)} hint={portfolio.pipelineCents > 0 ? `${money(portfolio.pipelineCents)} still open` : undefined} />
                  <Kpi label="Gross profit" value={money(portfolio.grossProfitCents)} hint={`${ratio(portfolio.profitPerDollar)} per $1 of ads`} />
                  <Kpi label="Net after ads" value={money(portfolio.netProfitCents)} tone={portfolio.netProfitCents >= 0 ? 'good' : 'bad'} hint={portfolio.costPerWonJobCents ? `${money(portfolio.costPerWonJobCents)} per won job` : undefined} />
                </div>

                {insight && (
                  <Card className="p-6">
                    <h2 className="text-base font-semibold text-text-primary">Leads vs. profit</h2>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                      <strong className="text-text-primary">{insight.byLeads.campaign.name}</strong> brings the most leads ({insight.byLeads.leads}) but nets {money(insight.byLeads.netProfitCents)}.{' '}
                      <strong className="text-text-primary">{insight.byProfit.campaign.name}</strong> brings {insight.byProfit.leads} and nets {money(insight.byProfit.netProfitCents)}. Budget should follow profit.
                    </p>
                  </Card>
                )}

                {/* Recommendations */}
                <Card className="p-6">
                  <h2 className="text-base font-semibold text-text-primary">Budget recommendations</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Mode: <strong className="text-text-primary">{settings.mode}</strong>. Changes are capped at {settings.max_shift_pct}% per campaign, respect a {settings.cooldown_days}-day cooldown, and are fully logged.
                  </p>
                  {pending.length === 0 ? (
                    <p className="mt-4 text-sm text-text-secondary">No open recommendations. Run "Analyze budgets" after new data syncs.</p>
                  ) : (
                    <ul className="mt-4 space-y-3">
                      {pending.map((r) => {
                        const c = campaignById.get(r.campaign_id);
                        const up = r.direction === 'increase';
                        const net = r.evidence.estNetDailyProfitDeltaCents;
                        return (
                          <li key={r.id} className="rounded-xl border border-border/60 bg-bg-tertiary/30 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                                  {up ? <TrendingUp size={16} className="text-success-500" /> : <TrendingDown size={16} className="text-danger" />}
                                  {c?.name ?? 'Campaign'} <span className="text-xs font-normal text-text-secondary">{c ? PLATFORM_LABEL[c.platform] : ''}</span>
                                </p>
                                <p className="mt-1 text-sm text-text-primary">
                                  {money(r.current_budget_cents)}/day → <strong>{money(r.proposed_budget_cents)}/day</strong>
                                  {typeof net === 'number' && <span className="ml-2 text-xs text-text-secondary">est. {net >= 0 ? '+' : ''}{money(net)}/day profit</span>}
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-text-secondary">{r.reason}</p>
                                {!r.applyable && <p className="mt-1 text-xs text-warning-500">Advisory only — this budget can't be changed through the API. Adjust it in the platform.</p>}
                              </div>
                              {isOwner && (
                                <div className="flex gap-2">
                                  {r.applyable && (
                                    <button type="button" className={primaryBtn} disabled={!!busy} onClick={() => doDecide(r.id, 'approve')}>
                                      <Check size={14} /> Apply
                                    </button>
                                  )}
                                  <button type="button" className={btnClass} disabled={!!busy} onClick={() => doDecide(r.id, 'reject')}>
                                    <X size={14} /> Dismiss
                                  </button>
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {history.length > 0 && (
                    <details className="mt-5">
                      <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Recent activity</summary>
                      <ul className="mt-2 space-y-1.5">
                        {history.map((r) => (
                          <li key={r.id} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-1.5 text-xs text-text-secondary">
                            <span>
                              {campaignById.get(r.campaign_id)?.name ?? 'Campaign'} · {money(r.current_budget_cents)} → {money(r.proposed_budget_cents)} · <strong>{r.status}</strong>
                              {r.decided_by === 'autopilot' ? ' (autopilot)' : ''}
                              {r.error ? ` — ${r.error}` : ''}
                            </span>
                            {isOwner && r.status === 'applied' && (
                              <button type="button" className="focus-ring inline-flex items-center gap-1 font-semibold hover:text-text-primary" disabled={!!busy} onClick={() => doDecide(r.id, 'revert')}>
                                <Undo2 size={12} /> Revert
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Card>

                {/* Campaign table */}
                <Card className="overflow-x-auto p-6">
                  <h2 className="text-base font-semibold text-text-primary">Campaigns</h2>
                  <table className="mt-4 w-full min-w-[860px] text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-text-secondary">
                      <tr>
                        <th className="pb-2 pr-3">Campaign</th><th className="pb-2 pr-3">Market</th><th className="pb-2 pr-3 text-right">Spend</th>
                        <th className="pb-2 pr-3 text-right">Leads</th><th className="pb-2 pr-3 text-right">Won</th><th className="pb-2 pr-3 text-right">Revenue</th>
                        <th className="pb-2 pr-3 text-right">Gross profit</th><th className="pb-2 pr-3 text-right">$ / $1 ads</th><th className="pb-2 text-right">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {performance.map((p) => (
                        <tr key={p.campaign.id} className="border-t border-border/50">
                          <td className="py-2 pr-3 text-text-primary">
                            {p.campaign.name}
                            <span className="ml-2 text-xs text-text-secondary">{PLATFORM_LABEL[p.campaign.platform]}{p.campaign.status === 'paused' ? ' · paused' : ''}</span>
                          </td>
                          <td className="py-2 pr-3">
                            {isOwner ? (
                              <input
                                defaultValue={p.campaign.market_label ?? ''}
                                placeholder="Assign market"
                                maxLength={80}
                                aria-label={`Market for ${p.campaign.name}`}
                                className="focus-ring w-32 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xs text-text-primary hover:border-border"
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  if (v === (p.campaign.market_label ?? '')) return;
                                  setCampaignMarket(p.campaign.id, v).then(load).catch(() => toast('Could not save market.', 'error'));
                                }}
                              />
                            ) : (
                              <span className="text-xs text-text-secondary">{p.campaign.market_label ?? '—'}</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right">{money(p.spend_cents)}</td>
                          <td className="py-2 pr-3 text-right">{p.leads}</td>
                          <td className="py-2 pr-3 text-right">{p.jobs_won}</td>
                          <td className="py-2 pr-3 text-right">{money(p.revenue_cents)}</td>
                          <td className="py-2 pr-3 text-right">{money(p.gross_profit_cents)}</td>
                          <td className="py-2 pr-3 text-right">{ratio(p.profitPerDollar)}</td>
                          <td className={`py-2 text-right font-semibold ${p.netProfitCents >= 0 ? 'text-success-500' : 'text-danger'}`}>{money(p.netProfitCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-3 text-xs text-text-secondary">
                    Window: leads created {settings.lookback_days} days ending {settings.maturation_days} days ago, so jobs have time to close. Gross profit uses real job costs.
                  </p>
                </Card>

                {markets.length > 1 && (
                  <Card className="p-6">
                    <h2 className="text-base font-semibold text-text-primary">By market</h2>
                    <ul className="mt-3 space-y-1.5">
                      {markets.map((m) => (
                        <li key={m.market} className="flex items-center justify-between rounded-xl border border-border/60 bg-bg-tertiary/30 px-4 py-2 text-sm">
                          <span className="text-text-primary">{m.market}</span>
                          <span className="text-text-secondary">
                            {money(m.portfolio.spendCents)} spend · {m.portfolio.jobsWon} jobs · <strong className={m.portfolio.netProfitCents >= 0 ? 'text-success-500' : 'text-danger'}>{money(m.portfolio.netProfitCents)}</strong> net
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </>
            )}

            {/* LSA spend */}
            {isOwner && lsaCampaigns.length > 0 && (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-text-primary">Log Local Services spend</h2>
                <p className="mt-1 text-sm text-text-secondary">Google doesn't expose LSA cost through its API. Enter the total from your LSA dashboard; it's spread evenly across the period.</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <select className={inputClass} value={lsa.campaignId} onChange={(e) => setLsa({ ...lsa, campaignId: e.target.value })} aria-label="LSA account">
                    <option value="">Select account</option>
                    {lsaCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input type="date" className={inputClass} value={lsa.start} onChange={(e) => setLsa({ ...lsa, start: e.target.value })} aria-label="Period start" />
                  <input type="date" className={inputClass} value={lsa.end} onChange={(e) => setLsa({ ...lsa, end: e.target.value })} aria-label="Period end" />
                  <input type="number" min={0} step="0.01" placeholder="Total ($)" className={inputClass} value={lsa.amount} onChange={(e) => setLsa({ ...lsa, amount: e.target.value })} />
                  <button
                    type="button"
                    className={primaryBtn}
                    disabled={!!busy || !lsa.campaignId || !lsa.start || !lsa.end || !(Number(lsa.amount) >= 0) || lsa.amount === ''}
                    onClick={() => act('lsa', async () => { await logLsaSpend(lsa.campaignId, lsa.start, lsa.end, Number(lsa.amount)); setLsa({ campaignId: '', start: '', end: '', amount: '' }); await load(); }, 'LSA spend logged.')}
                  >
                    Log spend
                  </button>
                </div>
              </Card>
            )}

            {/* Settings */}
            {isOwner && (
              <Card className="p-6">
                <h2 className="text-base font-semibold text-text-primary">Automation & guardrails</h2>
                <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Automation mode">
                  {(['off', 'recommend', 'autopilot'] as DemandOsMode[]).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={settings.mode === m} onClick={() => setMode(m)} disabled={!!busy}
                      className={`rounded-xl border px-4 py-2 text-xs font-semibold transition-colors ${settings.mode === m ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}`}>
                      {m === 'off' ? 'Off' : m === 'recommend' ? 'Recommend (you approve)' : 'Autopilot'}
                    </button>
                  ))}
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {([
                    ['max_shift_pct', 'Max budget shift / change (%)', 1, 30],
                    ['cooldown_days', 'Cooldown between changes (days)', 3, 30],
                    ['min_jobs', 'Min. won jobs of evidence', 1, 1000],
                    ['maturation_days', 'Lead maturation (days)', 0, 90],
                    ['lookback_days', 'Lookback window (days)', 14, 365],
                    ['conversion_delay_days', 'Conversion upload delay (days)', 0, 30],
                  ] as const).map(([key, label, min, max]) => (
                    <label key={key} className="text-xs font-semibold text-text-secondary">
                      {label}
                      <input type="number" min={min} max={max} className={`${inputClass} mt-1`} value={draft[key]} onChange={(e) => setNum(key, e.target.value)} />
                    </label>
                  ))}
                  <label className="text-xs font-semibold text-text-secondary">
                    Min. spend before acting ($)
                    <input type="number" min={0} className={`${inputClass} mt-1`} value={draft.min_spend_cents / 100} onChange={(e) => setDraft({ ...draft, min_spend_cents: Math.round(Number(e.target.value || 0) * 100) })} />
                  </label>
                  <label className="text-xs font-semibold text-text-secondary">
                    Total daily cap ($, optional)
                    <input type="number" min={0} className={`${inputClass} mt-1`} value={draft.total_daily_cap_cents ? draft.total_daily_cap_cents / 100 : ''} onChange={(e) => setDraft({ ...draft, total_daily_cap_cents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })} />
                  </label>
                  <label className="flex items-center gap-2 pt-5 text-xs font-semibold text-text-secondary">
                    <input type="checkbox" checked={draft.allow_growth} onChange={(e) => setDraft({ ...draft, allow_growth: e.target.checked })} />
                    Allow total budget to grow
                  </label>
                </div>
                <h3 className="mt-6 text-sm font-semibold text-text-primary">Send profit back to the platforms</h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="text-xs font-semibold text-text-secondary">
                    Conversion value
                    <select className={`${inputClass} mt-1`} value={draft.conversion_value_basis} onChange={(e) => setDraft({ ...draft, conversion_value_basis: e.target.value as DemandOsSettings['conversion_value_basis'] })}>
                      <option value="gross_profit">Gross profit (recommended)</option>
                      <option value="revenue">Revenue</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-text-secondary">
                    Google conversion action ID
                    <input className={`${inputClass} mt-1`} inputMode="numeric" value={draft.google_conversion_action_id ?? ''} onChange={(e) => setDraft({ ...draft, google_conversion_action_id: e.target.value.replace(/\D/g, '') || null })} />
                  </label>
                  <label className="text-xs font-semibold text-text-secondary">
                    Meta pixel / dataset ID
                    <input className={`${inputClass} mt-1`} inputMode="numeric" value={draft.meta_pixel_id ?? ''} onChange={(e) => setDraft({ ...draft, meta_pixel_id: e.target.value.replace(/\D/g, '') || null })} />
                  </label>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <button type="button" className={primaryBtn} disabled={!dirty || !!busy} onClick={() => doSaveSettings(draft)}>Save settings</button>
                  <button type="button" className={btnClass} disabled={!!busy} onClick={() => act('cv-dry', async () => { const r = await sendConversions(true); toast(`Validated ${r.sent} event(s), ${r.failed} failed.`, r.failed ? 'error' : 'success'); }, '')}>Validate upload (no changes)</button>
                  <button type="button" className={btnClass} disabled={!!busy} onClick={() => act('cv', async () => { await sendConversions(false); await load(); }, 'Conversions sent.')}>Send conversions now</button>
                  <span className="text-xs text-text-secondary">
                    {convCounts.sent} sent · {convCounts.pending} pending · {convCounts.failed} failed · {convCounts.skipped} skipped
                  </span>
                </div>
              </Card>
            )}

            {/* Tracking setup */}
            <Card className="p-6">
              <h2 className="text-base font-semibold text-text-primary">Tracking setup (required for lead → campaign matching)</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Add these to your ad's final-URL suffix so each visit carries the real campaign ID. Also pass <code>gclid</code> / <code>fbclid</code> to <code>marketing-track</code> so profit can be sent back.
              </p>
              {(['google', 'meta'] as const).map((k) => (
                <div key={k} className="mt-3">
                  <p className="text-xs font-semibold text-text-secondary">{k === 'google' ? 'Google Ads — final URL suffix' : 'Meta Ads — URL parameters'}</p>
                  <code className="mt-1 block overflow-x-auto rounded-xl border border-border bg-bg-tertiary/40 px-3 py-2 text-xs text-text-primary">{TRACKING_TEMPLATES[k]}</code>
                </div>
              ))}
            </Card>
          </div>
        </FadeIn>
      )}

      <ConfirmDialog
        open={confirmAutopilot}
        title="Turn on Autopilot?"
        description={`Vireek will change real ad budgets on its own (max ${draft.max_shift_pct}% per campaign, ${draft.cooldown_days}-day cooldown), and every change is logged and reversible. Type the phrase below to confirm.`}
        confirmPhrase="enable autopilot"
        confirmLabel="Enable autopilot"
        onConfirm={async () => {
          setConfirmAutopilot(false);
          await doSaveSettings({ ...draft, mode: 'autopilot' });
        }}
        onCancel={() => setConfirmAutopilot(false)}
      />
      <ConfirmDialog
        open={!!disconnecting}
        title="Disconnect this ad account?"
        description="Vireek will stop syncing it and delete its stored credentials. Historical campaign data is removed with it."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          const a = disconnecting;
          setDisconnecting(null);
          if (a) await act('dc', async () => { await disconnectAccount(a.id); await load(); }, 'Account disconnected.');
        }}
        onCancel={() => setDisconnecting(null)}
      />
    </DashboardLayout>
  );
}
