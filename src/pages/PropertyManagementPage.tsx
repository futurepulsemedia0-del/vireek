import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Clock, Link2, Loader2, Lock, Plug, RefreshCw, RotateCcw, Save, ShieldAlert, Unplug, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList, SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  APPROVALS,
  INVOICE_CONSTANTS,
  LOG_PAGE_SIZE,
  PM_PROVIDERS,
  PROVIDER_META,
  WO_MAPPING_KEYS,
  WO_MAPPING_LABELS,
  WO_STATUSES,
  DEFAULT_ENDPOINTS,
  cancelQueueItem,
  capabilityList,
  connectPm,
  disconnectPm,
  listConnections,
  listCustomers,
  listLog,
  listQueue,
  listRuns,
  listTenants,
  listUnits,
  previewSample,
  readSettings,
  retryQueueItem,
  saveSettings,
  syncNow,
  timeAgo,
  useCanManagePm,
  usePmOwnerId,
  type LogAction,
  type PmConnection,
  type PmLogRow,
  type PmPreviewSample,
  type PmProvider,
  type PmQueueRow,
  type PmRun,
  type PmSettings,
  type PmTenant,
  type PmUnit,
  type QueueStatus,
  type RunStatus,
} from '@/lib/pmIntegrations';

type Tab = 'overview' | 'settings' | 'queue' | 'log' | 'contacts';

const SELECT =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60';

const RUN_STYLE: Record<RunStatus, { label: string; cls: string }> = {
  running: { label: 'Syncing', cls: 'bg-accent/10 text-accent' },
  success: { label: 'Up to date', cls: 'bg-success-500/10 text-success-500' },
  partial: { label: 'Partially synced', cls: 'bg-warning-500/10 text-warning-500' },
  failed: { label: 'Failed', cls: 'bg-danger/10 text-danger' },
};
const ACTION_STYLE: Record<LogAction, string> = {
  created: 'bg-success-500/10 text-success-500',
  updated: 'bg-accent/10 text-accent',
  linked: 'bg-bg-tertiary text-text-secondary',
  pushed: 'bg-success-500/10 text-success-500',
  dry_run: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  conflict: 'bg-warning-500/10 text-warning-500',
  retry: 'bg-warning-500/10 text-warning-500',
  error: 'bg-danger/10 text-danger',
};
const QUEUE_STYLE: Record<QueueStatus, string> = {
  pending: 'bg-accent/10 text-accent',
  processing: 'bg-accent/10 text-accent',
  done: 'bg-success-500/10 text-success-500',
  failed: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};
const ACCESS_LABEL = { self_serve: 'Self-serve API key', plan_required: 'Plan required', partner_gated: 'Partner access required' } as const;

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// ------------------------------------------------------------------------------------------
// Connect form
// ------------------------------------------------------------------------------------------

function ConnectForm({ provider, customers, onDone, onCancel }: {
  provider: PmProvider;
  customers: { id: string; name: string }[];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const meta = PROVIDER_META[provider];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(meta.credentials.filter((f) => f.kind === 'select').map((f) => [f.key, f.options?.[0] ?? ''])));
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await connectPm(provider, values, customerId || null);
      if (r.warning) toast(r.warning, 'info');
      else toast(`${meta.label} connected.`, 'success');
      onDone(r.connection_id);
    } catch (e) {
      setError(errMsg(e, 'Could not connect.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-5 !p-5 hover:!translate-y-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Connect {meta.label}</h3>
          <p className="mt-1 text-sm text-text-secondary">{meta.requirement}</p>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
        {meta.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <p className="text-xs text-text-secondary">
        Official documentation: <a className="text-accent underline" href={meta.docsUrl} target="_blank" rel="noopener noreferrer">{meta.docsUrl.replace('https://', '')}</a>
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {meta.credentials.map((f) =>
          f.kind === 'select' ? (
            <div key={f.key}>
              <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor={`cred-${f.key}`}>{f.label}</label>
              <select id={`cred-${f.key}`} className={SELECT} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              {f.help && <p className="mt-1 text-xs text-text-secondary">{f.help}</p>}
            </div>
          ) : (
            <Input
              key={f.key}
              label={f.label}
              type={f.kind === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={f.placeholder}
              helperText={f.help}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          ),
        )}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="pm-customer">Property manager as a Vireek customer</label>
          <select id="pm-customer" className={SELECT} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">None (leave customer empty)</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-text-secondary">Synced work orders are billed to this customer.</p>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex gap-3">
        <Button onClick={() => void submit()} disabled={busy} size="sm">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />} Verify and connect
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="text-xs text-text-secondary">Credentials are encrypted before they are stored and are never shown again.</p>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------
// Settings tab
// ------------------------------------------------------------------------------------------

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1 h-4 w-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium text-text-primary">{label}</span>{hint && <span className="block text-text-secondary">{hint}</span>}</span>
    </label>
  );
}

function SettingsTab({ conn, customers, onSaved }: { conn: PmConnection; customers: { id: string; name: string }[]; onSaved: () => void }) {
  const { toast } = useToast();
  const [s, setS] = useState<PmSettings>(() => readSettings(conn.provider, conn.settings));
  const [customerId, setCustomerId] = useState(conn.customer_id ?? '');
  const [autoSync, setAutoSync] = useState(conn.auto_sync);
  const [endpointsJson, setEndpointsJson] = useState(() => JSON.stringify(readSettings(conn.provider, conn.settings).endpoints, null, 2));
  const [busy, setBusy] = useState(false);
  const [samples, setSamples] = useState<PmPreviewSample[] | null>(null);
  const [sampling, setSampling] = useState(false);
  const meta = PROVIDER_META[conn.provider];
  const set = (patch: Partial<PmSettings>) => setS((p) => ({ ...p, ...patch }));

  const save = async () => {
    let endpoints = s.endpoints;
    try {
      const parsed = JSON.parse(endpointsJson || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      endpoints = parsed;
    } catch {
      toast('Advanced endpoints must be a valid JSON object.', 'error');
      return;
    }
    setBusy(true);
    try {
      await saveSettings(conn.id, { ...s, endpoints }, { autoSync, customerId: customerId || null });
      toast('Settings saved. Changed mappings are re-read on the next sync.', 'success');
      onSaved();
    } catch (e) {
      toast(errMsg(e, 'Could not save the settings.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fetchSample = async () => {
    setSampling(true);
    try {
      setSamples((await previewSample(conn.id, 'workOrders')).samples);
    } catch (e) {
      toast(errMsg(e, 'Could not fetch a sample.'), 'error');
    } finally {
      setSampling(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="space-y-4 !p-5 hover:!translate-y-0">
        <h3 className="text-base font-semibold text-text-primary">What to sync</h3>
        <Check checked={s.pull.workOrders} onChange={(v) => set({ pull: { ...s.pull, workOrders: v } })} label="Work orders" hint="Created in Vireek's Work Orders, so approvals, NTE caps and billing rules still apply." />
        <Check checked={s.pull.units} onChange={(v) => set({ pull: { ...s.pull, units: v } })} label="Units" />
        <Check checked={s.pull.tenants} onChange={(v) => set({ pull: { ...s.pull, tenants: v } })} label="Tenant contacts" hint="Personal data. Used to fill the site contact on a work order. Deleted when you disconnect." />
        <Check checked={s.createWorkOrders} onChange={(v) => set({ createWorkOrders: v })} label="Create new Vireek work orders for unseen provider work orders" />
        <Check checked={s.usePmNumberAsPo} onChange={(v) => set({ usePmNumberAsPo: v })} label="Use the provider's work order number as the PO number when none is given" hint="Also used to match an existing Vireek work order instead of creating a duplicate." />
        <Check checked={autoSync} onChange={setAutoSync} label="Sync automatically every few minutes" />
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="s-approval">When the provider has no approval</label>
            <select id="s-approval" className={SELECT} value={s.defaultApproval} onChange={(e) => set({ defaultApproval: e.target.value as PmSettings['defaultApproval'] })}>
              {APPROVALS.map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
            </select>
            <p className="mt-1 text-xs text-text-secondary">“pending” means someone approves in Vireek before work starts.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="s-customer">Customer</label>
            <select id="s-customer" className={SELECT} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">None</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <Input label="First import covers (days)" type="number" min={1} max={365} value={s.backfillDays} onChange={(e) => set({ backfillDays: Number(e.target.value) || 30 })} />
        </div>
      </Card>

      <Card className="space-y-4 !p-5 hover:!translate-y-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-text-primary">Field mapping (work orders)</h3>
          <Button variant="secondary" size="sm" onClick={() => void fetchSample()} disabled={sampling}>
            {sampling ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Fetch sample
          </Button>
        </div>
        <p className="text-sm text-text-secondary">
          Each field is the name in {meta.label}'s JSON. Use <code>A|B</code> for “first one found” and <code>A+B</code> to join (for example first + last name). Names are case-insensitive. Use “Fetch sample” to see real records and what they map to.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {WO_MAPPING_KEYS.map((k) => (
            <Input key={k} label={WO_MAPPING_LABELS[k]} value={s.mapping.workOrder[k]} spellCheck={false} onChange={(e) => set({ mapping: { ...s.mapping, workOrder: { ...s.mapping.workOrder, [k]: e.target.value } } })} />
          ))}
        </div>
        {samples && (
          <div className="space-y-3">
            {samples.length === 0 && <EmptyState icon={Clock} title="The provider returned no records" description="Check access, or widen the first-import window." />}
            {samples.map((x, i) => (
              <div key={i} className="grid gap-3 rounded-xl border border-border bg-bg-primary p-3 lg:grid-cols-2">
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-text-secondary">{x.raw}</pre>
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                  {WO_MAPPING_KEYS.map((k) => (
                    <div key={k} className="contents"><dt className="text-text-secondary">{WO_MAPPING_LABELS[k]}</dt><dd className={x.canonical[k] ? 'text-text-primary' : 'text-warning-500'}>{x.canonical[k] ?? 'not found'}</dd></div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="space-y-4 !p-5 hover:!translate-y-0">
        <h3 className="text-base font-semibold text-text-primary">Status mapping</h3>
        <p className="text-sm text-text-secondary">Words {meta.label} uses for each Vireek status, sent when we update a work order. Incoming statuses are matched by name; add extra names below.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {WO_STATUSES.map((st) => (
            <Input key={st} label={`Send for “${st.replace('_', ' ')}”`} value={s.statusOut[st]} onChange={(e) => set({ statusOut: { ...s.statusOut, [st]: e.target.value } })} />
          ))}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="s-extra">Extra incoming statuses (one “name = status” per line)</label>
          <textarea
            id="s-extra"
            rows={3}
            spellCheck={false}
            className={SELECT}
            placeholder={'on site visit = in_progress\nwaiting on parts = draft'}
            value={Object.entries(s.statusIn).map(([k, v]) => `${k} = ${v}`).join('\n')}
            onChange={(e) => {
              const next: PmSettings['statusIn'] = {};
              for (const line of e.target.value.split('\n')) {
                const [k, v] = line.split('=').map((x) => x.trim());
                if (k && (WO_STATUSES as string[]).includes(v)) next[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = v as PmSettings['unknownStatus'];
              }
              set({ statusIn: next });
            }}
          />
          <p className="mt-1 text-xs text-text-secondary">Allowed statuses: {WO_STATUSES.join(', ')}.</p>
        </div>
      </Card>

      <Card className="space-y-4 !p-5 hover:!translate-y-0">
        <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><ShieldAlert size={18} /> Writing back to {meta.label}</h3>
        <p className="text-sm text-text-secondary">Off by default. Turn on a dry run first: Vireek logs the exact request it would send and sends nothing. Only switch dry run off after the log looks right in the provider's sandbox.</p>
        <Check checked={s.push.status} onChange={(v) => set({ push: { ...s.push, status: v } })} label="Send status updates" hint={DEFAULT_ENDPOINTS[conn.provider].pushStatus ? undefined : 'Needs an endpoint under Advanced for this provider.'} />
        <Check checked={s.push.invoices} onChange={(v) => set({ push: { ...s.push, invoices: v } })} label="Send invoices when a visit is marked invoiced" hint={DEFAULT_ENDPOINTS[conn.provider].pushInvoice ? undefined : 'Needs an endpoint under Advanced for this provider.'} />
        <Check checked={s.push.dryRun} onChange={(v) => set({ push: { ...s.push, dryRun: v } })} label="Dry run (log only, send nothing)" />
        {INVOICE_CONSTANTS.filter((c) => c.providers.includes(conn.provider)).length > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            {INVOICE_CONSTANTS.filter((c) => c.providers.includes(conn.provider)).map((c) => (
              <Input key={c.key} label={c.label} inputMode={c.numeric ? 'numeric' : undefined} placeholder={c.placeholder} value={s.invoice.constants[c.key] ?? ''} onChange={(e) => set({ invoice: { ...s.invoice, constants: { ...s.invoice.constants, [c.key]: e.target.value } } })} />
            ))}
            <Input label="Invoice due in (days)" type="number" min={0} max={180} value={s.invoice.dueDays} onChange={(e) => set({ invoice: { ...s.invoice, dueDays: Number(e.target.value) || 0 } })} />
          </div>
        )}
      </Card>

      <Card className="space-y-3 !p-5 hover:!translate-y-0">
        <h3 className="text-base font-semibold text-text-primary">Advanced: endpoints</h3>
        <p className="text-sm text-text-secondary">
          Overrides for the API calls, from the provider's partner documentation. Keys: workOrders, units, tenants, pushStatus, pushInvoice. Each is {'{'} method, path, query?, body?, itemsPath?, paging? {'}'}. Paths are relative to the provider's API and may contain {'{id}'}. Leave <code>{'{}'}</code> to use the defaults.
        </p>
        <textarea aria-label="Endpoint overrides (JSON)" rows={8} spellCheck={false} className={`${SELECT} font-mono text-xs`} value={endpointsJson} onChange={(e) => setEndpointsJson(e.target.value)} />
      </Card>

      <Button onClick={() => void save()} disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save settings</Button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Queue / Log / Contacts tabs
// ------------------------------------------------------------------------------------------

function QueueTab({ conn, refreshKey }: { conn: PmConnection; refreshKey: number }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PmQueueRow[] | null>(null);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await listQueue(conn.id));
      setError(false);
    } catch {
      setError(true);
    }
  }, [conn.id]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = async (id: string, fn: (id: string) => Promise<unknown>, done: string) => {
    setBusyId(id);
    try {
      await fn(id);
      toast(done, 'success');
      await load();
    } catch (e) {
      toast(errMsg(e, 'Action failed.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (error) return <EmptyState icon={AlertTriangle} title="Couldn't load the retry queue" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />;
  if (!rows) return <SkeletonTable rows={4} columns={4} />;
  if (rows.length === 0) return <EmptyState icon={CheckCircle2} title="Nothing waiting to be sent" description="Status updates and invoices you send to the property manager appear here. Failed items retry automatically with increasing delays." />;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex shrink-0 items-center gap-2 sm:w-56">
            <Badge cls={QUEUE_STYLE[r.status]}>{r.status}</Badge>
            <span className="text-sm font-medium text-text-primary">{r.kind === 'push_status' ? 'Status update' : 'Invoice'}</span>
          </div>
          <div className="min-w-0 flex-1 text-sm text-text-secondary">
            <p>Attempt {r.attempts} of {r.max_attempts}{r.status === 'pending' && ` · next try ${new Date(r.next_attempt_at).toLocaleString()}`}</p>
            {r.last_error && <p className="mt-0.5 break-words text-danger">{r.last_error}</p>}
          </div>
          <div className="flex gap-2">
            {r.status === 'failed' && <Button variant="secondary" size="sm" disabled={busyId === r.id} onClick={() => void act(r.id, retryQueueItem, 'Queued for retry.')}><RotateCcw size={14} /> Retry</Button>}
            {(r.status === 'failed' || r.status === 'pending') && <Button variant="ghost" size="sm" disabled={busyId === r.id} onClick={() => void act(r.id, cancelQueueItem, 'Cancelled.')}>Cancel</Button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function LogTab({ conn, refreshKey }: { conn: PmConnection; refreshKey: number }) {
  const [rows, setRows] = useState<PmLogRow[] | null>(null);
  const [error, setError] = useState(false);
  const [action, setAction] = useState<LogAction | 'all'>('all');
  const [more, setMore] = useState(false);
  const load = useCallback(async (append = false, before: string | null = null) => {
    try {
      const page = await listLog(conn.id, { action, before });
      setRows((prev) => (append && prev ? [...prev, ...page] : page));
      setMore(page.length === LOG_PAGE_SIZE);
      setError(false);
    } catch {
      setError(true);
    }
  }, [conn.id, action]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <div className="space-y-4">
      <div>
        <label className="sr-only" htmlFor="log-filter">Filter</label>
        <select id="log-filter" className={`${SELECT} sm:w-56`} value={action} onChange={(e) => { setRows(null); setAction(e.target.value as LogAction | 'all'); }}>
          <option value="all">All events</option>
          {(Object.keys(ACTION_STYLE) as LogAction[]).map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
        </select>
      </div>
      {error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load the sync log" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
      ) : !rows ? (
        <SkeletonTable rows={6} columns={3} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Clock} title="Nothing in the log yet" description="Created, updated, sent, dry-run and failed events show up here after a sync. Entries are kept for 30 days." />
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-1.5 p-3.5 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-44">
                  <Badge cls={ACTION_STYLE[r.action]}>{r.action.replace('_', ' ')}</Badge>
                  <span className="text-xs text-text-secondary">{r.entity}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-text-primary">{r.message}</p>
                  {r.action === 'dry_run' && r.details ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-primary p-2 text-xs text-text-secondary">{JSON.stringify(r.details, null, 2)}</pre> : null}
                </div>
                <span className="shrink-0 text-xs text-text-secondary">{timeAgo(r.created_at)}</span>
              </li>
            ))}
          </ul>
          {more && <Button variant="secondary" size="sm" onClick={() => void load(true, rows[rows.length - 1]?.created_at ?? null)}>Load older</Button>}
        </>
      )}
    </div>
  );
}

function ContactsTab({ conn }: { conn: PmConnection }) {
  const [search, setSearch] = useState('');
  const [units, setUnits] = useState<PmUnit[] | null>(null);
  const [tenants, setTenants] = useState<PmTenant[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.all([listUnits(conn.id, search), listTenants(conn.id, search)])
        .then(([u, n]) => { if (!cancelled) { setUnits(u); setTenants(n); setError(false); } })
        .catch(() => { if (!cancelled) setError(true); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [conn.id, search]);

  if (error) return <EmptyState icon={AlertTriangle} title="Couldn't load units and tenants" description="Check your connection and try again." />;
  return (
    <div className="space-y-4">
      <Input label="Search" placeholder="Property, unit, tenant, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      {!units || !tenants ? (
        <SkeletonTable rows={5} columns={3} />
      ) : units.length === 0 && tenants.length === 0 ? (
        <EmptyState icon={Building2} title="No units or tenants synced yet" description="They appear after the first sync, when units and tenant contacts are switched on in Settings." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            <h4 className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">Units ({units.length})</h4>
            <ul className="divide-y divide-border">
              {units.map((u) => <li key={u.id} className="px-4 py-2.5 text-sm"><span className="font-medium text-text-primary">{u.property_name ?? 'Property'}{u.unit_number ? ` · Unit ${u.unit_number}` : ''}</span><span className="block text-text-secondary">{[u.address, u.city, u.state].filter(Boolean).join(', ')}</span></li>)}
            </ul>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
            <h4 className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">Tenant contacts ({tenants.length})</h4>
            <ul className="divide-y divide-border">
              {tenants.map((t) => <li key={t.id} className="px-4 py-2.5 text-sm"><span className="font-medium text-text-primary">{t.name ?? 'Unnamed'}</span><span className="block break-all text-text-secondary">{[t.phone, t.email].filter(Boolean).join(' · ')}</span></li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------

export function PropertyManagementPage() {
  const { toast } = useToast();
  const canManage = useCanManagePm();
  const ownerId = usePmOwnerId();
  const [conns, setConns] = useState<PmConnection[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [runs, setRuns] = useState<PmRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [connecting, setConnecting] = useState<PmProvider | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<PmConnection | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tick, setTick] = useState(0);

  const loadConns = useCallback(async (quiet = false) => {
    if (!ownerId) return;
    if (!quiet) setLoading(true);
    try {
      const list = await listConnections(ownerId);
      setConns(list);
      setLoadError(false);
      setSelectedId((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list.find((c) => c.status !== 'disconnected') ?? list[0])?.id ?? null));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => { if (canManage) void loadConns(); }, [canManage, loadConns]);
  useEffect(() => { if (canManage && ownerId) listCustomers(ownerId).then(setCustomers).catch(() => setCustomers([])); }, [canManage, ownerId]);

  const selected = conns.find((c) => c.id === selectedId) ?? null;
  const loadRuns = useCallback(async () => {
    if (selected) listRuns(selected.id).then(setRuns).catch(() => setRuns([]));
  }, [selected]);
  useEffect(() => { void loadRuns(); }, [loadRuns, tick]);

  const liveStatus = useRealtimeSubscription<PmRun>({
    channelName: `pm-runs-${ownerId ?? 'anon'}`,
    table: 'pm_sync_runs',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    enabled: canManage && !!ownerId,
    onChange: () => { void loadConns(true); setTick((t) => t + 1); },
  });

  // Poll while a run is active, in case the socket drops.
  const running = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void loadConns(true); setTick((x) => x + 1); }, 4000);
    return () => clearInterval(t);
  }, [running, loadConns]);

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Property Management">
        <EmptyState icon={Lock} title="Permission required" description="Ask the account owner for the “edit business profile” permission to manage property-management integrations." />
      </DashboardLayout>
    );
  }

  const doSync = async () => {
    if (!selected) return;
    setSyncing(true);
    try {
      await syncNow(selected.id);
      toast('Sync started.', 'success');
      setTick((t) => t + 1);
    } catch (e) {
      toast(errMsg(e, 'Could not start the sync.'), 'error');
    } finally {
      setSyncing(false);
    }
  };
  const doDisconnect = async () => {
    if (!confirmDisconnect) return;
    try {
      await disconnectPm(confirmDisconnect.id);
      toast(`${PROVIDER_META[confirmDisconnect.provider].label} disconnected.`, 'success');
      setConfirmDisconnect(null);
      await loadConns(true);
    } catch (e) {
      toast(errMsg(e, 'Could not disconnect.'), 'error');
    }
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'settings', label: 'Settings' },
    { id: 'queue', label: 'Retry queue' },
    { id: 'log', label: 'Sync log' },
    { id: 'contacts', label: 'Units & tenants' },
  ];
  const active = conns.filter((c) => c.status !== 'disconnected');

  return (
    <DashboardLayout activeLabel="Property Management">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><Building2 size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold text-text-primary">Property Management</h1>
              <LiveIndicator status={liveStatus} />
            </div>
            <p className="text-sm text-text-secondary">Sync work orders, units, tenant contacts, status updates, approvals and invoices with Buildium, Propertyware, Rentvine, AppFolio and Yardi.</p>
          </div>
        </div>

        {loading ? (
          <SkeletonCardList count={3} rows={2} />
        ) : loadError ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load your connections" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void loadConns() }} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PM_PROVIDERS.map((p) => {
              const meta = PROVIDER_META[p];
              const mine = conns.filter((c) => c.provider === p && c.status !== 'disconnected');
              return (
                <Card key={p} className="flex flex-col gap-3 !p-5 hover:!translate-y-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-semibold text-text-primary">{meta.label}</h3>
                      <p className="text-sm text-text-secondary">{meta.tagline}</p>
                    </div>
                    <Badge cls={meta.access === 'self_serve' ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500'}>{ACCESS_LABEL[meta.access]}</Badge>
                  </div>
                  <ul className="flex flex-wrap gap-1.5">
                    {capabilityList(p).map((c) => <li key={c.label}><Badge cls={c.on ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary line-through'}>{c.label}</Badge></li>)}
                  </ul>
                  <p className="text-xs text-text-secondary">{meta.requirement}</p>
                  {mine.map((c) => (
                    <button key={c.id} type="button" onClick={() => { setSelectedId(c.id); setTab('overview'); }} className={`focus-ring flex items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${c.id === selectedId ? 'border-accent bg-accent/5' : 'border-border'}`}>
                      <span className="min-w-0 truncate text-text-primary">{c.account_label}</span>
                      <Badge cls={c.status === 'error' ? 'bg-danger/10 text-danger' : 'bg-success-500/10 text-success-500'}>{c.status === 'error' ? 'Needs attention' : 'Connected'}</Badge>
                    </button>
                  ))}
                  <Button variant="secondary" size="sm" className="mt-auto" onClick={() => setConnecting(p)}>
                    <Link2 size={16} /> {mine.length ? 'Connect another account' : 'Connect'}
                  </Button>
                </Card>
              );
            })}
          </div>
        )}

        {connecting && (
          <ConnectForm
            provider={connecting}
            customers={customers}
            onCancel={() => setConnecting(null)}
            onDone={(id) => { setConnecting(null); setSelectedId(id); setTab('settings'); void loadConns(true); }}
          />
        )}

        {!loading && !loadError && active.length === 0 && !connecting && (
          <EmptyState icon={Plug} title="Connect a property management system" description="Pick your provider above. Writing back to it is off until you turn it on, and starts as a dry run." />
        )}

        {selected && selected.status !== 'disconnected' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-text-primary">{PROVIDER_META[selected.provider].label} · {selected.account_label}</h2>
              <Button size="sm" onClick={() => void doSync()} disabled={syncing || running}>
                {syncing || running ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Sync now
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(selected)}><Unplug size={16} /> Disconnect</Button>
            </div>
            <div role="tablist" aria-label="Connection sections" className="flex gap-1 overflow-x-auto border-b border-border">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)} className={`focus-ring whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
              ))}
            </div>

            {tab === 'overview' && (
              <div className="space-y-4">
                {selected.last_error && <p role="alert" className="rounded-xl bg-warning-500/10 px-3 py-2 text-sm text-warning-500">{selected.last_error}</p>}
                <p className="text-sm text-text-secondary">Last synced: {timeAgo(selected.last_synced_at)}</p>
                {runs.length === 0 ? (
                  <EmptyState icon={Clock} title="No syncs yet" description="Press “Sync now”. The first import covers the window set in Settings." />
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                    {runs.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-3 p-3.5 text-sm">
                        <Badge cls={RUN_STYLE[r.status].cls}>{RUN_STYLE[r.status].label}</Badge>
                        <span className="text-text-secondary">{r.trigger === 'manual' ? 'Manual' : 'Scheduled'} · {timeAgo(r.started_at)}</span>
                        <span className="text-text-secondary">
                          {r.stats.created ?? 0} new · {r.stats.updated ?? 0} updated · {r.stats.pushed ?? 0} sent · {r.stats.queued ?? 0} queued · {r.stats.failed ?? 0} failed
                        </span>
                        {r.error && <span className="w-full text-xs text-text-secondary">{r.error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {tab === 'settings' && <SettingsTab key={`${selected.id}-${selected.created_at}`} conn={selected} customers={customers} onSaved={() => void loadConns(true)} />}
            {tab === 'queue' && <QueueTab conn={selected} refreshKey={tick} />}
            {tab === 'log' && <LogTab conn={selected} refreshKey={tick} />}
            {tab === 'contacts' && <ContactsTab conn={selected} />}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDisconnect}
        title={`Disconnect ${confirmDisconnect ? PROVIDER_META[confirmDisconnect.provider].label : ''}?`}
        description="Syncing stops. The stored credentials, queued updates, units and tenant contacts are deleted. Work orders already in Vireek stay untouched, and reconnecting the same account re-links them."
        confirmLabel="Disconnect"
        onConfirm={doDisconnect}
        onCancel={() => setConfirmDisconnect(null)}
      />
    </DashboardLayout>
  );
}
