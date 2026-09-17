import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, CheckCircle2, XCircle, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { supabase } from '@/lib/supabase';
import { OUTCOME_LABELS, type TechnicianCapacityEvent } from '@/lib/technicianCapacity';

interface TechnicianRow {
  id: string;
  member_name: string | null;
  max_jobs_per_day: number;
  dispatch_enabled: boolean;
}

function CapacityBar({ load, capacity }: { load: number; capacity: number }) {
  const pct = capacity > 0 ? Math.min(100, Math.round((load / capacity) * 100)) : 0;
  const atCapacity = load >= capacity;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div
        className={`h-full rounded-full transition-all ${atCapacity ? 'bg-danger' : 'bg-accent'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function TechnicianCapacityPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [technicians, setTechnicians] = useState<TechnicianRow[]>([]);
  const [loadByTech, setLoadByTech] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<TechnicianCapacityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const [techRes, jobsRes, eventsRes] = await Promise.all([
      supabase
        .from('team_members')
        .select('id, member_name, max_jobs_per_day, dispatch_enabled')
        .eq('role', 'technician')
        .eq('invite_status', 'active'),
      supabase
        .from('jobs')
        .select('assigned_technician_id')
        .not('assigned_technician_id', 'is', null)
        .in('job_status', ['scheduled', 'en_route', 'in_progress'])
        .gte('scheduled_datetime', startOfDay.toISOString())
        .lte('scheduled_datetime', endOfDay.toISOString()),
      supabase
        .from('technician_capacity_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    if (techRes.error) toast('Failed to load technicians', 'error');
    setTechnicians((techRes.data as TechnicianRow[]) || []);

    const loads: Record<string, number> = {};
    (jobsRes.data || []).forEach((j: { assigned_technician_id: string | null }) => {
      if (!j.assigned_technician_id) return;
      loads[j.assigned_technician_id] = (loads[j.assigned_technician_id] || 0) + 1;
    });
    setLoadByTech(loads);
    setEvents((eventsRes.data as TechnicianCapacityEvent[]) || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const blockedToday = useMemo(
    () => events.filter((e) => e.outcome === 'at_capacity' || e.outcome === 'no_technician_available').length,
    [events],
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Lock size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Technician Capacity</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every assignment — AI-booked or manual — is checked and locked against a technician's real capacity
              before it's made, so simultaneous calls can never double-book someone past their daily limit.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{technicians.length}</p>
                <p className="text-xs text-text-secondary">Dispatch-enabled techs</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">
                  {Object.values(loadByTech).reduce((sum, n) => sum + n, 0)}
                </p>
                <p className="text-xs text-text-secondary">Jobs scheduled today</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{blockedToday}</p>
                <p className="text-xs text-text-secondary">Capacity locks triggered</p>
              </div>
            </div>

            <div className="mb-8 grid gap-4 sm:grid-cols-2">
              {technicians.map((tech) => {
                const load = loadByTech[tech.id] || 0;
                return (
                  <Card key={tech.id} className="p-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                        <Users size={14} className="text-text-secondary" />
                        {tech.member_name || 'Unnamed technician'}
                      </p>
                      <span className="text-xs font-semibold text-text-secondary">
                        {load} / {tech.max_jobs_per_day}
                      </span>
                    </div>
                    <div className="mt-3">
                      <CapacityBar load={load} capacity={tech.max_jobs_per_day} />
                    </div>
                    {load >= tech.max_jobs_per_day && (
                      <p className="mt-2 text-xs font-semibold text-danger">At capacity for today</p>
                    )}
                  </Card>
                );
              })}

              {technicians.length === 0 && (
                <p className="col-span-2 py-6 text-center text-sm text-text-secondary">
                  No dispatch-enabled technicians yet.
                </p>
              )}
            </div>

            <Card className="p-6">
              <h2 className="mb-4 text-sm font-semibold text-text-primary">Recent assignment decisions</h2>
              <div className="space-y-1.5">
                {events.map((event) => {
                  const ok = event.outcome === 'assigned';
                  return (
                    <div
                      key={event.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs"
                    >
                      <span className="flex items-center gap-1.5 font-medium text-text-primary">
                        {ok ? (
                          <CheckCircle2 size={13} className="text-success-500" />
                        ) : (
                          <XCircle size={13} className="text-danger" />
                        )}
                        {event.technician_name || 'No technician'}
                      </span>
                      <span className="text-text-secondary">{OUTCOME_LABELS[event.outcome]}</span>
                      {event.capacity !== null && (
                        <span className="text-text-secondary/70">
                          {event.day_load}/{event.capacity}
                        </span>
                      )}
                      <span className="text-text-secondary/70">{new Date(event.created_at).toLocaleString()}</span>
                    </div>
                  );
                })}

                {events.length === 0 && (
                  <p className="py-6 text-center text-sm text-text-secondary">
                    No assignment decisions logged yet — they'll show up here as jobs get assigned.
                  </p>
                )}
              </div>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
