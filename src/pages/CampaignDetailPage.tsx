import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Megaphone, Pause, Play, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { formatEnrollmentStatus, getCampaignTypeConfig, type EnrollmentStatus } from '@/lib/marketing';
import {
  ATTRIBUTION_WINDOW_DAYS,
  attributeRevenue,
  buildFunnel,
  buildRecipientRows,
  buildStepStats,
  filterRecipients,
  paginate,
  summarizeCampaign,
  toggleLabel,
  toggleTarget,
  type RecipientFilter,
  type RecipientRow,
  type StepStat,
} from '@/lib/campaignDetail';
import { cloneCampaign, fetchCampaignBundle, setCampaignStatus, type CampaignBundle } from '@/lib/campaignDetailApi';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const FILTERS: Array<{ value: RecipientFilter; label: string }> = [
  { value: 'all', label: 'All recipients' },
  { value: 'active', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'converted', label: 'Converted' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Had a failed send' },
];

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'danger' }) {
  const tones = {
    neutral: 'bg-bg-tertiary text-text-secondary',
    accent: 'bg-accent/10 text-accent',
    danger: 'bg-danger/10 text-danger',
  };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function statusTone(status: EnrollmentStatus): 'neutral' | 'accent' | 'danger' {
  if (status === 'converted' || status === 'active') return 'accent';
  if (status === 'stopped') return 'danger';
  return 'neutral';
}

function StepsSection({ stats }: { stats: StepStat[] }) {
  return (
    <section aria-labelledby="steps-heading" className="space-y-3">
      <h2 id="steps-heading" className="text-lg font-semibold text-text-primary">Per-step performance</h2>
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
            <tr>
              <th scope="col" className="px-4 py-3">Step</th>
              <th scope="col" className="px-4 py-3">Sent</th>
              <th scope="col" className="px-4 py-3">Failed</th>
              <th scope="col" className="px-4 py-3">Delivery</th>
              <th scope="col" className="px-4 py-3">Reached</th>
              <th scope="col" className="px-4 py-3">Kept from prior step</th>
              <th scope="col" className="px-4 py-3">Waiting</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg-secondary">
            {stats.map((s) => (
              <tr key={s.stepId}>
                <td className="px-4 py-3">
                  <p className="font-medium text-text-primary">{s.stepOrder}. {s.label}</p>
                  <p className="text-xs text-text-secondary">
                    {s.channel === 'email' ? 'Email' : 'SMS'} · {s.delayHours === 0 ? 'immediately' : `after ${s.delayHours}h`}
                  </p>
                  {s.topError && <p className="mt-1 text-xs text-danger">Most common error: {s.topError}</p>}
                </td>
                <td className="px-4 py-3 text-text-primary">{s.sent}</td>
                <td className="px-4 py-3 text-text-primary">{s.failed}</td>
                <td className="px-4 py-3 text-text-primary">{s.sent + s.failed > 0 ? `${s.deliveryRate}%` : '—'}</td>
                <td className="px-4 py-3 text-text-primary">{s.reached}</td>
                <td className="px-4 py-3 text-text-primary">{s.retentionFromPrevious === null ? '—' : `${s.retentionFromPrevious}%`}</td>
                <td className="px-4 py-3 text-text-primary">{s.waiting}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {stats.map((s) => (
          <li key={s.stepId} className="rounded-xl border border-border bg-bg-secondary p-4">
            <p className="font-medium text-text-primary">{s.stepOrder}. {s.label}</p>
            <p className="text-xs text-text-secondary">
              {s.channel === 'email' ? 'Email' : 'SMS'} · {s.delayHours === 0 ? 'immediately' : `after ${s.delayHours}h`}
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div><dt className="text-xs text-text-secondary">Sent</dt><dd className="font-semibold text-text-primary">{s.sent}</dd></div>
              <div><dt className="text-xs text-text-secondary">Failed</dt><dd className="font-semibold text-text-primary">{s.failed}</dd></div>
              <div><dt className="text-xs text-text-secondary">Delivery</dt><dd className="font-semibold text-text-primary">{s.sent + s.failed > 0 ? `${s.deliveryRate}%` : '—'}</dd></div>
              <div><dt className="text-xs text-text-secondary">Reached</dt><dd className="font-semibold text-text-primary">{s.reached}</dd></div>
              <div><dt className="text-xs text-text-secondary">Kept</dt><dd className="font-semibold text-text-primary">{s.retentionFromPrevious === null ? '—' : `${s.retentionFromPrevious}%`}</dd></div>
              <div><dt className="text-xs text-text-secondary">Waiting</dt><dd className="font-semibold text-text-primary">{s.waiting}</dd></div>
            </dl>
            {s.topError && <p className="mt-2 text-xs text-danger">Most common error: {s.topError}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecipientsSection({ rows }: { rows: RecipientRow[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RecipientFilter>('all');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => filterRecipients(rows, query, filter), [rows, query, filter]);
  const view = useMemo(() => paginate(filtered, page, PAGE_SIZE), [filtered, page]);

  return (
    <section aria-labelledby="recipients-heading" className="space-y-3">
      <h2 id="recipients-heading" className="text-lg font-semibold text-text-primary">Recipients</h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <Input
            type="search"
            icon={Search}
            aria-label="Search recipients"
            placeholder="Search name, email or phone"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          aria-label="Filter recipients"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as RecipientFilter);
            setPage(1);
          }}
          className="focus-ring min-h-[48px] rounded-xl border border-border bg-bg-secondary px-3 text-sm text-text-primary"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Nobody enrolled"
          description="Recipients appear here once contacts enter this campaign's segment or trigger."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No matching recipients" description="Try a different search or filter." />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-4 py-3">Contact</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Progress</th>
                  <th scope="col" className="px-4 py-3">Last message</th>
                  <th scope="col" className="px-4 py-3">Next message</th>
                  <th scope="col" className="px-4 py-3 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-bg-secondary">
                {view.rows.map((r) => (
                  <tr key={r.enrollmentId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{r.name}</p>
                      <p className="text-xs text-text-secondary">{[r.email, r.phone].filter(Boolean).join(' · ') || 'No contact info'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(r.converted ? 'converted' : r.status)}>{formatEnrollmentStatus(r.converted ? 'converted' : r.status)}</Badge>
                      {r.failedCount > 0 && <span className="ml-2"><Badge tone="danger">{r.failedCount} failed</Badge></span>}
                    </td>
                    <td className="px-4 py-3 text-text-primary">{r.stepsDone}/{r.stepsTotal}</td>
                    <td className="px-4 py-3 text-text-secondary">{when(r.lastSentAt)}</td>
                    <td className="px-4 py-3 text-text-secondary">{when(r.nextSendAt)}</td>
                    <td className="px-4 py-3 text-right font-medium text-text-primary">{r.revenue > 0 ? money(r.revenue) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-3 md:hidden">
            {view.rows.map((r) => (
              <li key={r.enrollmentId} className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text-primary">{r.name}</p>
                    <p className="truncate text-xs text-text-secondary">{[r.email, r.phone].filter(Boolean).join(' · ') || 'No contact info'}</p>
                  </div>
                  <Badge tone={statusTone(r.converted ? 'converted' : r.status)}>{formatEnrollmentStatus(r.converted ? 'converted' : r.status)}</Badge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs text-text-secondary">Progress</dt><dd className="text-text-primary">{r.stepsDone}/{r.stepsTotal}</dd></div>
                  <div><dt className="text-xs text-text-secondary">Revenue</dt><dd className="text-text-primary">{r.revenue > 0 ? money(r.revenue) : '—'}</dd></div>
                  <div><dt className="text-xs text-text-secondary">Last message</dt><dd className="text-text-primary">{when(r.lastSentAt)}</dd></div>
                  <div><dt className="text-xs text-text-secondary">Next message</dt><dd className="text-text-primary">{when(r.nextSendAt)}</dd></div>
                </dl>
                {r.failedCount > 0 && <p className="mt-2 text-xs text-danger">{r.failedCount} failed send(s)</p>}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-sm text-text-secondary">
            <span>
              {filtered.length} recipient{filtered.length === 1 ? '' : 's'} · page {view.page} of {view.pageCount}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={view.page >= view.pageCount} onClick={() => setPage(view.page + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();

  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canView = permissions.can_view_billing;
  const validId = !!id && UUID.test(id);

  const [bundle, setBundle] = useState<CampaignBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'status' | 'clone' | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId || !id || !validId) return;
    setLoadError(null);
    try {
      setBundle(await fetchCampaignBundle(accountOwnerId, id));
    } catch (e) {
      setLoadError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId, id, validId]);

  useEffect(() => {
    if (!canView || !validId) {
      setLoading(false);
      return;
    }
    if (!accountOwnerId) {
      if (!profileLoading) setLoading(false);
      return;
    }
    setLoading(true);
    setBundle(null);
    void load();
  }, [canView, validId, accountOwnerId, profileLoading, load]);

  const derived = useMemo(() => {
    if (!bundle) return null;
    const attribution = attributeRevenue(bundle.enrollments, bundle.sends, bundle.paidJobs);
    const summary = summarizeCampaign(bundle.enrollments, bundle.sends, attribution);
    return {
      summary,
      funnel: buildFunnel(summary),
      steps: buildStepStats(bundle.steps, bundle.sends, bundle.enrollments),
      rows: buildRecipientRows(bundle.enrollments, bundle.contacts, bundle.sends, attribution, bundle.steps.length),
    };
  }, [bundle]);

  const changeStatus = async () => {
    if (!bundle || !accountOwnerId) return;
    const target = toggleTarget(bundle.campaign.status, bundle.steps.length);
    if (!target) return;
    setBusy('status');
    try {
      await setCampaignStatus(accountOwnerId, bundle.campaign.id, target);
      toast(target === 'paused' ? 'Campaign paused. No further messages will be sent.' : 'Campaign is live.', 'success');
      await load();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
      setConfirmPause(false);
    }
  };

  const clone = async () => {
    if (!bundle || !accountOwnerId) return;
    setBusy('clone');
    try {
      const newId = await cloneCampaign(accountOwnerId, bundle.campaign, bundle.steps);
      toast('Copy created as a draft.', 'success');
      navigate(`/dashboard/campaigns/${newId}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const renderBody = () => {
    if (!canView) {
      return <EmptyState icon={ShieldCheck} title="Restricted" description="You need billing access to view campaign performance and revenue." />;
    }
    if (!validId) {
      return <EmptyState icon={Megaphone} title="Campaign not found" description="This link isn't valid." action={{ label: 'Back to campaigns', onClick: () => navigate('/dashboard/marketing') }} />;
    }
    if (loading || profileLoading) {
      return (
        <div className="space-y-6">
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={1} />
          <SkeletonTable rows={5} columns={5} />
        </div>
      );
    }
    if (loadError) {
      return (
        <EmptyState
          icon={TriangleAlert}
          title="Couldn't load this campaign"
          description={loadError}
          action={{ label: 'Try again', onClick: () => { setLoading(true); void load(); } }}
        />
      );
    }
    if (!bundle || !derived) {
      return <EmptyState icon={Megaphone} title="Campaign not found" description="It may have been deleted." action={{ label: 'Back to campaigns', onClick: () => navigate('/dashboard/marketing') }} />;
    }

    const { campaign } = bundle;
    const config = getCampaignTypeConfig(campaign.campaign_type);
    const target = toggleTarget(campaign.status, bundle.steps.length);
    const { summary } = derived;

    return (
      <div className="space-y-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <config.icon className="h-5 w-5 shrink-0 text-accent" aria-hidden />
              <h1 className="truncate text-2xl font-bold text-text-primary">{campaign.name}</h1>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <Badge tone={campaign.status === 'active' ? 'accent' : 'neutral'}>{campaign.status}</Badge>
              <span>{config.label}</span>
              <span>· trigger: {campaign.trigger_type.replace('_', ' ')}</span>
              <span>· created {when(campaign.created_at)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {target ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy !== null}
                onClick={() => (campaign.status === 'active' ? setConfirmPause(true) : void changeStatus())}
              >
                {campaign.status === 'active' ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                {busy === 'status' ? 'Working…' : toggleLabel(campaign.status)}
              </Button>
            ) : (
              <p className="self-center text-xs text-text-secondary">Add at least one step to activate.</p>
            )}
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void clone()}>
              <Copy className="h-4 w-4" aria-hidden />
              {busy === 'clone' ? 'Copying…' : 'Clone'}
            </Button>
          </div>
        </div>

        {bundle.truncated && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-border bg-bg-tertiary p-3 text-sm text-text-secondary">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>This campaign is very large. Figures below are based on the most recent records only.</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Enrolled" value={summary.enrolled} hint={`${summary.active} in progress`} />
          <Stat label="Converted" value={summary.converted} hint={`${summary.conversionRate}% of enrolled`} />
          <Stat label="Attributed revenue" value={money(summary.revenue)} hint={`${money(summary.revenuePerRecipient)} per recipient`} />
          <Stat label="Delivery rate" value={summary.sent + summary.failed > 0 ? `${summary.deliveryRate}%` : '—'} hint={`${summary.sent} sent · ${summary.failed} failed`} />
        </div>

        <section aria-labelledby="funnel-heading" className="space-y-3">
          <h2 id="funnel-heading" className="text-lg font-semibold text-text-primary">Funnel</h2>
          {summary.enrolled === 0 ? (
            <EmptyState icon={Megaphone} title="Nothing to chart" description="The funnel fills in as contacts enter this campaign." />
          ) : (
            <ol className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
              {derived.funnel.map((stage, i) => (
                <li key={stage.key}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium text-text-primary">{stage.label}</span>
                    <span className="text-text-secondary">
                      {stage.count} · {stage.pctOfEnrolled}% of enrolled
                      {i > 0 && ` · ${stage.pctOfPrevious}% of previous`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-3 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${stage.label}: ${stage.count} (${stage.pctOfEnrolled}% of enrolled)`}>
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-500"
                      style={{ width: `${stage.count > 0 ? Math.max(stage.pctOfEnrolled, 2) : 0}%` }}
                    />
                  </div>
                </li>
              ))}
              <li className="pt-1 text-xs text-text-secondary">
                {summary.completed} finished the sequence · {summary.stopped} stopped · {summary.active} still in progress
              </li>
            </ol>
          )}
        </section>

        {bundle.steps.length === 0 ? (
          <EmptyState icon={Megaphone} title="No steps configured" description="Add email or SMS steps to this campaign to start sending." />
        ) : (
          <StepsSection stats={derived.steps} />
        )}

        <RecipientsSection rows={derived.rows} />

        <p className="text-xs text-text-secondary">
          Attributed revenue counts paid invoices for enrolled contacts on jobs created within {ATTRIBUTION_WINDOW_DAYS} days after their first message
          from this campaign (last-touch). It shows correlation with the campaign, not guaranteed causation.
        </p>

        <ConfirmDialog
          open={confirmPause}
          title="Pause this campaign?"
          description="No further messages will be sent to anyone in this campaign until you resume it."
          confirmLabel="Pause campaign"
          onConfirm={changeStatus}
          onCancel={() => setConfirmPause(false)}
        />
      </div>
    );
  };

  return (
    <DashboardLayout activeLabel="Marketing Automation">
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
        <Link to="/dashboard/marketing" className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Marketing Automation
        </Link>
        {renderBody()}
      </div>
    </DashboardLayout>
  );
}
