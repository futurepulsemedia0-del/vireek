import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Download,
  History,
  Lock,
  Pencil,
  Plus,
  ScanLine,
  Search,
  Settings as SettingsIcon,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { exportToCsv } from '@/lib/csvExport';
import { detectCapabilities, scanCode } from '@/lib/native/capabilities';
import { isNative } from '@/lib/native/platform';
import {
  CONDITION_LABELS,
  DEFAULT_SETTINGS,
  EVENT_LABELS,
  LOAN_STATE_LABELS,
  TOOL_STATUS_LABELS,
  alertLoans,
  buildToolCsvColumns,
  buildToolCsvRows,
  checkInCribTool,
  defaultVehicleFor,
  checkOutCribTool,
  cribErrorMessage,
  dueLabel,
  emptyToolInput,
  extendCribLoan,
  filterTools,
  findToolByCode,
  formatCostCents,
  getCribOptions,
  groupLoansByTechnician,
  listCribTools,
  listOpenCribLoans,
  listToolEvents,
  loanState,
  loanStateTone,
  markCribToolLost,
  parseWholeNumber,
  recoverCribTool,
  saveCribSettings,
  saveCribTool,
  scanCribAlerts,
  setCribToolStatus,
  summarizeCrib,
  toolStatusTone,
  toolToInput,
  type CribEvent,
  type CribLoan,
  type CribOptions,
  type CribSettings,
  type CribTool,
  type StatusTone,
  type ToolCondition,
  type ToolFilter,
  type ToolInput,
} from '@/lib/toolCrib';

// ============================================================
// SHARED BITS
// ============================================================

type ToastFn = (message: string, type?: 'success' | 'error' | 'info') => void;
type TabKey = 'tools' | 'out' | 'alerts';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';
const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const labelClass = 'mb-1.5 block text-sm font-medium text-text-primary';

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  good: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  bad: 'bg-danger/10 text-danger',
};

function StatusPill({ text, tone = 'neutral' }: { text: string; tone?: StatusTone }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>{text}</span>
  );
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

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type Action =
  | { kind: 'checkout'; tool: CribTool }
  | { kind: 'checkin'; loan: CribLoan }
  | { kind: 'extend'; loan: CribLoan }
  | { kind: 'detail'; tool: CribTool }
  | { kind: 'edit'; input: ToolInput }
  | { kind: 'lost'; tool: CribTool }
  | { kind: 'recover'; tool: CribTool }
  | { kind: 'settings' }
  | { kind: 'scan' };

// ============================================================
// PAGE
// ============================================================

export function ToolCribPage() {
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();

  // The crib belongs to the ACCOUNT OWNER; team members read/write the owner's crib.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canViewCosts = isOwner || permissions.can_view_billing;

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
    body = <Crib accountOwnerId={accountOwnerId} canViewCosts={canViewCosts} toast={toast} />;
  }

  return (
    <DashboardLayout activeLabel="Tool Crib">
      <div className="mx-auto max-w-6xl px-0 py-2 sm:px-2">{body}</div>
    </DashboardLayout>
  );
}

// ============================================================
// CRIB (data + tabs)
// ============================================================

function Crib({ accountOwnerId, canViewCosts, toast }: { accountOwnerId: string; canViewCosts: boolean; toast: ToastFn }) {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: TabKey = tabParam === 'out' || tabParam === 'alerts' ? tabParam : 'tools';

  const [options, setOptions] = useState<CribOptions | null>(null);
  const [tools, setTools] = useState<CribTool[]>([]);
  const [loans, setLoans] = useState<CribLoan[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [now, setNow] = useState(() => Date.now());
  const [action, setAction] = useState<Action | null>(null);
  const [canScan, setCanScan] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ToolFilter>('all');
  const [techFilter, setTechFilter] = useState('all');

  const settings: CribSettings = options?.settings ?? DEFAULT_SETTINGS;
  const canManage = options?.can_manage ?? false;
  const lostAfter = settings.lost_after_hours;

  const loadAll = useCallback(async () => {
    setPhase('loading');
    try {
      const [o, t, l] = await Promise.all([getCribOptions(), listCribTools(accountOwnerId), listOpenCribLoans(accountOwnerId)]);
      setOptions(o);
      setTools(t);
      setLoans(l);
      setNow(Date.now());
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [accountOwnerId]);

  // Quiet refresh (no skeleton) after an action or on the timer.
  const refresh = useCallback(async () => {
    try {
      const [t, l] = await Promise.all([listCribTools(accountOwnerId), listOpenCribLoans(accountOwnerId)]);
      setTools(t);
      setLoans(l);
      setNow(Date.now());
    } catch {
      /* keep what is on screen; the next refresh will retry */
    }
  }, [accountOwnerId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let alive = true;
    detectCapabilities()
      .then((c) => alive && setCanScan(c.scan))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Server-side alert pass (writes notification-bell entries once per loan per stage), then re-read.
  useEffect(() => {
    if (phase !== 'ready') return;
    let alive = true;
    const run = async () => {
      try {
        await scanCribAlerts();
      } catch {
        /* alerts are best-effort; the Alerts tab is computed locally anyway */
      }
      if (alive) void refresh();
    };
    void run();
    const id = window.setInterval(() => void run(), 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [phase, refresh]);

  // Keep "due in / overdue by" labels live.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const openLoanByTool = useMemo(() => {
    const m = new Map<string, CribLoan>();
    for (const l of loans) if (l.status === 'out') m.set(l.tool_id, l);
    return m;
  }, [loans]);

  const summary = useMemo(() => summarizeCrib(tools, loans, now, lostAfter), [tools, loans, now, lostAfter]);
  const alerts = useMemo(() => alertLoans(loans, now, lostAfter), [loans, now, lostAfter]);
  const lostTools = useMemo(() => tools.filter((t) => t.status === 'lost'), [tools]);
  const alertCount = alerts.length + lostTools.length;

  const setTab = (k: TabKey) => setParams(k === 'tools' ? {} : { tab: k });

  const openForTool = useCallback(
    (t: CribTool) => {
      const loan = openLoanByTool.get(t.id);
      if (t.status === 'available') setAction({ kind: 'checkout', tool: t });
      else if (t.status === 'checked_out' && loan) setAction({ kind: 'checkin', loan });
      else setAction({ kind: 'detail', tool: t });
    },
    [openLoanByTool],
  );

  const handleCode = useCallback(
    (code: string) => {
      const t = findToolByCode(tools, code);
      if (!t) {
        toast('No tool matches that code', 'error');
        return;
      }
      openForTool(t);
    },
    [tools, toast, openForTool],
  );

  const done = useCallback(
    (message: string) => {
      toast(message, 'success');
      setAction(null);
      void refresh();
    },
    [toast, refresh],
  );

  const exportCsv = () => {
    exportToCsv(buildToolCsvRows(tools, loans), buildToolCsvColumns(canViewCosts), `tool-crib-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const visibleTools = useMemo(() => filterTools(tools, query, filter), [tools, query, filter]);
  const groups = useMemo(() => groupLoansByTechnician(loans, now, lostAfter), [loans, now, lostAfter]);
  const visibleGroups = techFilter === 'all' ? groups : groups.filter((g) => g.key === techFilter);

  const filters: { key: ToolFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'available', label: 'Available' },
    { key: 'checked_out', label: 'Checked out' },
    { key: 'maintenance', label: 'Maintenance' },
    { key: 'lost', label: 'Lost' },
    { key: 'retired', label: 'Retired' },
  ];

  const tabs: { key: TabKey; label: string; badge?: number }[] = [
    { key: 'tools', label: 'Tools' },
    { key: 'out', label: 'Checked out', badge: summary.out },
    { key: 'alerts', label: 'Alerts', badge: alertCount },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Wrench size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Tool Crib</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Check shared tools out to technicians, get them back, and catch overdue or lost tools early.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/dashboard/inventory"
            className="focus-ring rounded-xl px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            Parts &amp; Inventory
          </Link>
          {phase === 'ready' && tools.length > 0 && (
            <Button size="sm" variant="secondary" onClick={exportCsv}>
              <Download size={16} /> Export
            </Button>
          )}
          {phase === 'ready' && canManage && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setAction({ kind: 'settings' })} aria-label="Crib settings">
                <SettingsIcon size={16} />
              </Button>
              <Button size="sm" onClick={() => setAction({ kind: 'edit', input: emptyToolInput() })}>
                <Plus size={16} /> Add tool
              </Button>
            </>
          )}
        </div>
      </header>

      {phase === 'loading' && (
        <>
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} />
        </>
      )}

      {phase === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load the tool crib"
          description="Check your connection and try again."
          action={{ label: 'Retry', onClick: () => void loadAll() }}
        />
      )}

      {phase === 'ready' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Available" value={summary.available} tone="good" />
            <StatCard label="Checked out" value={summary.out} />
            <StatCard label="Overdue" value={summary.overdue + summary.suspectedLost} tone={summary.overdue + summary.suspectedLost ? 'bad' : undefined} />
            <StatCard label="Lost" value={summary.lost} tone={summary.lost ? 'bad' : undefined} />
          </div>

          {alertCount > 0 && tab !== 'alerts' && (
            <button
              type="button"
              onClick={() => setTab('alerts')}
              className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-left text-sm font-medium text-danger"
            >
              <AlertTriangle size={18} className="shrink-0" />
              {alertCount} {alertCount === 1 ? 'tool needs' : 'tools need'} attention — review alerts
            </button>
          )}

          <div role="tablist" aria-label="Tool crib sections" className="flex gap-1 overflow-x-auto border-b border-border">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`focus-ring -mb-px flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${
                  tab === t.key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t.label}
                {!!t.badge && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      t.key === 'alerts' ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {tab === 'tools' && (
            <section className="space-y-4" aria-label="Tools">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // A USB/Bluetooth scanner "types" the code then presses Enter.
                      if (e.key === 'Enter' && query.trim()) {
                        e.preventDefault();
                        if (findToolByCode(tools, query)) {
                          handleCode(query);
                          setQuery('');
                        }
                      }
                    }}
                    placeholder="Search, or scan a tag and press Enter"
                    aria-label="Search tools"
                    className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-3 pl-10 pr-4 text-base text-text-primary focus-visible:border-accent"
                  />
                </div>
                {canScan && (
                  <Button variant="secondary" onClick={() => setAction({ kind: 'scan' })}>
                    <ScanLine size={18} /> Scan tag
                  </Button>
                )}
              </div>

              <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter by status">
                {filters.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    className={`focus-ring shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                      filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {tools.length === 0 ? (
                <EmptyState
                  icon={Wrench}
                  title="Your tool crib is empty"
                  description={
                    canManage
                      ? 'Add the shared tools your technicians borrow — drills, gauges, ladders — then check them out by name or by scanning a tag.'
                      : 'No tools have been added yet. Ask a manager to add the shared tools.'
                  }
                  action={canManage ? { label: 'Add your first tool', onClick: () => setAction({ kind: 'edit', input: emptyToolInput() }) } : undefined}
                />
              ) : visibleTools.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No tools match"
                  description="Try a different search or status filter."
                  action={{
                    label: 'Clear filters',
                    onClick: () => {
                      setQuery('');
                      setFilter('all');
                    },
                  }}
                />
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {visibleTools.map((t) => {
                    const loan = openLoanByTool.get(t.id);
                    const st = loan ? loanState(loan, now, lostAfter) : null;
                    return (
                      <li key={t.id} className={`${panelClass} flex flex-col gap-3`}>
                        <div className="flex items-start justify-between gap-3">
                          <button type="button" onClick={() => setAction({ kind: 'detail', tool: t })} className="focus-ring min-w-0 rounded-lg text-left">
                            <p className="truncate font-semibold text-text-primary">{t.name}</p>
                            <p className="truncate text-xs text-text-secondary">
                              {t.tool_number}
                              {t.category ? ` · ${t.category}` : ''}
                            </p>
                          </button>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <StatusPill text={TOOL_STATUS_LABELS[t.status]} tone={toolStatusTone(t.status)} />
                            {st && (st === 'overdue' || st === 'suspected_lost' || st === 'due_soon') && (
                              <StatusPill text={LOAN_STATE_LABELS[st]} tone={loanStateTone(st)} />
                            )}
                          </div>
                        </div>
                        {loan && (
                          <p className="text-sm text-text-secondary">
                           <span className="font-medium text-text-primary">{loan.technician_name}</span>
                            {loan.vehicle_label ? ` · ${loan.vehicle_label}` : ''} · {dueLabel(loan, now)}
                          </p>
                        )}
                        <div className="mt-auto flex gap-2">
                          {t.status === 'available' && (
                            <Button size="sm" className="flex-1" onClick={() => setAction({ kind: 'checkout', tool: t })}>
                              <ArrowUpFromLine size={16} /> Check out
                            </Button>
                          )}
                          {t.status === 'checked_out' && loan && (
                            <>
                              <Button size="sm" className="flex-1" onClick={() => setAction({ kind: 'checkin', loan })}>
                                <ArrowDownToLine size={16} /> Check in
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => setAction({ kind: 'extend', loan })}>
                                <Clock size={16} /> Extend
                              </Button>
                            </>
                          )}
                          {t.status !== 'available' && t.status !== 'checked_out' && (
                            <Button size="sm" variant="secondary" className="flex-1" onClick={() => setAction({ kind: 'detail', tool: t })}>
                              Details
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {tab === 'out' && (
            <section className="space-y-4" aria-label="Checked out tools">
              {groups.length > 1 && (
                <div className="max-w-xs">
                  <label htmlFor="tech-filter" className={labelClass}>
                    Technician
                  </label>
                  <select id="tech-filter" className={selectClass} value={techFilter} onChange={(e) => setTechFilter(e.target.value)}>
                    <option value="all">Everyone ({groups.length})</option>
                    {groups.map((g) => (
                      <option key={g.key} value={g.key}>
                        {g.name} ({g.loans.length})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {groups.length === 0 ? (
                <EmptyState icon={ArrowUpFromLine} title="Nothing is checked out" description="Every tool is back in the crib." />
              ) : (
                visibleGroups.map((g) => (
                  <div key={g.key} className={panelClass}>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-semibold text-text-primary">{g.name}</h3>
                      <span className="text-xs text-text-secondary">
                        {g.loans.length} {g.loans.length === 1 ? 'tool' : 'tools'}
                        {g.late > 0 ? ` · ${g.late} late` : ''}
                      </span>
                    </div>
                    <ul className="divide-y divide-border">
                      {g.loans.map((l) => (
                        <LoanRow key={l.id} loan={l} now={now} lostAfter={lostAfter} onCheckIn={() => setAction({ kind: 'checkin', loan: l })} onExtend={() => setAction({ kind: 'extend', loan: l })} />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </section>
          )}

          {tab === 'alerts' && (
            <section className="space-y-4" aria-label="Alerts">
              {alertCount === 0 ? (
                <EmptyState
                  icon={Clock}
                  title="No overdue or lost tools"
                  description={
                    settings.alerts_enabled
                      ? 'You will get a notification when a tool passes its return time, and again if it looks lost.'
                      : 'Alerts are turned off in the crib settings. Overdue tools still show here.'
                  }
                />
              ) : (
                <>
                  {alerts.length > 0 && (
                    <div className={panelClass}>
                      <h3 className="mb-1 font-semibold text-text-primary">Overdue and possibly lost</h3>
                      <p className="mb-2 text-xs text-text-secondary">
                        A tool is flagged as possibly lost {settings.lost_after_hours}h after its due time.
                      </p>
                      <ul className="divide-y divide-border">
                        {alerts.map((l) => (
                          <LoanRow
                            key={l.id}
                            loan={l}
                            now={now}
                            lostAfter={lostAfter}
                            showTool
                            onCheckIn={() => setAction({ kind: 'checkin', loan: l })}
                            onExtend={() => setAction({ kind: 'extend', loan: l })}
                            onLost={
                              canManage
                                ? () => {
                                    const t = tools.find((x) => x.id === l.tool_id);
                                    if (t) setAction({ kind: 'lost', tool: t });
                                  }
                                : undefined
                            }
                          />
                        ))}
                      </ul>
                    </div>
                  )}
                  {lostTools.length > 0 && (
                    <div className={panelClass}>
                      <h3 className="mb-2 font-semibold text-text-primary">Marked lost</h3>
                      <ul className="divide-y divide-border">
                        {lostTools.map((t) => {
                          const lostLoan = loans.find((l) => l.tool_id === t.id && l.status === 'lost');
                          return (
                            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                              <div className="min-w-0">
                                <p className="truncate font-medium text-text-primary">{t.name}</p>
                                <p className="text-xs text-text-secondary">
                                  {t.tool_number}
                                  {lostLoan ? ` · last with ${lostLoan.technician_name}` : ''}
                                  {lostLoan?.lost_at ? ` · lost ${fmtDateTime(lostLoan.lost_at)}` : ''}
                                </p>
                              </div>
                              {canManage && (
                                <Button size="sm" variant="secondary" onClick={() => setAction({ kind: 'recover', tool: t })}>
                                  Found it
                                </Button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}

      {action?.kind === 'scan' && (
        <ScanSheet
          onClose={() => setAction(null)}
          onCode={(c) => {
            setAction(null);
            handleCode(c);
          }}
        />
      )}
      {action?.kind === 'checkout' && options && (
        <CheckOutSheet tool={action.tool} options={options} toast={toast} onClose={() => setAction(null)} onDone={done} />
      )}
      {action?.kind === 'checkin' && <CheckInSheet loan={action.loan} toast={toast} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'extend' && <ExtendSheet loan={action.loan} toast={toast} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'lost' && <LostSheet tool={action.tool} toast={toast} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'recover' && <RecoverSheet tool={action.tool} toast={toast} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'edit' && <EditSheet input={action.input} toast={toast} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'settings' && options && (
        <SettingsSheet settings={options.settings} toast={toast} onClose={() => setAction(null)} onDone={(m) => { done(m); void loadAll(); }} />
      )}
      {action?.kind === 'detail' && (
        <DetailSheet
          tool={tools.find((t) => t.id === action.tool.id) ?? action.tool}
          loan={openLoanByTool.get(action.tool.id) ?? null}
          accountOwnerId={accountOwnerId}
          canManage={canManage}
          canViewCosts={canViewCosts}
          toast={toast}
          onClose={() => setAction(null)}
          onAction={setAction}
          onChanged={(m) => { toast(m, 'success'); void refresh(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// ROWS
// ============================================================

function LoanRow({
  loan,
  now,
  lostAfter,
  showTool,
  onCheckIn,
  onExtend,
  onLost,
}: {
  loan: CribLoan;
  now: number;
  lostAfter: number;
  showTool?: boolean;
  onCheckIn: () => void;
  onExtend: () => void;
  onLost?: () => void;
}) {
  const st = loanState(loan, now, lostAfter);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-text-primary">{loan.tool_name}</p>
        <p className="text-xs text-text-secondary">
          {loan.tool_number}
         {showTool ? ` · ${loan.technician_name}` : ''}
          {loan.vehicle_label ? ` · ${loan.vehicle_label}` : ''} · {dueLabel(loan, now)}
          {loan.extended_count > 0 ? ` · extended ${loan.extended_count}×` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill text={LOAN_STATE_LABELS[st]} tone={loanStateTone(st)} />
        <Button size="sm" onClick={onCheckIn}>
          Check in
        </Button>
        <Button size="sm" variant="secondary" onClick={onExtend}>
          Extend
        </Button>
        {onLost && (
          <Button size="sm" variant="ghost" onClick={onLost}>
            Mark lost
          </Button>
        )}
      </div>
    </li>
  );
}

// ============================================================
// SHEETS
// ============================================================

interface SheetProps {
  toast: ToastFn;
  onClose: () => void;
  onDone: (message: string) => void;
}

function ScanSheet({ onClose, onCode }: { onClose: () => void; onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const { value } = await scanCode(videoRef.current, abort.signal);
        if (!abort.signal.aborted) onCodeRef.current(value);
      } catch (e) {
        if (!abort.signal.aborted) setErr(e instanceof Error ? e.message : 'Could not start the scanner.');
      }
    })();
    return () => abort.abort();
  }, []);

  return (
    <Sheet title="Scan a tool tag" onClose={onClose}>
      <video ref={videoRef} muted playsInline className={isNative() ? 'hidden' : 'aspect-video w-full rounded-xl bg-black object-cover'} />
      <p className="mt-3 text-sm text-text-secondary" role={err ? 'alert' : undefined}>
        {err ?? 'Point the camera at the barcode or tag number on the tool.'}
      </p>
      <Button variant="secondary" className="mt-4 w-full" onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

function CheckOutSheet({ tool, options, toast, onClose, onDone }: SheetProps & { tool: CribTool; options: CribOptions }) {
  const defaultHours = tool.default_loan_hours ?? options.settings.default_loan_hours;
  const [techId, setTechId] = useState(options.self_member_id ?? '');
  const [vehicleId, setVehicleId] = useState(() => defaultVehicleFor(options.vehicles, options.self_member_id));
  const [hours, setHours] = useState(String(defaultHours));
  const [condition, setCondition] = useState<'good' | 'worn'>('good');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!techId) {
      setError('Choose who is taking the tool');
      return;
    }
    const h = parseWholeNumber(hours, 1, 720, 'Loan length');
    if (!h.ok) {
      setError(h.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await checkOutCribTool({ toolId: tool.id, technicianId: techId, loanHours: h.value, condition, note, vehicleId: vehicleId || null });
      onDone(`${r.tool_name} checked out to ${r.technician_name}${r.vehicle_label ? ` (${r.vehicle_label})` : ''}`);
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Check out ${tool.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="co-tech" className={labelClass}>
            Taken by
          </label>
          <select id="co-tech" className={selectClass} value={techId} onChange={(e) => {
              setTechId(e.target.value);
              const v = defaultVehicleFor(options.vehicles, e.target.value);
              if (v) setVehicleId(v);
            }} disabled={busy || options.self_only}>
            <option value="">Choose a team member…</option>
            {options.technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {options.technicians.length === 0 && (
            <p className="mt-1.5 text-xs text-text-secondary">No active team members yet. Invite your technicians from the Team page.</p>
          )}
        </div>
        {options.vehicles.length > 0 && (
          <div>
            <label htmlFor="co-vehicle" className={labelClass}>
              Vehicle (optional)
            </label>
            <select id="co-vehicle" className={selectClass} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} disabled={busy}>
              <option value="">No vehicle</option>
              {options.vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.plate ? ` (${v.plate})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <Input label="Return within (hours)" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} disabled={busy} helperText="Default comes from the tool or the crib settings." />
        <div>
          <label htmlFor="co-cond" className={labelClass}>
            Condition now
          </label>
          <select id="co-cond" className={selectClass} value={condition} onChange={(e) => setCondition(e.target.value as 'good' | 'worn')} disabled={busy}>
            <option value="good">{CONDITION_LABELS.good}</option>
            <option value="worn">{CONDITION_LABELS.worn}</option>
          </select>
        </div>
        <Textarea label="Note (optional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Checking out…' : 'Check out'}
        </Button>
      </div>
    </Sheet>
  );
}

function CheckInSheet({ loan, toast, onClose, onDone }: SheetProps & { loan: CribLoan }) {
  const [condition, setCondition] = useState<ToolCondition>('good');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (condition === 'damaged' && note.trim().length < 3) {
      setError('Add a short note about the damage');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await checkInCribTool({ loanId: loan.id, condition, note });
      onDone(r.tool_status === 'maintenance' ? `${loan.tool_name} returned and sent to maintenance` : `${loan.tool_name} checked in`);
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Check in ${loan.tool_name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Held by <span className="font-medium text-text-primary">{loan.technician_name}</span> since {fmtDateTime(loan.checked_out_at)}.
        </p>
        <div>
          <label htmlFor="ci-cond" className={labelClass}>
            Condition on return
          </label>
          <select id="ci-cond" className={selectClass} value={condition} onChange={(e) => setCondition(e.target.value as ToolCondition)} disabled={busy}>
            <option value="good">{CONDITION_LABELS.good}</option>
            <option value="worn">{CONDITION_LABELS.worn}</option>
            <option value="damaged">{CONDITION_LABELS.damaged} — send to maintenance</option>
          </select>
        </div>
        <Textarea label="Note (optional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Checking in…' : 'Check in'}
        </Button>
      </div>
    </Sheet>
  );
}

function ExtendSheet({ loan, toast, onClose, onDone }: SheetProps & { loan: CribLoan }) {
  const [hours, setHours] = useState('24');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const h = parseWholeNumber(hours, 1, 168, 'Extension');
    if (!h.ok) {
      setError(h.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await extendCribLoan(loan.id, h.value, note);
      onDone(`${loan.tool_name} extended by ${h.value}h`);
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Extend ${loan.tool_name}`} onClose={onClose}>
      <div className="space-y-4">
        <Input label="Extend by (hours)" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} disabled={busy} helperText="Counted from the current due time, or from now if it is already overdue." />
        <Textarea label="Reason (optional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Extending…' : 'Extend loan'}
        </Button>
      </div>
    </Sheet>
  );
}

function LostSheet({ tool, toast, onClose, onDone }: SheetProps & { tool: CribTool }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await markCribToolLost(tool.id, note);
      onDone(`${tool.name} marked lost`);
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Mark ${tool.name} lost?`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          The tool can't be checked out while it is lost. If it turns up later you can use "Found it" to put it back in the crib.
        </p>
        <Textarea label="What happened? (optional)" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button className="flex-1 !bg-danger" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Saving…' : 'Mark lost'}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function RecoverSheet({ tool, toast, onClose, onDone }: SheetProps & { tool: CribTool }) {
  const [condition, setCondition] = useState<ToolCondition>('good');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await recoverCribTool(tool.id, condition, note);
      onDone(`${tool.name} is back in the crib`);
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`${tool.name} found`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="rc-cond" className={labelClass}>
            Condition
          </label>
          <select id="rc-cond" className={selectClass} value={condition} onChange={(e) => setCondition(e.target.value as ToolCondition)} disabled={busy}>
            <option value="good">{CONDITION_LABELS.good}</option>
            <option value="worn">{CONDITION_LABELS.worn}</option>
            <option value="damaged">{CONDITION_LABELS.damaged} — send to maintenance</option>
          </select>
        </div>
        <Textarea label="Note (optional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : 'Return to crib'}
        </Button>
      </div>
    </Sheet>
  );
}

function EditSheet({ input, toast, onClose, onDone }: SheetProps & { input: ToolInput }) {
  const [form, setForm] = useState<ToolInput>(input);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof ToolInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (busy) return;
    if (!form.tool_number.trim() || !form.name.trim()) {
      setError('Tag number and name are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveCribTool(form);
      onDone(form.id ? 'Tool updated' : 'Tool added');
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title={form.id ? 'Edit tool' : 'Add a tool'} onClose={onClose}>
      <div className="space-y-4">
        <Input label="Name" required maxLength={120} value={form.name} onChange={set('name')} disabled={busy} />
        <Input label="Tag number" required maxLength={40} value={form.tool_number} onChange={set('tool_number')} disabled={busy} helperText="Your own asset tag, e.g. DR-014. Must be unique." />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Category" maxLength={60} value={form.category} onChange={set('category')} disabled={busy} />
          <Input label="Serial number" maxLength={80} value={form.serial_number} onChange={set('serial_number')} disabled={busy} />
        </div>
        <Input label="Barcode" maxLength={128} value={form.barcode} onChange={set('barcode')} disabled={busy} helperText="Optional. Scanning it finds this tool instantly." />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Purchase cost ($)" inputMode="decimal" value={form.cost} onChange={set('cost')} disabled={busy} />
          <Input label="Default loan (hours)" inputMode="numeric" value={form.loan_hours} onChange={set('loan_hours')} disabled={busy} helperText="Blank = crib default" />
        </div>
        <Textarea label="Notes" rows={2} maxLength={1000} value={form.notes} onChange={set('notes')} disabled={busy} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : form.id ? 'Save changes' : 'Add tool'}
        </Button>
      </div>
    </Sheet>
  );
}

function SettingsSheet({ settings, toast, onClose, onDone }: SheetProps & { settings: CribSettings }) {
  const [loanHours, setLoanHours] = useState(String(settings.default_loan_hours));
  const [lostHours, setLostHours] = useState(String(settings.lost_after_hours));
  const [alertsOn, setAlertsOn] = useState(settings.alerts_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const a = parseWholeNumber(loanHours, 1, 720, 'Default loan length');
    const b = parseWholeNumber(lostHours, 1, 2160, 'Lost threshold');
    if (!a.ok) return setError(a.error);
    if (!b.ok) return setError(b.error);
    setBusy(true);
    setError(null);
    try {
      await saveCribSettings({ default_loan_hours: a.value, lost_after_hours: b.value, alerts_enabled: alertsOn });
      onDone('Crib settings saved');
    } catch (e) {
      const m = cribErrorMessage(e);
      setError(m);
      toast(m, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet title="Crib settings" onClose={onClose}>
      <div className="space-y-4">
        <Input label="Default loan length (hours)" inputMode="numeric" value={loanHours} onChange={(e) => setLoanHours(e.target.value)} disabled={busy} />
        <Input
          label="Flag as possibly lost after (hours overdue)"
          inputMode="numeric"
          value={lostHours}
          onChange={(e) => setLostHours(e.target.value)}
          disabled={busy}
          helperText="Counted from the due time."
        />
        <label className="flex items-center gap-3 text-sm text-text-primary">
          <input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} disabled={busy} className="h-5 w-5 accent-[var(--color-accent,#2563eb)]" />
          Send overdue and possibly-lost notifications
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </Sheet>
  );
}

function DetailSheet({
  tool,
  loan,
  accountOwnerId,
  canManage,
  canViewCosts,
  toast,
  onClose,
  onAction,
  onChanged,
}: {
  tool: CribTool;
  loan: CribLoan | null;
  accountOwnerId: string;
  canManage: boolean;
  canViewCosts: boolean;
  toast: ToastFn;
  onClose: () => void;
  onAction: (a: Action) => void;
  onChanged: (message: string) => void;
}) {
  const [events, setEvents] = useState<CribEvent[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      setEvents(await listToolEvents(accountOwnerId, tool.id));
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [accountOwnerId, tool.id]);

  useEffect(() => {
    void load();
  }, [load, tool.status]);

  const changeStatus = async (to: 'available' | 'maintenance' | 'retired') => {
    if (busy) return;
    setBusy(true);
    try {
      await setCribToolStatus(tool.id, to, '');
      onChanged(`${tool.name} is now ${TOOL_STATUS_LABELS[to].toLowerCase()}`);
    } catch (e) {
      toast(cribErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const canChangeStatus = canManage && tool.status !== 'checked_out' && tool.status !== 'lost';

  return (
    <Sheet title={tool.name} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill text={TOOL_STATUS_LABELS[tool.status]} tone={toolStatusTone(tool.status)} />
          <span className="text-sm text-text-secondary">
            {tool.tool_number}
            {tool.category ? ` · ${tool.category}` : ''}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {tool.serial_number && (
            <>
              <dt className="text-text-secondary">Serial</dt>
              <dd className="text-text-primary">{tool.serial_number}</dd>
            </>
          )}
          {tool.barcode && (
            <>
              <dt className="text-text-secondary">Barcode</dt>
              <dd className="break-all text-text-primary">{tool.barcode}</dd>
            </>
          )}
          {canViewCosts && tool.purchase_cost_cents !== null && (
            <>
              <dt className="text-text-secondary">Purchase cost</dt>
              <dd className="text-text-primary">{formatCostCents(tool.purchase_cost_cents)}</dd>
            </>
          )}
          {loan && (
            <>
              <dt className="text-text-secondary">Held by</dt>
              <dd className="text-text-primary">
                {loan.technician_name} · {dueLabel(loan, Date.now())}
              </dd>
              {loan.vehicle_label && (
                <>
                  <dt className="text-text-secondary">Vehicle</dt>
                  <dd className="text-text-primary">{loan.vehicle_label}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {tool.notes && <p className="rounded-xl bg-bg-secondary p-3 text-sm text-text-secondary">{tool.notes}</p>}

        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => onAction({ kind: 'edit', input: toolToInput(tool) })}>
              <Pencil size={14} /> Edit
            </Button>
            {canChangeStatus && tool.status !== 'maintenance' && tool.status !== 'retired' && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void changeStatus('maintenance')}>
                Send to maintenance
              </Button>
            )}
            {canChangeStatus && (tool.status === 'maintenance' || tool.status === 'retired') && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void changeStatus('available')}>
                Make available
              </Button>
            )}
            {canChangeStatus && tool.status !== 'retired' && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void changeStatus('retired')}>
                Retire
              </Button>
            )}
            {tool.status !== 'lost' && tool.status !== 'retired' && (
              <Button size="sm" variant="ghost" onClick={() => onAction({ kind: 'lost', tool })}>
                Mark lost
              </Button>
            )}
            {tool.status === 'lost' && (
              <Button size="sm" onClick={() => onAction({ kind: 'recover', tool })}>
                Found it
              </Button>
            )}
          </div>
        )}

        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <History size={16} /> History
          </h3>
          {phase === 'loading' && <SkeletonCardList count={2} rows={1} />}
          {phase === 'error' && (
            <p className="text-sm text-text-secondary">
              Couldn't load the history.{' '}
              <button type="button" className="focus-ring rounded font-medium text-accent underline" onClick={() => void load()}>
                Retry
              </button>
            </p>
          )}
          {phase === 'ready' && events.length === 0 && <p className="text-sm text-text-secondary">No activity yet.</p>}
          {phase === 'ready' && events.length > 0 && (
            <ol className="space-y-2">
              {events.map((ev) => (
                <li key={ev.id} className="rounded-xl bg-bg-secondary px-3 py-2 text-sm">
                  <p className="font-medium text-text-primary">{EVENT_LABELS[ev.event_type]}</p>
                  {ev.note && <p className="text-text-secondary">{ev.note}</p>}
                  <p className="text-xs text-text-secondary">
                    {fmtDateTime(ev.created_at)}
                    {ev.actor_name ? ` · ${ev.actor_name}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Sheet>
  );
}
