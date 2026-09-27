import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronRight, MapPin } from 'lucide-react';
import { fetchTodayJobs, formatTime, STATUS_LABELS, TechnicianJob } from '@/lib/technicianOS';

const STATUS_DOT: Record<string, string> = {
  scheduled: 'bg-accent',
  en_route: 'bg-blue-500',
  in_progress: 'bg-warning-500',
  completed: 'bg-success-500',
};

export function TechnicianTodayPage() {
  const [jobs, setJobs] = useState<TechnicianJob[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchTodayJobs()
      .then(setJobs)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <h1 className="text-lg font-semibold text-text-primary">Today</h1>
        <p className="text-sm text-text-secondary">{jobs.length} job{jobs.length === 1 ? '' : 's'} scheduled</p>
      </header>

      <main className="mx-auto max-w-lg px-4 py-4">
        {loading && <p className="py-10 text-center text-text-secondary">Loading…</p>}
        {!loading && jobs.length === 0 && (
          <p className="py-10 text-center text-text-secondary">No jobs scheduled for today.</p>
        )}

        <ul className="space-y-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                onClick={() => navigate(`/tech/job/${job.id}`)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-bg-secondary p-4 text-left active:scale-[0.98]"
              >
                <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${STATUS_DOT[job.job_status]}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">{formatTime(job.scheduled_datetime)}</span>
                    {job.safety_flag && <AlertTriangle className="h-4 w-4 text-danger" />}
                  </div>
                  <p className="truncate text-sm text-text-primary">{job.customer_name}</p>
                  <p className="truncate text-xs text-text-secondary">{job.service_type || '—'}</p>
                  {job.address && (
                    <p className="mt-1 flex items-center gap-1 truncate text-xs text-text-secondary">
                      <MapPin className="h-3 w-3 flex-shrink-0" /> {job.address}
                    </p>
                  )}
                  <span className="mt-1 inline-block text-xs font-medium text-accent">{STATUS_LABELS[job.job_status]}</span>
                </div>
                <ChevronRight className="h-5 w-5 flex-shrink-0 text-text-secondary" />
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
