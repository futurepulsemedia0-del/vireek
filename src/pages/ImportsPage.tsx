import { useCallback, useEffect, useState } from 'react';
import { FileUp, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { ImportWizard } from '@/components/imports/ImportWizard';
import { ImportHistory } from '@/components/imports/ImportHistory';
import { listImportJobs, type ImportJobRecord } from '@/lib/importWizard';

export function ImportsPage() {
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  // Same account-scoping rule as NotificationsContext: owners are their own account, members point at their owner.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_edit_business_profile;

  const [jobs, setJobs] = useState<ImportJobRecord[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setJobsLoading(true);
    setJobsError(null);
    try {
      setJobs(await listImportJobs(accountOwnerId));
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : 'Could not load import history.');
    } finally {
      setJobsLoading(false);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  if (loading || profileLoading) {
    return (
      <DashboardLayout activeLabel="Data Imports">
        <SkeletonCard rows={4} />
      </DashboardLayout>
    );
  }

  if (!canAccess || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Data Imports">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Importing data is restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Data Imports">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><FileUp size={24} /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Data Imports</h1>
          <p className="text-sm text-text-secondary">Bring customers and job history from ServiceTitan, Jobber, Housecall Pro or any spreadsheet — checked before it’s written, and fully undoable.</p>
        </div>
      </div>
      <div className="space-y-6">
        <ImportWizard accountOwnerId={accountOwnerId} onFinished={() => void loadJobs()} />
        <ImportHistory accountOwnerId={accountOwnerId} jobs={jobs} loading={jobsLoading} error={jobsError} onRefresh={() => void loadJobs()} />
      </div>
    </DashboardLayout>
  );
}
