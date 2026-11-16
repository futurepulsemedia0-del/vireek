import { DashboardPage } from '@/pages/DashboardPage';
import { GettingStartedCard } from '@/components/GettingStartedCard';
import { TodayHome } from '@/components/today/TodayHome';
import { Button } from '@/components/ui/Button';
import { useSimpleMode } from '@/hooks/useSimpleMode';

/**
 * /dashboard. New owners get the lean view (setup progress + Today: calls, bookings, recovered money, what needs
 * attention). Everyone else, and anyone who chooses "Show all features", gets the full dashboard unchanged.
 */
export function DashboardHome() {
  const { active, setShowEverything } = useSimpleMode();
  if (!active) return <DashboardPage />;
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Today</h1>
          <p className="text-sm text-text-secondary">What your receptionist did today, and what needs you.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowEverything(true)}>Show all features</Button>
      </header>
      <GettingStartedCard />
      <TodayHome />
    </main>
  );
}
