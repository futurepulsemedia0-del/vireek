import { DashboardLayout } from '@/components/DashboardNav';
import { WhatsNewFeed } from '@/components/whats-new/WhatsNewFeed';

// The feed lives in its own component on purpose: WhatsNewProvider is mounted INSIDE
// DashboardLayout, so anything calling useWhatsNew() must be a child of the layout.
export function WhatsNewPage() {
  return (
    <DashboardLayout activeLabel="What’s New">
      <WhatsNewFeed />
    </DashboardLayout>
  );
}
