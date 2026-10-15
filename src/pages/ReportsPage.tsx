import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Download,
  FileBarChart,
  Lock,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ReportChart } from '@/components/reports/ReportChart';
import { exportToCsv, type CsvColumn } from '@/lib/csvExport';
import {
  AGG_LABELS,
  ENTITIES,
  ENTITY_KEYS,
  GROUP_LIMITS,
  MAX_COLUMNS,
  MAX_FILTERS,
  OPS_BY_TYPE,
  OP_LABELS,
  RANGE_LABELS,
  createReport,
  defaultDefinition,
  deleteReport,
  fetchReportRows,
  formatCell,
  formatMetricNumber,
  getField,
  groupLabel,
  listReports,
  runReport,
  sanitizeDefinition,
  toExportTable,
  updateReport,
  validateDefinition,
  type AggFn,
  type ChartType,
  type DateBucket,
  type ExportCell,
  type FetchedRows,
  type FieldDef,
  type ReportDefinition,
  type ReportEntity,
  type ReportFilter,
  type SavedReport,
  type SortMode,
} from '@/lib/reportBuilder';

const PREVIEW_ROW_LIMIT = 200;

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

const CHART_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'none', label: 'Table only' },
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'donut', label: 'Donut' },
];

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function snapshot(name: string, description: string, def: ReportDefinition): string {
  return JSON.stringify([name.trim(), description.trim(), def]);
}

function fileSlug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'report';
}

function FilterValueInput({ field, value, onChange }: { field: FieldDef; value: string; onChange: (v: string) => void }) {
  if (field.type === 'enum') {
    return (
      <select aria-label="Filter value" className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select aria-label="Filter value" className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  return (
    <Input
      aria-label="Filter value"
      className="!py-2.5 !text-sm"
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      step={field.type === 'number' ? 'any' : undefined}
      maxLength={200}
      placeholder={field.type === 'string' ? 'Type a value…' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ReportsPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const { currency } = useCurrency();

  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const authPending = authLoading || profileLoading;

  // ---------- saved reports list ----------
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState('');

  const loadReports = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setListState('loading');
    try {
      setReports(await listReports(accountOwnerId));
      setListState('ready');
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load reports.');
      setListState('error');
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  // ---------- editor ----------
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [def, setDef] = useState<ReportDefinition>(() => defaultDefinition('calls'));
  const [baseline, setBaseline] = useState(() => snapshot('', '', defaultDefinition('calls')));
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedReport | null>(null);

  const dirty = snapshot(name, description, def) !== baseline;
  const entity = ENTITIES[def.entity];
  const numericFields = useMemo(() => entity.fields.filter((f) => f.type === 'number'), [entity]);
  const groupableFields = useMemo(() => entity.fields.filter((f) => f.type !== 'number'), [entity]);
  const groupField = def.groupBy ? getField(def.entity, def.groupBy) : undefined;
  const metricField = def.metric.field ? getField(def.entity, def.metric.field) : undefined;

  const loadIntoEditor = useCallback((id: string | null, n: string, d: string, definition: ReportDefinition) => {
    setActiveId(id);
    setName(n);
    setDescription(d);
    setDef(definition);
    setBaseline(snapshot(n, d, definition));
    setNameError('');
  }, []);

  const guard = (action: () => void) => {
    if (dirty) setPendingAction(() => action);
    else action();
  };

  const startNew = () => loadIntoEditor(null, '', '', defaultDefinition('calls'));
  const openReport = (r: SavedReport) => loadIntoEditor(r.id, r.name, r.description ?? '', r.definition);

  const patchDef = useCallback(
    (patch: Partial<ReportDefinition>) => setDef((d) => sanitizeDefinition({ ...d, ...patch }, d.entity)),
    [],
  );

  const changeEntity = (next: ReportEntity) => {
    if (next === def.entity) return;
    setDef((d) => defaultDefinition(next, d.range));
  };

  const toggleColumn = (key: string) => {
    const selected = new Set(def.columns);
    if (selected.has(key)) selected.delete(key);
    else if (selected.size < MAX_COLUMNS) selected.add(key);
    else {
      toast(`You can pick up to ${MAX_COLUMNS} columns.`, 'error');
      return;
    }
    patchDef({ columns: entity.fields.filter((f) => selected.has(f.key)).map((f) => f.key) });
  };

  const addFilter = () => {
    if (def.filters.length >= MAX_FILTERS) return;
    const first = entity.fields[0];
    patchDef({ filters: [...def.filters, { field: first.key, op: OPS_BY_TYPE[first.type][0], value: '' }] });
  };
  const updateFilter = (index: number, next: ReportFilter) =>
    patchDef({ filters: def.filters.map((f, i) => (i === index ? next : f)) });
  const removeFilter = (index: number) => patchDef({ filters: def.filters.filter((_, i) => i !== index) });

  const changeFilterField = (index: number, key: string) => {
    const field = getField(def.entity, key);
    if (!field) return;
    updateFilter(index, { field: key, op: OPS_BY_TYPE[field.type][0], value: '' });
  };

  const changeGroupBy = (key: string) => {
    if (!key) {
      patchDef({ groupBy: null, chart: 'none' });
      return;
    }
    const f = getField(def.entity, key);
    patchDef({
      groupBy: key,
      chart: def.chart === 'none' ? (f?.type === 'date' ? 'line' : 'bar') : def.chart,
      sort: f?.type === 'date' ? 'label_asc' : 'value_desc',
    });
  };

  const changeMetricFn = (fn: AggFn) => {
    if (fn === 'count') {
      patchDef({ metric: { fn: 'count', field: null } });
      return;
    }
    const field = def.metric.field ?? numericFields[0]?.key ?? null;
    if (field) patchDef({ metric: { fn, field } });
  };

  // ---------- data ----------
  const [data, setData] = useState<(FetchedRows & { entity: ReportEntity }) | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!accountOwnerId || !canAccess) return;
    const requestId = ++requestRef.current;
    setDataLoading(true);
    setDataError('');
    fetchReportRows(def.entity, accountOwnerId, def.range)
      .then((res) => {
        if (requestId === requestRef.current) setData({ ...res, entity: def.entity });
      })
      .catch((err) => {
        if (requestId !== requestRef.current) return;
        setData(null);
        setDataError(err instanceof Error ? err.message : 'Could not load report data.');
      })
      .finally(() => {
        if (requestId === requestRef.current) setDataLoading(false);
      });
    return () => {
      requestRef.current++;
    };
  }, [accountOwnerId, canAccess, def.entity, def.range, reloadTick]);

  const rowsReady = data && data.entity === def.entity ? data : null;
  const result = useMemo(() => (rowsReady ? runReport(rowsReady.rows, def) : null), [rowsReady, def]);

  const formatGroupValue = useCallback(
    (v: number) => formatMetricNumber(v, def.metric.fn === 'count' ? undefined : metricField?.format, currency),
    [def.metric.fn, metricField, currency],
  );

  // ---------- actions ----------
  const handleSave = async (asCopy: boolean) => {
    if (!accountOwnerId || saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Give the report a name.');
      return;
    }
    const problem = validateDefinition(def);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: asCopy ? `${trimmed} (copy)`.slice(0, 120) : trimmed,
        description,
        definition: def,
      };
      const saved =
        activeId && !asCopy
          ? await updateReport(accountOwnerId, activeId, input)
          : await createReport(accountOwnerId, input);
      setReports((prev) => [saved, ...prev.filter((r) => r.id !== saved.id)]);
      loadIntoEditor(saved.id, saved.name, saved.description ?? '', saved.definition);
      toast(asCopy ? 'Report duplicated.' : 'Report saved.', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save the report.';
      if (/already exists/i.test(message)) setNameError(message);
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    if (!target || !accountOwnerId) return;
    try {
      await deleteReport(accountOwnerId, target.id);
      setReports((prev) => prev.filter((r) => r.id !== target.id));
      if (target.id === activeId) startNew();
      toast('Report deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the report.', 'error');
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleExport = () => {
    if (!result) return;
    const table = toExportTable(result, def, currency);
    if (table.rows.length === 0) {
      toast('There is nothing to export yet.', 'error');
      return;
    }
    const columns: CsvColumn<ExportCell[]>[] = table.headers.map((header, i) => ({ header, accessor: (row) => row[i] }));
    const stamp = new Date().toISOString().slice(0, 10);
    exportToCsv(table.rows, columns, `${fileSlug(name || `${entity.label}-report`)}-${stamp}`);
    toast(`Exported ${table.rows.length.toLocaleString()} rows.`, 'success');
  };

  // ---------- gates ----------
  if (authPending || (canAccess && !accountOwnerId)) {
    return (
      <DashboardLayout activeLabel="Reports">
        <Skeleton className="mb-6 h-9 w-56" />
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full rounded-2xl" />
          <Skeleton className="h-96 w-full rounded-2xl" />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Reports">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Reports are restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const shownRows = result?.kind === 'rows' ? result.rows.slice(0, PREVIEW_ROW_LIMIT) : [];
  const columnFields = def.columns.map((k) => getField(def.entity, k)).filter((f): f is FieldDef => !!f);
  const reportTitle = name.trim() || 'Untitled report';

  return (
    <DashboardLayout activeLabel="Reports">
      <div className="no-print mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FileBarChart size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Reports</h1>
            <p className="text-sm text-text-secondary">Build, save and export custom reports from your calls, leads, jobs and customers.</p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => guard(startNew)}>
          <Plus size={16} /> New report
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* ---------------- Saved reports ---------------- */}
        <aside className="no-print" aria-label="Saved reports">
          <Card className="!p-4 hover:!translate-y-0">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Saved reports</h2>
            {listState === 'loading' && (
              <div className="space-y-2" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-xl" />
                ))}
              </div>
            )}
            {listState === 'error' && (
              <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm" role="alert">
                <p className="text-text-primary">{listError}</p>
                <button type="button" onClick={loadReports} className="focus-ring mt-2 text-xs font-semibold text-accent hover:underline">
                  Try again
                </button>
              </div>
            )}
            {listState === 'ready' && reports.length === 0 && (
              <EmptyState
                icon={FileBarChart}
                title="No saved reports"
                description="Configure a report on the right, name it and press Save."
                className="!py-6"
              />
            )}
            {listState === 'ready' && reports.length > 0 && (
              <ul className="max-h-72 space-y-1.5 overflow-y-auto lg:max-h-[32rem]">
                {reports.map((r) => (
                  <li key={r.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => guard(() => openReport(r))}
                      aria-current={r.id === activeId ? 'true' : undefined}
                      className={`focus-ring min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        r.id === activeId ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-bg-tertiary'
                      }`}
                    >
                      <span className="block truncate text-sm font-medium text-text-primary">{r.name}</span>
                      <span className="block truncate text-xs text-text-secondary">
                        {ENTITIES[r.entity].label}
                        {r.definition.groupBy ? ` · by ${getField(r.entity, r.definition.groupBy)?.label.toLowerCase() ?? 'group'}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(r)}
                      aria-label={`Delete report ${r.name}`}
                      className="focus-ring rounded-lg p-2 text-text-secondary transition-colors hover:text-danger lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover:opacity-100"
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>

        <div className="min-w-0 space-y-6">
          {/* ---------------- Builder ---------------- */}
          <Card className="no-print !p-5 hover:!translate-y-0 sm:!p-6">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-text-primary">{activeId ? 'Edit report' : 'New report'}</h2>
              {dirty && (
                <span className="rounded-full bg-warning-500/10 px-2.5 py-1 text-xs font-medium text-warning-500" role="status">
                  Unsaved changes
                </span>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Report name"
                value={name}
                maxLength={120}
                placeholder="e.g. Emergency calls by source"
                error={nameError || undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError('');
                }}
              />
              <Input
                label="Description (optional)"
                value={description}
                maxLength={500}
                placeholder="What question does this answer?"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Data source">
                <select className={selectClass} value={def.entity} onChange={(e) => changeEntity(e.target.value as ReportEntity)}>
                  {ENTITY_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {ENTITIES[k].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date range">
                <select className={selectClass} value={def.range} onChange={(e) => patchDef({ range: e.target.value as ReportDefinition['range'] })}>
                  {Object.entries(RANGE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {/* Columns */}
            <fieldset className="mt-6">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Columns <span className="font-normal normal-case">({def.columns.length}/{MAX_COLUMNS}{def.groupBy ? ' · used when ungrouped' : ''})</span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {entity.fields.map((f) => {
                  const on = def.columns.includes(f.key);
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleColumn(f.key)}
                      className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-tertiary'
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Filters */}
            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Filters</h3>
                <button
                  type="button"
                  onClick={addFilter}
                  disabled={def.filters.length >= MAX_FILTERS}
                  className="focus-ring inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline disabled:opacity-50"
                >
                  <Plus size={13} /> Add filter
                </button>
              </div>
              {def.filters.length === 0 ? (
                <p className="text-sm text-text-secondary">All rows in the date range are included.</p>
              ) : (
                <ul className="space-y-3">
                  {def.filters.map((f, i) => {
                    const field = getField(def.entity, f.field);
                    if (!field) return null;
                    return (
                      <li
                        key={i}
                        className="grid gap-2 rounded-xl border border-border/70 p-3 sm:grid-cols-[1fr_1fr_1.2fr_auto] sm:items-center sm:border-0 sm:p-0"
                      >
                        <select aria-label="Filter field" className={selectClass} value={f.field} onChange={(e) => changeFilterField(i, e.target.value)}>
                          {entity.fields.map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Filter operator"
                          className={selectClass}
                          value={f.op}
                          onChange={(e) => updateFilter(i, { ...f, op: e.target.value as ReportFilter['op'] })}
                        >
                          {OPS_BY_TYPE[field.type].map((op) => (
                            <option key={op} value={op}>
                              {OP_LABELS[op]}
                            </option>
                          ))}
                        </select>
                        <FilterValueInput field={field} value={f.value} onChange={(v) => updateFilter(i, { ...f, value: v })} />
                        <button
                          type="button"
                          onClick={() => removeFilter(i)}
                          aria-label="Remove filter"
                          className="focus-ring justify-self-end rounded-lg p-2 text-text-secondary transition-colors hover:text-danger"
                        >
                          <X size={16} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Grouping + metric + chart */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Group by">
                <select className={selectClass} value={def.groupBy ?? ''} onChange={(e) => changeGroupBy(e.target.value)}>
                  <option value="">No grouping (list rows)</option>
                  {groupableFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              {groupField?.type === 'date' && (
                <Field label="Time bucket">
                  <select className={selectClass} value={def.dateBucket} onChange={(e) => patchDef({ dateBucket: e.target.value as DateBucket })}>
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                  </select>
                </Field>
              )}
              {def.groupBy && (
                <>
                  <Field label="Metric">
                    <select className={selectClass} value={def.metric.fn} onChange={(e) => changeMetricFn(e.target.value as AggFn)}>
                      {(Object.keys(AGG_LABELS) as AggFn[]).map((fn) => (
                        <option key={fn} value={fn} disabled={fn !== 'count' && numericFields.length === 0}>
                          {AGG_LABELS[fn]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {def.metric.fn !== 'count' && (
                    <Field label="Metric field">
                      <select
                        className={selectClass}
                        value={def.metric.field ?? ''}
                        onChange={(e) => patchDef({ metric: { fn: def.metric.fn, field: e.target.value } })}
                      >
                        {numericFields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Field label="Sort groups">
                    <select className={selectClass} value={def.sort} onChange={(e) => patchDef({ sort: e.target.value as SortMode })}>
                      <option value="value_desc">Highest first</option>
                      <option value="value_asc">Lowest first</option>
                      <option value="label_asc">{groupField?.type === 'date' ? 'Chronological' : 'A → Z'}</option>
                    </select>
                  </Field>
                  <Field label="Max groups">
                    <select className={selectClass} value={def.limit} onChange={(e) => patchDef({ limit: Number(e.target.value) })}>
                      {GROUP_LIMITS.map((n) => (
                        <option key={n} value={n}>
                          Top {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
            </div>

            <fieldset className="mt-6">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Chart</legend>
              <div className="flex flex-wrap gap-2">
                {CHART_OPTIONS.map((c) => {
                  const disabled = c.value !== 'none' && !def.groupBy;
                  const on = def.chart === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={on}
                      disabled={disabled}
                      onClick={() => patchDef({ chart: c.value })}
                      className={`focus-ring rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-tertiary'
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              {!def.groupBy && <p className="mt-2 text-xs text-text-secondary">Pick a "Group by" field to unlock charts.</p>}
            </fieldset>

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
              <Button size="sm" onClick={() => handleSave(false)} disabled={saving}>
                <Save size={16} /> {saving ? 'Saving…' : activeId ? 'Save changes' : 'Save report'}
              </Button>
              {activeId && (
                <Button variant="secondary" size="sm" onClick={() => handleSave(true)} disabled={saving}>
                  <Copy size={16} /> Save as copy
                </Button>
              )}
              {activeId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const target = reports.find((r) => r.id === activeId);
                    if (target) setDeleteTarget(target);
                  }}
                  className="ml-auto !text-danger"
                >
                  <Trash2 size={16} /> Delete
                </Button>
              )}
            </div>
          </Card>

          {/* ---------------- Preview ---------------- */}
          <Card className="!p-5 hover:!translate-y-0 sm:!p-6">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-text-primary">{reportTitle}</h2>
                <p className="text-sm text-text-secondary" aria-live="polite">
                  {rowsReady && result
                    ? `${result.matched.toLocaleString()} of ${rowsReady.rows.length.toLocaleString()} ${entity.label.toLowerCase()} · ${RANGE_LABELS[def.range]}`
                    : `${entity.label} · ${RANGE_LABELS[def.range]}`}
                </p>
                {description.trim() && <p className="mt-1 text-sm text-text-secondary">{description.trim()}</p>}
              </div>
              <div className="no-print flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setReloadTick((t) => t + 1)} disabled={dataLoading} aria-label="Refresh data">
                  <RefreshCw size={16} className={dataLoading ? 'animate-spin' : ''} />
                </Button>
                <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!result}>
                  <Printer size={16} /> Print
                </Button>
                <Button size="sm" onClick={handleExport} disabled={!result || result.matched === 0}>
                  <Download size={16} /> Export CSV
                </Button>
              </div>
            </div>

            {dataLoading && !rowsReady && (
              <div className="space-y-3" aria-busy="true" aria-label="Loading report data">
                <Skeleton className="h-40 w-full rounded-xl" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-3/4" />
              </div>
            )}

            {dataError && (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4" role="alert">
                <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <AlertTriangle size={16} className="text-danger" /> {dataError}
                </p>
                <Button variant="secondary" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
                  <RefreshCw size={16} /> Try again
                </Button>
              </div>
            )}

            {rowsReady?.truncated && (
              <p className="mb-4 flex items-start gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-text-primary" role="status">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
                This date range has more than 5,000 {entity.label.toLowerCase()}, so only the most recent 5,000 are included. Narrow the date range for complete totals.
              </p>
            )}

            {result && result.matched === 0 && (
              <EmptyState
                icon={FileBarChart}
                title="No matching rows"
                description="Try a wider date range or remove a filter."
                className="!py-10"
              />
            )}

            {result?.kind === 'grouped' && result.groups.length > 0 && (
              <>
                {def.chart !== 'none' && (
                  <div className="mb-6">
                    <ReportChart type={def.chart} groups={result.groups} formatValue={formatGroupValue} title={`${result.metricLabel} by ${groupLabel(def)}`} />
                  </div>
                )}
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full min-w-[20rem] text-left text-sm">
                    <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
                      <tr>
                        <th scope="col" className="px-4 py-2.5 font-semibold">
                          {groupLabel(def)}
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                          Rows
                        </th>
                        {def.metric.fn !== 'count' && (
                          <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                            {result.metricLabel}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {result.groups.map((g) => (
                        <tr key={g.key}>
                          <td className="px-4 py-2.5 text-text-primary">{g.label}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">{g.count.toLocaleString()}</td>
                          {def.metric.fn !== 'count' && (
                            <td className="px-4 py-2.5 text-right font-medium tabular-nums text-text-primary">
                              {g.value === null ? '—' : formatGroupValue(g.value)}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.hiddenGroups > 0 && (
                  <p className="mt-2 text-xs text-text-secondary">
                    {result.hiddenGroups.toLocaleString()} more groups not shown — raise "Max groups" to include them.
                  </p>
                )}
              </>
            )}

            {result?.kind === 'rows' && result.matched > 0 && (
              <>
                {columnFields.length === 0 ? (
                  <p className="py-6 text-center text-sm text-text-secondary">Pick at least one column to see rows.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full min-w-[32rem] text-left text-sm">
                      <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
                        <tr>
                          {columnFields.map((f) => (
                            <th key={f.key} scope="col" className="whitespace-nowrap px-4 py-2.5 font-semibold">
                              {f.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {shownRows.map((row, i) => (
                          <tr key={typeof row.id === 'string' ? row.id : i}>
                            {columnFields.map((f) => (
                              <td key={f.key} className="max-w-[16rem] truncate px-4 py-2.5 text-text-primary" title={formatCell(f, row[f.key], currency)}>
                                {formatCell(f, row[f.key], currency)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {result.matched > PREVIEW_ROW_LIMIT && (
                  <p className="no-print mt-2 text-xs text-text-secondary">
                    Showing the first {PREVIEW_ROW_LIMIT} of {result.matched.toLocaleString()} rows — Export CSV includes all of them.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title="Discard unsaved changes?"
        description="You have changes in this report that haven't been saved. Continuing will discard them."
        confirmLabel="Discard changes"
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          action?.();
        }}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this report?"
        description={`"${deleteTarget?.name ?? ''}" will be removed for everyone on your account. Your underlying data is not affected.`}
        confirmLabel="Yes, delete report"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </DashboardLayout>
  );
}
