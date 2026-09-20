import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Route as RouteIcon,
  MapPin,
  Navigation,
  Siren,
  Layers,
  RefreshCw,
  Plus,
  Trash2,
  Loader2,
  Wifi,
  Signal,
  Gauge,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { supabase, Job, TeamMember, Territory } from '@/lib/supabase';
import {
  geocodeTargets,
  jobsNeedingGeocode,
  techniciansNeedingGeocode,
  optimizeRoute,
  findNearestTechnicians,
  fetchTerritories,
  saveTerritory,
  deleteTerritory,
  assignTechnicianTerritory,
  computeTerritoryBalance,
  type OptimizedRoute,
  type NearestTechnician,
} from '@/lib/routing';

const TERRITORY_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];

type JobWithCall = Job & { calls: { is_emergency: boolean } | null };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function etaSourceLabel(source: OptimizedRoute['etaSource']): { text: string; icon: JSX.Element } {
  if (source === 'google_traffic') return { text: 'Live traffic ETA', icon: <Wifi size={12} /> };
  if (source === 'osrm_road_network') return { text: 'Road-network ETA', icon: <Signal size={12} /> };
  if (source === 'estimated') return { text: 'Estimated ETA', icon: <Gauge size={12} /> };
  return { text: '—', icon: <Gauge size={12} /> };
}

// ============================================================
// ROUTE OPTIMIZATION PANEL
// ============================================================

function RouteOptimizationPanel({ technicians }: { technicians: TeamMember[] }) {
  const { toast } = useToast();
  const [technicianId, setTechnicianId] = useState(technicians[0]?.id ?? '');
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [route, setRoute] = useState<OptimizedRoute | null>(null);

  const handleOptimize = async () => {
    if (!technicianId) return;
    setLoading(true);
    setRoute(null);
    try {
      const result = await optimizeRoute(technicianId, date);
      setRoute(result);
      if (result.unrouted.length > 0) {
        toast(`${result.unrouted.length} job(s) skipped — address not geocoded yet.`, 'error');
      }
    } catch {
      toast('Could not optimize this route. Please try again.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const eta = route ? etaSourceLabel(route.etaSource) : null;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <RouteIcon size={16} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Route Optimization</h2>
          <p className="text-xs text-text-secondary">Multi-stop order, ETA, and total drive time for one technician's day</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary">Technician</label>
          <select
            value={technicianId}
            onChange={(e) => setTechnicianId(e.target.value)}
            className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          >
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>{t.member_name || t.member_email}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-secondary">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          />
        </div>
        <button
          type="button"
          onClick={handleOptimize}
          disabled={loading || !technicianId}
          className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Navigation size={14} />}
          {loading ? 'Optimizing…' : 'Optimize route'}
        </button>
      </div>

      {route && (
        <div className="mt-5">
          {route.stops.length === 0 ? (
            <p className="py-4 text-center text-sm text-text-secondary">
              No geocoded, scheduled jobs for this technician on this date.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
                <span className="flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 font-semibold text-text-primary">
                  {eta?.icon}
                  {eta?.text}
                </span>
                <span>{route.stops.length} stops</span>
                <span>{route.totalDistanceMiles} mi total</span>
                <span>{route.totalDriveMinutes} min drive time</span>
              </div>
              <ol className="space-y-1.5">
                {route.stops.map((stop) => (
                  <li
                    key={stop.jobId}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 px-3 py-2 text-xs"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-bold text-accent">
                      {stop.order}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text-primary">{stop.address}</span>
                    <span className="shrink-0 text-text-secondary">
                      +{stop.travelMinutesFromPrev} min / {stop.distanceMilesFromPrev} mi
                    </span>
                    <span className="shrink-0 font-semibold text-text-primary">
                      {new Date(stop.etaArrival).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </li>
                ))}
              </ol>
              {route.unrouted.length > 0 && (
                <p className="mt-3 text-xs text-warning-500">
                  {route.unrouted.length} job(s) for this day aren't geocoded yet and were left out — use "Geocode missing addresses" above.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// EMERGENCY DISPATCH PANEL
// ============================================================

function EmergencyDispatchPanel() {
  const { toast } = useToast();
  const [unassigned, setUnassigned] = useState<JobWithCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchingJobId, setSearchingJobId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, NearestTechnician[]>>({});
  const [assigning, setAssigning] = useState<string | null>(null);

  const loadUnassigned = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('jobs')
      .select('*, calls(is_emergency)')
      .is('assigned_technician_id', null)
      .in('job_status', ['scheduled', 'en_route'])
      .order('scheduled_datetime', { ascending: true })
      .limit(20);
    setUnassigned((data as JobWithCall[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadUnassigned();
  }, [loadUnassigned]);

  const handleFindNearest = async (job: JobWithCall) => {
    setSearchingJobId(job.id);
    try {
      let lat = job.latitude;
      let lon = job.longitude;
      if ((lat === null || lat === undefined) && job.address) {
        const geo = await geocodeTargets([{ type: 'job', id: job.id, address: job.address }]);
        const hit = geo.results[0];
        if (hit?.status === 'geocoded') {
          lat = hit.latitude ?? null;
          lon = hit.longitude ?? null;
        }
      }
      if (lat === null || lat === undefined || lon === null || lon === undefined) {
        toast('Could not geocode this job\u2019s address.', 'error');
        return;
      }
      const nearest = await findNearestTechnicians(lat, lon, job.service_type ?? undefined, 5);
      setCandidates((prev) => ({ ...prev, [job.id]: nearest }));
      if (nearest.length === 0) toast('No technicians with a known location right now.', 'error');
    } catch {
      toast('Could not search for nearby technicians.', 'error');
    } finally {
      setSearchingJobId(null);
    }
  };

  const handleAssign = async (jobId: string, technicianId: string) => {
    setAssigning(`${jobId}:${technicianId}`);
    try {
      const { data, error } = await supabase.rpc('assign_technician_to_job', { p_job_id: jobId, p_technician_id: technicianId });
      if (error) throw error;
      const result = data as { status: string; reason?: string };
      if (result.status === 'assigned') {
        toast('Technician dispatched.', 'success');
        setUnassigned((prev) => prev.filter((j) => j.id !== jobId));
      } else {
        toast(result.reason ?? 'Could not assign that technician.', 'error');
      }
    } catch {
      toast('Could not assign that technician.', 'error');
    } finally {
      setAssigning(null);
    }
  };

  const emergencyFirst = useMemo(
    () => [...unassigned].sort((a, b) => Number(b.calls?.is_emergency ?? false) - Number(a.calls?.is_emergency ?? false)),
    [unassigned],
  );

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <Siren size={16} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Emergency Dispatch</h2>
            <p className="text-xs text-text-secondary">Unassigned jobs — find and dispatch the nearest available technician</p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadUnassigned}
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {loading ? (
          [0, 1].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-bg-tertiary" />)
        ) : emergencyFirst.length === 0 ? (
          <p className="py-4 text-center text-sm text-text-secondary">No unassigned jobs right now.</p>
        ) : (
          emergencyFirst.map((job) => (
            <div key={job.id} className="rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs">
                  {job.calls?.is_emergency && (
                    <span className="rounded-full bg-danger/10 px-2 py-0.5 font-semibold text-danger">Emergency</span>
                  )}
                  <span className="font-medium text-text-primary">{job.customer_name}</span>
                  <span className="text-text-secondary">{job.address}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleFindNearest(job)}
                  disabled={searchingJobId === job.id}
                  className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                >
                  {searchingJobId === job.id ? <Loader2 size={12} className="animate-spin" /> : <MapPin size={12} />}
                  Find nearest techs
                </button>
              </div>

              {candidates[job.id] && (
                <div className="mt-2 space-y-1">
                  {candidates[job.id].length === 0 ? (
                    <p className="text-xs text-text-secondary">No technicians with a known location.</p>
                  ) : (
                    candidates[job.id].map((c) => (
                      <div key={c.technician_id} className="flex items-center justify-between gap-2 rounded-md bg-bg-tertiary/60 px-2.5 py-1.5 text-xs">
                        <span className="font-medium text-text-primary">{c.technician_name}</span>
                        <span className="text-text-secondary">{c.distance_miles.toFixed(1)} mi</span>
                        <span className="text-text-secondary">{c.today_load}/{c.max_jobs_per_day} today</span>
                        {c.has_skill && <span className="text-success-500">skill match</span>}
                        <button
                          type="button"
                          onClick={() => handleAssign(job.id, c.technician_id)}
                          disabled={assigning === `${job.id}:${c.technician_id}` || c.today_load >= c.max_jobs_per_day}
                          className="focus-ring ml-auto rounded-md bg-accent px-2 py-1 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Dispatch
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

// ============================================================
// TERRITORY BALANCING PANEL
// ============================================================

function TerritoryPanel({
  territories,
  technicians,
  openJobs,
  onChange,
}: {
  territories: Territory[];
  technicians: TeamMember[];
  openJobs: Job[];
  onChange: () => void;
}) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [radius, setRadius] = useState(15);
  const [saving, setSaving] = useState(false);

  const balance = useMemo(() => computeTerritoryBalance(territories, technicians, openJobs), [territories, technicians, openJobs]);

  const handleCreate = async () => {
    if (!name.trim() || !address.trim()) return;
    setSaving(true);
    try {
      const geo = await geocodeTargets([{ type: 'scratch', id: 'territory-center', address }]);
      const hit = geo.results[0];
      if (hit?.status !== 'geocoded' || hit.latitude === undefined || hit.longitude === undefined) {
        toast('Could not find that address.', 'error');
        return;
      }
      await saveTerritory({
        name: name.trim(),
        color: TERRITORY_COLORS[territories.length % TERRITORY_COLORS.length],
        centerLatitude: hit.latitude,
        centerLongitude: hit.longitude,
        radiusMiles: radius,
      });
      toast('Territory created.', 'success');
      setName('');
      setAddress('');
      setShowForm(false);
      onChange();
    } catch {
      toast('Could not create territory.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTerritory(id);
      toast('Territory deleted.', 'success');
      onChange();
    } catch {
      toast('Could not delete territory.', 'error');
    }
  };

  const handleTechTerritory = async (techId: string, territoryId: string) => {
    try {
      await assignTechnicianTerritory(techId, territoryId || null);
      onChange();
    } catch {
      toast('Could not update territory assignment.', 'error');
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Layers size={16} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Territory Balancing</h2>
            <p className="text-xs text-text-secondary">Open jobs per technician, by zone — flags where load is uneven</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
        >
          <Plus size={13} />
          New territory
        </button>
      </div>

      {showForm && (
        <div className="mt-4 flex flex-wrap items-end gap-2 rounded-lg border border-border/70 p-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="North Zone" className="focus-ring w-32 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Center address</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="City, State" className="focus-ring w-48 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Radius (mi)</label>
            <input type="number" value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="focus-ring w-20 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-sm" />
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving}
            className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {balance.length === 0 ? (
          <p className="py-4 text-center text-sm text-text-secondary">No territories yet — create one to start balancing load.</p>
        ) : (
          balance.map((t) => (
            <div key={t.territoryId} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 px-3 py-2 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
              <span className="font-medium text-text-primary">{t.territoryName}</span>
              <span className="text-text-secondary">{t.technicianCount} techs</span>
              <span className="text-text-secondary">{t.openJobCount} open jobs</span>
              <span className="font-semibold text-text-primary">{t.jobsPerTechnician ?? '—'} jobs/tech</span>
              <button
                type="button"
                onClick={() => handleDelete(t.territoryId)}
                className="focus-ring ml-auto text-text-secondary/70 transition-colors hover:text-danger"
                aria-label="Delete territory"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>

      {territories.length > 0 && technicians.length > 0 && (
        <div className="mt-4 border-t border-border/70 pt-4">
          <p className="mb-2 text-xs font-semibold text-text-secondary">Assign technicians to territories</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {technicians.map((tech) => (
              <div key={tech.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-text-primary">{tech.member_name || tech.member_email}</span>
                <select
                  value={tech.territory_id ?? ''}
                  onChange={(e) => handleTechTerritory(tech.id, e.target.value)}
                  className="focus-ring rounded-md border border-border bg-bg-primary px-2 py-1 text-xs"
                >
                  <option value="">Unassigned</option>
                  {territories.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function AdvancedRoutingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [openJobs, setOpenJobs] = useState<Job[]>([]);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [loading, setLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [techRes, jobsRes, territoriesData] = await Promise.all([
        supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
        supabase.from('jobs').select('*').in('job_status', ['scheduled', 'en_route', 'in_progress']),
        fetchTerritories(),
      ]);
      setTechnicians((techRes.data as TeamMember[]) ?? []);
      setOpenJobs((jobsRes.data as Job[]) ?? []);
      setTerritories(territoriesData);
    } catch {
      // empty states below
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const missingGeocode = useMemo(
    () => jobsNeedingGeocode(openJobs).length + techniciansNeedingGeocode(technicians).length,
    [openJobs, technicians],
  );

  const handleGeocodeMissing = async () => {
    setGeocoding(true);
    try {
      const targets = [...jobsNeedingGeocode(openJobs), ...techniciansNeedingGeocode(technicians)].slice(0, 25);
      if (targets.length === 0) return;
      const result = await geocodeTargets(targets);
      toast(`Geocoded ${result.geocoded} of ${result.total}. Run again for any remaining.`, 'success');
      loadAll();
    } catch {
      toast('Could not geocode addresses. Please try again.', 'error');
    } finally {
      setGeocoding(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Advanced Routing">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <RouteIcon size={16} />
              </span>
              <h1 className="text-2xl font-bold text-text-primary">Advanced Routing</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              Route optimization, technician proximity, territory balancing, and emergency dispatch.
            </p>
          </div>
        </div>

        {missingGeocode > 0 && (
          <button
            type="button"
            onClick={handleGeocodeMissing}
            disabled={geocoding}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            {geocoding ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
            {geocoding ? 'Geocoding…' : `Geocode ${Math.min(missingGeocode, 25)} missing address${missingGeocode === 1 ? '' : 'es'}`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />)}
        </div>
      ) : technicians.length === 0 ? (
        <EmptyState
          icon={RouteIcon}
          title="No dispatch-enabled technicians yet"
          description="Add technicians under Team and enable dispatch to start using Advanced Routing."
          action={{ label: 'Go to Team', onClick: () => navigate('/dashboard/team') }}
        />
      ) : (
        <div className="space-y-6">
          <RouteOptimizationPanel technicians={technicians} />
          <EmergencyDispatchPanel />
          <TerritoryPanel territories={territories} technicians={technicians} openJobs={openJobs} onChange={loadAll} />
        </div>
      )}
    </DashboardLayout>
  );
}
