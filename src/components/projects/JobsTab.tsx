import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Unlink, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { fetchLinkableJobs, linkJob, unlinkJob } from '@/lib/installProjectsApi';
import { formatDate, friendlyError } from '@/lib/installProjects';
import { Pill, SectionHeader, panelClass, selectClass, useAction, useConfirm, type TabProps } from './projectUi';

type Linkable = Awaited<ReturnType<typeof fetchLinkableJobs>>;

const jobTone = (s: string) => (s === 'completed' ? 'success' : s === 'cancelled' ? 'danger' : s === 'in_progress' || s === 'en_route' ? 'info' : 'neutral');

export function JobsTab({ ownerId, bundle, onChanged }: TabProps) {
  const { project, phases, jobs } = bundle;
  const { toast } = useToast();
  const { busyKey, run } = useAction(onChanged);
  const { ask, dialog } = useConfirm();
  const [options, setOptions] = useState<Linkable | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [jobId, setJobId] = useState('');
  const [phaseId, setPhaseId] = useState('');

  const loadOptions = async () => {
    setLoadFailed(false);
    try {
      setOptions(await fetchLinkableJobs(ownerId));
    } catch (e) {
      setLoadFailed(true);
      toast(friendlyError(e, 'Could not load jobs.'), 'error');
    }
  };

  // Re-query after every link/unlink so the picker never offers a job that is already attached.
  useEffect(() => {
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, jobs.length]);

  const attach = async () => {
    if (!jobId) return;
    const ok = await run('link', () => linkJob(ownerId, project.id, jobId, phaseId), 'Job linked.');
    if (ok) { setJobId(''); setPhaseId(''); }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Linked jobs"
        description="Visits, crews and service calls that belong to this install. A job can belong to one project."
        action={<Link to="/dashboard/jobs" className="text-sm font-medium text-accent underline-offset-2 hover:underline">Open Jobs to schedule a visit</Link>}
      />
      {jobs.length === 0 ? (
        <EmptyState icon={Wrench} title="No jobs linked yet" description="Link existing jobs so site visits, inspections and crew time roll up under this project." />
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.link_id} className={`${panelClass} flex flex-wrap items-center justify-between gap-3`}>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''}</p>
                <p className="truncate text-xs text-text-secondary">
                  {j.scheduled_datetime ? formatDate(j.scheduled_datetime) : 'Not scheduled'}
                  {j.address ? ` · ${j.address}` : ''}
                  {j.phase_id ? ` · ${phases.find((p) => p.id === j.phase_id)?.name ?? ''}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={jobTone(j.job_status)}>{j.job_status.replace(/_/g, ' ')}</Pill>
                <button type="button" aria-label={`Unlink job for ${j.customer_name}`} onClick={() => ask({ title: 'Unlink job?', description: 'The job itself is not deleted — it just stops counting toward this project.', label: 'Unlink', onConfirm: () => run(`unlink-${j.link_id}`, () => unlinkJob(ownerId, j.link_id), 'Job unlinked.') })} disabled={busyKey === `unlink-${j.link_id}`} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500">
                  <Unlink size={16} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className={`${panelClass} space-y-3`}>
        <h3 className="text-sm font-semibold text-text-primary">Link an existing job</h3>
        {options === null && !loadFailed ? (
          <Skeleton className="h-10 w-full" />
        ) : loadFailed ? (
          <p className="text-sm text-text-secondary">Jobs could not be loaded. <button type="button" onClick={loadOptions} className="font-medium text-accent hover:underline">Try again</button></p>
        ) : options && options.length === 0 ? (
          <p className="text-sm text-text-secondary">Every recent job is already linked to a project.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <select aria-label="Job" className={selectClass} value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Choose a job…</option>
              {options?.map((j) => (
                <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''}{j.scheduled_datetime ? ` · ${formatDate(j.scheduled_datetime)}` : ''}</option>
              ))}
            </select>
            <select aria-label="Phase" className={selectClass} value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
              <option value="">Any phase</option>
              {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <Button size="sm" onClick={attach} disabled={!jobId || busyKey === 'link'}><Link2 size={14} aria-hidden="true" /> Link job</Button>
          </div>
        )}
      </section>
      {dialog}
    </div>
  );
}
