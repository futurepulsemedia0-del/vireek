/**
 * Prevailing wage & certified payroll — rules engine for commercial and
 * government jobs: wage tables, overtime rule sets, per-job rate application on
 * approved timesheets, and certified payroll exports (PDF + CSV).
 *
 * View needs can_view_billing; editing needs owner or
 * (can_view_billing + can_edit_business_profile). Enforced by RLS and RPCs too.
 * LEGAL REVIEW REQUIRED — this is a calculation aid, not legal advice.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { FadeIn } from '@/components/Skeleton';
import { EmptyStateError } from '@/components/EmptyState';
import {
  fetchAssignments,
  fetchDeterminations,
  fetchEmployeesLite,
  fetchJobsLite,
  fetchRuleSets,
  fetchWorkerProfiles,
  type Determination,
  type EmployeeLite,
  type JobAssignment,
  type JobLite,
  type RuleSetRow,
  type WorkerProfile,
} from '@/lib/prevailingWageApi';
import { LegalBanner, errMsg } from '@/components/prevailingWage/shared';
import { WageTablesTab } from '@/components/prevailingWage/WageTablesTab';
import { OvertimeRulesTab } from '@/components/prevailingWage/OvertimeRulesTab';
import { JobSetupTab } from '@/components/prevailingWage/JobSetupTab';
import { WorkersTab } from '@/components/prevailingWage/WorkersTab';
import { CertifiedPayrollTab } from '@/components/prevailingWage/CertifiedPayrollTab';
import { ChangeHistoryTab } from '@/components/prevailingWage/ChangeHistoryTab';

type Tab = 'payroll' | 'jobs' | 'tables' | 'rules' | 'workers' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'payroll', label: 'Certified payroll' },
  { id: 'jobs', label: 'Job setup' },
  { id: 'tables', label: 'Wage tables' },
  { id: 'rules', label: 'Overtime rules' },
  { id: 'workers', label: 'Workers' },
  { id: 'history', label: 'Change history' },
];

export function PrevailingWagePage() {
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canView = isOwner || permissions.can_view_billing;
  const canEdit = isOwner || (permissions.can_view_billing && permissions.can_edit_business_profile);

  const [tab, setTab] = useState<Tab>('payroll');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [jobs, setJobs] = useState<JobLite[]>([]);
  const [assignments, setAssignments] = useState<JobAssignment[]>([]);
  const [determinations, setDeterminations] = useState<Determination[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSetRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [profiles, setProfiles] = useState<WorkerProfile[]>([]);

  const load = useCallback(async () => {
    try {
      const [j, a, d, r, e, p] = await Promise.all([
        fetchJobsLite(),
        fetchAssignments(),
        fetchDeterminations(),
        fetchRuleSets(),
        fetchEmployeesLite(),
        fetchWorkerProfiles(),
      ]);
      setJobs(j);
      setAssignments(a);
      setDeterminations(d);
      setRuleSets(r);
      setEmployees(e);
      setProfiles(p);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      toast(errMsg(err, 'Could not load prevailing wage data.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (canView) void load();
    else setLoading(false);
  }, [canView, load]);

  if (!canView) {
    return (
      <DashboardLayout activeLabel="Prevailing Wage">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Prevailing Wage">
      <div className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Prevailing wage & certified payroll</h1>
          <p className="text-sm text-text-secondary">Wage tables, overtime rules and certified payroll for commercial and government jobs.</p>
        </div>
      </div>

      <div className="mb-6">
        <LegalBanner />
      </div>

      <div role="tablist" aria-label="Prevailing wage sections" className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-border bg-bg-secondary p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`pw-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`pw-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`focus-ring whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loadFailed && !loading ? (
        <EmptyStateError icon={Lock} onRetry={load} />
      ) : (
        <FadeIn>
          <div role="tabpanel" id={`pw-panel-${tab}`} aria-labelledby={`pw-tab-${tab}`}>
            {tab === 'payroll' && <CertifiedPayrollTab canEdit={canEdit} jobs={jobs} assignments={assignments} ruleSets={ruleSets} loading={loading} />}
            {tab === 'jobs' && (
              <JobSetupTab canEdit={canEdit} jobs={jobs} assignments={assignments} determinations={determinations} ruleSets={ruleSets} employees={employees} loading={loading} reload={load} />
            )}
            {tab === 'tables' && <WageTablesTab canEdit={canEdit} determinations={determinations} loading={loading} reload={load} />}
            {tab === 'rules' && <OvertimeRulesTab canEdit={canEdit} ruleSets={ruleSets} loading={loading} reload={load} />}
            {tab === 'workers' && <WorkersTab canEdit={canEdit} employees={employees} profiles={profiles} loading={loading} reload={load} />}
            {tab === 'history' && <ChangeHistoryTab />}
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
