import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Route, Wrench, Sparkles, Brain, X, PackageCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Job, TeamMember } from '@/lib/supabase';
import { suggestTechnicians } from '@/lib/dispatch';
import { buildStockFitMap, fetchStockFit, stockFitBonus, type StockFitRow } from '@/lib/truckStock';

function formatTime(dateStr: string | null): string {
  if (!dateStr) return 'Unscheduled';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return new Date(dateStr).toDateString() === new Date().toDateString();
}

interface CopilotRecommendation {
  priority: number;
  title: string;
  description: string;
  recommended_action: string;
}

function copilotPriorityStyle(priority: number): { color: string; bgColor: string; borderColor: string } {
  if (priority >= 5) return { color: 'text-danger', bgColor: 'bg-danger/10', borderColor: 'border-l-danger' };
  if (priority >= 3) return { color: 'text-warning-500', bgColor: 'bg-warning-500/10', borderColor: 'border-l-warning-500' };
  return { color: 'text-accent', bgColor: 'bg-accent/10', borderColor: 'border-l-accent' };
}

export function DispatchBoardPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [stockFit, setStockFit] = useState<Record<string, Record<string, StockFitRow>>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
    const [aiDispatchEnabled, setAiDispatchEnabled] = useState(false);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [copilotRecommendations, setCopilotRecommendations] = useState<CopilotRecommendation[] | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [jobsRes, teamRes, profileRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*')
        .in('job_status', ['scheduled', 'en_route', 'in_progress'])
        .order('scheduled_datetime', { ascending: true }),
      supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
      supabase.from('business_profile').select('ai_dispatch_enabled').maybeSingle(),
    ]);
    setAiDispatchEnabled(Boolean((profileRes as { data?: { ai_dispatch_enabled?: boolean } })?.data?.ai_dispatch_enabled));

    if (jobsRes.error || teamRes.error) {
      toast('Failed to load the dispatch board', 'error');
    } else {
      const loadedJobs = (jobsRes.data as Job[]) || [];
      setJobs(loadedJobs);
      void fetchStockFit(loadedJobs.filter((j) => !j.assigned_technician_id).map((j) => j.id)).then((rows) =>
        setStockFit(buildStockFitMap(rows)),
      ); as Job[]) || []);
      setTechnicians((teamRes.data as TeamMember[]) || []);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchAll();
  }, [user, fetchAll]);

  const jobsByTechnician = useMemo(() => {
    const map: Record<string, Job[]> = {};
    jobs.forEach((j) => {
      if (!j.assigned_technician_id) return;
      map[j.assigned_technician_id] = [...(map[j.assigned_technician_id] ?? []), j];
    });
    return map;
  }, [jobs]);

  const unassignedJobs = jobs.filter((j) => !j.assigned_technician_id);
    const handleToggleAiDispatch = async () => {
    const next = !aiDispatchEnabled;
    setAiDispatchEnabled(next);
    await supabase.from('business_profile').update({ ai_dispatch_enabled: next }).eq('user_id', user!.id);
  };

  const handleAutoAssignAll = async () => {
    setAutoAssigning(true);
    const { data, error } = await supabase.functions.invoke('dispatch-auto-assign', { body: {} });
    setAutoAssigning(false);
    if (error || data?.error) {
      toast(data?.error || 'Auto-assign failed', 'error');
      return;
    }
    toast(`Assigned ${data.assigned} of ${data.total} unassigned jobs.`, 'success');
    fetchAll();
  };
  
  const handleAskCopilot = async () => {
    setCopilotLoading(true);
    const { data, error } = await supabase.functions.invoke('dispatch-copilot', { body: {} });
    setCopilotLoading(false);
    if (error || data?.error) {
      toast(data?.error || 'AI Copilot could not analyze the board right now', 'error');
      return;
    }
    setCopilotRecommendations((data?.recommendations as CopilotRecommendation[]) ?? []);
  };

const handleAssign = async (job: Job, technicianId: string) => {
  setAssigning(job.id);

  const { data, error } = await supabase.rpc('assign_technician_to_job', {
    p_job_id: job.id,
    p_technician_id: technicianId,
  });

  if (error || data?.status !== 'assigned') {
    toast(data?.reason || 'Could not assign this job', 'error');
  } else {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === job.id
          ? { ...j, assigned_technician_id: technicianId }
          : j
      )
    );
    toast('Job assigned', 'success');
    const fit = stockFit[job.id]?.[technicianId];
    if (fit && fit.parts_on_van < fit.parts_required) {
      toast(`This technician's truck is missing ${fit.parts_required - fit.parts_on_van} required part(s). Check Parts & Inventory before dispatch.`, 'info');
    }
  }

  setAssigning(null);
};

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Route size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Dispatch Board</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Suggested technician for each unassigned job, ranked by skill match and today's workload.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleAiDispatch}
              className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                aiDispatchEnabled ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'
              }`}
            >
              AI Dispatch: {aiDispatchEnabled ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              onClick={handleAutoAssignAll}
              disabled={autoAssigning || unassignedJobs.length === 0}
              className="focus-ring rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            >
              {autoAssigning ? 'Assigning…' : 'Auto-assign all'}
            </button>
            <button
              type="button"
              onClick={handleAskCopilot}
              disabled={copilotLoading}
              className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              <Brain size={13} />
              {copilotLoading ? 'Thinking…' : 'Ask AI Copilot'}
            </button>
          </div>
        </div>

        {copilotRecommendations !== null && (
          <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">AI Copilot recommendations</h2>
              </div>
              <button
                type="button"
                onClick={() => setCopilotRecommendations(null)}
                className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                aria-label="Dismiss AI Copilot recommendations"
              >
                <X size={14} />
              </button>
            </div>
            {copilotRecommendations.length === 0 ? (
              <p className="text-sm text-text-secondary">Nothing urgent right now — the board looks healthy.</p>
            ) : (
              <div className="space-y-2.5">
                {copilotRecommendations.map((rec, i) => {
                  const style = copilotPriorityStyle(rec.priority);
                  return (
                    <div
                      key={`${rec.title}-${i}`}
                      className={`rounded-xl border border-border border-l-4 ${style.borderColor} bg-bg-primary p-3`}
                    >
                      <p className="text-sm font-semibold text-text-primary">{rec.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-text-secondary">{rec.description}</p>
                      {rec.recommended_action && (
                        <p className={`mt-1.5 text-xs font-medium ${style.color}`}>→ {rec.recommended_action}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {technicians.map((tech) => {
                const load = (jobsByTechnician[tech.id] ?? []).filter((j) => isToday(j.scheduled_datetime)).length;
                const capacity = tech.max_jobs_per_day || 6;
                const pct = Math.min(100, Math.round((load / capacity) * 100));
                return (
                  <div key={tech.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {tech.member_name ?? tech.member_email}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {load}/{capacity} jobs today
                    </p>
                    <div className="mt-2 h-1.5 rounded-full bg-bg-tertiary">
                      <div
                        className={`h-full rounded-full ${pct >= 100 ? 'bg-danger' : 'bg-accent'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <h2 className="mb-3 text-sm font-semibold text-text-primary">Unassigned jobs</h2>
            {unassignedJobs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-12 text-center">
                <Wrench size={28} className="mx-auto mb-3 text-text-secondary" />
                <p className="text-sm text-text-secondary">Every open job has a technician assigned.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {unassignedJobs.map((job) => {
                  const suggestions = suggestTechnicians(job, technicians, jobsByTechnician, stockFit[job.id] ?? {}); 
                  const top = suggestions[0];
                  return (
                    <motion.div
                      key={job.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="rounded-2xl border border-border bg-bg-secondary p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-text-primary">{job.customer_name}</p>
                          <p className="text-xs text-text-secondary">
                            {job.service_type ?? 'Unspecified service'} · {formatTime(job.scheduled_datetime)}
                          </p>
                          {job.address && <p className="text-xs text-text-secondary/70">{job.address}</p>}
                                                    {job.dispatch_note && (
                            <p className="mt-1 text-xs italic text-accent/80">{job.dispatch_note}</p>
                          )}
                        </div>
                        {top && (
                          <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                            <Sparkles size={11} /> {top.technician.member_name ?? top.technician.member_email}
                          </span>
                        )}
                      </div>

                      {suggestions.length === 0 ? (
                        <p className="mt-3 text-xs text-text-secondary">
                          No available technician — everyone's at capacity or dispatch is off for the team.
                        </p>
                      ) : (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {suggestions.map((s) => (
                            <button
                              key={s.technician.id}
                              type="button"
                              disabled={assigning === job.id}
                              onClick={() => handleAssign(job, s.technician.id)}
                              title={s.reasons.join(' · ')}
                              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
                            >
                              {s.technician.member_name ?? s.technician.member_email}
                              {stockFitBonus(stockFit[job.id]?.[s.technician.id]) >= 12 && (
                               <PackageCheck size={12} className="ml-1 inline text-success-500" aria-label="Truck has all required parts" />
                                )}
                            </button>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
