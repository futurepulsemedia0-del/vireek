import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Download, Loader2, RefreshCw, ScrollText, ShieldCheck, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  AUDIT_EXPORT_CAP,
  AUDIT_PAGE_SIZE,
  EMPTY_FILTERS,
  buildAuditDetails,
  describeTarget,
  exportAuditLogCsv,
  fetchAuditFilterOptions,
  fetchAuditLog,
  formatAction,
  hasActiveFilters,
  type AuditFilters,
  type AuditLogRow,
} from '@/lib/auditLog';

const FIELD_CLASS =
  'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Settings">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <ShieldCheck size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">Owner access only</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          The audit log records sensitive account activity, so only the account owner can view or export it.
        </p>
      </div>
    </DashboardLayout>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-xl bg-bg-tertiary/60" />
      ))}
    </div>
  );
}

function Details({ row }: { row: AuditLogRow }) {
  const details = buildAuditDetails(row.metadata);
  if (!details) {
    return <p className="text-sm text-text-secondary">No change details were recorded for this event.</p>;
  }
  if (details.kind === 'json') {
    return (
      <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-bg-primary p-3 font-mono text-xs leading-relaxed text-text-primary">
        {details.json}
      </pre>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-bg-tertiary/60 text-xs uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium">Before</th>
            <th className="px-3 py-2 font-medium">After</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {details.rows.map((d) => (
            <tr key={d.field}>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-primary">{d.field}</td>
              <td className="break-all bg-danger-500/5 px-3 py-2 font-mono text-xs text-danger-500">{d.from}</td>
              <td className="break-all bg-success-500/5 px-3 py-2 font-mono text-xs text-success-500">{d.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditLogPage() {
  const { isOwner } = useAuth();
  const { toast } = useToast();

  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  /** Debounced copy of the actor text box so we don't query on every keystroke. */
  const [actorInput, setActorInput] = useState('');
  const [options, setOptions] = useState<{ actions: string[]; targetTables: string[] }>({ actions: [], targetTables: [] });

  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const ticketRef = useRef(0);

  // Filter dropdown options (best-effort — the viewer works without them).
  useEffect(() => {
    if (!isOwner) return;
    fetchAuditFilterOptions().then(setOptions).catch(() => undefined);
  }, [isOwner]);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.actor === actorInput ? f : { ...f, actor: actorInput })), 300);
    return () => clearTimeout(t);
  }, [actorInput]);

  /** `before` undefined = fresh load; otherwise append the next page. */
  const load = useCallback(
    async (before?: string) => {
      const ticket = ++ticketRef.current;
      if (before) setLoadingMore(true);
      else {
        setLoading(true);
        setExpanded(null);
      }
      setError(null);
      try {
        const page = await fetchAuditLog({ filters, before });
        if (ticket !== ticketRef.current) return;
        setRows((prev) => (before ? [...prev, ...page] : page));
        setHasMore(page.length === AUDIT_PAGE_SIZE);
      } catch (e) {
        if (ticket !== ticketRef.current) return;
        setError(e instanceof Error ? e.message : 'Could not load the audit log.');
        if (!before) {
          setRows([]);
          setHasMore(false);
        }
      } finally {
        if (ticket === ticketRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filters],
  );

  useEffect(() => {
    if (!isOwner) return;
    void load();
  }, [isOwner, load]);

  if (!isOwner) return <NoAccess />;

  const setField = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const clearFilters = () => {
    setActorInput('');
    setFilters(EMPTY_FILTERS);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { count, truncated } = await exportAuditLogCsv(filters);
      if (count === 0) toast('Nothing to export for these filters.', 'info');
      else
        toast(
          truncated ? `Exported the newest ${count.toLocaleString()} events (export is capped).` : `Exported ${count.toLocaleString()} events.`,
          'success',
        );
    } catch {
      toast('Export failed. Please try again.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));
  const filtered = hasActiveFilters(filters);

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mb-6">
        <BackButton fallback="/dashboard/settings" />
      </div>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ScrollText size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Audit log</h1>
            <p className="mt-1 text-sm text-text-secondary">
              A tamper-resistant record of sensitive actions on your account. Only you, the owner, can see it.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting || loading || rows.length === 0}
          title={`Exports up to ${AUDIT_EXPORT_CAP.toLocaleString()} events matching the current filters`}
          className="focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition hover:border-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {/* Filters */}
      <div className="mb-5 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block text-xs font-medium text-text-secondary">
            Action
            <select value={filters.action} onChange={(e) => setField('action', e.target.value)} className={`mt-1.5 ${FIELD_CLASS}`}>
              <option value="">All actions</option>
              {options.actions.map((a) => (
                <option key={a} value={a}>{formatAction(a)}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            Target
            <select value={filters.targetTable} onChange={(e) => setField('targetTable', e.target.value)} className={`mt-1.5 ${FIELD_CLASS}`}>
              <option value="">All targets</option>
              {options.targetTables.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            Actor email
            <input
              type="search"
              value={actorInput}
              onChange={(e) => setActorInput(e.target.value)}
              placeholder="name@company.com"
              maxLength={120}
              className={`mt-1.5 ${FIELD_CLASS}`}
            />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            From
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setField('from', e.target.value)} className={`mt-1.5 ${FIELD_CLASS}`} />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            To
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setField('to', e.target.value)} className={`mt-1.5 ${FIELD_CLASS}`} />
          </label>
        </div>
        {(filtered || actorInput) && (
          <button
            type="button"
            onClick={clearFilters}
            className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg text-xs font-semibold text-accent hover:underline"
          >
            <X size={13} /> Clear filters
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger-500/30 bg-danger-500/5 px-4 py-3 text-sm text-danger-500">
          <span className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </span>
          <button type="button" onClick={() => void load()} className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg font-semibold hover:underline">
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      )}

      {loading ? (
        <Skeleton />
      ) : rows.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <ScrollText size={22} />
          </span>
          <h3 className="mt-4 text-base font-semibold text-text-primary">{filtered ? 'No matching events' : 'No events recorded yet'}</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">
            {filtered ? 'Try widening the date range or clearing a filter.' : 'Sensitive actions such as security and team changes will appear here.'}
          </p>
          {filtered && (
            <button type="button" onClick={clearFilters} className="focus-ring mt-4 rounded-xl border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:border-accent/30">
              Clear filters
            </button>
          )}
        </div>
      ) : (
        rows.length > 0 && (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-2xl border border-border bg-bg-secondary md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Actor</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="w-10 px-4 py-3" aria-label="Details" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const open = expanded === row.id;
                    return (
                      <Fragment key={row.id}>
                        <tr className="cursor-pointer border-b border-border/60 transition-colors hover:bg-bg-tertiary/40" onClick={() => toggle(row.id)}>
                          <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{new Date(row.created_at).toLocaleString()}</td>
                          <td className="px-4 py-3 font-medium text-text-primary">{formatAction(row.action)}</td>
                          <td className="px-4 py-3 text-text-secondary">{row.actor_email ?? '—'}</td>
                          <td className="max-w-[16rem] truncate px-4 py-3 font-mono text-xs text-text-secondary" title={describeTarget(row)}>{describeTarget(row)}</td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={open ? 'Hide details' : 'Show details'}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(row.id);
                              }}
                              className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"
                            >
                              <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-b border-border/60 bg-bg-tertiary/20">
                            <td colSpan={5} className="px-4 py-4"><Details row={row} /></td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <ul className="space-y-2 md:hidden">
              {rows.map((row) => {
                const open = expanded === row.id;
                return (
                  <li key={row.id} className="rounded-2xl border border-border bg-bg-secondary">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggle(row.id)}
                      className="focus-ring flex w-full items-start justify-between gap-3 rounded-2xl p-4 text-left"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-text-primary">{formatAction(row.action)}</span>
                        <span className="mt-0.5 block truncate text-xs text-text-secondary">{row.actor_email ?? '—'}</span>
                        <span className="mt-0.5 block break-all font-mono text-[11px] text-text-secondary">{describeTarget(row)}</span>
                        <span className="mt-1 block text-[11px] text-text-secondary">{new Date(row.created_at).toLocaleString()}</span>
                      </span>
                      <ChevronDown size={16} className={`mt-1 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
                    </button>
                    {open && <div className="border-t border-border p-4"><Details row={row} /></div>}
                  </li>
                );
              })}
            </ul>

            {hasMore && (
              <div className="mt-5 flex justify-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void load(rows[rows.length - 1]?.created_at)}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-5 py-2.5 text-sm font-semibold text-text-primary transition hover:border-accent/30 disabled:opacity-60"
                >
                  {loadingMore && <Loader2 size={14} className="animate-spin" />}
                  {loadingMore ? 'Loading…' : 'Load older events'}
                </button>
              </div>
            )}
          </>
        )
      )}
    </DashboardLayout>
  );
}
