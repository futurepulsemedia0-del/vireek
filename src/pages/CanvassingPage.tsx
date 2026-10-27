import { useMemo, useState } from 'react';
import { DoorOpen } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { DoorsPanel } from '@/components/canvassing/DoorsPanel';
import { FollowUpsPanel } from '@/components/canvassing/FollowUpsPanel';
import { ResultsPanel } from '@/components/canvassing/ResultsPanel';
import { TerritoriesPanel } from '@/components/canvassing/TerritoriesPanel';
import { VisitSheet } from '@/components/canvassing/VisitSheet';
import { useCanvassData } from '@/components/canvassing/useCanvassData';
import { useAuth } from '@/contexts/AuthContext';
import { canManageCanvassing, followUpBucket, type VisitLogResult } from '@/lib/canvassing';

const PAGE = 'Canvassing';
type Tab = 'doors' | 'territories' | 'followups' | 'results';

export function CanvassingPage() {
  const { user, profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  // Everything is keyed by the ACCOUNT OWNER's id (differs from user.id for team members).
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const isManager = canManageCanvassing(isOwner, permissions as unknown as Record<string, boolean | undefined>);

  const [tab, setTab] = useState<Tab>('doors');
  const [activeDoorId, setActiveDoorId] = useState<string | null>(null);
  const data = useCanvassData(ownerId, isManager);

  const activeDoor = useMemo(() => data.doors.find((d) => d.id === activeDoorId) ?? null, [data.doors, activeDoorId]);
  const activeTerritory = useMemo(
    () => (activeDoor?.territory_id ? data.territories.find((t) => t.id === activeDoor.territory_id) ?? null : null),
    [activeDoor, data.territories],
  );
  const repNames = useMemo(() => new Map(data.reps.map((r) => [r.user_id, r.name])), [data.reps]);
  const overdue = useMemo(() => {
    const now = new Date();
    return data.doors.filter((d) => d.follow_up_at && followUpBucket(d.follow_up_at, now) === 'overdue').length;
  }, [data.doors]);

  if (authLoading || profileLoading) {
    return <DashboardLayout activeLabel={PAGE}><div className="mx-auto w-full max-w-6xl"><SkeletonCardList count={3} rows={2} /></div></DashboardLayout>;
  }

  if (!ownerId) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <div className="mx-auto w-full max-w-3xl">
          <EmptyState icon={DoorOpen} title="Canvassing isn't available yet" description="Finish setting up your account, then come back to map your territories." />
        </div>
      </DashboardLayout>
    );
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'doors', label: 'Doors' },
    { id: 'territories', label: 'Territories' },
    { id: 'followups', label: 'Follow-ups', badge: overdue },
    { id: 'results', label: 'Results' },
  ];

  const handleSaved = (res: VisitLogResult) => {
    data.patchDoor(res.door);
    setActiveDoorId(null);
  };

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><DoorOpen size={22} className="text-accent" /> Canvassing</h1>
          <p className="mt-1 text-sm text-text-secondary">Door-to-door lead map: territories for each rep, a logged outcome for every knock, and follow-ups that never fall through.</p>
        </header>

        <div role="tablist" aria-label="Canvassing sections" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`cv-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`cv-panel-${t.id}`} onClick={() => setTab(t.id)}
              className={`focus-ring inline-flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
              {t.label}
              {!!t.badge && <span aria-label={`${t.badge} overdue`} className="rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-5 text-white">{t.badge}</span>}
            </button>
          ))}
        </div>

        {tab !== 'results' && data.status === 'loading' && <SkeletonCardList count={3} rows={2} />}
        {tab !== 'results' && data.status === 'error' && <EmptyStateError icon={DoorOpen} title="Couldn't load canvassing" onRetry={() => void data.reload()} />}

        <div role="tabpanel" id={`cv-panel-${tab}`} aria-labelledby={`cv-tab-${tab}`}>
          {tab === 'results' && <ResultsPanel isManager={isManager} />}
          {tab !== 'results' && data.status === 'ready' && (
            <>
              {tab === 'doors' && (
                <DoorsPanel isManager={isManager} territories={data.territories} doors={data.doors} truncated={data.truncated}
                  activeDoorId={activeDoorId} onOpenDoor={setActiveDoorId} onReload={() => data.reload(true)} />
              )}
              {tab === 'territories' && (
                <TerritoriesPanel isManager={isManager} territories={data.territories} doors={data.doors} reps={data.reps} onChanged={() => data.reload(true)} />
              )}
              {tab === 'followups' && (
                <FollowUpsPanel doors={data.doors} territories={data.territories} onOpenDoor={setActiveDoorId} onDoorChanged={data.patchDoor} />
              )}
            </>
          )}
        </div>
      </div>

      <VisitSheet door={activeDoor} territory={activeTerritory} isManager={isManager} myUserId={user?.id ?? null} repNames={repNames}
        onClose={() => setActiveDoorId(null)} onSaved={handleSaved} />
    </DashboardLayout>
  );
}

export default CanvassingPage;
