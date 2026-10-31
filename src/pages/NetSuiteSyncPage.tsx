import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Clock, Link2, Loader2, Lock, RefreshCw, Save, ShieldAlert, Unplug } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  ENVIRONMENT_LABEL,
  LOG_PAGE_SIZE,
  NS_CONFLICT_RULES,
  NS_DIRECTIONS,
  NS_ENTITIES,
  NS_VERIFICATION,
  VIREEK_FIELDS,
  connectNetSuite,
  disconnectNetSuite,
  effectiveDirection,
  getConnection,
  listConflicts,
  listLog,
  listRuns,
  loadOptions,
  readSettings,
  resolveConflict,
  resyncAll,
  saveSettings,
  syncNow,
  timeAgo,
  useCanManageNetSuite,
  useNsOwnerId,
  validateCredentials,
  validateSettings,
  vireekFieldLabel,
  type LogAction,
  type NsConflict,
  type NsConflictRule,
  type NsConnection,
  type NsCredentialsForm,
  type NsDirection,
  type NsEntity,
  type NsLogRow,
  type NsOptions,
  type NsRun,
  type NsSettings,
} from '@/lib/netsuite';

const ACTION_STYLE: Record<LogAction, string> = {
  created: 'bg-success-500/10 text-success-500',
  updated: 'bg-accent/10 text-accent',
  linked: 'bg-accent/10 text-accent',
  voided: 'bg-warning-500/10 text-warning-500',
  conflict: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-error-500/10 text-error-500',
};
const RUN_STYLE: Record<NsRun['status'], string> = {
  running: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-error-500/10 text-error-500',
};
const selectCls = 'rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none';
const inputCls = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** Always-visible honesty label: this integration has not been run against a live NetSuite account. */
function VerificationBanner() {
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/5 p-4">
      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warning-500" />
      <p className="text-sm text-text-secondary">
        <span className="font-semibold text-text-primary">{NS_VERIFICATION.label}. </span>
        {NS_VERIFICATION.detail}
      </p>
    </div>
  );
}

// ============================================================
// CONNECT (token-based authentication)
// ============================================================

const EMPTY_FORM: NsCredentialsForm = { accountId: '', consumerKey: '', consumerSecret: '', tokenId: '', tokenSecret: '' };

function ConnectPanel({ reconnectAccount, onConnected }: { reconnectAccount?: string; onConnected: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<NsCredentialsForm>({ ...EMPTY_FORM, accountId: reconnectAccount ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = validateCredentials(form);

  const set = (k: keyof NsCredentialsForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connectNetSuite(form);
      setForm(EMPTY_FORM); // credentials never stay in the browser
      toast('NetSuite connected. Review the mapping, then run your first sync.', 'success');
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect NetSuite.');
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof NsCredentialsForm, label: string, hint: string, secret = false) => (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text-primary">{label}</span>
      <input
        className={inputCls}
        type={secret ? 'password' : 'text'}
        value={form[k]}
        onChange={set(k)}
        autoComplete="off"
        spellCheck={false}
        required
        aria-label={label}
      />
      <span className="text-xs text-text-secondary">{hint}</span>
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="ns-connect">
      <div>
        <h2 id="ns-connect" className="text-lg font-semibold text-text-primary">Connect NetSuite</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Uses NetSuite token-based authentication. A NetSuite administrator creates an integration record and an access token for a dedicated role, then pastes the four values below.
          Credentials are verified with one test call and stored encrypted; they are never shown again.
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">
        <li>Enable REST Web Services and Token-Based Authentication (Setup → Company → Enable Features → SuiteCloud).</li>
        <li>Create an integration record (Setup → Integration → Manage Integrations → New) with Token-Based Authentication checked. Copy the consumer key and secret.</li>
        <li>Create a role with REST Web Services, Log in using Access Tokens, SuiteAnalytics Workbook and customer, item, invoice and payment permissions.</li>
        <li>Create an access token for that role (Setup → Users/Roles → Access Tokens → New). Copy the token ID and secret.</li>
      </ol>
      <div className="grid gap-4 sm:grid-cols-2">
        {field('accountId', 'Account ID', 'Setup → Company → Company Information. Sandboxes look like 1234567_SB1.')}
        <span className="hidden sm:block" />
        {field('consumerKey', 'Consumer key', 'From the integration record.', true)}
        {field('consumerSecret', 'Consumer secret', 'From the integration record.', true)}
        {field('tokenId', 'Token ID', 'From the access token.', true)}
        {field('tokenSecret', 'Token secret', 'From the access token.', true)}
      </div>
      {error && <p role="alert" className="text-sm text-error-500">{error}</p>}
      <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} {busy ? 'Checking with NetSuite…' : 'Verify and connect'}
      </button>
    </form>
  );
}

// ============================================================
// MAPPING
// ============================================================

const INCOME_TYPES = ['Income', 'OthIncome'];
const DEPOSIT_TYPES = ['Bank', 'OthCurrAsset'];
const AR_TYPES = ['AcctRec'];

function MappingPanel({ conn, onSaved }: { conn: NsConnection; onSaved: () => void }) {
  const { toast } = useToast();
  const saved = useMemo(() => readSettings(conn.settings), [conn.settings]);
  const [draft, setDraft] = useState<NsSettings>(saved);
  const [auto, setAuto] = useState(conn.auto_sync);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<NsOptions | null>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const [open, setOpen] = useState<NsEntity | null>(null);

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

  const patch = (entity: NsEntity, p: Partial<NsSettings['entities'][NsEntity]>) =>
    setDraft((d) => ({ ...d, entities: { ...d.entities, [entity]: { ...d.entities[entity], ...p } } }));
  const setDefault = (k: keyof NsSettings['defaults'], v: string | boolean | null) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, [k]: v } }));

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

  type IdKey = 'subsidiaryId' | 'arAccountId' | 'depositAccountId' | 'incomeAccountId' | 'fallbackItemId' | 'taxCodeId';
  const pickList = (label: string, key: IdKey, rows: { id: string; name: string }[], hint: string) => (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text-primary">{label}</span>
      <select className={selectCls} value={draft.defaults[key] ?? ''} onChange={(e) => setDefault(key, e.target.value || null)} disabled={!options}>
        <option value="">{options ? 'Not set' : 'Loading…'}</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
      <span className="text-xs text-text-secondary">{hint}</span>
    </label>
  );
  const accountsOf = (types: string[]) => (options?.accounts ?? []).filter((a) => types.includes(a.type));

  return (
    <section className="space-y-4" aria-labelledby="ns-mapping">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ns-mapping" className="text-lg font-semibold text-text-primary">Mapping &amp; conflict rules</h2>
        <button type="button" onClick={save} disabled={!dirty || saving || !check.ok} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save mapping
        </button>
      </div>
      {!check.ok && <p role="alert" className="text-sm text-error-500">{check.error}</p>}

      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
        {NS_ENTITIES.map((entity) => {
          const es = draft.entities[entity];
          const meta = ENTITY_META[entity];
          const fields = VIREEK_FIELDS[entity];
          return (
            <div key={entity} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-w-[9rem] items-center gap-2.5">
                  <input type="checkbox" checked={es.enabled} onChange={(e) => patch(entity, { enabled: e.target.checked })} className="h-4 w-4" aria-label={`Sync ${meta.label}`} />
                  <span className="font-medium text-text-primary">{meta.label}</span>
                </label>
                <span className="hidden text-xs text-text-secondary lg:inline">{meta.vireekLabel} ↔ {meta.nsLabel}</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select className={selectCls} value={es.direction} disabled={!es.enabled} onChange={(e) => patch(entity, { direction: e.target.value as NsDirection })} aria-label={`${meta.label} direction`}>
                    {NS_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label}</option>)}
                  </select>
                  <select className={selectCls} value={es.conflict} disabled={!es.enabled} onChange={(e) => patch(entity, { conflict: e.target.value as NsConflictRule })} aria-label={`${meta.label} conflict rule`} title={CONFLICT_RULE_META[es.conflict].hint}>
                    {NS_CONFLICT_RULES.map((r) => <option key={r} value={r}>{CONFLICT_RULE_META[r].label}</option>)}
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
                        <select
                          className={selectCls}
                          value={dir}
                          aria-label={`${f.label} direction`}
                          onChange={(e) => patch(entity, { fields: { ...es.fields, [f.key]: e.target.value as NsDirection | 'off' } })}
                        >
                          {NS_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label}</option>)}
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
        <h3 className="font-medium text-text-primary">Defaults for records Vireek creates in NetSuite</h3>
        <p className="mb-3 mt-1 text-xs text-text-secondary">NetSuite needs these to accept new items, invoices and payments. Nothing is sent for a record whose default is missing; it is listed in the log instead.</p>
        {optError && <p className="mb-3 text-sm text-warning-500">Could not load your NetSuite lists: {optError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {pickList('Subsidiary (OneWorld only)', 'subsidiaryId', options?.subsidiaries ?? [], 'Leave empty if your NetSuite account has no subsidiaries.')}
          {pickList('Fallback item for invoice lines', 'fallbackItemId', options?.items ?? [], 'Used when a line matches no synced item. Required to send invoices.')}
          {pickList('Income account for new items', 'incomeAccountId', accountsOf(INCOME_TYPES), 'Required only if Vireek creates service items in NetSuite.')}
          {pickList('A/R account for invoices (optional)', 'arAccountId', accountsOf(AR_TYPES), 'Empty = the customer’s NetSuite default.')}
          {pickList('Deposit account for payments (optional)', 'depositAccountId', accountsOf(DEPOSIT_TYPES), 'Empty = NetSuite’s default for the payment method.')}
          {pickList('Sales tax code (optional)', 'taxCodeId', options?.taxCodes ?? [], 'Applied to taxable lines. NetSuite calculates its own tax, so totals can differ.')}
        </div>
        <label className="mt-4 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={draft.defaults.sendTranId} onChange={(e) => setDefault('sendTranId', e.target.checked)} className="h-4 w-4" />
          Send the Vireek invoice number to NetSuite
        </label>
        <label className="mt-2 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={draft.defaults.sendEntityId} onChange={(e) => setDefault('sendEntityId', e.target.checked)} className="h-4 w-4" />
          My NetSuite requires a customer ID (manual customer numbering)
        </label>
        <label className="mt-2 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4" />
          Sync automatically every 15 minutes
        </label>
      </div>
    </section>
  );
}

// ============================================================
// CONFLICTS
// ============================================================

function ConflictsPanel({ conn, refreshKey, onChanged }: { conn: NsConnection; refreshKey: number; onChanged: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<NsConflict[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConflicts(conn.id).then((r) => !cancelled && setRows(r)).catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [conn.id, refreshKey]);

  const resolve = async (c: NsConflict, winner: 'vireek' | 'ns') => {
    setBusy(c.link_id + winner);
    try {
      await resolveConflict(c.link_id, winner);
      toast(winner === 'vireek' ? 'Kept the Vireek value.' : 'Kept the NetSuite value.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not resolve the conflict.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!rows || rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="ns-conflicts">
      <h2 id="ns-conflicts" className="flex items-center gap-2 text-lg font-semibold text-text-primary">
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
                  <div key={f.field} className="grid grid-cols-1 gap-1 sm:grid-cols-[8rem_1fr_1fr] sm:gap-3">
                    <dt className="text-text-secondary">{vireekFieldLabel(c.entity, f.field)}</dt>
                    <dd className="truncate text-text-primary" title={fmt(f.vireek)}>Vireek: {fmt(f.vireek)}</dd>
                    <dd className="truncate text-text-primary" title={fmt(f.ns)}>NetSuite: {fmt(f.ns)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!!busy} onClick={() => resolve(c, 'vireek')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'vireek' ? 'Applying…' : 'Keep Vireek'}
              </button>
              <button type="button" disabled={!!busy} onClick={() => resolve(c, 'ns')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'ns' ? 'Applying…' : 'Keep NetSuite'}
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

function LogPanel({ conn, refreshKey }: { conn: NsConnection; refreshKey: number }) {
  const [action, setAction] = useState<LogAction | 'all'>('all');
  const [entity, setEntity] = useState<NsEntity | 'all'>('all');
  const [rows, setRows] = useState<NsLogRow[]>([]);
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
    try {
      const r = await listLog(conn.id, { action, entity, before: rows[rows.length - 1]?.created_at });
      setRows((x) => [...x, ...r]);
      setMore(r.length === LOG_PAGE_SIZE);
    } catch {
      setMore(false);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="ns-log">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="ns-log" className="mr-auto text-lg font-semibold text-text-primary">Sync log</h2>
        <select className={selectCls} value={entity} onChange={(e) => setEntity(e.target.value as NsEntity | 'all')} aria-label="Filter by record type">
          <option value="all">All records</option>
          {NS_ENTITIES.map((e) => <option key={e} value={e}>{ENTITY_META[e].label}</option>)}
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
                  <span className="text-xs text-text-secondary">{ENTITY_META[r.entity].label}</span>
                </div>
                <p className="min-w-0 flex-1 break-words text-sm text-text-primary">{r.message}</p>
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

export function NetSuiteSyncPage() {
  const { toast } = useToast();
  const canManage = useCanManageNetSuite();
  const ownerId = useNsOwnerId();
  const [conn, setConn] = useState<NsConnection | null>(null);
  const [runs, setRuns] = useState<NsRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'sync' | 'resync' | null>(null);
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

  const live = useRealtimeSubscription<NsRun>({
    channelName: `ns-runs-${ownerId ?? 'anon'}`,
    table: 'ns_sync_runs',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    enabled: canManage && !!ownerId,
    onChange: () => void loadAll(true),
  });

  const running = runs[0]?.status === 'running';
  const connected = !!conn && conn.status !== 'disconnected';
  const needsReconnect = conn?.status === 'error';

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
      await disconnectNetSuite(conn.id);
      toast('NetSuite disconnected.', 'success');
      void loadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not disconnect.', 'error');
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="NetSuite">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">NetSuite sync moves financial records, so it is limited to people who can edit the business profile and view billing. Ask your account owner for access.</p>
        </div>
      </DashboardLayout>
    );
  }

  const stats = runs[0]?.stats ?? {};
  return (
    <DashboardLayout activeLabel="NetSuite">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><Building2 size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary sm:text-2xl">NetSuite</h1>
              <Badge cls="bg-warning-500/10 text-warning-500">{NS_VERIFICATION.label}</Badge>
              <LiveIndicator status={live} />
            </div>
            <p className="text-sm text-text-secondary">Sync of customers, items, invoices and payments through SuiteTalk REST.</p>
          </div>
        </div>

        <VerificationBanner />

        {loading ? (
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading NetSuite connection" />
        ) : failed ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load your NetSuite connection" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void loadAll() }} />
        ) : !connected ? (
          <ConnectPanel onConnected={() => void loadAll()} />
        ) : conn ? (
          <>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-base font-semibold text-text-primary">{conn.company_name ?? `Account ${conn.account_id}`}</p>
                    {needsReconnect ? <Badge cls="bg-error-500/10 text-error-500"><AlertTriangle size={12} /> Needs reconnect</Badge> : running ? <Badge cls="bg-accent/10 text-accent"><Loader2 size={12} className="animate-spin" /> Syncing</Badge> : <Badge cls="bg-success-500/10 text-success-500"><CheckCircle2 size={12} /> Connected</Badge>}
                    {conn.environment !== 'production' && <Badge cls="bg-warning-500/10 text-warning-500">{ENVIRONMENT_LABEL[conn.environment]}</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">Account {conn.account_id} · last synced {timeAgo(conn.last_synced_at)}{conn.last_error ? ` · ${conn.last_error}` : ''}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!needsReconnect && (
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
                  <span>{stats.created_ns ?? 0} created in NetSuite</span>
                  <span>{(stats.updated_vireek ?? 0) + (stats.updated_ns ?? 0)} updated</span>
                  <span>{stats.conflicts ?? 0} conflicts</span>
                  <span className={(stats.errors ?? 0) > 0 ? 'text-error-500' : ''}>{stats.errors ?? 0} errors</span>
                </div>
              )}
            </div>

            {needsReconnect && <ConnectPanel reconnectAccount={conn.account_id} onConnected={() => void loadAll()} />}
            <ConflictsPanel conn={conn} refreshKey={tick} onChanged={() => void loadAll(true)} />
            <MappingPanel conn={conn} onSaved={() => void loadAll(true)} />
            <LogPanel conn={conn} refreshKey={tick} />
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect NetSuite?"
        description="Syncing stops and the stored credentials are deleted from Vireek. Records already synced stay in both systems untouched. Also revoke the access token in NetSuite (Setup → Users/Roles → Access Tokens), because only NetSuite can revoke it."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={confirmResync}
        title="Re-read everything from scratch?"
        description="Every record is compared again. Matching records are left alone and nothing is duplicated, but a large account can take several runs to finish."
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
