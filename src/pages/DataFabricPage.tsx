/**
 * Data Fabric — /dashboard/data-fabric
 *
 * Universal Service Data Layer: connect any external system (CRM, ERP,
 * accounting, OEM, IoT, telematics, maps, payments, inventory, phone, email,
 * calendar, insurance, warranty, government, marketplace) and watch it resolve
 * into the canonical service graph.
 * See src/lib/dataFabric.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Layers,
  Link2,
  Network,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  buildCurlExample,
  CANONICAL_ENTITIES,
  createConnection,
  DOMAIN_BY_KEY,
  deleteConnection,
  ENTITY_LABELS,
  fabricErrMessage,
  fetchConnections,
  fetchOverview,
  fetchRecords,
  FABRIC_DOMAINS,
  healthPercent,
  ingestEndpoint,
  parseFieldMapping,
  reapplyFailed,
  rotateIngestKey,
  timeAgo,
  updateConnection,
  type CanonicalEntity,
  type FabricConnection,
  type FabricDomain,
  type FabricOverview,
  type FabricRecordRow,
} from '@/lib/dataFabric';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';
const FIELD =
  'w-full rounded-xl border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus-ring';
const LABEL = 'mb-1 block text-xs font-medium text-text-secondary';

const MAPPING_PLACEHOLDER = `{
  "customer": {
    "external_id": "contact.id",
    "name": "contact.fullName",
    "email": "contact.emails[0]",
    "phone": "contact.phone"
  }
}`;

// ============================================================
// SMALL PARTS
// ============================================================

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      {hint && <p className="text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, note }: { icon: typeof Network; title: string; note?: string }) {
  return (
    <div className="mb-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Icon size={15} /> {title}
      </h2>
      {note && <p className="mt-0.5 text-xs text-text-secondary">{note}</p>}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// KEY REVEAL (shown once)
// ============================================================

interface RevealState {
  name: string;
  domain: FabricDomain;
  key: string;
}

function KeyReveal({ reveal, onClose }: { reveal: RevealState; onClose: () => void }) {
  const { toast } = useToast();
  const curl = useMemo(() => buildCurlExample(reveal.domain, reveal.key), [reveal]);

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    toast(ok ? `${what} copied` : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
  };

  return (
    <div className={`${CARD} border-accent/40`}>
      <SectionTitle
        icon={KeyRound}
        title={`Ingest key for “${reveal.name}”`}
        note="Copy it now — for security it is shown only once. If you lose it, rotate the key."
      />
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-primary">{reveal.key}</code>
        <Button size="sm" variant="secondary" onClick={() => void copy(reveal.key, 'Key')}>
          <Copy size={14} /> Copy key
        </Button>
      </div>
      <p className="mt-3 text-xs text-text-secondary">Endpoint: <code className="break-all">{ingestEndpoint()}</code></p>
      <pre className="mt-2 overflow-x-auto rounded-xl bg-bg-tertiary p-3 text-[11px] leading-relaxed text-text-primary">{curl}</pre>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => void copy(curl, 'Example')}>
          <Copy size={14} /> Copy example
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>I saved the key</Button>
      </div>
    </div>
  );
}

// ============================================================
// CREATE FORM
// ============================================================

function CreateConnectionForm({
  initialDomain,
  onCreated,
  onCancel,
}: {
  initialDomain: FabricDomain;
  onCreated: (reveal: RevealState) => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [domain, setDomain] = useState<FabricDomain>(initialDomain);
  const [name, setName] = useState('');
  const [entities, setEntities] = useState<CanonicalEntity[]>(DOMAIN_BY_KEY[initialDomain].entities);
  const [mappingText, setMappingText] = useState('');
  const [busy, setBusy] = useState(false);

  const pickDomain = (d: FabricDomain) => {
    setDomain(d);
    setEntities(DOMAIN_BY_KEY[d].entities);
  };

  const toggleEntity = (e: CanonicalEntity) =>
    setEntities((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));

  const submit = async () => {
    if (busy) return;
    if (name.trim().length < 2) return toast('Give the connection a name (2+ characters)', 'error');
    if (entities.length === 0) return toast('Select at least one entity', 'error');
    const mapping = parseFieldMapping(mappingText);
    if (!mapping.ok) return toast(mapping.error, 'error');

    setBusy(true);
    try {
      const { ingestKey } = await createConnection({ domain, name, entities, fieldMapping: mapping.value });
      onCreated({ name: name.trim(), domain, key: ingestKey });
    } catch (e) {
      toast(fabricErrMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={CARD}>
      <SectionTitle icon={Plus} title="New data connection" note="One connection per source system. You can pause or rotate its key at any time." />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="fabric-domain" className={LABEL}>Category</label>
          <select id="fabric-domain" className={FIELD} value={domain} onChange={(e) => pickDomain(e.target.value as FabricDomain)}>
            {FABRIC_DOMAINS.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fabric-name" className={LABEL}>Connection name</label>
          <input id="fabric-name" className={FIELD} value={name} maxLength={120} placeholder="e.g. Salesforce production" onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <fieldset className="mt-3">
        <legend className={LABEL}>Entities this source may send</legend>
        <div className="flex flex-wrap gap-2">
          {CANONICAL_ENTITIES.map((e) => {
            const on = entities.includes(e.key);
            return (
              <button
                key={e.key}
                type="button"
                aria-pressed={on}
                title={e.hint}
                onClick={() => toggleEntity(e.key)}
                className={`focus-ring rounded-full border px-3 py-1 text-xs transition-colors ${
                  on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:bg-bg-tertiary'
                }`}
              >
                {e.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-3">
        <label htmlFor="fabric-mapping" className={LABEL}>Field mapping (optional JSON — only needed if the source sends its own payload shape)</label>
        <textarea
          id="fabric-mapping"
          className={`${FIELD} font-mono text-xs`}
          rows={6}
          value={mappingText}
          placeholder={MAPPING_PLACEHOLDER}
          onChange={(e) => setMappingText(e.target.value)}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Creating…' : 'Create connection'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

type ConfirmState = { kind: 'delete' | 'rotate'; conn: FabricConnection } | null;

export function DataFabricPage() {
  const { toast } = useToast();
  const [connections, setConnections] = useState<FabricConnection[]>([]);
  const [overview, setOverview] = useState<FabricOverview | null>(null);
  const [issues, setIssues] = useState<FabricRecordRow[]>([]);
  const [recent, setRecent] = useState<FabricRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingDomain, setCreatingDomain] = useState<FabricDomain | null>(null);
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, o, bad, latest] = await Promise.all([
        fetchConnections(),
        fetchOverview(),
        fetchRecords({ statuses: ['failed', 'dead_letter'], limit: 15 }),
        fetchRecords({ limit: 10 }),
      ]);
      setConnections(c);
      setOverview(o);
      setIssues(bad);
      setRecent(latest);
      setLoadError(null);
    } catch (e) {
      setLoadError(fabricErrMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connById = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const statById = useMemo(() => new Map((overview?.by_connection ?? []).map((s) => [s.connection_id, s])), [overview]);
  const countByDomain = useMemo(() => {
    const m = new Map<FabricDomain, number>();
    connections.forEach((c) => m.set(c.domain, (m.get(c.domain) ?? 0) + 1));
    return m;
  }, [connections]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (e) {
      toast(fabricErrMessage(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const togglePause = (c: FabricConnection) =>
    run(c.id, async () => {
      await updateConnection(c.id, { status: c.status === 'active' ? 'paused' : 'active' });
      toast(c.status === 'active' ? 'Connection paused' : 'Connection resumed');
    });

  const retry = (connectionId?: string) =>
    run(connectionId ?? 'all', async () => {
      const r = await reapplyFailed(connectionId);
      toast(
        r.retried === 0 ? 'Nothing to retry' : `Retried ${r.retried}: ${r.applied} applied, ${r.failed} still failing`,
        r.failed > 0 ? 'info' : 'success',
      );
    });

  const handleConfirm = async () => {
    if (!confirm) return;
    const { kind, conn } = confirm;
    setConfirm(null);
    await run(conn.id, async () => {
      if (kind === 'delete') {
        await deleteConnection(conn.id);
        toast('Connection deleted');
      } else {
        const key = await rotateIngestKey(conn.id);
        setReveal({ name: conn.name, domain: conn.domain, key });
        toast('Key rotated — the old key no longer works');
      }
    });
  };

  const health = overview ? healthPercent(overview) : null;
  const needsAttention = (overview?.failed ?? 0) + (overview?.dead_letter ?? 0);

  return (
    <DashboardLayout activeLabel="Data Fabric">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
              <Layers size={20} /> Data Fabric
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              One canonical service graph fed by every system you run. Records are de-duplicated, matched to the customers,
              properties and equipment you already have, and linked with full provenance.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/dashboard/service-graph" className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
              <Network size={15} /> Open graph
            </Link>
            <Button size="sm" onClick={() => setCreatingDomain((d) => d ?? 'crm')}>
              <Plus size={15} /> New connection
            </Button>
          </div>
        </header>

        {loading ? (
          <>
            <SkeletonStatGrid count={6} />
            <SkeletonCardList count={3} />
          </>
        ) : loadError ? (
          <div role="alert" className={`${CARD} border-danger/40`}>
            <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <AlertTriangle size={15} /> Couldn’t load the Data Fabric
            </p>
            <p className="mt-1 text-xs text-text-secondary">{loadError}</p>
            <p className="mt-1 text-xs text-text-secondary">Data connections are visible to the account owner and team members with billing access.</p>
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }}>
              <RefreshCw size={14} /> Try again
            </Button>
          </div>
        ) : (
          <>
            {overview && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                <StatCard label="Connections" value={`${overview.active_connections}/${overview.connections}`} hint="active / total" />
                <StatCard label="Records (24h)" value={overview.records_24h.toLocaleString()} hint={`${overview.records_total.toLocaleString()} total`} />
                <StatCard label="Ingest health" value={health === null ? '—' : `${health}%`} hint="landed cleanly" />
                <StatCard label="Graph nodes linked" value={overview.linked_nodes.toLocaleString()} />
                <StatCard label="Multi-source nodes" value={overview.multi_source_nodes.toLocaleString()} hint="confirmed by 2+ systems" />
                <StatCard label="Needs attention" value={needsAttention.toLocaleString()} hint={needsAttention ? 'failed records' : 'all clear'} />
              </div>
            )}

            {reveal && <KeyReveal reveal={reveal} onClose={() => setReveal(null)} />}

            {creatingDomain && (
              <CreateConnectionForm
                key={creatingDomain}
                initialDomain={creatingDomain}
                onCancel={() => setCreatingDomain(null)}
                onCreated={(r) => {
                  setCreatingDomain(null);
                  setReveal(r);
                  toast('Connection created');
                  void load();
                }}
              />
            )}

            <section>
              <SectionTitle icon={Plug} title="Coverage" note="Sixteen categories of systems, one canonical model. Pick a category to connect a source." />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {FABRIC_DOMAINS.map((d) => {
                  const n = countByDomain.get(d.key) ?? 0;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => setCreatingDomain(d.key)}
                      className="focus-ring rounded-2xl border border-border bg-bg-secondary p-3 text-left transition-colors hover:border-accent/40 hover:bg-bg-tertiary"
                    >
                      <span className="flex items-center justify-between">
                        <d.icon size={16} className="text-accent" />
                        {n > 0 && <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">{n} connected</span>}
                      </span>
                      <span className="mt-2 block text-sm font-semibold text-text-primary">{d.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-text-secondary">{d.description}</span>
                      <span className="mt-1 block text-[10px] text-text-secondary/80">{d.examples}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <SectionTitle icon={Link2} title="Connections" />
              {connections.length === 0 ? (
                <EmptyState
                  icon={Layers}
                  title="No data connections yet"
                  description="Connect your first system. It takes a minute: name it, pick the entities it sends, and copy the ingest key."
                  action={{ label: 'New connection', onClick: () => setCreatingDomain('crm') }}
                />
              ) : (
                <div className="space-y-3">
                  {connections.map((c) => {
                    const info = DOMAIN_BY_KEY[c.domain];
                    const stat = statById.get(c.id);
                    const busy = busyId === c.id;
                    return (
                      <div key={c.id} className={CARD}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><info.icon size={17} /></span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-text-primary">{c.name}</p>
                              <p className="text-[11px] text-text-secondary">
                                {info.label} · key <code>{c.ingest_key_prefix}…</code> · last event {timeAgo(c.last_event_at)}
                              </p>
                              <p className="mt-1 text-[11px] text-text-secondary">
                                {c.entities.map((e) => ENTITY_LABELS[e] ?? e).join(', ')}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.status === 'active' ? 'bg-success/15 text-success' : 'bg-warning-500/15 text-warning-500'}`}>
                              {c.status === 'active' ? 'Active' : 'Paused'}
                            </span>
                            <span className="text-xs text-text-secondary">
                              {(stat?.records ?? 0).toLocaleString()} records{stat && stat.failed > 0 ? ` · ${stat.failed} failed` : ''}
                            </span>
                          </div>
                        </div>
                        {c.last_error && (
                          <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">Last error: {c.last_error}</p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void togglePause(c)}>
                            {c.status === 'active' ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Resume</>}
                          </Button>
                          {stat && stat.failed > 0 && (
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retry(c.id)}>
                              <RefreshCw size={14} /> Retry failed
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'rotate', conn: c })}>
                            <KeyRound size={14} /> Rotate key
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'delete', conn: c })}>
                            <Trash2 size={14} /> Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {issues.length > 0 && (
              <section>
                <div className="flex items-start justify-between gap-3">
                  <SectionTitle icon={AlertTriangle} title="Needs attention" note="Records that could not be applied. Fix the mapping or source data, then retry." />
                  <Button size="sm" variant="secondary" disabled={busyId === 'all'} onClick={() => void retry()}>
                    <RefreshCw size={14} /> Retry all
                  </Button>
                </div>
                <div className={`${CARD} overflow-x-auto p-0`}>
                  <table className="w-full min-w-[560px] text-left text-xs">
                    <thead className="text-text-secondary">
                      <tr><th className="p-3 font-medium">Source</th><th className="p-3 font-medium">Record</th><th className="p-3 font-medium">Error</th><th className="p-3 font-medium">Tries</th><th className="p-3 font-medium">Received</th></tr>
                    </thead>
                    <tbody>
                      {issues.map((r) => (
                        <tr key={r.id} className="border-t border-border align-top">
                          <td className="p-3 text-text-primary">{connById.get(r.connection_id)?.name ?? '—'}</td>
                          <td className="p-3 text-text-primary">{ENTITY_LABELS[r.entity]} · <code>{r.external_id}</code></td>
                          <td className="p-3 text-danger">{r.error ?? 'Unknown error'}{r.status === 'dead_letter' ? ' (gave up)' : ''}</td>
                          <td className="p-3 text-text-secondary">{r.attempts}</td>
                          <td className="p-3 text-text-secondary">{timeAgo(r.received_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {recent.length > 0 && (
              <section>
                <SectionTitle icon={Activity} title="Recent activity" note="How each record was matched into your graph." />
                <div className={`${CARD} divide-y divide-border p-0`}>
                  {recent.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs">
                      <span className="flex items-center gap-2 text-text-primary">
                        {r.status === 'applied' ? <CheckCircle2 size={14} className="text-success" /> : <AlertTriangle size={14} className="text-warning-500" />}
                        {ENTITY_LABELS[r.entity]} · <code>{r.external_id}</code>
                        <span className="text-text-secondary">from {connById.get(r.connection_id)?.name ?? 'source'}</span>
                      </span>
                      <span className="text-text-secondary">
                        {r.status === 'applied' && r.match_method
                          ? `matched by ${r.match_method.replace('_', ' ')}${r.match_confidence ? ` (${Math.round(Number(r.match_confidence) * 100)}%)` : ''}`
                          : r.status}
                        {' · '}{timeAgo(r.received_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'delete' ? 'Delete this connection?' : 'Rotate the ingest key?'}
        description={
          confirm?.kind === 'delete'
            ? 'The source will stop being accepted and its landed records are removed. Graph nodes already created stay in your service graph.'
            : 'A new key is generated and the current one stops working immediately. Update the source system with the new key.'
        }
        confirmPhrase={confirm?.kind === 'delete' ? 'delete connection' : undefined}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete connection' : 'Rotate key'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </DashboardLayout>
  );
}
