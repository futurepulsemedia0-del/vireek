/**
 * OEM Intelligence Graph — /dashboard/oem-graph
 *
 * Serial # → OEM → Model → Known issue → Bulletin → Required part → Warranty → Claim, for every unit
 * in the account, plus the network benchmark ("this model fails more often in Vireek data than the
 * benchmark"). All matching, scoping and privacy rules run in SQL
 * (supabase/migrations/20270401000000_oem_intelligence_graph.sql); the logic here lives in lib/oemGraph.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Factory, Network, Search, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { OemUnitDetail } from '@/components/oem/OemUnitDetail';
import { fetchOemGraph, fetchOemGraphFleet, fetchOemNetworkStats } from '@/lib/oemGraphApi';
import {
  FLEET_FILTER_LABELS,
  MATCH_LABELS,
  SIGNAL_LABELS,
  filterFleet,
  formatLift,
  summarizeFleet,
  type FleetFilter,
  type OemFleetRow,
  type OemGraph,
  type OemNetworkStats,
} from '@/lib/oemGraph';

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/70';
const FILTERS = Object.keys(FLEET_FILTER_LABELS) as FleetFilter[];

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

export function OemGraphPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('unit');

  const [fleet, setFleet] = useState<OemFleetRow[] | null>(null);
  const [fleetError, setFleetError] = useState(false);
  const [stats, setStats] = useState<OemNetworkStats | null>(null);
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [query, setQuery] = useState('');
  const [graph, setGraph] = useState<OemGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState(false);
  const requestSeq = useRef(0);
  const now = useMemo(() => new Date(), []);

  const loadFleet = useCallback(async () => {
    setFleetError(false);
    setFleet(null);
    const [rows, networkStats] = await Promise.allSettled([fetchOemGraphFleet(), fetchOemNetworkStats()]);
    if (rows.status === 'fulfilled') setFleet(rows.value);
    else {
      setFleet([]);
      setFleetError(true);
    }
    setStats(networkStats.status === 'fulfilled' ? networkStats.value : null);
  }, []);

  useEffect(() => {
    void loadFleet();
  }, [loadFleet]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    if (!selectedId) {
      setGraph(null);
      setGraphError(false);
      setGraphLoading(false);
      return;
    }
    setGraphLoading(true);
    setGraphError(false);
    setGraph(null);
    fetchOemGraph(selectedId)
      .then((g) => {
        if (seq !== requestSeq.current) return;
        if (!g.found) setGraphError(true);
        else setGraph(g);
      })
      .catch(() => {
        if (seq === requestSeq.current) setGraphError(true);
      })
      .finally(() => {
        if (seq === requestSeq.current) setGraphLoading(false);
      });
  }, [selectedId]);

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set('unit', id);
      else next.delete('unit');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  const summary = useMemo(() => summarizeFleet(fleet ?? []), [fleet]);
  const visible = useMemo(() => filterFleet(fleet ?? [], filter, query), [fleet, filter, query]);

  return (
    <DashboardLayout activeLabel="OEM Intelligence Graph">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Network size={22} className="text-accent" aria-hidden="true" /> OEM Intelligence Graph
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
            Every unit connected end to end — serial, manufacturer, model, known issues, bulletins, required parts, warranty and claims — and
            benchmarked against what actually happens in the Vireek network.
          </p>
        </div>

        {fleet === null ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Active units" value={String(summary.total)} />
              <StatTile label="Matched to OEM" value={`${summary.matchedPct}%`} hint={`${summary.matched} of ${summary.total}`} />
              <StatTile label="With recalls" value={String(summary.withRecalls)} />
              <StatTile
                label="Above benchmark"
                value={String(summary.aboveBenchmark)}
                hint={stats ? `${stats.contributing_businesses} contributing businesses` : 'Benchmark not published yet'}
              />
            </div>

            {fleetError && (
              <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                <span className="flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> The OEM graph could not be loaded.</span>
                <Button variant="secondary" size="sm" onClick={() => void loadFleet()}>Retry</Button>
              </div>
            )}

            {!fleetError && summary.total === 0 ? (
              <EmptyState
                icon={Factory}
                title="No equipment to connect yet"
                description="Add equipment to a customer and it appears here, matched to its manufacturer and model automatically."
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <section aria-label="Units" className="min-w-0">
                  <div className="relative mb-2">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search make, model, customer, serial"
                      aria-label="Search units"
                      className={FIELD}
                    />
                  </div>
                  <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter units">
                    {FILTERS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={filter === f}
                        onClick={() => setFilter(f)}
                        className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
                          filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {FLEET_FILTER_LABELS[f]}
                      </button>
                    ))}
                  </div>

                  {visible.length === 0 ? (
                    <EmptyState icon={Search} title="Nothing matches" description="Try a different filter or search term." />
                  ) : (
                    <ul className="space-y-2">
                      {visible.map((row) => {
                        const active = row.equipment_id === selectedId;
                        const above = row.reliability?.signal === 'above_benchmark';
                        return (
                          <li key={row.equipment_id}>
                            <button
                              type="button"
                              onClick={() => select(row.equipment_id)}
                              aria-current={active ? 'true' : undefined}
                              className={`focus-ring w-full rounded-2xl border p-3 text-left transition-colors ${
                                active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                              }`}
                            >
                              <p className="truncate text-sm font-semibold text-text-primary">
                                {[row.make, row.model].filter(Boolean).join(' ') || 'Unnamed unit'}
                              </p>
                              <p className="truncate text-xs text-text-secondary">
                                {row.equipment_type}
                                {row.customer_name ? ` · ${row.customer_name}` : ''}
                              </p>
                              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{MATCH_LABELS[row.match_method]}</span>
                                {row.recall_count > 0 && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 font-medium text-danger">
                                    <ShieldAlert size={11} aria-hidden="true" /> {row.recall_count} recall{row.recall_count === 1 ? '' : 's'}
                                  </span>
                                )}
                                {row.issue_count > 0 && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 font-medium text-warning-500">{row.issue_count} issue{row.issue_count === 1 ? '' : 's'}</span>}
                                {above && row.reliability && (
                                  <span className="rounded-full bg-danger/10 px-2 py-0.5 font-medium text-danger">
                                    {SIGNAL_LABELS.above_benchmark}
                                    {formatLift(row.reliability.lift) ? ` · ${formatLift(row.reliability.lift)}` : ''}
                                  </span>
                                )}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <section aria-label="Unit detail" aria-live="polite" className="min-w-0">
                  {!selectedId && (
                    <EmptyState icon={Network} title="Select a unit" description="Pick a unit to see its full chain from serial number to warranty claim." />
                  )}
                  {selectedId && graphLoading && <SkeletonCardList count={3} />}
                  {selectedId && graphError && !graphLoading && (
                    <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                      <p>This unit could not be loaded. It may have been removed.</p>
                      <div className="mt-2 flex gap-2">
                        <Button variant="secondary" size="sm" onClick={() => select(selectedId)}>Retry</Button>
                        <Button variant="secondary" size="sm" onClick={() => select(null)}>Close</Button>
                      </div>
                    </div>
                  )}
                  {graph && !graphLoading && <OemUnitDetail graph={graph} now={now} />}
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
