import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Plug, Plus, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import { listLocations, listSuppliers, type LocationOption, type SupplierOption } from '@/lib/partsOrderingApi';
import {
  cancelSession,
  createOrder,
  getSession,
  listConnections,
  listSessionLines,
  listSessions,
  saveConnection,
  startSession,
  testConnection,
  type CreatedOrder,
} from '@/lib/punchoutApi';
import {
  EMPTY_FORM,
  RETURN_ERRORS,
  STATUS_LABEL,
  formatMoney,
  isOpen,
  lineDelta,
  statusTone,
  summarizeReview,
  totalMismatch,
  validateConnection,
  type ConnectionForm,
  type PunchoutConnection,
  type PunchoutLine,
  type PunchoutSession,
  type Tone,
} from '@/lib/punchout';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const TONE: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};
type ToastFn = ReturnType<typeof useToast>['toast'];

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>{children}</span>;
}

export function SupplierPunchoutPage() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const sessionParam = params.get('session');
  const errorParam = params.get('error');
  const jobId = params.get('job');

  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [connections, setConnections] = useState<PunchoutConnection[]>([]);
  const [sessions, setSessions] = useState<PunchoutSession[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [editing, setEditing] = useState<{ vendorId: string } | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading');
    try {
      const [s, c, ss, loc] = await Promise.all([listSuppliers(), listConnections(), listSessions(), listLocations().catch(() => [])]);
      setSuppliers(s);
      setConnections(c);
      setSessions(ss);
      setLocations(loc);
      setState('ready');
    } catch {
      if (!quiet) setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a supplier store is open in another tab, poll so the cart shows up the moment it is transferred.
  const hasOpen = sessions.some(isOpen);
  useEffect(() => {
    if (!hasOpen) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 4000);
    return () => window.clearInterval(t);
  }, [hasOpen, load]);
  useEffect(() => {
    const onFocus = () => void load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const supplierName = useCallback((id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier', [suppliers]);
  const selectSession = (id: string | null) => {
    const next = new URLSearchParams(params);
    next.delete('error');
    if (id) next.set('session', id);
    else next.delete('session');
    setParams(next, { replace: true });
  };

  return (
    <DashboardLayout activeLabel="Supplier PunchOut">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Supplier PunchOut</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Shop your supplier’s own website (Ferguson, Grainger and other cXML PunchOut stores) at your negotiated prices, then send the cart back
            here. You review it, and Vireek turns it into a purchase order.
          </p>
        </div>

        {errorParam && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{RETURN_ERRORS[errorParam] ?? RETURN_ERRORS.failed}</span>
          </div>
        )}

        {state === 'loading' && (
          <div className={`${card} flex items-center gap-2 text-sm text-text-secondary`} role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading PunchOut…
          </div>
        )}

        {state === 'error' && (
          <div role="alert" className="rounded-xl bg-danger/10 px-3 py-3 text-sm text-danger">
            Could not load PunchOut. You may not have permission to manage purchasing.
            <Button variant="secondary" size="sm" className="ml-3" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}

        {state === 'ready' && (
          <>
            {sessionParam && (
              <CartPanel
                key={sessionParam}
                sessionId={sessionParam}
                supplierName={supplierName}
                locations={locations}
                toast={toast}
                onClose={() => selectSession(null)}
                onChanged={() => void load(true)}
              />
            )}

            {suppliers.length === 0 ? (
              <div className={card}>
                <p className="text-sm text-text-secondary">Add a supplier first (Parts &amp; Inventory → Suppliers), then connect its PunchOut store here.</p>
              </div>
            ) : (
              <ConnectionsCard
                suppliers={suppliers}
                connections={connections}
                locations={locations}
                jobId={jobId}
                editing={editing}
                setEditing={setEditing}
                toast={toast}
                onChanged={() => void load(true)}
                onStarted={(id) => selectSession(id)}
              />
            )}

            <SessionsCard sessions={sessions} supplierName={supplierName} onOpen={(id) => selectSession(id)} />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ------------------------------------------------------------------ connections

function ConnectionsCard(props: {
  suppliers: SupplierOption[];
  connections: PunchoutConnection[];
  locations: LocationOption[];
  jobId: string | null;
  editing: { vendorId: string } | null;
  setEditing: (v: { vendorId: string } | null) => void;
  toast: ToastFn;
  onChanged: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const { suppliers, connections, locations, jobId, editing, setEditing, toast, onChanged, onStarted } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [dest, setDest] = useState('');
  const [blockedUrl, setBlockedUrl] = useState<{ url: string; sessionId: string } | null>(null);
  const byVendor = useMemo(() => new Map(connections.map((c) => [c.vendor_id, c])), [connections]);
  const unconnected = suppliers.filter((s) => !byVendor.has(s.id));

  async function open(conn: PunchoutConnection) {
    setBusy(`open:${conn.id}`);
    setBlockedUrl(null);
    // Open the tab synchronously (inside the click) so popup blockers allow it; point it at the store afterwards.
    const tab = window.open('about:blank', '_blank');
    try {
      const res = await startSession({ connectionId: conn.id, jobId, destinationLocationId: dest || null });
      if (tab) tab.location.href = res.start_url;
      else setBlockedUrl({ url: res.start_url, sessionId: res.session_id });
      onChanged();
      onStarted(res.session_id);
      toast('Supplier store opened in a new tab. Send the cart back when you are done.', 'success');
    } catch (e) {
      tab?.close();
      toast(e instanceof Error ? e.message : 'Could not open the supplier store.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function test(conn: PunchoutConnection) {
    setBusy(`test:${conn.id}`);
    try {
      const r = await testConnection(conn.id);
      toast(r.message, r.ok ? 'success' : 'error');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The connection test failed.', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={card}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Supplier stores</h2>
        {unconnected.length > 0 && !editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing({ vendorId: unconnected[0].id })}>
            <Plus className="h-4 w-4" aria-hidden /> Connect a supplier
          </Button>
        )}
      </div>

      {jobId && <p className="mb-3 rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">Parts you transfer will be ordered for the job you came from.</p>}

      {locations.length > 0 && connections.length > 0 && (
        <div className="mb-3 max-w-xs">
          <label htmlFor="po-dest" className="mb-1 block text-xs font-medium text-text-secondary">Deliver to</label>
          <select id="po-dest" className={field} value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">Main warehouse (default)</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      )}

      {blockedUrl && (
        <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          Your browser blocked the new tab.{' '}
          <a className="font-semibold underline" href={blockedUrl.url} target="_blank" rel="noopener noreferrer">Open the supplier store</a>
        </p>
      )}

      {connections.length === 0 && !editing && (
        <div className="rounded-xl border border-dashed border-border p-5 text-center">
          <Plug className="mx-auto mb-2 h-6 w-6 text-text-secondary" aria-hidden />
          <p className="text-sm font-medium text-text-primary">No PunchOut connections yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-text-secondary">
            Ask your supplier rep to enable cXML PunchOut for your account. They will give you a PunchOut URL, identities and a shared secret.
          </p>
          <Button className="mt-3" size="sm" onClick={() => setEditing({ vendorId: suppliers[0].id })}>
            <Plus className="h-4 w-4" aria-hidden /> Connect a supplier
          </Button>
        </div>
      )}

      <ul className="space-y-3">
        {connections.map((c) => {
          const name = suppliers.find((s) => s.id === c.vendor_id)?.name ?? 'Supplier';
          const isEdit = editing?.vendorId === c.vendor_id;
          return (
            <li key={c.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
                    <Pill tone={c.environment === 'production' ? 'success' : 'warning'}>{c.environment === 'production' ? 'Live' : 'Test'}</Pill>
                    {!c.enabled && <Pill tone="neutral">Off</Pill>}
                    {c.last_test_ok === true && <Pill tone="success">Tested OK</Pill>}
                    {c.last_test_ok === false && <Pill tone="danger">Test failed</Pill>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!c.enabled || busy !== null} onClick={() => void open(c)}>
                    {busy === `open:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />}
                    Open store
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void test(c)}>
                    {busy === `test:${c.id}` && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(isEdit ? null : { vendorId: c.vendor_id })}>
                    {isEdit ? 'Close' : 'Edit'}
                  </Button>
                </div>
              </div>
              {c.last_test_ok === false && c.last_test_message && <p role="alert" className="mt-2 text-xs text-danger">{c.last_test_message}</p>}
              {isEdit && <ConnectionForm key={c.id} suppliers={suppliers} existing={c} vendorId={c.vendor_id} toast={toast} onDone={() => { setEditing(null); onChanged(); }} />}
            </li>
          );
        })}
      </ul>

      {editing && !byVendor.has(editing.vendorId) && (
        <div className="mt-3 rounded-xl border border-border p-3">
          <ConnectionForm
            suppliers={unconnected}
            existing={null}
            vendorId={editing.vendorId}
            toast={toast}
            onCancel={() => setEditing(null)}
            onDone={() => { setEditing(null); onChanged(); }}
          />
        </div>
      )}
      <span className="sr-only" aria-live="polite">{busy ? 'Working…' : ''}</span>
    </div>
  );
}

function ConnectionForm(props: {
  suppliers: SupplierOption[];
  existing: PunchoutConnection | null;
  vendorId: string;
  toast: ToastFn;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { suppliers, existing, toast, onDone, onCancel } = props;
  const [form, setForm] = useState<ConnectionForm>(() =>
    existing
      ? { ...EMPTY_FORM, ...existing, shared_secret: '' }
      : { ...EMPTY_FORM, vendor_id: props.vendorId },
  );
  const [errors, setErrors] = useState<Partial<Record<keyof ConnectionForm, string>>>({});
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const err = (k: keyof ConnectionForm) => (errors[k] ? <p role="alert" className="mt-1 text-xs text-danger">{errors[k]}</p> : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = validateConnection(form, existing !== null);
    setErrors(v);
    if (Object.keys(v).length) return;
    setSaving(true);
    try {
      await saveConnection(form);
      toast('PunchOut connection saved. Use Test to check it.', 'success');
      onDone();
    } catch (e2) {
      toast(e2 instanceof Error ? e2.message : 'Could not save the connection.', 'error');
    } finally {
      setSaving(false);
    }
  }

  const id = (k: string) => `pc-${existing?.id ?? 'new'}-${k}`;
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2" noValidate>
      {!existing && (
        <div className="sm:col-span-2">
          <label htmlFor={id('vendor')} className="mb-1 block text-xs font-medium text-text-secondary">Supplier</label>
          <select id={id('vendor')} className={field} value={form.vendor_id} onChange={(e) => set('vendor_id', e.target.value)}>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {err('vendor_id')}
        </div>
      )}
      <div className="sm:col-span-2">
        <label htmlFor={id('url')} className="mb-1 block text-xs font-medium text-text-secondary">PunchOut URL</label>
        <input id={id('url')} className={field} inputMode="url" autoComplete="off" placeholder="https://punchout.supplier.com/cxml" value={form.setup_url} onChange={(e) => set('setup_url', e.target.value)} />
        {err('setup_url')}
      </div>
      {(
        [
          ['buyer_identity', 'Your buyer identity'],
          ['sender_identity', 'Your sender identity'],
          ['supplier_identity', 'Supplier identity'],
        ] as const
      ).map(([k, label]) => (
        <div key={k}>
          <label htmlFor={id(k)} className="mb-1 block text-xs font-medium text-text-secondary">{label}</label>
          <input id={id(k)} className={field} autoComplete="off" value={form[k]} onChange={(e) => set(k, e.target.value)} />
          {err(k)}
        </div>
      ))}
      <div>
        <label htmlFor={id('secret')} className="mb-1 block text-xs font-medium text-text-secondary">
          Shared secret {existing?.secret_set && <span className="font-normal">(saved — leave blank to keep)</span>}
        </label>
        <input id={id('secret')} type="password" className={field} autoComplete="new-password" value={form.shared_secret} onChange={(e) => set('shared_secret', e.target.value)} />
        {err('shared_secret')}
      </div>
      <div>
        <label htmlFor={id('env')} className="mb-1 block text-xs font-medium text-text-secondary">Environment</label>
        <select id={id('env')} className={field} value={form.environment} onChange={(e) => set('environment', e.target.value as 'test' | 'production')}>
          <option value="test">Test (supplier sandbox)</option>
          <option value="production">Live</option>
        </select>
      </div>
      <div>
        <label htmlFor={id('cur')} className="mb-1 block text-xs font-medium text-text-secondary">Currency</label>
        <input id={id('cur')} className={field} maxLength={3} value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
        {err('currency')}
      </div>
      <label className="flex items-center gap-2 self-end text-sm text-text-primary">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Connection enabled
      </label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save connection
        </Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ cart review

function CartPanel(props: {
  sessionId: string;
  supplierName: (id: string) => string;
  locations: LocationOption[];
  toast: ToastFn;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { sessionId, supplierName, toast, onClose, onChanged } = props;
  const [session, setSession] = useState<PunchoutSession | null | undefined>(undefined);
  const [lines, setLines] = useState<PunchoutLine[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [holdJob, setHoldJob] = useState(true);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<null | 'order' | 'cancel'>(null);
  const [created, setCreated] = useState<CreatedOrder | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const s = await getSession(sessionId);
      setSession(s);
      setLines(s && (s.status === 'returned' || s.status === 'ordered') ? await listSessionLines(sessionId) : []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);
  // Keep checking while the supplier store is still open.
  useEffect(() => {
    if (!session || !isOpen(session)) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [session, load]);

  const summary = useMemo(() => summarizeReview(lines), [lines]);
  const mismatch = session ? totalMismatch(session.supplier_total_cents, summary.totalCents) : null;

  async function order() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('order');
    try {
      const res = await createOrder({ sessionId, holdJob: holdJob && Boolean(session?.job_id), notes });
      setCreated(res);
      toast(`Order ${res.po_number} created.`, 'success');
      onChanged();
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the order.', 'error');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      await cancelSession(sessionId);
      toast('Cart cancelled.', 'success');
      onChanged();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not cancel this cart.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="rounded-xl bg-danger/10 px-3 py-3 text-sm text-danger">
        Could not load this cart.
        <Button variant="secondary" size="sm" className="ml-3" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (session === undefined) {
    return (
      <div className={`${card} flex items-center gap-2 text-sm text-text-secondary`} role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading cart…
      </div>
    );
  }
  if (session === null) {
    return (
      <div className={card}>
        <p className="text-sm text-text-secondary">That cart was not found.</p>
        <Button className="mt-2" size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    );
  }

  const title = `${supplierName(session.vendor_id)} cart`;

  if (isOpen(session)) {
    return (
      <div className={card} role="status">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p className="mt-2 flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Waiting for you to send the cart back from the supplier’s store…
        </p>
        <p className="mt-1 text-xs text-text-secondary">In the store, finish shopping and choose “Transfer cart” (the wording varies by supplier).</p>
        <Button className="mt-3" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void cancel()}>Cancel</Button>
      </div>
    );
  }

  if (session.status === 'ordered' || created) {
    const po = created?.po_number;
    return (
      <div className={card}>
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" aria-hidden />
          <div>
            <h2 className="text-sm font-semibold text-text-primary">{po ? `Order ${po} created` : 'This cart was ordered'}</h2>
            <p className="mt-1 text-sm text-text-secondary">
              {created?.status === 'pending_approval'
                ? 'It is above your approval limit, so it is waiting for approval.'
                : 'It is saved as a draft purchase order. Send it from Parts & Inventory → Purchase orders.'}
            </p>
            {created?.job.hold === 'ok' && <p className="mt-1 text-xs text-text-secondary">The job is now on hold until the parts arrive.</p>}
          </div>
        </div>
        <Button className="mt-3" size="sm" variant="secondary" onClick={onClose}>Done</Button>
      </div>
    );
  }

  if (session.status !== 'returned') {
    return (
      <div className={card}>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p role={session.status === 'failed' ? 'alert' : undefined} className="mt-2 text-sm text-text-secondary">
          {session.status === 'failed' ? session.error_message ?? 'The supplier store could not be opened.' : `This cart is ${STATUS_LABEL[session.status].toLowerCase()}.`}
        </p>
        <Button className="mt-3" size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    );
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Review {title}</h2>
        <Pill tone="info">{summary.lineCount} lines · {summary.unitCount} units</Pill>
      </div>

      {lines.length === 0 ? (
        <p className="mt-3 text-sm text-text-secondary">This cart has no lines.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <caption className="sr-only">Lines in the supplier cart</caption>
            <thead className="text-xs text-text-secondary">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Part</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Qty</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Unit price</th>
                <th scope="col" className="py-1 pr-3 font-medium">vs catalog</th>
                <th scope="col" className="py-1 text-right font-medium">Line total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const d = lineDelta(l);
                return (
                  <tr key={l.id} className="border-t border-border align-top text-text-primary">
                    <td className="py-2 pr-3">
                      <p className="font-medium">{l.name}</p>
                      <p className="text-xs text-text-secondary">{l.sku}{l.manufacturer ? ` · ${l.manufacturer}` : ''}</p>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.quantity} <span className="text-xs text-text-secondary">{l.uom}</span></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(l.unit_price_cents, session.currency)}</td>
                    <td className="py-2 pr-3 text-xs">
                      {d === null ? <Pill tone="info">New part</Pill> : d === 0 ? <span className="text-text-secondary">Same price</span> : (
                        <Pill tone={d > 0 ? 'warning' : 'success'}>{d > 0 ? '▲' : '▼'} {formatMoney(Math.abs(d), session.currency)}</Pill>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(l.quantity * l.unit_price_cents, session.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
        <span className="text-text-secondary">
          {summary.changed > 0 ? `${summary.changed} price change${summary.changed === 1 ? '' : 's'} vs your catalog` : 'No price changes vs your catalog'}
          {summary.newParts > 0 ? ` · ${summary.newParts} new part${summary.newParts === 1 ? '' : 's'}` : ''}
        </span>
        <span className="text-base font-semibold text-text-primary tabular-nums">{formatMoney(summary.totalCents, session.currency)}</span>
      </div>
      {mismatch !== null && (
        <p role="status" className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          The supplier’s own cart total differs from the line sum by {formatMoney(Math.abs(mismatch), session.currency)} (tax, shipping or rounding). The order uses the line prices.
        </p>
      )}

      {session.job_id && (
        <label className="mt-3 flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={holdJob} onChange={(e) => setHoldJob(e.target.checked)} /> Put the job on hold until these parts arrive
        </label>
      )}
      <div className="mt-3">
        <label htmlFor="po-notes" className="mb-1 block text-xs font-medium text-text-secondary">Order notes (optional)</label>
        <textarea id="po-notes" className={field} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy !== null || lines.length === 0} onClick={() => void order()}>
          {busy === 'order' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShoppingCart className="h-4 w-4" aria-hidden />} Create purchase order
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void cancel()}>Discard cart</Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ history

function SessionsCard({ sessions, supplierName, onOpen }: { sessions: PunchoutSession[]; supplierName: (id: string) => string; onOpen: (id: string) => void }) {
  return (
    <div className={card}>
      <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent carts</h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-text-secondary">No PunchOut carts yet. Open a supplier store above to start one.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <caption className="sr-only">Recent PunchOut carts</caption>
            <thead className="text-xs text-text-secondary">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">When</th>
                <th scope="col" className="py-1 pr-3 font-medium">Supplier</th>
                <th scope="col" className="py-1 pr-3 font-medium">Status</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Lines</th>
                <th scope="col" className="py-1 text-right font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t border-border text-text-primary">
                  <td className="py-2 pr-3">{new Date(s.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-3">{supplierName(s.vendor_id)}</td>
                  <td className="py-2 pr-3"><Pill tone={statusTone(s.status)}>{STATUS_LABEL[s.status]}</Pill></td>
                  <td className="py-2 pr-3 text-right tabular-nums">{s.line_count}</td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => onOpen(s.id)}>{s.status === 'returned' ? 'Review' : 'View'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
