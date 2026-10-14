/**
 * Team member / technician detail — /dashboard/team/:id
 *
 * Skills, credentials, scorecard, availability, hours, earnings and job
 * history for one team member. All reads are scoped to the account owner
 * (accountOwnerId). Access needs `can_manage_team`; hours/earnings
 * additionally need `can_view_billing`. RLS enforces the account boundary in
 * the database — these gates are UX on top of it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Lock, Mail, Phone, TriangleAlert, UserX } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { AvailabilitySection, CredentialsSection, SkillsSection } from '@/components/team/TechnicianProfileSections';
import { EarningsSection, HoursSection, JobHistorySection, ScorecardSection } from '@/components/team/TechnicianWorkSections';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { saveTechnicianScorecard } from '@/lib/technicianPerformance';
import {
  buildCredentialViews,
  computeAvailability,
  computeSkillEvidence,
  computeTechScorecard,
  fetchTechnicianDetail,
  periodRanges,
  summarizeEarnings,
  summarizeHours,
  type TechnicianDetailData,
} from '@/lib/technicianDetail';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS = [
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
] as const;
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', technician: 'Technician', member: 'Member', owner: 'Owner' };

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';

function Shell({ children }: { children: React.ReactNode }) {
  return <DashboardLayout activeLabel="Team"><div className="mx-auto max-w-6xl space-y-5">{children}</div></DashboardLayout>;
}

function BackLink() {
  return (
    <Link to="/dashboard/team" className="focus-ring inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary">
      <ArrowLeft size={14} /> Team
    </Link>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading team member" className="space-y-5">
      <div className="flex items-center gap-4"><div className="h-14 w-14 animate-pulse rounded-full bg-bg-tertiary" /><div className="space-y-2"><div className="h-5 w-48 animate-pulse rounded bg-bg-tertiary" /><div className="h-3 w-32 animate-pulse rounded bg-bg-tertiary" /></div></div>
      <div className="grid gap-5 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-56 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
    </div>
  );
}

export function TechnicianDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { isOwner, permissions, profile, teamMember, profileLoading } = useAuth();
  const { toast } = useToast();

  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canView = isOwner || permissions.can_manage_team;
  const canSeePay = isOwner || permissions.can_view_billing;

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<TechnicianDetailData | null>(null);
  const [days, setDays] = useState<number>(90);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!UUID_RE.test(id)) { setState('not_found'); return; }
    if (!accountOwnerId) { setState('error'); return; }
    if (!opts.silent) setState('loading');
    try {
      const detail = await fetchTechnicianDetail(accountOwnerId, id, { includePayroll: canSeePay });
      if (!detail) { setData(null); setState('not_found'); return; }
      setData(detail);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [accountOwnerId, id, canSeePay]);

  useEffect(() => {
    if (!canView || profileLoading) return;
    void load();
  }, [canView, profileLoading, load]);

  const ranges = useMemo(() => periodRanges(days), [days]);
  const derived = useMemo(() => {
    if (!data) return null;
    const { member } = data;
    return {
      current: computeTechScorecard(member, data.jobs, data.reviews, ranges.current),
      previous: computeTechScorecard(member, data.jobs, data.reviews, ranges.previous),
      skills: computeSkillEvidence(member.skills ?? [], data.jobs, data.reviews, member.id),
      credentials: buildCredentialViews(data.credentials),
      availability: computeAvailability(member, data.jobs),
      hours: summarizeHours(data.timesheets, ranges.current),
      earnings: summarizeEarnings(data.payslips, data.commissions, ranges.current),
    };
  }, [data, ranges]);

  const saveSnapshot = async () => {
    if (!data || !derived || !accountOwnerId || saving) return;
    setSaving(true);
    try {
      await saveTechnicianScorecard(data.member.id, derived.current, ranges.current.start, ranges.current.end, accountOwnerId);
      toast('Scorecard snapshot saved.', 'success');
      await load({ silent: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the snapshot.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (profileLoading) return <Shell><PageSkeleton /></Shell>;

  if (!canView) {
    return (
      <Shell>
        <BackLink />
        <EmptyState icon={Lock} title="You don’t have access to team details" description="Ask the account owner to enable “Manage team” for your role to view technician profiles." />
      </Shell>
    );
  }

  if (state === 'loading') return <Shell><BackLink /><PageSkeleton /></Shell>;

  if (state === 'not_found') {
    return (
      <Shell>
        <BackLink />
        <EmptyState icon={UserX} title="Team member not found" description="They may have been removed, or they belong to a different account." />
      </Shell>
    );
  }

  if (state === 'error' || !data || !derived) {
    return (
      <Shell>
        <BackLink />
        <EmptyState icon={TriangleAlert} title="Couldn’t load this team member" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
      </Shell>
    );
  }

  const { member, errors } = data;
  const name = member.member_name || member.member_email;
  const periodLabel = PERIODS.find((p) => p.days === days)?.label ?? `${days}d`;
  const isTechnician = member.role === 'technician';

  return (
    <Shell>
      <BackLink />

      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span aria-hidden className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-xl font-semibold text-text-secondary">{name[0]?.toUpperCase()}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-text-primary sm:text-2xl">{name}</h1>
              <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-[11px] font-semibold uppercase text-text-secondary">{ROLE_LABEL[member.role] ?? member.role}</span>
              {member.invite_status === 'pending' && <span className="rounded-full bg-warning-500/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase text-warning-500">Invite pending</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-secondary">
              <a href={`mailto:${member.member_email}`} className="focus-ring flex items-center gap-1 break-all rounded hover:text-text-primary"><Mail size={13} /> {member.member_email}</a>
              {member.member_phone && <a href={`tel:${member.member_phone}`} className="focus-ring flex items-center gap-1 rounded hover:text-text-primary"><Phone size={13} /> {member.member_phone}</a>}
            </div>
          </div>
        </div>

        <div role="group" aria-label="Reporting period" className="flex shrink-0 self-start rounded-xl bg-bg-tertiary p-1 sm:self-auto">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)}
              className={`focus-ring min-w-[52px] rounded-lg px-3 py-1.5 text-xs font-semibold ${days === p.days ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>{p.label}</button>
          ))}
        </div>
      </header>

      {!isTechnician && (
        <p className="rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
          This team member isn’t a technician, so job-based metrics only reflect jobs assigned to them directly.
        </p>
      )}

      <ScorecardSection
        current={derived.current}
        previous={derived.previous}
        snapshots={data.snapshots}
        snapshotsError={errors.snapshots}
        canSave={isTechnician}
        saving={saving}
        onSave={() => void saveSnapshot()}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <SkillsSection skills={derived.skills} languages={member.languages ?? []} error={errors.jobs ?? errors.reviews} onRetry={() => void load({ silent: true })} />
        <CredentialsSection views={derived.credentials} error={errors.credentials} onRetry={() => void load({ silent: true })} />
        <AvailabilitySection member={member} days={derived.availability} />
        <HoursSection allowed={canSeePay} linked={Boolean(data.employee)} error={errors.payroll} onRetry={() => void load({ silent: true })} summary={derived.hours} periodLabel={periodLabel} />
      </div>

      <EarningsSection
        allowed={canSeePay}
        linked={Boolean(data.employee)}
        error={errors.payroll}
        onRetry={() => void load({ silent: true })}
        summary={derived.earnings}
        payslips={data.payslips}
        hourlyCostCents={canSeePay ? member.hourly_cost_rate_cents : null}
        periodLabel={periodLabel}
      />

      <JobHistorySection jobs={data.jobs} technicianId={member.id} error={errors.jobs} onRetry={() => void load({ silent: true })} />
    </Shell>
  );
}
