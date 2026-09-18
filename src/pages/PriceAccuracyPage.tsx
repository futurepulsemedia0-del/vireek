import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ShieldCheck,
  Lock,
  AlertTriangle,
  HelpCircle,
  CheckCircle2,
  Phone,
  Info,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Call } from '@/lib/supabase';
import { summarizePriceAccuracy, getFlaggedCalls, type PriceMismatchDetail } from '@/lib/priceAccuracy';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable, FadeIn } from '@/components/Skeleton';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function StatusBadge({ status }: { status: Call['price_accuracy_status'] }) {
  if (status === 'mismatch') {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
        <AlertTriangle size={12} /> Mismatch
      </span>
    );
  }
  if (status === 'unverified') {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-warning-500/10 px-2.5 py-1 text-xs font-medium text-warning-500">
        <HelpCircle size={12} /> Unverified
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success">
      <CheckCircle2 size={12} /> Verified
    </span>
  );
}

export function PriceAccuracyPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();

  const canAccess = isOwner || permissions.can_view_billing;

  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !canAccess) return;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('calls')
          .select('*')
          .not('price_accuracy_status', 'is', null)
          .order('call_datetime', { ascending: false })
          .limit(500);
        if (error) throw error;
        setCalls((data as Call[]) ?? []);
      } catch {
        // empty state handles this
      } finally {
        setLoading(false);
      }
    })();
  }, [user, canAccess]);

  const summary = useMemo(() => summarizePriceAccuracy(calls), [calls]);
  const flaggedCalls = useMemo(() => getFlaggedCalls(calls), [calls]);

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Price Accuracy">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Price Accuracy access is restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Price Accuracy">
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
              <ShieldCheck size={16} />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Price Accuracy</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">Every price Sarah quoted, checked against your real Price Book</p>
        </div>
      </div>

      {loading ? (
        <>
          <SkeletonStatGrid count={4} />
          <div className="mt-6"><SkeletonTable rows={5} columns={4} /></div>
        </>
      ) : summary.totalCallsWithPricing === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No priced calls yet"
          description="Once a call includes Sarah quoting a price, it'll be checked against your Price Book and show up here."
        />
      ) : (
        <FadeIn>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-text-secondary">
                <Phone size={14} />
                <span className="text-xs font-medium">Calls with Pricing</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.totalCallsWithPricing}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-success">
                <CheckCircle2 size={14} />
                <span className="text-xs font-medium">Accuracy Rate</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.accuracyRate !== null ? `${summary.accuracyRate}%` : '—'}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-accent">
                <ShieldCheck size={14} />
                <span className="text-xs font-medium">Live-Grounded Rate</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.groundedRate !== null ? `${summary.groundedRate}%` : '—'}</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
              <div className="flex items-center gap-2 text-danger">
                <AlertTriangle size={14} />
                <span className="text-xs font-medium">Mismatches</span>
              </div>
              <p className="mt-2 text-xl font-bold text-text-primary">{summary.mismatchCount}</p>
            </div>
          </div>

          {/* Flagged calls */}
          <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
            <h3 className="text-sm font-semibold text-text-primary">Flagged Calls</h3>
            <p className="text-xs text-text-secondary">Mismatches first — prices Sarah said that don't match any active Price Book entry</p>

            {flaggedCalls.length === 0 ? (
              <p className="mt-5 text-sm text-text-secondary">Nothing flagged — every priced call this period checked out.</p>
            ) : (
              <div className="mt-5 space-y-2">
                {flaggedCalls.map((c) => {
                  const details = (c.price_accuracy_details as unknown as PriceMismatchDetail[]) ?? [];
                  const isExpanded = expandedCallId === c.id;
                  return (
                    <div key={c.id} className="rounded-xl border border-border/60">
                      <button
                        type="button"
                        onClick={() => setExpandedCallId(isExpanded ? null : c.id)}
                        className="focus-ring flex w-full items-center justify-between gap-3 p-3.5 text-left"
                      >
                        <div>
                          <p className="text-sm font-medium text-text-primary">{c.caller_name ?? c.caller_phone ?? 'Unknown caller'}</p>
                          <p className="text-xs text-text-secondary">{formatDate(c.call_datetime)} · {c.price_lookups_performed} price lookup{c.price_lookups_performed === 1 ? '' : 's'} this call</p>
                        </div>
                        <StatusBadge status={c.price_accuracy_status} />
                      </button>
                      {isExpanded && (
                        <div className="border-t border-border/60 p-3.5 pt-3">
                          {c.price_accuracy_status === 'unverified' && (
                            <p className="text-xs text-text-secondary">
                              Sarah quoted a price that happens to match the Price Book, but never called the price lookup
                              tool during this call — meaning she likely answered from memory rather than checking live.
                            </p>
                          )}
                          {details.length > 0 && (
                            <div className="mt-2 space-y-2">
                              {details.map((d, i) => (
                                <div key={i} className="rounded-lg bg-bg-tertiary p-3 text-xs">
                                  <p className="font-semibold text-danger">Said {formatCents(d.stated_cents)}</p>
                                  <p className="mt-1 italic text-text-secondary">&ldquo;…{d.context_snippet}…&rdquo;</p>
                                  {d.closest_catalog_match && (
                                    <p className="mt-1.5 text-text-secondary">
                                      Closest Price Book entry: <span className="font-medium text-text-primary">{d.closest_catalog_match.service_name}</span>{' '}
                                      ({formatCents(d.closest_catalog_match.price_cents)}
                                      {d.closest_catalog_match.price_max_cents ? `–${formatCents(d.closest_catalog_match.price_max_cents)}` : ''})
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => navigate('/dashboard/calls')}
                            className="focus-ring mt-3 text-xs font-medium text-accent hover:underline"
                          >
                            View full call →
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-6 flex items-start gap-2 rounded-xl border border-dashed border-border p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              This check is deterministic, not AI-graded — it's regex-extracted dollar amounts from what Sarah said,
              compared against your active Price Book with generous tolerances. "Mismatch" means the stated price
              doesn't correspond to anything in the book, worth a listen. "Unverified" means the number happened to be
              right, but wasn't checked live — update your Price Book and this stops being a reliable signal on its
              own. Tolerances are intentionally generous to avoid false alarms on legitimately larger jobs.
            </p>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}
