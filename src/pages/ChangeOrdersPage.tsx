/**
 * Change Orders — /dashboard/change-orders and /dashboard/change-orders/:changeOrderId
 *
 * Priced scope/price changes on jobs and install projects, with customer approval (online signature or
 * staff-recorded) and invoice impact. Billing-sensitive: owner or team members with can_view_billing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileText, Lock, Plus, Search } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ChangeOrderDetail } from '@/components/change-orders/ChangeOrderDetail';
import { ChangeOrderForm } from '@/components/change-orders/ChangeOrderForm';
import { Pill, Stat, panelClass, statusTone } from '@/components/change-orders/coUi';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatCents } from '@/lib/quotes';
import {
  createChangeOrder,
  fetchChangeOrders,
  fetchParentInfo,
  type ParentInfo,
  type ParentOption,
} from '@/lib/changeOrdersApi';
import {
  EMPTY_FORM,
  REASON_LABEL,
  STATUS_LABEL,
  changeOrderError,
  displayStatus,
  formatDate,
  formatScheduleImpact,
  summarize,
  toPayload,
  type ChangeOrder,
  type DisplayStatus,
  type FormValues,
} from '@/lib/changeOrders';

type Filter = 'all' | 'open' | DisplayStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'open', label: 'Needs attention' },
  { key: 'draft', label: 'Drafts' },
  { key: 'sent', label: 'Awaiting' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
  { key: 'expired', label: 'Expired' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

interface Loaded {
  cos: ChangeOrder[];
  parents: Record<string, ParentInfo>;
}

function useChangeOrders(ownerId: string) {
  const { toast } = useToast();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const cos = await fetchChangeOrders(ownerId);
      // Parent labels are nice-to-have: a failure here must not hide the change orders themselves.
      const parents = await fetchParentInfo(ownerId, cos).catch(() => ({}) as Record<string, ParentInfo>);
      setData({ cos, parents });
    } catch (e) {
      setFailed(true);
      toast(changeOrderError(e, 'Could not load change orders.'), 'error');
    }
  }, [ownerId, toast]);

  useEffect(() => { void load(); }, [load]);

  // Fresh data when the tab regains focus (an approval may have arrived while the user was away).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  return { data, failed, load };
}

const parentKey = (c: ChangeOrder) => (c.project_id ? `project:${c.project_id}` : `job:${c.job_id}`);

function ChangeOrderList({ ownerId, data, failed, load }: { ownerId: string; data: Loaded | null; failed: boolean; load: () => Promise<void> }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const now = new Date();
  const cos = data?.cos ?? [];
  const summary = useMemo(() => summarize(cos), [cos]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (v: FormValues, parent: ParentOption | null) => {
    if (!parent) return;
    setSaving(true);
    try {
      const id = await createChangeOrder(parent.kind === 'job' ? { jobId: parent.id } : { projectId: parent.id }, toPayload(v));
      toast('Draft created.', 'success');
      await load();
      navigate(`/dashboard/change-orders/${id}`);
    } catch (e) {
      toast(changeOrderError(e, 'Could not create the change order.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cos.filter((c) => {
      const st = displayStatus(c, now);
      if (filter === 'open' ? !(st === 'draft' || st === 'sent' || st === 'expired' || (st === 'approved' && !c.invoice_id && c.total_cents > 0)) : filter !== 'all' && st !== filter) return false;
      if (!q) return true;
      return `${c.co_number ?? ''} ${c.title} ${c.customer_name} ${data?.parents[parentKey(c)]?.label ?? ''}`.toLowerCase().includes(q);
    });
  }, [cos, filter, query, data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Change Orders</h1>
          <p className="mt-1 text-sm text-text-secondary">Priced scope changes on jobs and projects — approved by the customer, then invoiced.</p>
        </div>
        {!creating && <Button size="sm" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New change order</Button>}
      </div>

      {creating && <ChangeOrderForm mode="create" ownerId={ownerId} initial={EMPTY_FORM} submitting={saving} onSubmit={create} onCancel={() => setCreating(false)} />}

      {failed ? (
        <EmptyStateError icon={FileText} title="Could not load change orders" onRetry={() => void load()} />
      ) : data === null ? (
        <div aria-busy="true" aria-label="Loading change orders" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
          <SkeletonCard rows={2} /><SkeletonCard rows={2} />
        </div>
      ) : cos.length === 0 ? (
        !creating && <EmptyState icon={FileText} title="No change orders yet" description="When the scope or price of a job changes, create a change order, get the customer’s approval and invoice it — all in one place." action={{ label: 'Create your first change order', onClick: () => setCreating(true) }} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Awaiting approval" value={summary.awaiting} hint={summary.awaiting ? formatCents(summary.awaitingCents) : 'Nothing pending'} tone={summary.awaiting ? 'warning' : undefined} />
            <Stat label="Approved, not invoiced" value={formatCents(summary.approvedToInvoiceCents)} tone={summary.approvedToInvoiceCents > 0 ? 'warning' : undefined} />
            <Stat label="Approved total" value={formatCents(summary.approvedCents)} tone="success" />
            <Stat label="Drafts / expired" value={`${summary.drafts} / ${summary.expired}`} hint={`${summary.declinedCount} declined`} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
              ))}
            </div>
            <div className="w-full sm:ml-auto sm:w-64"><Input aria-label="Search change orders" icon={Search} placeholder="Search change orders" value={query} onChange={(e) => setQuery(e.target.value)} className="py-2 text-sm" /></div>
          </div>

          {visible.length === 0 ? (
            <EmptyState icon={FileText} title="Nothing matches" description="Try a different status filter or search term." secondaryAction={{ label: 'Clear filters', onClick: () => { setFilter('all'); setQuery(''); } }} />
          ) : (
            <ul className="space-y-3">
              {visible.map((c) => {
                const st = displayStatus(c, now);
                const parent = data.parents[parentKey(c)];
                return (
                  <li key={c.id}>
                    <Link to={`/dashboard/change-orders/${c.id}`} className={`${panelClass} focus-ring block transition-colors hover:border-accent/40`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-base font-semibold text-text-primary">{c.title}</p>
                          <p className="truncate text-sm text-text-secondary">{c.co_number} · {c.customer_name}{parent ? ` · ${parent.label}` : ''}</p>
                        </div>
                        <Pill tone={statusTone[st]}>{STATUS_LABEL[st]}</Pill>
                      </div>
                      <div className="mt-3 flex flex-wrap justify-between gap-x-6 gap-y-1 text-xs text-text-secondary">
                        <span>Total <span className={`font-semibold tabular-nums ${c.total_cents < 0 ? 'text-success-500' : 'text-text-primary'}`}>{formatCents(c.total_cents)}</span></span>
                        <span>{REASON_LABEL[c.reason]}</span>
                        <span>{formatScheduleImpact(c.schedule_impact_days)}</span>
                        <span>{c.responded_at ? `Responded ${formatDate(c.responded_at)}` : c.sent_at ? `Sent ${formatDate(c.sent_at)}` : `Created ${formatDate(c.created_at)}`}</span>
                        {c.status === 'approved' && !c.invoice_id && c.total_cents > 0 && <span className="font-semibold text-warning-500">Ready to invoice</span>}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Workspace({ ownerId }: { ownerId: string }) {
  const { changeOrderId } = useParams<{ changeOrderId: string }>();
  const navigate = useNavigate();
  const { data, failed, load } = useChangeOrders(ownerId);

  if (!changeOrderId) return <ChangeOrderList ownerId={ownerId} data={data} failed={failed} load={load} />;

  if (failed) return <EmptyStateError icon={FileText} title="Could not load this change order" onRetry={() => void load()} />;
  if (data === null) return <div aria-busy="true" aria-label="Loading change order" className="space-y-4"><Skeleton className="h-8 w-64" /><SkeletonCard rows={3} /></div>;

  const co = data.cos.find((c) => c.id === changeOrderId);
  if (!co) {
    return (
      <EmptyState icon={FileText} title="Change order not found" description="It may have been removed, or it belongs to a different account." action={{ label: 'Back to change orders', onClick: () => navigate('/dashboard/change-orders') }} />
    );
  }
  return <ChangeOrderDetail key={co.id} ownerId={ownerId} co={co} all={data.cos} parent={data.parents[parentKey(co)]} onChanged={load} onBack={() => navigate('/dashboard/change-orders')} />;
}

export function ChangeOrdersPage() {
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  return (
    <DashboardLayout activeLabel="Change Orders">
      {loading || profileLoading ? (
        <div aria-busy="true" className="space-y-4"><Skeleton className="h-8 w-56" /><SkeletonCard rows={2} /></div>
      ) : !canAccess ? (
        <EmptyState icon={Lock} title="Change orders are limited to billing access" description="Ask the account owner for the “view billing” permission to create, send and invoice change orders." />
      ) : !ownerId ? (
        <EmptyStateError icon={FileText} title="Account not ready" description="We couldn't determine which account this belongs to. Refresh the page or sign in again." />
      ) : (
        <Workspace ownerId={ownerId} />
      )}
    </DashboardLayout>
  );
}
