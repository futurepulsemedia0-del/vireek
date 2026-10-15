/**
 * Locations & Brands — /dashboard/settings/locations
 *
 * Multi-location / multi-brand setup with per-location settings (address, timezone, currency, tax,
 * opening hours, booking + after-hours call handling, team assignment) and the organization
 * switcher's data source. Tenant scoping, "one primary", archive/delete rules and write permission
 * are enforced in SQL (supabase/migrations/20270501000000_business_locations.sql); the pure logic
 * lives in lib/locations.ts and the shared store in lib/locationStore.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, Plus, Search, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { BrandsPanel } from '@/components/locations/BrandsPanel';
import { LocationCard, type LocationAction } from '@/components/locations/LocationCard';
import { LocationFormDialog } from '@/components/locations/LocationFormDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useLocations } from '@/lib/locationStore';
import { archiveLocation, deleteLocation, fetchTeamMembers, restoreLocation, setLocationStatus, setPrimaryLocation } from '@/lib/locationsApi';
import { FILTER_LABELS, filterLocations, summarizeLocations, type BusinessLocation, type LocationFilter, type TeamMemberLite } from '@/lib/locations';

const FILTERS = Object.keys(FILTER_LABELS) as LocationFilter[];

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
    </div>
  );
}

export function LocationsSettingsPage() {
  const { isOwner, permissions, profile, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const { status, error, locations, brands, activeId, reload, setActive } = useLocations();

  const canManage = isOwner || permissions.can_edit_business_profile;
  const [filter, setFilter] = useState<LocationFilter>('all');
  const [query, setQuery] = useState('');
  const [team, setTeam] = useState<TeamMemberLite[] | null>(null);
  const [dialog, setDialog] = useState<{ location: BusinessLocation | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete'; location: BusinessLocation } | null>(null);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    fetchTeamMembers()
      .then((m) => !cancelled && setTeam(m))
      .catch(() => !cancelled && setTeam(null)); // assignment section degrades gracefully
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const summary = useMemo(() => summarizeLocations(locations, brands), [locations, brands]);
  const visible = useMemo(() => filterLocations(locations, filter, query), [locations, filter, query]);
  const counts = useMemo<Record<LocationFilter, number>>(
    () => ({ all: summary.total, active: summary.active, paused: summary.paused, archived: summary.archived }),
    [summary],
  );

  const run = useCallback(
    async (location: BusinessLocation, work: () => Promise<void>, success: string) => {
      setBusyId(location.id);
      try {
        await work();
        await reload();
        toast(success, 'success');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [reload, toast],
  );

  const onAction = useCallback(
    (action: LocationAction, l: BusinessLocation) => {
      switch (action) {
        case 'edit':
          setDialog({ location: l });
          break;
        case 'select':
          void setActive(l.id);
          toast(`Now working in ${l.name}.`, 'info');
          break;
        case 'primary':
          void run(l, () => setPrimaryLocation(l.id), `${l.name} is now the primary location.`);
          break;
        case 'pause':
          void run(l, () => setLocationStatus(l.id, 'paused'), `${l.name} paused.`);
          break;
        case 'resume':
          void run(l, () => setLocationStatus(l.id, 'active'), `${l.name} resumed.`);
          break;
        case 'restore':
          void run(l, () => restoreLocation(l.id), `${l.name} restored.`);
          break;
        case 'archive':
          setConfirm({ kind: 'archive', location: l });
          break;
        case 'delete':
          setConfirm({ kind: 'delete', location: l });
          break;
      }
    },
    [run, setActive, toast],
  );

  const confirmAction = async () => {
    if (!confirm) return;
    const { kind, location } = confirm;
    setConfirm(null);
    if (kind === 'archive') await run(location, () => archiveLocation(location.id), `${location.name} archived.`);
    else await run(location, () => deleteLocation(location.id), `${location.name} deleted.`);
  };

  // ---- permission gate (wait for the profile so permitted users never see a flash of "no access")
  if (authLoading || profileLoading || !profile) {
    return (
      <DashboardLayout activeLabel="Locations">
        <div className="mx-auto max-w-6xl space-y-4" aria-busy="true">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={2} />
        </div>
      </DashboardLayout>
    );
  }

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Locations">
        <div className="mx-auto max-w-3xl">
          <EmptyState
            icon={ShieldAlert}
            title="You don't have access to locations"
            description="Managing locations and brands needs the “edit business profile” permission. Ask your account owner to grant it."
          />
        </div>
      </DashboardLayout>
    );
  }

  const loadingFirst = status === 'loading' || status === 'idle';
  const hasAny = locations.length > 0;

  return (
    <DashboardLayout activeLabel="Locations">
      <div className="mx-auto max-w-6xl">
        <BackButton fallback="/dashboard/settings" label="Settings" className="mb-4" />

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Building2 size={22} className="text-accent" aria-hidden="true" /> Locations & brands
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Run several branches or brands from one account. Each location has its own address, timezone, hours, tax rate and call handling,
              and you can switch between them from the menu.
            </p>
          </div>
          <Button onClick={() => setDialog({ location: null })} className="w-full sm:w-auto">
            <Plus size={16} aria-hidden="true" /> Add location
          </Button>
        </div>

        {status === 'error' && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            <span className="flex items-center gap-2">
              <AlertTriangle size={16} aria-hidden="true" /> {error ?? 'Locations could not be loaded.'}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}

        {loadingFirst ? (
          <div className="space-y-4" aria-busy="true">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={2} />
          </div>
        ) : (
          <div className="space-y-6">
            {hasAny && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="Locations" value={summary.total} />
                <StatTile label="Active" value={summary.active} />
                <StatTile label="Paused" value={summary.paused} />
                <StatTile label="Brands" value={summary.brands} />
              </div>
            )}

            {!hasAny ? (
              status !== 'error' && (
                <EmptyState
                  icon={Building2}
                  title="Add your first location"
                  description="Start with your main branch. You can add more locations, group them under brands and assign your team any time."
                  action={{ label: 'Add location', onClick: () => setDialog({ location: null }) }}
                />
              )
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
                    {FILTERS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={filter === f}
                        onClick={() => setFilter(f)}
                        className={`focus-ring min-h-[40px] rounded-full border px-3.5 text-sm font-medium transition-colors ${
                          filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {FILTER_LABELS[f]} <span className="ml-1 text-xs opacity-70">{counts[f]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="relative sm:w-72">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      aria-label="Search locations"
                      placeholder="Search name, city, brand…"
                      className="focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/70"
                    />
                  </div>
                </div>

                {visible.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title="No locations match"
                    description="Try a different status filter or clear the search."
                    action={{ label: 'Clear filters', onClick: () => { setFilter('all'); setQuery(''); } }}
                  />
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    {visible.map((l) => (
                      <LocationCard key={l.id} location={l} isActive={l.id === activeId} busy={busyId === l.id} onAction={onAction} />
                    ))}
                  </div>
                )}
              </>
            )}

            <BrandsPanel brands={brands} onChanged={reload} />
          </div>
        )}
      </div>

      {dialog && (
        <LocationFormDialog
          key={dialog.location?.id ?? 'new'}
          location={dialog.location}
          brands={brands}
          team={team}
          allLocations={locations}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'delete' ? `Delete ${confirm.location.name}?` : `Archive ${confirm?.location.name ?? 'location'}?`}
        description={
          confirm?.kind === 'delete'
            ? 'This permanently removes the location and its team assignments. This cannot be undone.'
            : 'The location is hidden from the switcher and stops being used. You can restore it later.'
        }
        confirmPhrase={confirm?.kind === 'delete' ? 'delete location' : undefined}
        confirmLabel={confirm?.kind === 'delete' ? 'Yes, delete location' : 'Yes, archive'}
        onConfirm={confirmAction}
        onCancel={() => setConfirm(null)}
      />
    </DashboardLayout>
  );
}
