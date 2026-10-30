import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, CheckCircle2, Clock, FlaskConical, Link2, Loader2, Lock, RefreshCw, Save, Unplug } from 'lucide-react';
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
  IA_CONFLICT_RULES,
  IA_DIRECTIONS,
  IA_ENTITIES,
  LOG_PAGE_SIZE,
  NOT_LIVE_VERIFIED_LABEL,
  NOT_LIVE_VERIFIED_NOTE,
  VIREEK_FIELDS,
  connectIntacct,
  disconnectIntacct,
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
  useCanManageIntacct,
  useIntacctOwnerId,
  validateConnectInput,
  validateSettings,
  vireekFieldLabel,
  type IaConflict,
  type IaConflictRule,
  type IaConnection,
  type IaDirection,
  type IaEntity,
  type IaLogRow,
  type IaOptions,
  type IaRun,
  type IaSettings,
  type LogAction,
} from '@/lib/sageIntacct';

const ACTION_STYLE: Record<LogAction, string> = {
  created: 'bg-success-500/10 text-success-500',
  updated: 'bg-accent/10 text-accent',
  linked: 'bg-accent/10 text-accent',
  voided: 'bg-warning-500/10 text-warning-500',
  conflict: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-error-500/10 text-error-500',
};
const RUN_STYLE: Record<IaRun['status'], string> = {
  running: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-error-500/10 text-error-500',
};
const selectCls = 'rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none';

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

// ============================================================
// MAPPING
// ============================================================

function MappingPanel({ conn, onSaved }: { conn: IaConnection; onSaved: () => void }) {
  const { toast } = useToast();
  const saved = useMemo(() => readSettings(conn.settings), [conn.settings]);
  const [draft, setDraft] = useState<IaSettings>(saved);
  const [auto, setAuto] = useState(conn.auto_sync);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<IaOptions | null>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const [open, setOpen] = useState<IaEntity | null>(null);

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

  const patch = (entity: IaEntity, p: Partial<IaSettings['entities'][IaEntity]>) =>
    setDraft((d) => ({ ...d, entities: { ...d.entities, [entity]: { ...d.entities[entity], ...p } } }));
  const setDefault = (k: keyof IaSettings['defaults'], v: string | boolean | null) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, [k]: v } }));

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

  const pickList = (label: string, key: 'revenueAccountNo' | 'taxAccountNo' | 'bankAccountId', rows: { id: string; name: string }[], hint: string) => (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text-primary">{label}</span>
      <select className={selectCls} value={draft.defaults[key] ?? ''} onChange={(e) => setDefault(key, e.target.value || null)} disabled={!options}>
        <option value="">{options ? 'Not set' : 'Loading…'}</option>
        {draft.defaults[key] && !rows.some((r) => r.id === draft.defaults[key]) && <option value={draft.defaults[key] ?? ''}>{draft.defaults[key]}</option>}
        {rows.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
      <span className="text-xs text-text-secondary">{hint}</span>
    </label>
  );

  return (
    <section className="space-y-4" aria-labelledby="ia-mapping">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ia-mapping" className="text-lg font-semibold text-text-primary">Mapping &amp; conflict rules</h2>
        <button type="button" onClick={save} disabled={!dirty || saving || !check.ok} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save mapping
        </button>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
        {IA_ENTITIES.map((entity) => {
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
                <span className="hidden text-xs text-text-secondary lg:inline">{meta.vireekLabel} ↔ {meta.intacctLabel}</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select className={selectCls} value={es.direction} disabled={!es.enabled} onChange={(e) => patch(entity, { direction: e.target.value as IaDirection })} aria-label={`${meta.label} direction`}>
                    {IA_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label}</option>)}
                  </select>
                  <select className={selectCls} value={es.conflict} disabled={!es.enabled} onChange={(e) => patch(entity, { conflict: e.target.value as IaConflictRule })} aria-label={`${meta.label} conflict rule`} title={CONFLICT_RULE_META[es.conflict].hint}>
                    {IA_CONFLICT_RULES.map((r) => <option key={r} value={r}>{CONFLICT_RULE_META[r].label}</option>)}
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
                          onChange={(e) => patch(entity, { fields: { ...es.fields, [f.key]: e.target.value as IaDirection | 'off' } })}
                        >
                          {IA_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label}</option>)}
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
        <h3 className="font-medium text-text-primary">Defaults for records Vireek creates in Sage Intacct</h3>
        <p className="mb-3 mt-1 text-xs text-text-secondary">Sage Intacct needs these to accept new invoices and payments. Nothing is sent for a record whose default is missing; it is listed in the log instead.</p>
        {optError && <p className="mb-3 text-sm text-warning-500">Could not load your Sage Intacct lists: {optError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {pickList('Revenue account for invoice lines', 'revenueAccountNo', (options?.accounts ?? []).map((a) => ({ id: a.id, name: `${a.id} · ${a.name}` })), 'Used for lines whose Vireek revenue account is not linked. Required to send invoices.')}
          {pickList('Sales tax account', 'taxAccountNo', (options?.accounts ?? []).map((a) => ({ id: a.id, name: `${a.id} · ${a.name}` })), 'Tax is sent to and read from this account, so it is never booked as revenue. Required for invoices that carry tax.')}
          {pickList('Bank account for payments', 'bankAccountId', options?.banks ?? [], 'Payments Vireek sends are deposited here. Required to send payments.')}
        </div>
        <label className="mt-4 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={draft.defaults.sendInvoiceNumber} onChange={(e) => setDefault('sendInvoiceNumber', e.target.checked)} className="h-4 w-4" />
          Send the Vireek invoice number to Sage Intacct
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

function ConflictsPanel({ conn, refreshKey, onChanged }: { conn: IaConnection; refreshKey: number; onChanged: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<IaConflict[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConflicts(conn.id).then((r) => !cancelled && setRows(r)).catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [conn.id, refreshKey]);

  const resolve = async (c: IaConflict, winner: 'vireek' | 'intacct') => {
    setBusy(c.link_id + winner);
    try {
      await resolveConflict(c.link_id, winner);
      toast(winner === 'vireek' ? 'Kept the Vireek value.' : 'Kept the Sage Intacct value.', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not resolve the conflict.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!rows || rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="ia-conflicts">
      <h2 id="ia-conflicts" className="flex items-center gap-2 text-lg font-semibold text-text-primary">
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
                    <dd className="truncate text-text-primary" title={fmt(f.intacct)}>Sage Intacct: {fmt(f.intacct)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!!busy} onClick={() => resolve(c, 'vireek')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'vireek' ? 'Applying…' : 'Keep Vireek'}
              </button>
              <button type="button" disabled={!!busy} onClick={() => resolve(c, 'intacct')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'intacct' ? 'Applying…' : 'Keep Sage Intacct'}
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

function LogPanel({ conn, refreshKey }: { conn: IaConnection; refreshKey: number }) {
  const [action, setAction] = useState<LogAction | 'all'>('all');
  const [entity, setEntity] = useState<IaEntity | 'all'>('all');
  const [rows, setRows] = useState<IaLogRow[]>([]);
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
    <section className="space-y-3" aria-labelledby="ia-log">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="ia-log" className="mr-auto text-lg font-semibold text-text-primary">Sync log</h2>
        <select className={selectCls} value={entity} onChange={(e) => setEntity(e.target.value as IaEntity | 'all')} aria-label="Filter by record type">
          <option value="all">All records</option>
          {IA_ENTITIES.map((e) => <option key={e} value={e}>{ENTITY_META[e].label}</option>)}
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
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-text-primary">{r.message}</p>
                  {r.request_id && <p className="mt-0.5 text-xs text-text-secondary">Sage Intacct reference: {r.request_id}</p>}
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

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState({ companyId: '', userId: '', password: '', entityId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputCls = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateConnectInput(f);
    if (err) return setError(err);
    setError(null);
    setBusy(true);
    try {
      await connectIntacct(f);
      setF({ companyId: '', userId: '', password: '', entityId: '' });
      toast('Sage Intacct connected. Review the mapping, then run your first sync.', 'success');
      onConnected();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Could not connect Sage Intacct.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="ia-connect">
      <div>
        <h2 id="ia-connect" className="text-lg font-semibold text-text-primary">Connect Sage Intacct</h2>
        <p className="mt-1 text-sm text-text-secondary">
          In Sage Intacct, create a dedicated web services user and authorise Vireek’s sender ID for your company. Credentials are verified with Sage Intacct, then stored encrypted and never shown again. You choose what syncs, in which direction, and who wins when both sides change. Nothing is deleted in either system.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Company ID</span><input className={inputCls} value={f.companyId} onChange={set('companyId')} autoComplete="off" required /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Entity ID (optional)</span><input className={inputCls} value={f.entityId} onChange={set('entityId')} autoComplete="off" placeholder="Leave empty for top level" /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Web services user ID</span><input className={inputCls} value={f.userId} onChange={set('userId')} autoComplete="off" required /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Password</span><input className={inputCls} type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required /></label>
      </div>
      {error && <p role="alert" className="text-sm text-error-500">{error}</p>}
      <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} {busy ? 'Verifying with Sage Intacct…' : 'Connect Sage Intacct'}
      </button>
    </form>
  );
}

export function SageIntacctSyncPage() {
  const { toast } = useToast();
  const canManage = useCanManageIntacct();
  const ownerId = useIntacctOwnerId();
  const [conn, setConn] = useState<IaConnection | null>(null);
  const [runs, setRuns] = useState<IaRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'sync' | 'resync' | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmResync, setConfirmResync] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
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

  const live = useRealtimeSubscription<IaRun>({
    channelName: `intacct-runs-${ownerId ?? 'anon'}`,
    table: 'intacct_sync_runs',
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
      await disconnectIntacct(conn.id);
      toast('Sage Intacct disconnected.', 'success');
      void loadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not disconnect.', 'error');
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Sage Intacct">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Sage Intacct sync moves financial records, so it is limited to people who can edit the business profile and view billing. Ask your account owner for access.</p>
        </div>
      </DashboardLayout>
    );
  }

  const stats = runs[0]?.stats ?? {};
  return (
    <DashboardLayout activeLabel="Sage Intacct">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><Calculator size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Sage Intacct</h1>
              <Badge cls="bg-warning-500/10 text-warning-500"><FlaskConical size={12} /> {NOT_LIVE_VERIFIED_LABEL}</Badge>
              <LiveIndicator status={live} />
            </div>
            <p className="text-sm text-text-secondary">Two-way sync of GL accounts, customers, invoices and payments.</p>
          </div>
        </div>
        <p role="note" className="rounded-xl border border-warning-500/40 bg-warning-500/5 px-4 py-3 text-sm text-text-secondary">{NOT_LIVE_VERIFIED_NOTE}</p>

        {loading ? (
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label="Loading Sage Intacct connection" />
        ) : failed ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load your Sage Intacct connection" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void loadAll() }} />
        ) : !connected ? (
          <ConnectForm onConnected={() => void loadAll()} />
        ) : (
          <>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-base font-semibold text-text-primary">{conn.company_name ?? `Company ${conn.company_id}`}{conn.entity_id ? ` · ${conn.entity_id}` : ''}</p>
                    {needsReconnect ? <Badge cls="bg-error-500/10 text-error-500"><AlertTriangle size={12} /> Needs reconnect</Badge> : running ? <Badge cls="bg-accent/10 text-accent"><Loader2 size={12} className="animate-spin" /> Syncing</Badge> : <Badge cls="bg-success-500/10 text-success-500"><CheckCircle2 size={12} /> Connected</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">Last synced {timeAgo(conn.last_synced_at)}{conn.last_error ? ` · ${conn.last_error}` : ''}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {needsReconnect ? (
                    <button type="button" onClick={() => setReconnecting(true)} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"><Link2 size={16} /> Reconnect</button>
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
                  <span>{stats.created_intacct ?? 0} created in Sage Intacct</span>
                  <span>{(stats.updated_vireek ?? 0) + (stats.updated_intacct ?? 0)} updated</span>
                  <span>{stats.conflicts ?? 0} conflicts</span>
                  <span className={(stats.errors ?? 0) > 0 ? 'text-error-500' : ''}>{stats.errors ?? 0} errors</span>
                </div>
              )}
            </div>

            {reconnecting && <ConnectForm onConnected={() => { setReconnecting(false); void loadAll(); }} />}
            <ConflictsPanel conn={conn} refreshKey={tick} onChanged={() => void loadAll(true)} />
            <MappingPanel conn={conn} onSaved={() => void loadAll(true)} />
            <LogPanel conn={conn} refreshKey={tick} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Sage Intacct?"
        description="Syncing stops and the stored credentials are deleted. Records already synced stay in both systems untouched. Reconnecting later re-matches records by email, name, account number or invoice number."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={confirmResync}
        title="Re-read everything from scratch?"
        description="Every record is compared again. Matching records are left alone and nothing is duplicated, but a large company can take several runs to finish."
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
