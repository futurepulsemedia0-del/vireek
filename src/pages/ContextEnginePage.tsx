import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Radar, Sparkles } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { JobContextPanel } from '@/components/jobs/JobContextPanel';
import { useToast } from '@/contexts/ToastContext';
import { supabase, type Job } from '@/lib/supabase';
import {
  RISK_META,
  fetchLatestContextsForJobs,
  isStale,
  requestJobContext,
  type JobContextSnapshot,
} from '@/lib/jobContext';

const HORIZON_DAYS = 7;
const MAX_JOBS = 60;

export function ContextEnginePage() {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [snapshots, setSnapshots] = useState<Map<string, JobContextSnapshot>>(new Map());
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const to = new Date(Date.now() + HORIZON_DAYS * 24 * 3_600_000).toISOString();
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .in('job_status', ['scheduled', 'en_route'])
        .gte('scheduled_datetime', from)
        .lte('scheduled_datetime', to)
        .order('scheduled_datetime', { ascending: true })
        .limit(MAX_JOBS);
      if (error) throw error;
      const list = (data ?? []) as Job[];
      setJobs(list);
      setSnapshots(await fetchLatestContextsForJobs(list.map((j) => j.id)));
    } catch {
      toast('Failed to load upcoming jobs', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Risk first: lowest readiness at the top, jobs without context next, then the ready ones.
  const sorted = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const sa = snapshots.get(a.id)?.readiness_score ?? 50;
        const sb = snapshots.get(b.id)?.readiness_score ?? 50;
        return sa - sb;
      }),
    [jobs, snapshots],
  );

  const needing = useMemo(() => jobs.filter((j) => { const s = snapshots.get(j.id); return !s || isStale(s); }), [jobs, snapshots]);

  const buildAll = useCallback(async () => {
    if (!needing.length) return;
    setBulk({ done: 0, total: needing.length });
    let failed = 0;
    for (let i = 0; i < needing.length; i++) {
      try {
        const { snapshot } = await requestJobContext(needing[i].id, { skipAi: true });
        setSnapshots((prev) => new Map(prev).set(snapshot.job_id, snapshot));
      } catch {
        failed++;
      }
      setBulk({ done: i + 1, total: needing.length });
    }
    setBulk(null);
    toast(failed ? `Context built, ${failed} job${failed === 1 ? '' : 's'} failed` : 'Context built for upcoming jobs', failed ? 'error' : 'success');
  }, [needing, toast]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Radar size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Real-World Context Engine</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Before a technician leaves, Vireek connects the customer, property, weather, equipment, history, permits, parts and technician into one
              Context Graph, so you dispatch knowing the real situation.
            </p>
          </div>
        </div>

        <Card className="mb-6 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Next {HORIZON_DAYS} days</h2>
              <p className="mt-1 text-xs text-text-secondary">
                {needing.length} job{needing.length === 1 ? '' : 's'} without fresh context. Bulk builds skip the AI brief to keep it fast; open a job for the full brief.
              </p>
            </div>
            <Button size="sm" onClick={buildAll} disabled={!!bulk || loading || needing.length === 0}>
              {bulk ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {bulk ? `Building ${bulk.done}/${bulk.total}…` : 'Build missing context'}
            </Button>
          </div>
        </Card>

        {loading ? (
          <p className="text-sm text-text-secondary">Loading…</p>
        ) : sorted.length === 0 ? (
          <Card className="p-6">
            <p className="text-sm text-text-secondary">No scheduled jobs in the next {HORIZON_DAYS} days.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {sorted.map((job) => {
              const snap = snapshots.get(job.id);
              const open = openId === job.id;
              const top = snap?.flags.find((f) => f.severity === 'critical' || f.severity === 'risk');
              return (
                <li key={job.id} className="rounded-2xl border border-border bg-bg-secondary">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : job.id)}
                    aria-expanded={open}
                    className="focus-ring flex w-full items-center gap-4 rounded-2xl px-4 py-3 text-left"
                  >
                    <span
                      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-current text-sm font-bold ${snap ? RISK_META[snap.risk_level].text : 'text-text-secondary'}`}
                      aria-label={snap ? `Readiness ${snap.readiness_score} out of 100` : 'No context yet'}
                    >
                      {snap ? snap.readiness_score : '—'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-text-primary">
                        {job.customer_name}{job.service_type ? ` · ${job.service_type}` : ''}
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        {job.scheduled_datetime ? new Date(job.scheduled_datetime).toLocaleString() : 'Unscheduled'}
                        {snap ? ` · ${RISK_META[snap.risk_level].label}` : ' · context not built yet'}
                        {snap && isStale(snap) ? ' · out of date' : ''}
                      </span>
                      {top && <span className="mt-0.5 block truncate text-xs text-danger">{top.title}</span>}
                    </span>
                    <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  {open && (
                    <div className="border-t border-border p-4">
                      <JobContextPanel key={`${job.id}-${snap?.id ?? 'none'}`} job={job} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DashboardLayout>
  );
}
