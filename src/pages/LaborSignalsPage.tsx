import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Lock, RefreshCw, Scale, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { getJurisdictionRule, normalizeJurisdictionCode } from '@/lib/breakRules';
import { LABOR_SIGNALS_NS } from '@/lib/laborSignals/i18n';
import {
  fetchLaborOverview,
  laborErrorKey,
  recordLaborRuleReview,
  reviewLaborSignal,
  saveLaborRuleConfig,
  setWorkerClassification,
} from '@/lib/laborSignals/api';
import {
  WORKER_CLASSIFICATIONS,
  evaluateLaborSignals,
  filterSignals,
  summarizeSignals,
  type LaborSignal,
  type SignalTopic,
  type WorkerClassification,
} from '@/lib/laborSignals/evaluate';
import { RANGES, windowFor, type LaborOverview, type RangeDays } from '@/lib/laborSignals/overview';
import {
  OVERTIME_PACKS,
  PW_PACKS,
  CUSTOM_RULE,
  getOvertimePack,
  getPwPack,
  openMarkers,
  validateOvertimeParams,
  validatePwParams,
  type OvertimeParams,
  type PrevailingWageParams,
  type RuleConfigRecord,
  type RuleTopic,
} from '@/lib/laborSignals/rules';

// ============================================================
// SHARED BITS
// ============================================================

type TabKey = 'signals' | 'workers' | 'rules';
type ToastFn = (message: string, type?: 'success' | 'error' | 'info') => void;
type Translate = (key: string, opts?: Record<string, unknown>) => string;

const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';
const TOPICS: SignalTopic[] = ['overtime', 'classification', 'prevailing_wage', 'breaks'];

function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'warn' | 'good' | 'bad' }) {
  const cls = { neutral: 'bg-bg-tertiary text-text-secondary', warn: 'bg-warning/10 text-warning', good: 'bg-success/10 text-success', bad: 'bg-danger/10 text-danger' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{text}</span>;
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className={panelClass}>
      <p className={`text-xl font-bold ${tone === 'warn' && value > 0 ? 'text-warning' : 'text-text-primary'}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

function Sheet({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-overlay/50" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-primary p-5 pb-8 shadow-xl sm:max-w-lg sm:rounded-2xl sm:pb-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fmtDay = (isoDate: string) => new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtMoney = (cents: number) => (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Turns a signal's numeric facts into the interpolation values the i18n strings expect. */
function signalValues(s: LaborSignal, classificationOf: (id: string) => string): Record<string, unknown> {
  const f = s.facts;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = typeof v === 'number' ? fmtNum(v) : v;
  if (typeof f.weekStart === 'string') out.weekStart = fmtDay(f.weekStart);
  if (typeof f.paidCents === 'number') out.paid = fmtMoney(f.paidCents);
  if (typeof f.tableCents === 'number') out.table = fmtMoney(f.tableCents);
  if (s.code === 'classification_with_clock_use') out.classificationLabel = classificationOf(s.employeeId);
  return out;
}

// ============================================================
// PAGE
// ============================================================

export function LaborSignalsPage() {
  const { t } = useTranslation(LABOR_SIGNALS_NS);
  const { profile, teamMember, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  let body: React.ReactNode;
  if (profileLoading || (!accountOwnerId && !profile)) {
    body = (
      <div className="space-y-4" aria-busy="true" aria-label={t('states.loadingLabel')}>
        <Skeleton className="h-10 w-64" />
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} />
      </div>
    );
  } else if (!accountOwnerId) {
    body = <EmptyState icon={Lock} title={t('states.noAccount')} description="" />;
  } else {
    body = <Signals accountOwnerId={accountOwnerId} toast={toast} />;
  }

  return (
    <DashboardLayout activeLabel="Labor Signals">
      <div className="mx-auto max-w-6xl px-0 py-2 sm:px-2">{body}</div>
    </DashboardLayout>
  );
}

// ============================================================
// DATA + TABS
// ============================================================

function Signals({ accountOwnerId, toast }: { accountOwnerId: string; toast: ToastFn }) {
  const { t } = useTranslation(LABOR_SIGNALS_NS);
  const tr = t as unknown as Translate;
  const [params, setParams] = useSearchParams();
  const tab: TabKey = params.get('tab') === 'workers' ? 'workers' : params.get('tab') === 'rules' ? 'rules' : 'signals';

  const [data, setData] = useState<LaborOverview | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'denied'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [days, setDays] = useState<RangeDays>(30);
  const [employeeId, setEmployeeId] = useState('all');
  const [topic, setTopic] = useState<SignalTopic | 'all'>('all');
  const [openOnly, setOpenOnly] = useState(true);
  const [reviewing, setReviewing] = useState<LaborSignal | null>(null);

  const toastRef = useRef(toast);
  toastRef.current = toast;
  const windowFromRef = useRef('');

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setPhase('loading');
      try {
        const ts = Date.now();
        const w = windowFor(days, ts);
        const o = await fetchLaborOverview(w.dataFrom, w.to);
        windowFromRef.current = w.windowFrom;
        setData(o);
        setNow(ts);
        setPhase('ready');
      } catch (e) {
        if (laborErrorKey(e) === 'permission') setPhase('denied');
        else if (quiet) toastRef.current(t(`errors.${laborErrorKey(e)}`), 'error');
        else setPhase('error');
      } finally {
        setRefreshing(false);
      }
    },
    // accountOwnerId is an explicit dependency so a switch of account reloads; the RPC itself scopes by auth.uid().
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountOwnerId, days],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const result = useMemo(() => {
    if (!data) return null;
    return evaluateLaborSignals({
      employees: data.employees,
      shifts: data.shifts,
      payroll: data.payroll,
      pwSegments: data.pwSegments,
      overtime: data.overtime?.enabled ? data.overtime.params : null,
      prevailingWage: data.prevailingWage?.enabled ? data.prevailingWage.params : null,
      breakSettings: data.breakSettings,
      breakReviews: data.breakReviews,
      reviews: data.reviews,
      now,
      windowFrom: windowFromRef.current || undefined,
    });
  }, [data, now]);

  const nameById = useMemo(() => new Map((data?.employees ?? []).map((e) => [e.id, e.name])), [data]);
  const classificationLabelOf = useCallback(
    (id: string) => {
      const e = data?.employees.find((x) => x.id === id);
      if (!e) return t('classifications.unreviewed');
      if (e.employment_type === '1099' && e.classification !== 'contractor_recorded') return t('classifications.payroll1099');
      return t(`classifications.${e.classification}`);
    },
    [data, t],
  );

  const summary = useMemo(() => summarizeSignals(result?.signals ?? []), [result]);
  const visible = useMemo(() => filterSignals(result?.signals ?? [], employeeId, topic, openOnly ? 'open' : 'all'), [result, employeeId, topic, openOnly]);

  const setTab = (k: TabKey) => setParams(k === 'signals' ? {} : { tab: k });

  if (phase === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={t('states.loadingLabel')}>
        <Skeleton className="h-10 w-64" />
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} />
      </div>
    );
  }
  if (phase === 'denied') return <EmptyState icon={Lock} title={t('states.noAccessTitle')} description={t('states.noAccessBody')} />;
  if (phase === 'error' || !data || !result) {
    return <EmptyStateError title={t('states.errorTitle')} description={t('states.errorBody')} onRetry={() => void load()} />;
  }

  const noRules = !data.overtime?.enabled && !data.prevailingWage?.enabled;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Scale size={22} aria-hidden="true" />
            {t('title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('subtitle')}</p>
        </div>
        <Button variant="secondary" size="md" onClick={() => void load(true)} loading={refreshing} loadingLabel={t('refreshing')}>
          <RefreshCw size={16} aria-hidden="true" />
          {t('refresh')}
        </Button>
      </header>

      {/* Always visible: the page never states a legal conclusion. */}
      <p role="note" className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-text-primary">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <span>{t('disclaimer.text')}</span>
      </p>

      <div role="tablist" aria-label={t('title')} className="flex gap-1 border-b border-border">
        {(['signals', 'workers', 'rules'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const order = ['signals', 'workers', 'rules'] as const;
              const rtl = document.documentElement.dir === 'rtl';
              const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
              const next = order[(order.indexOf(k) + step + order.length) % order.length];
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
            className={`focus-ring min-h-11 px-4 text-sm font-semibold ${tab === k ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'signals' && (
          <SignalsTab
            tr={tr}
            data={data}
            signals={visible}
            summary={summary}
            excluded={result.excludedEmployeeIds.length}
            noRules={noRules}
            days={days}
            setDays={setDays}
            employeeId={employeeId}
            setEmployeeId={setEmployeeId}
            topic={topic}
            setTopic={setTopic}
            openOnly={openOnly}
            setOpenOnly={setOpenOnly}
            nameOf={(id) => nameById.get(id) ?? '—'}
            classificationLabelOf={classificationLabelOf}
            onReview={setReviewing}
            goRules={() => setTab('rules')}
          />
        )}
        {tab === 'workers' && <WorkersTab tr={tr} data={data} excluded={result.excludedEmployeeIds.length} toast={toast} reload={() => load(true)} />}
        {tab === 'rules' && <RulesTab tr={tr} data={data} toast={toast} reload={() => load(true)} />}
      </div>

      {reviewing && (
        <ReviewSheet
          tr={tr}
          signal={reviewing}
          who={nameById.get(reviewing.employeeId) ?? '—'}
          onClose={() => setReviewing(null)}
          onSaved={() => {
            setReviewing(null);
            toast(t('review.saved'), 'success');
            void load(true);
          }}
          onError={(e) => toast(t(`errors.${laborErrorKey(e)}`), 'error')}
        />
      )}
    </div>
  );
}

// ============================================================
// SIGNALS TAB
// ============================================================

interface SignalsTabProps {
  tr: Translate;
  data: LaborOverview;
  signals: LaborSignal[];
  summary: ReturnType<typeof summarizeSignals>;
  excluded: number;
  noRules: boolean;
  days: RangeDays;
  setDays: (d: RangeDays) => void;
  employeeId: string;
  setEmployeeId: (v: string) => void;
  topic: SignalTopic | 'all';
  setTopic: (v: SignalTopic | 'all') => void;
  openOnly: boolean;
  setOpenOnly: (v: boolean) => void;
  nameOf: (id: string) => string;
  classificationLabelOf: (id: string) => string;
  onReview: (s: LaborSignal) => void;
  goRules: () => void;
}

function SignalsTab(p: SignalsTabProps) {
  const { tr } = p;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <StatCard label={tr('stats.open')} value={p.summary.open} tone="warn" />
        <StatCard label={tr('stats.reviewed')} value={p.summary.reviewed} />
        {TOPICS.map((k) => (
          <StatCard key={k} label={tr(`stats.${k}`)} value={p.summary.byTopic[k]} />
        ))}
      </div>

      {p.data.shiftsTruncated && <p role="status" className="rounded-xl bg-warning/10 p-3 text-sm text-text-primary">{tr('states.truncated')}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-sm font-medium text-text-primary">
          {tr('ranges.label')}
          <select className={`${selectClass} mt-1.5`} value={p.days} onChange={(e) => p.setDays(Number(e.target.value) as RangeDays)}>
            {RANGES.map((d) => (
              <option key={d} value={d}>
                {tr('ranges.option', { count: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-text-primary">
          {tr('filters.worker')}
          <select className={`${selectClass} mt-1.5`} value={p.employeeId} onChange={(e) => p.setEmployeeId(e.target.value)}>
            <option value="all">{tr('filters.allWorkers')}</option>
            {p.data.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-text-primary">
          {tr('filters.topic')}
          <select className={`${selectClass} mt-1.5`} value={p.topic} onChange={(e) => p.setTopic(e.target.value as SignalTopic | 'all')}>
            <option value="all">{tr('topics.all')}</option>
            {TOPICS.map((k) => (
              <option key={k} value={k}>
                {tr(`topics.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-text-primary">
          {tr('filters.view')}
          <select className={`${selectClass} mt-1.5`} value={p.openOnly ? 'open' : 'all'} onChange={(e) => p.setOpenOnly(e.target.value === 'open')}>
            <option value="open">{tr('filters.openOnly')}</option>
            <option value="all">{tr('filters.showAll')}</option>
          </select>
        </label>
      </div>

      {p.excluded > 0 && <p className="text-xs text-text-secondary">{tr('workers.excluded', { count: p.excluded })}</p>}

      {p.signals.length === 0 ? (
        p.noRules && p.summary.open === 0 ? (
          <EmptyState icon={Scale} title={tr('states.emptyNoRulesTitle')} description={tr('states.emptyNoRulesBody')} action={{ label: tr('tabs.rules'), onClick: p.goRules }} />
        ) : (
          <EmptyState icon={Scale} title={tr('states.emptyTitle')} description={tr('states.emptyBody')} />
        )
      ) : (
        <ul className="space-y-3">
          {p.signals.map((s) => (
            <li key={s.key} className={panelClass}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-text-primary">{tr(`signals.${s.code}.title`)}</h3>
                    <Pill text={tr(`status.${s.status}`)} tone={s.status === 'open' ? 'warn' : 'neutral'} />
                  </div>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {p.nameOf(s.employeeId)} · {tr('card.anchor', { date: fmtDay(s.anchorDate) })} · {tr(`topics.${s.topic}`)}
                  </p>
                  <p className="mt-2 text-sm text-text-primary">{tr(`signals.${s.code}.detail`, signalValues(s, p.classificationLabelOf))}</p>
                  {s.note && <p className="mt-1 text-xs text-text-secondary">{tr('card.reviewedBy', { note: s.note })}</p>}
                </div>
                {s.readOnly ? (
                  <Link to="/dashboard/break-compliance" className="focus-ring inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-accent hover:bg-bg-tertiary">
                    {tr('card.openBreaks')}
                  </Link>
                ) : (
                  <Button variant="secondary" size="md" onClick={() => p.onReview(s)}>
                    {tr('card.review')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// REVIEW SHEET
// ============================================================

function ReviewSheet({ tr, signal, who, onClose, onSaved, onError }: { tr: Translate; signal: LaborSignal; who: string; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [status, setStatus] = useState<'open' | 'acknowledged' | 'no_action_needed' | 'sent_to_counsel'>(signal.status === 'open' ? 'acknowledged' : signal.status);
  const [note, setNote] = useState(signal.note ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await reviewLaborSignal(signal.key, status, note);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={tr('review.title')} closeLabel={tr('close')} onClose={onClose}>
      <p className="text-sm text-text-secondary">
        {who} · {tr(`signals.${signal.code}.title`)}
      </p>
      <div className="mt-4 space-y-4">
        <label className="block text-sm font-medium text-text-primary">
          {tr('review.status')}
          <select className={`${selectClass} mt-1.5`} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {(['acknowledged', 'no_action_needed', 'sent_to_counsel', 'open'] as const).map((k) => (
              <option key={k} value={k}>
                {k === 'open' ? tr('review.reopen') : tr(`status.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {status === 'sent_to_counsel' && <p className="text-xs text-text-secondary">{tr('review.counselHint')}</p>}
        <Textarea id="labor-review-note" label={tr('review.note')} placeholder={tr('review.notePlaceholder')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={status === 'open'} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onClose}>
            {tr('review.cancel')}
          </Button>
          <Button size="md" onClick={() => void save()} loading={saving} loadingLabel={tr('review.saving')}>
            {tr('review.save')}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// ============================================================
// WORKERS TAB
// ============================================================

function WorkersTab({ tr, data, excluded, toast, reload }: { tr: Translate; data: LaborOverview; excluded: number; toast: ToastFn; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, { c: WorkerClassification; note: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  if (data.employees.length === 0) return <EmptyState icon={Scale} title={tr('workers.heading')} description={tr('workers.empty')} />;

  const save = async (id: string) => {
    const d = draft[id];
    if (!d) return;
    setSavingId(id);
    try {
      await setWorkerClassification(id, d.c, d.note);
      toast(tr('workers.saved'), 'success');
      setDraft((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
      await reload();
    } catch (e) {
      toast(tr(`errors.${laborErrorKey(e)}`), 'error');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-text-secondary">{tr('workers.intro')}</p>
      {!data.canEdit && <p className="text-xs text-text-secondary">{tr('workers.readOnly')}</p>}
      {excluded > 0 && <p className="text-xs text-text-secondary">{tr('workers.excluded', { count: excluded })}</p>}
      <ul className="space-y-3">
        {data.employees.map((e) => {
          const d = draft[e.id];
          const value = d?.c ?? e.classification;
          const note = d?.note ?? e.basis_note ?? '';
          const dirty = !!d && (d.c !== e.classification || d.note !== (e.basis_note ?? ''));
          return (
            <li key={e.id} className={panelClass}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-text-primary">{e.name}</h3>
                {e.employment_type === '1099' && <Pill text={tr('workers.payroll1099')} tone="warn" />}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm font-medium text-text-primary">
                  {tr('workers.classification')}
                  <select
                    className={`${selectClass} mt-1.5`}
                    value={value}
                    disabled={!data.canEdit}
                    onChange={(ev) => setDraft((cur) => ({ ...cur, [e.id]: { c: ev.target.value as WorkerClassification, note } }))}
                  >
                    {WORKER_CLASSIFICATIONS.map((c) => (
                      <option key={c} value={c}>
                        {tr(`classifications.${c}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  id={`basis-${e.id}`}
                  label={tr('workers.basis')}
                  placeholder={tr('workers.basisPlaceholder')}
                  value={note}
                  maxLength={500}
                  disabled={!data.canEdit}
                  onChange={(ev) => setDraft((cur) => ({ ...cur, [e.id]: { c: value, note: ev.target.value } }))}
                />
              </div>
              {data.canEdit && dirty && (
                <div className="mt-3 flex justify-end">
                  <Button size="md" onClick={() => void save(e.id)} loading={savingId === e.id} loadingLabel={tr('rules.saving')}>
                    {tr('workers.save')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================
// RULES TAB
// ============================================================

function Markers({ tr, rule }: { tr: Translate; rule: Pick<RuleConfigRecord<unknown>, 'counsel_status' | 'verified_on'> | null }) {
  if (!rule) return null;
  const open = openMarkers(rule);
  return (
    <div className="flex flex-wrap gap-2">
      {open.includes('COUNSEL') ? <Pill text={tr('disclaimer.counsel')} tone="warn" /> : <Pill text={tr('disclaimer.counselDone')} tone="good" />}
      {open.includes('VERIFY') ? <Pill text={tr('disclaimer.verify')} tone="warn" /> : <Pill text={tr('disclaimer.verifyDone', { date: rule.verified_on ? fmtDay(rule.verified_on) : '' })} tone="good" />}
    </div>
  );
}

function RulesTab({ tr, data, toast, reload }: { tr: Translate; data: LaborOverview; toast: ToastFn; reload: () => Promise<void> }) {
  const days = tr('rules.overtime.days', { returnObjects: true }) as unknown as string[];
  const breakRule = getJurisdictionRule(normalizeJurisdictionCode(data.breakJurisdiction));

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-text-secondary">{tr('rules.intro')}</p>
      <OvertimeCard tr={tr} rule={data.overtime} canEdit={data.canEdit} days={Array.isArray(days) ? days : []} toast={toast} reload={reload} />
      <PwCard tr={tr} rule={data.prevailingWage} canEdit={data.canEdit} toast={toast} reload={reload} />
      <section className={panelClass} aria-labelledby="rules-breaks">
        <h3 id="rules-breaks" className="text-base font-semibold text-text-primary">
          {tr('rules.breaks.heading')}
        </h3>
        <p className="mt-1 text-sm text-text-secondary">{tr('rules.breaks.body')}</p>
        <p className="mt-2 text-sm text-text-primary">{tr('rules.breaks.jurisdiction', { name: breakRule.name })}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill text={tr('disclaimer.counsel')} tone="warn" />
          {!breakRule.lastReviewed && <Pill text={tr('disclaimer.verify')} tone="warn" />}
        </div>
        <Link to="/dashboard/break-compliance" className="focus-ring mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-accent">
          {tr('rules.breaks.open')}
        </Link>
      </section>
    </div>
  );
}

/** Shared "pack picker + citation + notChecked + save" scaffold for one rule topic. */
function RuleFrame<P extends object>({
  tr,
  topic,
  heading,
  rule,
  packs,
  canEdit,
  buildParams,
  validate,
  onApplyPack,
  jurisdiction,
  setJurisdiction,
  enabled,
  setEnabled,
  citation,
  sourceUrl,
  toast,
  reload,
  children,
}: {
  tr: Translate;
  topic: RuleTopic;
  heading: string;
  rule: RuleConfigRecord<P> | null;
  packs: readonly { code: string; name: string; summary: string; notChecked: string[]; lastReviewed: string | null }[];
  canEdit: boolean;
  buildParams: () => unknown;
  validate: (raw: unknown) => { ok: boolean };
  onApplyPack: (code: string) => void;
  jurisdiction: string;
  setJurisdiction: (v: string) => void;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  citation: string;
  sourceUrl: string;
  toast: ToastFn;
  reload: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const pack = packs.find((p) => p.code === jurisdiction);
  const valid = validate(buildParams()).ok;

  const save = async () => {
    setSaving(true);
    try {
      await saveLaborRuleConfig({
        topic,
        jurisdiction: jurisdiction || CUSTOM_RULE,
        enabled,
        params: buildParams() as object,
        citation: citation.trim() || null,
        sourceUrl: sourceUrl.trim() || null,
      });
      toast(tr(rule && (rule.counsel_status === 'counsel_reviewed' || rule.verified_on) ? 'rules.saved' : 'rules.savedSame'), 'success');
      await reload();
    } catch (e) {
      toast(tr(`errors.${laborErrorKey(e)}`), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`${panelClass} space-y-4`} aria-labelledby={`rules-${topic}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`rules-${topic}`} className="text-base font-semibold text-text-primary">
          {heading}
        </h3>
        <Markers tr={tr} rule={rule} />
      </div>
      {!rule && <p className="text-sm text-text-secondary">{tr('rules.notConfigured')}</p>}

      <label className="block text-sm font-medium text-text-primary">
        {tr('rules.pack')}
        <select className={`${selectClass} mt-1.5`} value={pack ? jurisdiction : jurisdiction === '' ? '' : CUSTOM_RULE} disabled={!canEdit} onChange={(e) => (e.target.value === CUSTOM_RULE ? setJurisdiction(CUSTOM_RULE) : onApplyPack(e.target.value))}>
          {!rule && !jurisdiction && <option value="">{tr('rules.chooseStarter')}</option>}
          {packs.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
          <option value={CUSTOM_RULE}>{tr('rules.custom')}</option>
        </select>
      </label>

      {pack && (
        <div className="space-y-1 text-sm">
          <p className="text-text-primary">{pack.summary}</p>
          {!pack.lastReviewed && <p className="text-xs text-text-secondary">{tr('rules.lastReviewedNone')}</p>}
          {citation && <p className="text-xs text-text-secondary">{tr('rules.citation')}: {citation}</p>}
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-accent underline">
              {tr('rules.source')}
            </a>
          )}
          <div>
            <p className="mt-2 text-xs font-semibold text-text-secondary">{tr('rules.notChecked')}</p>
            <ul className="ms-4 list-disc text-xs text-text-secondary">
              {pack.notChecked.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {children}

      <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} className="h-5 w-5" />
        {tr('rules.enabled')}
      </label>

      {canEdit && (
        <div className="flex justify-end">
          <Button size="md" onClick={() => void save()} disabled={!valid} loading={saving} loadingLabel={tr('rules.saving')}>
            {tr('rules.save')}
          </Button>
        </div>
      )}

      {canEdit && rule && <ReviewRecordForm tr={tr} topic={topic} toast={toast} reload={reload} />}
    </section>
  );
}

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

function NumberField({ id, label, value, onChange, disabled, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean; hint?: string }) {
  return <Input id={id} label={label} type="number" inputMode="decimal" step="0.25" value={value} disabled={disabled} helperText={hint} onChange={(e) => onChange(e.target.value)} />;
}

function OvertimeCard({ tr, rule, canEdit, days, toast, reload }: { tr: Translate; rule: RuleConfigRecord<OvertimeParams> | null; canEdit: boolean; days: string[]; toast: ToastFn; reload: () => Promise<void> }) {
  const init = rule?.params;
  const [jurisdiction, setJurisdiction] = useState(rule?.jurisdiction ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [dow, setDow] = useState(String(init?.workweek_start_dow ?? 1));
  const [weekly, setWeekly] = useState(init?.weekly_threshold_hours?.toString() ?? '40');
  const [dailyOt, setDailyOt] = useState(init?.daily_ot_after_hours?.toString() ?? '');
  const [dailyDt, setDailyDt] = useState(init?.daily_dt_after_hours?.toString() ?? '');
  const [seventh, setSeventh] = useState(init?.seventh_day_signal ?? false);
  const [open, setOpen] = useState(init?.open_shift_alert_hours?.toString() ?? '16');
  const [tol, setTol] = useState(init?.payroll_gap_tolerance_hours?.toString() ?? '0.25');
  const [citation, setCitation] = useState(rule?.citation ?? '');
  const [sourceUrl, setSourceUrl] = useState(rule?.source_url ?? '');

  const build = () => ({
    workweek_start_dow: Number(dow),
    weekly_threshold_hours: numOrNull(weekly),
    daily_ot_after_hours: numOrNull(dailyOt),
    daily_dt_after_hours: numOrNull(dailyDt),
    seventh_day_signal: seventh,
    open_shift_alert_hours: Number(open),
    payroll_gap_tolerance_hours: Number(tol),
  });

  const apply = (code: string) => {
    const pk = getOvertimePack(code);
    if (!pk) return;
    setJurisdiction(code);
    setDow(String(pk.params.workweek_start_dow));
    setWeekly(pk.params.weekly_threshold_hours?.toString() ?? '');
    setDailyOt(pk.params.daily_ot_after_hours?.toString() ?? '');
    setDailyDt(pk.params.daily_dt_after_hours?.toString() ?? '');
    setSeventh(pk.params.seventh_day_signal);
    setOpen(String(pk.params.open_shift_alert_hours));
    setTol(String(pk.params.payroll_gap_tolerance_hours));
    setCitation(pk.citation);
    setSourceUrl(pk.sourceUrl ?? '');
  };

  return (
    <RuleFrame
      tr={tr}
      topic="overtime"
      heading={tr('rules.overtime.heading')}
      rule={rule}
      packs={OVERTIME_PACKS}
      canEdit={canEdit}
      buildParams={build}
      validate={validateOvertimeParams}
      onApplyPack={apply}
      jurisdiction={jurisdiction}
      setJurisdiction={setJurisdiction}
      enabled={enabled}
      setEnabled={setEnabled}
      citation={citation}
      sourceUrl={sourceUrl}
      toast={toast}
      reload={reload}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-text-primary">
          {tr('rules.overtime.workweek')}
          <select className={`${selectClass} mt-1.5`} value={dow} disabled={!canEdit} onChange={(e) => setDow(e.target.value)}>
            {days.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <NumberField id="ot-weekly" label={tr('rules.overtime.weekly')} value={weekly} onChange={setWeekly} disabled={!canEdit} hint={tr('rules.overtime.blank')} />
        <NumberField id="ot-daily" label={tr('rules.overtime.dailyOt')} value={dailyOt} onChange={setDailyOt} disabled={!canEdit} hint={tr('rules.overtime.blank')} />
        <NumberField id="ot-daily2" label={tr('rules.overtime.dailyDt')} value={dailyDt} onChange={setDailyDt} disabled={!canEdit} hint={tr('rules.overtime.blank')} />
        <NumberField id="ot-open" label={tr('rules.overtime.open')} value={open} onChange={setOpen} disabled={!canEdit} />
        <NumberField id="ot-tol" label={tr('rules.overtime.tolerance')} value={tol} onChange={setTol} disabled={!canEdit} />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={seventh} disabled={!canEdit} onChange={(e) => setSeventh(e.target.checked)} className="h-5 w-5" />
        {tr('rules.overtime.seventh')}
      </label>
    </RuleFrame>
  );
}

function PwCard({ tr, rule, canEdit, toast, reload }: { tr: Translate; rule: RuleConfigRecord<PrevailingWageParams> | null; canEdit: boolean; toast: ToastFn; reload: () => Promise<void> }) {
  const [jurisdiction, setJurisdiction] = useState(rule?.jurisdiction ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [missing, setMissing] = useState(rule?.params.check_missing_classification ?? true);
  const [below, setBelow] = useState(rule?.params.check_rate_below_table ?? true);
  const [citation, setCitation] = useState(rule?.citation ?? '');
  const [sourceUrl, setSourceUrl] = useState(rule?.source_url ?? '');

  const apply = (code: string) => {
    const pk = getPwPack(code);
    if (!pk) return;
    setJurisdiction(code);
    setMissing(pk.params.check_missing_classification);
    setBelow(pk.params.check_rate_below_table);
    setCitation(pk.citation);
    setSourceUrl(pk.sourceUrl ?? '');
  };

  return (
    <RuleFrame
      tr={tr}
      topic="prevailing_wage"
      heading={tr('rules.prevailing_wage.heading')}
      rule={rule}
      packs={PW_PACKS}
      canEdit={canEdit}
      buildParams={() => ({ check_missing_classification: missing, check_rate_below_table: below })}
      validate={validatePwParams}
      onApplyPack={apply}
      jurisdiction={jurisdiction}
      setJurisdiction={setJurisdiction}
      enabled={enabled}
      setEnabled={setEnabled}
      citation={citation}
      sourceUrl={sourceUrl}
      toast={toast}
      reload={reload}
    >
      <div className="space-y-1">
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={missing} disabled={!canEdit} onChange={(e) => setMissing(e.target.checked)} className="h-5 w-5" />
          {tr('rules.prevailing_wage.missing')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={below} disabled={!canEdit} onChange={(e) => setBelow(e.target.checked)} className="h-5 w-5" />
          {tr('rules.prevailing_wage.below')}
        </label>
      </div>
    </RuleFrame>
  );
}

function ReviewRecordForm({ tr, topic, toast, reload }: { tr: Translate; topic: RuleTopic; toast: ToastFn; reload: () => Promise<void> }) {
  const [who, setWho] = useState('');
  const [verified, setVerified] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const can = who.trim() !== '' || verified !== '';

  const save = async () => {
    setSaving(true);
    try {
      await recordLaborRuleReview(topic, who, verified, note);
      toast(tr('rules.review.saved'), 'success');
      setWho('');
      setVerified('');
      setNote('');
      await reload();
    } catch (e) {
      toast(tr(`errors.${laborErrorKey(e)}`), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h4 className="text-sm font-semibold text-text-primary">{tr('rules.review.heading')}</h4>
      <p className="text-xs text-text-secondary">{tr('rules.review.hint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input id={`rv-who-${topic}`} label={tr('rules.review.counsel')} placeholder={tr('rules.review.counselPlaceholder')} value={who} maxLength={160} onChange={(e) => setWho(e.target.value)} />
        <Input id={`rv-date-${topic}`} label={tr('rules.review.verified')} type="date" max={today} value={verified} onChange={(e) => setVerified(e.target.value)} />
      </div>
      <Textarea id={`rv-note-${topic}`} label={tr('rules.review.note')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <div className="flex justify-end">
        <Button variant="secondary" size="md" onClick={() => void save()} disabled={!can} loading={saving} loadingLabel={tr('rules.saving')}>
          {tr('rules.review.save')}
        </Button>
      </div>
    </div>
  );
}
