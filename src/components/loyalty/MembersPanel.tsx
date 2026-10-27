/**
 * Loyalty — members: balances and tiers, manual point adjustments, staff-side redemptions, points history.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Loader2, Search, UserPlus, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { Dialog, Pill, ProgressBar, SelectField } from '@/components/loyalty/loyaltyUi';
import { adjustPoints, backfillPaidJobs, fetchLedger, redeemForCustomer } from '@/lib/loyaltyApi';
import { searchCustomers, type CustomerOption } from '@/lib/referralsApi';
import {
  ENTRY_LABELS,
  canAfford,
  filterMembers,
  formatMultiplier,
  formatPoints,
  formatRewardValue,
  formatSigned,
  pointsShort,
  sortMembers,
  tierProgress,
  timeAgo,
  validateAdjust,
  type LedgerEntry,
  type LoyaltyReward,
  type LoyaltyTier,
  type MemberSort,
  type MemberSummary,
} from '@/lib/loyalty';

const SORT_OPTIONS: { value: MemberSort; label: string }[] = [
  { value: 'balance', label: 'Highest balance' },
  { value: 'lifetime', label: 'Most lifetime points' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name (A–Z)' },
];

interface Props {
  ownerId: string;
  members: MemberSummary[];
  tiers: LoyaltyTier[];
  rewards: LoyaltyReward[];
  programEnabled: boolean;
  pointsLabel: string;
  onChanged: () => void;
}

const blankMember = (c: CustomerOption): MemberSummary => ({
  customer_id: c.id, name: c.name, phone: c.phone, email: c.email, points_balance: 0, lifetime_points: 0,
  tier_id: null, tier_name: null, earn_multiplier: null, last_activity_at: null,
});

export function MembersPanel({ ownerId, members, tiers, rewards, programEnabled, pointsLabel, onChanged }: Props) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MemberSort>('balance');
  const [selected, setSelected] = useState<MemberSummary | null>(null);
  const [finderOpen, setFinderOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<CustomerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const searchRef = useRef(0);

  const rows = useMemo(() => sortMembers(filterMembers(members, query), sort), [members, query, sort]);
  // Keep the open dialog in sync with fresh data after an adjustment or redemption.
  const live = selected ? members.find((m) => m.customer_id === selected.customer_id) ?? selected : null;

  useEffect(() => {
    if (!finderOpen || term.trim().length < 2) {
      setFound([]);
      return;
    }
    const id = ++searchRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchCustomers(ownerId, term)
        .then((r) => {
          if (id === searchRef.current) setFound(r);
        })
        .catch(() => {
          if (id === searchRef.current) setFound([]);
        })
        .finally(() => {
          if (id === searchRef.current) setSearching(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [term, finderOpen, ownerId]);

  const runBackfill = async () => {
    try {
      const n = await backfillPaidJobs();
      toast(n > 0 ? `Awarded points for ${n} past paid ${n === 1 ? 'job' : 'jobs'}.` : 'Everything was already up to date.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not award points for past jobs.', 'error');
    } finally {
      setBackfillOpen(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input icon={Search} label="Search members" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, phone, email or tier" />
        </div>
        <div className="sm:w-56">
          <SelectField label="Sort by" value={sort} onChange={setSort} options={SORT_OPTIONS} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setFinderOpen((v) => !v)} aria-expanded={finderOpen}>
          <UserPlus size={16} /> Add points for another customer
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setBackfillOpen(true)} disabled={!programEnabled} title={programEnabled ? undefined : 'Turn the program on first'}>
          <History size={16} /> Award points for past paid jobs
        </Button>
      </div>

      {finderOpen && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <Input icon={Search} label="Find a customer" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Type at least 2 letters of their name" autoFocus />
          <div className="mt-3" aria-live="polite">
            {searching ? (
              <Skeleton className="h-10 w-full" />
            ) : term.trim().length >= 2 && found.length === 0 ? (
              <p className="text-sm text-text-secondary">No customers match &quot;{term.trim()}&quot;.</p>
            ) : (
              <ul className="space-y-1">
                {found.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(members.find((m) => m.customer_id === c.id) ?? blankMember(c));
                        setFinderOpen(false);
                        setTerm('');
                      }}
                      className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-bg-tertiary"
                    >
                      <span className="truncate text-sm font-medium text-text-primary">{c.name}</span>
                      <span className="truncate text-xs text-text-secondary">{c.phone ?? c.email ?? ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members yet"
          description={programEnabled ? 'Customers appear here after their first paid invoice earns points, or when you add points yourself.' : 'Turn the program on in Earn rules, then paid invoices start earning points.'}
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={Search} title="No members match your search" description="Try a different name, phone number or tier." action={{ label: 'Clear search', onClick: () => setQuery('') }} />
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.customer_id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-semibold text-text-primary">{m.name}</p>
                  {m.tier_name && <Pill tone="success">{m.tier_name}</Pill>}
                </div>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {formatPoints(m.lifetime_points)} lifetime · active {timeAgo(m.last_activity_at)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <p className="text-right">
                  <span className="block text-lg font-bold text-text-primary">{formatPoints(m.points_balance)}</span>
                  <span className="block text-xs text-text-secondary">{pointsLabel}</span>
                </p>
                <Button variant="secondary" size="sm" onClick={() => setSelected(m)}>Manage</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {live && (
        <MemberDialog
          ownerId={ownerId}
          member={live}
          tiers={tiers}
          rewards={rewards}
          programEnabled={programEnabled}
          pointsLabel={pointsLabel}
          onClose={() => setSelected(null)}
          onChanged={onChanged}
        />
      )}

      <ConfirmDialog
        open={backfillOpen}
        title="Award points for past paid jobs?"
        description="Paid invoices from before the program was on will earn points using your current rules, oldest first. Jobs that already earned points are skipped, so this is safe to run again."
        confirmLabel="Award points"
        onConfirm={runBackfill}
        onCancel={() => setBackfillOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------

interface DialogProps {
  ownerId: string;
  member: MemberSummary;
  tiers: LoyaltyTier[];
  rewards: LoyaltyReward[];
  programEnabled: boolean;
  pointsLabel: string;
  onClose: () => void;
  onChanged: () => void;
}

function MemberDialog({ ownerId, member, tiers, rewards, programEnabled, pointsLabel, onClose, onChanged }: DialogProps) {
  const { toast } = useToast();
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [ledgerError, setLedgerError] = useState(false);
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ points?: string; note?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const progress = tierProgress(tiers, member.lifetime_points);
  const activeRewards = rewards.filter((r) => r.is_active);

  const loadLedger = useCallback(async () => {
    setLedgerError(false);
    try {
      setLedger(await fetchLedger(ownerId, member.customer_id));
    } catch {
      setLedgerError(true);
    }
  }, [ownerId, member.customer_id]);

  useEffect(() => {
    setLedger(null);
    void loadLedger();
  }, [loadLedger]);

  const submitAdjust = async () => {
    const e = validateAdjust(points, note, member.points_balance);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setBusy('adjust');
    try {
      await adjustPoints(member.customer_id, Number(points), note);
      toast('Points updated.', 'success');
      setPoints('');
      setNote('');
      onChanged();
      await loadLedger();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not adjust the points.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const redeem = async (r: LoyaltyReward) => {
    setBusy(r.id);
    try {
      const res = await redeemForCustomer(member.customer_id, r.id);
      toast(`Redeemed "${res.reward_name}". Code ${res.code} is waiting in Redemptions.`, 'success');
      onChanged();
      await loadLedger();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not redeem the reward.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title={member.name} description={[member.phone, member.email].filter(Boolean).join(' · ') || undefined}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-text-secondary">Balance</p>
            <p className="text-xl font-bold text-text-primary">{formatPoints(member.points_balance)}</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-text-secondary">Lifetime</p>
            <p className="text-xl font-bold text-text-primary">{formatPoints(member.lifetime_points)}</p>
          </div>
        </div>

        {tiers.length > 0 && (
          <div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-text-primary">
                {progress.current ? `${progress.current.name} (${formatMultiplier(progress.current.earn_multiplier)})` : 'No tier yet'}
              </span>
              <span className="text-xs text-text-secondary">
                {progress.next ? `${formatPoints(progress.pointsToNext)} to ${progress.next.name}` : 'Top tier'}
              </span>
            </div>
            <div className="mt-2"><ProgressBar percent={progress.percent} label="Progress to the next tier" /></div>
          </div>
        )}

        <section aria-label="Adjust points" className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Adjust {pointsLabel}</h3>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <Input label="Amount" value={points} onChange={(e) => setPoints(e.target.value)} inputMode="numeric" placeholder="+50 or -50" error={errors.points} />
            <Input label="Reason" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Goodwill after a late arrival" error={errors.note} />
          </div>
          <Button size="sm" onClick={() => void submitAdjust()} disabled={busy !== null}>
            {busy === 'adjust' && <Loader2 size={16} className="animate-spin" />} Apply adjustment
          </Button>
        </section>

        <section aria-label="Redeem a reward" className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">Redeem a reward</h3>
          {!programEnabled ? (
            <p className="text-sm text-text-secondary">Turn the program on to redeem rewards.</p>
          ) : activeRewards.length === 0 ? (
            <p className="text-sm text-text-secondary">Add an active reward in the Rewards tab first.</p>
          ) : (
            <ul className="space-y-2">
              {activeRewards.map((r) => {
                const ok = canAfford(member.points_balance, r.points_cost);
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{r.name}</p>
                      <p className="text-xs text-text-secondary">
                        {formatRewardValue(r)} · {formatPoints(r.points_cost)} {pointsLabel}
                        {!ok && ` · needs ${formatPoints(pointsShort(member.points_balance, r.points_cost))} more`}
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => void redeem(r)} disabled={!ok || busy !== null}>
                      {busy === r.id && <Loader2 size={16} className="animate-spin" />} Redeem
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Points history" className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">History</h3>
          {ledgerError ? (
            <EmptyStateError icon={History} title="Could not load history" description="Check your connection and try again." onRetry={() => void loadLedger()} />
          ) : ledger === null ? (
            <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
          ) : ledger.length === 0 ? (
            <EmptyState icon={History} title="No activity yet" description="Points earned, redeemed and adjusted will be listed here." />
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {ledger.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary">{ENTRY_LABELS[e.entry_type]}{e.note ? ` · ${e.note}` : ''}</p>
                    <p className="text-xs text-text-secondary">{timeAgo(e.created_at)}</p>
                  </div>
                  <span className={`text-sm font-semibold ${e.points > 0 ? 'text-success' : 'text-text-primary'}`}>{formatSigned(e.points)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
