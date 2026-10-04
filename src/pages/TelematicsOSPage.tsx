import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Camera, ExternalLink, Fuel, Gauge, RefreshCw, Satellite, Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { TelematicsConnectPanel } from '@/components/telematics/TelematicsConnectPanel';
import { supabase } from '@/lib/supabase';
import {
  EVENT_LABELS, FLAG_LABELS, addMaintenanceSchedule, ageLabel, liveStatus, loadTelematics, maintenanceStatus, mapsUrl,
  markServiced, recomputeChain, safetyTier, subscribeLive, type LiveStatus, type LiveVehicle, type TelematicsSnapshot,
} from '@/lib/telematics';

type Tab = 'live' | 'safety' | 'maintenance' | 'truth' | 'connect';
const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live fleet' }, { id: 'safety', label: 'Driver safety' }, { id: 'maintenance', label: 'Maintenance' },
  { id: 'truth', label: 'Job truth' }, { id: 'connect', label: 'Connect' },
];

const STATUS_STYLE: Record<LiveStatus, string> = {
  moving: 'bg-success-500/10 text-success-500', idling: 'bg-warning-500/10 text-warning-500',
  stopped: 'bg-bg-tertiary text-text-secondary', offline: 'bg-danger-500/10 text-danger-500',
};
const TIER_STYLE = { excellent: 'text-success-500', good: 'text-success-500', watch: 'text-warning-500', at_risk: 'text-danger-500' } as const;
const CARD = 'rounded-2xl border border-border bg-bg-secondary';
const INPUT = 'rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

const empty: TelematicsSnapshot = { connections: [], vehicles: [], live: [], safety: [], events: [], faults: [], schedules: [], truth: [] };

export function TelematicsOSPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<TelematicsSnapshot>(empty);
  const [techNames, setTechNames] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('live');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [sched, setSched] = useState({ vehicle_id: '', name: '', interval_miles: '', interval_days: '' });
  const [savingSched, setSavingSched] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [snap, team] = await Promise.all([loadTelematics(), supabase.from('team_members').select('id, member_name, member_email')]);
      setData(snap);
      setTechNames(Object.fromEntries(((team.data as { id: string; member_name: string | null; member_email: string }[]) ?? []).map((t) => [t.id, t.member_name || t.member_email])));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (user) void refresh(); }, [user, refresh]);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(id); }, []);
  useEffect(() => subscribeLive((row) => setData((d) => ({ ...d, live: [...d.live.filter((l) => l.vehicle_id !== row.vehicle_id), row] }))), []);

  const liveById = useMemo(() => new Map(data.live.map((l) => [l.vehicle_id, l])), [data.live]);
  const vehicleLabel = useMemo(() => Object.fromEntries(data.vehicles.map((v) => [v.id, v.label])), [data.vehicles]);
  const connected = data.connections.some((c) => c.status === 'connected' || c.status === 'error');

  const summary = useMemo(() => {
    const st = data.vehicles.map((v) => liveStatus(liveById.get(v.id), now));
    const miles = data.safety.reduce((s, r) => s + r.miles, 0);
    const avg = data.safety.length ? data.safety.reduce((s, r) => s + r.score * Math.max(r.miles, 1), 0) / data.safety.reduce((s, r) => s + Math.max(r.miles, 1), 0) : null;
    const overdue = data.schedules.filter((s) => maintenanceStatus(s, data.vehicles.find((v) => v.id === s.vehicle_id)?.odometer_miles ?? null, now).status === 'overdue').length;
    return { moving: st.filter((s) => s === 'moving').length, idling: st.filter((s) => s === 'idling').length, offline: st.filter((s) => s === 'offline').length, avg, miles, overdue };
  }, [data, liveById, now]);

  const perVehicleSafety = useMemo(() => {
    const m = new Map<string, { miles: number; weighted: number; weight: number; harsh: number; speeding: number; tech: string | null }>();
    for (const r of data.safety) {
      const cur = m.get(r.vehicle_id) ?? { miles: 0, weighted: 0, weight: 0, harsh: 0, speeding: 0, tech: r.technician_id };
      const w = Math.max(r.miles, 1); // a near-zero-mile day still counts, but cannot dominate
      cur.miles += r.miles; cur.weighted += r.score * w; cur.weight += w;
      cur.harsh += r.harsh_brake + r.harsh_accel + r.harsh_turn; cur.speeding += r.speeding_events;
      m.set(r.vehicle_id, cur);
    }
    return [...m.entries()].map(([id, c]) => ({ id, miles: c.miles, harsh: c.harsh, speeding: c.speeding, tech: c.tech, score: c.weighted / c.weight })).sort((a, b) => a.score - b.score);
  }, [data.safety]);

  const recompute = async () => {
    setRecomputing(true);
    const r = await recomputeChain(7);
    setRecomputing(false);
    if (r.error) { toast(r.error, 'error'); return; }
    toast(`Updated ${r.trips ?? 0} trips and ${r.jobs_scored ?? 0} jobs.`, 'success');
    void refresh();
  };

  const addSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !sched.vehicle_id || !sched.name.trim()) return;
    const miles = Number(sched.interval_miles) || null;
    const days = Number(sched.interval_days) || null;
    if (!miles && !days) { toast('Set a mileage and/or day interval.', 'error'); return; }
    const odo = data.vehicles.find((v) => v.id === sched.vehicle_id)?.odometer_miles ?? null;
    setSavingSched(true);
    const { error } = await addMaintenanceSchedule({ vehicle_id: sched.vehicle_id, name: sched.name.trim(), interval_miles: miles, interval_days: days, last_service_miles: miles ? odo : null, last_service_date: new Date().toISOString().slice(0, 10) }, user.id);
    setSavingSched(false);
    if (error) { toast('Could not save the schedule.', 'error'); return; }
    setSched({ vehicle_id: '', name: '', interval_miles: '', interval_days: '' });
    void refresh();
  };

  const serviced = async (id: string, vehicleId: string) => {
    const odo = data.vehicles.find((v) => v.id === vehicleId)?.odometer_miles ?? null;
    const { error } = await markServiced(id, odo);
    if (error) { toast('Could not update.', 'error'); return; }
    void refresh();
  };

  const kpi = (label: string, value: string, tone = 'text-text-primary') => (
    <div className={`${CARD} p-4`}><p className="text-xs text-text-secondary">{label}</p><p className={`mt-1 text-lg font-bold ${tone}`}>{value}</p></div>
  );

  return (
    <DashboardLayout activeLabel="Telematics OS">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Satellite size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Telematics OS</h1>
            <p className="text-sm text-text-secondary">Vehicle → technician → job → customer outcome, from real GPS and diagnostics.</p>
          </div>
        </div>
        <button type="button" onClick={() => void recompute()} disabled={recomputing || !connected} className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60">
          <RefreshCw size={14} className={recomputing ? 'animate-spin' : ''} /> {recomputing ? 'Recomputing…' : 'Recompute chain'}
        </button>
      </div>

      {loadError && <div role="alert" className="mb-4 rounded-xl border border-danger-500/30 bg-danger-500/10 p-3 text-sm text-danger-500">Could not load telematics data. Check that the Real Telematics OS migration has been applied, then retry.</div>}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {kpi('Moving now', String(summary.moving), 'text-success-500')}
        {kpi('Idling', String(summary.idling), summary.idling ? 'text-warning-500' : 'text-text-primary')}
        {kpi('Offline', String(summary.offline), summary.offline ? 'text-danger-500' : 'text-text-primary')}
        {kpi('Fleet safety (14d)', summary.avg == null ? '—' : summary.avg.toFixed(0), summary.avg == null ? 'text-text-primary' : TIER_STYLE[safetyTier(summary.avg)])}
        {kpi('Overdue service', String(summary.overdue), summary.overdue ? 'text-danger-500' : 'text-text-primary')}
      </div>

      <div role="tablist" aria-label="Telematics sections" className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`focus-ring -mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{t.label}</button>
        ))}
      </div>

      {loading ? <p className="text-sm text-text-secondary">Loading…</p> : (
        <div role="tabpanel">
          {tab === 'live' && (
            data.vehicles.length === 0 ? (
              <div className={`${CARD} p-8 text-center text-sm text-text-secondary`}>No vehicles yet. Add them in Fleet Economics, or connect Samsara to import your fleet automatically.</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {data.vehicles.map((v) => {
                  const l: LiveVehicle | undefined = liveById.get(v.id);
                  const st = liveStatus(l, now);
                  const activeFaults = data.faults.filter((f) => f.vehicle_id === v.id);
                  return (
                    <article key={v.id} className={`${CARD} p-4`}>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-semibold text-text-primary">{v.label}</h3>
                          <p className="text-xs text-text-secondary">{v.assigned_technician_id ? techNames[v.assigned_technician_id] ?? 'Technician' : 'No technician assigned'}</p>
                        </div>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[st]}`}>{st === 'moving' && l?.speed_mph != null ? `${Math.round(l.speed_mph)} mph` : st}</span>
                      </div>
                      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        <div><dt className="text-text-secondary"><Fuel size={11} className="mr-1 inline" />Fuel</dt><dd className="font-medium text-text-primary">{l?.fuel_pct != null ? `${Math.round(l.fuel_pct)}%` : '—'}</dd></div>
                        <div><dt className="text-text-secondary"><Gauge size={11} className="mr-1 inline" />Odometer</dt><dd className="font-medium text-text-primary">{(l?.odometer_miles ?? v.odometer_miles)?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'}</dd></div>
                        <div><dt className="text-text-secondary">Last fix</dt><dd className="font-medium text-text-primary">{ageLabel(l?.last_fix_at ?? null, now)}</dd></div>
                      </dl>
                      {l?.reverse_geo && <p className="mt-2 truncate text-xs text-text-secondary" title={l.reverse_geo}>{l.reverse_geo}</p>}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {(l?.check_engine || activeFaults.length > 0) && <span className="inline-flex items-center gap-1 rounded-full bg-danger-500/10 px-2 py-0.5 text-[11px] font-medium text-danger-500"><AlertTriangle size={11} />{activeFaults.length || 1} fault{activeFaults.length === 1 ? '' : 's'}</span>}
                        {l?.current_job_id && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">On a job site</span>}
                        {l?.latitude != null && l?.longitude != null && <a href={mapsUrl(l.latitude, l.longitude)} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline">Map <ExternalLink size={11} /></a>}
                      </div>
                    </article>
                  );
                })}
              </div>
            )
          )}

          {tab === 'safety' && (
            <div className="space-y-6">
              <div className={`${CARD} overflow-x-auto`}>
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary"><tr>
                    <th className="px-4 py-3 font-medium">Vehicle</th><th className="px-4 py-3 font-medium">Driver</th><th className="px-4 py-3 font-medium">Miles (14d)</th><th className="px-4 py-3 font-medium">Harsh</th><th className="px-4 py-3 font-medium">Speeding</th><th className="px-4 py-3 font-medium">Score</th>
                  </tr></thead>
                  <tbody>
                    {perVehicleSafety.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-medium text-text-primary">{vehicleLabel[r.id] ?? '—'}</td>
                        <td className="px-4 py-3 text-text-secondary">{r.tech ? techNames[r.tech] ?? '—' : '—'}</td>
                        <td className="px-4 py-3 text-text-secondary">{r.miles.toFixed(0)}</td>
                        <td className="px-4 py-3 text-text-secondary">{r.harsh}</td>
                        <td className="px-4 py-3 text-text-secondary">{r.speeding}</td>
                        <td className={`px-4 py-3 font-semibold ${TIER_STYLE[safetyTier(r.score)]}`}>{r.score.toFixed(0)}</td>
                      </tr>
                    ))}
                    {perVehicleSafety.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-text-secondary">No driving data yet. Scores appear after the first trips are computed.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div>
                <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent safety events</h2>
                <ul className="space-y-2">
                  {data.events.map((e) => (
                    <li key={e.id} className={`${CARD} flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm`}>
                      <span className="text-text-primary">{EVENT_LABELS[e.event_type] ?? e.event_type} <span className="text-xs text-text-secondary">· {vehicleLabel[e.vehicle_id] ?? ''} · {ageLabel(e.occurred_at, now)}</span></span>
                      <span className="flex items-center gap-2">
                        {e.speed_mph != null && <span className="text-xs text-text-secondary">{Math.round(e.speed_mph)}{e.speed_limit_mph ? `/${Math.round(e.speed_limit_mph)}` : ''} mph</span>}
                        {e.media_url && <a href={e.media_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline"><Camera size={12} />Clip</a>}
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${e.severity === 'critical' || e.severity === 'high' ? 'bg-danger-500/10 text-danger-500' : 'bg-bg-tertiary text-text-secondary'}`}>{e.severity}</span>
                      </span>
                    </li>
                  ))}
                  {data.events.length === 0 && <li className={`${CARD} p-6 text-center text-sm text-text-secondary`}>No safety events in the last 14 days.</li>}
                </ul>
              </div>
            </div>
          )}

          {tab === 'maintenance' && (
            <div className="space-y-6">
              {data.faults.length > 0 && (
                <div className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-4">
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-danger-500"><AlertTriangle size={14} /> Active diagnostic faults</h2>
                  <ul className="space-y-1 text-sm">
                    {data.faults.map((f) => <li key={f.id} className="text-text-primary"><strong>{vehicleLabel[f.vehicle_id] ?? 'Vehicle'}</strong> · {f.code}{f.description ? ` — ${f.description}` : ''} <span className="text-xs text-text-secondary">({f.severity}, seen {ageLabel(f.last_seen_at, now)})</span></li>)}
                  </ul>
                </div>
              )}
              <form onSubmit={addSchedule} className={`${CARD} grid grid-cols-2 gap-3 p-4 sm:grid-cols-5`}>
                <select value={sched.vehicle_id} onChange={(e) => setSched({ ...sched, vehicle_id: e.target.value })} required aria-label="Vehicle" className={INPUT}><option value="">Vehicle…</option>{data.vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select>
                <input value={sched.name} onChange={(e) => setSched({ ...sched, name: e.target.value })} placeholder="Service (e.g. Oil change)" required aria-label="Service name" className={INPUT} />
                <input value={sched.interval_miles} onChange={(e) => setSched({ ...sched, interval_miles: e.target.value })} type="number" min="1" placeholder="Every … miles" aria-label="Interval miles" className={INPUT} />
                <input value={sched.interval_days} onChange={(e) => setSched({ ...sched, interval_days: e.target.value })} type="number" min="1" placeholder="Every … days" aria-label="Interval days" className={INPUT} />
                <button type="submit" disabled={savingSched} className="focus-ring col-span-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60 sm:col-span-1">{savingSched ? 'Saving…' : 'Add schedule'}</button>
              </form>
              <div className={`${CARD} overflow-x-auto`}>
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary"><tr><th className="px-4 py-3 font-medium">Vehicle</th><th className="px-4 py-3 font-medium">Service</th><th className="px-4 py-3 font-medium">Remaining</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3" /></tr></thead>
                  <tbody>
                    {data.schedules.map((s) => {
                      const odo = liveById.get(s.vehicle_id)?.odometer_miles ?? data.vehicles.find((v) => v.id === s.vehicle_id)?.odometer_miles ?? null;
                      const m = maintenanceStatus(s, odo, now);
                      return (
                        <tr key={s.id} className="border-b border-border last:border-0">
                          <td className="px-4 py-3 font-medium text-text-primary">{vehicleLabel[s.vehicle_id] ?? '—'}</td>
                          <td className="px-4 py-3 text-text-secondary"><Wrench size={12} className="mr-1 inline" />{s.name}</td>
                          <td className="px-4 py-3 text-text-secondary">{[m.milesRemaining != null ? `${m.milesRemaining.toLocaleString()} mi` : null, m.daysRemaining != null ? `${m.daysRemaining} d` : null].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m.status === 'overdue' ? 'bg-danger-500/10 text-danger-500' : m.status === 'due_soon' ? 'bg-warning-500/10 text-warning-500' : 'bg-success-500/10 text-success-500'}`}>{m.status.replace('_', ' ')}</span></td>
                          <td className="px-4 py-3 text-right"><button type="button" onClick={() => void serviced(s.id, s.vehicle_id)} className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary">Mark serviced</button></td>
                        </tr>
                      );
                    })}
                    {data.schedules.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-text-secondary">No maintenance schedules yet. Add one above — odometer comes straight from the vehicle.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'truth' && (
            <div>
              <p className="mb-3 text-xs text-text-secondary">Lowest integrity first. Score blends GPS-verified arrival, punctuality, safe driving, rework, disputes, customer rating and travel efficiency.</p>
              <div className={`${CARD} overflow-x-auto`}>
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary"><tr>
                    <th className="px-4 py-3 font-medium">Job</th><th className="px-4 py-3 font-medium">Vehicle</th><th className="px-4 py-3 font-medium">Drive</th><th className="px-4 py-3 font-medium">On site</th><th className="px-4 py-3 font-medium">Value / hr</th><th className="px-4 py-3 font-medium">Integrity</th><th className="px-4 py-3 font-medium">Flags</th>
                  </tr></thead>
                  <tbody>
                    {data.truth.map((r) => (
                      <tr key={r.job_id} className="border-b border-border align-top last:border-0">
                        <td className="px-4 py-3 text-text-primary">{r.jobs?.customer_name ?? 'Job'}<span className="ml-1.5 text-xs text-text-secondary">{r.jobs?.service_type ?? ''}</span></td>
                        <td className="px-4 py-3 text-text-secondary">{r.vehicle_id ? vehicleLabel[r.vehicle_id] ?? '—' : '—'}</td>
                        <td className="px-4 py-3 text-text-secondary">{r.drive_miles.toFixed(1)} mi · {Math.round(r.drive_minutes)} min</td>
                        <td className="px-4 py-3 text-text-secondary">{r.onsite_minutes != null ? `${Math.round(r.onsite_minutes)} min` : 'In progress'}</td>
                        <td className="px-4 py-3 text-text-secondary">{r.value_per_onsite_hour != null ? `$${r.value_per_onsite_hour.toFixed(0)}` : '—'}</td>
                        <td className={`px-4 py-3 font-semibold ${r.integrity_score >= 80 ? 'text-success-500' : r.integrity_score >= 60 ? 'text-warning-500' : 'text-danger-500'}`}>{Math.round(r.integrity_score)}</td>
                        <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{r.flags.map((f) => <span key={f} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{FLAG_LABELS[f] ?? f}</span>)}</div></td>
                      </tr>
                    ))}
                    {data.truth.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-text-secondary">No scored jobs yet. Jobs appear once a vehicle's GPS arrival is detected at a geocoded job address.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'connect' && <TelematicsConnectPanel connections={data.connections} onChanged={refresh} />}
        </div>
      )}
    </DashboardLayout>
  );
}
