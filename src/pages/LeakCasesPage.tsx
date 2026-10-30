import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Loader2,
  Lock,
  RefreshCw,
  ScanSearch,
  Snowflake,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { exportToCsv } from '@/lib/csvExport';
import { supabase } from '@/lib/supabase';
import {
  EPA_608_CREDENTIAL_TYPES,
  CATEGORY_LABELS,
  type CredentialLike,
} from '@/lib/refrigerantCompliance';
import {
  HAWK_COLUMNS,
  HAWK_EXPORT_NOTICE,
  LEGAL_NOTICE,
  NEXT_ACTION_LABELS,
  fetchChronicCandidates,
  fetchLeakCases,
  fetchLeakSummary,
  hawkFilename,
  isLive,
  leakUrgency,
  scanLeakCases,
  sortCases,
  type ChronicCandidate,
  type LeakCase,
  type LeakSummary,
} from '@/lib/leakRepair';
import { LeakCaseDetail, type TechOption } from '@/components/leak/LeakCaseDetail';
import {
  StatusBadge,
  UrgencyBadge,
  btnGhost,
  btnPrimary,
  fmtDay,
  inputClass,
  unitTitle,
} from '@/components/leak/leakUi';

type Tab = 'cases' | 'chronic';
type Filter = 'active' | 'overdue' | 'failed' | 'closed' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'failed', label: 'Repair failed' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

export function LeakCasesPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isOwner, permissions, teamMember, profile } = useAuth();
  const [params, setParams] = useSearchParams();

  const role = teamMember?.role ?? null;
  const canAccess =
    isOwner || permissions.can_view_all_jobs || role === 'admin' || role === 'technician';
  const canManage = isOwner || role === 'admin';
  const selfTechId = role === 'technician' ? (teamMember?.id ?? null) : null;

  const [tab, setTab] = useState<Tab>('cases');
  const [filter, setFilter] = useState<Filter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cases, setCases] = useState<LeakCase[]>([]);
  const [summary, setSummary] = useState<LeakSummary | null>(null);
  const [techs, setTechs] = useState<TechOption[]>([]);
  const [creds, setCreds] = useState<CredentialLike[]>([]);
  const [scanning, setScanning] = useState(false);

  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const [chronic, setChronic] = useState<ChronicCandidate[] | null>(null);
  const [chronicError, setChronicError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, sum, techRes, credRes] = await Promise.all([
        fetchLeakCases(),
        fetchLeakSummary(),
        supabase
          .from('team_members')
          .select('id, member_name, member_email')
          .eq('role', 'technician'),
        supabase
          .from('technician_credentials')
          .select('id, technician_id, credential_type, credential_number, status, expires_at')
          .in('credential_type', EPA_608_CREDENTIAL_TYPES),
      ]);
      setCases(list);
      setSummary(sum);
      setTechs((techRes.data ?? []) as TechOption[]);
      setCreds((credRes.data ?? []) as CredentialLike[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load leak cases.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  const loadChronic = useCallback(async () => {
    setChronic(null);
    setChronicError(null);
    try {
      setChronic(await fetchChronicCandidates(year));
    } catch (err) {
      setChronicError(err instanceof Error ? err.message : 'Could not load chronic-leak data.');
    }
  }, [year]);

  useEffect(() => {
    if (canAccess && tab === 'chronic') void loadChronic();
  }, [canAccess, tab, loadChronic]);

  const now = useMemo(() => new Date(), []);
  const visible = useMemo(() => {
    const list = cases.filter((c) => {
      if (filter === 'all') return true;
      if (filter === 'active') return isLive(c.status);
      if (filter === 'overdue') return leakUrgency(c, now) === 'overdue';
      if (filter === 'failed') return c.status === 'failed';
      return c.status === 'closed' || c.status === 'voided';
    });
    return sortCases(list, now);
  }, [cases, filter, now]);

  const selectedId = params.get('case');
  const selected = cases.find((c) => c.id === selectedId) ?? null;
  const openCase = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('case', id);
    else next.delete('case');
    setParams(next, { replace: true });
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const n = await scanLeakCases();
      toast(
        n > 0
          ? `Opened ${n} leak case${n === 1 ? '' : 's'} from existing records.`
          : 'No missing leak cases found.',
        n > 0 ? 'success' : 'info',
      );
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Scan failed.', 'error');
    } finally {
      setScanning(false);
    }
  };

  const handleExport = () => {
    if (!chronic || chronic.length === 0) return;
    exportToCsv(chronic, HAWK_COLUMNS, hawkFilename(year));
    toast(
      `Exported ${chronic.length} unit${chronic.length === 1 ? '' : 's'} (prepared only — nothing was filed).`,
      'success',
    );
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Refrigerant Leaks">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">
            You don't have access to this page
          </h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
            Ask your account owner for the "View all jobs" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1, now.getUTCFullYear() - 2];

  return (
    <DashboardLayout activeLabel="Refrigerant Leaks">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard/compliance')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"
            aria-label="Back to Compliance Center"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Snowflake size={22} className="text-accent" /> Refrigerant leak repairs
            </h1>
            <p className="text-sm text-text-secondary">
              Every regulated unit over its leak limit has a case with a dated next action.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnGhost} onClick={() => void load()}>
            <RefreshCw size={14} /> Refresh
          </button>
          {canManage && (
            <button
              type="button"
              className={btnGhost}
              onClick={() => void handleScan()}
              disabled={scanning}
              title="Check existing refrigerant records for units already over their limit"
            >
              {scanning ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}{' '}
              Scan existing records
            </button>
          )}
        </div>
      </div>

      {summary && summary.overdue > 0 && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <strong>
              {summary.overdue} leak case{summary.overdue === 1 ? ' is' : 's are'} overdue.
            </strong>{' '}
            Open them below and complete the next action.
          </p>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Active cases" value={summary?.active} loading={loading} />
        <Tile label="Overdue" value={summary?.overdue} loading={loading} danger />
        <Tile label="Due in 7 days" value={summary?.due_soon} loading={loading} />
        <Tile label="Repair failed" value={summary?.failed} loading={loading} danger />
      </div>

      <div
        role="tablist"
        aria-label="Leak views"
        className="mb-4 flex gap-2 border-b border-border"
      >
        {(
          [
            ['cases', 'Leak cases'],
            ['chronic', 'Chronic leakers (HAWK data)'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`focus-ring -mb-px min-h-[44px] border-b-2 px-3 text-sm font-medium ${tab === k ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'cases' && (
        <>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter cases">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`focus-ring min-h-[36px] rounded-full border px-3 text-xs font-medium ${filter === f.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading leak cases">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
              ))}
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-2xl border border-danger/30 bg-danger/5 p-5 text-sm text-danger"
            >
              {error}{' '}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
              >
                Try again
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-14 text-center">
              <Snowflake size={28} className="mx-auto text-text-secondary" aria-hidden="true" />
              <h3 className="mt-3 text-base font-semibold text-text-primary">
                {cases.length === 0 ? 'No leak cases yet' : 'No cases in this view'}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">
                {cases.length === 0
                  ? 'A case opens automatically when a regulated unit (15 lb or more, GWP above 53) goes over its leak-rate limit after a refrigerant addition is logged on a job.'
                  : 'Try another filter.'}
              </p>
              {cases.length === 0 && canManage && (
                <button
                  type="button"
                  className={`${btnPrimary} mt-4`}
                  onClick={() => void handleScan()}
                  disabled={scanning}
                >
                  {scanning ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ScanSearch size={14} />
                  )}{' '}
                  Scan existing records
                </button>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {visible.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => openCase(c.id)}
                    className="focus-ring flex w-full flex-col gap-2 rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {unitTitle(c)}
                      </p>
                      <p className="truncate text-xs text-text-secondary">
                        {[c.customer_name, c.site_address].filter(Boolean).join(' · ') || '—'}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {c.rate_pct}% / {c.threshold_pct}% · {CATEGORY_LABELS[c.appliance_category]}
                        {c.next_action && c.next_action_due_at
                          ? ` · ${NEXT_ACTION_LABELS[c.next_action]} by ${fmtDay(c.next_action_due_at)}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <UrgencyBadge c={c} now={now} />
                      <StatusBadge status={c.status} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {tab === 'chronic' && (
        <section aria-label="Chronic leakers">
          <p className="mb-3 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-secondary">
            {HAWK_EXPORT_NOTICE}
          </p>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-text-secondary">
              Calendar year
              <select
                className={`${inputClass} mt-1 block w-32`}
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={btnPrimary}
              onClick={handleExport}
              disabled={!chronic || chronic.length === 0}
            >
              <Download size={14} /> Export CSV (prepared, not filed)
            </button>
          </div>
          {chronicError ? (
            <div
              role="alert"
              className="rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
            >
              {chronicError}{' '}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => void loadChronic()}
              >
                Try again
              </button>
            </div>
          ) : chronic === null ? (
            <div className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" />
          ) : chronic.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">
              No regulated unit added more than 125% of its full charge in {year}.
            </p>
          ) : (
            <ul className="space-y-2">
              {chronic.map((r) => (
                <li
                  key={r.equipment_id}
                  className="flex flex-col gap-1 rounded-2xl border border-border bg-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {r.equipment_label ?? 'Unit'}
                      {r.equipment_serial ? ` · S/N ${r.equipment_serial}` : ''}
                    </p>
                    <p className="truncate text-xs text-text-secondary">
                      {[r.customer_name, r.site_address].filter(Boolean).join(' · ') || '—'}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {r.pounds_added} lb added of {r.charge_lbs} lb · {r.additions} addition
                      {r.additions === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
                    <AlertTriangle size={12} aria-hidden="true" /> {r.leak_rate_pct}% of charge
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="mt-8 text-[11px] leading-relaxed text-text-secondary">{LEGAL_NOTICE}</p>

      {selected && (
        <LeakCaseDetail
          c={selected}
          allCases={cases}
          techs={techs}
          creds={creds}
          selfTechId={selfTechId}
          canManage={canManage}
          isOwner={isOwner}
          businessName={profile?.company_name ?? null}
          onChanged={() => void load()}
          onClose={() => openCase(null)}
        />
      )}
    </DashboardLayout>
  );
}

function Tile({
  label,
  value,
  loading,
  danger,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  danger?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
      {loading ? (
        <div className="mx-auto h-7 w-10 animate-pulse rounded bg-bg-tertiary" />
      ) : (
        <p
          className={`text-2xl font-bold ${danger && (value ?? 0) > 0 ? 'text-danger' : 'text-text-primary'}`}
        >
          {value ?? 0}
        </p>
      )}
      <p className="text-xs text-text-secondary">{label}</p>
    </div>
  );
}
