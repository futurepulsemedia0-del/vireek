import { useCallback, useEffect, useRef, useState } from 'react';
import { Crown, Gift, Loader2, Lock, PackageCheck, RefreshCw, Sparkles, TriangleAlert, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { MembersPanel } from '@/components/loyalty/MembersPanel';
import { ProgramPanel } from '@/components/loyalty/ProgramPanel';
import { RedemptionsPanel } from '@/components/loyalty/RedemptionsPanel';
import { RewardsPanel } from '@/components/loyalty/RewardsPanel';
import { TiersPanel } from '@/components/loyalty/TiersPanel';
import { Pill, Tile } from '@/components/loyalty/loyaltyUi';
import {
  createEarnRule,
  createReward,
  createTier,
  fetchEarnRules,
  fetchMembers,
  fetchOverview,
  fetchRedemptions,
  fetchRewards,
  fetchSettings,
  fetchTiers,
  saveSettings,
} from '@/lib/loyaltyApi';
import {
  DEFAULT_SETUP,
  EMPTY_OVERVIEW,
  earnRuleToPayload,
  formatPoints,
  rewardToPayload,
  tierToPayload,
  type EarnRule,
  type LoyaltyOverview,
  type LoyaltyReward,
  type LoyaltySettings,
  type LoyaltyTier,
  type MemberSummary,
  type RedemptionDetail,
} from '@/lib/loyalty';

type TabKey = 'members' | 'program' | 'tiers' | 'rewards' | 'redemptions';

const TABS: { key: TabKey; label: string; icon: typeof Users }[] = [
  { key: 'members', label: 'Members', icon: Users },
  { key: 'program', label: 'Earn rules', icon: Sparkles },
  { key: 'tiers', label: 'Tiers', icon: Crown },
  { key: 'rewards', label: 'Rewards', icon: Gift },
  { key: 'redemptions', label: 'Redemptions', icon: PackageCheck },
];

export function LoyaltyPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  // Same gate as Referrals/Gift Cards: owners and anyone with billing access (the database re-checks this).
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [tab, setTab] = useState<TabKey>('members');
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [rules, setRules] = useState<EarnRule[]>([]);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [redemptions, setRedemptions] = useState<RedemptionDetail[]>([]);
  const [overview, setOverview] = useState<LoyaltyOverview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!ownerId) return;
      const id = ++requestRef.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);
      try {
        const [s, t, r, w, m, red, o] = await Promise.all([
          fetchSettings(ownerId),
          fetchTiers(ownerId),
          fetchEarnRules(ownerId),
          fetchRewards(ownerId),
          fetchMembers(ownerId),
          fetchRedemptions(ownerId),
          fetchOverview(),
        ]);
        if (id !== requestRef.current) return;
        setSettings(s);
        setTiers(t);
        setRules(r);
        setRewards(w);
        setMembers(m);
        setRedemptions(red);
        setOverview(o);
      } catch (err) {
        if (id === requestRef.current) setLoadError(err instanceof Error ? err.message : 'Could not load the rewards program.');
      } finally {
        if (id === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [ownerId],
  );

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  const reload = useCallback(() => void load(true), [load]);

  const startRecommended = async () => {
    if (!ownerId) return;
    setSeeding(true);
    try {
      await saveSettings(ownerId, { is_enabled: true, ...DEFAULT_SETUP.settings });
      // Each section is only filled when empty, so a retry after a partial failure never duplicates anything.
      if (rules.length === 0) for (const r of DEFAULT_SETUP.rules) await createEarnRule(ownerId, earnRuleToPayload(r));
      if (tiers.length === 0) for (const t of DEFAULT_SETUP.tiers) await createTier(ownerId, tierToPayload(t));
      if (rewards.length === 0) for (const w of DEFAULT_SETUP.rewards) await createReward(ownerId, rewardToPayload(w));
      toast('Rewards program is on. Paid invoices now earn points.', 'success');
      setTab('program');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Setup stopped part-way. Press the button again to finish.', 'error');
    } finally {
      setSeeding(false);
      await load(true);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Loyalty">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don&apos;t have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            The rewards program includes customer balances and payouts. Ask your account owner to grant you the &quot;View Billing&quot; permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const enabled = settings?.is_enabled ?? false;
  const pointsLabel = settings?.points_label ?? 'points';

  return (
    <DashboardLayout activeLabel="Loyalty">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Crown size={22} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{settings?.program_name ?? 'Loyalty'}</h1>
              <p className="text-sm text-text-secondary">Reward repeat customers with points, tiers and perks.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!loading && !loadError && <Pill tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Program on' : 'Program off'}</Pill>}
            <Button variant="secondary" size="sm" onClick={reload} disabled={loading || refreshing} aria-label="Refresh">
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="mt-6 space-y-6">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : loadError ? (
          <div className="mt-6">
            <EmptyStateError icon={TriangleAlert} title="Could not load the rewards program" description={loadError} onRetry={() => void load()} />
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="Members" value={formatPoints(overview.members)} hint="Customers with points activity" />
              <Tile label={`${pointsLabel[0].toUpperCase()}${pointsLabel.slice(1)} outstanding`} value={formatPoints(overview.outstanding_points)} hint="Unspent balance" />
              <Tile label="Issued (30 days)" value={formatPoints(overview.issued_30d)} />
              <Tile label="Redeemed (30 days)" value={formatPoints(overview.redeemed_30d)} hint={overview.pending_redemptions > 0 ? `${overview.pending_redemptions} waiting to fulfill` : undefined} />
            </div>

            {!enabled && (
              <div className="mt-6 rounded-2xl border border-accent/30 bg-accent/5 p-5">
                <h2 className="text-base font-semibold text-text-primary">Launch your rewards program</h2>
                <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                  One click sets up 1 point per $1, four tiers and three starter rewards. You can change everything afterwards.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void startRecommended()} disabled={seeding}>
                    {seeding ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Start with a recommended setup
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setTab('program')}>Set it up myself</Button>
                </div>
              </div>
            )}

            {enabled && rules.length === 0 && (
              <div role="status" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4">
                <p className="text-sm text-text-primary">The program is on, but there are no earn rules, so paid invoices earn nothing yet.</p>
                <Button variant="secondary" size="sm" onClick={() => setTab('program')}>Add an earn rule</Button>
              </div>
            )}

            <div className="mt-6 overflow-x-auto" role="tablist" aria-label="Loyalty sections">
              <div className="flex min-w-max gap-2 border-b border-border pb-px">
                {TABS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => setTab(key)}
                    className={`focus-ring -mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors ${
                      tab === key ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <Icon size={16} /> {label}
                    {key === 'redemptions' && overview.pending_redemptions > 0 && (
                      <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-xs text-warning-500">{overview.pending_redemptions}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-6" role="tabpanel">
              {ownerId && tab === 'members' && (
                <MembersPanel ownerId={ownerId} members={members} tiers={tiers} rewards={rewards} programEnabled={enabled} pointsLabel={pointsLabel} onChanged={reload} />
              )}
              {ownerId && tab === 'program' && <ProgramPanel ownerId={ownerId} settings={settings} rules={rules} tiers={tiers} onChanged={reload} />}
              {ownerId && tab === 'tiers' && <TiersPanel ownerId={ownerId} tiers={tiers} onChanged={reload} />}
              {ownerId && tab === 'rewards' && <RewardsPanel ownerId={ownerId} rewards={rewards} pointsLabel={pointsLabel} onChanged={reload} />}
              {tab === 'redemptions' && <RedemptionsPanel redemptions={redemptions} pointsLabel={pointsLabel} onChanged={reload} />}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
