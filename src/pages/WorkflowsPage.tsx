/**
 * Call-to-Cash Workflow Engine — /dashboard/workflows
 *
 * Four views on one page: the built-in playbook catalog (install a
 * pre-built automation in one click), the business's installed
 * workflows (pause/resume/archive), a live feed of runs in flight, and
 * a queue of steps waiting on a human decision.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Workflow as WorkflowIcon,
  X,
  XCircle,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  approveStep,
  cancelRun,
  computeStats,
  fetchDefinitions,
  fetchPendingApprovals,
  fetchRuns,
  fetchRunSteps,
  installPlaybook,
  rejectStep,
  setWorkflowStatus,
  STATUS_COLORS,
  STATUS_LABELS,
  TRIGGER_EVENT_LABELS,
} from '@/lib/workflowEngine';
import type { WorkflowApproval, WorkflowDefinition, WorkflowRun, WorkflowRunStep } from '@/lib/workflowEngine';
import { WORKFLOW_PLAYBOOKS } from '@/lib/workflowPlaybooks';

type TabKey = 'catalog' | 'installed' | 'runs' | 'approvals';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'catalog', label: 'Playbook Catalog' },
  { key: 'installed', label: 'My Workflows' },
  { key: 'runs', label: 'Runs' },
  { key: 'approvals', label: 'Approvals' },
];

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ size?: number; className?: string }> }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-secondary">{label}</span>
        <Icon size={18} className="text-text-secondary" />
      </div>
      <p className="mt-2 text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function StepTypePill({ type }: { type: string }) {
  const labels: Record<string, string> = {
    sms: 'Text', call: 'Call', wait: 'Wait', webhook: 'Webhook',
    human_approval: 'Approval', condition_gate: 'Check',
  };
  return <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">{labels[type] ?? type}</span>;
}

function StepStatusIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <CheckCircle2 size={16} className="text-success-500" />;
  if (status === 'failed') return <XCircle size={16} className="text-danger" />;
  if (status === 'running') return <Loader2 size={16} className="animate-spin text-accent-500" />;
  if (status === 'awaiting_approval') return <Clock size={16} className="text-warning-500" />;
  if (status === 'skipped') return <X size={16} className="text-text-secondary" />;
  return <Clock size={16} className="text-text-secondary/60" />;
}

// ============================================================
// CATALOG TAB
// ============================================================

function CatalogTab({ installedSlugs, onInstall }: { installedSlugs: Set<string>; onInstall: (slug: string) => void }) {
  const [installing, setInstalling] = useState<string | null>(null);
  const { toast } = useToast();

  const handleInstall = async (slug: string) => {
    const playbook = WORKFLOW_PLAYBOOKS.find((p) => p.slug === slug);
    if (!playbook) return;
    setInstalling(slug);
    try {
      await installPlaybook(playbook);
      toast(`${playbook.name} installed — it will start enrolling matching events right away.`, 'success');
      onInstall(slug);
    } catch (err) {
      toast(`Could not install playbook: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {WORKFLOW_PLAYBOOKS.map((playbook) => {
        const Icon = playbook.icon;
        const installed = installedSlugs.has(playbook.slug);
        return (
          <div key={playbook.slug} className="flex flex-col rounded-2xl border border-border bg-bg-secondary p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-accent-500/10 p-2.5 text-accent-500"><Icon size={20} /></div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{playbook.category}</p>
                <h3 className="mt-0.5 font-semibold text-text-primary">{playbook.name}</h3>
              </div>
            </div>
            <p className="mt-3 text-sm italic text-text-secondary">{playbook.tagline}</p>
            <p className="mt-2 flex-1 text-sm text-text-secondary">{playbook.description}</p>
            <div className="mt-3 rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
              Trigger: {TRIGGER_EVENT_LABELS[playbook.trigger_event]} &middot; {playbook.steps.length} steps
            </div>
            <button
              type="button"
              disabled={installed || installing === playbook.slug}
              onClick={() => handleInstall(playbook.slug)}
              className={`focus-ring mt-4 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                installed ? 'cursor-default bg-success-500/10 text-success-500' : 'bg-accent-500 text-white hover:bg-accent-600'
              }`}
            >
              {installing === playbook.slug ? <Loader2 size={16} className="animate-spin" /> : installed ? <CheckCircle2 size={16} /> : <Sparkles size={16} />}
              {installed ? 'Installed' : 'Install Playbook'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// INSTALLED TAB
// ============================================================

function InstalledTab({ definitions, onChanged }: { definitions: WorkflowDefinition[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = async (def: WorkflowDefinition) => {
    const next = def.status === 'active' ? 'paused' : 'active';
    setBusyId(def.id);
    const ok = await setWorkflowStatus(def.id, next);
    setBusyId(null);
    if (ok) { toast(`${def.name} ${next === 'active' ? 'resumed' : 'paused'}`, 'success'); onChanged(); }
    else toast('Could not update workflow', 'error');
  };

  if (definitions.length === 0) {
    return <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">No workflows installed yet — start from the Playbook Catalog tab.</p>;
  }

  return (
    <div className="space-y-3">
      {definitions.map((def) => (
        <div key={def.id} className="flex items-center justify-between rounded-2xl border border-border bg-bg-secondary p-4">
          <div>
            <p className="font-medium text-text-primary">{def.name}</p>
            <p className="text-xs text-text-secondary">Trigger: {TRIGGER_EVENT_LABELS[def.trigger_event]} &middot; v{def.active_version ?? '—'}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${def.status === 'active' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
              {def.status}
            </span>
            <button
              type="button"
              disabled={busyId === def.id}
              onClick={() => toggle(def)}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
            >
              {def.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
              {def.status === 'active' ? 'Pause' : 'Resume'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// RUNS TAB
// ============================================================

function RunRow({ run, onCancelled }: { run: WorkflowRun; onCancelled: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<WorkflowRunStep[] | null>(null);
  const [loadingSteps, setLoadingSteps] = useState(false);

  const toggleOpen = async () => {
    setOpen((v) => !v);
    if (!steps && !loadingSteps) {
      setLoadingSteps(true);
      try { setSteps(await fetchRunSteps(run.id)); } finally { setLoadingSteps(false); }
    }
  };

  const handleCancel = async () => {
    const ok = await cancelRun(run.id);
    if (ok) { toast('Run cancelled', 'success'); onCancelled(); }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={toggleOpen} className="focus-ring flex w-full items-center justify-between gap-3 p-4 text-left">
        <div className="min-w-0">
          <p className="truncate font-medium text-text-primary">{run.customer_name ?? 'Unknown customer'}</p>
          <p className="text-xs text-text-secondary">Step {run.current_step_number} &middot; started {new Date(run.started_at).toLocaleString()}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[run.status]}`}>{STATUS_LABELS[run.status]}</span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>
      {open && (
        <div className="border-t border-border p-4">
          {loadingSteps && <Loader2 size={16} className="animate-spin text-text-secondary" />}
          {steps && (
            <ol className="space-y-2">
              {steps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <StepStatusIcon status={s.status} />
                  <span className="text-text-secondary">#{s.step_number}</span>
                  <StepTypePill type={s.step_type} />
                  <span className="text-text-secondary">{s.status}</span>
                  {s.error && <span className="truncate text-xs text-danger">{s.error}</span>}
                </li>
              ))}
            </ol>
          )}
          {(run.status === 'active' || run.status === 'waiting_approval') && (
            <button type="button" onClick={handleCancel} className="focus-ring mt-3 rounded-lg border border-danger/30 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10">
              Cancel run
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RunsTab({ runs, onChanged }: { runs: WorkflowRun[]; onChanged: () => void }) {
  if (runs.length === 0) {
    return <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">No runs yet. Once a workflow's trigger event happens, it will show up here.</p>;
  }
  return <div className="space-y-3">{runs.map((r) => <RunRow key={r.id} run={r} onCancelled={onChanged} />)}</div>;
}

// ============================================================
// APPROVALS TAB
// ============================================================

function ApprovalsTab({ approvals, onChanged }: { approvals: WorkflowApproval[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = async (approval: WorkflowApproval, action: 'approve' | 'reject') => {
    setBusyId(approval.id);
    const ok = action === 'approve' ? await approveStep(approval.id) : await rejectStep(approval.id);
    setBusyId(null);
    if (ok) { toast(action === 'approve' ? 'Approved' : 'Rejected', 'success'); onChanged(); }
    else toast('Could not record decision', 'error');
  };

  if (approvals.length === 0) {
    return <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-text-secondary">Nothing waiting on you right now.</p>;
  }

  return (
    <div className="space-y-3">
      {approvals.map((a) => (
        <div key={a.id} className="flex items-center justify-between rounded-2xl border border-border bg-bg-secondary p-4">
          <div>
            <p className="font-medium text-text-primary">{a.reason ?? 'Approval required'}</p>
            <p className="text-xs text-text-secondary">Requested {new Date(a.requested_at).toLocaleString()}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busyId === a.id} onClick={() => decide(a, 'reject')} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary">Reject</button>
            <button type="button" disabled={busyId === a.id} onClick={() => decide(a, 'approve')} className="focus-ring rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-600">Approve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function WorkflowsPage() {
  const [tab, setTab] = useState<TabKey>('catalog');
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [approvals, setApprovals] = useState<WorkflowApproval[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [defs, runData, approvalData] = await Promise.all([fetchDefinitions(), fetchRuns(), fetchPendingApprovals()]);
      setDefinitions(defs);
      setRuns(runData);
      setApprovals(approvalData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const installedSlugs = useMemo(() => new Set(definitions.map((d) => d.slug)), [definitions]);
  const stats = useMemo(() => computeStats(definitions, runs, approvals), [definitions, runs, approvals]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary"><WorkflowIcon size={24} /> Call-to-Cash Workflows</h1>
            <p className="mt-1 text-sm text-text-secondary">The engine that turns every lead, quote, job and review into a scheduled follow-up — automatically.</p>
          </div>
          <button type="button" onClick={load} className="focus-ring flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Active workflows" value={stats.activeDefinitions} icon={WorkflowIcon} />
          <StatCard label="Runs in flight" value={stats.runsInFlight} icon={Loader2} />
          <StatCard label="Needs approval" value={stats.pendingApprovals} icon={Clock} />
          <StatCard label="Completed this month" value={stats.completedThisMonth} icon={CheckCircle2} />
        </div>

        <div className="mt-6 flex gap-1 overflow-x-auto rounded-xl bg-bg-tertiary p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`focus-ring flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.key ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
              {t.key === 'approvals' && approvals.length > 0 && <span className="ml-1.5 rounded-full bg-warning-500/20 px-1.5 py-0.5 text-xs text-warning-500">{approvals.length}</span>}
            </button>
          ))}
        </div>

        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-text-secondary" /></div>
          ) : (
            <>
              {tab === 'catalog' && <CatalogTab installedSlugs={installedSlugs} onInstall={load} />}
              {tab === 'installed' && <InstalledTab definitions={definitions} onChanged={load} />}
              {tab === 'runs' && <RunsTab runs={runs} onChanged={load} />}
              {tab === 'approvals' && <ApprovalsTab approvals={approvals} onChanged={load} />}
            </>
          )}
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
