import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { Crosshair, List, Map as MapIcon, MapPinOff, Satellite, ShieldCheck, TriangleAlert, Truck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Skeleton, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { LiveMapCanvas } from '@/components/livemap/LiveMapCanvas';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  appendTrailPoint,
  buildVehicleViews,
  filterViews,
  formatEta,
  isLateJob,
  summarizeLiveMap,
  type LiveRow,
  type StateFilter,
  type TrailPoint,
  type VehicleView,
} from '@/lib/liveMap';
import { loadLiveMap, type LiveMapSnapshot } from '@/lib/liveMapApi';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const FLUSH_MS = 750;
const TICK_MS = 30_000;

const FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'moving', label: 'Moving' },
  { value: 'idling', label: 'Idle' },
  { value: 'offline', label: 'Offline' },
];

const STATE_DOT: Record<VehicleView['state'], string> = {
  moving: 'bg-success-500',
  idling: 'bg-warning-500',
  stopped: 'bg-accent',
  offline: 'bg-text-secondary',
};
const STATE_LABEL: Record<VehicleView['state'], string> = { moving: 'Moving', idling: 'Idling', stopped: 'Stopped', offline: 'Offline' };

const ageText = (min: number | null) => (min === null ? 'no fix yet' : min < 1 ? 'just now' : min < 60 ? `${Math.round(min)} min ago` : `${Math.floor(min / 60)} h ago`);

function etaLine(v: VehicleView): string {
  if (!v.job) return 'No job assigned';
  if (v.onSite) return `On site · ${v.job.customer_name}`;
  if (v.etaMinutes !== null) return `ETA ${formatEta(v.etaMinutes)}${v.distanceMiles !== null ? ` · ${v.distanceMiles} mi` : ''}`;
  return `ETA unavailable (GPS ${v.state === 'offline' ? 'offline' : 'stale'})`;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-0.5 text-xl font-bold text-text-primary">{value}</p>
    </div>
  );
}

export function LiveMapPage() {
  const navigate = useNavigate();
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canView = permissions.can_view_all_jobs;

  const [snapshot, setSnapshot] = useState<LiveMapSnapshot | null>(null);
  const [liveRows, setLiveRows] = useState<Map<string, LiveRow>>(new Map());
  const [trails, setTrails] = useState<Map<string, TrailPoint[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [filter, setFilter] = useState<StateFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'map' | 'list'>('map');
  const [fitSignal, setFitSignal] = useState(0);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapKey, setMapKey] = useState(0);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    try {
      const snap = await loadLiveMap(accountOwnerId);
      setSnapshot(snap);
      setLiveRows(snap.live);
      setTrails(snap.trails);
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    if (!accountOwnerId) {
      if (!profileLoading) setLoading(false);
      return;
    }
    setLoading(true);
    void load();
  }, [canView, accountOwnerId, profileLoading, load]);

  // Keep "age", ETAs and late flags honest even when no new GPS fix arrives.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // ---- Realtime: batch bursts of GPS updates into one render per FLUSH_MS ----
  const pending = useRef(new Map<string, LiveRow | null>());
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const batch = new Map(pending.current);
    pending.current.clear();
    if (batch.size === 0) return;
    setLiveRows((prev) => {
      const next = new Map(prev);
      batch.forEach((row, id) => (row ? next.set(id, row) : next.delete(id)));
      return next;
    });
    setTrails((prev) => {
      const next = new Map(prev);
      const now = Date.now();
      batch.forEach((row, id) => {
        if (!row || row.latitude === null || row.longitude === null) return;
        const t = row.last_fix_at ? Date.parse(row.last_fix_at) : now;
        next.set(id, appendTrailPoint(prev.get(id) ?? [], { lat: Number(row.latitude), lng: Number(row.longitude), t: Number.isNaN(t) ? now : t }, now));
      });
      return next;
    });
  }, []);

  const onChange = useCallback(
    (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'DELETE') {
        const id = (payload.old as { vehicle_id?: string } | undefined)?.vehicle_id;
        if (id) pending.current.set(id, null);
      } else {
        const row = payload.new as unknown as LiveRow | undefined;
        if (row?.vehicle_id) pending.current.set(row.vehicle_id, row);
      }
      if (timer.current === null) timer.current = window.setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const rtStatus = useRealtimeSubscription<Record<string, unknown>>({
    channelName: `live-map-${accountOwnerId ?? 'anon'}`,
    table: 'vehicle_live_state',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    onChange,
    enabled: !!accountOwnerId && canView && !!snapshot,
  });

  // After a dropped connection, anything missed is re-fetched rather than guessed.
  const prevRt = useRef(rtStatus);
  useEffect(() => {
    if (prevRt.current === 'reconnecting' && rtStatus === 'live') void load();
    prevRt.current = rtStatus;
  }, [rtStatus, load]);

  // ---- Derived data ----------------------------------------------------------
  const derived = useMemo(() => {
    if (!snapshot) return null;
    const { views, unlocated } = buildVehicleViews(snapshot.vehicles, liveRows, snapshot.techs, snapshot.jobs, nowMs, snapshot.geofenceM);
    return { views, unlocated, summary: summarizeLiveMap(views, snapshot.jobs, nowMs) };
  }, [snapshot, liveRows, nowMs]);

  const shown = useMemo(() => (derived ? filterViews(derived.views, filter) : []), [derived, filter]);
  const selected = useMemo(() => derived?.views.find((v) => v.id === selectedId) ?? null, [derived, selectedId]);
  const mapJobs = useMemo(() => snapshot?.jobs ?? [], [snapshot]);
  const mapViews = shown;

  const selectVehicle = (id: string | null) => {
    setSelectedId(id);
    if (id) setMobileTab('map');
  };

  // ---- Render ----------------------------------------------------------------
  const renderBody = () => {
    if (!canView) {
      return <EmptyState icon={ShieldCheck} title="Restricted" description="You need access to all jobs to view the live fleet map." />;
    }
    if (loading || profileLoading) {
      return (
        <div className="space-y-4">
          <SkeletonStatGrid count={6} />
          <div className="grid gap-4 md:grid-cols-[340px_1fr]">
            <SkeletonCardList count={4} />
            <Skeleton className="h-[480px] w-full rounded-xl" />
          </div>
        </div>
      );
    }
    if (loadError || !snapshot || !derived) {
      return (
        <EmptyState
          icon={TriangleAlert}
          title="Couldn't load the live map"
          description={loadError ?? 'No data was returned.'}
          action={{ label: 'Try again', onClick: () => { setLoading(true); void load(); } }}
        />
      );
    }
    if (snapshot.vehicles.length === 0) {
      return (
        <EmptyState
          icon={Truck}
          title="No vehicles yet"
          description="Add vehicles and connect a telematics provider to see your technicians live on the map."
          action={{ label: 'Connect telematics', onClick: () => navigate('/dashboard/telematics') }}
        />
      );
    }

    const { summary, views, unlocated } = derived;
    const noPositions = views.length === 0 && mapJobs.every((j) => j.latitude === null);

    return (
      <div className="space-y-4">
        {snapshot.warnings.length > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-border bg-bg-tertiary p-3 text-sm text-text-secondary">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{snapshot.warnings.join(' ')}</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
          <Stat label="On map" value={summary.located} />
          <Stat label="Moving" value={summary.moving} />
          <Stat label="Idle" value={summary.idle} />
          <Stat label="Offline" value={summary.offline} />
          <Stat label="Open jobs" value={summary.openJobs} />
          <Stat label="Late jobs" value={summary.lateJobs} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5" role="group" aria-label="Filter vehicles">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={`focus-ring min-h-[36px] rounded-full border px-3 text-sm font-medium ${
                  filter === f.value ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setFitSignal((n) => n + 1)} disabled={views.length === 0 && mapJobs.length === 0}>
            <Crosshair className="h-4 w-4" aria-hidden /> Fit all
          </Button>
          <div className="ml-auto flex gap-1.5 md:hidden" role="group" aria-label="Switch view">
            <Button variant={mobileTab === 'map' ? 'primary' : 'secondary'} size="sm" onClick={() => setMobileTab('map')}>
              <MapIcon className="h-4 w-4" aria-hidden /> Map
            </Button>
            <Button variant={mobileTab === 'list' ? 'primary' : 'secondary'} size="sm" onClick={() => setMobileTab('list')}>
              <List className="h-4 w-4" aria-hidden /> List
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[340px_1fr]">
          {/* ---- List column ---- */}
          <div className={`${mobileTab === 'list' ? 'block' : 'hidden'} max-h-[70vh] space-y-4 overflow-y-auto md:block md:max-h-[calc(100vh-22rem)]`}>
            <section aria-labelledby="techs-heading" className="space-y-2">
              <h2 id="techs-heading" className="text-sm font-semibold text-text-primary">Technicians ({shown.length})</h2>
              {shown.length === 0 ? (
                <EmptyState icon={MapPinOff} title="No vehicles match" description="Try a different filter, or wait for the next GPS fix." />
              ) : (
                <ul className="space-y-2">
                  {shown.map((v) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => selectVehicle(v.id)}
                        aria-pressed={v.id === selectedId}
                        className={`focus-ring w-full rounded-xl border p-3 text-left ${
                          v.id === selectedId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[v.state]}`} aria-hidden />
                            <span className="truncate text-sm font-semibold text-text-primary">{v.techName ?? v.label}</span>
                          </span>
                          <span className="shrink-0 text-xs text-text-secondary">{STATE_LABEL[v.state]}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-text-secondary">{v.techName ? `${v.label} · ` : ''}{etaLine(v)}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {unlocated.length > 0 && (
                <p className="text-xs text-text-secondary">
                  {unlocated.length} vehicle{unlocated.length === 1 ? ' has' : 's have'} no GPS fix yet: {unlocated.map((u) => u.label).join(', ')}.
                </p>
              )}
            </section>

            <section aria-labelledby="jobs-heading" className="space-y-2">
              <h2 id="jobs-heading" className="text-sm font-semibold text-text-primary">Open jobs ({mapJobs.length})</h2>
              {mapJobs.length === 0 ? (
                <EmptyState icon={MapPinOff} title="No open jobs" description="Jobs scheduled around now will appear here and on the map." />
              ) : (
                <ul className="space-y-2">
                  {mapJobs.slice(0, 50).map((j) => {
                    const late = isLateJob(j, nowMs);
                    return (
                      <li key={j.id} className="rounded-xl border border-border bg-bg-secondary p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium text-text-primary">{j.customer_name}</p>
                          <span className={`shrink-0 text-xs ${late ? 'text-danger' : 'text-text-secondary'}`}>{late ? 'Late' : j.job_status.replace('_', ' ')}</span>
                        </div>
                        <p className="truncate text-xs text-text-secondary">
                          {[j.service_type, j.address].filter(Boolean).join(' · ') || 'No details'}
                          {j.latitude === null ? ' · not on map (no coordinates)' : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          {/* ---- Map column (kept mounted so the map never reloads when switching tabs) ---- */}
          <div className={`${mobileTab === 'map' ? 'block' : 'hidden'} relative h-[65vh] min-h-[420px] overflow-hidden rounded-xl border border-border md:block md:h-[calc(100vh-22rem)]`}>
            {mapError ? (
              <div className="flex h-full items-center justify-center p-4">
                <EmptyState
                  icon={MapPinOff}
                  title="The map couldn't load"
                  description={mapError}
                  action={{ label: 'Retry', onClick: () => { setMapError(null); setMapKey((k) => k + 1); } }}
                />
              </div>
            ) : (
              <>
                <LiveMapCanvas
                  key={mapKey}
                  views={mapViews}
                  jobs={mapJobs}
                  trails={trails}
                  geofenceM={snapshot.geofenceM}
                  nowMs={nowMs}
                  selectedId={selectedId}
                  fitSignal={fitSignal}
                  onSelectVehicle={selectVehicle}
                  onError={setMapError}
                />
                <div className="pointer-events-none absolute left-3 top-3">
                  <LiveIndicator status={rtStatus} />
                </div>
                {noPositions && (
                  <div className="pointer-events-none absolute inset-x-3 top-12 rounded-xl border border-border bg-bg-secondary/95 p-3 text-sm text-text-secondary">
                    No GPS positions yet. Vehicles appear here as soon as your telematics provider reports a fix.{' '}
                    <Link to="/dashboard/telematics" className="pointer-events-auto text-accent underline">Check telematics</Link>
                  </div>
                )}
                {selected && (
                  <div className="absolute inset-x-3 bottom-3 rounded-xl border border-border bg-bg-secondary p-4 shadow-lg md:right-auto md:max-w-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-text-primary">{selected.techName ?? selected.label}</p>
                        <p className="text-xs text-text-secondary">{selected.label} · {STATE_LABEL[selected.state]} · fix {ageText(selected.ageMin)}</p>
                      </div>
                      <button type="button" onClick={() => setSelectedId(null)} aria-label="Close details" className="focus-ring rounded-lg px-2 text-text-secondary hover:text-text-primary">✕</button>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div><dt className="text-xs text-text-secondary">Speed</dt><dd className="text-text-primary">{selected.speedMph} mph</dd></div>
                      <div><dt className="text-xs text-text-secondary">Fuel</dt><dd className="text-text-primary">{selected.fuelPct === null ? '—' : `${Math.round(selected.fuelPct)}%`}</dd></div>
                      <div className="col-span-2"><dt className="text-xs text-text-secondary">Near</dt><dd className="truncate text-text-primary">{selected.reverseGeo ?? `${selected.point.lat.toFixed(4)}, ${selected.point.lng.toFixed(4)}`}</dd></div>
                      <div className="col-span-2"><dt className="text-xs text-text-secondary">Next stop</dt><dd className="text-text-primary">{selected.job ? `${selected.job.customer_name} — ${etaLine(selected)}` : 'No job assigned'}</dd></div>
                    </dl>
                    {selected.checkEngine && <p className="mt-2 text-xs text-danger">Check-engine light is on.</p>}
                    <p className="mt-2 text-[11px] text-text-secondary">ETA is an estimate from straight-line distance, not live traffic.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <DashboardLayout activeLabel="Live Map">
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <div className="flex items-center gap-2">
          <Satellite className="h-6 w-6 text-accent" aria-hidden />
          <h1 className="text-2xl font-bold text-text-primary">Live Map</h1>
        </div>
        {renderBody()}
      </div>
    </DashboardLayout>
  );
}
