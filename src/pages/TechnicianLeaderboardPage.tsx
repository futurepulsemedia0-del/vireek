import { useState } from 'react';
import { Lock, Medal } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { LoadError, useLoader } from '@/components/commissions/shared';
import { LeaderboardBoard } from '@/components/leaderboard/LeaderboardBoard';
import { MyBonusesPanel } from '@/components/leaderboard/MyBonusesPanel';
import { SpiffPayoutsPanel } from '@/components/leaderboard/SpiffPayoutsPanel';
import { SpiffRulesPanel } from '@/components/leaderboard/SpiffRulesPanel';
import { fetchLeaderboard } from '@/lib/technicianLeaderboardApi';
import { shiftAnchor, toDateOnly, type LeaderboardPeriod } from '@/lib/technicianLeaderboard';

type Tab = 'board' | 'mine' | 'rules' | 'payouts';

export function TechnicianLeaderboardPage() {
  const { isOwner, profile, teamMember } = useAuth();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const [period, setPeriod] = useState<LeaderboardPeriod>('weekly');
  const [anchor, setAnchor] = useState(() => toDateOnly(new Date()));
  const [tab, setTab] = useState<Tab>('board');
  const board = useLoader(() => fetchLeaderboard(period, anchor), [period, anchor, ownerId]);

  const data = board.data;
  const isManager = data?.viewer?.is_manager ?? false;
  const isTechnician = !!data?.viewer?.team_member_id;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'board', label: 'Leaderboard' },
    ...(isTechnician ? [{ id: 'mine' as const, label: 'My bonuses' }] : []),
    ...(isManager ? [{ id: 'rules' as const, label: 'Rules & settings' }, { id: 'payouts' as const, label: 'Bonus payouts' }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'board';

  return (
    <DashboardLayout activeLabel="Leaderboard">
      <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Medal className="h-6 w-6 text-accent" aria-hidden="true" /> Technician leaderboard
          </h1>
          <p className="mt-1 text-sm text-text-secondary">Friendly competition on what matters: fixing it right the first time, great service and growth. Bonuses are paid through payroll automatically.</p>
        </header>

        {board.loading && !data ? (
          <SkeletonCardList count={4} rows={2} />
        ) : board.error && !data ? (
          <LoadError message={board.error} onRetry={board.reload} />
        ) : data && !data.enabled && !isManager ? (
          <EmptyState icon={Lock} title="Leaderboards are turned off" description="Your account owner hasn’t enabled the technician leaderboard." />
        ) : data ? (
          <>
            <div role="tablist" aria-label="Leaderboard sections" className="flex gap-1 overflow-x-auto border-b border-border">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  id={`lb-tab-${t.id}`}
                  aria-selected={activeTab === t.id}
                  aria-controls={`lb-panel-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`focus-ring -mb-px min-h-[44px] shrink-0 border-b-2 px-4 text-sm font-semibold transition-colors ${activeTab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id={`lb-panel-${activeTab}`} aria-labelledby={`lb-tab-${activeTab}`}>
              {activeTab === 'board' && (
                <>
                  {!data.enabled && <p role="status" className="mb-3 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-warning-500">Leaderboards are off for technicians. Only you can see this board.</p>}
                  <LeaderboardBoard
                    data={data}
                    period={period}
                    anchor={anchor}
                    onPeriod={setPeriod}
                    onAnchor={setAnchor}
                    onShift={(d) => setAnchor((a) => shiftAnchor(period, a, d))}
                  />
                </>
              )}
              {activeTab === 'mine' && <MyBonusesPanel onOptOutChanged={board.reload} />}
              {activeTab === 'rules' && ownerId && <SpiffRulesPanel ownerId={ownerId} />}
              {activeTab === 'payouts' && <SpiffPayoutsPanel />}
            </div>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
