import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FolderKanban, Lock, Plus, Search } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProjectDetail } from '@/components/projects/ProjectDetail';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { Pill, ProgressBar, Stat, panelClass, projectStatusTone, scheduleTone } from '@/components/projects/projectUi';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { createProject, fetchCustomerOptions, fetchPortfolio, type CustomerOption, type Portfolio } from '@/lib/installProjectsApi';
import {
  PROJECT_STATUS_LABEL,
  PROJECT_TYPE_LABEL,
  SCHEDULE_LABEL,
  formatDate,
  formatMoney,
  friendlyError,
  type ProjectFormValues,
  type ProjectStatus,
} from '@/lib/installProjects';

type Filter = 'open' | 'all' | ProjectStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'planning', label: 'Planning' },
  { key: 'active', label: 'Active' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

function ProjectList({ ownerId }: { ownerId: string }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<Portfolio | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await fetchPortfolio(ownerId));
    } catch (e) {
      setFailed(true);
      toast(friendlyError(e, 'Could not load projects.'), 'error');
    }
  }, [ownerId, toast]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setCreating(true);
    fetchCustomerOptions(ownerId).then(setCustomers).catch(() => toast('Customers could not be loaded — you can still type a name.', 'info'));
  };

  const create = async (v: ProjectFormValues) => {
    setSaving(true);
    try {
      const id = await createProject(ownerId, v);
      toast('Project created.', 'success');
      navigate(`/dashboard/projects/${id}`);
    } catch (e) {
      toast(friendlyError(e, 'Could not create the project.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const projects = data?.projects ?? [];
  const rollups = data?.rollups ?? {};

  const kpis = useMemo(() => {
    const open = projects.filter((p) => p.status === 'planning' || p.status === 'active' || p.status === 'on_hold');
    return {
      openCount: open.length,
      pipeline: open.reduce((s, p) => s + p.contract_value_cents, 0),
      outstanding: projects.reduce((s, p) => s + (rollups[p.id]?.billing.outstandingCents ?? 0), 0),
      overdue: projects.reduce((s, p) => s + (rollups[p.id]?.billing.overdueCents ?? 0), 0),
      late: open.filter((p) => rollups[p.id]?.schedule.state === 'late').length,
    };
  }, [projects, rollups]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (filter === 'open' ? p.status === 'completed' || p.status === 'cancelled' : filter !== 'all' && p.status !== filter) return false;
      return !q || `${p.name} ${p.customer_name} ${p.project_number ?? ''} ${p.site_address ?? ''}`.toLowerCase().includes(q);
    });
  }, [projects, filter, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Install Projects</h1>
          <p className="mt-1 text-sm text-text-secondary">Multi-phase installs with milestones, progress billing, linked jobs and materials.</p>
        </div>
        {!creating && <Button size="sm" onClick={openCreate}><Plus size={16} aria-hidden="true" /> New project</Button>}
      </div>

      {creating && <ProjectForm mode="create" customers={customers} submitting={saving} onSubmit={create} onCancel={() => setCreating(false)} />}

      {failed ? (
        <EmptyStateError icon={FolderKanban} title="Could not load projects" onRetry={() => void load()} />
      ) : data === null ? (
        <div aria-busy="true" aria-label="Loading projects" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
          <SkeletonCard rows={2} /><SkeletonCard rows={2} />
        </div>
      ) : projects.length === 0 ? (
        !creating && <EmptyState icon={FolderKanban} title="No projects yet" description="Track big installs end to end: phases, milestones, progress invoices, linked jobs and materials." action={{ label: 'Create your first project', onClick: openCreate }} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Open projects" value={kpis.openCount} hint={kpis.late > 0 ? `${kpis.late} running late` : 'None running late'} tone={kpis.late > 0 ? 'warning' : undefined} />
            <Stat label="Open contract value" value={formatMoney(kpis.pipeline, true)} />
            <Stat label="Outstanding invoices" value={formatMoney(kpis.outstanding, true)} />
            <Stat label="Overdue" value={formatMoney(kpis.overdue, true)} tone={kpis.overdue > 0 ? 'danger' : undefined} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
              ))}
            </div>
            <div className="w-full sm:ml-auto sm:w-64"><Input aria-label="Search projects" icon={Search} placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} className="py-2 text-sm" /></div>
          </div>

          {visible.length === 0 ? (
            <EmptyState icon={FolderKanban} title="Nothing matches" description="Try a different status filter or search term." secondaryAction={{ label: 'Clear filters', onClick: () => { setFilter('all'); setQuery(''); } }} />
          ) : (
            <ul className="space-y-3">
              {visible.map((p) => {
                const r = rollups[p.id];
                return (
                  <li key={p.id}>
                    <Link to={`/dashboard/projects/${p.id}`} className={`${panelClass} focus-ring block transition-colors hover:border-accent/40`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-base font-semibold text-text-primary">{p.name}</p>
                          <p className="truncate text-sm text-text-secondary">{p.project_number} · {p.customer_name} · {PROJECT_TYPE_LABEL[p.project_type]}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {p.status === 'active' && r && <Pill tone={scheduleTone[r.schedule.state]}>{SCHEDULE_LABEL[r.schedule.state]}</Pill>}
                          <Pill tone={projectStatusTone[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Pill>
                        </div>
                      </div>
                      {r && (
                        <div className="mt-3 space-y-3">
                          <div>
                            <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>{r.progress}% complete</span><span>{Math.round(r.billing.billedPercent)}% invoiced</span></div>
                            <ProgressBar value={r.progress} label={`${p.name} progress`} tone={r.schedule.state === 'late' ? 'danger' : r.schedule.state === 'at_risk' ? 'warning' : r.progress === 100 ? 'success' : 'info'} />
                          </div>
                          <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 text-xs text-text-secondary">
                            <span>Contract <span className="font-semibold text-text-primary">{formatMoney(p.contract_value_cents, true)}</span></span>
                            <span>Next: <span className="text-text-primary">{r.nextMilestone ? `${r.nextMilestone.title}${r.nextMilestone.due_date ? ` · ${formatDate(r.nextMilestone.due_date)}` : ''}` : '—'}</span></span>
                            {r.billing.overdueCents > 0 && <span className="font-semibold text-danger-500">{formatMoney(r.billing.overdueCents)} overdue</span>}
                          </div>
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function InstallProjectsPage() {
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  const { projectId } = useParams<{ projectId: string }>();
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  return (
    <DashboardLayout activeLabel="Install Projects">
      {loading || profileLoading ? (
        <div aria-busy="true" className="space-y-4"><Skeleton className="h-8 w-56" /><SkeletonCard rows={2} /></div>
      ) : !canAccess ? (
        <EmptyState icon={Lock} title="Projects are limited to billing access" description="Ask the account owner for the “view billing” permission to manage install projects and progress billing." />
      ) : !ownerId ? (
        <EmptyStateError icon={FolderKanban} title="Account not ready" description="We couldn't determine which account this belongs to. Refresh the page or sign in again." />
      ) : projectId ? (
        <ProjectDetail key={projectId} ownerId={ownerId} projectId={projectId} />
      ) : (
        <ProjectList ownerId={ownerId} />
      )}
    </DashboardLayout>
  );
}
