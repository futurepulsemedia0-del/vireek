/** /dashboard/win-cards — owner + managers. Server enforces identity_is_manager(); this page only hides the UI. */
import { DashboardLayout } from '@/components/DashboardNav';
import { WinCardsPanel } from '@/components/wincards/WinCardsPanel';

export function WinCardsPage() {
  return (
    <DashboardLayout activeLabel="Win Cards">
      <WinCardsPanel />
    </DashboardLayout>
  );
}
