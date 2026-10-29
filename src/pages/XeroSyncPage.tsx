import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, BookOpen, CheckCircle2, Clock, Link2, Loader2, Lock, RefreshCw, Save, Unplug } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  CONFLICT_RULE_META,
  CURRENCY_MODE_META,
  DIRECTION_META,
  ENTITY_META,
  FOREIGN_CURRENCY_MODES,
  LOG_PAGE_SIZE,
  OAUTH_REASONS,
  VIREEK_FIELDS,
  XERO_CONFLICT_RULES,
  XERO_DIRECTIONS,
  XERO_ENTITIES,
  disconnectXero,
  effectiveDirection,
  getConnection,
  listConflicts,
  listLog,
  listRuns,
  listTaxRates,
  loadOptions,
  readSettings,
  refreshDaysLeft,
  resolveConflict,
  resyncAll,
  saveSettings,
  selectableSalesTaxRates,
  startOAuth,
  syncNow,
  taxRateMismatch,
  timeAgo,
  useCanManageXero,
  useXeroOwnerId,
  validateSettings,
  vireekFieldLabel,
  type ForeignCurrencyMode,
  type LogAction,
  type LogEntity,
  type XeroConflict,
  type XeroConflictRule,
  type XeroConnection,
  type XeroDirection,
  type XeroEntity,
  type XeroLogRow,
  type XeroOptions,
  type XeroRun,
  type XeroSettings,
  type XeroTaxRate,
} from '@/lib/xero';

const ACTION_STYLE: Record<LogAction, string> = {
  created: 'bg-success-500/10 text-success-500',
  updated: 'bg-accent/10 text-accent',
  linked: 'bg-accent/10 text-accent',
  voided: 'bg-warning-500/10 text-warning-500',
  conflict: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-error-500/10 text-error-500',
};
const RUN_STYLE: Record<XeroRun['status'], string> = {
  running: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-error-500/10 text-error-500',
};
const selectCls = 'rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none';

function Badge({ cls, children, title }: { cls: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

// ============================================================
// MAPPING
// ============================================================

type Defaults = XeroSettings['defaults'];

function MappingPanel({ conn, onSaved }: { conn: XeroConnection; onSaved: () => void }) {
  const { toast } = useToast();
  const saved = useMemo(() => readSettings(conn.settings), [conn.settings]);
  const [draft, setDraft] = useState<XeroSettings>(saved);
  const [auto, setAuto] = useState(conn.auto_sync);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<XeroOptions | null>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const [open, setOpen] = useState<XeroEntity | null>(null);

  useEffect(() => setDraft(saved), [saved]);
  useEffect(() => setAuto(conn.auto_sync), [conn.auto_sync]);
  useEffect(() => {
    let cancelled = false;
    loadOptions(conn.id)
      .then((o) => !cancelled && setOptions(o))
      .catch((e: Error) => !cancelled && setOptError(e.message));
    return () => {
      cancelled = true;
    };
  }, [conn.id]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || auto !== conn.auto_sync;
  const check = validateSettings(draft);
  const patch = (entity: XeroEntity, p: Partial<XeroSettings['entities'][XeroEntity]>) =>
    setDraft((d) => ({ ...d, entities: { ...d.entities, [entity]: { ...d.entities[entity], ...p } } }));
  const setDefault = <K extends keyof Defaults>(k: K, v: Defaults[K]) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, [k]: v } }));

  const save = async () => {
    if (!check.ok) return toast(check.error, 'error');
    setSaving(true);
    try {
      await saveSettings(conn.id, draft, auto);
      toast('Mapping saved. Changed entities are re-read on the next sync.', 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const salesRates = selectableSalesTaxRates(options?.taxRates ?? []);
  const chosenRate = salesRates.find((r) => r.taxType === draft.defaults.taxType);
  const mismatch = taxRateMismatch(chosenRate, options?.vireekTaxRate);
  const field = (label: string, hint: string, control: React.ReactNode) => (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text-primary">{label}</span>
      {control}
      <span className="text-xs text-text-secondary">{hint}</span>
    </label>
  );
  const loadingOpt = options ? 'Not set' : 'Loading…';

  return (
    <section className="space-y-4" aria-labelledby="xero-mapping">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="xero-mapping" className="text-lg font-semibold text-text-primary">Mapping &amp; conflict rules</h2>
        <button type="button" onClick={save} disabled={!dirty || saving || !check.ok} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save mapping
        </button>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
        {XERO_ENTITIES.map((entity) => {
          const es = draft.entities[entity];
          const meta = ENTITY_META[entity];
          const fields = VIREEK_FIELDS[entity];
          return (
            <div key={entity} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-w-[9rem] items-center gap-2.5">
                  <input type="checkbox" checked={es.enabled} onChange={(e) => patch(entity, { enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent,#2563eb)]" aria-label={`Sync ${meta.label}`} />
                  <span className="font-medium text-text-primary">{meta.label}</span>
                </label>
                <span className="hidden text-xs text-text-secondary lg:inline">{meta.vireekLabel} ↔ {meta.xeroLabel}</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select className={selectCls} value={es.direction} disabled={!es.enabled} onChange={(e) => patch(entity, { direction: e.target.value as XeroDirection })} aria-label={`${meta.label} direction`}>
                    {XERO_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label}</option>)}
                  </select>
                  <select className={selectCls} value={es.conflict} disabled={!es.enabled} onChange={(e) => patch(entity, { conflict: e.target.value as XeroConflictRule })} aria-label={`${meta.label} conflict rule`} title={CONFLICT_RULE_META[es.conflict].hint}>
                    {XERO_CONFLICT_RULES.map((r) => <option key={r} value={r}>{CONFLICT_RULE_META[r].label}</option>)}
                  </select>
                  {fields.length > 0 && (
                    <button type="button" onClick={() => setOpen(open === entity ? null : entity)} className="text-sm font-medium text-accent hover:underline" aria-expanded={open === entity}>
                      {open === entity ? 'Hide fields' : 'Fields'}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-text-secondary">{meta.hint}</p>
              {open === entity && (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {fields.map((f) => {
                    const dir = es.fields[f.key] ?? 'both';
                    const eff = effectiveDirection(es.direction, dir);
                    return (
                      <li key={f.key} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary px-3 py-2">
                        <span className="text-sm text-text-primary">{f.label}{f.required ? ' *' : ''}</span>
                        <select className={selectCls} value={dir} aria-label={`${f.label} direction`} onChange={(e) => patch(entity, { fields: { ...es.fields, [f.key]: e.target.value as XeroDirection | 'off' } })}>
                          {XERO_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label}</option>)}
                          {!f.required && <option value="off">Don't sync</option>}
                        </select>
                        {eff !== dir && <span className="sr-only">Effective: {eff}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h3 className="font-medium text-text-primary">Defaults for records Vireek creates in Xero</h3>
        <p className="mb-3 mt-1 text-xs text-text-secondary">Xero needs these to accept new invoices and payments. Nothing is sent for a record whose default is missing; it is listed in the log instead.</p>
        {optError && <p className="mb-3 text-sm text-warning-500">Could not load your Xero lists: {optError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {field('Sales account for invoice lines', 'Used when a line matches no synced item. Required to send invoices.',
            <select className={selectCls} value={draft.defaults.salesAccountCode ?? ''} disabled={!options} onChange={(e) => setDefault('salesAccountCode', e.target.value || null)}>
              <option value="">{loadingOpt}</option>
              {(options?.accounts ?? []).filter((a) => a.classification === 'REVENUE').map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name}</option>)}
            </select>)}
          {field('Fallback item (optional)', 'Used instead of the sales account when a line matches no synced item.',
            <select className={selectCls} value={draft.defaults.fallbackItemCode ?? ''} disabled={!options} onChange={(e) => setDefault('fallbackItemCode', e.target.value || null)}>
              <option value="">{loadingOpt}</option>
              {(options?.items ?? []).map((i) => <option key={i.code} value={i.code}>{i.name} ({i.code})</option>)}
            </select>)}
          {field('Deposit account for payments', 'Bank (or payment-enabled) account used when the payment’s account is not linked.',
            <select className={selectCls} value={draft.defaults.depositAccountId ?? ''} disabled={!options} onChange={(e) => setDefault('depositAccountId', e.target.value || null)}>
              <option value="">{loadingOpt}</option>
              {(options?.accounts ?? []).filter((a) => a.bank).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>)}
          {field('Sales tax rate (invoices with tax)', 'Applied to the lines of invoices that carry tax. Vireek’s tax amount is sent exactly.',
            <select className={selectCls} value={draft.defaults.taxType ?? ''} disabled={!options} onChange={(e) => setDefault('taxType', e.target.value || null)}>
              <option value="">{loadingOpt}</option>
              {salesRates.map((r) => <option key={r.taxType} value={r.taxType}>{r.name} ({r.effectiveRate}%)</option>)}
            </select>)}
          {field('Tax rate for tax-free invoices', 'Defaults to Xero’s “No Tax” (NONE) when not set.',
            <select className={selectCls} value={draft.defaults.zeroTaxType ?? ''} disabled={!options} onChange={(e) => setDefault('zeroTaxType', e.target.value || null)}>
              <option value="">{options ? 'No Tax (NONE)' : 'Loading…'}</option>
              {salesRates.filter((r) => r.effectiveRate === 0).map((r) => <option key={r.taxType} value={r.taxType}>{r.name}</option>)}
            </select>)}
          {field('Foreign-currency invoices', CURRENCY_MODE_META[draft.defaults.foreignCurrency].hint,
            <select className={selectCls} value={draft.defaults.foreignCurrency} onChange={(e) => setDefault('foreignCurrency', e.target.value as ForeignCurrencyMode)}>
              {FOREIGN_CURRENCY_MODES.map((m) => <option key={m} value={m}>{CURRENCY_MODE_META[m].label}</option>)}
            </select>)}
        </div>
        {mismatch && <p className="mt-3 text-sm text-warning-500">{mismatch}</p>}
        {options && !options.organisation.currencyOk && <p className="mt-3 text-sm text-error-500">{options.organisation.reason}</p>}
        <label className="mt-4 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={draft.defaults.sendInvoiceNumber} onChange={(e) => setDefault('sendInvoiceNumber', e.target.checked)} className="h-4 w-4" />
          Send the Vireek invoice number to Xero
        </label>
        <label className="mt-2 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={draft.defaults.syncTaxRates} onChange={(e) => setDefault('syncTaxRates', e.target.checked)} className="h-4 w-4" />
          Keep the Xero tax-rate list up to date
        </label>
        <label className="mt-2 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4" />
          Sync automatically every 15 minutes (and when Xero reports an invoice or contact change)
        </label>
      </div>
    </section>
  );
}

// ============================================================
// TAX RATES + CURRENCY (read-only)
// ============================================================

function TaxRatesPanel({ conn, refreshKey }: { conn: XeroConnection; refreshKey: number }) {
  const [rates, setRates] = useState<XeroTaxRate[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    listTaxRates(conn.id).then((r) => !cancelled && setRates(r)).catch(() => !cancelled && setRates([]));
    return () => {
      cancelled = true;
    };
  }, [conn.id, refreshKey]);
  const settings = readSettings(conn.settings);
  if (!rates || rates.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="xero-tax">
      <h2 id="xero-tax" className="text-lg font-semibold text-text-primary">Xero tax rates</h2>
      <p className="text-xs text-text-secondary">Read from Xero (tax rates are managed in Xero). Choose the rate used for invoices under Mapping → Defaults. Base currency: {conn.base_currency ?? 'unknown'}.</p>
      <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-text-secondary">
            <tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Rate</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Used by Vireek</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rates.map((r) => (
              <tr key={r.taxType}>
                <td className="px-3 py-2 text-text-primary">{r.name}</td>
                <td className="px-3 py-2 text-text-secondary">{r.taxType}</td>
                <td className="px-3 py-2 text-text-primary">{r.effectiveRate}%</td>
                <td className="px-3 py-2 text-text-secondary">{r.status.toLowerCase()}</td>
                <td className="px-3 py-2 text-text-secondary">{r.taxType === settings.defaults.taxType ? 'Taxable invoices' : r.taxType === (settings.defaults.zeroTaxType ?? 'NONE') ? 'Tax-free invoices' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ============================================================
// CONFLICTS
// ============================================================

function ConflictsPanel({ conn, refreshKey, onChanged }: { conn: XeroConnection; refreshKey: number; onChanged: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<XeroConflict[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConflicts(conn.id).then((r) => !cancelled && setRows(r)).catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [conn.id, refreshKey]);

  const resolve = async (c: XeroConflict, winner: 'vireek' | 'xero') => {
    setBusy(c.link_id + winner);
    try {
      await resolveConflict(c.link_id, winner);
      toast(winner === 'vireek' ? 'Kept the Vireek value.' : 'Kept the Xero value.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not resolve the conflict.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!rows || rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="xero-conflicts">
      <h2 id="xero-conflicts" className="flex items-center gap-2 text-lg font-semibold text-text-primary">
        <AlertTriangle size={18} className="text-warning-500" /> Needs your decision ({rows.length})
      </h2>
      <ul className="space-y-3">
        {rows.map((c) => (
          <li key={c.link_id} className="rounded-2xl border border-warning-500/40 bg-warning-500/5 p-4">
            <p className="text-sm font-medium text-text-primary">{ENTITY_META[c.entity].label.replace(/s$/, '')}</p>
            {c.reason && <p className="mt-1 text-sm text-text-secondary">{c.reason}</p>}
            {c.fields.length > 0 && (
              <dl className="mt-2 grid gap-1 text-sm">
                {c.fields.map((f) => (
                  <div key={f.field} className="grid grid-cols-[8rem_1fr_1fr] gap-3">
                    <dt className="text-text-secondary">{vireekFieldLabel(c.entity, f.field)}</dt>
                    <dd className="truncate text-text-primary" title={fmt(f.vireek)}>Vireek: {fmt(f.vireek)}</dd>
                    <dd className="truncate text-text-primary" title={fmt(f.xero)}>Xero: {fmt(f.xero)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!!busy} onClick={() => resolve(c, 'vireek')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'vireek' ? 'Applying…' : 'Keep Vireek'}
              </button>
              <button type="button" disabled={!!busy} onClick={() => resolve(c, 'xero')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'xero' ? 'Applying…' : 'Keep Xero'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ============================================================
// LOG
// ============================================================

function LogPanel({ conn, refreshKey }: { conn: XeroConnection; refreshKey: number }) {
  const [action, setAction] = useState<LogAction | 'all'>('all');
  const [entity, setEntity] = useState<LogEntity | 'all'>('all');
  const [rows, setRows] = useState<XeroLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const r = await listLog(conn.id, { action, entity });
      setRows(r);
      setMore(r.length === LOG_PAGE_SIZE);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [conn.id, action, entity]);
  useEffect(() => void load(), [load, refreshKey]);

  const loadMore = async () => {
    const r = await listLog(conn.id, { action, entity, before: rows[rows.length - 1]?.created_at });
    setRows((x) => [...x, ...r]);
    setMore(r.length === LOG_PAGE_SIZE);
  };

  return (
    <section className="space-y-3" aria-labelledby="xero-log">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="xero-log" className="mr-auto text-lg font-semibold text-text-primary">Sync log</h2>
        <select className={selectCls} value={entity} onChange={(e) => setEntity(e.target.value as LogEntity | 'all')} aria-label="Filter by record type">
          <option value="all">All records</option>
          {XERO_ENTITIES.map((e) => <option key={e} value={e}>{ENTITY_META[e].label}</option>)}
          <option value="tax_rate">Tax rates</option>
        </select>
        <select className={selectCls} value={action} onChange={(e) => setAction(e.target.value as LogAction | 'all')} aria-label="Filter by result">
          <option value="all">All results</option>
          {(Object.keys(ACTION_STYLE) as LogAction[]).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {loading ? (
        <div className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" />
      ) : failed ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load the sync log" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Clock} title="Nothing in the log yet" description="Created, updated, linked, skipped and failed records show up here after a sync. Entries are kept for 30 days." />
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-1.5 p-3.5 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-44">
                  <Badge cls={ACTION_STYLE[r.action]}>{r.action}</Badge>
                  <span className="text-xs text-text-secondary">{r.entity === 'tax_rate' ? 'Tax rates' : ENTITY_META[r.entity].label}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-text-primary">{r.message}</p>
                  {r.xero_correlation_id && <p className="mt-0.5 text-xs text-text-secondary">Xero reference: {r.xero_correlation_id}</p>}
                </div>
                <span className="shrink-0 text-xs text-text-secondary">{timeAgo(r.created_at)}</span>
              </li>
            ))}
          </ul>
          {more && <button type="button" onClick={() => void loadMore()} className="text-sm font-medium text-accent hover:underline">Load older entries</button>}
        </>
      )}
    </section>
  );
}

// ============================================================
// PAGE
// ============================================================

export function XeroSyncPage() {
  const { toast } = useToast();
  const canManage = useCanManageXero();
  const ownerId = useXeroOwnerId();
  const [params, setParams] = useSearchParams();
  const [conn, setConn] = useState<XeroConnection | null>(null);
  const [runs, setRuns] = useState<XeroRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'resync' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmResync, setConfirmResync] = useState(false);
  const [tick, setTick] = useState(0);

  const loadAll = useCallback(
    async (silent = false) => {
      if (!ownerId) return;
      if (!silent) setLoading(true);
      try {
        const c = await getConnection(ownerId);
        setConn(c);
        setRuns(c ? await listRuns(c.id) : []);
        setFailed(false);
      } catch {
        if (!silent) setFailed(true);
      } finally {
        setLoading(false);
        setTick((t) => t + 1);
      }
    },
    [ownerId],
  );
  useEffect(() => {
    if (canManage) void loadAll();
    else setLoading(false);
  }, [canManage, loadAll]);

  // Result of the OAuth round trip.
  useEffect(() => {
    const q = params.get('xero');
    if (!q) return;
    if (q === 'connected') toast('Xero connected. Review the mapping, then run your first sync.', 'success');
    else toast(OAUTH_REASONS[params.get('reason') ?? ''] ?? 'Could not connect Xero. Please try again.', 'error');
    params.delete('xero');
    params.delete('reason');
    setParams(params, { replace: true });
  }, [params, setParams, toast]);

  const live = useRealtimeSubscription<XeroRun>({
    channelName: `xero-runs-${ownerId ?? 'anon'}`,
    table: 'xero_sync_runs',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    enabled: canManage && !!ownerId,
    onChange: () => void loadAll(true),
  });

  const running = runs[0]?.status === 'running';
  const connected = !!conn && conn.status !== 'disconnected';
  const needsReconnect = conn?.status === 'error';
  const daysLeft = refreshDaysLeft(conn?.refresh_token_expires_at);

  const connect = async () => {
    setBusy('connect');
    try {
      window.location.assign(await startOAuth());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not connect Xero.', 'error');
      setBusy(null);
    }
  };
  const sync = async (full: boolean) => {
    if (!conn) return;
    setBusy(full ? 'resync' : 'sync');
    try {
      await (full ? resyncAll(conn.id) : syncNow(conn.id));
      toast(full ? 'Full re-sync started.' : 'Sync started.', 'success');
      void loadAll(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the sync.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (!conn) return;
    setConfirmDisconnect(false);
    try {
      await disconnectXero(conn.id);
      toast('Xero disconnected.', 'success');
      void loadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not disconnect.', 'error');
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Xero">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Xero sync moves financial records, so it is limited to people who can edit the business profile and view billing. Ask your account owner for access.</p>
        </div>
      </DashboardLayout>
    );
  }

  const stats = runs[0]?.stats ?? {};
  return (
    <DashboardLayout activeLabel="Xero">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><BookOpen size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Xero</h1>
              <LiveIndicator status={live} />
              <Badge cls="bg-warning-500/10 text-warning-500" title="Built from Xero's public documentation and tested with mocked data only. Verify with a Xero Demo Company before relying on it.">Not live-verified</Badge>
            </div>
            <p className="text-sm text-text-secondary">Sync of accounts, contacts, items, invoices, payments and tax rates, with multi-currency invoices.</p>
          </div>
        </div>

        {loading ? (
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading Xero connection" />
        ) : failed ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load your Xero connection" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void loadAll() }} />
        ) : !connected ? (
          <EmptyState
            icon={Link2}
            title="Connect Xero"
            description="Sign in with Xero and approve access to one organisation. You choose what syncs, in which direction, and who wins when both sides change. Nothing is deleted in either system."
            action={{ label: busy === 'connect' ? 'Opening Xero…' : 'Connect Xero', onClick: () => void connect() }}
          />
        ) : (
          <>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-base font-semibold text-text-primary">{conn.organisation_name ?? `Organisation ${conn.tenant_id.slice(0, 8)}`}</p>
                    {needsReconnect ? <Badge cls="bg-error-500/10 text-error-500"><AlertTriangle size={12} /> Needs reconnect</Badge> : running ? <Badge cls="bg-accent/10 text-accent"><Loader2 size={12} className="animate-spin" /> Syncing</Badge> : <Badge cls="bg-success-500/10 text-success-500"><CheckCircle2 size={12} /> Connected</Badge>}
                    {conn.is_demo && <Badge cls="bg-warning-500/10 text-warning-500">Demo company</Badge>}
                    {conn.base_currency && <Badge cls="bg-bg-tertiary text-text-secondary">Base {conn.base_currency}</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">Last synced {timeAgo(conn.last_synced_at)}{conn.last_error ? ` · ${conn.last_error}` : ''}</p>
                  {daysLeft !== null && daysLeft <= 14 && !needsReconnect && <p className="mt-1 text-sm text-warning-500">Xero access expires in {Math.max(daysLeft, 0)} days unless a sync runs. Run a sync to renew it.</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {needsReconnect ? (
                    <button type="button" onClick={() => void connect()} disabled={busy === 'connect'} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"><Link2 size={16} /> Reconnect</button>
                  ) : (
                    <button type="button" onClick={() => void sync(false)} disabled={!!busy || running} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                      <RefreshCw size={16} className={running || busy === 'sync' ? 'animate-spin' : ''} /> Sync now
                    </button>
                  )}
                  <button type="button" onClick={() => setConfirmResync(true)} disabled={!!busy || running || needsReconnect} className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary disabled:opacity-50">Full re-sync</button>
                  <button type="button" onClick={() => setConfirmDisconnect(true)} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary"><Unplug size={16} /> Disconnect</button>
                </div>
              </div>
              {runs[0] && (
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-3 text-sm text-text-secondary">
                  <Badge cls={RUN_STYLE[runs[0].status]}>{runs[0].status}</Badge>
                  <span>{stats.created_vireek ?? 0} created in Vireek</span>
                  <span>{stats.created_xero ?? 0} created in Xero</span>
                  <span>{(stats.updated_vireek ?? 0) + (stats.updated_xero ?? 0)} updated</span>
                  <span>{stats.conflicts ?? 0} conflicts</span>
                  <span className={(stats.errors ?? 0) > 0 ? 'text-error-500' : ''}>{stats.errors ?? 0} errors</span>
                </div>
              )}
            </div>

            <ConflictsPanel conn={conn} refreshKey={tick} onChanged={() => void loadAll(true)} />
            <MappingPanel conn={conn} onSaved={() => void loadAll(true)} />
            <TaxRatesPanel conn={conn} refreshKey={tick} />
            <LogPanel conn={conn} refreshKey={tick} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Xero?"
        description="Syncing stops, the connection is removed in Xero and the stored credentials are deleted. Records already synced stay in both systems untouched. Reconnecting later re-matches records by email, name, account code or invoice number."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={confirmResync}
        title="Re-read everything from scratch?"
        description="Every record is compared again. Matching records are left alone and nothing is duplicated, but a large organisation can take several runs to finish."
        confirmLabel="Start full re-sync"
        onConfirm={() => {
          setConfirmResync(false);
          void sync(true);
        }}
        onCancel={() => setConfirmResync(false)}
      />
    </DashboardLayout>
  );
}

export default XeroSyncPage;
