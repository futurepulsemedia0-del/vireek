import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Building2, Download, Network, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonTable, FadeIn } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { fetchChartOfAccounts, type ChartOfAccount } from '@/lib/accounting';
import { errMsg, money } from '@/lib/chartOfAccounts';
import {
  assignEntries, buildCombinedStatement, buildEntityStatement, createEntity, eliminationCheck, fetchAccessOverview, fetchEntities,
  fetchEntityEntries, fetchMultiEntityPnl, groupAccess, isValidRange, isoDate, postIntercompany, rangePreset, setEntityAccess,
  statementToCsv, summarizeEntities, updateEntity, validateEntityDraft, validateIntercompanyDraft,
  type AccessRow, type EntityEntryRow, type IntercompanyDraft, type MultiEntityPnlRow, type PnlLine, type PnlStatement,
  type RangePreset, type ReportingEntity,
} from '@/lib/multiEntityReporting';

type Tab = 'reports' | 'entities' | 'assign' | 'intercompany' | 'access';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'quarter', label: 'Quarter to date' },
  { id: 'year', label: 'Year to date' },
];

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' | 'success' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-text-primary';
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </Card>
  );
}

function SelectField({ id, label, value, onChange, error, children }: {
  id: string; label: string; value: string; onChange: (v: string) => void; error?: string; children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)}>
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

function StatementRows({ title, lines, total, showElim }: { title: string; lines: PnlLine[]; total: number; showElim: boolean }) {
  return (
    <>
      <tr className="bg-bg-tertiary/50">
        <th colSpan={showElim ? 4 : 2} scope="colgroup" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</th>
      </tr>
      {lines.map((l) => (
        <tr key={`${l.type}:${l.account_code}`} className="border-t border-border">
          <td className="px-4 py-2 text-sm text-text-primary"><span className="mr-2 text-text-secondary">{l.account_code}</span>{l.account_name}</td>
          {showElim && <td className="px-4 py-2 text-right text-sm text-text-secondary">{money(l.gross_cents)}</td>}
          {showElim && <td className="px-4 py-2 text-right text-sm text-text-secondary">{l.eliminated_cents ? `-${money(l.eliminated_cents)}` : '—'}</td>}
          <td className="px-4 py-2 text-right text-sm font-medium text-text-primary">{money(l.amount_cents)}</td>
        </tr>
      ))}
      <tr className="border-t border-border">
        <td className="px-4 py-2 text-sm font-semibold text-text-primary">Total {title.toLowerCase()}</td>
        {showElim && <td />}
        {showElim && <td />}
        <td className="px-4 py-2 text-right text-sm font-semibold text-text-primary">{money(total)}</td>
      </tr>
    </>
  );
}

function StatementTable({ statement, showElim }: { statement: PnlStatement; showElim: boolean }) {
  const t = statement.totals;
  if (!statement.revenue.length && !statement.expenses.length) {
    return <EmptyState icon={Building2} title="No activity in this period" description="Nothing was posted for the selected entities and dates." />;
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[480px] border-collapse">
        <thead>
          <tr className="text-xs text-text-secondary">
            <th scope="col" className="px-4 py-2 text-left font-medium">Account</th>
            {showElim && <th scope="col" className="px-4 py-2 text-right font-medium">Gross</th>}
            {showElim && <th scope="col" className="px-4 py-2 text-right font-medium">Eliminated</th>}
            <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          <StatementRows title="Revenue" lines={statement.revenue} total={t.revenue_cents} showElim={showElim} />
          <StatementRows title="Expenses" lines={statement.expenses} total={t.expense_cents} showElim={showElim} />
          <tr className="border-t-2 border-border bg-bg-tertiary/50">
            <td className="px-4 py-3 text-sm font-semibold text-text-primary">Net income</td>
            {showElim && <td />}
            {showElim && <td />}
            <td className={`px-4 py-3 text-right text-sm font-bold ${t.net_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>{money(t.net_cents)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MultiEntityReportingPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const canAccess = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('reports');
  const [entities, setEntities] = useState<ReportingEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const today = useMemo(() => new Date(), []);
  const initial = useMemo(() => rangePreset('month', today), [today]);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [eliminate, setEliminate] = useState(true);
  const [view, setView] = useState<string>('combined');

  const [rows, setRows] = useState<MultiEntityPnlRow[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportFailed, setReportFailed] = useState(false);
  const reqId = useRef(0);
  const seeded = useRef(false);

  const loadEntities = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const list = await fetchEntities();
      setEntities(list);
      setSelected((prev) => {
        if (!seeded.current) {
          seeded.current = true;
          return new Set(list.map((e) => e.entity_id));
        }
        return new Set([...prev].filter((id) => list.some((e) => e.entity_id === id)));
      });
    } catch (e) {
      setLoadFailed(true);
      toastRef.current(errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user && canAccess) void loadEntities();
    else setLoading(false);
  }, [user, canAccess, loadEntities]);

  const selectedIds = useMemo(() => entities.filter((e) => selected.has(e.entity_id)).map((e) => e.entity_id), [entities, selected]);
  const selectedKey = selectedIds.join(',');

  useEffect(() => {
    if (!canAccess || loading || loadFailed) return;
    if (!isValidRange(start, end) || selectedIds.length === 0) {
      setRows([]);
      setReportFailed(false);
      return;
    }
    const id = ++reqId.current;
    setReportLoading(true);
    setReportFailed(false);
    fetchMultiEntityPnl(start, end, selectedIds.length === entities.length ? null : selectedIds)
      .then((r) => { if (id === reqId.current) setRows(r); })
      .catch((e) => {
        if (id !== reqId.current) return;
        setRows([]);
        setReportFailed(true);
        toastRef.current(errMsg(e), 'error');
      })
      .finally(() => { if (id === reqId.current) setReportLoading(false); });
    // selectedKey stands in for selectedIds so the effect only reruns on real changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess, loading, loadFailed, start, end, selectedKey, entities.length, reloadKey]);

  const refreshAll = useCallback(() => {
    void loadEntities();
    setReloadKey((k) => k + 1);
  }, [loadEntities]);

  const activeView = view === 'combined' || selected.has(view) ? view : 'combined';
  const statement = useMemo(
    () => (activeView === 'combined' ? buildCombinedStatement(rows, eliminate) : buildEntityStatement(rows, activeView)),
    [rows, eliminate, activeView],
  );
  const summaries = useMemo(() => summarizeEntities(rows, entities.filter((e) => selected.has(e.entity_id))), [rows, entities, selected]);
  const check = useMemo(() => eliminationCheck(rows), [rows]);
  const combinedTotals = useMemo(() => buildCombinedStatement(rows, eliminate).totals, [rows, eliminate]);
  const partial = selectedIds.length < entities.length;
  const showElim = activeView === 'combined' && eliminate && check.eliminated_revenue_cents + check.eliminated_expense_cents > 0;

  const toggleEntity = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyPreset = (kind: RangePreset) => {
    const r = rangePreset(kind, new Date());
    setStart(r.start);
    setEnd(r.end);
  };

  const downloadCsv = () => {
    const label = activeView === 'combined' ? 'combined' : (entities.find((e) => e.entity_id === activeView)?.entity_code ?? 'entity').toLowerCase();
    const blob = new Blob([statementToCsv(statement)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `profit-and-loss-${label}-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'reports', label: 'Reports' },
    { id: 'entities', label: 'Entities' },
    { id: 'assign', label: 'Assign entries' },
    { id: 'intercompany', label: 'Intercompany' },
    ...(isOwner ? [{ id: 'access' as Tab, label: 'Access' }] : []),
  ];

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Multi-Entity Reporting">
        <EmptyState icon={Network} title="You don't have access to entity reports" description="Ask the account owner to give you billing access." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Multi-Entity Reporting">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Network size={22} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Multi-Entity Reporting</h1>
            <p className="text-sm text-text-secondary">Profit &amp; loss for each entity, a combined view, and intercompany elimination.</p>
          </div>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={refreshAll} disabled={loading || reportLoading}>
          <RefreshCw size={14} className={loading || reportLoading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : loadFailed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load your entities" description="Check your connection and try again." onRetry={() => void loadEntities()} />
      ) : (
        <FadeIn>
          <div role="tablist" aria-label="Multi-entity reporting sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {tabs.map((t) => (
              <button
                key={t.id} type="button" role="tab" aria-selected={tab === t.id} id={`mer-tab-${t.id}`} aria-controls={`mer-panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`focus-ring shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'reports' && (
            <div role="tabpanel" id="mer-panel-reports" aria-labelledby="mer-tab-reports" className="space-y-5">
              {entities.length === 0 ? (
                <EmptyState icon={Building2} title="No entities shared with you" description="The account owner can grant you access to one or more entities." />
              ) : (
                <>
                  <Card className="space-y-4">
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Date presets">
                      {PRESETS.map((p) => (
                        <Button key={p.id} type="button" variant="secondary" size="sm" onClick={() => applyPreset(p.id)}>{p.label}</Button>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input id="mer-start" label="From" type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />
                      <Input id="mer-end" label="To" type="date" value={end} min={start || undefined} max={isoDate(today)} onChange={(e) => setEnd(e.target.value)} />
                    </div>
                    {!isValidRange(start, end) && <p className="text-xs text-danger">Choose a valid date range.</p>}
                    <fieldset>
                      <legend className="mb-2 text-sm font-medium text-text-primary">Entities in this report</legend>
                      <div className="flex flex-wrap gap-2">
                        {entities.map((e) => (
                          <label key={e.entity_id} className={`focus-within:ring-2 flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${selected.has(e.entity_id) ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary'}`}>
                            <input type="checkbox" checked={selected.has(e.entity_id)} onChange={() => toggleEntity(e.entity_id)} />
                            <span className="font-medium">{e.entity_code}</span>
                            <span className="hidden sm:inline">{e.entity_name}</span>
                            {!e.is_active && <span className="text-xs text-text-secondary">(inactive)</span>}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </Card>

                  {selectedIds.length === 0 ? (
                    <EmptyState icon={Building2} title="Select at least one entity" description="Pick the entities you want in this report." />
                  ) : reportFailed ? (
                    <EmptyStateError icon={AlertTriangle} title="Couldn't load the report" onRetry={() => setReloadKey((k) => k + 1)} />
                  ) : reportLoading ? (
                    <SkeletonTable rows={6} columns={4} />
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <Stat label="Combined revenue" value={money(combinedTotals.revenue_cents)} sub={eliminate ? 'After elimination' : 'Before elimination'} />
                        <Stat label="Combined expenses" value={money(combinedTotals.expense_cents)} />
                        <Stat label="Combined net income" value={money(combinedTotals.net_cents)} tone={combinedTotals.net_cents < 0 ? 'danger' : 'success'} sub={`Margin ${pct(combinedTotals.margin_pct)}`} />
                        <Stat label="Eliminated" value={money(check.eliminated_revenue_cents)} sub="Intercompany revenue removed" />
                      </div>

                      {partial && (
                        <p className="rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
                          Partial consolidation: intercompany is only eliminated between entities that are both selected.
                        </p>
                      )}
                      {!check.balanced && (
                        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-text-primary">
                          Intercompany is out of balance by {money(check.mismatch_cents)}: eliminated revenue and expense differ. One side of an intercompany entry may have been voided.
                        </p>
                      )}

                      <Card className="!p-0 overflow-hidden">
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[560px] border-collapse">
                            <caption className="sr-only">Profit and loss by entity</caption>
                            <thead>
                              <tr className="text-xs text-text-secondary">
                                <th scope="col" className="px-4 py-2 text-left font-medium">Entity</th>
                                <th scope="col" className="px-4 py-2 text-right font-medium">Revenue</th>
                                <th scope="col" className="px-4 py-2 text-right font-medium">Expenses</th>
                                <th scope="col" className="px-4 py-2 text-right font-medium">Net income</th>
                                <th scope="col" className="px-4 py-2 text-right font-medium">Margin</th>
                                <th scope="col" className="px-4 py-2 text-right font-medium">Revenue share</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summaries.map((s) => (
                                <tr key={s.entity.entity_id} className="border-t border-border">
                                  <td className="px-4 py-2 text-sm text-text-primary"><span className="mr-2 font-medium">{s.entity.entity_code}</span><span className="text-text-secondary">{s.entity.entity_name}</span></td>
                                  <td className="px-4 py-2 text-right text-sm">{money(s.totals.revenue_cents)}</td>
                                  <td className="px-4 py-2 text-right text-sm">{money(s.totals.expense_cents)}</td>
                                  <td className={`px-4 py-2 text-right text-sm font-medium ${s.totals.net_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>{money(s.totals.net_cents)}</td>
                                  <td className="px-4 py-2 text-right text-sm text-text-secondary">{pct(s.totals.margin_pct)}</td>
                                  <td className="px-4 py-2 text-right text-sm text-text-secondary">{pct(s.revenue_share_pct)}</td>
                                </tr>
                              ))}
                              <tr className="border-t-2 border-border bg-bg-tertiary/50">
                                <td className="px-4 py-2 text-sm font-semibold text-text-primary">Combined{eliminate ? ' (eliminated)' : ''}</td>
                                <td className="px-4 py-2 text-right text-sm font-semibold">{money(combinedTotals.revenue_cents)}</td>
                                <td className="px-4 py-2 text-right text-sm font-semibold">{money(combinedTotals.expense_cents)}</td>
                                <td className={`px-4 py-2 text-right text-sm font-bold ${combinedTotals.net_cents < 0 ? 'text-danger' : 'text-text-primary'}`}>{money(combinedTotals.net_cents)}</td>
                                <td className="px-4 py-2 text-right text-sm text-text-secondary">{pct(combinedTotals.margin_pct)}</td>
                                <td />
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </Card>

                      <div className="flex flex-wrap items-end justify-between gap-3">
                        <div className="w-full sm:w-64">
                          <SelectField id="mer-view" label="Statement" value={activeView} onChange={setView}>
                            <option value="combined">Combined</option>
                            {entities.filter((e) => selected.has(e.entity_id)).map((e) => (
                              <option key={e.entity_id} value={e.entity_id}>{e.entity_code} — {e.entity_name}</option>
                            ))}
                          </SelectField>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          {activeView === 'combined' && (
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                              <input type="checkbox" checked={eliminate} onChange={(e) => setEliminate(e.target.checked)} />
                              Eliminate intercompany
                            </label>
                          )}
                          <Button type="button" variant="secondary" size="sm" onClick={downloadCsv}><Download size={14} /> Export CSV</Button>
                        </div>
                      </div>
                      <StatementTable statement={statement} showElim={showElim} />
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'entities' && <EntitiesPanel entities={entities} isOwner={isOwner} onChanged={refreshAll} />}
          {tab === 'assign' && <AssignPanel entities={entities.filter((e) => e.is_active)} allEntities={entities} onChanged={refreshAll} />}
          {tab === 'intercompany' && <IntercompanyPanel entities={entities.filter((e) => e.is_active)} onChanged={refreshAll} />}
          {tab === 'access' && isOwner && <AccessPanel />}
        </FadeIn>
      )}
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function EntitiesPanel({ entities, isOwner, onChanged }: { entities: ReportingEntity[]; isOwner: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ name?: string; code?: string }>({});
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const create = async () => {
    const v = validateEntityDraft(name, code);
    setErrors(v);
    if (v.name || v.code) return;
    setBusy(true);
    try {
      await createEntity(name, code);
      toast('Entity created');
      setName('');
      setCode('');
      onChanged();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: ReportingEntity, nextName: string, active: boolean) => {
    setBusy(true);
    try {
      await updateEntity(e.entity_id, nextName, active);
      toast('Entity updated');
      setEditingId(null);
      onChanged();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="tabpanel" id="mer-panel-entities" aria-labelledby="mer-tab-entities" className="space-y-5">
      {isOwner && (
        <Card className="space-y-3">
          <h2 className="text-base font-semibold text-text-primary">New entity</h2>
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-start">
            <Input id="mer-new-name" label="Name" value={name} error={errors.name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            <Input id="mer-new-code" label="Code" value={code} error={errors.code} maxLength={20} helperText="Short, e.g. BETA" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <Button type="button" className="sm:mt-7" onClick={() => void create()} disabled={busy}><Plus size={14} /> Add</Button>
          </div>
        </Card>
      )}
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[520px] border-collapse">
          <caption className="sr-only">Entities</caption>
          <thead>
            <tr className="text-xs text-text-secondary">
              <th scope="col" className="px-4 py-2 text-left font-medium">Entity</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Posted entries</th>
              <th scope="col" className="px-4 py-2 text-left font-medium">Status</th>
              {isOwner && <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.entity_id} className="border-t border-border">
                <td className="px-4 py-2 text-sm text-text-primary">
                  {editingId === e.entity_id ? (
                    <Input id={`mer-edit-${e.entity_id}`} aria-label="Entity name" value={editName} maxLength={120} onChange={(ev) => setEditName(ev.target.value)} />
                  ) : (
                    <><span className="mr-2 font-medium">{e.entity_code}</span>{e.entity_name}{e.is_default && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">Default</span>}</>
                  )}
                </td>
                <td className="px-4 py-2 text-right text-sm text-text-secondary">{e.entry_count}</td>
                <td className="px-4 py-2 text-sm text-text-secondary">{e.is_active ? 'Active' : 'Inactive'}</td>
                {isOwner && (
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {editingId === e.entity_id ? (
                        <>
                          <Button type="button" size="sm" disabled={busy || !editName.trim()} onClick={() => void save(e, editName, e.is_active)}>Save</Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                        </>
                      ) : (
                        <>
                          <Button type="button" size="sm" variant="secondary" onClick={() => { setEditingId(e.entity_id); setEditName(e.entity_name); }}>Rename</Button>
                          {!e.is_default && (
                            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(e, e.entity_name, !e.is_active)}>
                              {e.is_active ? 'Deactivate' : 'Activate'}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-secondary">Ledger entries that were never assigned belong to the default entity.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assign entries
// ---------------------------------------------------------------------------

function AssignPanel({ entities, allEntities, onChanged }: { entities: ReportingEntity[]; allEntities: ReportingEntity[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [entries, setEntries] = useState<EntityEntryRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!fromId && allEntities.length) setFromId(allEntities.find((e) => e.is_default)?.entity_id ?? allEntities[0].entity_id);
  }, [allEntities, fromId]);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setFailed(false);
    setChecked(new Set());
    try {
      setEntries(await fetchEntityEntries(id, 100));
    } catch (e) {
      setEntries([]);
      setFailed(true);
      toast(errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(fromId); }, [fromId, load]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const movable = entries.filter((e) => !e.is_intercompany);
  const allChecked = movable.length > 0 && movable.every((e) => checked.has(e.entry_id));

  const move = async () => {
    setBusy(true);
    try {
      const moved = await assignEntries([...checked], toId);
      toast(moved === 1 ? 'Moved 1 entry' : `Moved ${moved} entries`);
      onChanged();
      await load(fromId);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="tabpanel" id="mer-panel-assign" aria-labelledby="mer-tab-assign" className="space-y-4">
      <Card className="space-y-3">
        <p className="text-sm text-text-secondary">Move posted ledger entries between entities. Entries from closed periods and intercompany pairs cannot be moved.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField id="mer-from" label="Show entries of" value={fromId} onChange={setFromId}>
            {allEntities.map((e) => <option key={e.entity_id} value={e.entity_id}>{e.entity_code} — {e.entity_name}</option>)}
          </SelectField>
          <SelectField id="mer-to" label="Move selected to" value={toId} onChange={setToId}>
            <option value="">Choose an entity…</option>
            {entities.filter((e) => e.entity_id !== fromId).map((e) => <option key={e.entity_id} value={e.entity_id}>{e.entity_code} — {e.entity_name}</option>)}
          </SelectField>
        </div>
      </Card>
      {loading ? (
        <SkeletonTable rows={5} columns={4} />
      ) : failed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load entries" onRetry={() => void load(fromId)} />
      ) : entries.length === 0 ? (
        <EmptyState icon={Building2} title="No entries for this entity" description="Posted ledger entries will appear here." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[560px] border-collapse">
              <caption className="sr-only">Ledger entries</caption>
              <thead>
                <tr className="text-xs text-text-secondary">
                  <th scope="col" className="w-10 px-4 py-2"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(movable.map((e) => e.entry_id)))} /></th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Entry</th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Date</th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Memo</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.entry_id} className="border-t border-border">
                    <td className="px-4 py-2"><input type="checkbox" aria-label={`Select ${e.entry_number}`} disabled={e.is_intercompany} checked={checked.has(e.entry_id)} onChange={() => toggle(e.entry_id)} /></td>
                    <td className="px-4 py-2 text-sm text-text-primary">{e.entry_number}{e.is_intercompany && <span className="ml-2 text-xs text-text-secondary">Intercompany</span>}</td>
                    <td className="px-4 py-2 text-sm text-text-secondary">{e.entry_date}</td>
                    <td className="max-w-[260px] truncate px-4 py-2 text-sm text-text-secondary">{e.memo ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-sm text-text-primary">{money(e.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <Button type="button" disabled={busy || checked.size === 0 || !toId} onClick={() => void move()}>
              Move {checked.size || ''} {checked.size === 1 ? 'entry' : 'entries'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intercompany
// ---------------------------------------------------------------------------

function IntercompanyPanel({ entities, onChanged }: { entities: ReportingEntity[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof IntercompanyDraft, string>>>({});
  const [draft, setDraft] = useState<IntercompanyDraft>({
    date: isoDate(new Date()), memo: '', providerId: '', recipientId: '', amount: '',
    receivableId: '', revenueId: '', expenseId: '', payableId: '',
  });

  useEffect(() => {
    let alive = true;
    fetchChartOfAccounts()
      .then((list) => {
        if (!alive) return;
        setAccounts(list);
        const pick = (type: string, code: string) =>
          (list.find((a) => a.type === type && a.code === code) ?? list.find((a) => a.type === type))?.id ?? '';
        setDraft((d) => ({
          ...d,
          receivableId: d.receivableId || pick('asset', '1100'),
          revenueId: d.revenueId || pick('revenue', '4900'),
          expenseId: d.expenseId || pick('expense', '6900'),
          payableId: d.payableId || pick('liability', '2000'),
        }));
      })
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, []);

  const set = <K extends keyof IntercompanyDraft>(key: K, value: IntercompanyDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const ofType = (type: string) => accounts.filter((a) => a.type === type);

  const submit = async () => {
    const v = validateIntercompanyDraft(draft);
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await postIntercompany(draft);
      toast('Intercompany entry posted to both entities');
      setDraft((d) => ({ ...d, memo: '', amount: '' }));
      onChanged();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loadFailed) return <EmptyStateError icon={AlertTriangle} title="Couldn't load your chart of accounts" onRetry={() => window.location.reload()} />;
  if (entities.length < 2) {
    return <EmptyState icon={Building2} title="Add a second entity first" description="Intercompany entries move money between two entities." />;
  }

  const accountOptions = (type: string) => ofType(type).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>);
  const entityOptions = entities.map((e) => <option key={e.entity_id} value={e.entity_id}>{e.entity_code} — {e.entity_name}</option>);

  return (
    <div role="tabpanel" id="mer-panel-intercompany" aria-labelledby="mer-tab-intercompany" className="space-y-4">
      <Card className="space-y-4">
        <p className="text-sm text-text-secondary">
          One entity charges another (management fees, shared services, loans of staff). Both sides are posted together and flagged so the combined P&amp;L can eliminate them.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField id="mer-ic-provider" label="Provider (earns revenue)" value={draft.providerId} onChange={(v) => set('providerId', v)} error={errors.providerId}>
            <option value="">Choose…</option>{entityOptions}
          </SelectField>
          <SelectField id="mer-ic-recipient" label="Recipient (books expense)" value={draft.recipientId} onChange={(v) => set('recipientId', v)} error={errors.recipientId}>
            <option value="">Choose…</option>{entityOptions}
          </SelectField>
          <Input id="mer-ic-date" label="Date" type="date" value={draft.date} error={errors.date} onChange={(e) => set('date', e.target.value)} />
          <Input id="mer-ic-amount" label="Amount (USD)" inputMode="decimal" value={draft.amount} error={errors.amount} placeholder="250.00" onChange={(e) => set('amount', e.target.value)} />
          <SelectField id="mer-ic-receivable" label="Provider: receivable account" value={draft.receivableId} onChange={(v) => set('receivableId', v)} error={errors.receivableId}>
            <option value="">Choose…</option>{accountOptions('asset')}
          </SelectField>
          <SelectField id="mer-ic-revenue" label="Provider: revenue account" value={draft.revenueId} onChange={(v) => set('revenueId', v)} error={errors.revenueId}>
            <option value="">Choose…</option>{accountOptions('revenue')}
          </SelectField>
          <SelectField id="mer-ic-expense" label="Recipient: expense account" value={draft.expenseId} onChange={(v) => set('expenseId', v)} error={errors.expenseId}>
            <option value="">Choose…</option>{accountOptions('expense')}
          </SelectField>
          <SelectField id="mer-ic-payable" label="Recipient: payable account" value={draft.payableId} onChange={(v) => set('payableId', v)} error={errors.payableId}>
            <option value="">Choose…</option>{accountOptions('liability')}
          </SelectField>
        </div>
        <Input id="mer-ic-memo" label="Memo (optional)" value={draft.memo} error={errors.memo} maxLength={500} onChange={(e) => set('memo', e.target.value)} />
        <div className="flex justify-end">
          <Button type="button" disabled={busy} onClick={() => void submit()}>Post intercompany entry</Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access (owner only)
// ---------------------------------------------------------------------------

function AccessPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setRows(await fetchAccessOverview());
    } catch (e) {
      setFailed(true);
      toast(errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { entities, members, granted } = useMemo(() => groupAccess(rows), [rows]);

  const flip = async (entityId: string, memberId: string, next: boolean) => {
    const key = `${entityId}:${memberId}`;
    setPending(key);
    try {
      await setEntityAccess(entityId, memberId, next);
      await load();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setPending(null);
    }
  };

  if (loading) return <SkeletonTable rows={4} columns={4} />;
  if (failed) return <EmptyStateError icon={AlertTriangle} title="Couldn't load access settings" onRetry={() => void load()} />;
  if (members.length === 0) {
    return <EmptyState icon={Building2} title="No team members yet" description="Invite teammates, then choose which entities each of them can see." />;
  }

  return (
    <div role="tabpanel" id="mer-panel-access" aria-labelledby="mer-tab-access" className="space-y-3">
      <p className="text-sm text-text-secondary">
        Team members only see entities you grant here, and only if they also have billing access. You always see every entity.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[480px] border-collapse">
          <caption className="sr-only">Entity access by team member</caption>
          <thead>
            <tr className="text-xs text-text-secondary">
              <th scope="col" className="px-4 py-2 text-left font-medium">Team member</th>
              {entities.map((e) => <th key={e.id} scope="col" className="px-4 py-2 text-center font-medium">{e.code}</th>)}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="px-4 py-2 text-sm text-text-primary">{m.name}<span className="block text-xs text-text-secondary">{m.email}</span></td>
                {entities.map((e) => {
                  const key = `${e.id}:${m.id}`;
                  return (
                    <td key={key} className="px-4 py-2 text-center">
                      <input
                        type="checkbox" aria-label={`${m.name} can see ${e.name}`} checked={granted.has(key)} disabled={pending === key}
                        onChange={(ev) => void flip(e.id, m.id, ev.target.checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
