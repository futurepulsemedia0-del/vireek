import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, Coffee, Download, Lock, RotateCcw, Settings as SettingsIcon, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { exportToCsv } from '@/lib/csvExport';
import {
  DEFAULT_SETTINGS,
  REVIEW_LABELS,
  REVIEW_TONES,
  VIOLATION_CSV_COLUMNS,
  applyReviews,
  breakErrorMessage,
  buildViolationCsvRows,
  evaluateShifts,
  filterShifts,
  minutesLabel,
  rollupByMember,
  settingsEqual,
  settingsToForm,
  summarize,
  validateSettingsForm,
  type BreakSettings,
  type ReviewRecord,
  type ReviewStatus,
  type SettingsForm,
  type ShiftRecord,
  type ShiftCompliance,
  type StatusTone,
  type Violation,
  type ViolationFilter,
} from '@/lib/breakCompliance';
import {
  getBreakOptions,
  listReviews,
  listShiftsForReport,
  reviewViolation,
  saveBreakSettings,
  applyBreakJurisdiction,
  type BreakOptions,
} from '@/lib/breakComplianceApi';
import {
  BREAK_RULES_DISCLAIMER,
  CUSTOM_JURISDICTION,
  JURISDICTION_RULES,
  effectiveJurisdiction,
  getJurisdictionRule,
  isJurisdictionCode,
  jurisdictionLabel,
  premiumExplanation,
  settingsForJurisdiction,
  type EffectiveJurisdiction,
  type JurisdictionCode,
} from '@/lib/breakRules';

// ============================================================
// SHARED BITS
// ============================================================

type ToastFn = (message: string, type?: 'success' | 'error' | 'info') => void;
type TabKey = 'report' | 'rules';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';
const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-4';

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  good: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  bad: 'bg-danger/10 text-danger',
};

function StatusPill({ text, tone = 'neutral' }: { text: string; tone?: StatusTone }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>{text}</span>;
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: StatusTone }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : tone === 'good' ? 'text-success' : 'text-text-primary';
  return (
    <div className={panelClass}>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-primary p-5 pb-8 shadow-xl sm:max-w-lg sm:rounded-2xl sm:pb-5"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const RANGES = [7, 14, 30, 90] as const;

const sinceDateFor = (days: number, now: number) => {
  const d = new Date(now - (days - 1) * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ============================================================
// PAGE
// ============================================================

export function BreakCompliancePage() {
  const { profile, teamMember, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();

  // Time data belongs to the ACCOUNT OWNER; managers read the owner's account.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  let body: React.ReactNode;
  if (profileLoading || (!accountOwnerId && !profile)) {
    body = (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} />
      </div>
    );
  } else if (!accountOwnerId) {
    body = (
      <EmptyState
        icon={Lock}
        title="We couldn't find your account"
        description="Your user isn't linked to a business account yet. Ask the account owner to re-send your invite."
      />
    );
  } else {
    body = <Compliance accountOwnerId={accountOwnerId} toast={toast} />;
  }

  return (
    <DashboardLayout activeLabel="Break Compliance">
      <div className="mx-auto max-w-6xl px-0 py-2 sm:px-2">{body}</div>
    </DashboardLayout>
  );
}

// ============================================================
// DATA + TABS
// ============================================================

function Compliance({ accountOwnerId, toast }: { accountOwnerId: string; toast: ToastFn }) {
  const [params, setParams] = useSearchParams();
  const tab: TabKey = params.get('tab') === 'rules' ? 'rules' : 'report';

  const [options, setOptions] = useState<BreakOptions | null>(null);
  const [shifts, setShifts] = useState<ShiftRecord[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [days, setDays] = useState<number>(14);
  const [memberId, setMemberId] = useState('all');
  const [filter, setFilter] = useState<ViolationFilter>('open');
  const [reviewing, setReviewing] = useState<{ sc: ShiftCompliance; violation: Violation } | null>(null);

  const settings: BreakSettings = options?.settings ?? DEFAULT_SETTINGS;
  const canManage = options?.can_manage ?? false;
  const jurisdiction = effectiveJurisdiction(options?.jurisdiction, settings);

  // toast identity may change between renders; keep it out of the load callback's deps.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const loadAll = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      else setPhase('loading');
      try {
        const t = Date.now();
        const o = await getBreakOptions();
        if (!o.can_manage) {
          setOptions(o);
          setPhase('ready');
          return;
        }
        const s = await listShiftsForReport(accountOwnerId, sinceDateFor(days, t));
        const r = await listReviews(
          accountOwnerId,
          s.map((x) => x.id),
        );
        setOptions(o);
        setShifts(s);
        setReviews(r);
        setNow(t);
        setPhase('ready');
      } catch (e) {
        if (quiet) toastRef.current(breakErrorMessage(e, "Couldn't refresh. Showing the last data."), 'error');
        else setPhase('error');
      } finally {
        setRefreshing(false);
      }
    },
    [accountOwnerId, days],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const evaluated = useMemo(() => applyReviews(evaluateShifts(shifts, settings, now), reviews), [shifts, settings, now, reviews]);
  const nameById = useMemo(() => new Map((options?.members ?? []).map((m) => [m.id, m.name])), [options]);
  const nameOf = useCallback((id: string) => nameById.get(id) ?? 'Former team member', [nameById]);
  const summary = useMemo(() => summarize(evaluated, settings), [evaluated, settings]);
  const rollup = useMemo(() => rollupByMember(evaluated).filter((r) => r.openViolations > 0).slice(0, 5), [evaluated]);
  const visible = useMemo(() => filterShifts(evaluated, memberId, filter), [evaluated, memberId, filter]);

  const setTab = (k: TabKey) => setParams(k === 'report' ? {} : { tab: k });

  const exportCsv = () => {
    const rows = buildViolationCsvRows(filterShifts(evaluated, memberId, 'all'), nameOf);
    if (rows.length === 0) {
      toast('There are no violations to export for this selection', 'info');
      return;
    }
    exportToCsv(rows, VIOLATION_CSV_COLUMNS, `break-violations-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  if (phase === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-10 w-64" />
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} />
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <EmptyStateError
        icon={AlertTriangle}
        title="We couldn't load break compliance"
        description="Check your connection and try again."
        onRetry={() => void loadAll()}
      />
    );
  }
  if (!canManage) {
    return (
      <EmptyState
        icon={Lock}
        title="Managers only"
        description="Break compliance reports are available to the account owner and team members who can view billing. Ask an owner for access."
      />
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text-primary">Break compliance</h1>
          <p className="mt-1 text-sm text-text-secondary">Meal and rest break rules, technician reminders and a violation report from your time clock.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void loadAll(true)} disabled={refreshing}>
            <RotateCcw size={16} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button variant="secondary" size="sm" onClick={exportCsv}>
            <Download size={16} /> Export CSV
          </Button>
        </div>
      </header>

      <div role="tablist" aria-label="Break compliance sections" className="flex gap-1 rounded-xl border border-border bg-bg-secondary p-1">
        {(
          [
            ['report', 'Report', Coffee],
            ['rules', 'Rules', SettingsIcon],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`focus-ring flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${
              tab === key ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {!settings.enabled && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <span>
            Break rules are turned off, so no violations are being flagged and technicians are not prompted. Turn them on in the{' '}
            <button type="button" className="focus-ring font-semibold text-accent underline" onClick={() => setTab('rules')}>
              Rules
            </button>{' '}
            tab.
          </span>
        </div>
      )}

      {tab === 'rules' ? (
        <RulesPanel
          settings={settings}
          jurisdiction={jurisdiction}
          onApplied={(s, code) => {
            setOptions((o) => (o ? { ...o, settings: s, jurisdiction: code } : o));
            toast(`${getJurisdictionRule(code).name} rules applied`, 'success');
          }}
          toast={toast}
          onSaved={(s) => {
            setOptions((o) => (o ? { ...o, settings: s } : o));
            toast('Break rules saved', 'success');
          }}
        />
      ) : (
        <>
          <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Shifts checked" value={summary.shifts} />
            <StatCard
              label="Fully compliant"
              value={summary.complianceRate === null ? '—' : `${summary.complianceRate}%`}
              tone={summary.complianceRate === null ? 'neutral' : summary.complianceRate >= 95 ? 'good' : summary.complianceRate >= 80 ? 'warn' : 'bad'}
            />
            <StatCard label="Violations to review" value={summary.openViolations} tone={summary.openViolations > 0 ? 'bad' : 'good'} />
            <StatCard
              label="Estimated premium pay owed"
              value={minutesLabel(summary.premiumOwedMinutes)}
              tone={summary.premiumOwedMinutes > 0 ? 'warn' : 'neutral'}
            />
          </section>

          <p className="text-xs text-text-secondary">
            Rule set: <span className="font-semibold text-text-primary">{jurisdictionLabel(jurisdiction)}</span>. {BREAK_RULES_DISCLAIMER}
          </p>
          <section aria-label="Filters" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex gap-1 rounded-xl border border-border bg-bg-secondary p-1" role="group" aria-label="Date range">
              {RANGES.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days === d}
                  onClick={() => setDays(d)}
                  className={`focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold transition-colors ${
                    days === d ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <label className="min-w-0 flex-1 sm:max-w-xs">
              <span className="sr-only">Employee</span>
              <select className={selectClass} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="all">All employees</option>
                {(options?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1 rounded-xl border border-border bg-bg-secondary p-1" role="group" aria-label="Show">
              {(
                [
                  ['open', 'Needs review'],
                  ['all', 'All violations'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={filter === k}
                  onClick={() => setFilter(k)}
                  className={`focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold transition-colors ${
                    filter === k ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {rollup.length > 0 && memberId === 'all' && (
            <section className={panelClass} aria-label="Employees with the most open violations">
              <h2 className="mb-2 text-sm font-semibold text-text-primary">Needs attention</h2>
              <ul className="divide-y divide-border">
                {rollup.map((r) => (
                  <li key={r.memberId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <button type="button" className="focus-ring min-w-0 truncate rounded text-left font-medium text-text-primary hover:text-accent" onClick={() => setMemberId(r.memberId)}>
                      {nameOf(r.memberId)}
                    </button>
                    <span className="shrink-0 text-text-secondary">
                      {r.openViolations} open · {r.complianceRate}% compliant
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {shifts.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No shifts in this period"
              description="Shifts appear here once technicians clock in and out with the time clock. Try a longer date range."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={filter === 'open' ? 'Nothing to review' : 'No violations'}
              description={
                filter === 'open'
                  ? 'Every flagged break in this period has been reviewed, or none were flagged.'
                  : 'All checked shifts met your meal and rest break rules.'
              }
            />
          ) : (
            <ul className="space-y-3" aria-label="Shifts with break violations">
              {visible.map((sc) => (
                <li key={sc.shiftId} className={panelClass}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-text-primary">{nameOf(sc.memberId)}</p>
                      <p className="text-xs text-text-secondary">
                        {fmtDay(sc.workDate)} · {fmtTime(sc.clockInAt)} – {sc.clockOutAt ? fmtTime(sc.clockOutAt) : 'still working'} · {minutesLabel(sc.workedMinutes)} worked
                      </p>
                    </div>
                    <p className="text-xs text-text-secondary">
                      Meals {sc.mealsTaken}/{sc.mealsRequired} · Rests {sc.restsTaken}/{sc.restsRequired}
                    </p>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {sc.violations.map((v) => (
                      <li key={v.code} className="rounded-xl border border-border bg-bg-primary p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-text-primary">{v.label}</span>
                            <StatusPill text={REVIEW_LABELS[v.status]} tone={REVIEW_TONES[v.status]} />
                            {sc.open && <StatusPill text="In progress" tone="warn" />}
                          </div>
                          <Button variant="secondary" size="sm" onClick={() => setReviewing({ sc, violation: v })}>
                            {v.status === 'open' ? 'Review' : 'Change'}
                          </Button>
                        </div>
                        <p className="mt-1.5 text-sm text-text-secondary">{v.detail}</p>
                        {v.note && <p className="mt-1.5 text-xs italic text-text-secondary">Note: {v.note}</p>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-text-secondary">
            Breaks are classified by length: at least {settings.meal_min_minutes} min counts as a meal break, {settings.rest_min_minutes}–{settings.meal_min_minutes - 1} min as a rest
            break. Premium pay is an estimate (one {minutesLabel(settings.premium_minutes)} premium per shift for meal violations and one for rest violations) — confirm with your
            payroll advisor.
          </p>
        </>
      )}

      {reviewing && (
        <ReviewSheet
          target={reviewing}
          name={nameOf(reviewing.sc.memberId)}
          toast={toast}
          onClose={() => setReviewing(null)}
          onDone={(message) => {
            toast(message, 'success');
            setReviewing(null);
            void loadAll(true);
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// REVIEW SHEET
// ============================================================

function ReviewSheet({
  target,
  name,
  toast,
  onClose,
  onDone,
}: {
  target: { sc: ShiftCompliance; violation: Violation };
  name: string;
  toast: ToastFn;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { sc, violation } = target;
  const [status, setStatus] = useState<ReviewStatus>(violation.status === 'open' ? 'waived' : violation.status);
  const [note, setNote] = useState(violation.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: { value: ReviewStatus; label: string; hint: string }[] = [
    { value: 'waived', label: 'Waived', hint: 'The employee agreed to skip it where the rules allow.' },
    { value: 'excused', label: 'Excused', hint: 'A real reason it could not happen, e.g. an emergency.' },
    { value: 'premium_paid', label: 'Premium paid', hint: 'Premium pay was added in payroll.' },
    { value: 'open', label: 'Needs review', hint: 'Undo the earlier decision.' },
  ];

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await reviewViolation(sc.shiftId, violation.code, status, note);
      onDone(status === 'open' ? 'Reopened for review' : 'Review saved');
    } catch (e) {
      const m = breakErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={violation.label} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {name} · {fmtDay(sc.workDate)}
        </p>
        <p className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">{violation.detail}</p>
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="mb-1.5 text-sm font-medium text-text-primary">Decision</legend>
          {options.map((o) => (
            <label
              key={o.value}
              className={`flex min-h-[48px] cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${
                status === o.value ? 'border-accent bg-accent/5' : 'border-border'
              }`}
            >
              <input type="radio" name="decision" className="mt-1 h-4 w-4 accent-[var(--color-accent,#2563eb)]" checked={status === o.value} onChange={() => setStatus(o.value)} />
              <span>
                <span className="block font-semibold text-text-primary">{o.label}</span>
                <span className="block text-xs text-text-secondary">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Textarea label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : 'Save decision'}
        </Button>
      </div>
    </Sheet>
  );
}

// ============================================================
// RULES
// ============================================================

function RulesPanel({
  settings,
  jurisdiction,
  toast,
  onSaved,
  onApplied,
}: {
  settings: BreakSettings;
  jurisdiction: EffectiveJurisdiction;
  toast: ToastFn;
  onSaved: (s: BreakSettings) => void;
  onApplied: (s: BreakSettings, code: JurisdictionCode) => void;
}) {
  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(settingsToForm(settings));
  }, [settings]);

  const parsed = useMemo(() => validateSettingsForm(form), [form]);
  const [pick, setPick] = useState('');
  const picked = isJurisdictionCode(pick) ? getJurisdictionRule(pick) : null;

  const apply = async () => {
    if (busy || !isJurisdictionCode(pick)) return;
    setBusy(true);
    setError(null);
    try {
      const next = settingsForJurisdiction(pick, settings);
      await applyBreakJurisdiction(pick, next);
      onApplied(next, pick);
      setPick('');
    } catch (e) {
      const m = breakErrorMessage(e);
      setError(m);
      toast(m, 'error');
    } finally {
      setBusy(false);
    }
  };
  const dirty = !parsed.ok || !settingsEqual(parsed.value, settings);

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveBreakSettings(parsed.value);
      onSaved(parsed.value);
    } catch (e) {
      const m = breakErrorMessage(e);
      setError(m);
      toast(m, 'error');
    } finally {
      setBusy(false);
    }
  };

  const check = (key: 'enabled' | 'prompts_enabled', label: string) => (
    <label className="flex min-h-[44px] items-center gap-3 text-sm text-text-primary">
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(e) => set(key, e.target.checked)}
        disabled={busy}
        className="h-5 w-5 accent-[var(--color-accent,#2563eb)]"
      />
      {label}
    </label>
  );

  return (
    <div className="space-y-4">
      <section className={`${panelClass} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-text-primary">State rule set</h2>
          <StatusPill text={jurisdictionLabel(jurisdiction)} tone={jurisdiction === CUSTOM_JURISDICTION ? 'warn' : 'good'} />
        </div>
        <p className="text-sm text-text-secondary">{premiumExplanation(jurisdiction)}</p>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-text-primary">Apply a rule set</span>
          <select className={selectClass} value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
            <option value="">Choose a state…</option>
            {JURISDICTION_RULES.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {picked && (
          <div className="space-y-2 rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">
            <p className="text-text-primary">{picked.summary}</p>
            <p>{picked.premiumNote}</p>
            <p className="font-semibold text-text-primary">Not checked by this tool:</p>
            <ul className="list-disc space-y-1 pl-5">
              {picked.notChecked.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p className="text-xs">
              {picked.citation}
              {picked.sourceUrl && (
                <>
                  {' · '}
                  <a href={picked.sourceUrl} target="_blank" rel="noopener noreferrer" className="focus-ring text-accent underline">
                    Source
                  </a>
                </>
              )}
              {' · '}
              {picked.lastReviewed ? `Checked ${picked.lastReviewed}` : 'Not yet verified against the agency source'}
            </p>
            <Button onClick={() => void apply()} disabled={busy}>
              {busy ? 'Applying…' : `Apply ${picked.name} rules`}
            </Button>
          </div>
        )}
        <p className="text-xs text-text-secondary">{BREAK_RULES_DISCLAIMER}</p>
      </section>
      <section className={`${panelClass} space-y-3`}>
        <h2 className="text-base font-semibold text-text-primary">Rules</h2>
        {check('enabled', 'Check shifts against break rules')}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Meal break length (min)" inputMode="numeric" value={form.meal_min_minutes} onChange={(e) => set('meal_min_minutes', e.target.value)} disabled={busy} helperText="A break at least this long counts as a meal break." />
          <Input label="First meal must start before (worked min)" inputMode="numeric" value={form.meal_deadline_minutes} onChange={(e) => set('meal_deadline_minutes', e.target.value)} disabled={busy} helperText="300 = before the end of the 5th hour." />
          <Input label="Meal required once worked time reaches (min)" value={form.meal_thresholds} onChange={(e) => set('meal_thresholds', e.target.value)} disabled={busy} helperText="Comma separated. 300, 600 = one meal at 5h, a second at 10h." />
          <Input label="Rest break length (min)" inputMode="numeric" value={form.rest_min_minutes} onChange={(e) => set('rest_min_minutes', e.target.value)} disabled={busy} helperText="Shorter than a meal break." />
          <Input label="Rest break required once worked time reaches (min)" value={form.rest_thresholds} onChange={(e) => set('rest_thresholds', e.target.value)} disabled={busy} helperText="210, 360, 600 = 1 rest at 3.5h, 2 at 6h, 3 at 10h." />
          <Input label="Premium pay per violation type (min)" inputMode="numeric" value={form.premium_minutes} onChange={(e) => set('premium_minutes', e.target.value)} disabled={busy} helperText="60 = one hour of pay. Used for the estimate only." />
        </div>
      </section>

      <section className={`${panelClass} space-y-3`}>
        <h2 className="text-base font-semibold text-text-primary">Technician reminders</h2>
        {check('prompts_enabled', 'Remind technicians on the Timesheet screen')}
        <div className="sm:max-w-xs">
          <Input label="Remind this long before it is due (min)" inputMode="numeric" value={form.prompt_lead_minutes} onChange={(e) => set('prompt_lead_minutes', e.target.value)} disabled={busy} />
        </div>
      </section>

      {(error || (!parsed.ok && dirty)) && (
        <p role="alert" className="text-sm text-danger">
          {error ?? (parsed.ok ? '' : parsed.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={busy || !dirty || !parsed.ok}>
          {busy ? 'Saving…' : 'Save rules'}
        </Button>
        <Button variant="ghost" onClick={() => setForm(settingsToForm(DEFAULT_SETTINGS))} disabled={busy}>
          Reset to defaults
        </Button>
      </div>
      <p className="text-xs text-text-secondary">
        Rule changes re-check your whole history. These defaults follow a common US layout; rules differ by state and employer, so confirm yours with your payroll or legal advisor.
      </p>
    </div>
  );
}
