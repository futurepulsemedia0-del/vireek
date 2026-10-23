import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Circle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { formatDate, phaseProgress, projectProgress, scheduleHealth, todayIso, PROJECT_TYPE_LABEL } from '@/lib/installProjects';
import { CUSTOMER_STATE_LABEL, barGeometry, currentWindows, customerHeadline, customerPhaseStates, projectedFinish, timelineRange, type CustomerPhaseState } from '@/lib/projectScheduler';
import { fetchPublicProgress, type PublicProgress } from '@/lib/projectSchedulerApi';

const POLL_MS = 60_000;
const TONE: Record<CustomerPhaseState, string> = {
  done: 'bg-success-500/10 text-success-500',
  active: 'bg-accent/10 text-accent',
  next: 'bg-warning-500/15 text-warning-500',
  upcoming: 'bg-bg-tertiary text-text-secondary',
  delayed: 'bg-danger-500/15 text-danger-500',
};

export function ProjectProgressPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicProgress | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');

  const load = useCallback(async () => {
    const res = await fetchPublicProgress(token);
    if (res.kind === 'ok') { setData(res.data); setStatus('ready'); }
    else if (res.kind === 'not_found') { setData(null); setStatus('not_found'); }
    else setStatus((s) => (s === 'ready' ? s : 'error')); // a failed poll never wipes what we already showed
  }, [token]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow, noarchive';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  const view = useMemo(() => {
    if (!data) return null;
    const today = todayIso();
    const progress = projectProgress(data.project, data.phases, data.milestones);
    const health = scheduleHealth(data.project, data.phases, data.milestones, today);
    const windows = currentWindows(data.phases);
    const finish = data.showDates ? projectedFinish(windows) ?? data.project.target_end_date : null;
    const states = customerPhaseStates([...data.phases], (p) => phaseProgress(p, data.milestones));
    const range = windows.size ? timelineRange([...windows.values()], today, { padDays: 3, minDays: 14 }) : null;
    return { today, progress, windows, states, range, headline: customerHeadline({ status: data.project.status, progress, schedule: health, finish, showDates: data.showDates }) };
  }, [data]);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10">
        <div className="mx-auto max-w-3xl space-y-6">
          {status === 'loading' && <div className="space-y-4" aria-busy="true" aria-label="Loading project progress"><Skeleton className="h-8 w-64" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>}
          {status === 'not_found' && (
            <div role="alert" className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
              <AlertCircle className="mx-auto mb-3 text-text-secondary" aria-hidden="true" />
              <h1 className="text-lg font-semibold text-text-primary">This progress link isn’t available</h1>
              <p className="mt-1 text-sm text-text-secondary">It may have been turned off or replaced. Please ask your contractor for a new link.</p>
            </div>
          )}
          {status === 'error' && (
            <div role="alert" className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
              <h1 className="text-lg font-semibold text-text-primary">We couldn’t load your project</h1>
              <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
              <Button className="mt-4" size="sm" onClick={() => { setStatus('loading'); void load(); }}>Try again</Button>
            </div>
          )}
          {status === 'ready' && data && view && (
            <>
              <header>
                {data.businessName && <p className="text-sm text-text-secondary">{data.businessName}</p>}
                <h1 className="text-2xl font-bold text-text-primary">{data.project.name}</h1>
                <p className="text-sm text-text-secondary">{PROJECT_TYPE_LABEL[data.project.project_type]}</p>
              </header>

              <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Overall progress">
                <p className="text-base font-medium text-text-primary">{view.headline}</p>
                <div role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.progress} className="mt-3 h-3 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${view.progress}%` }} />
                </div>
              </section>

              {data.showDates && view.range && (
                <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Timeline">
                  <h2 className="mb-3 text-sm font-semibold text-text-primary">Timeline</h2>
                  <div className="space-y-2">
                    {[...data.phases].sort((a, b) => a.sort_order - b.sort_order).map((p) => {
                      const w = view.windows.get(p.id);
                      const px = 100 / view.range!.days;
                      const g = w ? barGeometry(view.range!, w, px) : null;
                      return (
                        <div key={p.id} className="grid grid-cols-[110px_1fr] items-center gap-2 sm:grid-cols-[160px_1fr]">
                          <span className="truncate text-xs text-text-secondary">{p.name}</span>
                          <div className="relative h-4 rounded bg-bg-tertiary" aria-hidden="true">
                            {g && <div className={`absolute inset-y-0 rounded ${p.status === 'completed' ? 'bg-success-500' : p.status === 'in_progress' ? 'bg-accent' : 'bg-accent/40'}`} style={{ left: `${g.left}%`, width: `${Math.max(g.width, 1.5)}%` }} />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section aria-label="Phases" className="space-y-3">
                <h2 className="text-sm font-semibold text-text-primary">Phases</h2>
                {[...data.phases].sort((a, b) => a.sort_order - b.sort_order).map((p) => {
                  const st = view.states.get(p.id)!;
                  const items = data.milestones.filter((m) => m.phase_id === p.id).sort((a, b) => a.sort_order - b.sort_order);
                  const w = view.windows.get(p.id);
                  return (
                    <article key={p.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-text-primary">{p.name}</h3>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[st.state]}`}>{CUSTOMER_STATE_LABEL[st.state]}</span>
                      </div>
                      {data.showDates && w && <p className="mt-0.5 text-xs text-text-secondary">{formatDate(w.start)} – {formatDate(w.end)}</p>}
                      <div role="progressbar" aria-label={`${p.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.percent} className="mt-2 h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
                        <div className={`h-full rounded-full ${st.state === 'done' ? 'bg-success-500' : 'bg-accent'}`} style={{ width: `${st.percent}%` }} />
                      </div>
                      {items.length > 0 && (
                        <ul className="mt-3 space-y-1.5">
                          {items.map((m) => (
                            <li key={m.id} className="flex items-center gap-2 text-sm">
                              {m.status === 'done' ? <CheckCircle2 size={16} className="shrink-0 text-success-500" aria-label="Done" /> : <Circle size={16} className="shrink-0 text-text-secondary" aria-label={m.status === 'skipped' ? 'Skipped' : 'Pending'} />}
                              <span className={m.status === 'done' || m.status === 'skipped' ? 'text-text-secondary line-through' : 'text-text-primary'}>{m.title}</span>
                              {data.showDates && m.due_date && m.status === 'pending' && <span className="ml-auto text-xs text-text-secondary">{formatDate(m.due_date)}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </article>
                  );
                })}
                {data.phases.length === 0 && <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-center text-sm text-text-secondary">Your contractor hasn’t added the project phases yet.</p>}
              </section>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
