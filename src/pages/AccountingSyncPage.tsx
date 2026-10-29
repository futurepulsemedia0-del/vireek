import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { AlertTriangle, Calculator, CheckCircle2, Clock, Copy, Link2, Loader2, Lock, RefreshCw, Save, Unplug } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  ACCT_CONFLICT_RULES,
  ACCT_DIRECTIONS,
  ACCT_ENTITIES,
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  LOG_PAGE_SIZE,
  OAUTH_REASONS,
  PROVIDER_META,
  connectNetSuite,
  disconnectAccounting,
  effectiveDirection,
  fieldLabel,
  fieldsFor,
  getConnection,
  getNetSuiteCertificate,
  listConflicts,
  listLog,
  listRuns,
  loadOptions,
  providerFromSlug,
  readSettings,
  refreshDaysLeft,
  resolveConflict,
  resyncAll,
  saveSettings,
  startOAuth,
  syncNow,
  timeAgo,
  useAcctOwnerId,
  useCanManageAccounting,
  validateSettings,
  type AcctConflict,
  type AcctConflictRule,
  type AcctConnection,
  type AcctDirection,
  type AcctEntity,
  type AcctLogRow,
  type AcctOptions,
  type AcctProvider,
  type AcctRun,
  type AcctSettings,
  type LogAction,
  type OptionRow,
} from '@/lib/accounting';

const ACTION_STYLE: Record<LogAction, string> = {
  created: 'bg-success-500/10 text-success-500',
  updated: 'bg-accent/10 text-accent',
  linked: 'bg-accent/10 text-accent',
  voided: 'bg-warning-500/10 text-warning-500',
  conflict: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  error: 'bg-error-500/10 text-error-500',
};
const RUN_STYLE: Record<AcctRun['status'], string> = {
  running: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-error-500/10 text-error-500',
};
const selectCls = 'rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none';
const inputCls = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';
const btnPrimary = 'inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50';

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

// ============================================================
// CONNECT (provider specific)
// ============================================================

function ConnectPanel({ provider, onConnected }: { provider: AcctProvider; onConnected: () => void }) {
  const { toast } = useToast();
  const meta = PROVIDER_META[provider];
  const [busy, setBusy] = useState(false);
  const [region, setRegion] = useState('com');
  const [ns, setNs] = useState({ account_id: '', client_id: '', certificate_id: '' });
  const [cert, setCert] = useState<{ certificate: string; algorithm: string } | null>(null);
  const [certError, setCertError] = useState<string | null>(null);

  useEffect(() => {
    if (provider !== 'netsuite') return;
    let cancelled = false;
    getNetSuiteCertificate().then((c) => !cancelled && setCert(c)).catch((e: Error) => !cancelled && setCertError(e.message));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const oauth = async () => {
    setBusy(true);
    try {
      window.location.assign(await startOAuth(provider, provider === 'zoho_books' ? region : undefined));
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not connect ${meta.label}.`, 'error');
      setBusy(false);
    }
  };
  const m2m = async () => {
    setBusy(true);
    try {
      await connectNetSuite(ns);
      toast('NetSuite connected. Review the mapping, then run your first sync.', 'success');
      onConnected();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not connect NetSuite.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (provider !== 'netsuite') {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Link2 size={26} /></span>
        <h2 className="mt-4 text-lg font-semibold text-text-primary">Connect {meta.label}</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-text-secondary">
          Sign in with {meta.label} and approve access. You choose what syncs, in which direction, and who wins when both sides change. Nothing is deleted in either system.
        </p>
        {provider === 'zoho_books' && (
          <label className="mx-auto mt-4 flex max-w-xs flex-col gap-1.5 text-left text-sm">
            <span className="font-medium text-text-primary">Where is your Zoho account hosted?</span>
            <select className={selectCls} value={region} onChange={(e) => setRegion(e.target.value)}>
              {meta.regions?.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
        )}
        <button type="button" onClick={() => void oauth()} disabled={busy} className={`${btnPrimary} mt-5`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} {busy ? `Opening ${meta.label}…` : `Connect ${meta.label}`}
        </button>
      </div>
    );
  }

  const ready = ns.account_id.trim() && ns.client_id.trim() && ns.certificate_id.trim();
  return (
    <div className="space-y-5 rounded-2xl border border-border bg-bg-secondary p-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Connect NetSuite</h2>
        <p className="mt-1 text-sm text-text-secondary">NetSuite connects server-to-server, so it never needs a weekly re-login. Setup takes about ten minutes for a NetSuite administrator.</p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-text-secondary">
        <li>Enable <strong className="text-text-primary">REST Web Services</strong> and <strong className="text-text-primary">OAuth 2.0</strong> (Setup → Company → Enable Features → SuiteCloud).</li>
        <li>Create an <strong className="text-text-primary">integration record</strong> with <em>Client Credentials (Machine to Machine) Grant</em> and the <em>REST Web Services</em> scope. Copy the Client ID.</li>
        <li>Upload the certificate below under <strong className="text-text-primary">Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup</strong>, pick the integration, a user and a role that can read and write customers, items, accounts, invoices and payments. Copy the Certificate ID.</li>
      </ol>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-text-primary">Vireek public certificate ({cert?.algorithm ?? '…'})</span>
          {cert && (
            <button type="button" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline" onClick={() => void navigator.clipboard.writeText(cert.certificate).then(() => toast('Certificate copied.', 'success'))}>
              <Copy size={14} /> Copy
            </button>
          )}
        </div>
        {certError ? <p className="text-sm text-warning-500">{certError}</p> : cert ? <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg-primary p-3 text-xs text-text-secondary">{cert.certificate}</pre> : <div className="h-20 animate-pulse rounded-lg bg-bg-tertiary" aria-busy="true" />}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Account ID</span>
          <input className={inputCls} placeholder="1234567 or 1234567_SB1" value={ns.account_id} onChange={(e) => setNs({ ...ns, account_id: e.target.value })} autoComplete="off" /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Client ID</span>
          <input className={inputCls} value={ns.client_id} onChange={(e) => setNs({ ...ns, client_id: e.target.value })} autoComplete="off" /></label>
        <label className="flex flex-col gap-1.5 text-sm"><span className="font-medium text-text-primary">Certificate ID</span>
          <input className={inputCls} value={ns.certificate_id} onChange={(e) => setNs({ ...ns, certificate_id: e.target.value })} autoComplete="off" /></label>
      </div>
      <button type="button" onClick={() => void m2m()} disabled={busy || !ready} className={btnPrimary}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} {busy ? 'Checking with NetSuite…' : 'Connect NetSuite'}
      </button>
    </div>
  );
}

// ============================================================
// MAPPING
// ============================================================

function MappingPanel({ conn, onSaved }: { conn: AcctConnection; onSaved: () => void }) {
  const { toast } = useToast();
  const provider = conn.provider;
  const meta = PROVIDER_META[provider];
  const saved = useMemo(() => readSettings(provider, conn.settings), [provider, conn.settings]);
  const [draft, setDraft] = useState<AcctSettings>(saved);
  const [auto, setAuto] = useState(conn.auto_sync);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<AcctOptions | null>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const [open, setOpen] = useState<AcctEntity | null>(null);

  useEffect(() => setDraft(saved), [saved]);
  useEffect(() => setAuto(conn.auto_sync), [conn.auto_sync]);
  useEffect(() => {
    let cancelled = false;
    loadOptions(conn.id).then((o) => !cancelled && setOptions(o)).catch((e: Error) => !cancelled && setOptError(e.message));
    return () => {
      cancelled = true;
    };
  }, [conn.id]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || auto !== conn.auto_sync;
  const check = validateSettings(provider, draft);
  const patch = (entity: AcctEntity, p: Partial<AcctSettings['entities'][AcctEntity]>) => setDraft((d) => ({ ...d, entities: { ...d.entities, [entity]: { ...d.entities[entity], ...p } } }));
  const setDefault = (k: keyof AcctSettings['defaults'], v: string | boolean | null) => setDraft((d) => ({ ...d, defaults: { ...d.defaults, [k]: v } }));

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

  const pick = (title: string, key: 'incomeAccountId' | 'depositAccountId' | 'fallbackItemId' | 'taxCodeId' | 'subsidiaryId', rows: OptionRow[], hint: string) => (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-text-primary">{title}</span>
      <select className={selectCls} value={draft.defaults[key] ?? ''} onChange={(e) => setDefault(key, e.target.value || null)} disabled={!options}>
        <option value="">{options ? 'Not set' : 'Loading…'}</option>
        {draft.defaults[key] && !rows.some((r) => r.id === draft.defaults[key]) && <option value={draft.defaults[key] ?? ''}>{draft.defaults[key]}</option>}
        {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <span className="text-xs text-text-secondary">{hint}</span>
    </label>
  );
  const accounts = options?.accounts ?? [];

  return (
    <section className="space-y-4" aria-labelledby="acct-mapping">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="acct-mapping" className="text-lg font-semibold text-text-primary">Mapping &amp; conflict rules</h2>
        <button type="button" onClick={() => void save()} disabled={!dirty || saving || !check.ok} className={btnPrimary}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save mapping
        </button>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
        {ACCT_ENTITIES.map((entity) => {
          const es = draft.entities[entity];
          const em = ENTITY_META[entity];
          const fields = fieldsFor(provider, entity);
          return (
            <div key={entity} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-w-[9rem] items-center gap-2.5">
                  <input type="checkbox" checked={es.enabled} onChange={(e) => patch(entity, { enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent,#2563eb)]" aria-label={`Sync ${em.label}`} />
                  <span className="font-medium text-text-primary">{em.label}</span>
                </label>
                <span className="hidden text-xs text-text-secondary lg:inline">{em.vireekLabel} ↔ {meta.label}</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select className={selectCls} value={es.direction} disabled={!es.enabled} onChange={(e) => patch(entity, { direction: e.target.value as AcctDirection })} aria-label={`${em.label} direction`}>
                    {ACCT_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label(provider)}</option>)}
                  </select>
                  <select className={selectCls} value={es.conflict} disabled={!es.enabled} onChange={(e) => patch(entity, { conflict: e.target.value as AcctConflictRule })} aria-label={`${em.label} conflict rule`} title={CONFLICT_RULE_META[es.conflict].hint}>
                    {ACCT_CONFLICT_RULES.map((r) => <option key={r} value={r}>{CONFLICT_RULE_META[r].label(provider)}</option>)}
                  </select>
                  {fields.length > 0 && (
                    <button type="button" onClick={() => setOpen(open === entity ? null : entity)} className="text-sm font-medium text-accent hover:underline" aria-expanded={open === entity}>
                      {open === entity ? 'Hide fields' : 'Fields'}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-text-secondary">{em.hint}</p>
              {open === entity && (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {fields.map((f) => {
                    const dir = es.fields[f.key] ?? 'both';
                    const eff = effectiveDirection(es.direction, dir);
                    return (
                      <li key={f.key} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary px-3 py-2">
                        <span className="text-sm text-text-primary">{f.label}{f.required ? ' *' : ''}</span>
                        <select className={selectCls} value={dir} aria-label={`${f.label} direction`} onChange={(e) => patch(entity, { fields: { ...es.fields, [f.key]: e.target.value as AcctDirection | 'off' } })}>
                          {ACCT_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_META[d].label(provider)}</option>)}
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
        <h3 className="font-medium text-text-primary">Defaults for records Vireek creates in {meta.label}</h3>
        <p className="mb-3 mt-1 text-xs text-text-secondary">{meta.label} needs these to accept new items, invoices and payments. Nothing is sent for a record whose default is missing; it is listed in the log instead.</p>
        {optError && <p className="mb-3 text-sm text-warning-500">Could not load your {meta.label} lists: {optError}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {pick(meta.words.incomeAccount, 'incomeAccountId', accounts.filter((a) => a.classification === 'revenue'), 'Used for new items and invoice lines.')}
          {pick(meta.words.depositAccount, 'depositAccountId', accounts.filter((a) => a.classification === 'asset'), 'Required to send payments. Used when the payment’s account is not linked.')}
          {meta.needs.fallbackItem && pick(meta.words.fallbackItem, 'fallbackItemId', options?.items ?? [], 'Used when a line matches no synced item. Required to send invoices.')}
          {pick(meta.words.taxCode, 'taxCodeId', options?.taxCodes ?? [], `Applied to taxable lines. ${meta.label} may calculate its own tax; differences are reported in the log.`)}
          {meta.needs.subsidiary && (options?.subsidiaries.length ?? 0) > 0 && pick('Subsidiary', 'subsidiaryId', options?.subsidiaries ?? [], 'Required by NetSuite OneWorld for new customers, items and invoices.')}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-text-primary">Currency of your books</span>
            <input className={`${inputCls} uppercase`} maxLength={3} value={draft.defaults.currency} onChange={(e) => setDefault('currency', e.target.value.toUpperCase())} aria-invalid={!/^[A-Z]{3}$/.test(draft.defaults.currency)} />
            <span className="text-xs text-text-secondary">Documents in any other currency are skipped, never converted.</span>
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={draft.defaults.sendDocNumber} onChange={(e) => setDefault('sendDocNumber', e.target.checked)} className="h-4 w-4" />
          Send the Vireek invoice number to {meta.label}
        </label>
        <label className="mt-2 flex items-center gap-2.5 text-sm text-text-primary">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4" />
          Sync automatically every 15 minutes{meta.label === 'Xero' ? ' (and when Xero reports a change)' : ''}
        </label>
      </div>
    </section>
  );
}

// ============================================================
// CONFLICTS
// ============================================================

function ConflictsPanel({ conn, refreshKey, onChanged }: { conn: AcctConnection; refreshKey: number; onChanged: () => void }) {
  const { toast } = useToast();
  const label = PROVIDER_META[conn.provider].label;
  const [rows, setRows] = useState<AcctConflict[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConflicts(conn.id).then((r) => !cancelled && setRows(r)).catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [conn.id, refreshKey]);

  const resolve = async (c: AcctConflict, winner: 'vireek' | 'ext') => {
    setBusy(c.link_id + winner);
    try {
      await resolveConflict(c.link_id, winner);
      toast(winner === 'vireek' ? 'Kept the Vireek value.' : `Kept the ${label} value.`, 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not resolve the conflict.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!rows || rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="acct-conflicts">
      <h2 id="acct-conflicts" className="flex items-center gap-2 text-lg font-semibold text-text-primary">
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
                    <dt className="text-text-secondary">{fieldLabel(conn.provider, c.entity, f.field)}</dt>
                    <dd className="truncate text-text-primary" title={fmt(f.vireek)}>Vireek: {fmt(f.vireek)}</dd>
                    <dd className="truncate text-text-primary" title={fmt(f.ext)}>{label}: {fmt(f.ext)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={!!busy} onClick={() => void resolve(c, 'vireek')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'vireek' ? 'Applying…' : 'Keep Vireek'}
              </button>
              <button type="button" disabled={!!busy} onClick={() => void resolve(c, 'ext')} className="rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50">
                {busy === c.link_id + 'ext' ? 'Applying…' : `Keep ${label}`}
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

function LogPanel({ conn, refreshKey }: { conn: AcctConnection; refreshKey: number }) {
  const [action, setAction] = useState<LogAction | 'all'>('all');
  const [entity, setEntity] = useState<AcctEntity | 'all'>('all');
  const [rows, setRows] = useState<AcctLogRow[]>([]);
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
    <section className="space-y-3" aria-labelledby="acct-log">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="acct-log" className="mr-auto text-lg font-semibold text-text-primary">Sync log</h2>
        <select className={selectCls} value={entity} onChange={(e) => setEntity(e.target.value as AcctEntity | 'all')} aria-label="Filter by record type">
          <option value="all">All records</option>
          {ACCT_ENTITIES.map((e) => <option key={e} value={e}>{ENTITY_META[e].label}</option>)}
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
                  {r.request_ref && <p className="mt-0.5 text-xs text-text-secondary">Support reference: {r.request_ref}</p>}
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

export function AccountingSyncPage() {
  const { provider: slug } = useParams<{ provider: string }>();
  const provider = providerFromSlug(slug);
  if (!provider) {
    return (
      <DashboardLayout activeLabel="Accounting">
        <EmptyState icon={AlertTriangle} title="Unknown accounting system" description="Choose Xero, Zoho Books or NetSuite from the Integrations page." />
      </DashboardLayout>
    );
  }
  return <ProviderSync key={provider} provider={provider} />;
}

function ProviderSync({ provider }: { provider: AcctProvider }) {
  const { toast } = useToast();
  const meta = PROVIDER_META[provider];
  const canManage = useCanManageAccounting();
  const ownerId = useAcctOwnerId();
  const [params, setParams] = useSearchParams();
  const [conn, setConn] = useState<AcctConnection | null>(null);
  const [runs, setRuns] = useState<AcctRun[]>([]);
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
        const c = await getConnection(ownerId, provider);
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
    [ownerId, provider],
  );
  useEffect(() => {
    if (canManage) void loadAll();
    else setLoading(false);
  }, [canManage, loadAll]);

  // Result of the OAuth round trip.
  useEffect(() => {
    const q = params.get('acct');
    if (!q) return;
    if (q === 'connected') toast(`${meta.label} connected. Review the mapping, then run your first sync.`, 'success');
    else toast(OAUTH_REASONS[params.get('reason') ?? ''] ?? `Could not connect ${meta.label}. Please try again.`, 'error');
    params.delete('acct');
    params.delete('reason');
    setParams(params, { replace: true });
  }, [params, setParams, toast, meta.label]);

  const live = useRealtimeSubscription<AcctRun>({
    channelName: `acct-runs-${provider}-${ownerId ?? 'anon'}`,
    table: 'acct_sync_runs',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    enabled: canManage && !!ownerId,
    onChange: () => void loadAll(true),
  });

  const running = runs[0]?.status === 'running';
  const connected = !!conn && conn.status !== 'disconnected';
  const needsReconnect = conn?.status === 'error';
  const daysLeft = refreshDaysLeft(conn?.refresh_token_expires_at);

  const reconnect = async () => {
    setBusy('connect');
    try {
      window.location.assign(await startOAuth(provider, conn?.region ?? undefined));
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not connect ${meta.label}.`, 'error');
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
      await disconnectAccounting(conn.id);
      toast(`${meta.label} disconnected.`, 'success');
      void loadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not disconnect.', 'error');
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Accounting">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Accounting sync moves financial records, so it is limited to people who can edit the business profile and view billing. Ask your account owner for access.</p>
        </div>
      </DashboardLayout>
    );
  }

  const stats = runs[0]?.stats ?? {};
  return (
    <DashboardLayout activeLabel="Accounting">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><Calculator size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-text-primary sm:text-2xl">{meta.label}</h1>
              <LiveIndicator status={live} />
            </div>
            <p className="text-sm text-text-secondary">{meta.tagline}</p>
          </div>
          <Link to="/dashboard/integrations" className="text-sm font-medium text-accent hover:underline">All integrations</Link>
        </div>

        {loading ? (
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" aria-busy="true" aria-label={`Loading ${meta.label} connection`} />
        ) : failed ? (
          <EmptyState icon={AlertTriangle} title={`Couldn't load your ${meta.label} connection`} description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void loadAll() }} />
        ) : !connected ? (
          <ConnectPanel provider={provider} onConnected={() => void loadAll()} />
        ) : (
          <>
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-base font-semibold text-text-primary">{conn.company_name ?? `Organisation ${conn.tenant_id}`}</p>
                    {needsReconnect ? <Badge cls="bg-error-500/10 text-error-500"><AlertTriangle size={12} /> Needs reconnect</Badge> : running ? <Badge cls="bg-accent/10 text-accent"><Loader2 size={12} className="animate-spin" /> Syncing</Badge> : <Badge cls="bg-success-500/10 text-success-500"><CheckCircle2 size={12} /> Connected</Badge>}
                    {/_SB\d*$|_RP$/i.test(conn.tenant_id) && <Badge cls="bg-warning-500/10 text-warning-500">Sandbox</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">Last synced {timeAgo(conn.last_synced_at)}{conn.last_error ? ` · ${conn.last_error}` : ''}</p>
                  {daysLeft !== null && daysLeft <= 14 && !needsReconnect && <p className="mt-1 text-sm text-warning-500">{meta.label} access expires in {Math.max(daysLeft, 0)} days unless a sync runs. Run a sync to renew it.</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {needsReconnect && provider !== 'netsuite' ? (
                    <button type="button" onClick={() => void reconnect()} disabled={busy === 'connect'} className={btnPrimary}><Link2 size={16} /> Reconnect</button>
                  ) : needsReconnect ? (
                    <button type="button" onClick={() => setConfirmDisconnect(true)} className={btnPrimary}><Unplug size={16} /> Disconnect to reconnect</button>
                  ) : (
                    <button type="button" onClick={() => void sync(false)} disabled={!!busy || running} className={btnPrimary}>
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
                  <span>{stats.created_ext ?? 0} created in {meta.label}</span>
                  <span>{(stats.updated_vireek ?? 0) + (stats.updated_ext ?? 0)} updated</span>
                  <span>{stats.conflicts ?? 0} conflicts</span>
                  <span className={(stats.errors ?? 0) > 0 ? 'text-error-500' : ''}>{stats.errors ?? 0} errors</span>
                </div>
              )}
            </div>

            <ConflictsPanel conn={conn} refreshKey={tick} onChanged={() => void loadAll(true)} />
            <MappingPanel conn={conn} onSaved={() => void loadAll(true)} />
            <LogPanel conn={conn} refreshKey={tick} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        title={`Disconnect ${meta.label}?`}
        description={`Syncing stops and the stored credentials are deleted. Records already synced stay in both systems untouched. Reconnecting later re-matches records by email, name, account number or invoice number.`}
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
