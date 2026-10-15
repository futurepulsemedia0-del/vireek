import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, History, Layers, Lock, LockKeyhole, Pencil, Plus, Power, RefreshCw, Search, Unlock, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonTable, FadeIn } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import type { AccountType } from '@/lib/accounting';
import {
  ACCOUNT_TYPES, buildAccountRows, countUnmapped, createAccount, describeAuditEvent, descendantIds, errMsg, fetchAccountsOverview,
  fetchAuditEvents, fetchPeriods, fetchServiceMappings, filterRows, isContra, lockPeriodsThrough, lockedThroughLabel, mapService, money,
  monthName, seedStandardChart, setAccountActive, setPeriodStatus, suggestNextCode, summarizeAccounts, typeMeta, unmapService,
  updateAccount, validateAccountDraft,
  type AccountDraft, type AuditEvent, type CoaAccount, type DraftErrors, type PeriodRow, type ServiceMappingRow,
} from '@/lib/chartOfAccounts';

type Tab = 'accounts' | 'services' | 'periods' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'services', label: 'Service mapping' },
  { id: 'periods', label: 'Period locking' },
  { id: 'activity', label: 'Activity' },
];

const TYPE_BADGE: Record<AccountType, string> = {
  asset: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
  liability: 'bg-warning-500/10 text-warning-500',
  equity: 'bg-purple-500/10 text-purple-600 dark:text-purple-300',
  revenue: 'bg-success/10 text-success',
  expense: 'bg-danger/10 text-danger',
};

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </Card>
  );
}

const emptyDraft = (type: AccountType = 'asset', code = ''): AccountDraft => ({ code, name: '', type, contra: false, parentId: '', description: '' });

// ---------------------------------------------------------------------------
// Account editor dialog
// ---------------------------------------------------------------------------

function AccountEditor({
  editing, accounts, onClose, onSaved,
}: {
  editing: CoaAccount | null;
  accounts: CoaAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [draft, setDraft] = useState<AccountDraft>(() =>
    editing
      ? { code: editing.code, name: editing.name, type: editing.type, contra: isContra(editing), parentId: editing.parent_account_id ?? '', description: editing.description ?? '' }
      : emptyDraft('asset', suggestNextCode(accounts, 'asset')),
  );
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const errors: DraftErrors = useMemo(() => validateAccountDraft(draft, accounts, editing?.id ?? null), [draft, accounts, editing]);
  const hasErrors = Object.keys(errors).length > 0;

  const typeLockReason = editing
    ? editing.is_system
      ? 'System accounts keep their type.'
      : editing.line_count > 0
        ? 'This account has ledger activity, so its type is locked.'
        : ''
    : '';
  const codeLocked = !!editing?.is_system;

  const parentOptions = useMemo(() => {
    const blocked = editing ? descendantIds(accounts, editing.id) : new Set<string>();
    return accounts.filter((a) => a.type === draft.type && !blocked.has(a.id) && (a.is_active || a.id === draft.parentId));
  }, [accounts, draft.type, draft.parentId, editing]);

  const set = <K extends keyof AccountDraft>(k: K, v: AccountDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const changeType = (type: AccountType) =>
    setDraft((d) => ({
      ...d,
      type,
      parentId: '',
      contra: false,
      code: !editing && (d.code === '' || d.code === suggestNextCode(accounts, d.type)) ? suggestNextCode(accounts, type) : d.code,
    }));

  const submit = async () => {
    setTouched(true);
    if (hasErrors || saving) return;
    setSaving(true);
    setServerError('');
    try {
      if (editing) await updateAccount(editing.id, draft);
      else await createAccount(draft);
      toast(editing ? 'Account updated.' : 'Account created.', 'success');
      onSaved();
    } catch (e) {
      const msg = errMsg(e);
      setServerError(msg);
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const shown = (k: keyof DraftErrors) => (touched ? errors[k] : undefined);

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="coa-editor-title"
        className="fixed inset-x-0 bottom-0 z-[120] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[92vw] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="coa-editor-title" className="text-lg font-semibold text-text-primary">{editing ? 'Edit account' : 'New account'}</h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              {editing ? `${editing.code} · ${editing.name}` : 'Accounts you add here are available to invoices, bills and bank categorization.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="coa-type" className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
            <select id="coa-type" value={draft.type} onChange={(e) => changeType(e.target.value as AccountType)} disabled={!!typeLockReason} className={selectClass}>
              {ACCOUNT_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
            </select>
            <p className="mt-1.5 text-xs text-text-secondary">{typeLockReason || typeMeta(draft.type).hint}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Code" required value={draft.code} disabled={codeLocked} maxLength={16}
              onChange={(e) => set('code', e.target.value)} error={shown('code')}
              helperText={codeLocked ? 'System code is fixed.' : undefined}
            />
            <div className="sm:col-span-2">
              <Input label="Name" required value={draft.name} maxLength={120} onChange={(e) => set('name', e.target.value)} error={shown('name')} />
            </div>
          </div>

          <div>
            <label htmlFor="coa-parent" className="mb-1.5 block text-sm font-medium text-text-primary">Parent account (optional)</label>
            <select id="coa-parent" value={draft.parentId} onChange={(e) => set('parentId', e.target.value)} className={selectClass}>
              <option value="">None — top level</option>
              {parentOptions.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
            {shown('parent') && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.parent}</p>}
          </div>

          <label className={`flex items-start gap-3 rounded-xl border border-border p-3 text-sm ${typeLockReason ? 'opacity-60' : ''}`}>
            <input
              type="checkbox" className="mt-0.5 h-4 w-4" checked={draft.contra} disabled={!!typeLockReason}
              onChange={(e) => set('contra', e.target.checked)}
            />
            <span>
              <span className="font-medium text-text-primary">Contra account</span>
              <span className="block text-xs text-text-secondary">
                Balances on the opposite side of its type (normal balance: {draft.contra ? (typeMeta(draft.type).natural === 'debit' ? 'credit' : 'debit') : typeMeta(draft.type).natural}). Use for things like accumulated depreciation or refunds.
              </span>
            </span>
          </label>

          <Textarea label="Description (optional)" rows={3} maxLength={500} value={draft.description} onChange={(e) => set('description', e.target.value)} error={shown('description')} />

          {serverError && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-text-primary">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
              <span>{serverError}</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" className="flex-1" onClick={submit} disabled={saving || (touched && hasErrors)}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create account'}
          </Button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reason dialog (reopen a period)
// ---------------------------------------------------------------------------

function ReasonDialog({
  title, description, confirmLabel, onConfirm, onCancel,
}: {
  title: string; description: string; confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>; onCancel: () => void;
}) {
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onCancel);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim().length >= 5;
  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div
        ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="coa-reason-title"
        className="fixed left-1/2 top-1/2 z-[120] w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover"
      >
        <h2 id="coa-reason-title" className="text-base font-semibold text-text-primary">{title}</h2>
        <p className="mt-1.5 text-sm text-text-secondary">{description}</p>
        <div className="mt-4">
          <Textarea label="Reason" required rows={3} maxLength={300} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} helperText="At least 5 characters. Saved to the activity log." />
        </div>
        <div className="mt-5 flex gap-3">
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button
            type="button" size="sm" className="flex-1" disabled={!valid || busy}
            onClick={async () => { setBusy(true); try { await onConfirm(reason); } finally { setBusy(false); } }}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ChartOfAccountsPage() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [tab, setTab] = useState<Tab>('accounts');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [accounts, setAccounts] = useState<CoaAccount[]>([]);
  const [services, setServices] = useState<ServiceMappingRow[]>([]);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [periodsLoading, setPeriodsLoading] = useState(false);
  const [periodsFailed, setPeriodsFailed] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditFailed, setAuditFailed] = useState(false);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<AccountType | 'all'>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [editor, setEditor] = useState<{ editing: CoaAccount | null } | null>(null);
  const [deactivating, setDeactivating] = useState<CoaAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [customService, setCustomService] = useState({ name: '', accountId: '' });
  const [reopening, setReopening] = useState<PeriodRow | null>(null);
  const [lockTarget, setLockTarget] = useState<string>('');
  const [confirmLock, setConfirmLock] = useState(false);

  const loadCore = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [a, s] = await Promise.all([fetchAccountsOverview(), fetchServiceMappings()]);
      setAccounts(a);
      setServices(s);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, canAccess]);

  const loadPeriods = useCallback(async () => {
    if (!user || !canAccess) return;
    setPeriodsLoading(true);
    setPeriodsFailed(false);
    try {
      setPeriods(await fetchPeriods(year));
    } catch {
      setPeriodsFailed(true);
    } finally {
      setPeriodsLoading(false);
    }
  }, [user, canAccess, year]);

  const loadAudit = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setAuditFailed(false);
    try {
      setAudit(await fetchAuditEvents(accountOwnerId));
    } catch {
      setAuditFailed(true);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => { void loadCore(); }, [loadCore]);
  useEffect(() => { void loadPeriods(); }, [loadPeriods]);
  useEffect(() => { if (tab === 'activity') void loadAudit(); }, [tab, loadAudit]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadCore(), loadPeriods(), tab === 'activity' ? loadAudit() : Promise.resolve()]);
  }, [loadCore, loadPeriods, loadAudit, tab]);

  const rows = useMemo(() => buildAccountRows(accounts), [accounts]);
  const visibleRows = useMemo(() => filterRows(rows, { query, type: typeFilter, showInactive }), [rows, query, typeFilter, showInactive]);
  const summary = useMemo(() => summarizeAccounts(accounts), [accounts]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const revenueAccounts = useMemo(() => accounts.filter((a) => a.type === 'revenue' && a.is_active), [accounts]);
  const unmapped = countUnmapped(services);
  const lockedThrough = lockedThroughLabel(periods);
  const visibleServices = useMemo(() => (onlyUnmapped ? services.filter((s) => !s.mapping_id) : services), [services, onlyUnmapped]);
  const currentMonthStart = useMemo(() => new Date().toISOString().slice(0, 7) + '-01', []);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const seed = () => run('seed', async () => { await seedStandardChart(); await loadCore(); }, 'Standard chart of accounts created.');

  const toggleActive = (a: CoaAccount) =>
    run(`active-${a.id}`, async () => { await setAccountActive(a.id, !a.is_active); await loadCore(); }, a.is_active ? 'Account deactivated.' : 'Account reactivated.');

  const assignService = (s: ServiceMappingRow, accountId: string) => {
    if (!accountId) return;
    void run(`svc-${s.service_name}`, async () => { await mapService(s.service_name, accountId, s.notes ?? undefined); setServices(await fetchServiceMappings()); await loadCore(); }, `“${s.service_name}” mapped.`);
  };

  const removeMapping = (s: ServiceMappingRow) => {
    if (!s.mapping_id) return;
    const id = s.mapping_id;
    void run(`svc-${s.service_name}`, async () => { await unmapService(id); setServices(await fetchServiceMappings()); await loadCore(); }, 'Mapping removed.');
  };

  const addCustomService = () => {
    const name = customService.name.trim();
    if (!name || !customService.accountId) {
      toast('Enter a service name and choose a revenue account.', 'error');
      return;
    }
    void run('svc-custom', async () => {
      await mapService(name, customService.accountId);
      setCustomService({ name: '', accountId: '' });
      setServices(await fetchServiceMappings());
      await loadCore();
    }, `“${name}” mapped.`);
  };

  const closePeriod = (p: PeriodRow) =>
    run(`period-${p.period_start}`, async () => { await setPeriodStatus(p.period_start, 'closed'); await loadPeriods(); }, `${monthName(p.period_start)} ${year} closed.`);

  const lockThrough = () =>
    run('lock', async () => {
      const n = await lockPeriodsThrough(lockTarget);
      setConfirmLock(false);
      await loadPeriods();
      if (n === 0) toast('Those months were already closed.', 'info');
    }, 'Periods locked.');

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Chart of Accounts">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const yearBounds = { min: 2000, max: new Date().getFullYear() + 1 };

  return (
    <DashboardLayout activeLabel="Chart of Accounts">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Layers size={22} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Chart of Accounts</h1>
            <p className="text-sm text-text-secondary">Define the accounts your books post to, route each service to the right revenue account, and lock closed months.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void refreshAll()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
          {tab === 'accounts' && !loadFailed && (
            <Button type="button" size="sm" onClick={() => setEditor({ editing: null })}>
              <Plus size={14} /> New account
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : loadFailed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load the chart of accounts" description="Check your connection and try again." onRetry={() => void loadCore()} />
      ) : (
        <FadeIn>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Active accounts" value={summary.active} sub={summary.inactive ? `${summary.inactive} inactive` : undefined} />
            <Stat label="With ledger activity" value={summary.withActivity} sub="Type is locked once used" />
            <Stat label="Unmapped services" value={unmapped} sub={unmapped ? 'Posting to the default account' : 'All routed'} />
            <Stat label="Locked through" value={lockedThrough ?? 'Nothing locked'} sub={`Showing ${year}`} />
          </div>

          <div role="tablist" aria-label="Chart of accounts sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.id} type="button" role="tab" aria-selected={tab === t.id} id={`coa-tab-${t.id}`} aria-controls={`coa-panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`focus-ring shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}
              >
                {t.label}
                {t.id === 'services' && unmapped > 0 && <span className="ml-1.5 rounded-full bg-warning-500/20 px-1.5 text-[11px] font-semibold text-warning-500">{unmapped}</span>}
              </button>
            ))}
          </div>

          {/* ------------------------------ ACCOUNTS ------------------------------ */}
          {tab === 'accounts' && (
            <section role="tabpanel" id="coa-panel-accounts" aria-labelledby="coa-tab-accounts">
              {accounts.length === 0 ? (
                <EmptyState
                  icon={Layers}
                  title="No accounts yet"
                  description="Start from the standard home-service chart (cash, receivables, revenue, payroll, fuel and more) and adjust it, or add your own accounts."
                  action={{ label: busy === 'seed' ? 'Creating…' : 'Create standard chart', onClick: () => void seed() }}
                  secondaryAction={{ label: 'Add an account', onClick: () => setEditor({ editing: null }) }}
                />
              ) : (
                <>
                  <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="lg:w-72">
                      <Input icon={Search} placeholder="Search code, name or description" aria-label="Search accounts" value={query} onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      {([{ type: 'all', label: 'All' }, ...ACCOUNT_TYPES] as { type: AccountType | 'all'; label: string }[]).map((t) => (
                        <button
                          key={t.type} type="button" aria-pressed={typeFilter === t.type} onClick={() => setTypeFilter(t.type)}
                          className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${typeFilter === t.type ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                        >
                          {t.label}
                        </button>
                      ))}
                      <label className="ml-auto flex items-center gap-2 text-xs text-text-secondary">
                        <input type="checkbox" className="h-4 w-4" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                        Show inactive
                      </label>
                    </div>
                  </div>

                  {visibleRows.length === 0 ? (
                    <EmptyState icon={Search} title="No accounts match" description="Try a different search or filter." action={{ label: 'Clear filters', onClick: () => { setQuery(''); setTypeFilter('all'); setShowInactive(true); } }} />
                  ) : (
                    <>
                      {/* Desktop table */}
                      <div className="hidden overflow-x-auto rounded-2xl border border-border md:block">
                        <table className="w-full text-sm">
                          <thead className="bg-bg-tertiary text-left text-xs uppercase tracking-wide text-text-secondary">
                            <tr>
                              <th scope="col" className="px-4 py-3">Code</th>
                              <th scope="col" className="px-4 py-3">Account</th>
                              <th scope="col" className="px-4 py-3">Type</th>
                              <th scope="col" className="px-4 py-3 text-right">Balance</th>
                              <th scope="col" className="px-4 py-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border bg-bg-secondary">
                            {visibleRows.map(({ account: a, depth }) => (
                              <tr key={a.id} className={a.is_active ? '' : 'opacity-60'}>
                                <td className="px-4 py-3 font-mono text-text-primary">{a.code}</td>
                                <td className="px-4 py-3">
                                  <div style={{ paddingLeft: depth * 18 }}>
                                    <span className="font-medium text-text-primary">{a.name}</span>
                                    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                                      {a.is_system && <Pill className="bg-bg-tertiary text-text-secondary">System</Pill>}
                                      {isContra(a) && <Pill className="bg-bg-tertiary text-text-secondary">Contra</Pill>}
                                      {!a.is_active && <Pill className="bg-bg-tertiary text-text-secondary">Inactive</Pill>}
                                      {a.mapping_count > 0 && <Pill className="bg-accent/10 text-accent">{a.mapping_count} service{a.mapping_count === 1 ? '' : 's'}</Pill>}
                                    </span>
                                    {a.description && <p className="mt-0.5 text-xs text-text-secondary">{a.description}</p>}
                                  </div>
                                </td>
                                <td className="px-4 py-3"><Pill className={TYPE_BADGE[a.type]}>{typeMeta(a.type).label}</Pill></td>
                                <td className="px-4 py-3 text-right tabular-nums text-text-primary">{money(a.balance_cents)}</td>
                                <td className="px-4 py-3">
                                  <div className="flex justify-end gap-1">
                                    <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${a.name}`} onClick={() => setEditor({ editing: a })}><Pencil size={14} /></Button>
                                    {!a.is_system && (
                                      <Button
                                        type="button" variant="ghost" size="sm" disabled={busy === `active-${a.id}`}
                                        aria-label={`${a.is_active ? 'Deactivate' : 'Reactivate'} ${a.name}`}
                                        onClick={() => (a.is_active ? setDeactivating(a) : void toggleActive(a))}
                                      >
                                        <Power size={14} />
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile cards */}
                      <ul className="space-y-3 md:hidden">
                        {visibleRows.map(({ account: a, depth }) => (
                          <li key={a.id} className={a.is_active ? '' : 'opacity-60'} style={{ marginLeft: Math.min(depth, 3) * 12 }}>
                            <Card className="!p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="font-mono text-xs text-text-secondary">{a.code}</p>
                                  <p className="font-medium text-text-primary">{a.name}</p>
                                </div>
                                <p className="shrink-0 tabular-nums text-sm font-semibold text-text-primary">{money(a.balance_cents)}</p>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                <Pill className={TYPE_BADGE[a.type]}>{typeMeta(a.type).label}</Pill>
                                {a.is_system && <Pill className="bg-bg-tertiary text-text-secondary">System</Pill>}
                                {isContra(a) && <Pill className="bg-bg-tertiary text-text-secondary">Contra</Pill>}
                                {!a.is_active && <Pill className="bg-bg-tertiary text-text-secondary">Inactive</Pill>}
                                {a.mapping_count > 0 && <Pill className="bg-accent/10 text-accent">{a.mapping_count} service{a.mapping_count === 1 ? '' : 's'}</Pill>}
                              </div>
                              {a.description && <p className="mt-2 text-xs text-text-secondary">{a.description}</p>}
                              <div className="mt-3 flex gap-2">
                                <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={() => setEditor({ editing: a })}><Pencil size={14} /> Edit</Button>
                                {!a.is_system && (
                                  <Button
                                    type="button" variant="secondary" size="sm" className="flex-1" disabled={busy === `active-${a.id}`}
                                    onClick={() => (a.is_active ? setDeactivating(a) : void toggleActive(a))}
                                  >
                                    <Power size={14} /> {a.is_active ? 'Deactivate' : 'Reactivate'}
                                  </Button>
                                )}
                              </div>
                            </Card>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {/* --------------------------- SERVICE MAPPING --------------------------- */}
          {tab === 'services' && (
            <section role="tabpanel" id="coa-panel-services" aria-labelledby="coa-tab-services">
              <p className="mb-4 text-sm text-text-secondary">
                Services come from your price book and past jobs. Map each one to the revenue account it should post to; unmapped services fall back to Service Revenue (4000).
              </p>

              {revenueAccounts.length === 0 ? (
                <EmptyState
                  icon={Layers} title="Add a revenue account first" description="Service mapping needs at least one active revenue account."
                  action={{ label: 'Go to accounts', onClick: () => setTab('accounts') }}
                />
              ) : (
                <>
                  <Card className="mb-4 !p-4">
                    <p className="mb-3 text-sm font-medium text-text-primary">Map a service that isn't listed</p>
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                      <Input aria-label="Service name" placeholder="Service name, e.g. Water heater install" maxLength={120} value={customService.name} onChange={(e) => setCustomService((c) => ({ ...c, name: e.target.value }))} />
                      <select aria-label="Revenue account" className={selectClass} value={customService.accountId} onChange={(e) => setCustomService((c) => ({ ...c, accountId: e.target.value }))}>
                        <option value="">Revenue account…</option>
                        {revenueAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                      </select>
                      <Button type="button" size="sm" onClick={addCustomService} disabled={busy === 'svc-custom'}><Plus size={14} /> Add</Button>
                    </div>
                  </Card>

                  {services.length === 0 ? (
                    <EmptyState icon={Layers} title="No services found" description="Add items to your price book or complete jobs and they'll show up here, ready to map." />
                  ) : (
                    <>
                      <label className="mb-3 flex items-center gap-2 text-xs text-text-secondary">
                        <input type="checkbox" className="h-4 w-4" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} />
                        Show unmapped only ({unmapped})
                      </label>
                      {visibleServices.length === 0 ? (
                        <EmptyState icon={Layers} title="Everything is mapped" description="Every service posts to the account you chose." action={{ label: 'Show all services', onClick: () => setOnlyUnmapped(false) }} />
                      ) : (
                        <ul className="space-y-3">
                          {visibleServices.map((s) => {
                            const current = s.revenue_account_id ? accountById.get(s.revenue_account_id) : undefined;
                            const rowBusy = busy === `svc-${s.service_name}`;
                            return (
                              <li key={s.service_name.toLowerCase()}>
                                <Card className="!p-4">
                                  <div className="grid items-center gap-3 md:grid-cols-[1fr_minmax(0,18rem)_auto]">
                                    <div className="min-w-0">
                                      <p className="truncate font-medium text-text-primary">{s.service_name}</p>
                                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-text-secondary">
                                        {s.in_price_book && <span>In price book</span>}
                                        <span>{s.job_count} job{s.job_count === 1 ? '' : 's'}</span>
                                        {!s.mapping_id && <span className="font-medium text-warning-500">Unmapped</span>}
                                      </p>
                                    </div>
                                    <select
                                      aria-label={`Revenue account for ${s.service_name}`} className={selectClass} disabled={rowBusy}
                                      value={s.revenue_account_id ?? ''} onChange={(e) => assignService(s, e.target.value)}
                                    >
                                      <option value="">Default (4000 · Service Revenue)</option>
                                      {current && !current.is_active && <option value={current.id}>{current.code} · {current.name} (inactive)</option>}
                                      {revenueAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                                    </select>
                                    <div className="flex justify-end">
                                      {s.mapping_id && (
                                        <Button type="button" variant="ghost" size="sm" disabled={rowBusy} onClick={() => removeMapping(s)} aria-label={`Remove mapping for ${s.service_name}`}>
                                          <X size={14} /> Remove
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                </Card>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {/* --------------------------- PERIOD LOCKING --------------------------- */}
          {tab === 'periods' && (
            <section role="tabpanel" id="coa-panel-periods" aria-labelledby="coa-tab-periods">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-xl text-sm text-text-secondary">
                  A closed month rejects any new journal entry dated inside it — invoices, bills, payments and manual entries alike. Only the account owner can reopen one, and every change is logged.
                </p>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="secondary" size="sm" aria-label="Previous year" disabled={year <= yearBounds.min} onClick={() => setYear((y) => y - 1)}><ChevronLeft size={16} /></Button>
                  <span className="min-w-[4rem] text-center text-sm font-semibold text-text-primary">{year}</span>
                  <Button type="button" variant="secondary" size="sm" aria-label="Next year" disabled={year >= yearBounds.max} onClick={() => setYear((y) => y + 1)}><ChevronRight size={16} /></Button>
                </div>
              </div>

              {periodsLoading ? (
                <SkeletonTable rows={6} columns={3} />
              ) : periodsFailed ? (
                <EmptyStateError icon={AlertTriangle} title="Couldn't load periods" onRetry={() => void loadPeriods()} />
              ) : (
                <>
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {periods.map((p) => {
                      const closed = p.status === 'closed';
                      const future = p.period_start > currentMonthStart;
                      const rowBusy = busy === `period-${p.period_start}`;
                      return (
                        <li key={p.period_start}>
                          <Card className="!p-4">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="font-medium text-text-primary">{monthName(p.period_start)}</p>
                                <p className="text-xs text-text-secondary">{p.entry_count} posted entr{p.entry_count === 1 ? 'y' : 'ies'}</p>
                              </div>
                              <Pill className={closed ? 'bg-bg-tertiary text-text-primary' : 'bg-success/10 text-success'}>
                                {closed ? <><LockKeyhole size={11} className="mr-1" />Closed</> : 'Open'}
                              </Pill>
                            </div>
                            <div className="mt-3">
                              {closed ? (
                                isOwner ? (
                                  <Button type="button" variant="secondary" size="sm" className="w-full" disabled={rowBusy} onClick={() => setReopening(p)}><Unlock size={14} /> Reopen</Button>
                                ) : (
                                  <p className="text-xs text-text-secondary">Only the account owner can reopen.</p>
                                )
                              ) : (
                                <Button type="button" variant="secondary" size="sm" className="w-full" disabled={rowBusy || future} onClick={() => void closePeriod(p)}>
                                  <LockKeyhole size={14} /> {future ? 'Not yet closable' : rowBusy ? 'Closing…' : 'Close month'}
                                </Button>
                              )}
                            </div>
                          </Card>
                        </li>
                      );
                    })}
                  </ul>

                  <Card className="mt-6 !p-4">
                    <p className="text-sm font-medium text-text-primary">Lock everything through a month</p>
                    <p className="mt-0.5 text-xs text-text-secondary">Closes every open month from your first ledger entry up to and including the month you pick.</p>
                    <div className="mt-3 flex flex-wrap gap-3">
                      <select aria-label="Lock through month" className={`${selectClass} sm:max-w-xs`} value={lockTarget} onChange={(e) => setLockTarget(e.target.value)}>
                        <option value="">Choose a month…</option>
                        {periods.filter((p) => p.period_start <= currentMonthStart).map((p) => <option key={p.period_start} value={p.period_start}>{monthName(p.period_start)} {year}</option>)}
                      </select>
                      <Button type="button" size="sm" disabled={!lockTarget || busy === 'lock'} onClick={() => setConfirmLock(true)}><LockKeyhole size={14} /> Lock through…</Button>
                    </div>
                  </Card>
                </>
              )}
            </section>
          )}

          {/* ------------------------------ ACTIVITY ------------------------------ */}
          {tab === 'activity' && (
            <section role="tabpanel" id="coa-panel-activity" aria-labelledby="coa-tab-activity">
              {auditFailed ? (
                <EmptyStateError icon={AlertTriangle} title="Couldn't load activity" onRetry={() => void loadAudit()} />
              ) : audit === null ? (
                <SkeletonCardList count={4} rows={1} />
              ) : audit.length === 0 ? (
                <EmptyState icon={History} title="No changes yet" description="Account edits, service mappings and period locks are recorded here." />
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                  {audit.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                      <span className="text-sm text-text-primary">{describeAuditEvent(e)}</span>
                      <time dateTime={e.created_at} className="text-xs text-text-secondary">{new Date(e.created_at).toLocaleString()}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </FadeIn>
      )}

      {editor && (
        <AccountEditor
          editing={editor.editing}
          accounts={accounts}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); void loadCore(); if (tab === 'activity') void loadAudit(); }}
        />
      )}

      <ConfirmDialog
        open={!!deactivating}
        title={`Deactivate ${deactivating?.name ?? 'account'}?`}
        description="It will be hidden from account pickers. History is kept. The system will refuse if the account still has a balance, sub-accounts, service mappings or a linked bank account."
        confirmLabel="Deactivate"
        onConfirm={async () => { const a = deactivating; setDeactivating(null); if (a) await toggleActive(a); }}
        onCancel={() => setDeactivating(null)}
      />

      <ConfirmDialog
        open={confirmLock}
        title={`Lock through ${lockTarget ? `${monthName(lockTarget)} ${lockTarget.slice(0, 4)}` : 'this month'}?`}
        description="Every open month up to and including this one will reject new journal entries. Only the account owner can reopen a month."
        confirmLabel="Lock periods"
        onConfirm={lockThrough}
        onCancel={() => setConfirmLock(false)}
      />

      {reopening && (
        <ReasonDialog
          title={`Reopen ${monthName(reopening.period_start)} ${year}?`}
          description="New entries dated in this month will be accepted again. Your reason is saved to the activity log."
          confirmLabel="Reopen month"
          onCancel={() => setReopening(null)}
          onConfirm={async (reason) => {
            const p = reopening;
            try {
              await setPeriodStatus(p.period_start, 'open', reason);
              toast(`${monthName(p.period_start)} ${year} reopened.`, 'success');
              setReopening(null);
              await loadPeriods();
            } catch (e) {
              toast(errMsg(e), 'error');
            }
          }}
        />
      )}
    </DashboardLayout>
  );
}
