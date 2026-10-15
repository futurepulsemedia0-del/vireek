import { Lock, Smile } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { FeedbackAnalyticsPanel } from '@/components/feedback/FeedbackAnalyticsPanel';

export function FeedbackAnalyticsPage() {
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  // Same account-scoping rule as NotificationsContext: owners are their own account, members point at their owner.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_all_jobs;

  if (loading || profileLoading) {
    return (
      <DashboardLayout activeLabel="Customer Feedback">
        <SkeletonCard rows={4} />
      </DashboardLayout>
    );
  }

  if (!canAccess || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Customer Feedback">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Customer feedback analytics include per-technician scores. Ask your account owner for the "View All Jobs" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Customer Feedback">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Smile size={24} /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Customer Feedback</h1>
          <p className="text-sm text-text-secondary">NPS and CSAT from job surveys and call ratings — by technician, service, zone and lead source, down to the job.</p>
        </div>
      </div>
      <FeedbackAnalyticsPanel accountOwnerId={accountOwnerId} />
    </DashboardLayout>
  );
}
