import { DashboardLayout } from '@/components/DashboardNav';
import { TodayHome } from '@/components/today/TodayHome';

/** /dashboard/today — Today Home on its own page (bookmarkable, and the target of the "Today" nav item). */
export function TodayPage() {
  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-6">
        <TodayHome />
      </div>
    </DashboardLayout>
  );
}
