/**
 * /dashboard/sales-pipeline (wrapped in <ProtectedRoute>). Open deals by stage, weighted forecast and deal-desk discount
 * approvals on top of the existing CRM module (`crm_deals`). Account-scoped by RLS; approval rules are enforced by database
 * triggers, the checks here only explain them. Setup (stages) needs can_edit_business_profile; the deal-desk policy is owner-only.
 * Setup guide: docs/sales/pipeline.md.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonPage } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useSalesPipelineT } from '@/i18n/salesPipelineNamespace';
import { useCanManageCrm, useCrmOwnerId } from '@/lib/crmSync';
import {
  FORECAST_CATEGORIES, LIMITS, buildForecast, canDecide, canWithdraw, dealDeskMetrics, isCurrencyCode, parseAmount,
  parseMatchNames, parseProbability, requiredApprovalLevel, resolveStage, validateDiscountDraft, validateThresholds,
  type DealDeskSettings, type DiscountRequest, type ForecastCategory, type PipelineDeal, type PipelineStage,
} from '@/lib/salesPipeline';
import {
  DEAL_LIMIT, REQUEST_LIMIT, SalesPipelineApiError, createDeal, createDiscountRequest, decideRequest, fetchDealDeskSettings,
  fetchDeals, fetchRequests, fetchStages, saveDealDeskSettings, seedDefaultStages, updateDeal, updateStage, withdrawRequest,
  type SalesPipelineErrorCode,
} from '@/lib/salesPipelineApi';

type Load = 'loading' | 'ready' | 'error';
type Tab = 'pipeline' | 'forecast' | 'dealDesk' | 'setup';
const TABS: readonly Tab[] = ['pipeline', 'forecast', 'dealDesk', 'setup'];

const API_KEY: Record<SalesPipelineErrorCode, string> = {
  forbidden: 'forbidden', invalid: 'invalid', discount_requires_approval: 'discountRequiresApproval', deal_desk_disabled: 'dealDeskDisabled',
  deal_not_found: 'dealNotFound', self_approval: 'selfApproval', owner_required: 'ownerRequired', closed: 'closed',
  duplicate_pending: 'duplicatePending', note_required: 'noteRequired', unknown: 'unknown',
};

interface StageDraft { label: string; probability: string; category: ForecastCategory; match: string }
const draftOf = (s: PipelineStage): StageDraft => ({ label: s.label, probability: String(s.win_probability_pct), category: s.forecast_category, match: s.match_names.join(', ') });

export function SalesPipelinePage() {
  const { t, language } = useSalesPipelineT();
  const { toast } = useToast();
  const { user, isOwner } = useAuth();
  const canManage = useCanManageCrm();
  const ownerId = useCrmOwnerId();

  const [load, setLoad] = useState<Load>('loading');
  const [tab, setTab] = useState<Tab>('pipeline');
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<PipelineDeal[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [settings, setSettings] = useState<DealDeskSettings>({ enabled: false, auto_approve_max_pct: 10, manager_max_pct: 20 });
  const [requests, setRequests] = useState<DiscountRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // forms
  const [dealForm, setDealForm] = useState({ title: '', amount: '', currency: 'USD', stage: '', closeDate: '' });
  const [dealErrors, setDealErrors] = useState<Partial<Record<'title' | 'amount' | 'currency' | 'stage', string>>>({});
  const [reqForm, setReqForm] = useState({ dealId: '', pct: '', reason: '' });
  const [reqErrors, setReqErrors] = useState<{ pct?: string; reason?: string; deal?: string }>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [stageDrafts, setStageDrafts] = useState<Record<string, StageDraft>>({});
  const [deskDraft, setDeskDraft] = useState({ enabled: false, auto: '10', manager: '20' });
  const [deskError, setDeskError] = useState<string | undefined>();

  const money = useCallback((cents: number, currency: string | null): string => {
    const value = cents / 100;
    if (!currency) return value.toLocaleString(language, { maximumFractionDigits: 0 });
    try { return new Intl.NumberFormat(language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value); }
    catch { return `${value.toLocaleString(language, { maximumFractionDigits: 0 })} ${currency}`; }
  }, [language]);
  const dateFmt = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }), [language]);
  const fmtDay = (iso: string | null) => (iso ? dateFmt.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)) : t('pipeline.noDate'));
  const apiMsg = (e: unknown) => t(`api.${API_KEY[e instanceof SalesPipelineApiError ? e.code : 'unknown']}`);

  const refresh = useCallback(async () => {
    try {
      const [st, dl, ds, rq] = await Promise.all([fetchStages(), fetchDeals(), fetchDealDeskSettings(), fetchRequests()]);
      setStages(st);
      setDeals(dl.deals);
      setTruncated(dl.truncated);
      setSettings(ds);
      setRequests(rq);
      setStageDrafts(Object.fromEntries(st.map((s) => [s.id, draftOf(s)])));
      setDeskDraft({ enabled: ds.enabled, auto: String(ds.auto_approve_max_pct), manager: String(ds.manager_max_pct) });
      setDealForm((f) => (f.stage || st.length === 0 ? f : { ...f, stage: st[0].label }));
      setLoad('ready');
    } catch {
      setLoad('error');
    }
  }, []);

  useEffect(() => { setLoad('loading'); void refresh(); }, [refresh]);

  const run = async (key: string, fn: () => Promise<void>, okKey?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      if (okKey) toast(t(okKey), 'success');
      await refresh();
    } catch (e) {
      toast(apiMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const openDeals = useMemo(() => deals.filter((d) => d.status === 'open'), [deals]);
  const dealTitle = useMemo(() => new Map(deals.map((d) => [d.id, d.title])), [deals]);
  const forecast = useMemo(() => buildForecast(deals, stages, { now: new Date() }), [deals, stages]);
  const metrics = useMemo(() => dealDeskMetrics(requests, new Date()), [requests]);
  const grouped = useMemo(() => {
    const byStage = new Map<string, PipelineDeal[]>();
    const other: PipelineDeal[] = [];
    for (const d of openDeals) {
      const s = resolveStage(d.stage, stages);
      if (!s) { other.push(d); continue; }
      byStage.set(s.id, [...(byStage.get(s.id) ?? []), d]);
    }
    return { byStage, other };
  }, [openDeals, stages]);

  const decider = { userId: user?.id ?? null, isOwner, canManage };
  const levelLabel = (l: 'auto' | 'manager' | 'owner') => t(`desk.level.${l}`);

  // ---- handlers ----
  const onAddDeal = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof dealErrors = {};
    const title = dealForm.title.trim();
    if (!title) errs.title = t('errors.required'); else if (title.length > 300) errs.title = t('errors.too_long');
    const amount = parseAmount(dealForm.amount);
    if (Number.isNaN(amount)) errs.amount = t('errors.invalid');
    const currency = dealForm.currency.trim().toUpperCase();
    if (amount !== null && !Number.isNaN(amount) && !isCurrencyCode(currency)) errs.currency = t('errors.invalid');
    if (!dealForm.stage) errs.stage = t('errors.required');
    setDealErrors(errs);
    if (Object.keys(errs).length > 0) return;
    void run('add', async () => {
      await createDeal({ title, amount, currency: amount === null ? null : currency, stage: dealForm.stage, close_date: dealForm.closeDate || null, status: 'open' });
      setDealForm((f) => ({ ...f, title: '', amount: '', closeDate: '' }));
    }, 'pipeline.added');
  };

  const onSubmitRequest = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof reqErrors = {};
    if (!reqForm.dealId) errs.deal = t('errors.required');
    const v = validateDiscountDraft(reqForm.pct, reqForm.reason);
    if (!v.ok) { if (v.errors.pct) errs.pct = t(`errors.${v.errors.pct}`); if (v.errors.reason) errs.reason = t(`errors.${v.errors.reason}`); }
    setReqErrors(errs);
    if (Object.keys(errs).length > 0 || !v.ok) return;
    const auto = requiredApprovalLevel(v.pct, settings) === 'auto';
    void run('request', async () => {
      await createDiscountRequest(reqForm.dealId, v.pct, v.reason);
      setReqForm({ dealId: '', pct: '', reason: '' });
    }, auto ? 'desk.request.autoApproved' : 'desk.request.submitted');
  };

  const onSeed = () => void run('seed', async () => { const n = await seedDefaultStages(); toast(t('pipeline.stagesCreated', { count: n }), 'success'); });

  const onSaveStage = (s: PipelineStage) => {
    const d = stageDrafts[s.id];
    if (!d) return;
    const prob = parseProbability(d.probability);
    const names = parseMatchNames(d.match);
    const label = d.label.trim();
    if (!label || label.length > LIMITS.stageLabelMax || prob === null || Number.isNaN(prob) || !names.ok) { toast(t('api.invalid'), 'error'); return; }
    void run(`stage:${s.id}`, () => updateStage(s.id, { label, win_probability_pct: prob, forecast_category: d.category, match_names: names.names }), 'setup.saved');
  };

  const onSaveDesk = () => {
    const auto = Number(deskDraft.auto.replace(',', '.'));
    const manager = Number(deskDraft.manager.replace(',', '.'));
    const check = validateThresholds(auto, manager);
    if (check !== 'ok') { setDeskError(t(`errors.${check}`)); return; }
    setDeskError(undefined);
    if (!ownerId) { toast(t('api.forbidden'), 'error'); return; }
    void run('desk', () => saveDealDeskSettings(ownerId, { enabled: deskDraft.enabled, auto_approve_max_pct: auto, manager_max_pct: manager }), 'setup.deskSaved');
  };

  const shell = (children: ReactNode) => (
    <DashboardLayout activeLabel="Sales Pipeline"><main className="mx-auto max-w-6xl space-y-6">{children}</main></DashboardLayout>
  );

  if (load === 'loading') return shell(<div aria-busy="true"><SkeletonPage /></div>);
  if (load === 'error') {
    return shell(
      <EmptyState icon={AlertTriangle} variant="load-failed" title={t('page.loadFailedTitle')} description={t('page.loadFailedBody')}
        action={{ label: t('page.retry'), onClick: () => { setLoad('loading'); void refresh(); } }} />,
    );
  }

  const pendingLevel = (() => {
    const v = validateDiscountDraft(reqForm.pct || '0', 'x'.repeat(LIMITS.reasonMin));
    return v.ok ? levelLabel(requiredApprovalLevel(v.pct, settings)) : null;
  })();
  const th = 'px-3 py-2 text-start text-xs font-medium text-text-secondary';
  const td = 'px-3 py-2 text-sm text-text-primary align-top';

  const dealRows = (list: PipelineDeal[]) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead><tr>
          {(['deal', 'amount', 'close', 'discount', 'actions'] as const).map((c) => <th key={c} scope="col" className={th}>{t(`pipeline.columns.${c}`)}</th>)}
        </tr></thead>
        <tbody>
          {list.map((d) => (
            <tr key={d.id} className="border-t border-border">
              <td className={td}>{d.title}</td>
              <td className={td}>{d.amount === null ? <span className="text-text-secondary">{t('pipeline.noAmount')}</span> : money(Math.round(d.amount * 100), d.currency)}</td>
              <td className={td}>{fmtDay(d.close_date)}</td>
              <td className={td}>{d.discount_pct > 0 ? `${d.discount_pct}%` : '—'}</td>
              <td className={td}>
                <div className="flex flex-wrap items-center gap-2">
                  <Select aria-label={t('pipeline.moveTo')} value="" disabled={busy !== null}
                    onChange={(e) => { const v = e.target.value; if (v) void run(`move:${d.id}`, () => updateDeal(d.id, { stage: v }), 'pipeline.saved'); }}>
                    <option value="">{t('pipeline.moveTo')}</option>
                    {stages.map((s) => <option key={s.id} value={s.label}>{s.label}</option>)}
                  </Select>
                  <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void run(`won:${d.id}`, () => updateDeal(d.id, { status: 'won' }), 'pipeline.saved')}>{t('pipeline.markWon')}</Button>
                  <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void run(`lost:${d.id}`, () => updateDeal(d.id, { status: 'lost' }), 'pipeline.saved')}>{t('pipeline.markLost')}</Button>
                  {settings.enabled && (
                    <Button size="xs" variant="ghost" onClick={() => { setReqForm((f) => ({ ...f, dealId: d.id })); setTab('dealDesk'); }}>{t('pipeline.requestDiscount')}</Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return shell(
    <>
      <PageHeader title={t('page.title')} context={t('page.subtitle')} />
      {truncated && <p role="status" className="text-xs text-warning">{t('page.truncated', { count: DEAL_LIMIT })}</p>}

      <div role="tablist" aria-label={t('page.title')} className="flex flex-wrap gap-2">
        {TABS.map((k) => (
          <Button key={k} role="tab" aria-selected={tab === k} selected={tab === k} variant="secondary" size="sm" onClick={() => setTab(k)}>{t(`tabs.${k}`)}</Button>
        ))}
      </div>

      {tab === 'pipeline' && (
        stages.length === 0 ? (
          <EmptyState title={t('pipeline.noStagesTitle')} description={canManage ? t('pipeline.noStagesBody') : t('pipeline.noStagesNoPermission')}
            action={canManage ? { label: t('pipeline.createStages'), onClick: onSeed } : undefined} />
        ) : (
          <div className="space-y-6">
            <Card padding="md" interactive={false}>
              <form onSubmit={onAddDeal} noValidate className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <h2 className="text-sm font-semibold text-text-primary sm:col-span-2 lg:col-span-6">{t('pipeline.addDeal')}</h2>
                <div className="lg:col-span-2"><Input label={t('pipeline.title')} value={dealForm.title} maxLength={300} error={dealErrors.title}
                  onChange={(e) => setDealForm((f) => ({ ...f, title: e.target.value }))} /></div>
                <Input label={t('pipeline.amount')} inputMode="decimal" value={dealForm.amount} error={dealErrors.amount}
                  onChange={(e) => setDealForm((f) => ({ ...f, amount: e.target.value }))} />
                <Input label={t('pipeline.currency')} value={dealForm.currency} maxLength={3} error={dealErrors.currency}
                  onChange={(e) => setDealForm((f) => ({ ...f, currency: e.target.value }))} />
                <Select label={t('pipeline.stage')} value={dealForm.stage} error={dealErrors.stage} onChange={(e) => setDealForm((f) => ({ ...f, stage: e.target.value }))}>
                  {stages.map((s) => <option key={s.id} value={s.label}>{s.label}</option>)}
                </Select>
                <Input label={t('pipeline.closeDate')} type="date" value={dealForm.closeDate} onChange={(e) => setDealForm((f) => ({ ...f, closeDate: e.target.value }))} />
                <div className="sm:col-span-2 lg:col-span-6"><Button type="submit" loading={busy === 'add'}>{t('pipeline.add')}</Button></div>
              </form>
            </Card>

            {openDeals.length === 0 ? (
              <EmptyState compact title={t('pipeline.noDeals')} />
            ) : (
              <>
                {[...stages].sort((a, b) => a.position - b.position).map((s) => {
                  const list = grouped.byStage.get(s.id) ?? [];
                  if (list.length === 0) return null;
                  return (
                    <Card key={s.id} padding="sm" interactive={false}>
                      <h2 className="px-3 pt-2 text-sm font-semibold text-text-primary">{s.label} <span className="font-normal text-text-secondary">· {s.win_probability_pct}% · {t(`category.${s.forecast_category}`)}</span></h2>
                      {dealRows(list)}
                    </Card>
                  );
                })}
                {grouped.other.length > 0 && (
                  <Card padding="sm" interactive={false}>
                    <h2 className="px-3 pt-2 text-sm font-semibold text-text-primary">{t('pipeline.otherStages')}</h2>
                    {dealRows(grouped.other)}
                  </Card>
                )}
              </>
            )}
          </div>
        )
      )}

      {tab === 'forecast' && (
        forecast.currency === null && openDeals.length > 0 ? (
          <EmptyState compact title={t('forecast.noCurrency')} />
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-text-secondary">{t('forecast.currencyLabel', { currency: forecast.currency ?? '—' })} · {t('forecast.note')}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {([
                ['forecast.weighted', forecast.open],
                ['forecast.commit', forecast.byCategory.commit],
                ['forecast.bestCase', forecast.byCategory.best_case],
                ['forecast.pipeline', forecast.byCategory.pipeline],
              ] as const).map(([k, v]) => (
                <Card key={k} padding="md" interactive={false}>
                  <h3 className="text-sm text-text-secondary">{t(k)}</h3>
                  <p className="mt-1 text-2xl font-semibold text-text-primary">{money(v.weightedCents, forecast.currency)}</p>
                  <p className="mt-1 text-xs text-text-secondary">{t('forecast.unweighted', { amount: money(v.amountCents, forecast.currency), count: v.count })}</p>
                </Card>
              ))}
            </div>
            <Card padding="sm" interactive={false}>
              <h2 className="px-3 pt-2 text-sm font-semibold text-text-primary">{t('forecast.byMonth')}</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead><tr>
                    <th scope="col" className={th}>{t('forecast.month')}</th><th scope="col" className={th}>{t('forecast.commit')}</th>
                    <th scope="col" className={th}>{t('forecast.bestCase')}</th><th scope="col" className={th}>{t('forecast.pipeline')}</th>
                    <th scope="col" className={th}>{t('forecast.weighted')}</th>
                  </tr></thead>
                  <tbody>
                    {forecast.byMonth.map((m) => (
                      <tr key={m.month} className="border-t border-border">
                        <td className={td}>{m.month}</td>
                        <td className={td}>{money(m.commit, forecast.currency)}</td><td className={td}>{money(m.best_case, forecast.currency)}</td>
                        <td className={td}>{money(m.pipeline, forecast.currency)}</td><td className={td}>{money(m.weightedCents, forecast.currency)}</td>
                      </tr>
                    ))}
                    {([['forecast.overdue', forecast.overdue], ['forecast.noCloseDate', forecast.noCloseDate], ['forecast.later', forecast.later]] as const).map(([k, v]) => (
                      <tr key={k} className="border-t border-border">
                        <td className={td}>{t(k)}</td><td className={td} colSpan={3}>{t('forecast.deals', { count: v.count })}</td><td className={td}>{money(v.weightedCents, forecast.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            {Object.values(forecast.excluded).some((n) => n > 0) && (
              <div role="status" className="space-y-1 text-xs text-warning">
                <p className="font-medium">{t('forecast.excludedTitle')}</p>
                {forecast.excluded.unmappedStage > 0 && <p>{t('forecast.excludedUnmapped', { count: forecast.excluded.unmappedStage })}</p>}
                {forecast.excluded.omittedStage > 0 && <p>{t('forecast.excludedOmitted', { count: forecast.excluded.omittedStage })}</p>}
                {forecast.excluded.noAmount > 0 && <p>{t('forecast.excludedNoAmount', { count: forecast.excluded.noAmount })}</p>}
                {forecast.excluded.otherCurrency > 0 && <p>{t('forecast.excludedOtherCurrency', { count: forecast.excluded.otherCurrency })}</p>}
              </div>
            )}
          </div>
        )
      )}

      {tab === 'dealDesk' && (
        <div className="space-y-6">
          {!settings.enabled && <EmptyState compact title={t('desk.disabledTitle')} description={t('desk.disabledBody')} />}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {([
              ['desk.metrics.pending', String(metrics.pending)],
              ['desk.metrics.oldest', metrics.oldestPendingBusinessDays === null ? t('desk.metrics.none') : t('desk.metrics.days', { value: metrics.oldestPendingBusinessDays.toFixed(1) })],
              ['desk.metrics.p50', metrics.decisionP50BusinessDays === null ? t('desk.metrics.none') : t('desk.metrics.days', { value: metrics.decisionP50BusinessDays.toFixed(1) })],
              ['desk.metrics.p90', metrics.decisionP90BusinessDays === null ? t('desk.metrics.none') : t('desk.metrics.days', { value: metrics.decisionP90BusinessDays.toFixed(1) })],
              ['desk.metrics.auto', String(metrics.autoApproved)],
            ] as const).map(([k, v]) => (
              <Card key={k} padding="md" interactive={false}>
                <h3 className="text-sm text-text-secondary">{t(k)}</h3>
                <p className="mt-1 text-xl font-semibold text-text-primary">{v}</p>
              </Card>
            ))}
          </div>
          <p className="text-xs text-text-secondary">{t('desk.metrics.note')}</p>

          {settings.enabled && (
            <Card padding="md" interactive={false}>
              <form onSubmit={onSubmitRequest} noValidate className="grid gap-3 sm:grid-cols-3">
                <h2 className="text-sm font-semibold text-text-primary sm:col-span-3">{t('desk.request.title')}</h2>
                <Select label={t('desk.request.deal')} value={reqForm.dealId} error={reqErrors.deal} onChange={(e) => setReqForm((f) => ({ ...f, dealId: e.target.value }))}>
                  <option value="">{t('desk.request.pickDeal')}</option>
                  {openDeals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                </Select>
                <Input label={t('desk.request.pct')} inputMode="decimal" value={reqForm.pct} error={reqErrors.pct}
                  helperText={pendingLevel ? t('desk.request.levelPreview', { level: pendingLevel }) : undefined}
                  onChange={(e) => setReqForm((f) => ({ ...f, pct: e.target.value }))} />
                <div className="sm:col-span-3"><Textarea label={t('desk.request.reason')} helperText={t('desk.request.reasonHelp')} rows={3} maxLength={LIMITS.reasonMax}
                  value={reqForm.reason} error={reqErrors.reason} onChange={(e) => setReqForm((f) => ({ ...f, reason: e.target.value }))} /></div>
                <div className="sm:col-span-3"><Button type="submit" loading={busy === 'request'}>{t('desk.request.submit')}</Button></div>
              </form>
            </Card>
          )}

          <Card padding="sm" interactive={false}>
            <h2 className="px-3 pt-2 text-sm font-semibold text-text-primary">{t('desk.queue.title')}</h2>
            {requests.length === 0 ? <EmptyState compact title={t('desk.queue.empty')} /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead><tr>
                    {(['deal', 'discount', 'needs', 'status', 'reason', 'requested', 'decision'] as const).map((c) => <th key={c} scope="col" className={th}>{t(`desk.queue.columns.${c}`)}</th>)}
                  </tr></thead>
                  <tbody>
                    {requests.map((r) => {
                      const mayDecide = canDecide(r, decider);
                      const mayWithdraw = canWithdraw(r, decider);
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className={td}>{dealTitle.get(r.deal_id) ?? t('desk.queue.unknownDeal')}</td>
                          <td className={td}>{r.requested_pct}%</td>
                          <td className={td}>{levelLabel(r.required_level)}</td>
                          <td className={td}>{t(`desk.status.${r.status}`)}</td>
                          <td className={`${td} max-w-xs`}><span title={r.reason} className="line-clamp-2">{r.reason}</span></td>
                          <td className={td}>{fmtDay(r.created_at)}{r.requested_by && r.requested_by === user?.id ? ` · ${t('desk.queue.you')}` : ''}</td>
                          <td className={td}>
                            {r.status === 'pending' ? (
                              <div className="space-y-2">
                                {mayDecide && (
                                  <Input label={t('desk.queue.note')} helperText={t('desk.queue.noteHelp')} maxLength={LIMITS.noteMax} value={notes[r.id] ?? ''}
                                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                                )}
                                <div className="flex flex-wrap gap-2">
                                  {mayDecide && <Button size="xs" disabled={busy !== null} onClick={() => void run(`ok:${r.id}`, () => decideRequest(r.id, 'approved', notes[r.id] ?? ''), 'desk.queue.approved')}>{t('desk.queue.approve')}</Button>}
                                  {mayDecide && <Button size="xs" variant="danger" disabled={busy !== null || !(notes[r.id] ?? '').trim()} onClick={() => void run(`no:${r.id}`, () => decideRequest(r.id, 'rejected', notes[r.id] ?? ''), 'desk.queue.rejected')}>{t('desk.queue.reject')}</Button>}
                                  {mayWithdraw && <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void run(`wd:${r.id}`, () => withdrawRequest(r.id), 'desk.queue.withdrawn')}>{t('desk.queue.withdraw')}</Button>}
                                </div>
                              </div>
                            ) : (r.decision_note ?? '—')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {requests.length >= REQUEST_LIMIT && <p className="px-3 py-2 text-xs text-text-secondary">{t('desk.queue.truncated', { count: REQUEST_LIMIT })}</p>}
          </Card>
        </div>
      )}

      {tab === 'setup' && (
        <div className="space-y-6">
          <Card padding="md" interactive={false}>
            <h2 className="text-sm font-semibold text-text-primary">{t('setup.stagesTitle')}</h2>
            <p className="mt-1 text-xs text-text-secondary">{t('setup.stagesHelp')}</p>
            {!canManage && <p className="mt-2 text-xs text-warning">{t('setup.noPermission')}</p>}
            {stages.length === 0 ? <p className="mt-3 text-sm text-text-secondary">{t('setup.noStages')}</p> : (
              <div className="mt-4 space-y-4">
                {stages.map((s) => {
                  const d = stageDrafts[s.id] ?? draftOf(s);
                  const set = (patch: Partial<StageDraft>) => setStageDrafts((all) => ({ ...all, [s.id]: { ...d, ...patch } }));
                  return (
                    <div key={s.id} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-5">
                      <Input label={t('setup.label')} value={d.label} maxLength={LIMITS.stageLabelMax} disabled={!canManage} onChange={(e) => set({ label: e.target.value })} />
                      <Input label={t('setup.probability')} inputMode="decimal" value={d.probability} disabled={!canManage} onChange={(e) => set({ probability: e.target.value })} />
                      <Select label={t('setup.category')} value={d.category} disabled={!canManage} onChange={(e) => set({ category: e.target.value as ForecastCategory })}>
                        {FORECAST_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
                      </Select>
                      <Input label={t('setup.matchNames')} value={d.match} disabled={!canManage} onChange={(e) => set({ match: e.target.value })} />
                      <div className="flex items-end"><Button size="sm" disabled={!canManage || busy !== null} loading={busy === `stage:${s.id}`} onClick={() => onSaveStage(s)}>{t('setup.save')}</Button></div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card padding="md" interactive={false}>
            <h2 className="text-sm font-semibold text-text-primary">{t('setup.deskTitle')}</h2>
            <p className="mt-1 text-xs text-text-secondary">{t('setup.deskHelp')}</p>
            {!isOwner && <p className="mt-2 text-xs text-warning">{t('setup.ownerOnly')}</p>}
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Checkbox label={t('setup.deskEnabled')} checked={deskDraft.enabled} disabled={!isOwner} onChange={(e) => setDeskDraft((d) => ({ ...d, enabled: e.target.checked }))} />
              <Input label={t('setup.autoMax')} inputMode="decimal" value={deskDraft.auto} disabled={!isOwner} onChange={(e) => setDeskDraft((d) => ({ ...d, auto: e.target.value }))} />
              <Input label={t('setup.managerMax')} inputMode="decimal" value={deskDraft.manager} disabled={!isOwner} error={deskError} onChange={(e) => setDeskDraft((d) => ({ ...d, manager: e.target.value }))} />
            </div>
            <div className="mt-4"><Button disabled={!isOwner || busy !== null} loading={busy === 'desk'} onClick={onSaveDesk}>{t('setup.saveDesk')}</Button></div>
          </Card>
        </div>
      )}
    </>,
  );
}
