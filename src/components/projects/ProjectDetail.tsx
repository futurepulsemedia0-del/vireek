import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FolderKanban, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { deleteProject, fetchProjectBundle, setProjectStatus, type ProjectBundle } from '@/lib/installProjectsApi';
import {
  PROJECT_STATUS_LABEL,
  PROJECT_TYPE_LABEL,
  SCHEDULE_LABEL,
  friendlyError,
  scheduleHealth,
  todayIso,
  type ProjectStatus,
} from '@/lib/installProjects';
import { BillingTab } from './BillingTab';
import { JobsTab } from './JobsTab';
import { MaterialsTab } from './MaterialsTab';
import { OverviewTab } from './OverviewTab';
import { PhasesTab } from './PhasesTab';
import { Pill, projectStatusTone, scheduleTone, useAction, useConfirm } from './projectUi';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'phases', label: 'Phases' },
  { key: 'billing', label: 'Billing' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'materials', label: 'Materials' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function ProjectDetail({ ownerId, projectId }: { ownerId: string; projectId: string }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const { ask, dialog } = useConfirm();
  const today = todayIso();

  const load = useCallback(async () => {
    try {
      const b = await fetchProjectBundle(ownerId, projectId);
      setBundle(b);
      setState(b ? 'ready' : 'missing');
    } catch (e) {
      toast(friendlyError(e, 'Could not load this project.'), 'error');
      setState((s) => (s === 'ready' ? s : 'error'));
    }
  }, [ownerId, projectId, toast]);

  useEffect(() => {
    setState('loading');
    void load();
  }, [load]);

  const refresh = useCallback(async () => { await load(); }, [load]);
  const { busyKey, run } = useAction(refresh);

  const tabParam = params.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview';
  const health = useMemo(() => (bundle ? scheduleHealth(bundle.project, bundle.phases, bundle.milestones, today) : null), [bundle, today]);

  if (state === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading project">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-40" />
        <SkeletonCard rows={3} />
        <SkeletonCard rows={2} />
      </div>
    );
  }
  if (state === 'error') return <EmptyStateError icon={FolderKanban} title="Could not load this project" onRetry={() => { setState('loading'); void load(); }} />;
  if (state === 'missing' || !bundle || !health) {
    return <EmptyState icon={FolderKanban} title="Project not found" description="It may have been deleted, or it belongs to a different account." action={{ label: 'Back to projects', onClick: () => navigate('/dashboard/projects') }} />;
  }

  const { project, milestones } = bundle;
  const pending = milestones.filter((m) => m.status === 'pending').length;
  const changeStatus = (status: ProjectStatus, success: string) => run('status', () => setProjectStatus(ownerId, project.id, status), success);

  const actions: { label: string; variant: 'primary' | 'secondary'; onClick: () => void }[] = [];
  if (project.status === 'planning') actions.push({ label: 'Start project', variant: 'primary', onClick: () => void changeStatus('active', 'Project started.') });
  if (project.status === 'active') {
    actions.push({
      label: 'Mark completed',
      variant: 'primary',
      onClick: () =>
        pending > 0
          ? ask({ title: 'Complete with open milestones?', description: `${pending} milestone${pending === 1 ? ' is' : 's are'} still pending. The project will be marked completed anyway.`, label: 'Mark completed', onConfirm: () => changeStatus('completed', 'Project completed.') })
          : void changeStatus('completed', 'Project completed.'),
    });
    actions.push({ label: 'Put on hold', variant: 'secondary', onClick: () => void changeStatus('on_hold', 'Project put on hold.') });
  }
  if (project.status === 'on_hold') actions.push({ label: 'Resume', variant: 'primary', onClick: () => void changeStatus('active', 'Project resumed.') });
  if (project.status === 'completed' || project.status === 'cancelled') actions.push({ label: 'Reopen', variant: 'secondary', onClick: () => void changeStatus('active', 'Project reopened.') });
  if (project.status !== 'cancelled' && project.status !== 'completed') {
    actions.push({ label: 'Cancel project', variant: 'secondary', onClick: () => ask({ title: 'Cancel this project?', description: 'Invoicing is disabled for cancelled projects. You can reopen it later.', label: 'Cancel project', onConfirm: () => changeStatus('cancelled', 'Project cancelled.') }) });
  }

  const tabProps = { ownerId, bundle, today, onChanged: refresh };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/dashboard/projects" className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"><ArrowLeft size={14} aria-hidden="true" /> All projects</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-text-primary sm:text-2xl">{project.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">{project.project_number} · {project.customer_name} · {PROJECT_TYPE_LABEL[project.project_type]}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Pill tone={projectStatusTone[project.status]}>{PROJECT_STATUS_LABEL[project.status]}</Pill>
              {project.status === 'active' && <Pill tone={scheduleTone[health.state]}>{SCHEDULE_LABEL[health.state]}</Pill>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((a) => <Button key={a.label} size="sm" variant={a.variant} disabled={busyKey === 'status'} onClick={a.onClick}>{a.label}</Button>)}
            <button type="button" aria-label="Delete project" onClick={() => ask({ title: 'Delete this project?', description: 'Phases, milestones, billing steps, links and materials are deleted permanently. Invoices already created stay in Invoicing.', label: 'Delete project', confirmPhrase: 'delete project', onConfirm: async () => { const ok = await run('delete', () => deleteProject(ownerId, project.id), 'Project deleted.'); if (ok) navigate('/dashboard/projects'); } })} className="focus-ring rounded-xl p-2.5 text-text-secondary hover:bg-bg-tertiary hover:text-danger-500"><Trash2 size={18} aria-hidden="true" /></button>
          </div>
        </div>
      </div>

      <div role="tablist" aria-label="Project sections" className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            type="button"
            onClick={() => setParams(t.key === 'overview' ? {} : { tab: t.key }, { replace: true })}
            className={`focus-ring -mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === t.key ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <OverviewTab {...tabProps} />}
        {tab === 'phases' && <PhasesTab {...tabProps} />}
        {tab === 'billing' && <BillingTab {...tabProps} />}
        {tab === 'jobs' && <JobsTab {...tabProps} />}
        {tab === 'materials' && <MaterialsTab {...tabProps} />}
      </div>
      {dialog}
    </div>
  );
}
