import { Suspense, lazy, useMemo, useState } from 'react';
import { DoorOpen, MapPinOff, Plus, Search, Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import {
  DEFAULT_FILTERS,
  STATUS_ORDER,
  countByStatus,
  coverage,
  filterDoors,
  formatAddress,
  formatDistance,
  hasPoint,
  relativeTime,
  sortByDistance,
  statusLabel,
  type Door,
  type DoorFilters,
  type DoorStatus,
  type Territory,
} from '@/lib/canvassing';
import type { AddDoorsSummary } from '@/lib/canvassingApi';
import { AddDoorsDialog } from './AddDoorsDialog';
import { KpiTile, StatusBadge, TerritoryDot, compactSelectCls } from './canvassUi';

const CanvassMap = lazy(() => import('./CanvassMap'));

const LIST_PAGE = 100;

interface DoorsPanelProps {
  isManager: boolean;
  territories: Territory[];
  doors: Door[];
  truncated: boolean;
  activeDoorId: string | null;
  onOpenDoor: (id: string) => void;
  onReload: () => Promise<void>;
}

export function DoorsPanel({ isManager, territories, doors, truncated, activeDoorId, onOpenDoor, onReload }: DoorsPanelProps) {
  const [filters, setFilters] = useState<DoorFilters>(DEFAULT_FILTERS);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [fitSignal, setFitSignal] = useState(0);
  const [mapError, setMapError] = useState<string | null>(null);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [nearest, setNearest] = useState(false);
  const [visible, setVisible] = useState(LIST_PAGE);

  const [addOpen, setAddOpen] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);

  const activeTerritories = useMemo(() => territories.filter((t) => t.status === 'active'), [territories]);
  const territoryById = useMemo(() => new Map(territories.map((t) => [t.id, t])), [territories]);
  const filtered = useMemo(() => filterDoors(doors, filters), [doors, filters]);
  const counts = useMemo(() => countByStatus(filterDoors(doors, { ...filters, statuses: [] })), [doors, filters]);
  const cov = useMemo(() => coverage(filterDoors(doors, { ...filters, statuses: [] })), [doors, filters]);

  const rows = useMemo(() => {
    if (nearest && here) return sortByDistance(filtered, here);
    return filtered.map((door) => ({ door, km: null as number | null }));
  }, [filtered, nearest, here]);

  const patchFilters = (p: Partial<DoorFilters>) => { setFilters((f) => ({ ...f, ...p })); setVisible(LIST_PAGE); };
  const toggleStatus = (s: DoorStatus) =>
    patchFilters({ statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s] });
  const filtersActive = filters.territory !== 'all' || filters.statuses.length > 0 || filters.query.trim() !== '';
  const pinned = filtered.filter(hasPoint).length;

  const startPick = () => { setAddOpen(false); setPickMode(true); setView('map'); };
  const handlePick = (p: { lat: number; lng: number }) => { setPoint(p); setPickMode(false); setAddOpen(true); };
  const cancelPick = () => { setPickMode(false); setAddOpen(true); };

  const handleAdded = (summary: AddDoorsSummary, single: boolean) => {
    setAddOpen(false);
    setPoint(null);
    void onReload().then(() => {
      if (single && summary.doorIds.length === 1) onOpenDoor(summary.doorIds[0]);
      else setFitSignal((n) => n + 1);
    });
  };

  const defaultTerritory = filters.territory !== 'all' && filters.territory !== 'none' ? filters.territory : null;

  if (doors.length === 0) {
    return (
      <>
        <EmptyState
          icon={DoorOpen}
          title={isManager ? 'No doors on the map yet' : 'No doors in your territory yet'}
          description={isManager
            ? 'Import a list of addresses or add doors one by one, then assign territories to your reps.'
            : activeTerritories.length === 0
              ? 'Your manager has not assigned you a territory yet.'
              : 'Add the first door in your territory, or ask your manager to import a list.'}
          action={isManager || activeTerritories.length > 0 ? { label: 'Add doors', onClick: () => setAddOpen(true) } : undefined}
        />
        <AddDoorsDialog open={addOpen} isManager={isManager} territories={activeTerritories} defaultTerritoryId={null} point={point} onPointChange={setPoint}
          onRequestPick={startPick} onClose={() => setAddOpen(false)} onAdded={handleAdded} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="Doors" value={cov.total.toLocaleString()} sub={filtersActive ? 'in this view' : 'on the map'} />
        <KpiTile label="Knocked" value={`${cov.pct}%`} sub={`${cov.knocked.toLocaleString()} of ${cov.total.toLocaleString()}`} />
        <KpiTile label="Appointments" value={String(counts.appointment_set)} sub="booked at the door" />
        <KpiTile label="Sold" value={String(counts.sold)} sub="signed at the door" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[10rem] flex-1">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input type="search" aria-label="Search doors" placeholder="Search address or name" value={filters.query} onChange={(e) => patchFilters({ query: e.target.value })}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent" />
        </div>
        <select aria-label="Filter by territory" value={filters.territory} onChange={(e) => patchFilters({ territory: e.target.value })} className={compactSelectCls}>
          <option value="all">All territories</option>
          {isManager && <option value="none">Unassigned</option>}
          {territories.map((t) => <option key={t.id} value={t.id}>{t.name}{t.status === 'archived' ? ' (archived)' : ''}</option>)}
        </select>
        <Button type="button" size="sm" onClick={() => setAddOpen(true)}><Plus size={16} aria-hidden="true" />Add doors</Button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by outcome">
        {STATUS_ORDER.map((s) => {
          const on = filters.statuses.includes(s);
          return (
            <button key={s} type="button" aria-pressed={on} onClick={() => toggleStatus(s)}
              className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent bg-accent/10 text-text-primary' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'}`}>
              <StatusBadge status={s} className="!text-inherit" />
              <span className="tabular-nums text-text-secondary">{counts[s]}</span>
            </button>
          );
        })}
        {filtersActive && (
          <button type="button" onClick={() => { setFilters(DEFAULT_FILTERS); setVisible(LIST_PAGE); }} className="focus-ring rounded-full px-3 py-1.5 text-xs font-medium text-accent hover:underline">Clear filters</button>
        )}
      </div>

      {truncated && <p role="status" className="rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-xs text-text-secondary">Showing the first 10,000 doors. Filter by territory to see the rest.</p>}

      <div role="tablist" aria-label="Map or list" className="flex gap-1 rounded-xl border border-border bg-bg-secondary p-1 lg:hidden">
        {(['map', 'list'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
            className={`focus-ring flex-1 rounded-lg px-3 py-2 text-sm font-medium ${view === v ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
            {v === 'map' ? 'Map' : `List (${filtered.length.toLocaleString()})`}
          </button>
        ))}
      </div>

      {pickMode && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-text-primary">
          <span>Tap the map where the door is.</span>
          <Button type="button" variant="secondary" size="sm" onClick={cancelPick}>Cancel</Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className={`${view === 'map' ? 'block' : 'hidden'} lg:block`}>
          <div className="relative h-[60dvh] min-h-[320px] overflow-hidden rounded-2xl border border-border bg-bg-secondary lg:h-[640px]">
            {mapError ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <MapPinOff size={28} className="text-text-secondary" aria-hidden="true" />
                <p className="text-sm font-medium text-text-primary">The map is unavailable</p>
                <p className="max-w-xs text-xs text-text-secondary">{mapError} The list still works — you can log every visit from it.</p>
                <Button type="button" variant="secondary" size="sm" onClick={() => { setMapError(null); setView('list'); }}>Use the list</Button>
              </div>
            ) : (
              <Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
                <CanvassMap doors={filtered} selectedId={activeDoorId} fitSignal={fitSignal} pickMode={pickMode} pickedPoint={point}
                  onSelect={(id) => { if (id) onOpenDoor(id); }} onPick={handlePick} onLocate={setHere} onError={setMapError} />
              </Suspense>
            )}
            {!mapError && (
              <button type="button" onClick={() => setFitSignal((n) => n + 1)} className="focus-ring absolute bottom-3 left-3 rounded-lg border border-border bg-bg-secondary/95 px-3 py-1.5 text-xs font-medium text-text-primary shadow-sm hover:bg-bg-tertiary">
                Fit all ({pinned.toLocaleString()})
              </button>
            )}
          </div>
        </div>

        <div className={`${view === 'list' ? 'block' : 'hidden'} lg:block`}>
          <div className="flex h-[60dvh] min-h-[320px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary lg:h-[640px]">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-text-primary">Doors <span className="font-normal text-text-secondary">({filtered.length.toLocaleString()})</span></h3>
              <Button type="button" variant={nearest ? 'primary' : 'secondary'} size="sm" aria-pressed={nearest}
                onClick={() => {
                  if (nearest) { setNearest(false); return; }
                  if (here) { setNearest(true); return; }
                  if (!('geolocation' in navigator)) return;
                  navigator.geolocation.getCurrentPosition((p) => { setHere({ lat: p.coords.latitude, lng: p.coords.longitude }); setNearest(true); }, () => undefined, { enableHighAccuracy: true, timeout: 15_000 });
                }}>
                <Crosshair size={14} aria-hidden="true" />Nearest first
              </Button>
            </div>
            {filtered.length === 0 ? (
              <div className="p-4"><EmptyState icon={Search} title="No doors match" description="Try a different search or clear the filters." action={{ label: 'Clear filters', onClick: () => setFilters(DEFAULT_FILTERS) }} /></div>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
                {rows.slice(0, visible).map(({ door, km }) => {
                  const t = door.territory_id ? territoryById.get(door.territory_id) : undefined;
                  return (
                    <li key={door.id}>
                      <button type="button" onClick={() => onOpenDoor(door.id)} aria-current={door.id === activeDoorId ? 'true' : undefined}
                        className={`focus-ring flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-bg-tertiary ${door.id === activeDoorId ? 'bg-accent/10' : ''}`}>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-text-primary">{formatAddress(door)}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                            <StatusBadge status={door.status} />
                            {t && <span className="inline-flex items-center gap-1.5"><TerritoryDot color={t.color} />{t.name}</span>}
                            {!hasPoint(door) && <span>No pin</span>}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-xs text-text-secondary">
                          {km !== null && <span className="block font-medium text-text-primary">{formatDistance(km)}</span>}
                          {door.last_visit_at ? relativeTime(door.last_visit_at, new Date()) : statusLabel('new')}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {rows.length > visible && (
                  <li className="p-3 text-center">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setVisible((v) => v + LIST_PAGE)}>Show more ({(rows.length - visible).toLocaleString()} left)</Button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>

      <AddDoorsDialog open={addOpen} isManager={isManager} territories={activeTerritories} defaultTerritoryId={defaultTerritory} point={point} onPointChange={setPoint}
        onRequestPick={startPick} onClose={() => setAddOpen(false)} onAdded={handleAdded} />
      <span className="sr-only" aria-live="polite">{filtered.length} doors shown</span>
    </div>
  );
}
