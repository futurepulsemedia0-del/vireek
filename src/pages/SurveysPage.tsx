// /dashboard/surveys — post-job NPS/CSAT: builder, auto-send, trend analytics, low-score service recovery.
// Schema: supabase/migrations/20270410000000_post_job_surveys.sql · Sender: supabase/functions/survey-dispatcher
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClipboardList,
  Lock,
  Loader2,
  MessageSquareHeart,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Button } from '@/components/ui/Button';
import { RecoveryCasesPanel } from '@/components/surveys/RecoveryCasesPanel';
import { SendSurveyDialog } from '@/components/surveys/SendSurveyDialog';
import { SurveyTemplateEditor } from '@/components/surveys/SurveyTemplateEditor';
import { SurveyTrendChart } from '@/components/surveys/SurveyTrendChart';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  CHANNEL_LABELS,
  INVITATION_STATUS_LABELS,
  SURVEY_TYPE_LABELS,
  TREND_RANGES,
  buildTrend,
  csatTone,
  describeSurveyError,
  npsTone,
  scoreByTechnician,
  summarize,
  type CaseStatus,
  type RecoveryCase,
  type SurveyInvitation,
  type SurveyTemplate,
  type SurveyTemplateInput,
  type SurveyType,
  type TrendRangeKey,
} from '@/lib/surveys';
import {
  INVITATION_FETCH_LIMIT,
  createTemplate,
  deleteTemplate,
  fetchCases,
  fetchInvitations,
  fetchTechnicianNames,
  fetchTemplates,
  updateCase,
  updateTemplate,
} from '@/lib/surveysApi';

type Tab = 'overview' | 'recovery' | 'surveys' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'recovery', label: 'Service recovery' },
  { key: 'surveys', label: 'Surveys' },
  { key: 'activity', label: 'Activity' },
];

const toneClass = { good: 'text-success-500', ok: 'text-warning-500', bad: 'text-danger', none: 'text-text-secondary' } as const;
const DAY = 86_400_000;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Delta({ current, previous, suffix = '' }: { current: number | null; previous: number | null; suffix?: string }) {
  if (current === null || previous === null) return <span className="text-xs text-text-secondary">No prior period to compare</span>;
  const d = Math.round((current - previous) * 10) / 10;
  if (d === 0) return <span className="text-xs text-text-secondary">No change vs prior period</span>;
  const up = d > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${up ? 'text-success-500' : 'text-danger'}`}>
      <Icon size={13} aria-hidden="true" />
      {up ? '+' : ''}
      {d}
      {suffix} vs prior period
    </span>
  );
}

function Kpi({ label, value, tone = 'none', children }: { label: string; value: string; tone?: keyof typeof toneClass; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-3xl font-bold tabular-nums ${toneClass[tone]}`}>{value}</p>
      <div className="mt-2 min-h-[18px]">{children}</div>
    </div>
  );
}

export function SurveysPage() {
  const { isOwner, permissions, profile, teamMember } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  // Same bar as the database (identity_is_manager): owner/admin or "View Billing".
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = TABS.some((t) => t.key === tabParam) ? (tabParam as Tab) : 'overview';
  const setTab = (t: Tab) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });

  const [range, setRange] = useState<TrendRangeKey>('30d');
  const [chartType, setChartType] = useState<SurveyType | null>(null);
  const days = TREND_RANGES.find((r) => r.key === range)!.days;

  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [invitations, setInvitations] = useState<SurveyInvitation[]>([]);
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [techNames, setTechNames] = useState<Record<string, string>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SurveyTemplate | null>(null);
  const [newType, setNewType] = useState<SurveyType>('nps');
  const [saving, setSaving] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendPreset, setSendPreset] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SurveyTemplate | null>(null);

  const loadId = useRef(0);
  const load = useCallback(
    async (silent = false) => {
      if (!ownerId || !canAccess) return;
      const id = ++loadId.current;
      if (silent) setRefreshing(true);
      else setState('loading');
      try {
        // Two periods so every KPI can show change vs the previous period.
        const since = new Date(Date.now() - days * 2 * DAY).toISOString();
        const [t, inv, c, names] = await Promise.all([
          fetchTemplates(ownerId),
          fetchInvitations(ownerId, since),
          fetchCases(ownerId),
          fetchTechnicianNames(ownerId).catch(() => ({}) as Record<string, string>),
        ]);
        if (id !== loadId.current) return; // a newer load superseded this one
        setTemplates(t);
        setInvitations(inv);
        setCases(c);
        setTechNames(names);
        setState('ready');
      } catch {
        if (id !== loadId.current) return;
        if (silent) toast('Could not refresh surveys.', 'error');
        else setState('error');
      } finally {
        if (id === loadId.current) setRefreshing(false);
      }
    },
    [ownerId, canAccess, days, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: a customer answering (invitation UPDATE) or a new recovery case refreshes quietly.
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const scheduleRefresh = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(true), 600);
  }, [load]);
  useEffect(() => () => clearTimeout(debounce.current), []);

  const rtEnabled = !!ownerId && canAccess;
  const liveInv = useRealtimeSubscription({
    channelName: `survey-invitations-${ownerId ?? 'anon'}`,
    table: 'survey_invitations',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    onChange: scheduleRefresh,
    enabled: rtEnabled,
  });
  useRealtimeSubscription({
    channelName: `survey-cases-${ownerId ?? 'anon'}`,
    table: 'survey_recovery_cases',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    onChange: scheduleRefresh,
    enabled: rtEnabled,
  });

  // ---- derived analytics ----
  const { current, previous } = useMemo(() => {
    const cutoff = Date.now() - days * DAY;
    const cur: SurveyInvitation[] = [];
    const prev: SurveyInvitation[] = [];
    for (const i of invitations) (Date.parse(i.created_at) >= cutoff ? cur : prev).push(i);
    return { current: cur, previous: prev };
  }, [invitations, days]);
  const sum = useMemo(() => summarize(current), [current]);
  const prevSum = useMemo(() => summarize(previous), [previous]);

  const effectiveType: SurveyType = chartType ?? (sum.csat.responses > sum.nps.responses ? 'csat' : 'nps');
  const trend = useMemo(() => buildTrend(current, effectiveType, days), [current, effectiveType, days]);
  const techScores = useMemo(() => scoreByTechnician(current, effectiveType, techNames), [current, effectiveType, techNames]);
  const recentComments = useMemo(
    () =>
      current
        .filter((i) => i.status === 'responded' && i.comment)
        .sort((a, b) => Date.parse(b.responded_at ?? '') - Date.parse(a.responded_at ?? ''))
        .slice(0, 6),
    [current],
  );
  const openCases = cases.filter((c) => c.status === 'open' || c.status === 'contacted');
  const criticalOpen = openCases.filter((c) => c.severity === 'critical').length;
  const hitCap = invitations.length >= INVITATION_FETCH_LIMIT;

  const perTemplate = useMemo(() => {
    const m = new Map<string, { sent: number; responded: number }>();
    for (const i of current) {
      if (!i.template_id) continue;
      const r = m.get(i.template_id) ?? { sent: 0, responded: 0 };
      if (i.status === 'sent' || i.status === 'responded') r.sent++;
      if (i.status === 'responded') r.responded++;
      m.set(i.template_id, r);
    }
    return m;
  }, [current]);

  // ---- actions ----
  const openEditor = (t: SurveyTemplate | null, type: SurveyType = 'nps') => {
    setEditing(t);
    setNewType(type);
    setEditorOpen(true);
  };

  const saveTemplate = async (input: SurveyTemplateInput) => {
    if (!ownerId) return;
    setSaving(true);
    try {
      if (editing) await updateTemplate(ownerId, editing.id, input);
      else await createTemplate(ownerId, input);
      toast(editing ? 'Survey updated.' : 'Survey created.', 'success');
      setEditorOpen(false);
      await load(true);
    } catch (e) {
      toast(describeSurveyError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (t: SurveyTemplate, patch: Partial<Pick<SurveyTemplateInput, 'auto_send' | 'is_active'>>) => {
    if (!ownerId) return;
    try {
      await updateTemplate(ownerId, t.id, patch);
      await load(true);
    } catch (e) {
      toast(describeSurveyError(e), 'error');
    }
  };

  const confirmDelete = async () => {
    if (!ownerId || !deleting) return;
    try {
      await deleteTemplate(ownerId, deleting.id);
      toast('Survey deleted. Collected responses were kept.', 'success');
      setDeleting(null);
      await load(true);
    } catch (e) {
      toast(describeSurveyError(e), 'error');
    }
  };

  const changeCase = async (id: string, status: CaseStatus, note?: string): Promise<boolean> => {
    if (!ownerId) return false;
    try {
      const updated = await updateCase(ownerId, id, { status, ...(note !== undefined ? { resolution_note: note } : {}) });
      setCases((prev) => prev.map((c) => (c.id === id ? updated : c)));
      toast(status === 'resolved' ? 'Case resolved.' : status === 'open' ? 'Case reopened.' : 'Case updated.', 'success');
      return true;
    } catch (e) {
      toast(describeSurveyError(e), 'error');
      return false;
    }
  };

  // ---- permission gate ----
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Surveys">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Customer surveys contain feedback and contact details. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Surveys">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-text-primary">Customer surveys</h1>
            <LiveIndicator status={liveInv} />
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Ask every customer how the job went, track NPS &amp; CSAT, and fix unhappy experiences before they become reviews.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing || state === 'loading'} aria-label="Refresh data">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { setSendPreset(null); setSendOpen(true); }} disabled={state !== 'ready'}>
            <Send size={15} aria-hidden="true" /> Send now
          </Button>
          <Button size="sm" onClick={() => openEditor(null)} disabled={state !== 'ready'}>
            <Plus size={15} aria-hidden="true" /> New survey
          </Button>
        </div>
      </div>

      <div className="mb-6 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label="Surveys sections" className="inline-flex min-w-full gap-1 rounded-2xl border border-border bg-bg-secondary p-1 sm:min-w-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`surveys-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`surveys-panel-${t.key}`}
              onClick={() => setTab(t.key)}
              className={`focus-ring relative min-h-[40px] flex-1 whitespace-nowrap rounded-xl px-4 text-sm font-medium transition-colors sm:flex-none ${
                tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
              {t.key === 'recovery' && openCases.length > 0 && (
                <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${tab === t.key ? 'bg-white/25 text-white' : 'bg-danger text-white'}`}>{openCases.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {state === 'loading' && <SkeletonCardList count={3} rows={2} />}

      {state === 'error' && (
        <EmptyStateError icon={ClipboardList} title="Couldn't load surveys" description="Check your connection and try again." onRetry={() => void load()} />
      )}

      {state === 'ready' && (
        <div role="tabpanel" id={`surveys-panel-${tab}`} aria-labelledby={`surveys-tab-${tab}`}>
          {/* ---------------- OVERVIEW ---------------- */}
          {tab === 'overview' &&
            (templates.length === 0 ? (
              <EmptyState
                icon={MessageSquareHeart}
                title="Start measuring customer happiness"
                description="Create a post-job survey in under a minute. Enable auto-send and every completed job gets a 10-second NPS or CSAT request by SMS and email."
                action={{ label: 'Create NPS survey', onClick: () => openEditor(null, 'nps') }}
                secondaryAction={{ label: 'Create CSAT survey', onClick: () => openEditor(null, 'csat') }}
              />
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-xl border border-border bg-bg-secondary p-1">
                    {TREND_RANGES.map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        role="radio"
                        aria-checked={range === r.key}
                        onClick={() => setRange(r.key)}
                        className={`focus-ring min-h-[36px] rounded-lg px-3 text-sm font-medium transition-colors ${range === r.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  {hitCap && <p className="text-xs text-warning-500">Showing the most recent {INVITATION_FETCH_LIMIT.toLocaleString()} surveys.</p>}
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Kpi label="Net Promoter Score" value={sum.nps.nps === null ? '—' : String(sum.nps.nps)} tone={npsTone(sum.nps.nps)}>
                    {sum.nps.responses === 0 ? (
                      <span className="text-xs text-text-secondary">No NPS responses yet</span>
                    ) : (
                      <Delta current={sum.nps.nps} previous={prevSum.nps.nps} />
                    )}
                  </Kpi>
                  <Kpi label="Customer satisfaction" value={sum.csat.csat === null ? '—' : `${sum.csat.csat}%`} tone={csatTone(sum.csat.csat)}>
                    {sum.csat.responses === 0 ? (
                      <span className="text-xs text-text-secondary">No CSAT responses yet</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-xs text-text-secondary">Average {sum.csat.average}/5 · {sum.csat.responses} responses</span>
                        <Delta current={sum.csat.csat} previous={prevSum.csat.csat} suffix=" pts" />
                      </span>
                    )}
                  </Kpi>
                  <Kpi label="Response rate" value={sum.responseRate === null ? '—' : `${sum.responseRate}%`}>
                    <span className="text-xs text-text-secondary">{sum.responded} of {sum.sent} delivered surveys answered</span>
                  </Kpi>
                  <button type="button" onClick={() => setTab('recovery')} className="focus-ring rounded-2xl text-left">
                    <Kpi label="Open recovery cases" value={String(openCases.length)} tone={criticalOpen > 0 ? 'bad' : openCases.length > 0 ? 'ok' : 'good'}>
                      <span className="text-xs text-text-secondary">{criticalOpen > 0 ? `${criticalOpen} critical — act now` : openCases.length > 0 ? 'Review unhappy customers' : 'All clear'}</span>
                    </Kpi>
                  </button>
                </div>

                <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Score trend">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-text-primary">Score trend</h2>
                    <div role="radiogroup" aria-label="Survey type" className="inline-flex rounded-xl border border-border bg-bg-primary p-1">
                      {(['nps', 'csat'] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          role="radio"
                          aria-checked={effectiveType === t}
                          onClick={() => setChartType(t)}
                          className={`focus-ring min-h-[36px] rounded-lg px-3 text-sm font-medium transition-colors ${effectiveType === t ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                        >
                          {SURVEY_TYPE_LABELS[t]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <SurveyTrendChart points={trend} type={effectiveType} />
                  {effectiveType === 'nps' && sum.nps.responses > 0 && (
                    <div className="mt-4">
                      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${sum.nps.promoters} promoters, ${sum.nps.passives} passives, ${sum.nps.detractors} detractors`}>
                        <div className="bg-success-500" style={{ width: `${(sum.nps.promoters / sum.nps.responses) * 100}%` }} />
                        <div className="bg-text-secondary/40" style={{ width: `${(sum.nps.passives / sum.nps.responses) * 100}%` }} />
                        <div className="bg-danger" style={{ width: `${(sum.nps.detractors / sum.nps.responses) * 100}%` }} />
                      </div>
                      <p className="mt-2 text-xs text-text-secondary">
                        {sum.nps.promoters} promoters · {sum.nps.passives} passives · {sum.nps.detractors} detractors
                      </p>
                    </div>
                  )}
                </section>

                <div className="grid gap-6 lg:grid-cols-2">
                  <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Scores by technician">
                    <h2 className="mb-3 text-base font-semibold text-text-primary">By technician ({SURVEY_TYPE_LABELS[effectiveType]})</h2>
                    {techScores.length === 0 ? (
                      <p className="text-sm text-text-secondary">Technician scores appear once customers respond.</p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {techScores.map((g) => (
                          <li key={g.key} className="flex items-center justify-between gap-3 py-2.5">
                            <span className="min-w-0 truncate text-sm text-text-primary">{g.label}</span>
                            <span className="shrink-0 text-sm text-text-secondary">
                              <strong className={`tabular-nums ${toneClass[effectiveType === 'nps' ? npsTone(g.value) : csatTone(g.value)]}`}>
                                {g.value === null ? '—' : effectiveType === 'csat' ? `${g.value}%` : g.value}
                              </strong>{' '}
                              · {g.responses} resp.
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Recent comments">
                    <h2 className="mb-3 text-base font-semibold text-text-primary">What customers are saying</h2>
                    {recentComments.length === 0 ? (
                      <p className="text-sm text-text-secondary">Written comments will show up here.</p>
                    ) : (
                      <ul className="space-y-3">
                        {recentComments.map((i) => (
                          <li key={i.id} className="rounded-xl bg-bg-tertiary px-4 py-3">
                            <p className="text-sm text-text-primary">“{i.comment}”</p>
                            <p className="mt-1 text-xs text-text-secondary">
                              {i.customer_name} · {SURVEY_TYPE_LABELS[i.survey_type]} {i.score}/{i.survey_type === 'nps' ? 10 : 5} · {formatDate(i.responded_at)}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </div>
            ))}

          {/* ---------------- RECOVERY ---------------- */}
          {tab === 'recovery' && <RecoveryCasesPanel cases={cases} canEdit onUpdate={changeCase} />}

          {/* ---------------- SURVEYS (builder list) ---------------- */}
          {tab === 'surveys' &&
            (templates.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No surveys yet"
                description="Build an NPS or CSAT survey, choose SMS and/or email, and turn on auto-send."
                action={{ label: 'Create NPS survey', onClick: () => openEditor(null, 'nps') }}
                secondaryAction={{ label: 'Create CSAT survey', onClick: () => openEditor(null, 'csat') }}
              />
            ) : (
              <ul className="space-y-4">
                {templates.map((t) => {
                  const stats = perTemplate.get(t.id);
                  return (
                    <li key={t.id} className="rounded-2xl border border-border bg-bg-secondary p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-base font-semibold text-text-primary">{t.name}</h3>
                            <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">{SURVEY_TYPE_LABELS[t.survey_type]}</span>
                            <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">{CHANNEL_LABELS[t.channel]}</span>
                            {!t.is_active && <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">Inactive</span>}
                          </div>
                          <p className="mt-1.5 text-sm text-text-secondary">{t.question}</p>
                          <p className="mt-2 text-xs text-text-secondary">
                            {t.auto_send ? `Auto-sends ${t.send_delay_minutes === 0 ? 'immediately' : `${t.send_delay_minutes >= 1440 ? `${Math.round(t.send_delay_minutes / 1440)}d` : t.send_delay_minutes >= 60 ? `${Math.round(t.send_delay_minutes / 60)}h` : `${t.send_delay_minutes}m`} after`} completion` : 'Manual sends only'} · recovery case at score ≤ {t.low_score_threshold}
                            {stats ? ` · ${stats.responded}/${stats.sent} answered (${days}d)` : ''}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="secondary" onClick={() => { setSendPreset(t.id); setSendOpen(true); }} disabled={!t.is_active}>
                            <Send size={15} aria-hidden="true" /> Send
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => openEditor(t)} aria-label={`Edit ${t.name}`}>
                            <Pencil size={15} aria-hidden="true" /> Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}>
                            <Trash2 size={15} aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-sm">
                        <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-2 text-text-primary">
                          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={t.auto_send} onChange={(e) => void toggle(t, { auto_send: e.target.checked })} />
                          Auto-send after completed jobs
                        </label>
                        <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-2 text-text-primary">
                          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={t.is_active} onChange={(e) => void toggle(t, { is_active: e.target.checked })} />
                          Active
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ))}

          {/* ---------------- ACTIVITY ---------------- */}
          {tab === 'activity' &&
            (current.length === 0 ? (
              <EmptyState icon={ClipboardList} title="No surveys sent in this period" description="Sent surveys, delivery problems and responses will be listed here." />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                {current.slice(0, 100).map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{i.customer_name}</p>
                      <p className="text-xs text-text-secondary">
                        {i.template_name} · {formatDate(i.sent_at ?? i.created_at)}
                        {i.channel_used ? ` · ${i.channel_used.replace('+', ' + ')}` : ''}
                        {i.trigger_source === 'manual' ? ' · manual' : ''}
                      </p>
                      {(i.status === 'failed' || i.status === 'skipped') && i.delivery_error && (
                        <p className="mt-0.5 text-xs text-danger">{i.delivery_error}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      {i.score !== null && (
                        <strong className={`tabular-nums ${i.score <= i.low_score_threshold ? 'text-danger' : 'text-text-primary'}`}>
                          {i.score}/{i.survey_type === 'nps' ? 10 : 5}
                        </strong>
                      )}
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          i.status === 'responded' ? 'bg-success-500/10 text-success-500' : i.status === 'failed' ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'
                        }`}
                      >
                        {INVITATION_STATUS_LABELS[i.status]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}

      {refreshing && state === 'ready' && (
        <span className="sr-only" role="status">
          <Loader2 aria-hidden="true" /> Refreshing
        </span>
      )}

      <SurveyTemplateEditor
        open={editorOpen}
        template={editing}
        initialType={newType}
        saving={saving}
        onSave={saveTemplate}
        onClose={() => setEditorOpen(false)}
      />

      {ownerId && (
        <SendSurveyDialog
          open={sendOpen}
          ownerId={ownerId}
          templates={templates}
          presetTemplateId={sendPreset}
          onClose={() => setSendOpen(false)}
          onSent={(m) => {
            toast(m, 'success');
            void load(true);
          }}
          onError={(m) => toast(m, 'error')}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this survey?"
        description="The survey stops sending. Responses already collected are kept for your reports."
        confirmLabel="Delete survey"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
