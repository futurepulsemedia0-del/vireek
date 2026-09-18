import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Handshake,
  Lock,
  Clock,
  CheckCircle2,
  XCircle,
  Ban,
  RotateCcw,
  AlertTriangle,
  Phone,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  fetchPromises,
  resolvePromise,
  reopenPromise,
  isOverdue,
  CATEGORY_LABELS,
  type Promise_,
  type PromiseStatus,
} from '@/lib/promises';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable, FadeIn } from '@/components/Skeleton';

type FilterTab = 'pending' | 'overdue' | 'fulfilled' | 'broken' | 'all';

function formatDueDate(dateStr: string | null): string {
  if (!dateStr) return 'No deadline given';
  const date = new Date(dateStr);
  const diffMs = date.getTime() - Date.now();
  const diffHours = Math.round(diffMs / 3600_000);

  const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  if (diffHours < 0) {
    const overdueHours = Math.abs(diffHours);
    const overdueLabel = overdueHours < 24 ? `${overdueHours}h overdue` : `${Math.round(overdueHours / 24)}d overdue`;
    return `${formatted} (${overdueLabel})`;
  }
  if (diffHours < 24) return `${formatted} (in ${diffHours}h)`;
  return formatted;
}

function StatusBadge({ status, overdue }: { status: PromiseStatus; overdue: boolean }) {
  if (status === 'fulfilled') {
    return <span className="flex items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success"><CheckCircle2 size={12} /> Fulfilled</span>;
  }
  if (status === 'broken') {
    return <span className="flex items-center gap-1 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger"><XCircle size={12} /> Broken</span>;
  }
  if (status === 'cancelled') {
    return <span className="flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary"><Ban size={12} /> Cancelled</span>;
  }
  if (overdue) {
    return <span className="flex items-center gap-1 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger"><AlertTriangle size={12} /> Overdue</span>;
  }
  return <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent"><Clock size={12} /> Pending</span>;
}

export function PromiseTrackerPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_view_all_jobs;

  const [promises, setPromises] = useState<Promise_[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<FilterTab>('pending');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const loadPromises = async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    try {
      setPromises(await fetchPromises());
    } catch {
      // empty state below
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPromises();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, canAccess]);

  const summary = useMemo(() => {
    const pending = promises.filter((p) => p.status === 'pending');
    const overdue = pending.filter((p) => isOverdue(p));
    const resolved = promises.filter((p) => p.status !== 'pending');
    const fulfilled = promises.filter((p) => p.status === 'fulfilled');
    const fulfilledRate = resolved.length > 0 ? Math.round((fulfilled.length / resolved.length) * 1000) / 10 : null;
    return { pendingCount: pending.length, overdueCount: overdue.length, brokenCount: promises.filter((p) => p.status === 'broken').length, fulfilledRate };
  }, [promises]);

  const filtered = useMemo(() => {
    switch (tab) {
      case 'pending': return promises.filter((p) => p.status === 'pending' && !isOverdue(p));
      case 'overdue': return promises.filter((p) => isOverdue(p));
      case 'fulfilled': return promises.filter((p) => p.status === 'fulfilled');
      case 'broken': return promises.filter((p) => p.status === 'broken');
      default: return promises;
    }
  }, [promises, tab]);

  const handleResolve = async (id: string, status: 'fulfilled' | 'broken' | 'cancelled') => {
    setResolvingId(id);
    try {
      await resolvePromise(id, status, '');
      setPromises((prev) => prev.map((p) => (p.id === id ? { ...p, status, resolved_at: new Date().toISOString() } : p)));
      toast(status === 'fulfilled' ? 'Marked as fulfilled.' : status === 'broken' ? 'Marked as broken.' : 'Cancelled.', 'success');
    } catch {
      toast('Could not update this promise.', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const handleReopen = async (id: string) => {
    setResolvingId(id);
    try {
      await reopenPromise(id);
      setPromises((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'pending', resolved_at: null } : p)));
      toast('Reopened.', 'success');
    } catch {
      toast('Could not reopen this promise.', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const TABS: { key: FilterTab; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'overdue', label: `Overdue${summary.overdueCount > 0 ? ` (${summary.overdueCount})` : ''}` },
    { key: 'fulfilled', label: 'Fulfilled' },
    { key: 'broken', label: 'Broken' },
    { key: 'all', label: 'All' },
  ];

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Promise Tracker">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Promise Tracker access is restricted. Ask your account owner for access.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Promise Tracker">
      <div className="mb-8 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Handshake size={16} />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Promise Tracker</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">Every commitment made on a call, tracked until it's kept</p>
        </div>
      </div>

      {loading ? (
        <>
          <SkeletonStatGrid count={4} />
          <div className="mt-6"><SkeletonTable rows={5} columns={4} /></div>
        </>
      ) : promises.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No promises tracked yet"
          description="When Sarah or your team commits to something on a call — a callback, an arrival time, a discount — it'll show up here automatically."
        />
      ) : (
        <FadeIn>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-accent"><Clock size={14} /><span className="text-xs font-medium">Pending</span></div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.pendingCount}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-danger"><AlertTriangle size={14} /><span className="text-xs font-medium">Overdue</span></div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.overdueCount}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-success"><CheckCircle2 size={14} /><span className="text-xs font-medium">Kept Rate</span></div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.fulfilledRate !== null ? `${summary.fulfilledRate}%` : '—'}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-danger"><XCircle size={14} /><span className="text-xs font-medium">Broken</span></div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.brokenCount}</p>
            </div>
          </div>

          <div className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`focus-ring shrink-0 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-2">
            {filtered.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">Nothing here.</p>
            ) : (
              filtered.map((p) => {
                const overdue = isOverdue(p);
                return (
                  <div key={p.id} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">{CATEGORY_LABELS[p.category]}</span>
                          <StatusBadge status={p.status} overdue={overdue} />
                        </div>
                        <p className="mt-2 text-sm font-medium text-text-primary">{p.promise_text}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                          {(p.customer_name || p.customer_phone) && (
                            <span className="flex items-center gap-1"><Phone size={11} /> {p.customer_name ?? p.customer_phone}</span>
                          )}
                          <span className="flex items-center gap-1"><Clock size={11} /> {p.due_description ? `"${p.due_description}" — ` : ''}{formatDueDate(p.due_at)}</span>
                        </div>
                        {p.resolution_note && (
                          <p className="mt-1.5 text-xs italic text-text-secondary">Note: {p.resolution_note}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                      {p.status === 'pending' ? (
                        <>
                          <button
                            type="button"
                            disabled={resolvingId === p.id}
                            onClick={() => handleResolve(p.id, 'fulfilled')}
                            className="focus-ring flex items-center gap-1.5 rounded-lg bg-success-500/10 px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success-500/20 disabled:opacity-50"
                          >
                            <CheckCircle2 size={13} /> Mark Fulfilled
                          </button>
                          <button
                            type="button"
                            disabled={resolvingId === p.id}
                            onClick={() => handleResolve(p.id, 'broken')}
                            className="focus-ring flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                          >
                            <XCircle size={13} /> Mark Broken
                          </button>
                          <button
                            type="button"
                            disabled={resolvingId === p.id}
                            onClick={() => handleResolve(p.id, 'cancelled')}
                            className="focus-ring flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-border disabled:opacity-50"
                          >
                            <Ban size={13} /> Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={resolvingId === p.id}
                          onClick={() => handleReopen(p.id)}
                          className="focus-ring flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-border disabled:opacity-50"
                        >
                          <RotateCcw size={13} /> Reopen
                        </button>
                      )}
                      {p.call_id && (
                        <button
                          type="button"
                          onClick={() => navigate('/dashboard/calls')}
                          className="focus-ring ml-auto text-xs font-medium text-accent hover:underline"
                        >
                          View call →
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
