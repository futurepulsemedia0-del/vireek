/**
 * Universal Identity Layer — /dashboard/identity-graph
 *
 * Search every entity (Person, Company, Property, Equipment, Service, Technician, Contractor, Part, Agent, Outcome,
 * Evidence, Transaction) by name, external reference or universal ID; explore the graph around it; and manage its
 * lifecycle, provenance, history and access. Logic: lib/universalIdentity.ts. Data:
 * supabase/migrations/20270415000000_universal_identity_layer.sql.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Fingerprint, Plus, RefreshCw, Search } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { EntityDossier } from '@/components/identity/EntityDossier';
import { IdentityGraphCanvas } from '@/components/identity/IdentityGraphCanvas';
import { RegisterIdentityDialog } from '@/components/identity/RegisterIdentityDialog';
import {
  fetchIdentityDossier, fetchIdentityGraph, fetchIdentityOverview, resolveIdentityUid, searchIdentities, syncOperationalIdentities,
} from '@/lib/universalIdentityApi';
import {
  ENTITY_TYPES, ENTITY_TYPE_META, LIFECYCLE_META, coverageGap, coveragePercent, formatConfidence, identityErrorMessage, looksLikeUid, shortUid,
  type EntityType, type IdentityDossier, type IdentityGraph, type IdentityOverview, type SearchResult,
} from '@/lib/universalIdentity';

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/70';
const PAGE_SIZE = 25;

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

export function UniversalIdentityPage() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('entity');

  const [overview, setOverview] = useState<IdentityOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<EntityType[]>([]);
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [dossier, setDossier] = useState<IdentityDossier | null>(null);
  const [graph, setGraph] = useState<IdentityGraph | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const searchSeq = useRef(0);
  const detailSeq = useRef(0);

  const loadOverview = useCallback(async () => {
    setOverviewError(false);
    try { setOverview(await fetchIdentityOverview()); } catch { setOverviewError(true); }
  }, []);

  const runSearch = useCallback(async (q: string, t: EntityType[], p: number) => {
    const seq = ++searchSeq.current;
    setSearchError(false);
    try {
      // Pasting a universal ID jumps straight to it (following merge redirects).
      if (looksLikeUid(q)) {
        const hit = await resolveIdentityUid(q);
        if (seq !== searchSeq.current) return;
        if (hit.found && hit.entity) {
          setResults({ total: 1, limit: PAGE_SIZE, offset: 0, items: [hit.entity] });
          if (hit.redirected) toast('That ID was merged; showing the surviving entity.', 'info');
          return;
        }
      }
      const r = await searchIdentities({ query: q, types: t, limit: PAGE_SIZE, offset: p * PAGE_SIZE });
      if (seq === searchSeq.current) setResults(r);
    } catch {
      if (seq === searchSeq.current) { setSearchError(true); setResults({ total: 0, limit: PAGE_SIZE, offset: 0, items: [] }); }
    }
  }, [toast]);

  const loadDetail = useCallback(async (id: string | null) => {
    const seq = ++detailSeq.current;
    if (!id) { setDossier(null); setGraph(null); setDetailError(false); setDetailLoading(false); return; }
    setDetailLoading(true); setDetailError(false);
    const [d, g] = await Promise.allSettled([fetchIdentityDossier(id), fetchIdentityGraph(id, 2)]);
    if (seq !== detailSeq.current) return;
    if (d.status === 'fulfilled' && d.value.found) {
      setDossier(d.value);
      setGraph(g.status === 'fulfilled' && g.value.found ? g.value : null);
    } else { setDossier(null); setGraph(null); setDetailError(true); }
    setDetailLoading(false);
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => {
    const timer = window.setTimeout(() => void runSearch(query, types, page), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, types, page, runSearch]);
  useEffect(() => { void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const select = useCallback((id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('entity', id); else next.delete('entity');
    setParams(next);
  }, [params, setParams]);

  const refreshAll = useCallback(() => {
    void loadOverview();
    void runSearch(query, types, page);
    void loadDetail(selectedId);
  }, [loadOverview, runSearch, loadDetail, query, types, page, selectedId]);

  async function sync() {
    setSyncing(true);
    try {
      let rounds = 0;
      let total = 0;
      for (;;) {
        const r = await syncOperationalIdentities(400);
        total += Object.values(r.synced).reduce((a, b) => a + b, 0);
        rounds += 1;
        if (!r.more || rounds >= 25) break;
      }
      toast(total > 0 ? `Registered ${total} identities from your existing data` : 'Everything is already registered', 'success');
      refreshAll();
    } catch (err) {
      toast(identityErrorMessage(err), 'error');
    } finally { setSyncing(false); }
  }

  const toggleType = (t: EntityType) => { setPage(0); setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t])); };
  const coverage = useMemo(() => (overview ? coveragePercent(overview.coverage) : 0), [overview]);
  const gaps = useMemo(() => (overview ? overview.coverage.filter((c) => coverageGap(c) > 0) : []), [overview]);
  const totalPages = results ? Math.max(1, Math.ceil(results.total / PAGE_SIZE)) : 1;

  return (
    <DashboardLayout activeLabel="Universal Identity">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Fingerprint size={24} aria-hidden="true" /> Universal Identity</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            One permanent ID for every person, company, property, equipment, service, technician, contractor, part, agent, outcome, evidence and transaction — with relationships, provenance, permissions, lifecycle and a tamper-evident history.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} aria-hidden="true" /> {syncing ? 'Syncing…' : 'Sync existing data'}
          </Button>
          <Button size="sm" onClick={() => setRegisterOpen(true)}><Plus size={14} aria-hidden="true" /> Register</Button>
        </div>
      </div>

      {overview === null && !overviewError ? <SkeletonStatGrid /> : overview && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Identities" value={overview.entities.toLocaleString()} hint={overview.avg_confidence !== null ? `Avg confidence ${formatConfidence(overview.avg_confidence)}` : undefined} />
          <StatTile label="Relationships" value={overview.relationships.toLocaleString()} />
          <StatTile label="Provenance claims" value={overview.provenance_claims.toLocaleString()} />
          <StatTile label="History events" value={overview.events.toLocaleString()} hint="Hash-chained" />
          <StatTile label="Coverage" value={`${coverage}%`} hint={gaps.length ? `${gaps.length} source${gaps.length > 1 ? 's' : ''} not fully registered` : 'All operational data registered'} />
        </div>
      )}
      {overviewError && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          <span className="flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> The identity layer could not be loaded. Make sure the latest migration has been applied.</span>
          <Button variant="secondary" size="sm" onClick={() => void loadOverview()}>Retry</Button>
        </div>
      )}

      {gaps.length > 0 && (
        <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="mb-2 text-sm font-semibold text-text-primary">Not yet in the identity graph</p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {gaps.map((c) => <li key={c.key} className="rounded-full bg-bg-tertiary px-3 py-1 text-text-secondary">{c.label}: {coverageGap(c).toLocaleString()} missing</li>)}
          </ul>
          <p className="mt-2 text-[11px] text-text-secondary">New records register automatically. “Sync existing data” backfills what was created before the layer was installed.</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-label="Identities" className="min-w-0">
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
            <input type="search" value={query} onChange={(e) => { setPage(0); setQuery(e.target.value); }} placeholder="Search name, reference, or paste a VRK-… ID" aria-label="Search identities" className={FIELD} />
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
            {ENTITY_TYPES.map((t) => (
              <button key={t} type="button" aria-pressed={types.includes(t)} onClick={() => toggleType(t)}
                className={`focus-ring rounded-full border px-2.5 py-1 text-[11px] font-medium ${types.includes(t) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                {ENTITY_TYPE_META[t].plural}{overview?.by_type[t] ? ` · ${overview.by_type[t]}` : ''}
              </button>
            ))}
          </div>

          {results === null ? <SkeletonCardList count={5} rows={2} /> : searchError ? (
            <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">Search failed. <button type="button" className="underline" onClick={() => void runSearch(query, types, page)}>Retry</button></div>
          ) : results.items.length === 0 ? (
            <EmptyState icon={Fingerprint} title={query || types.length ? 'Nothing matches' : 'No identities yet'}
              description={query || types.length ? 'Try a different search or clear the filters.' : 'Sync your existing customers, equipment and jobs, or register an identity by hand.'}
              action={!query && !types.length ? { label: 'Sync existing data', onClick: () => void sync() } : undefined} />
          ) : (
            <>
              <ul className="space-y-2">
                {results.items.map((it) => {
                  const m = ENTITY_TYPE_META[it.entity_type];
                  const active = it.id === selectedId;
                  const st = LIFECYCLE_META[it.lifecycle_state];
                  return (
                    <li key={it.id}>
                      <button type="button" onClick={() => select(it.id)} aria-current={active ? 'true' : undefined}
                        className={`focus-ring w-full rounded-2xl border p-3 text-left transition-colors ${active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-semibold text-text-primary">{it.display_name}</p>
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: m.color }}>{m.label}</span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary">{shortUid(it.uid)}</p>
                        <p className="mt-1 text-[11px] text-text-secondary">{st.label} · {formatConfidence(it.confidence)} confidence{it.scope === 'global' ? ' · Global' : ''}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {totalPages > 1 && (
                <div className="mt-3 flex items-center justify-between text-xs text-text-secondary">
                  <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
                  <span>Page {page + 1} of {totalPages} · {results.total.toLocaleString()} results</span>
                  <Button size="sm" variant="ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              )}
            </>
          )}
        </section>

        <section aria-label="Selected identity" className="min-w-0 space-y-4" aria-live="polite">
          {!selectedId ? (
            <EmptyState icon={Fingerprint} title="Select an identity" description="Pick an entity to see its graph, relationships, provenance, history and access." />
          ) : detailLoading ? (
            <SkeletonCardList count={2} rows={4} />
          ) : detailError || !dossier ? (
            <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              This entity could not be loaded or you no longer have access. <button type="button" className="underline" onClick={() => select(null)}>Clear</button>
            </div>
          ) : (
            <>
              {graph && graph.nodes.length > 1 && <IdentityGraphCanvas graph={graph} selectedId={selectedId} onSelect={select} />}
              <EntityDossier dossier={dossier} onChanged={refreshAll} onSelect={select} />
            </>
          )}
        </section>
      </div>

      <RegisterIdentityDialog open={registerOpen} onClose={() => setRegisterOpen(false)} onRegistered={(id) => { select(id); refreshAll(); }} />
    </DashboardLayout>
  );
}
