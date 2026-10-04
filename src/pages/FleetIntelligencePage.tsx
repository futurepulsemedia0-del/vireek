import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ChevronDown, Gauge, Plug, RefreshCw, ShieldAlert, Radar, Route, TriangleAlert, Truck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { FleetConnectPanel } from '@/components/fleet/FleetConnectPanel';
import { FleetTripLifecycle } from '@/components/fleet/FleetTripLifecycle';
import {
  EVENT_LABELS,
  HIGH_WINDSHIELD_SHARE_PCT,
  buildFleetInsights,
  fetchFleetOverview,
  formatAge,
  formatCents,
  formatMinutes,
  formatPct,
  isVehicleLive,
  minutesSince,
  refreshFleetIntelligence,
  summarizeFleet,
  type FleetOverview,
  type FleetProfile,
} from '@/lib/fleetIntelligence';

type Tab = 'overview' | 'combos' | 'trips' | 'health' | 'connect';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'combos', label: 'Technician × Vehicle × Job' },
  { id: 'trips', label: 'Trips' },
  { id: 'health', label: 'Health & safety' },
  { id: 'connect', label: 'Connect telematics' },
];

const SEVERITY_STYLE = {
  critical: 'border-l-danger bg-danger/5',
  warning: 'border-l-warning-500 bg-warning-500/5',
  info: 'border-l-accent bg-accent/5',
} as const;

const DIAG_STYLE = {
  critical: 'bg-danger/10 text-danger',
  warning: 'bg-warning-500/10 text-warning-500',
  info: 'bg-bg-tertiary text-text-secondary',
} as const;

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`mt-1 text-lg font-bold ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function ConfidenceDot({ level }: { level: FleetProfile['confidence'] }) {
  const cls = level === 'high' ? 'bg-success-500' : level === 'medium' ? 'bg-warning-500' : 'bg-text-secondary/40';
  return <span title={`${level} confidence`} className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

export function FleetIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [openTrip, setOpenTrip] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await fetchFleetOverview());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const names = useMemo(() => {
    const tech = new Map((overview?.technicians ?? []).map((t) => [t.id, t.member_name ?? t.member_email]));
    const veh = new Map((overview?.vehicles ?? []).map((v) => [v.id, v.label]));
    const terr = new Map((overview?.territories ?? []).map((t) => [t.id, t.name]));
    return {
      technician: (id: string | null) => (id ? tech.get(id) ?? 'Unknown technician' : 'Unassigned'),
      vehicle: (id: string | null) => (id ? veh.get(id) ?? 'Unknown vehicle' : '—'),
      territory: (id: string | null) => (id ? terr.get(id) ?? 'Unknown zone' : '—'),
    };
  }, [overview]);

  const summary = useMemo(() => summarizeFleet(overview?.profiles ?? []), [overview]);
  const insights = useMemo(() => buildFleetInsights(overview?.profiles ?? [], names), [overview, names]);
  const techProfiles = useMemo(
    () => (overview?.profiles ?? []).filter((p) => p.scope === 'technician').sort((a, b) => b.sample_size - a.sample_size),
    [overview],
  );
  const combos = useMemo(
    () => (overview?.profiles ?? []).filter((p) => p.scope === 'combo').sort((a, b) => b.total_contribution_cents - a.total_contribution_cents),
    [overview],
  );
  const zones = useMemo(
    () => (overview?.profiles ?? []).filter((p) => p.scope === 'territory_service').sort((a, b) => b.sample_size - a.sample_size),
    [overview],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshFleetIntelligence();
      toast(`Scored ${r.trips_scored} trips across ${r.vehicles_scanned} vehicles.`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not refresh fleet intelligence.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const liveCount = overview?.vehicles.filter((v) => isVehicleLive(v)).length ?? 0;
  const noData = !!overview && overview.trips.length === 0;

  return (
    <DashboardLayout activeLabel="Fleet Intelligence">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Radar size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Fleet Intelligence</h1>
            <p className="text-sm text-text-secondary">
              Vehicle → GPS → technician → job → drive → arrival → work → outcome. Real time and cost per technician, truck, job type and zone.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/fleet-economics" className="focus-ring inline-flex items-center rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-secondary hover:text-text-primary">
            Fleet Economics
          </Link>
          <Button size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Computing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="Fleet Intelligence sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`focus-ring whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-6"><SkeletonStatGrid count={4} /><SkeletonTable rows={5} columns={5} /></div>
      ) : loadError || !overview ? (
        <EmptyState
          icon={TriangleAlert}
          title="Fleet Intelligence is not available yet"
          description="The fleet tables could not be read. Make sure the latest database migration has been applied, then try again."
          action={{ label: 'Try again', onClick: () => { setLoading(true); void load(); } }}
        />
      ) : tab === 'connect' ? (
        <FleetConnectPanel overview={overview} ownerId={user!.id} onChanged={load} />
      ) : tab === 'overview' ? (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Trips analysed (90d)" value={String(summary.trips)} hint={`${liveCount} of ${overview.vehicles.length} trucks live now`} />
            <Tile label="Avg drive · on site" value={`${formatMinutes(summary.avgDriveMinutes)} · ${formatMinutes(summary.avgOnSiteMinutes)}`} />
            <Tile
              label="Windshield time"
              value={formatPct(summary.windshieldSharePct)}
              hint="of job time spent driving"
              tone={summary.windshieldSharePct != null && summary.windshieldSharePct >= HIGH_WINDSHIELD_SHARE_PCT ? 'bad' : undefined}
            />
            <Tile label="Idle share" value={formatPct(summary.idleSharePct)} hint="of drive time, engine on" tone={summary.idleSharePct != null && summary.idleSharePct >= 15 ? 'bad' : undefined} />
            <Tile label="On-time arrival" value={formatPct(summary.onTimePct)} tone={summary.onTimePct != null && summary.onTimePct < 80 ? 'bad' : undefined} />
            <Tile label="Harsh events / 100 mi" value={summary.harshPer100Mi == null ? '—' : summary.harshPer100Mi.toFixed(1)} />
            <Tile label="Vehicle cost (90d)" value={formatCents(summary.vehicleCostCents)} />
            <Tile
              label="Contribution (90d)"
              value={formatCents(summary.contributionCents)}
              hint={summary.avgMarginPct == null ? undefined : `${summary.avgMarginPct.toFixed(1)}% avg margin`}
              tone={summary.contributionCents < 0 ? 'bad' : 'good'}
            />
          </div>

          {noData && (
            <EmptyState
              icon={Plug}
              title="No scored trips yet"
              description="Connect GPS, link each truck to its driver, then hit Refresh. Completed jobs are scored automatically from then on."
              action={{ label: 'Connect telematics', onClick: () => setTab('connect') }}
            />
          )}

          {insights.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Activity size={14} /> What needs attention</h2>
              <div className="space-y-2">
                {insights.map((i) => (
                  <div key={i.id} className={`rounded-xl border border-border border-l-4 p-3 ${SEVERITY_STYLE[i.severity]}`}>
                    <p className="text-sm font-semibold text-text-primary">{i.title}</p>
                    <p className="text-xs text-text-secondary">{i.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Truck size={14} /> Live fleet</h2>
            <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-text-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Truck</th>
                    <th className="px-4 py-3 font-medium">Driver</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Speed</th>
                    <th className="px-4 py-3 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.vehicles.map((v) => {
                    const live = isVehicleLive(v);
                    return (
                      <tr key={v.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium text-text-primary">{v.label}</td>
                        <td className="px-4 py-3 text-text-secondary">{names.technician(v.assigned_technician_id)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${live ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-success-500' : 'bg-text-secondary/50'}`} />
                            {live ? (v.last_ignition_on === false ? 'Parked' : 'Live') : v.last_seen_at ? 'Offline' : 'No GPS'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-text-secondary">{live && v.last_speed_mph != null ? `${Math.round(v.last_speed_mph)} mph` : '—'}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatAge(minutesSince(v.last_seen_at))}</td>
                      </tr>
                    );
                  })}
                  {overview.vehicles.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-text-secondary">Add your trucks on the Fleet Economics page to see them here.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {techProfiles.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Gauge size={14} /> Technicians (90 days)</h2>
              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary">
                    <tr>
                      <th className="px-4 py-3 font-medium">Technician</th>
                      <th className="px-4 py-3 font-medium">Trips</th>
                      <th className="px-4 py-3 font-medium">Drive</th>
                      <th className="px-4 py-3 font-medium">On site</th>
                      <th className="px-4 py-3 font-medium">Windshield</th>
                      <th className="px-4 py-3 font-medium">On time</th>
                      <th className="px-4 py-3 font-medium">Cost / mi</th>
                      <th className="px-4 py-3 font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {techProfiles.map((p) => (
                      <tr key={p.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium text-text-primary"><span className="mr-2"><ConfidenceDot level={p.confidence} /></span>{names.technician(p.technician_id)}</td>
                        <td className="px-4 py-3 text-text-secondary">{p.sample_size}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatMinutes(p.avg_drive_minutes)}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatMinutes(p.avg_on_site_minutes)}</td>
                        <td className={`px-4 py-3 ${p.windshield_share_pct != null && p.windshield_share_pct >= HIGH_WINDSHIELD_SHARE_PCT ? 'font-semibold text-danger' : 'text-text-secondary'}`}>{formatPct(p.windshield_share_pct)}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatPct(p.on_time_pct)}</td>
                        <td className="px-4 py-3 text-text-secondary">{p.cost_per_mile_cents == null ? '—' : `${Math.round(p.cost_per_mile_cents)}¢`}</td>
                        <td className={`px-4 py-3 ${p.avg_margin_pct != null && p.avg_margin_pct < 0 ? 'font-semibold text-danger' : 'text-text-secondary'}`}>{formatPct(p.avg_margin_pct, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      ) : tab === 'combos' ? (
        <div className="space-y-8">
          {combos.length === 0 ? (
            <EmptyState icon={Route} title="No combinations scored" description="Once completed jobs are linked to a truck and driver, every technician × vehicle × job type shows up here with its real time and cost." />
          ) : (
            <section>
              <p className="mb-3 text-xs text-text-secondary">Ranked by total contribution. Dots show data confidence (green high, amber medium, grey low).</p>
              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary">
                    <tr>
                      <th className="px-4 py-3 font-medium">Technician</th>
                      <th className="px-4 py-3 font-medium">Truck</th>
                      <th className="px-4 py-3 font-medium">Job type</th>
                      <th className="px-4 py-3 font-medium">Zone</th>
                      <th className="px-4 py-3 font-medium">Jobs</th>
                      <th className="px-4 py-3 font-medium">Drive</th>
                      <th className="px-4 py-3 font-medium">On site</th>
                      <th className="px-4 py-3 font-medium">Loaded cost</th>
                      <th className="px-4 py-3 font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combos.map((p) => (
                      <tr key={p.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium text-text-primary"><span className="mr-2"><ConfidenceDot level={p.confidence} /></span>{names.technician(p.technician_id)}</td>
                        <td className="px-4 py-3 text-text-secondary">{names.vehicle(p.vehicle_id)}</td>
                        <td className="px-4 py-3 capitalize text-text-secondary">{p.service_type}</td>
                        <td className="px-4 py-3 text-text-secondary">{names.territory(p.territory_id)}</td>
                        <td className="px-4 py-3 text-text-secondary">{p.sample_size}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatMinutes(p.avg_drive_minutes)}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatMinutes(p.avg_on_site_minutes)}</td>
                        <td className="px-4 py-3 text-text-secondary">{p.avg_fully_loaded_cost_cents == null ? '—' : formatCents(p.avg_fully_loaded_cost_cents)}</td>
                        <td className={`px-4 py-3 ${p.avg_margin_pct != null && p.avg_margin_pct < 0 ? 'font-semibold text-danger' : 'text-text-secondary'}`}>{formatPct(p.avg_margin_pct, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {zones.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Zone × job type</h2>
              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary">
                    <tr>
                      <th className="px-4 py-3 font-medium">Zone</th>
                      <th className="px-4 py-3 font-medium">Job type</th>
                      <th className="px-4 py-3 font-medium">Jobs</th>
                      <th className="px-4 py-3 font-medium">Avg drive</th>
                      <th className="px-4 py-3 font-medium">Avg vehicle cost</th>
                      <th className="px-4 py-3 font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zones.map((p) => (
                      <tr key={p.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium text-text-primary">{names.territory(p.territory_id)}</td>
                        <td className="px-4 py-3 capitalize text-text-secondary">{p.service_type}</td>
                        <td className="px-4 py-3 text-text-secondary">{p.sample_size}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatMinutes(p.avg_drive_minutes)}</td>
                        <td className="px-4 py-3 text-text-secondary">{p.avg_vehicle_cost_cents == null ? '—' : formatCents(p.avg_vehicle_cost_cents)}</td>
                        <td className={`px-4 py-3 ${p.avg_margin_pct != null && p.avg_margin_pct < 0 ? 'font-semibold text-danger' : 'text-text-secondary'}`}>{formatPct(p.avg_margin_pct, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      ) : tab === 'trips' ? (
        overview.trips.length === 0 ? (
          <EmptyState icon={Route} title="No scored trips" description="Completed jobs with a technician and a linked truck are scored here, each with its drive, arrival, work and outcome." />
        ) : (
          <div className="space-y-2">
            {overview.trips.map((t) => {
              const open = openTrip === t.id;
              return (
                <div key={t.id} className="rounded-2xl border border-border bg-bg-secondary">
                  <button type="button" onClick={() => setOpenTrip(open ? null : t.id)} aria-expanded={open} className="focus-ring flex w-full items-center gap-3 px-4 py-3 text-left">
                    <ChevronDown size={14} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text-primary">{t.jobs?.customer_name ?? 'Job'}</p>
                      <p className="truncate text-xs text-text-secondary">
                        {names.technician(t.technician_id)} · {names.vehicle(t.vehicle_id)} · {t.service_type ?? 'General'}
                      </p>
                    </div>
                    <ConfidenceDot level={t.confidence} />
                    <span className={`text-sm font-semibold ${t.revenue_cents > 0 ? (t.contribution_cents < 0 ? 'text-danger' : 'text-success-500') : 'text-text-secondary'}`}>
                      {t.revenue_cents > 0 ? formatCents(t.contribution_cents) : '—'}
                    </span>
                  </button>
                  {open && <div className="border-t border-border p-3"><FleetTripLifecycle trip={t} /></div>}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><TriangleAlert size={14} /> Active diagnostic codes</h2>
            {overview.diagnostics.length === 0 ? (
              <EmptyState icon={Truck} title="No active diagnostic codes" description="Engine and OBD fault codes reported by your telematics provider appear here until they are cleared." />
            ) : (
              <div className="space-y-2">
                {overview.diagnostics.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{d.code} <span className="font-normal text-text-secondary">· {names.vehicle(d.vehicle_id)}</span></p>
                      <p className="truncate text-xs text-text-secondary">{d.description ?? 'No description from provider'} · first seen {formatAge(minutesSince(d.first_seen_at))}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${DIAG_STYLE[d.severity]}`}>{d.severity}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><ShieldAlert size={14} /> Safety events (30 days)</h2>
            {overview.safetyEvents.length === 0 ? (
              <EmptyState icon={ShieldAlert} title="No safety events" description="Harsh braking, acceleration, extreme speed, collisions and dashcam clips show up here." />
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary">
                    <tr>
                      <th className="px-4 py-3 font-medium">Event</th>
                      <th className="px-4 py-3 font-medium">Driver</th>
                      <th className="px-4 py-3 font-medium">Truck</th>
                      <th className="px-4 py-3 font-medium">Severity</th>
                      <th className="px-4 py-3 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.safetyEvents.map((e) => (
                      <tr key={e.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium text-text-primary">{EVENT_LABELS[e.event_type] ?? e.event_type}{e.value != null && <span className="ml-1.5 text-xs font-normal text-text-secondary">{e.value}{e.unit ? ` ${e.unit.replace('_', '/')}` : ''}</span>}</td>
                        <td className="px-4 py-3 text-text-secondary">{names.technician(e.technician_id)}</td>
                        <td className="px-4 py-3 text-text-secondary">{names.vehicle(e.vehicle_id)}</td>
                        <td className="px-4 py-3 text-text-secondary">{'●'.repeat(e.severity)}</td>
                        <td className="px-4 py-3 text-text-secondary">{formatAge(minutesSince(e.occurred_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
