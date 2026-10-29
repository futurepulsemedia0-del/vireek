/**
 * Local Rank Grid — /dashboard/geo-grid
 *
 * Where does the business appear in Google Maps for a keyword, from a grid of points around it? Track keywords
 * per location, scan on demand or on a schedule, compare scans over time. Scanning runs in the geo-grid-scan
 * edge function; rules + security live in supabase/migrations/20280105000000_geo_grid_rank_tracking.sql and the
 * shared engine in supabase/functions/_shared/geo-grid/engine.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink, Loader2, Lock, MapPin, Minus, Pencil, Play, Plus, Radar, RefreshCw, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { GridLegend, GridMap, TrendBars } from '@/components/geogrid/GridMap';
import { KeywordForm, LocationForm } from '@/components/geogrid/GeoGridForms';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DEFAULT_FILTERS,
  SCAN_STATUS_LABELS,
  SCHEDULE_LABELS,
  activeOnly,
  compareScans,
  describeGrid,
  filterKeywords,
  googleMapsUrl,
  isScanActive,
  latestScanByKeyword,
  pointLabel,
  relativeTime,
  sortScans,
  summarizeOverview,
  trendSeries,
  type GeoGridKeyword,
  type GeoGridLocation,
  type GeoGridPoint,
  type GeoGridScan,
  type KeywordFilters,
  type ProviderStatus,
  type TrendDelta,
} from '@/lib/geoGrid';
import {
  describeGeoGridError,
  fetchKeywordScans,
  fetchKeywords,
  fetchLocations,
  fetchProviderStatus,
  fetchRecentScans,
  fetchScanPoints,
  runGeoGridScan,
  setKeywordArchived,
  setLocationArchived,
} from '@/lib/geoGridApi';

const SELECT_CLASS =
  'focus-ring min-h-[40px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary transition-colors focus-visible:border-accent';
const POLL_MS = 5000;

type Mode = { type: 'new-location' } | { type: 'new-keyword' } | { type: 'edit-keyword' } | null;

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function DeltaBadge({ delta }: { delta: TrendDelta }) {
  if (delta.direction === 'none' || delta.solv === null) return null;
  const Icon = delta.direction === 'up' ? TrendingUp : delta.direction === 'down' ? TrendingDown : Minus;
  const tone = delta.direction === 'up' ? 'text-success' : delta.direction === 'down' ? 'text-danger' : 'text-text-secondary';
  const sign = delta.solv > 0 ? '+' : '';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {sign}
      {delta.solv} pts<span className="sr-only"> share of local voice versus the previous scan</span>
    </span>
  );
}

export function GeoGridPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = isOwner || permissions.can_edit_business_profile;
  const selectedId = params.get('keyword');

  const [locations, setLocations] = useState<GeoGridLocation[] | null>(null);
  const [keywords, setKeywords] = useState<GeoGridKeyword[]>([]);
  const [scans, setScans] = useState<GeoGridScan[]>([]);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [filters, setFilters] = useState<KeywordFilters>(DEFAULT_FILTERS);
  const [showArchived, setShowArchived] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [history, setHistory] = useState<{ keywordId: string; scans: GeoGridScan[] } | null>(null);
  const [pickedScanId, setPickedScanId] = useState<string | null>(null);
  const [points, setPoints] = useState<{ scanId: string; rows: GeoGridPoint[] } | null>(null);
  const [pointsError, setPointsError] = useState(false);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const loadSeq = useRef(0);
  const pointsSeq = useRef(0);

  // ---------------------------------------------------------------- loading
  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    const seq = ++loadSeq.current;
    setLoadError(false);
    const [locs, kws, recent, provider] = await Promise.allSettled([
      fetchLocations(accountOwnerId),
      fetchKeywords(accountOwnerId),
      fetchRecentScans(accountOwnerId),
      fetchProviderStatus(),
    ]);
    if (seq !== loadSeq.current) return;
    if (locs.status === 'fulfilled' && kws.status === 'fulfilled') {
      setLocations(locs.value);
      setKeywords(kws.value);
    } else {
      setLocations((prev) => prev ?? []);
      setLoadError(true);
    }
    if (recent.status === 'fulfilled') setScans(recent.value);
    if (provider.status === 'fulfilled') {
      setStatus(provider.value);
      setStatusFailed(false);
    } else {
      setStatusFailed(true);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshScans = useCallback(async () => {
    if (!accountOwnerId) return;
    try {
      const [recent, kws] = await Promise.all([fetchRecentScans(accountOwnerId), fetchKeywords(accountOwnerId)]);
      setScans(recent);
      setKeywords(kws);
    } catch {
      /* a failed background refresh is not worth interrupting the person */
    }
  }, [accountOwnerId]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await fetchProviderStatus());
      setStatusFailed(false);
    } catch {
      /* keep the last known budget */
    }
  }, []);

  // Poll while any scan is in flight (started here, by the schedule, or by a teammate).
  const anyActive = useMemo(() => scans.some((s) => isScanActive(s)), [scans]);
  useEffect(() => {
    if (!anyActive) return;
    const t = window.setInterval(() => void refreshScans(), POLL_MS);
    return () => window.clearInterval(t);
  }, [anyActive, refreshScans]);

  // ---------------------------------------------------------------- derived
  const locationById = useMemo(() => new Map((locations ?? []).map((l) => [l.id, l])), [locations]);
  const activeLocations = useMemo(() => activeOnly(locations ?? []), [locations]);
  const latestByKeyword = useMemo(() => latestScanByKeyword(scans), [scans]);
  const visibleKeywords = useMemo(() => {
    const base = showArchived ? keywords : activeOnly(keywords);
    return filterKeywords(base, filters);
  }, [keywords, filters, showArchived]);
  const activeKeywords = useMemo(() => activeOnly(keywords), [keywords]);
  const overview = useMemo(() => summarizeOverview(activeKeywords, scans), [activeKeywords, scans]);
  const selected = useMemo(() => keywords.find((k) => k.id === selectedId) ?? null, [keywords, selectedId]);
  const selectedLocation = selected ? locationById.get(selected.location_id) ?? null : null;
  const providerReady = status?.configured === true;

  const selectedScans = useMemo(() => {
    if (!selected) return [];
    if (history && history.keywordId === selected.id) return sortScans(history.scans);
    return sortScans(scans.filter((s) => s.keyword_id === selected.id));
  }, [selected, history, scans]);
  const latestScan = selectedScans[0];
  const latestCompleted = selectedScans.find((s) => s.status === 'completed');
  const shownScan =
    selectedScans.find((s) => s.id === pickedScanId) ?? (latestScan?.status === 'running' ? latestCompleted ?? latestScan : latestScan);
  const shownCompleted = shownScan && shownScan.status === 'completed' ? shownScan : null;
  const previousCompleted = shownCompleted
    ? selectedScans.find((s) => s.status === 'completed' && Date.parse(s.started_at) < Date.parse(shownCompleted.started_at))
    : undefined;
  const delta = compareScans(shownCompleted ?? undefined, previousCompleted);
  const trend = useMemo(() => trendSeries(selectedScans), [selectedScans]);
  const selectedRunning = !!selected && (running.has(selected.id) || isScanActive(latestScan));
  const selectedPoint = points && points.scanId === shownCompleted?.id ? points.rows.find((p) => p.id === selectedPointId) ?? null : null;
  const panelOpen = mode !== null || selectedId !== null;

  // Per-keyword history (the account-wide list only holds the newest scans).
  const latestKey = latestScan ? `${latestScan.id}:${latestScan.status}` : '';
  useEffect(() => {
    if (!accountOwnerId || !selectedId) return;
    let cancelled = false;
    fetchKeywordScans(accountOwnerId, selectedId)
      .then((rows) => {
        if (!cancelled) setHistory({ keywordId: selectedId, scans: rows });
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountOwnerId, selectedId, latestKey]);

  // Points of the scan on screen.
  const shownCompletedId = shownCompleted?.id ?? null;
  const loadPoints = useCallback(async () => {
    if (!accountOwnerId || !shownCompletedId) return;
    const seq = ++pointsSeq.current;
    setPointsError(false);
    try {
      const rows = await fetchScanPoints(accountOwnerId, shownCompletedId);
      if (seq === pointsSeq.current) setPoints({ scanId: shownCompletedId, rows });
    } catch {
      if (seq === pointsSeq.current) setPointsError(true);
    }
  }, [accountOwnerId, shownCompletedId]);

  useEffect(() => {
    setSelectedPointId(null);
    void loadPoints();
  }, [loadPoints]);

  // ---------------------------------------------------------------- navigation
  const confirmDiscard = () => !dirtyRef.current || window.confirm('You have unsaved changes. Discard them?');
  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const setSelectedParam = (id: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('keyword', id);
      else next.delete('keyword');
      return next;
    });

  const selectKeyword = (id: string) => {
    if (id === selectedId && !mode) return;
    if (!confirmDiscard()) return;
    setMode(null);
    setPickedScanId(null);
    setPoints(null);
    setHistory(null);
    setSelectedParam(id);
  };

  const closePanel = () => {
    if (!confirmDiscard()) return;
    setMode(null);
    setSelectedParam(null);
  };

  const openMode = (next: Mode) => {
    if (!confirmDiscard()) return;
    setSelectedParam(null);
    setMode(next);
  };

  // ---------------------------------------------------------------- actions
  const runScan = async (k: GeoGridKeyword) => {
    if (running.has(k.id)) return;
    setRunning((prev) => new Set(prev).add(k.id));
    try {
      const scan = await runGeoGridScan(k.id);
      if (scan.status === 'failed') toast(scan.error ?? 'The scan failed. Please try again.', 'error');
      else if (scan.error) toast(`Scan finished. ${scan.error}`, 'info');
      else toast(`Scan finished for "${k.keyword}"`, 'success');
      setPickedScanId(scan.id);
    } catch (e) {
      toast(describeGeoGridError(e), 'error');
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(k.id);
        return next;
      });
      void refreshScans();
      void refreshStatus();
    }
  };

  const archiveKeyword = async (k: GeoGridKeyword, archived: boolean) => {
    if (!accountOwnerId) return;
    if (archived && !window.confirm(`Stop tracking "${k.keyword}"? Past scans are kept and you can restore it later.`)) return;
    try {
      const saved = await setKeywordArchived(k.id, accountOwnerId, k.updated_at, archived);
      setKeywords((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
      toast(archived ? 'Keyword archived' : 'Keyword restored', 'success');
    } catch (e) {
      toast(describeGeoGridError(e), 'error');
    }
  };

  const archiveLocation = async (l: GeoGridLocation, archived: boolean) => {
    if (!accountOwnerId) return;
    if (archived && !window.confirm(`Archive "${l.name}"? Its keywords are archived too and scheduled scans stop.`)) return;
    try {
      await setLocationArchived(l.id, accountOwnerId, l.updated_at, archived);
      await load();
      toast(archived ? 'Location archived' : 'Location restored', 'success');
    } catch (e) {
      toast(describeGeoGridError(e), 'error');
    }
  };

  const retry = () => {
    setLocations(null);
    void load();
  };

  // ---------------------------------------------------------------- render
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Local Rank Grid">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Local rank tracking is restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const noLocations = locations !== null && activeLocations.length === 0;
  const budgetValue = status ? (status.monthly_limit > 0 ? `${status.used_points} / ${status.monthly_limit}` : `${status.used_points}`) : '—';

  return (
    <DashboardLayout activeLabel="Local Rank Grid">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Radar size={22} className="text-accent" aria-hidden="true" /> Local Rank Grid
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
              See where your business shows up in Google Maps for each keyword, from a grid of points around it, and watch it improve scan after scan.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => openMode({ type: 'new-location' })}>
              <MapPin size={16} aria-hidden="true" /> Add location
            </Button>
            <Button size="sm" disabled={noLocations || locations === null} onClick={() => openMode({ type: 'new-keyword' })}>
              <Plus size={16} aria-hidden="true" /> Track keyword
            </Button>
          </div>
        </div>

        {statusFailed && status === null && (
          <div role="alert" className="mb-4 flex flex-col gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500 sm:flex-row sm:items-center sm:justify-between">
            <span>We couldn't reach the scanning service, so new scans are paused.</span>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </Button>
          </div>
        )}
        {status && !status.configured && (
          <div role="status" className="mb-4 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-warning-500">
            Scanning isn't set up yet. An administrator needs to add a Google Places API key (GOOGLE_PLACES_API_KEY) to the scanning function. You can still view saved results.
          </div>
        )}

        {locations === null ? (
          <div className="mb-6">
            <SkeletonStatGrid count={4} />
          </div>
        ) : (
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Tracked keywords" value={String(overview.keywords)} hint={`${overview.scanned} scanned`} />
            <StatTile label="Avg share of local voice" value={overview.avgSolv === null ? '—' : `${overview.avgSolv}%`} hint="Spots in the top 3" />
            <StatTile label="Avg rank where you appear" value={overview.avgRank === null ? '—' : `#${overview.avgRank}`} />
            <StatTile label="Scan points this month" value={budgetValue} hint={status && status.monthly_limit > 0 ? 'Resets on the 1st' : undefined} />
          </div>
        )}

        {locations !== null && locations.length > 0 && (
          <section aria-label="Locations" className="mb-6 flex flex-wrap items-center gap-2">
            {(showArchived ? locations : activeLocations).map((l) => (
              <span
                key={l.id}
                className={`inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 text-sm ${l.archived_at ? 'opacity-60' : ''}`}
              >
                <MapPin size={14} className="text-text-secondary" aria-hidden="true" />
                <span className="max-w-[200px] truncate font-medium text-text-primary">{l.name}</span>
                <button
                  type="button"
                  className="focus-ring rounded-lg px-1.5 py-1 text-xs font-semibold text-text-secondary hover:text-text-primary"
                  onClick={() => void archiveLocation(l, !l.archived_at)}
                >
                  {l.archived_at ? 'Restore' : 'Archive'}
                </button>
              </span>
            ))}
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          {/* ------------------------------------------------ list */}
          <div className={panelOpen ? 'hidden lg:block' : ''}>
            <div className="mb-3 space-y-3">
              <Input
                icon={Search}
                aria-label="Search keywords"
                placeholder="Search keywords"
                value={filters.query}
                onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              />
              <div className="flex flex-wrap items-center gap-3">
                {activeLocations.length > 1 && (
                  <select
                    aria-label="Filter by location"
                    className={SELECT_CLASS}
                    value={filters.locationId}
                    onChange={(e) => setFilters((f) => ({ ...f, locationId: e.target.value }))}
                  >
                    <option value="all">All locations</option>
                    {activeLocations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                )}
                <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    className="focus-ring h-4 w-4 accent-accent"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.target.checked)}
                  />
                  Show archived
                </label>
              </div>
            </div>

            {locations === null ? (
              <SkeletonCardList count={4} />
            ) : loadError && keywords.length === 0 && locations.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="We couldn't load your rankings"
                description="Check your connection and try again."
                action={{ label: 'Try again', onClick: retry }}
              />
            ) : noLocations && keywords.length === 0 ? (
              <EmptyState
                icon={MapPin}
                title="Add your first location"
                description="Find your business on Google Maps, then choose the keywords you want to rank for."
                action={{ label: 'Add location', onClick: () => openMode({ type: 'new-location' }) }}
              />
            ) : keywords.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="Track your first keyword"
                description="Pick a phrase customers search for, like “emergency plumber”, and we'll map where you rank around your business."
                action={{ label: 'Track keyword', onClick: () => openMode({ type: 'new-keyword' }) }}
              />
            ) : visibleKeywords.length === 0 ? (
              <EmptyState
                icon={Search}
                title="Nothing matches these filters"
                description="Try a different search or clear the filters."
                action={{ label: 'Clear filters', onClick: () => setFilters(DEFAULT_FILTERS) }}
              />
            ) : (
              <ul className="space-y-2.5" aria-label="Tracked keywords">
                {visibleKeywords.map((k) => {
                  const latest = latestByKeyword.get(k.id);
                  const active = !mode && k.id === selectedId;
                  const busy = running.has(k.id) || isScanActive(latest);
                  return (
                    <li key={k.id}>
                      <button
                        type="button"
                        onClick={() => selectKeyword(k.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`focus-ring w-full rounded-2xl border p-4 text-left transition-colors ${
                          active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                        } ${k.archived_at ? 'opacity-70' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 truncate font-semibold text-text-primary">{k.keyword}</p>
                          {busy ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent">
                              <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Scanning
                            </span>
                          ) : latest?.status === 'completed' && latest.solv !== null ? (
                            <span className="shrink-0 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">{latest.solv}% top 3</span>
                          ) : null}
                        </div>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                          <MapPin size={12} aria-hidden="true" /> {locationById.get(k.location_id)?.name ?? 'Unknown location'}
                          {k.archived_at ? ' · Archived' : ''}
                        </p>
                        <p className="mt-2 text-[11px] text-text-secondary">
                          {describeGrid(k.grid_size, k.radius_m)} · {SCHEDULE_LABELS[k.schedule]}
                          {k.last_scan_at ? ` · scanned ${relativeTime(k.last_scan_at)}` : ' · not scanned yet'}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ------------------------------------------------ detail */}
          <div className={panelOpen ? '' : 'hidden lg:block'}>
            {panelOpen && (
              <button
                type="button"
                onClick={closePanel}
                className="focus-ring mb-3 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-text-secondary hover:text-text-primary lg:hidden"
              >
                <ArrowLeft size={16} aria-hidden="true" /> All keywords
              </button>
            )}

            {!accountOwnerId || locations === null ? (
              panelOpen ? <SkeletonCardList count={2} /> : null
            ) : mode?.type === 'new-location' ? (
              <LocationForm
                accountOwnerId={accountOwnerId}
                defaultQuery={profile?.company_name ?? ''}
                providerReady={providerReady}
                onSaved={(loc) => {
                  setLocations((prev) => [...(prev ?? []), loc]);
                  setMode(null);
                  if (activeKeywords.length === 0) setMode({ type: 'new-keyword' });
                }}
                onCancel={() => setMode(null)}
              />
            ) : mode?.type === 'new-keyword' || mode?.type === 'edit-keyword' ? (
              <KeywordForm
                key={mode.type === 'edit-keyword' && selected ? selected.id : 'new'}
                accountOwnerId={accountOwnerId}
                locations={activeLocations}
                keywords={keywords}
                editing={mode.type === 'edit-keyword' ? selected : null}
                defaultLocationId={filters.locationId !== 'all' ? filters.locationId : ''}
                onDirtyChange={onDirtyChange}
                onCancel={() => {
                  setMode(null);
                }}
                onSaved={(saved, created) => {
                  setKeywords((prev) => (created ? [...prev, saved] : prev.map((x) => (x.id === saved.id ? saved : x))));
                  setMode(null);
                  setSelectedParam(saved.id);
                }}
              />
            ) : selected ? (
              <div className="space-y-4">
                <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="break-words text-xl font-bold text-text-primary">{selected.keyword}</h2>
                      <p className="mt-1 text-sm text-text-secondary">
                        {selectedLocation?.name ?? 'Unknown location'} · {describeGrid(selected.grid_size, selected.radius_m)}
                      </p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {SCHEDULE_LABELS[selected.schedule]}
                        {selected.next_run_at && !selected.archived_at ? ` · next scan ${relativeTime(selected.next_run_at)}` : ''}
                        {selected.archived_at ? ' · Archived' : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selected.archived_at ? (
                        <Button variant="secondary" size="sm" onClick={() => void archiveKeyword(selected, false)}>
                          Restore
                        </Button>
                      ) : (
                        <>
                          <Button size="sm" disabled={selectedRunning || !providerReady} onClick={() => void runScan(selected)}>
                            {selectedRunning ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                            {selectedRunning ? 'Scanning…' : latestScan ? 'Scan again' : 'Run first scan'}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setMode({ type: 'edit-keyword' })}>
                            <Pencil size={14} aria-hidden="true" /> Edit
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void archiveKeyword(selected, true)}>
                            Archive
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {!providerReady && !selected.archived_at && (
                    <p className="mt-3 text-xs text-text-secondary">Scanning is unavailable until the Google Places key is configured.</p>
                  )}
                </section>

                {selectedScans.length === 0 ? (
                  <EmptyState
                    icon={Radar}
                    title="No scans yet"
                    description="Run a scan to see where you rank from every point of the grid."
                    action={selected.archived_at || !providerReady ? undefined : { label: 'Run first scan', onClick: () => void runScan(selected) }}
                  />
                ) : selectedRunning ? (
                  <section aria-live="polite" className="rounded-2xl border border-border bg-bg-secondary p-6 text-center">
                    <Loader2 size={28} className="mx-auto animate-spin text-accent" aria-hidden="true" />
                    <p className="mt-3 font-semibold text-text-primary">Scanning {selected.grid_size * selected.grid_size} points…</p>
                    <p className="mt-1 text-sm text-text-secondary">This usually takes 5–30 seconds. You can leave this page; the result will be here when you return.</p>
                    {latestCompleted && <p className="mt-3 text-xs text-text-secondary">Showing the previous result below until it finishes.</p>}
                  </section>
                ) : shownScan?.status === 'failed' ? (
                  <section role="alert" className="rounded-2xl border border-danger/40 bg-danger/5 p-5">
                    <p className="flex items-center gap-2 font-semibold text-danger">
                      <AlertTriangle size={18} aria-hidden="true" /> The last scan failed
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">{shownScan.error ?? 'Something went wrong while scanning.'}</p>
                    {!selected.archived_at && providerReady && (
                      <Button variant="secondary" size="sm" className="mt-3" disabled={selectedRunning} onClick={() => void runScan(selected)}>
                        <RefreshCw size={14} aria-hidden="true" /> Try again
                      </Button>
                    )}
                  </section>
                ) : null}

                {shownCompleted && (
                  <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6" aria-label="Scan result">
                    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Share of local voice</p>
                        <p className="text-2xl font-bold text-text-primary">{shownCompleted.solv === null ? '—' : `${shownCompleted.solv}%`}</p>
                        <DeltaBadge delta={delta} />
                      </div>
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Average rank</p>
                        <p className="text-2xl font-bold text-text-primary">{shownCompleted.avg_rank === null ? '—' : `#${shownCompleted.avg_rank}`}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Visible at</p>
                        <p className="text-2xl font-bold text-text-primary">
                          {shownCompleted.ranked_count}
                          <span className="text-base font-medium text-text-secondary"> / {shownCompleted.checked_count}</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Top 3 spots</p>
                        <p className="text-2xl font-bold text-text-primary">{shownCompleted.top3_count}</p>
                      </div>
                    </div>

                    {shownCompleted.error && <p className="mb-3 text-xs text-warning-500">{shownCompleted.error}</p>}

                    {points && points.scanId === shownCompleted.id ? (
                      <div className="space-y-4">
                        <GridMap points={points.rows} size={shownCompleted.grid_size} selectedId={selectedPointId} onSelect={(p) => setSelectedPointId(p.id)} />
                        <GridLegend points={points.rows} />
                        <p className="text-center text-[11px] text-text-secondary">North is up. The ringed circle is your business location.</p>
                        {selectedPoint ? (
                          <div className="rounded-xl border border-border bg-bg-primary p-4" aria-live="polite">
                            <p className="font-semibold text-text-primary">{pointLabel(selectedPoint)}</p>
                            {selectedPoint.competitors.length > 0 && (
                              <div className="mt-2">
                                <p className="text-xs text-text-secondary">Ahead of or next to you here:</p>
                                <ol className="mt-1 space-y-0.5 text-sm text-text-primary">
                                  {selectedPoint.competitors.map((c) => (
                                    <li key={`${c.r}-${c.n}`}>
                                      <span className="mr-1.5 text-text-secondary">#{c.r}</span>
                                      {c.n}
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            )}
                            <a
                              href={googleMapsUrl(selectedPoint.latitude, selectedPoint.longitude)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="focus-ring mt-3 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg text-sm font-semibold text-accent"
                            >
                              Open this spot in Google Maps <ExternalLink size={14} aria-hidden="true" />
                            </a>
                          </div>
                        ) : (
                          <p className="text-center text-sm text-text-secondary">Select a circle to see who ranks there.</p>
                        )}
                      </div>
                    ) : pointsError ? (
                      <EmptyState
                        icon={AlertTriangle}
                        title="We couldn't load this grid"
                        description="Check your connection and try again."
                        action={{ label: 'Try again', onClick: () => void loadPoints() }}
                      />
                    ) : (
                      <SkeletonCardList count={1} rows={4} />
                    )}
                  </section>
                )}

                {trend.length >= 2 && (
                  <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6">
                    <TrendBars series={trend} />
                  </section>
                )}

                {selectedScans.length > 0 && (
                  <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6" aria-label="Scan history">
                    <h3 className="mb-3 text-sm font-semibold text-text-primary">Scan history</h3>
                    <ul className="space-y-2">
                      {selectedScans.slice(0, 20).map((s) => {
                        const active = s.id === shownScan?.id;
                        return (
                          <li key={s.id}>
                            <button
                              type="button"
                              onClick={() => setPickedScanId(s.id)}
                              aria-current={active ? 'true' : undefined}
                              className={`focus-ring flex min-h-[44px] w-full items-center justify-between gap-3 rounded-xl border px-3 text-left text-sm transition-colors ${
                                active ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/40'
                              }`}
                            >
                              <span className="text-text-primary">
                                {new Date(s.started_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                                {s.triggered_by === 'schedule' && <span className="ml-2 text-xs text-text-secondary">scheduled</span>}
                              </span>
                              <span className={`shrink-0 text-xs font-semibold ${s.status === 'failed' ? 'text-danger' : s.status === 'running' ? 'text-accent' : 'text-text-secondary'}`}>
                                {s.status === 'completed' && s.solv !== null ? `${s.solv}% top 3` : SCAN_STATUS_LABELS[s.status]}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>
            ) : selectedId ? (
              <EmptyState
                icon={AlertTriangle}
                title="That keyword isn't available"
                description="It may have been removed or belongs to another account."
                action={{ label: 'Back to keywords', onClick: closePanel }}
              />
            ) : (
              <EmptyState
                icon={Radar}
                title="Select a keyword"
                description="Choose one from the list to see its rank grid, or start tracking a new keyword."
                action={noLocations ? { label: 'Add location', onClick: () => openMode({ type: 'new-location' }) } : { label: 'Track keyword', onClick: () => openMode({ type: 'new-keyword' }) }}
              />
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
