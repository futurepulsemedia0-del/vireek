import { DashboardLayout } from '@/components/DashboardNav';
import { SarahLearnPage } from '@/pages/onboarding/sarah/SarahLearnPage';

/**
 * /dashboard/sarah - Sarah's learning flow inside the normal dashboard shell (nav, search, help),
 * so it is never a locked, full-screen step. The flow itself is unchanged and resumable.
 */
export function SarahKnowledgePage() {
  return (
    <DashboardLayout activeLabel="Sarah Knowledge">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <SarahLearnPage embedded />
      </div>
    </DashboardLayout>
  );
}
